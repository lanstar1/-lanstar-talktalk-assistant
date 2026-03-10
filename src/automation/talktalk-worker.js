import fs from "node:fs/promises";
import path from "node:path";

import { getActiveAccount } from "../lib/settings.js";

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
  }

  getStatus() {
    return {
      running: Boolean(this.timer),
      accountId: this.currentAccountId,
      accountName: this.currentAccountName,
      startedAt: this.startedAt,
      tickCount: this.tickCount,
      lastError: this.lastError,
      lastDraft: this.lastDraft
    };
  }

  getCurrentAccount() {
    return getActiveAccount(this.getSettings());
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
    } catch (error) {
      throw new Error(
        "playwright 패키지가 설치되지 않았습니다. npm install playwright 후 다시 시도해 주세요."
      );
    }
  }

  async start() {
    const account = this.getCurrentAccount();

    if (this.timer && this.currentAccountId === account.id) {
      return this.getStatus();
    }

    if (this.timer && this.currentAccountId !== account.id) {
      await this.stop();
    }

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
      headless
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
        storageState: storageStatePath
      });
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    } else {
      this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    }

    await this.page.goto(account.talktalk.url, { waitUntil: "domcontentloaded" });

    this.currentAccountId = account.id;
    this.currentAccountName = account.name;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    this.tickCount = 0;

    const pollInterval = Math.max(5000, account.talktalk.pollIntervalMs ?? 12000);
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.lastError = error.message;
      });
    }, pollInterval);

    await this.tick();
    return this.getStatus();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.context) {
      await this.context.close();
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    this.page = null;
    this.currentAccountId = null;
    this.currentAccountName = null;
    return this.getStatus();
  }

  async tick() {
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

    const config = await this.loadSelectorConfig(account);
    const snapshot = await this.extractCurrentConversation(config.selectors);

    if (!snapshot?.messages?.length || !snapshot.pendingCustomerText) {
      return null;
    }

    const suggestion = await this.engine.suggestReplyEnhanced(snapshot);
    this.lastDraft = {
      at: new Date().toISOString(),
      customerName: snapshot.customerName,
      replyText: suggestion.replyText,
      confidence: suggestion.confidence,
      canAutoSend: suggestion.canAutoSend,
      policyRule: suggestion.policyRule,
      generationSource: suggestion.generationSource,
      llmUsed: suggestion.llm?.used ?? false
    };

    const settings = this.getSettings();
    if (settings.mode === "auto" && suggestion.canAutoSend) {
      await this.sendDraft(config.selectors, suggestion.replyText);
    }

    return suggestion;
  }

  async sendManualDraft(replyText) {
    if (!this.page) {
      throw new Error("자동화 워커가 실행 중이 아닙니다. 먼저 자동화를 시작해 주세요.");
    }

    const account = this.getCurrentAccount();
    if (this.currentAccountId && account.id !== this.currentAccountId) {
      throw new Error("선택된 채널이 현재 실행 중인 톡톡 브라우저 채널과 다릅니다.");
    }

    const config = await this.loadSelectorConfig(account);
    await this.sendDraft(config.selectors, replyText);

    this.lastDraft = {
      at: new Date().toISOString(),
      customerName: this.lastDraft?.customerName ?? "수동 전송",
      replyText,
      confidence: this.lastDraft?.confidence ?? null,
      canAutoSend: false,
      policyRule: this.lastDraft?.policyRule ?? "manual_review"
    };

    return this.getStatus();
  }

  async extractCurrentConversation(selectors) {
    if (!this.page) {
      return null;
    }

    const rows = this.page.locator(selectors.messageRows);
    const rowCount = await rows.count();

    if (!rowCount) {
      throw new Error(
        "messageRows 셀렉터가 현재 페이지에서 메시지를 찾지 못했습니다. config/talktalk.selectors.sample.json을 실제 DOM에 맞게 조정해 주세요."
      );
    }

    const customerName = (
      await this.page.locator(selectors.customerName).first().textContent()
    )?.trim();

    const messages = [];
    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      const text = (await row.locator(selectors.messageText).first().textContent())?.trim();
      if (!text) {
        continue;
      }

      const isCustomer =
        (await row.locator(selectors.incomingRow).count()) > 0 &&
        (await row.locator(selectors.outgoingRow).count()) === 0;
      const role = isCustomer ? "customer" : "seller";
      messages.push({ role, text });
    }

    const pendingCustomerMessages = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "customer") {
        pendingCustomerMessages.unshift(messages[index].text);
        continue;
      }
      if (pendingCustomerMessages.length) {
        break;
      }
    }

    const purchaseHistory = [];
    if (selectors.purchaseItemRows && selectors.purchaseItemName) {
      const orderRows = this.page.locator(selectors.purchaseItemRows);
      const orderCount = await orderRows.count();

      for (let index = 0; index < orderCount; index += 1) {
        const row = orderRows.nth(index);
        const productName = await this.readOptionalText(row, selectors.purchaseItemName);
        const status = await this.readOptionalText(row, selectors.purchaseItemStatus);
        const orderDate = await this.readOptionalText(
          row,
          selectors.purchaseItemOrderDate
        );
        const orderNumber = await this.readOptionalText(
          row,
          selectors.purchaseItemOrderNumber
        );

        if (!productName && !status && !orderDate && !orderNumber) {
          continue;
        }

        purchaseHistory.push({
          주문날짜: orderDate,
          주문번호: orderNumber,
          상품목록: [
            {
              상품명: productName,
              상태: status
            }
          ]
        });
      }
    }

    const productNames = purchaseHistory
      .flatMap((order) => order.상품목록 ?? [])
      .map((item) => normalizeSnippet(item.상품명))
      .filter(Boolean);

    if (!productNames.length && selectors.productTags) {
      const tagNodes = this.page.locator(selectors.productTags);
      const tagCount = await tagNodes.count();
      for (let index = 0; index < tagCount; index += 1) {
        const tagText = normalizeSnippet(await tagNodes.nth(index).textContent());
        if (tagText) {
          productNames.push(tagText);
        }
      }
    }

    return {
      customerName: customerName || "고객",
      messages,
      pendingCustomerText: pendingCustomerMessages.join(" "),
      purchaseHistory,
      productNames: [...new Set(productNames)]
    };
  }

  async sendDraft(selectors, replyText) {
    const input = this.page.locator(selectors.input).last();
    await input.click();
    await input.fill(replyText);
    await this.page.locator(selectors.sendButton).click();
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
}
