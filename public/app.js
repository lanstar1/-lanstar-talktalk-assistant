const state = {
  conversations: [],
  filteredConversations: [],
  currentConversationId: null,
  currentConversation: null,
  currentSuggestion: null,
  settings: null,
  activeAccount: null
};

const elements = {
  metrics: document.querySelector("#metrics"),
  llmStatusText: document.querySelector("#llmStatusText"),
  searchInput: document.querySelector("#searchInput"),
  accountSelect: document.querySelector("#accountSelect"),
  modeSelect: document.querySelector("#modeSelect"),
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
  sendButton: document.querySelector("#sendButton"),
  draftReply: document.querySelector("#draftReply"),
  flagList: document.querySelector("#flagList"),
  confidenceBar: document.querySelector("#confidenceBar"),
  confidenceText: document.querySelector("#confidenceText"),
  evidenceList: document.querySelector("#evidenceList"),
  copyButton: document.querySelector("#copyButton"),
  conversationItemTemplate: document.querySelector("#conversationItemTemplate")
};

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
    elements.llmStatusText.textContent = `${base} / 호출 실패: ${suggestion.llm.error}`;
    return;
  }

  elements.llmStatusText.textContent = `${base} / 이번 초안은 규칙+검색만 사용`;
}

function renderConversationList(conversations) {
  elements.conversationCount.textContent = `${conversations.length}건`;
  elements.conversationList.innerHTML = "";

  for (const conversation of conversations) {
    const fragment = elements.conversationItemTemplate.content.cloneNode(true);
    const button = fragment.querySelector(".conversation-item");
    button.dataset.id = conversation.id;
    button.classList.toggle("active", state.currentConversationId === conversation.id);
    button.querySelector(".conversation-name").textContent = conversation.customerName;
    button.querySelector(".conversation-date").textContent =
      conversation.latestOrderDate || "주문일 미확인";
    button.querySelector(".conversation-products").textContent =
      conversation.productNames.join(" / ") || "상품명 없음";
    button.querySelector(".conversation-preview").textContent = conversation.preview;

    if (conversation.awaitingReply) {
      button.classList.add("awaiting");
    }

    button.addEventListener("click", () => selectConversation(conversation.id));
    elements.conversationList.appendChild(fragment);
  }
}

function renderThread(conversation) {
  elements.customerName.textContent = conversation.customerName;
  elements.orderSummary.textContent = conversation.orderSummary;
  elements.productTags.innerHTML = "";
  elements.thread.innerHTML = "";

  for (const productName of conversation.productNames) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = productName;
    elements.productTags.appendChild(tag);
  }

  for (const message of conversation.messages) {
    const bubble = document.createElement("article");
    bubble.className = `bubble ${message.role}`;
    bubble.innerHTML = `
      <span class="bubble-role">${message.role === "customer" ? "고객" : "판매자"}</span>
      <p>${message.text}</p>
    `;
    elements.thread.appendChild(bubble);
  }
}

function renderFlags(flags = []) {
  elements.flagList.innerHTML = "";
  if (!flags.length) {
    elements.flagList.innerHTML =
      '<span class="flag success">민감 키워드 없음</span>';
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
  state.currentSuggestion = suggestion;
  elements.draftReply.value = suggestion.replyText;
  renderFlags(suggestion.flags);
  renderEvidence(suggestion.evidence);
  elements.confidenceBar.style.width = `${Math.round(suggestion.confidence * 100)}%`;
  const sourceLabel =
    suggestion.generationSource === "llm_hybrid"
      ? "LLM 보강"
      : suggestion.generationSource === "policy"
        ? "정책 응답"
        : suggestion.generationSource === "retrieval"
          ? "기존 이력 재사용"
          : "기본 응답";
  elements.confidenceText.textContent = `신뢰도 ${Math.round(
    suggestion.confidence * 100
  )}% / ${sourceLabel} / ${suggestion.canAutoSend ? "자동 발송 가능" : "검토 필요"}`;
  renderLlmStatus(state.settings?.llmStatus ?? suggestion.llm, suggestion);
}

async function selectConversation(conversationId) {
  state.currentConversationId = conversationId;
  renderConversationList(state.filteredConversations);

  const payload = await request(`/api/conversations/${encodeURIComponent(conversationId)}`);
  state.currentConversation = payload.conversation;
  renderThread(payload.conversation);
  elements.draftReply.value = "";
  renderFlags([]);
  renderEvidence([]);
  elements.confidenceBar.style.width = "0%";
  elements.confidenceText.textContent = "신뢰도 -";
}

async function generateSuggestion() {
  if (!state.currentConversationId) {
    return;
  }

  const payload = await request("/api/suggest", {
    method: "POST",
    body: JSON.stringify({ conversationId: state.currentConversationId })
  });
  renderSuggestion(payload.suggestion);
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
        conversation.productNames.join(" ")
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(lowered);
    });
  }
  renderConversationList(state.filteredConversations);
}

async function saveMode() {
  const payload = await request("/api/settings", {
    method: "POST",
    body: JSON.stringify({ mode: elements.modeSelect.value })
  });
  state.settings = { ...payload.settings, llmStatus: payload.llmStatus };
  elements.modeSelect.value = payload.settings.mode;
  renderLlmStatus(state.settings.llmStatus ?? state.currentSuggestion?.llm);
}

async function saveActiveAccount() {
  const payload = await request("/api/settings", {
    method: "POST",
    body: JSON.stringify({ activeAccountId: elements.accountSelect.value })
  });
  state.settings = { ...payload.settings, llmStatus: payload.llmStatus };
  renderAccountSelect(payload.settings);
  await refreshAutomationStatus();
}

async function refreshAutomationStatus() {
  const payload = await request("/api/automation/status");
  const { automation } = payload;
  const accountLabel = state.activeAccount ? `선택 계정 ${state.activeAccount.name}` : "계정 미선택";

  if (automation.running) {
    elements.automationStatus.textContent = `${accountLabel} / 브라우저 실행 중 / 최근 초안 ${
      automation.lastDraft?.at ?? "없음"
    }${automation.lastDraft?.llmUsed ? " / LLM 보강 사용" : ""}`;
  } else if (automation.lastError) {
    elements.automationStatus.textContent = `${accountLabel} / 중지됨 / ${automation.lastError}`;
  } else {
    elements.automationStatus.textContent = `${accountLabel} / 자동화 워커 정지 상태`;
  }
}

async function startAutomation() {
  try {
    await request("/api/automation/start", { method: "POST" });
  } catch (error) {
    elements.automationStatus.textContent = error.message;
    return;
  }
  await refreshAutomationStatus();
}

async function stopAutomation() {
  await request("/api/automation/stop", { method: "POST" });
  await refreshAutomationStatus();
}

async function sendDraft() {
  const replyText = elements.draftReply.value.trim();
  if (!replyText) {
    elements.automationStatus.textContent = "전송할 답변이 없습니다.";
    return;
  }

  try {
    const payload = await request("/api/automation/manual-send", {
      method: "POST",
      body: JSON.stringify({ replyText })
    });
    elements.automationStatus.textContent = `${state.activeAccount?.name ?? "계정"} 계정으로 답변을 전송했습니다.`;
    return payload;
  } catch (error) {
    elements.automationStatus.textContent = error.message;
  }
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

async function bootstrap() {
  const payload = await request("/api/bootstrap");
  state.conversations = payload.conversations;
  state.filteredConversations = [...payload.conversations];

  renderMetrics(payload.stats);
  state.settings = { ...payload.settings, llmStatus: payload.llmStatus };
  renderAccountSelect(payload.settings);
  renderConversationList(state.filteredConversations);
  elements.modeSelect.value = payload.settings.mode;
  renderLlmStatus(payload.llmStatus);
  await refreshAutomationStatus();

  const firstAwaiting =
    payload.conversations.find((conversation) => conversation.awaitingReply) ??
    payload.conversations[0];
  if (firstAwaiting) {
    await selectConversation(firstAwaiting.id);
    await generateSuggestion();
  }
}

elements.searchInput.addEventListener("input", (event) => {
  applyFilter(event.target.value);
});
elements.accountSelect.addEventListener("change", saveActiveAccount);
elements.modeSelect.addEventListener("change", saveMode);
elements.generateButton.addEventListener("click", generateSuggestion);
elements.sendButton.addEventListener("click", sendDraft);
elements.startAutomationButton.addEventListener("click", startAutomation);
elements.stopAutomationButton.addEventListener("click", stopAutomation);
elements.copyButton.addEventListener("click", copyDraft);

bootstrap().catch((error) => {
  elements.automationStatus.textContent = error.message;
});
