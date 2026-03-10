const state = {
  conversations: [],
  filteredConversations: [],
  currentConversationId: null,
  currentConversation: null,
  manualConversation: null,
  previousConversationId: null,
  currentSuggestion: null,
  settings: null,
  activeAccount: null
};

const elements = {
  metrics: document.querySelector("#metrics"),
  llmStatusText: document.querySelector("#llmStatusText"),
  searchInput: document.querySelector("#searchInput"),
  manualCustomerName: document.querySelector("#manualCustomerName"),
  manualMessage: document.querySelector("#manualMessage"),
  manualHasOrder: document.querySelector("#manualHasOrder"),
  manualProductName: document.querySelector("#manualProductName"),
  manualOrderStatus: document.querySelector("#manualOrderStatus"),
  manualOrderDate: document.querySelector("#manualOrderDate"),
  manualOrderNumber: document.querySelector("#manualOrderNumber"),
  applyManualTestButton: document.querySelector("#applyManualTestButton"),
  resetManualTestButton: document.querySelector("#resetManualTestButton"),
  manualTestStatus: document.querySelector("#manualTestStatus"),
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

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function createManualPurchaseHistory() {
  if (!elements.manualHasOrder.checked) {
    return [];
  }

  const productName = elements.manualProductName.value.trim() || "테스트 상품";
  const orderStatus = elements.manualOrderStatus.value || "결제완료";
  const orderDate = elements.manualOrderDate.value || todayString();
  const orderNumber = elements.manualOrderNumber.value.trim() || "202603100001";

  return [
    {
      주문날짜: orderDate,
      주문번호: orderNumber,
      상품목록: [
        {
          상품명: productName,
          상태: orderStatus
        }
      ]
    }
  ];
}

function buildManualConversation() {
  const customerName = elements.manualCustomerName.value.trim() || "테스트 고객";
  const question = elements.manualMessage.value.trim();
  const purchaseHistory = createManualPurchaseHistory();
  const productName =
    elements.manualProductName.value.trim() ||
    purchaseHistory[0]?.상품목록?.[0]?.상품명 ||
    "";
  const productNames = productName ? [productName] : [];
  const latestOrder = purchaseHistory[0];
  const orderSummary = latestOrder
    ? `${latestOrder.주문날짜} / ${latestOrder.주문번호} / ${productName || "테스트 상품"}`
    : "테스트 문의 / 주문 내역 없음";

  return {
    id: "manual:test",
    isManual: true,
    customerName,
    purchaseHistory,
    orderSummary,
    latestOrderDate: latestOrder?.주문날짜 ?? "",
    productNames,
    messages: [
      {
        role: "customer",
        text: question
      }
    ],
    awaitingReply: true,
    preview: question
  };
}

function markManualConversationDirty() {
  if (!state.manualConversation) {
    return;
  }

  elements.manualTestStatus.textContent =
    "테스트 문의 입력값이 변경되었습니다. 초안 생성을 누르면 새 질문 기준으로 다시 생성합니다.";
}

function syncManualConversationFromForm() {
  const question = elements.manualMessage.value.trim();
  if (!question) {
    elements.manualTestStatus.textContent = "테스트할 고객 문의를 먼저 입력해 주세요.";
    elements.manualMessage.focus();
    return false;
  }

  state.manualConversation = buildManualConversation();
  renderThread(state.manualConversation);
  updateSendButtonState();
  return true;
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

function resetSuggestionView() {
  state.currentSuggestion = null;
  elements.draftReply.value = "";
  renderFlags([]);
  renderEvidence([]);
  elements.confidenceBar.style.width = "0%";
  elements.confidenceText.textContent = "신뢰도 -";
  renderLlmStatus(state.settings?.llmStatus);
}

function updateSendButtonState() {
  const disabled = false;
  elements.sendButton.disabled = disabled;
  elements.sendButton.title = state.manualConversation
    ? "테스트 문의에서는 실제 톡톡 전송 대신 화면에 판매자 답변으로 반영됩니다."
    : "";
  elements.sendButton.textContent = state.manualConversation
    ? "테스트 반영"
    : "검토 후 전송";
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
      : suggestion.generationSource === "retrieval_contextual"
        ? "문맥 기반 초안"
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
  state.manualConversation = null;
  state.previousConversationId = conversationId;
  state.currentConversationId = conversationId;
  renderConversationList(state.filteredConversations);

  const payload = await request(`/api/conversations/${encodeURIComponent(conversationId)}`);
  state.currentConversation = payload.conversation;
  renderThread(payload.conversation);
  resetSuggestionView();
  updateSendButtonState();
  elements.manualTestStatus.textContent =
    "질문을 입력한 뒤 테스트 초안 생성을 누르세요.";
}

async function generateSuggestion() {
  let requestBody = null;
  if (state.manualConversation) {
    if (!syncManualConversationFromForm()) {
      return;
    }

    requestBody = {
      customerName: state.manualConversation.customerName,
      purchaseHistory: state.manualConversation.purchaseHistory,
      messages: state.manualConversation.messages,
      productNames: state.manualConversation.productNames
    };
  } else if (state.currentConversationId) {
    requestBody = { conversationId: state.currentConversationId };
  }

  if (!requestBody) {
    return;
  }

  const payload = await request("/api/suggest", {
    method: "POST",
    body: JSON.stringify(requestBody)
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
  const accountLabel = state.activeAccount ? `선택 채널 ${state.activeAccount.name}` : "채널 미선택";

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
  if (state.manualConversation) {
    const replyText = elements.draftReply.value.trim();
    if (!replyText) {
      elements.automationStatus.textContent = "반영할 답변이 없습니다.";
      return;
    }

    state.manualConversation.messages.push({
      role: "seller",
      text: replyText
    });
    renderThread(state.manualConversation);
    elements.automationStatus.textContent =
      "테스트 문의에 판매자 답변으로 반영했습니다. 실제 톡톡에는 전송되지 않았습니다.";
    return;
  }

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
    elements.automationStatus.textContent = `${state.activeAccount?.name ?? "선택 채널"} 채널 대화창으로 답변을 전송했습니다.`;
    return payload;
  } catch (error) {
    elements.automationStatus.textContent = error.message;
  }
}

async function applyManualTest() {
  const question = elements.manualMessage.value.trim();
  if (!question) {
    elements.manualTestStatus.textContent = "테스트할 고객 문의를 먼저 입력해 주세요.";
    elements.manualMessage.focus();
    return;
  }

  if (state.currentConversationId) {
    state.previousConversationId = state.currentConversationId;
  }

  state.currentConversationId = null;
  state.currentConversation = null;
  state.manualConversation = buildManualConversation();
  renderConversationList(state.filteredConversations);
  renderThread(state.manualConversation);
  resetSuggestionView();
  updateSendButtonState();
  elements.manualTestStatus.textContent =
    "테스트 문의를 열었습니다. 초안을 생성 중입니다.";

  try {
    await generateSuggestion();
    elements.manualTestStatus.textContent =
      "테스트 초안 생성이 완료되었습니다. 실제 전송은 비활성화되어 있습니다.";
  } catch (error) {
    elements.manualTestStatus.textContent = error.message;
  }
}

async function resetManualTest() {
  state.manualConversation = null;
  elements.manualCustomerName.value = "테스트 고객";
  elements.manualMessage.value = "";
  elements.manualHasOrder.checked = false;
  elements.manualProductName.value = "";
  elements.manualOrderStatus.value = "";
  elements.manualOrderDate.value = "";
  elements.manualOrderNumber.value = "";
  elements.manualTestStatus.textContent =
    "질문을 입력한 뒤 테스트 초안 생성을 누르세요.";
  updateSendButtonState();

  if (state.previousConversationId) {
    await selectConversation(state.previousConversationId);
    await generateSuggestion();
    return;
  }

  resetSuggestionView();
  elements.customerName.textContent = "대화를 선택해 주세요";
  elements.orderSummary.textContent = "주문 정보 없음";
  elements.productTags.innerHTML = "";
  elements.thread.innerHTML = "";
  renderConversationList(state.filteredConversations);
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
  elements.manualOrderDate.value = todayString();
  updateSendButtonState();
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
elements.applyManualTestButton.addEventListener("click", applyManualTest);
elements.resetManualTestButton.addEventListener("click", () => {
  resetManualTest().catch((error) => {
    elements.manualTestStatus.textContent = error.message;
  });
});
elements.accountSelect.addEventListener("change", saveActiveAccount);
elements.modeSelect.addEventListener("change", saveMode);
elements.generateButton.addEventListener("click", generateSuggestion);
elements.sendButton.addEventListener("click", sendDraft);
elements.startAutomationButton.addEventListener("click", startAutomation);
elements.stopAutomationButton.addEventListener("click", stopAutomation);
elements.copyButton.addEventListener("click", copyDraft);
[
  elements.manualCustomerName,
  elements.manualMessage,
  elements.manualProductName,
  elements.manualOrderStatus,
  elements.manualOrderDate,
  elements.manualOrderNumber
].forEach((input) => {
  input.addEventListener("input", markManualConversationDirty);
  input.addEventListener("change", markManualConversationDirty);
});
elements.manualHasOrder.addEventListener("change", markManualConversationDirty);

bootstrap().catch((error) => {
  elements.automationStatus.textContent = error.message;
});
