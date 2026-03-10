const POLL_INTERVAL_MS = 4000;

const state = {
  conversations: [],
  filteredConversations: [],
  liveOverview: null,
  currentConversationId: null,
  currentConversation: null,
  currentSuggestion: null,
  settings: null,
  activeAccount: null,
  activeFocusTab: "thread",
  pollTimer: null,
  reviewedDraftSignature: "",
  lastConversationListSignature: "",
  lastThreadSignature: "",
  lastSuggestionSignature: ""
};

const elements = {
  metrics: document.querySelector("#metrics"),
  llmStatusText: document.querySelector("#llmStatusText"),
  searchInput: document.querySelector("#searchInput"),
  accountSelect: document.querySelector("#accountSelect"),
  modeSelect: document.querySelector("#modeSelect"),
  heroChannel: document.querySelector("#heroChannel"),
  heroMonitor: document.querySelector("#heroMonitor"),
  heroDraftState: document.querySelector("#heroDraftState"),
  overviewQueue: document.querySelector("#overviewQueue"),
  overviewQueueText: document.querySelector("#overviewQueueText"),
  overviewSync: document.querySelector("#overviewSync"),
  overviewSyncText: document.querySelector("#overviewSyncText"),
  overviewChannel: document.querySelector("#overviewChannel"),
  overviewChannelText: document.querySelector("#overviewChannelText"),
  overviewDraft: document.querySelector("#overviewDraft"),
  overviewDraftText: document.querySelector("#overviewDraftText"),
  automationStatus: document.querySelector("#automationStatus"),
  startAutomationButton: document.querySelector("#startAutomationButton"),
  stopAutomationButton: document.querySelector("#stopAutomationButton"),
  conversationCount: document.querySelector("#conversationCount"),
  conversationList: document.querySelector("#conversationList"),
  customerName: document.querySelector("#customerName"),
  orderSummary: document.querySelector("#orderSummary"),
  productTags: document.querySelector("#productTags"),
  thread: document.querySelector("#thread"),
  generateButton: document.querySelector("#generateButton"),
  reviewButton: document.querySelector("#reviewButton"),
  sendButton: document.querySelector("#sendButton"),
  draftReply: document.querySelector("#draftReply"),
  reviewStatus: document.querySelector("#reviewStatus"),
  flagList: document.querySelector("#flagList"),
  confidenceBar: document.querySelector("#confidenceBar"),
  confidenceText: document.querySelector("#confidenceText"),
  evidenceList: document.querySelector("#evidenceList"),
  copyButton: document.querySelector("#copyButton"),
  conversationItemTemplate: document.querySelector("#conversationItemTemplate"),
  focusTabButtons: Array.from(document.querySelectorAll("[data-focus-tab]")),
  focusPanels: Array.from(document.querySelectorAll("[data-focus-panel]"))
};

function formatStatusTimestamp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "대기 중";
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(date);
}

function formatCompactTimestamp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "대기 중";
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(date);
}

function isMonitorOnly() {
  return state.settings?.monitorOnly !== false;
}

function hasLiveMonitor() {
  return Boolean(state.liveOverview?.running);
}

function getCurrentSearchQuery() {
  return elements.searchInput.value.trim();
}

function getAwaitingConversationCount() {
  return state.conversations.filter(
    (conversation) => conversation.awaitingReply || conversation.unreadCount > 0
  ).length;
}

function getSuggestionSourceLabel(suggestion) {
  return suggestion.generationSource === "llm_hybrid"
    ? "LLM 보강"
    : suggestion.generationSource === "retrieval_contextual"
      ? "문맥 기반 초안"
      : suggestion.generationSource === "policy"
        ? "정책 응답"
        : suggestion.generationSource === "retrieval"
          ? "기존 이력 재사용"
          : "기본 응답";
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "요청 처리 중 오류가 발생했습니다.");
  }
  return payload;
}

function renderMetrics(stats) {
  elements.metrics.innerHTML = `
    <div class="metric-card">
      <span>대기 가능 대화</span>
      <strong>${stats.awaitingReplyCount}</strong>
    </div>
    <div class="metric-card">
      <span>Q&A 지식</span>
      <strong>${stats.qnaCount}</strong>
    </div>
    <div class="metric-card">
      <span>상담 학습 쌍</span>
      <strong>${stats.retrievalCount}</strong>
    </div>
    <div class="metric-card">
      <span>제품 종류</span>
      <strong>${stats.productCount}</strong>
    </div>
  `;
}

function renderAccountSelect(settings) {
  state.activeAccount =
    settings.accounts.find((account) => account.id === settings.activeAccountId) ??
    settings.accounts[0] ??
    null;
  elements.accountSelect.innerHTML = "";

  for (const account of settings.accounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.name;
    elements.accountSelect.appendChild(option);
  }

  if (state.activeAccount) {
    elements.accountSelect.value = state.activeAccount.id;
  }

  renderDashboardSummary();
}

function renderLlmStatus(llmStatus, suggestion = null) {
  if (!llmStatus?.enabled) {
    elements.llmStatusText.textContent = "비활성화됨";
    return;
  }

  if (!llmStatus.available) {
    elements.llmStatusText.textContent =
      "설정은 켜져 있지만 LLM_PROVIDER / LLM_MODEL / API 연결 정보가 없습니다.";
    return;
  }

  const base = `${llmStatus.provider} / ${llmStatus.model}`;
  if (!suggestion) {
    elements.llmStatusText.textContent = `${base} / 하이브리드 보강 대기`;
    return;
  }

  if (suggestion.llm?.used) {
    elements.llmStatusText.textContent = `${base} / 이번 초안에 보강 사용 (${suggestion.llm.reason})`;
    return;
  }

  if (suggestion.llm?.error) {
    elements.llmStatusText.textContent = `${base} / 보강 실패, 기본 초안 사용: ${suggestion.llm.error}`;
    return;
  }

  elements.llmStatusText.textContent = `${base} / 이번 초안은 규칙+검색만 사용`;
}

function setHeroChipState(element, text, active) {
  element.textContent = text;
  element.classList.toggle("muted", !active);
}

function renderDashboardSummary() {
  const activeChannel = state.activeAccount?.name ?? "채널 미선택";
  const running = hasLiveMonitor();
  const queueCount = getAwaitingConversationCount();
  const syncValue = state.liveOverview?.updatedAt ?? null;
  const reviewed =
    Boolean(elements.draftReply.value.trim()) &&
    Boolean(state.reviewedDraftSignature) &&
    state.reviewedDraftSignature === getCurrentDraftSignature();
  const sourceLabel = state.currentSuggestion
    ? getSuggestionSourceLabel(state.currentSuggestion)
    : "초안 대기";
  const draftTitle = state.currentSuggestion
    ? reviewed
      ? "검토 완료"
      : sourceLabel
    : "초안 대기";
  const draftDetail = state.currentSuggestion
    ? reviewed
      ? "운영자가 현재 초안을 확인했습니다"
      : state.currentSuggestion.llm?.used
        ? "LLM 보강 포함, 운영자 확인 필요"
        : "초안 생성 완료, 검토 후 처리 필요"
    : "새 문의가 들어오면 자동 갱신됩니다";

  setHeroChipState(elements.heroChannel, activeChannel, Boolean(state.activeAccount));
  setHeroChipState(
    elements.heroMonitor,
    running ? "실시간 동기화 중" : "워커 정지",
    running
  );
  setHeroChipState(
    elements.heroDraftState,
    state.currentSuggestion ? draftTitle : "초안 대기",
    Boolean(state.currentSuggestion)
  );

  elements.overviewQueue.textContent = `${queueCount}건`;
  elements.overviewQueueText.textContent =
    queueCount > 0 ? `미응답 또는 안읽음 대화 ${queueCount}건` : "현재 응답 대기 대화가 없습니다";

  elements.overviewSync.textContent = syncValue
    ? formatCompactTimestamp(syncValue)
    : "대기 중";
  elements.overviewSyncText.textContent = running
    ? "실시간 워커가 최신 대화 상태를 읽는 중입니다"
    : "자동화 시작 후 동기화 시각이 표시됩니다";

  elements.overviewChannel.textContent = activeChannel;
  elements.overviewChannelText.textContent = state.liveOverview?.partnerCode
    ? `채널 코드 ${state.liveOverview.partnerCode}`
    : "현재 선택된 톡톡 채널";

  elements.overviewDraft.textContent = draftTitle;
  elements.overviewDraftText.textContent = draftDetail;
}

function setActiveFocusTab(tabName) {
  state.activeFocusTab = tabName;
  for (const button of elements.focusTabButtons) {
    button.classList.toggle("active", button.dataset.focusTab === tabName);
  }
  for (const panel of elements.focusPanels) {
    panel.classList.toggle("active", panel.dataset.focusPanel === tabName);
  }
}

function setConversationSource(conversations) {
  state.conversations = conversations;
  renderDashboardSummary();
  applyFilter(getCurrentSearchQuery());
}

function clearConversationSource() {
  state.currentConversationId = null;
  state.currentConversation = null;
  state.reviewedDraftSignature = "";
  state.lastConversationListSignature = "";
  setConversationSource([]);
  setActiveFocusTab("thread");
  elements.customerName.textContent = "실시간 대화를 기다리는 중";
  elements.orderSummary.textContent = "자동화 시작 후 현재 톡톡 대화가 표시됩니다";
  elements.productTags.innerHTML = "";
  elements.thread.innerHTML =
    '<p class="empty-text">실시간 상담을 선택하면 메시지와 추천 답변이 표시됩니다.</p>';
  resetSuggestionView();
}

function getCurrentDraftSignature() {
  return `${state.currentConversationId ?? "none"}:${elements.draftReply.value.trim()}`;
}

function updateReviewButtonState() {
  const hasDraft = Boolean(elements.draftReply.value.trim());
  const reviewed =
    hasDraft &&
    state.reviewedDraftSignature &&
    state.reviewedDraftSignature === getCurrentDraftSignature();

  elements.reviewButton.disabled = !hasDraft;
  elements.reviewButton.textContent = reviewed ? "검토 완료됨" : "검토 완료";
  elements.reviewStatus.textContent = hasDraft
    ? reviewed
      ? "운영자 검토 완료. 고객 전송은 계속 차단된 상태입니다."
      : "초안을 확인하고 필요하면 직접 수정한 뒤 검토 완료를 누르세요."
    : "초안이 생성되면 내용을 확인하고 필요시 직접 수정한 뒤 검토 완료를 누르세요.";

  if (elements.overviewDraft) {
    renderDashboardSummary();
  }
}

function renderConversationList(conversations) {
  const signature = JSON.stringify(
    conversations.map((conversation) => [
      conversation.id,
      conversation.customerName,
      conversation.preview,
      conversation.timeLabel,
      conversation.unreadCount,
      state.currentConversationId === conversation.id
    ])
  );

  if (signature === state.lastConversationListSignature) {
    return;
  }

  state.lastConversationListSignature = signature;
  elements.conversationCount.textContent = `${conversations.length}건`;
  elements.conversationList.innerHTML = "";

  if (!conversations.length) {
    elements.conversationList.innerHTML =
      '<p class="empty-text">실시간 대화가 아직 없거나 자동화 워커가 시작되지 않았습니다.</p>';
    return;
  }

  for (const conversation of conversations) {
    const fragment = elements.conversationItemTemplate.content.cloneNode(true);
    const button = fragment.querySelector(".conversation-item");
    button.dataset.id = conversation.id;
    button.classList.toggle("active", state.currentConversationId === conversation.id);
    button.querySelector(".conversation-name").textContent = conversation.customerName;
    button.querySelector(".conversation-date").textContent = conversation.isLive
      ? [
          conversation.timeLabel || "방금 전",
          conversation.unreadCount > 0 ? `안읽음 ${conversation.unreadCount}` : ""
        ]
          .filter(Boolean)
          .join(" / ")
      : conversation.latestOrderDate || "주문일 미확인";
    button.querySelector(".conversation-products").textContent =
      conversation.productNames?.join(" / ") ||
      (conversation.isLive ? "실시간 대화" : "상품명 없음");
    button.querySelector(".conversation-preview").textContent =
      conversation.preview || "최근 메시지 없음";

    if (conversation.awaitingReply || conversation.unreadCount > 0) {
      button.classList.add("awaiting");
    }

    button.addEventListener("click", () => {
      selectConversation(conversation.id).catch((error) => {
        elements.automationStatus.textContent = error.message;
      });
    });
    elements.conversationList.appendChild(fragment);
  }
}

function renderThread(conversation) {
  const signature = JSON.stringify({
    id: conversation.id,
    messages: conversation.messages,
    products: conversation.productNames
  });
  if (signature === state.lastThreadSignature) {
    return;
  }
  state.lastThreadSignature = signature;
  renderDashboardSummary();
  elements.customerName.textContent = conversation.customerName;
  elements.orderSummary.textContent = conversation.orderSummary;
  elements.productTags.innerHTML = "";
  elements.thread.innerHTML = "";

  for (const productName of conversation.productNames ?? []) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = productName;
    elements.productTags.appendChild(tag);
  }

  for (const message of conversation.messages ?? []) {
    const bubble = document.createElement("article");
    bubble.className = `bubble ${message.role === "customer" ? "customer" : "seller"}`;
    bubble.innerHTML = `
      <span class="bubble-role">${message.role === "customer" ? "고객" : "판매자"}</span>
      <p>${message.text}</p>
    `;
    elements.thread.appendChild(bubble);
  }
}

function resetSuggestionView() {
  state.currentSuggestion = null;
  state.reviewedDraftSignature = "";
  state.lastSuggestionSignature = "";
  elements.draftReply.value = "";
  renderFlags([]);
  renderEvidence([]);
  elements.confidenceBar.style.width = "0%";
  elements.confidenceText.textContent = "신뢰도 -";
  renderLlmStatus(state.settings?.llmStatus);
  updateReviewButtonState();
  renderDashboardSummary();
}

function updateSendButtonState() {
  const monitorOnly = isMonitorOnly();

  if (monitorOnly) {
    elements.sendButton.disabled = true;
    elements.sendButton.title = "테스트 목적이라 고객 전송이 비활성화되어 있습니다.";
    elements.sendButton.textContent = "전송 차단";
    return;
  }

  elements.sendButton.disabled = false;
  elements.sendButton.title = "";
  elements.sendButton.textContent = "검토 후 전송";
}

function renderFlags(flags = []) {
  elements.flagList.innerHTML = "";
  if (!flags.length) {
    elements.flagList.innerHTML = '<span class="flag success">민감 키워드 없음</span>';
    return;
  }

  for (const flag of flags) {
    const tag = document.createElement("span");
    tag.className = "flag danger";
    tag.textContent = `${flag.label}: ${flag.reason}`;
    elements.flagList.appendChild(tag);
  }
}

function renderEvidence(evidence = []) {
  elements.evidenceList.innerHTML = "";
  if (!evidence.length) {
    elements.evidenceList.innerHTML =
      '<p class="empty-text">정책 룰 또는 유사 사례를 찾지 못했습니다.</p>';
    return;
  }

  for (const item of evidence) {
    const card = document.createElement("article");
    card.className = "evidence-card";
    card.innerHTML = `
      <div class="panel-row compact">
        <strong>${item.source}</strong>
        <span>${Math.round((item.score || 0) * 100)}점</span>
      </div>
      <p class="evidence-product">${item.productName || "정책 근거"}</p>
      <p class="evidence-text"><strong>문의:</strong> ${item.customerText}</p>
      <p class="evidence-text"><strong>답변:</strong> ${item.answerText}</p>
    `;
    elements.evidenceList.appendChild(card);
  }
}

function renderSuggestion(suggestion) {
  const signature = JSON.stringify({
    replyText: suggestion.replyText,
    confidence: suggestion.confidence,
    generationSource: suggestion.generationSource,
    evidence: suggestion.evidence?.map((item) => item.id)
  });
  if (signature === state.lastSuggestionSignature) {
    return;
  }
  state.lastSuggestionSignature = signature;
  state.currentSuggestion = suggestion;
  state.reviewedDraftSignature = "";
  elements.draftReply.value = suggestion.replyText;
  renderFlags(suggestion.flags);
  renderEvidence(suggestion.evidence);
  elements.confidenceBar.style.width = `${Math.round(suggestion.confidence * 100)}%`;
  const sourceLabel = getSuggestionSourceLabel(suggestion);
  elements.confidenceText.textContent = `신뢰도 ${Math.round(
    suggestion.confidence * 100
  )}% / ${sourceLabel} / ${suggestion.canAutoSend ? "자동 발송 가능" : "검토 필요"}`;
  renderLlmStatus(state.settings?.llmStatus ?? suggestion.llm, suggestion);
  updateReviewButtonState();
  renderDashboardSummary();
}

function applyFilter(query) {
  const lowered = query.trim().toLowerCase();
  if (!lowered) {
    state.filteredConversations = [...state.conversations];
  } else {
    state.filteredConversations = state.conversations.filter((conversation) => {
      const haystack = [
        conversation.customerName,
        conversation.preview,
        conversation.orderSummary,
        (conversation.productNames ?? []).join(" ")
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(lowered);
    });
  }
  renderConversationList(state.filteredConversations);
}

function hydrateLiveConversation(live) {
  state.liveOverview = live;
  renderDashboardSummary();
  if (!live?.running) {
    return;
  }

  if (live.selectedConversation) {
    state.currentConversationId = live.selectedConversation.id;
    state.currentConversation = live.selectedConversation;
  } else {
    state.currentConversationId = null;
    state.currentConversation = null;
  }

  setConversationSource(live.conversations ?? []);

  if (live.selectedConversation) {
    renderThread(live.selectedConversation);
  }

  if (live.suggestion) {
    renderSuggestion(live.suggestion);
  } else if (live.selectedConversation) {
    resetSuggestionView();
  }
}

async function selectLiveConversation(conversationId) {
  const payload = await request("/api/live/select", {
    method: "POST",
    body: JSON.stringify({ conversationId })
  });
  setActiveFocusTab("thread");
  hydrateLiveConversation(payload.live);
  updateSendButtonState();
}

async function selectConversation(conversationId) {
  if (!conversationId.startsWith("live:") || !hasLiveMonitor()) {
    return;
  }
  await selectLiveConversation(conversationId);
}

function buildCurrentConversationRequestBody() {
  if (!state.currentConversation) {
    return null;
  }

  return {
    customerName: state.currentConversation.customerName,
    purchaseHistory: state.currentConversation.purchaseHistory ?? [],
    messages: state.currentConversation.messages ?? [],
    productNames: state.currentConversation.productNames ?? []
  };
}

async function generateSuggestion() {
  if (!state.currentConversation?.isLive) {
    elements.automationStatus.textContent =
      "실시간 대화를 선택한 뒤 초안을 생성해 주세요.";
    return;
  }

  const payload = await request("/api/suggest", {
    method: "POST",
    body: JSON.stringify(buildCurrentConversationRequestBody())
  });
  setActiveFocusTab("draft");
  renderSuggestion(payload.suggestion);
}

async function saveMode() {
  const payload = await request("/api/settings", {
    method: "POST",
    body: JSON.stringify({ mode: elements.modeSelect.value })
  });
  state.settings = { ...payload.settings, llmStatus: payload.llmStatus };
  elements.modeSelect.value = payload.settings.mode;
  elements.modeSelect.disabled = isMonitorOnly();
  updateSendButtonState();
  renderLlmStatus(state.settings.llmStatus ?? state.currentSuggestion?.llm);
  renderDashboardSummary();
}

async function saveActiveAccount() {
  const payload = await request("/api/settings", {
    method: "POST",
    body: JSON.stringify({ activeAccountId: elements.accountSelect.value })
  });
  state.settings = { ...payload.settings, llmStatus: payload.llmStatus };
  state.liveOverview = null;
  renderAccountSelect(payload.settings);
  elements.modeSelect.disabled = isMonitorOnly();
  updateSendButtonState();
  await refreshAutomationStatus();
  if (!hasLiveMonitor()) {
    clearConversationSource();
  }
  renderDashboardSummary();
}

async function refreshLiveOverview() {
  if (!hasLiveMonitor()) {
    return;
  }

  const payload = await request("/api/live/overview");
  hydrateLiveConversation(payload.live);
}

async function refreshAutomationStatus() {
  const payload = await request("/api/automation/status");
  const { automation } = payload;
  const accountLabel = state.activeAccount ? `선택 채널 ${state.activeAccount.name}` : "채널 미선택";
  const monitorLabel = isMonitorOnly() ? " / 테스트 모니터링 / 고객 전송 차단" : "";

  if (automation.running) {
    elements.automationStatus.textContent = `${accountLabel}${monitorLabel} / 브라우저 실행 중 / 최근 동기화 ${
      formatStatusTimestamp(automation.live?.updatedAt ?? automation.lastDraft?.at)
    }`;
    state.liveOverview = automation.live ?? state.liveOverview;
  } else if (automation.lastError) {
    elements.automationStatus.textContent = `${accountLabel}${monitorLabel} / 중지됨 / ${automation.lastError}`;
    state.liveOverview = null;
  } else {
    elements.automationStatus.textContent = `${accountLabel}${monitorLabel} / 자동화 워커 정지 상태`;
    state.liveOverview = null;
  }

  if (!automation.running) {
    clearConversationSource();
  }

  renderDashboardSummary();

  return automation;
}

async function startAutomation() {
  try {
    await request("/api/automation/start", { method: "POST" });
  } catch (error) {
    elements.automationStatus.textContent = error.message;
    return;
  }

  await refreshAutomationStatus();
  await refreshLiveOverview();
  updateSendButtonState();
}

async function stopAutomation() {
  await request("/api/automation/stop", { method: "POST" });
  await refreshAutomationStatus();
  updateSendButtonState();
}

async function sendDraft() {
  elements.automationStatus.textContent =
    "테스트 모드에서는 고객에게 실제 답변을 전송할 수 없습니다.";
}

async function markDraftReviewed() {
  if (!elements.draftReply.value.trim()) {
    return;
  }

  state.reviewedDraftSignature = getCurrentDraftSignature();
  updateReviewButtonState();
  renderDashboardSummary();
  elements.automationStatus.textContent =
    "현재 초안을 운영자 검토 완료로 표시했습니다. 고객 전송은 차단 상태입니다.";
}

async function copyDraft() {
  if (!elements.draftReply.value) {
    return;
  }
  await navigator.clipboard.writeText(elements.draftReply.value);
  elements.copyButton.textContent = "복사됨";
  window.setTimeout(() => {
    elements.copyButton.textContent = "답변 복사";
  }, 1200);
}

async function pollLiveMonitor() {
  try {
    const automation = await refreshAutomationStatus();
    if (automation?.running) {
      await refreshLiveOverview();
    }
  } catch (error) {
    elements.automationStatus.textContent = error.message;
  }
}

function startPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
  }

  state.pollTimer = window.setInterval(() => {
    pollLiveMonitor().catch((error) => {
      elements.automationStatus.textContent = error.message;
    });
  }, POLL_INTERVAL_MS);
}

async function bootstrap() {
  const payload = await request("/api/bootstrap");
  state.settings = { ...payload.settings, llmStatus: payload.llmStatus };
  state.liveOverview = payload.live;

  renderMetrics(payload.stats);
  renderAccountSelect(payload.settings);
  elements.modeSelect.value = payload.settings.mode;
  elements.modeSelect.disabled = isMonitorOnly();
  renderLlmStatus(payload.llmStatus);
  updateSendButtonState();
  updateReviewButtonState();
  renderDashboardSummary();
  startPolling();

  await refreshAutomationStatus();

  if (payload.live?.running) {
    hydrateLiveConversation(payload.live);
    updateSendButtonState();
    return;
  }

  clearConversationSource();
}

elements.searchInput.addEventListener("input", (event) => {
  applyFilter(event.target.value);
});
elements.accountSelect.addEventListener("change", saveActiveAccount);
elements.modeSelect.addEventListener("change", saveMode);
elements.generateButton.addEventListener("click", generateSuggestion);
elements.reviewButton.addEventListener("click", markDraftReviewed);
elements.sendButton.addEventListener("click", sendDraft);
elements.startAutomationButton.addEventListener("click", startAutomation);
elements.stopAutomationButton.addEventListener("click", stopAutomation);
elements.copyButton.addEventListener("click", copyDraft);
elements.draftReply.addEventListener("input", updateReviewButtonState);
for (const button of elements.focusTabButtons) {
  button.addEventListener("click", () => {
    setActiveFocusTab(button.dataset.focusTab);
  });
}

bootstrap().catch((error) => {
  elements.automationStatus.textContent = error.message;
});
