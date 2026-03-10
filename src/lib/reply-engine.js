import {
  buildSearchIndexParts,
  cleanAnswer,
  extractModelIdentifiers,
  extractOrderStatuses,
  extractProductNames,
  extractSupportSignals,
  normalizeText,
  normalizeWhitespace,
  scoreSearch,
  snippet,
  summarizePurchaseHistory,
  unique
} from "./text-utils.js";

const DEFAULT_LLM_SETTINGS = {
  enabled: true,
  enhanceWhenConfidenceBelow: 0.78,
  weakAnswerLength: 140,
  maxEvidenceCount: 4,
  allowAutoSend: false
};

function includesAny(text, keywords = []) {
  return keywords.some((keyword) => text.includes(normalizeText(keyword)));
}

function buildEvidenceFromMatch(match) {
  return {
    id: match.example.id,
    source: match.example.source,
    productName: match.example.productName,
    score: match.score,
    customerText: snippet(match.example.customerText, 90),
    answerText: snippet(match.example.answerText, 120)
  };
}

function maybeAddGreetingAndClosing(body, policies) {
  const cleaned = cleanAnswer(body);
  const greeting = policies.greeting ?? "";
  const closing = policies.closing ?? "";
  const normalizedBody = normalizeText(cleaned);

  if (
    normalizeText(greeting) &&
    normalizedBody.startsWith(normalizeText(greeting))
  ) {
    return cleaned;
  }

  return [greeting, cleaned, closing].filter(Boolean).join("\n\n");
}

function llmReasonLabel(reason) {
  return (
    {
      no_history: "기존 이력 없음",
      low_confidence: "검색 신뢰도 낮음",
      weak_answer: "기존 답변 약함",
      needs_reasoning: "추론형 기술지원 필요"
    }[reason] ?? "LLM 보강"
  );
}

function hasSharedModel(left = [], right = []) {
  if (!left.length || !right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function countSharedSignals(left = [], right = []) {
  if (!left.length || !right.length) {
    return 0;
  }

  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}

function includesSignal(signals = [], targets = []) {
  return targets.some((target) => signals.includes(target));
}

function detectProductContext(productNames = []) {
  const normalized = normalizeText(productNames.join(" "));

  return {
    requiresDriver:
      (normalized.includes("usb3.0") && normalized.includes("hdmi")) ||
      normalized.includes("displaylink"),
    requiresAltMode:
      (normalized.includes("usb-c") ||
        normalized.includes("type-c") ||
        normalized.includes("c타입")) &&
      (normalized.includes("hdmi") ||
        normalized.includes("displayport") ||
        normalized.includes("dp")) &&
      !normalized.includes("displaylink") &&
      !normalized.includes("usb3.0")
  };
}

function collectActionHints(matches = []) {
  const hints = new Set();

  for (const match of matches) {
    const text = normalizeText(
      [
        match.example.customerText,
        match.example.answerText,
        match.example.productName
      ].join(" ")
    );

    if (
      text.includes("드라이버") ||
      text.includes("프로그램 설치") ||
      text.includes("재설치")
    ) {
      hints.add("driver");
    }

    if (
      text.includes("다른 컴퓨터") ||
      text.includes("다른 usb") ||
      text.includes("다른 포트") ||
      text.includes("직접 연결") ||
      text.includes("재연결")
    ) {
      hints.add("other_port");
    }

    if (text.includes("케이블") || text.includes("hdmi") || text.includes("모니터")) {
      hints.add("cable");
    }

    if (
      text.includes("디스플레이 설정") ||
      text.includes("장치관리자") ||
      text.includes("장치 관리자") ||
      text.includes("해상도") ||
      text.includes("인식")
    ) {
      hints.add("display_settings");
    }

    if (text.includes("재부팅")) {
      hints.add("reboot");
    }

    if (text.includes("alt mode") || text.includes("display alt mode")) {
      hints.add("alt_mode");
    }
  }

  return [...hints];
}

function buildTechnicalRetrievalReply({
  customerText,
  productNames,
  supportSignals,
  productContext,
  actionHints
}) {
  let opening = "문의주신 증상으로 보아 우선 연결 상태와 설치 상태를 먼저 점검해 보시는 것이 좋습니다.";
  if (
    includesSignal(supportSignals, ["display_no_signal"]) &&
    includesSignal(supportSignals, ["recognition"])
  ) {
    opening = "제품 연결 후 모니터 화면이 나오지 않고 기기 인식도 되지 않는 증상으로 확인됩니다.";
  } else if (includesSignal(supportSignals, ["display_no_signal"])) {
    opening = "제품 연결 후 모니터 화면이 출력되지 않는 증상으로 확인됩니다.";
  } else if (includesSignal(supportSignals, ["recognition"])) {
    opening = "제품 연결 후 장치 인식이 원활하지 않은 증상으로 확인됩니다.";
  } else if (includesSignal(supportSignals, ["driver"])) {
    opening = "설치 또는 드라이버 관련 증상으로 확인됩니다.";
  }

  const steps = [];
  const pushStep = (step) => {
    if (step && !steps.includes(step)) {
      steps.push(step);
    }
  };

  pushStep(
    "제품과 모니터, 케이블 연결 상태를 다시 확인하시고 가능하면 다른 케이블 또는 다른 포트로도 동일한지 먼저 확인 부탁드립니다."
  );

  if (productContext.requiresDriver || actionHints.includes("driver")) {
    pushStep(
      `${productNames[0] ?? "해당 모델"}은 드라이버 설치 또는 재설치 여부가 중요하니 설치 상태와 설치 후 재부팅 여부를 함께 확인 부탁드립니다.`
    );
  }

  if (productContext.requiresAltMode || actionHints.includes("alt_mode")) {
    pushStep(
      "사용 중인 노트북이나 기기의 C타입 포트가 영상 출력(Display Alt Mode)을 지원하는 포트인지 확인 부탁드립니다."
    );
  }

  if (
    includesSignal(supportSignals, ["display_no_signal", "recognition", "resolution"]) ||
    actionHints.includes("display_settings")
  ) {
    pushStep(
      "PC의 디스플레이 설정 또는 장치관리자에서 추가 모니터나 USB 디스플레이 장치가 인식되는지도 확인 부탁드립니다."
    );
  }

  if (actionHints.includes("other_port")) {
    pushStep(
      "가능하시면 다른 USB 포트 또는 다른 PC에서도 동일한 증상이 발생하는지 교차 테스트 부탁드립니다."
    );
  }

  if (actionHints.includes("reboot")) {
    pushStep("설치 또는 연결 변경 후에는 재부팅 뒤 다시 확인 부탁드립니다.");
  }

  const numberedSteps = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");

  return [
    opening,
    numberedSteps,
    "위 항목 확인 후에도 동일하면 사용 중인 PC/노트북 모델명, 운영체제, 연결 구성과 확인하신 결과를 남겨주시면 추가로 확인해 드리겠습니다."
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class ReplyEngine {
  constructor({ examples, policies, llmClient = null, getSettings = null }) {
    this.examples = examples;
    this.policies = policies;
    this.llmClient = llmClient;
    this.getSettings = getSettings;
  }

  getLlmSettings() {
    return {
      ...DEFAULT_LLM_SETTINGS,
      ...(this.getSettings?.().llm ?? {})
    };
  }

  getLlmStatus() {
    const clientStatus = this.llmClient?.getStatus?.() ?? {
      enabled: false,
      available: false,
      provider: "none",
      model: null,
      baseUrl: null
    };

    return {
      ...clientStatus,
      enabled: this.getLlmSettings().enabled && clientStatus.enabled !== false
    };
  }

  findMatches(
    customerText,
    productNames = [],
    modelIdentifiers = [],
    supportSignals = [],
    limit = 3
  ) {
    const queryIndex = buildSearchIndexParts(customerText);
    const normalizedProducts = productNames.map((name) => normalizeText(name));

    const scored = this.examples
      .map((example) => {
        const exampleSearchIndex =
          example.searchIndex ??
          buildSearchIndexParts(example.productName, example.customerText);
        const exampleModels =
          example.modelIdentifiers ??
          extractModelIdentifiers(example.productName, example.customerText);
        const exampleSignals =
          example.supportSignals ??
          extractSupportSignals(
            example.productName,
            example.customerText,
            example.answerText
          );
        const exactModelMatch = hasSharedModel(modelIdentifiers, exampleModels);
        const sharedSupportCount = countSharedSignals(supportSignals, exampleSignals);
        const productBonus =
          normalizedProducts.length &&
          normalizedProducts.some((name) =>
            normalizeText(example.productName).includes(name)
          )
            ? 0.12
            : 0;
        const modelBonus = exactModelMatch ? 0.45 : 0;
        const supportBonus = sharedSupportCount ? Math.min(0.24, sharedSupportCount * 0.1) : 0;
        let supportPenalty = 0;

        if (supportSignals.length && !sharedSupportCount) {
          supportPenalty += 0.16;
        }

        if (
          includesSignal(supportSignals, ["display_no_signal", "recognition"]) &&
          !includesSignal(exampleSignals, ["display_no_signal", "recognition", "driver", "resolution"])
        ) {
          supportPenalty += 0.16;
        }

        if (
          includesSignal(exampleSignals, ["rotation"]) &&
          !includesSignal(supportSignals, ["rotation"])
        ) {
          supportPenalty += 0.18;
        }

        return {
          example,
          exampleModels,
          exampleSignals,
          exactModelMatch,
          score: scoreSearch(
            queryIndex,
            exampleSearchIndex,
            productBonus + modelBonus + supportBonus - supportPenalty
          )
        };
      })
      .filter((item) => item.score > 0.12);

    if (modelIdentifiers.length) {
      const exactMatches = scored.filter((item) => item.exactModelMatch);
      if (exactMatches.length) {
        return exactMatches
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
      }

      return [];
    }

    return scored.sort((left, right) => right.score - left.score).slice(0, limit);
  }

  detectFlags(customerText) {
    const normalized = normalizeText(customerText);
    const flags = [];

    if (includesAny(normalized, this.policies.sensitiveKeywords)) {
      flags.push({
        type: "sensitive",
        label: "민감 문의",
        reviewOnly: true,
        reason: "개인정보 또는 민감 키워드가 감지되었습니다."
      });
    }

    if (includesAny(normalized, this.policies.reviewOnlyKeywords)) {
      flags.push({
        type: "policy_review",
        label: "정책 검토 필요",
        reviewOnly: true,
        reason: "환불/반품/교환 등 운영 정책 확인이 필요한 문의입니다."
      });
    }

    return flags;
  }

  matchPolicy({ customerText, purchaseHistory }) {
    const normalized = normalizeText(customerText);
    const hasOwnOrder = Array.isArray(purchaseHistory) && purchaseHistory.length > 0;

    if (includesAny(normalized, this.policies.refundKeywords)) {
      const reply = hasOwnOrder
        ? [
            "주문 내역이 확인되는 건에 대해서는 네이버쇼핑 주문내역에서 환불 또는 반품 접수로 진행 부탁드립니다.",
            "단순 변심에 의한 환불은 왕복 배송비가 청구될 수 있는 점 참고 부탁드립니다."
          ].join("\n")
        : "해당 주문이 저희 네이버쇼핑 주문내역에서 확인되지 않는 경우에는 주문하신 구매처에서 환불 또는 반품 요청을 진행해 주셔야 합니다.";

      return {
        rule: "refund",
        forceReview: true,
        autoEligible: false,
        reply,
        evidence: [
          {
            id: "policy:refund",
            source: "운영정책",
            productName: "",
            score: 1,
            customerText: "환불/반품/취소 문의",
            answerText: reply
          }
        ]
      };
    }

    if (includesAny(normalized, this.policies.addressChangeKeywords)) {
      const reply =
        "배송지 변경은 주문하신 구매처의 주문내역에서 직접 진행해 주셔야 합니다. 저희 쪽에서 임의 변경은 어려운 점 양해 부탁드립니다.";
      return {
        rule: "address_change",
        forceReview: true,
        autoEligible: false,
        reply,
        evidence: [
          {
            id: "policy:address_change",
            source: "운영정책",
            productName: "",
            score: 1,
            customerText: "배송지 변경 문의",
            answerText: reply
          }
        ]
      };
    }

    if (includesAny(normalized, this.policies.shippingKeywords)) {
      const statuses = extractOrderStatuses(purchaseHistory);
      const reply = hasOwnOrder
        ? statuses.length
          ? [
              `주문 내역상 현재 ${statuses.join(", ")} 상태로 확인됩니다.`,
              "네이버쇼핑 주문내역에서 배송 흐름도 함께 확인 부탁드립니다."
            ].join("\n")
          : "주문 내역은 확인되나 현재 상세 배송 상태는 네이버쇼핑 주문내역에서 함께 확인 부탁드립니다."
        : "해당 주문이 저희 네이버쇼핑 주문내역에서 확인되지 않는 경우에는 주문하신 구매처에서 배송 상태를 확인해 주셔야 합니다.";

      return {
        rule: "shipping",
        forceReview: false,
        autoEligible: true,
        reply,
        evidence: [
          {
            id: "policy:shipping",
            source: "주문정보",
            productName: "",
            score: 1,
            customerText: "배송 문의",
            answerText: reply
          }
        ]
      };
    }

    if (includesAny(normalized, this.policies.asKeywords)) {
      const initialDefect = includesAny(
        normalized,
        this.policies.initialDefectKeywords
      );
      const usedFault = includesAny(normalized, this.policies.usedFaultKeywords);

      let reply;
      if (initialDefect) {
        reply = [
          "초기 불량으로 확인되는 경우에는 바로 교환 진행을 도와드리고 있습니다.",
          "주문번호와 현재 증상을 함께 남겨주시면 빠르게 확인 후 절차를 안내드리겠습니다."
        ].join("\n");
      } else if (usedFault) {
        reply = [
          "사용 중 발생한 불량은 구매 후 1년 이내인 경우 무상 교환으로 안내드리고 있습니다.",
          "구매처, 주문번호, 사용 기간, 현재 증상을 남겨주시면 확인 후 절차를 안내드리겠습니다."
        ].join("\n");
      } else {
        reply = [
          "불량 또는 작동 이상 문의로 확인됩니다.",
          "초기 불량인지 사용 중 발생한 증상인지와 주문번호를 함께 알려주시면 교환 가능 여부를 확인해 드리겠습니다."
        ].join("\n");
      }

      return {
        rule: "as_policy",
        forceReview: true,
        autoEligible: false,
        reply,
        evidence: [
          {
            id: "policy:as",
            source: "운영정책",
            productName: "",
            score: 1,
            customerText: "AS/불량 문의",
            answerText: reply
          }
        ]
      };
    }

    return null;
  }

  buildFallback({ productNames }) {
    if (productNames.length) {
      return [
        `${productNames[0]} 관련 문의로 확인됩니다.`,
        "현재 증상과 사용 환경을 조금 더 자세히 알려주시면 정확히 확인 후 안내드리겠습니다."
      ].join("\n");
    }

    return this.policies.fallback;
  }

  needsModelConfirmation(customerText, modelIdentifiers = [], policyMatch = null) {
    if (!customerText || modelIdentifiers.length || policyMatch) {
      return false;
    }

    const normalized = normalizeText(customerText);
    const technicalKeywords = [
      "안되",
      "오류",
      "연결",
      "인식",
      "설치",
      "화면",
      "출력",
      "입력",
      "소리",
      "불량",
      "고장",
      "작동",
      "호환",
      "드라이버",
      "깜빡"
    ];

    return technicalKeywords.some((keyword) => normalized.includes(keyword));
  }

  buildModelRequestReply() {
    return [
      "문의 내용만으로는 정확한 제품 모델명을 확인하기 어려워 우선 모델명 확인이 필요합니다.",
      "구매하신 제품의 모델명 또는 주문내역상 상품명을 알려주시면 해당 모델 기준 상담 이력부터 먼저 확인한 뒤 안내드리겠습니다.",
      "예: LS-UH319-W, LS-UC202"
    ].join("\n");
  }

  shouldBuildTechnicalDraft(supportSignals = []) {
    return includesSignal(supportSignals, [
      "display_no_signal",
      "recognition",
      "driver",
      "audio",
      "power",
      "resolution",
      "alt_mode"
    ]);
  }

  buildBaseSuggestion({
    customerName = "고객",
    purchaseHistory = [],
    messages = [],
    productNames: inputProductNames = []
  }) {
    const conversationMessages = messages.map((message) => ({
      role: message.role,
      text: normalizeWhitespace(message.text ?? "")
    }));
    const pendingCustomerMessages = [];
    for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
      if (conversationMessages[index].role === "customer") {
        pendingCustomerMessages.unshift(conversationMessages[index].text);
        continue;
      }
      if (pendingCustomerMessages.length) {
        break;
      }
    }

    const customerText = pendingCustomerMessages.join(" ").trim();
    const productNames = unique([
      ...extractProductNames(purchaseHistory),
      ...inputProductNames.map((name) => normalizeWhitespace(name))
    ]);
    const supportSignals = extractSupportSignals(customerText, productNames);
    const productContext = detectProductContext(productNames);
    const modelIdentifiers = extractModelIdentifiers(
      productNames,
      conversationMessages.map((message) => message.text)
    );
    const flags = this.detectFlags(customerText);
    const policyMatch = this.matchPolicy({ customerText, purchaseHistory });
    const needsModelConfirmation = this.needsModelConfirmation(
      customerText,
      modelIdentifiers,
      policyMatch
    );
    const matches =
      customerText && !needsModelConfirmation
        ? this.findMatches(
            customerText,
            productNames,
            modelIdentifiers,
            supportSignals
          )
        : [];

    let body;
    let evidence;
    let confidence;
    let generationSource;

    if (needsModelConfirmation) {
      body = this.buildModelRequestReply();
      evidence = [
        {
          id: "policy:model_required",
          source: "모델명 확인 필요",
          productName: "",
          score: 1,
          customerText: "기술문의 / 모델명 미확인",
          answerText: body
        }
      ];
      confidence = 0.93;
      generationSource = "model_required";
    } else if (policyMatch) {
      body = policyMatch.reply;
      evidence = policyMatch.evidence;
      confidence = 0.98;
      generationSource = "policy";
    } else if (matches.length && this.shouldBuildTechnicalDraft(supportSignals)) {
      const actionHints = collectActionHints(matches);
      body = buildTechnicalRetrievalReply({
        customerText,
        productNames,
        supportSignals,
        productContext,
        actionHints
      });
      evidence = matches.map(buildEvidenceFromMatch);
      confidence = Math.min(0.9, 0.5 + matches[0].score);
      generationSource = "retrieval_contextual";
    } else if (matches.length) {
      body = cleanAnswer(matches[0].example.answerText);
      evidence = matches.map(buildEvidenceFromMatch);
      confidence = Math.min(0.92, 0.45 + matches[0].score);
      generationSource = "retrieval";
    } else {
      body = this.buildFallback({ productNames });
      evidence = [];
      confidence = 0.36;
      generationSource = "fallback";
    }

    const replyText = maybeAddGreetingAndClosing(body, this.policies);
    const canAutoSend =
      generationSource !== "model_required" &&
      generationSource !== "retrieval_contextual" &&
      confidence >= 0.8 &&
      !flags.some((flag) => flag.reviewOnly) &&
      !(policyMatch && policyMatch.autoEligible === false);

    return {
      suggestion: {
        customerName,
        customerText,
        productNames,
        supportSignals,
        modelIdentifiers,
        replyText,
        evidence,
        flags,
        confidence: Number(confidence.toFixed(2)),
        canAutoSend,
        policyRule: policyMatch?.rule ?? null,
        generationSource,
        llm: {
          ...this.getLlmStatus(),
          used: false,
          reason: null,
          error: null,
          missingInformation: []
        }
      },
      context: {
        customerName,
        purchaseHistory,
        messages: conversationMessages,
        customerText,
        productNames,
        supportSignals,
        modelIdentifiers,
        flags,
        policyMatch,
        productContext,
        needsModelConfirmation,
        matches,
        confidence,
        body,
        replyText,
        evidence,
        generationSource
      }
    };
  }

  shouldUseLlmEnhancement(suggestion, context) {
    const llmSettings = this.getLlmSettings();
    if (!llmSettings.enabled || !this.llmClient?.isAvailable?.()) {
      return null;
    }

    if (
      !context.customerText ||
      suggestion.policyRule ||
      context.needsModelConfirmation ||
      suggestion.generationSource === "model_required"
    ) {
      return null;
    }

    const normalizedQuestion = normalizeText(context.customerText);
    const topScore = context.matches[0]?.score ?? 0;
    const answerLength = cleanAnswer(context.body).length;
    const reasoningKeywords = [
      "안되",
      "오류",
      "연결",
      "인식",
      "설치",
      "화면",
      "소리",
      "출력",
      "입력",
      "전원",
      "깜빡",
      "안나와"
    ];

    if (!context.matches.length) {
      return "no_history";
    }

    if (suggestion.confidence < llmSettings.enhanceWhenConfidenceBelow) {
      return "low_confidence";
    }

    if (answerLength < llmSettings.weakAnswerLength) {
      return "weak_answer";
    }

    if (
      reasoningKeywords.some((keyword) => normalizedQuestion.includes(keyword)) &&
      topScore < 0.86
    ) {
      return "needs_reasoning";
    }

    return null;
  }

  buildLlmContext(payload, suggestion, context, enhancementReason) {
    const llmSettings = this.getLlmSettings();

    return {
      brandName: this.policies.brandName ?? "랜스타",
      customerName: payload.customerName ?? suggestion.customerName,
      customerText: suggestion.customerText,
      productNames: suggestion.productNames,
      supportSignals: context.supportSignals,
      modelIdentifiers: suggestion.modelIdentifiers,
      messages: context.messages,
      purchaseSummary: summarizePurchaseHistory(payload.purchaseHistory ?? []),
      baseReplyText: suggestion.replyText,
      enhancementReason,
      flags: suggestion.flags,
      evidence: suggestion.evidence.slice(0, llmSettings.maxEvidenceCount)
    };
  }

  suggestReply(payload) {
    return this.buildBaseSuggestion(payload).suggestion;
  }

  async suggestReplyEnhanced(payload) {
    const { suggestion, context } = this.buildBaseSuggestion(payload);
    const enhancementReason = this.shouldUseLlmEnhancement(suggestion, context);

    if (!enhancementReason) {
      return suggestion;
    }

    try {
      const enhanced = await this.llmClient.generateReplyEnhancement(
        this.buildLlmContext(payload, suggestion, context, enhancementReason)
      );

      if (!enhanced?.replyText) {
        return suggestion;
      }

      const flags = [...suggestion.flags];
      const missingInformation = Array.isArray(enhanced.missingInformation)
        ? enhanced.missingInformation.filter(Boolean)
        : [];

      if (enhanced.needsReview || missingInformation.length) {
        flags.push({
          type: "llm_review",
          label: "LLM 검토 필요",
          reviewOnly: true,
          reason:
            missingInformation.length > 0
              ? `추가 확인 필요: ${missingInformation.join(", ")}`
              : "LLM이 추가 확인이 필요하다고 판단했습니다."
        });
      }

      return {
        ...suggestion,
        replyText: maybeAddGreetingAndClosing(enhanced.replyText, this.policies),
        evidence: [
          {
            id: "llm:enhanced",
            source: "LLM 보강",
            productName: suggestion.productNames[0] ?? "",
            score: 1,
            customerText: llmReasonLabel(enhancementReason),
            answerText: snippet(
              enhanced.reasoning ?? enhanced.replyText,
              120
            )
          },
          ...suggestion.evidence
        ],
        flags,
        confidence: Number(
          Math.max(suggestion.confidence, Math.min(0.95, suggestion.confidence + 0.08)).toFixed(2)
        ),
        canAutoSend:
          suggestion.canAutoSend &&
          this.getLlmSettings().allowAutoSend &&
          !flags.some((flag) => flag.reviewOnly),
        generationSource: "llm_hybrid",
        llm: {
          ...this.getLlmStatus(),
          used: true,
          reason: enhancementReason,
          error: null,
          missingInformation
        }
      };
    } catch (error) {
      return {
        ...suggestion,
        llm: {
          ...this.getLlmStatus(),
          used: false,
          reason: enhancementReason,
          error: error.message,
          missingInformation: []
        }
      };
    }
  }
}
