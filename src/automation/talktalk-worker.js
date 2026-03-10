import fs from "node:fs/promises";
import path from "node:path";

import { getActiveAccount } from "../lib/settings.js";
import {
  buildLiveChatDetailUrl,
  buildLiveChatListUrl,
  buildMessageSignature,
  buildPendingCustomerText,
  compressMessages,
  createLiveConversationId,
  deriveProductNamesFromMessages,
  extractUserIdFromChatHref,
  extractUserIdFromChatUrl,
  getPartnerCodeFromPublicChatUrl,
  parseLiveConversationId,
  stripSellerPrefix,
  summarizeLiveOrder
} from "../lib/talktalk-live.js";

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function resolvePath(rootDir, targetPath) {
  if (!targetPath) {
    return null;
  }

  return path.isAbsolute(targetPath)
    ? targetPath
    : path.join(rootDir, targetPath);
}

function normalizeSnippet(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function lastOf(values = []) {
  return values[values.length - 1] ?? null;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class TalkTalkWorker {
  constructor({ rootDir, engine, getSettings }) {
    this.rootDir = rootDir;
    this.engine = engine;
    this.getSettings = getSettings;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.timer = null;
    this.lastDraft = null;
    this.lastError = null;
    this.startedAt = null;
    this.tickCount = 0;
    this.currentAccountId = null;
    this.currentAccountName = null;
    this.selectedConversationUserId = null;
    this.manualSelection = false;
    this.lastSuggestionSignature = null;
    this.liveState = this.createEmptyLiveState();
    this.selectorConfig = null;
    this.maxConversationList = positiveInteger(
      process.env.TALKTALK_MAX_CONVERSATIONS,
      30
    );
    this.maxMessageHistory = positiveInteger(
      process.env.TALKTALK_MAX_MESSAGES,
      40
    );
    this.browserRecycleTicks = positiveInteger(
      process.env.TALKTALK_BROWSER_RECYCLE_TICKS,
      process.env.RENDER ? 90 : 0
    );
  }

  createEmptyLiveState() {
    return {
      updatedAt: null,
      partnerCode: null,
      conversations: [],
      selectedConversationId: null,
      selectedConversation: null,
      lastSuggestion: null
    };
  }

  getStatus() {
    const live = this.getLiveOverview();
    return {
      running: Boolean(this.timer),
      accountId: this.currentAccountId,
      accountName: this.currentAccountName,
      startedAt: this.startedAt,
      tickCount: this.tickCount,
      lastError: this.lastError,
      lastDraft: this.lastDraft,
      monitorOnly: this.isMonitorOnly(),
      live
    };
  }

  getLiveOverview() {
    return {
      running: Boolean(this.timer),
      accountId: this.currentAccountId,
      accountName: this.currentAccountName,
      monitorOnly: this.isMonitorOnly(),
      updatedAt: this.liveState.updatedAt,
      partnerCode: this.liveState.partnerCode,
      conversations: this.liveState.conversations,
      selectedConversationId: this.liveState.selectedConversationId,
      selectedConversation: this.liveState.selectedConversation,
      suggestion: this.liveState.lastSuggestion,
      lastError: this.lastError
    };
  }

  getCurrentAccount() {
    return getActiveAccount(this.getSettings());
  }

  isMonitorOnly() {
    return this.getSettings().monitorOnly !== false;
  }

  async loadSelectorConfig(account = this.getCurrentAccount()) {
    const selectorsPath = path.join(
      this.rootDir,
      account.talktalk.selectorsPath ?? "config/talktalk.selectors.sample.json"
    );
    const content = await fs.readFile(selectorsPath, "utf8");
    return JSON.parse(content);
  }

  async ensurePlaywright() {
    try {
      return await import("playwright");
    } catch {
      throw new Error(
        "playwright 패키지가 설치되지 않았습니다. npm install playwright 후 다시 시도해 주세요."
      );
    }
  }

  getPartnerCode(account = this.getCurrentAccount()) {
    return getPartnerCodeFromPublicChatUrl(account.talktalk.publicChatUrl);
  }

  resolveLiveListUrl(account = this.getCurrentAccount()) {
    const partnerCode = this.getPartnerCode(account);
    const liveUrl = buildLiveChatListUrl(partnerCode);

    if (!liveUrl) {
      throw new Error("활성 채널의 공개 채팅 URL에서 톡톡 채널 코드를 찾지 못했습니다.");
    }

    return liveUrl;
  }

  resolveLiveDetailUrl(userId, account = this.getCurrentAccount()) {
    const partnerCode = this.getPartnerCode(account);
    const detailUrl = buildLiveChatDetailUrl(partnerCode, userId);

    if (!detailUrl) {
      throw new Error("선택한 실시간 대화 URL을 만들지 못했습니다.");
    }

    return detailUrl;
  }

  async start() {
    const account = this.getCurrentAccount();

    if (this.timer && this.currentAccountId === account.id) {
      return this.getStatus();
    }

    if (this.timer && this.currentAccountId !== account.id) {
      await this.stop();
    }

    this.selectorConfig = await this.loadSelectorConfig(account);
    await this.openBrowserSession(account);

    this.currentAccountId = account.id;
    this.currentAccountName = account.name;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    this.tickCount = 0;
    this.selectedConversationUserId = null;
    this.manualSelection = false;
    this.lastSuggestionSignature = null;
    this.liveState = this.createEmptyLiveState();

    const pollInterval = Math.max(4000, account.talktalk.pollIntervalMs ?? 12000);
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.lastError = error.message;
      });
    }, pollInterval);

    await this.tick({ forceSuggestion: true });
    return this.getStatus();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.closeBrowserSession();
    this.currentAccountId = null;
    this.currentAccountName = null;
    this.selectedConversationUserId = null;
    this.manualSelection = false;
    this.lastSuggestionSignature = null;
    this.liveState = this.createEmptyLiveState();
    this.selectorConfig = null;
    return this.getStatus();
  }

  async tick(options = {}) {
    this.tickCount += 1;
    if (!this.page) {
      return null;
    }

    const account = this.getCurrentAccount();
    if (this.currentAccountId && account.id !== this.currentAccountId) {
      throw new Error(
        "활성 채널이 변경되었습니다. 자동화 워커를 다시 시작해 주세요."
      );
    }

    if (
      this.browserRecycleTicks > 0 &&
      this.tickCount > 1 &&
      this.tickCount % this.browserRecycleTicks === 0
    ) {
      await this.recycleBrowserSession(account);
    }

    const liveConfig = this.selectorConfig?.live ?? {};
    await this.dismissMonitorPopups(liveConfig);

    let conversations = await this.extractConversationList(liveConfig, account);
    if (!conversations.length) {
      this.liveState = {
        ...this.createEmptyLiveState(),
        updatedAt: new Date().toISOString(),
        partnerCode: this.getPartnerCode(account)
      };
      return this.getLiveOverview();
    }

    const desiredConversation = this.pickConversationToOpen(conversations);
    const currentUserId = extractUserIdFromChatUrl(this.page.url());

    if (desiredConversation?.userId && desiredConversation.userId !== currentUserId) {
      await this.page.goto(this.resolveLiveDetailUrl(desiredConversation.userId, account), {
        waitUntil: "domcontentloaded"
      });
      await this.page.waitForLoadState("networkidle").catch(() => {});
      await this.dismissMonitorPopups(liveConfig);
      conversations = await this.extractConversationList(liveConfig, account);
    }

    const selectedConversation = await this.extractSelectedConversation(
      liveConfig,
      account,
      conversations
    );
    let suggestion = this.liveState.lastSuggestion;

    if (selectedConversation?.pendingCustomerText) {
      const suggestionSignature = `${selectedConversation.id}:${buildMessageSignature(
        selectedConversation.messages
      )}`;

      if (options.forceSuggestion || suggestionSignature !== this.lastSuggestionSignature) {
        suggestion = await this.engine.suggestReplyEnhanced(selectedConversation);
        this.lastSuggestionSignature = suggestionSignature;
        this.lastDraft = {
          at: new Date().toISOString(),
          customerName: selectedConversation.customerName,
          replyText: suggestion.replyText,
          confidence: suggestion.confidence,
          canAutoSend: false,
          policyRule: suggestion.policyRule,
          generationSource: suggestion.generationSource,
          llmUsed: suggestion.llm?.used ?? false
        };
      }
    } else {
      suggestion = null;
      this.lastSuggestionSignature = null;
    }

    this.liveState = {
      updatedAt: new Date().toISOString(),
      partnerCode: this.getPartnerCode(account),
      conversations,
      selectedConversationId: selectedConversation?.id ?? null,
      selectedConversation,
      lastSuggestion: suggestion
    };

    return this.getLiveOverview();
  }

  async sendManualDraft() {
    throw new Error("테스트 모드에서는 고객에게 실제 답변을 전송할 수 없습니다.");
  }

  async selectLiveConversation(conversationId) {
    if (!this.page) {
      throw new Error("자동화 워커가 실행 중이 아닙니다. 먼저 자동화를 시작해 주세요.");
    }

    const account = this.getCurrentAccount();
    const parsed = parseLiveConversationId(conversationId);
    const userId = parsed?.userId;
    if (!userId) {
      throw new Error("선택할 실시간 대화 ID가 올바르지 않습니다.");
    }

    this.selectedConversationUserId = userId;
    this.manualSelection = true;
    await this.page.goto(this.resolveLiveDetailUrl(userId, account), {
      waitUntil: "domcontentloaded"
    });
    await this.waitForLivePage(liveConfig);
    await this.tick({ forceSuggestion: true });
    return this.getLiveOverview();
  }

  async openBrowserSession(account) {
    const { chromium } = await this.ensurePlaywright();
    const userDataDir = resolvePath(
      this.rootDir,
      account.talktalk.userDataDir ?? `storage/browser-profile/${account.id}`
    );
    const storageStatePath = resolvePath(
      this.rootDir,
      account.talktalk.storageStatePath ?? process.env.TALKTALK_STORAGE_STATE_PATH
    );
    const browserChannel =
      process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? account.talktalk.browserChannel;
    const headless =
      process.env.PLAYWRIGHT_HEADLESS != null
        ? truthy(process.env.PLAYWRIGHT_HEADLESS)
        : Boolean(account.talktalk.headless || process.env.RENDER);
    const launchOptions = {
      channel: browserChannel || undefined,
      headless,
      args: [
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-component-extensions-with-background-pages",
        "--mute-audio",
        "--no-first-run",
        "--no-default-browser-check"
      ]
    };
    const contextOptions = {
      serviceWorkers: "block",
      viewport: {
        width: 1280,
        height: 720
      }
    };

    if (storageStatePath) {
      try {
        await fs.access(storageStatePath);
      } catch {
        throw new Error(
          `storageState 파일을 찾지 못했습니다: ${storageStatePath}`
        );
      }

      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext({
        ...contextOptions,
        storageState: storageStatePath
      });
      await this.configureContext();
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    } else {
      this.context = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        ...contextOptions
      });
      await this.configureContext();
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.browser = this.context.browser();
    }

    await this.page.goto(this.resolveLiveListUrl(account), {
      waitUntil: "domcontentloaded"
    });
    await this.waitForLivePage(this.selectorConfig?.live ?? {});
  }

  async closeBrowserSession() {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.page = null;
  }

  async recycleBrowserSession(account) {
    const preservedConversationUserId = this.selectedConversationUserId;
    const preservedManualSelection = this.manualSelection;
    await this.closeBrowserSession();
    await this.openBrowserSession(account);
    this.selectedConversationUserId = preservedConversationUserId;
    this.manualSelection = preservedManualSelection;
    this.lastSuggestionSignature = null;
  }

  async configureContext() {
    if (!this.context) {
      return;
    }

    this.context.setDefaultTimeout(4000);
    this.context.setDefaultNavigationTimeout(15000);
    await this.context.route("**/*", (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const url = request.url().toLowerCase();

      if (["image", "media", "font"].includes(resourceType)) {
        return route.abort();
      }

      if (
        /google-analytics|googletagmanager|doubleclick|hotjar|mixpanel|amplitude|beusable/.test(
          url
        )
      ) {
        return route.abort();
      }

      return route.continue();
    });
  }

  async waitForLivePage(liveConfig) {
    if (!this.page) {
      return;
    }

    const selector = liveConfig.conversationRows ?? "body";
    await this.page.waitForSelector(selector, { timeout: 10000 }).catch(() => {});
  }

  pickConversationToOpen(conversations) {
    if (!conversations.length) {
      return null;
    }

    if (this.selectedConversationUserId) {
      const preserved = conversations.find(
        (conversation) => conversation.userId === this.selectedConversationUserId
      );
      if (preserved) {
        return preserved;
      }
    }

    const currentUserId = extractUserIdFromChatUrl(this.page?.url());
    if (currentUserId && !this.manualSelection) {
      const current = conversations.find(
        (conversation) => conversation.userId === currentUserId
      );
      if (current) {
        return current;
      }
    }

    const unread = conversations.find((conversation) => conversation.unreadCount > 0);
    if (unread) {
      this.selectedConversationUserId = unread.userId;
      this.manualSelection = false;
      return unread;
    }

    this.selectedConversationUserId = conversations[0].userId;
    this.manualSelection = false;
    return conversations[0];
  }

  async dismissMonitorPopups(liveConfig) {
    if (!this.page) {
      return;
    }

    const closeSelectors = liveConfig.dismissPopupButtons ?? [];
    for (const selector of closeSelectors) {
      const buttons = this.page.locator(selector);
      const count = await buttons.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        await buttons.nth(index).click({ timeout: 500 }).catch(() => {});
      }
    }
  }

  async extractConversationList(liveConfig, account) {
    const rows = this.page.locator(liveConfig.conversationRows);
    const rowCount = Math.min(await rows.count(), this.maxConversationList);
    const sellerName = normalizeSnippet(account.talktalk.sourceName || account.name);
    const partnerCode = this.getPartnerCode(account);
    const conversations = [];

    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      const href = await this.readOptionalAttribute(
        row,
        liveConfig.conversationRowLink,
        "href"
      );
      const userId = extractUserIdFromChatHref(href);
      if (!userId) {
        continue;
      }

      const preview = stripSellerPrefix(
        await this.readOptionalText(row, liveConfig.conversationPreview),
        sellerName
      );
      const unreadText = await this.readOptionalText(row, liveConfig.conversationUnreadBadge);
      const unreadCount = Number.parseInt(unreadText || "0", 10) || 0;
      const itemClass = (await row.getAttribute("class")) ?? "";

      conversations.push({
        id: createLiveConversationId(partnerCode, userId),
        userId,
        isLive: true,
        customerName: await this.readOptionalText(row, liveConfig.conversationName),
        preview,
        unreadCount,
        timeLabel: await this.readOptionalText(row, liveConfig.conversationTime),
        href: buildLiveChatDetailUrl(partnerCode, userId),
        awaitingReply: unreadCount > 0,
        orderSummary: "실시간 상담",
        latestOrderDate: "",
        productNames: [],
        selected: /\bon\b/.test(itemClass)
      });
    }

    return conversations;
  }

  async extractSelectedConversation(liveConfig, account, conversations) {
    const userId = extractUserIdFromChatUrl(this.page.url());
    if (!userId) {
      return null;
    }

    const messageRows = this.page.locator(liveConfig.messageRows);
    const rowCount = await messageRows.count();
    if (!rowCount) {
      return null;
    }

    const nextData = await this.readNextData();
    const listItem =
      conversations.find((conversation) => conversation.userId === userId) ?? null;
    const partnerCode = this.getPartnerCode(account);
    const messages = [];

    for (let index = 0; index < rowCount; index += 1) {
      const message = await this.extractMessage(messageRows.nth(index), liveConfig);
      if (message) {
        messages.push(message);
      }
    }

    const compactMessages = compressMessages(messages, this.maxMessageHistory);
    const productNames = deriveProductNamesFromMessages(compactMessages);
    const customerName =
      normalizeSnippet(nextData?.props?.pageProps?.chatInfo?.info?.name) ||
      normalizeSnippet(await this.readOptionalText(this.page, liveConfig.customerName)) ||
      listItem?.customerName ||
      "고객";

    const preview = normalizeSnippet(lastOf(compactMessages)?.text ?? listItem?.preview ?? "");
    const pendingCustomerText = buildPendingCustomerText(compactMessages);

    return {
      id: createLiveConversationId(partnerCode, userId),
      userId,
      isLive: true,
      customerName,
      orderSummary: summarizeLiveOrder({
        customerName,
        timeLabel: listItem?.timeLabel
      }),
      latestOrderDate: listItem?.timeLabel ?? "",
      preview,
      productNames,
      purchaseHistory: [],
      messages: compactMessages,
      awaitingReply: Boolean(pendingCustomerText),
      pendingCustomerText,
      unreadCount: listItem?.unreadCount ?? 0,
      liveMeta: {
        partnerCode,
        timeLabel: listItem?.timeLabel ?? "",
        tags:
          nextData?.props?.pageProps?.chatInfo?.info?.tags?.map((tag) =>
            normalizeSnippet(tag)
          ) ?? []
      }
    };
  }

  async extractMessage(row, liveConfig) {
    const sender = normalizeSnippet(await row.getAttribute("data-sender"));
    const role = sender === "user" ? "customer" : sender === "partner" ? "seller" : "";
    if (!role) {
      return null;
    }

    const texts = [];
    const copyAreas = row.locator(liveConfig.messageCopyText);
    const copyCount = await copyAreas.count().catch(() => 0);
    for (let index = 0; index < copyCount; index += 1) {
      const text = normalizeSnippet(await copyAreas.nth(index).textContent());
      if (text) {
        texts.push(text);
      }
    }

    if (!texts.length) {
      const compositeTexts = row.locator(liveConfig.messageCompositeText);
      const compositeCount = await compositeTexts.count().catch(() => 0);
      for (let index = 0; index < compositeCount; index += 1) {
        const text = normalizeSnippet(await compositeTexts.nth(index).textContent());
        if (text) {
          texts.push(text);
        }
      }
    }

    if (!texts.length) {
      const fallback = normalizeSnippet(await this.readOptionalText(row, liveConfig.messageText));
      if (fallback) {
        texts.push(fallback);
      }
    }

    const text = normalizeSnippet(texts.join("\n"));
    if (!text) {
      return null;
    }

    return {
      role,
      text
    };
  }

  async readNextData() {
    try {
      const raw = await this.page.locator("#__NEXT_DATA__").textContent({
        timeout: 1000
      });
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async readOptionalText(scope, selector) {
    if (!selector) {
      return "";
    }

    try {
      return normalizeSnippet(
        await scope.locator(selector).first().textContent({ timeout: 800 })
      );
    } catch {
      return "";
    }
  }

  async readOptionalAttribute(scope, selector, attributeName) {
    if (!selector) {
      return "";
    }

    try {
      return normalizeSnippet(
        await scope.locator(selector).first().getAttribute(attributeName, {
          timeout: 800
        })
      );
    } catch {
      return "";
    }
  }
}
