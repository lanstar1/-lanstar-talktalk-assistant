import test from "node:test";
import assert from "node:assert/strict";

import { ReplyEngine } from "../src/lib/reply-engine.js";

const policies = {
  greeting: "안녕하세요. 고객님. 랜스타입니다.",
  closing: "추가로 궁금하신 사항이 있으시면 편하게 말씀 부탁드립니다. 감사합니다.",
  fallback:
    "문의주신 내용을 정확히 확인한 뒤 안내드리겠습니다. 사용 중인 제품명과 현재 증상, 연결 환경을 조금 더 자세히 알려주시면 빠르게 확인해 드리겠습니다.",
  sensitiveKeywords: ["주민번호", "계좌번호"],
  reviewOnlyKeywords: ["환불", "반품", "초기불량"],
  refundKeywords: ["환불", "반품", "취소"],
  addressChangeKeywords: ["배송지변경", "배송지 변경", "주소 변경"],
  shippingKeywords: ["배송", "출고", "발송", "송장"],
  asKeywords: ["고장", "불량", "초기불량"],
  initialDefectKeywords: ["초기불량", "받자마자"],
  usedFaultKeywords: ["사용하다", "사용 중", "1년"]
};

const examples = [
  {
    id: "qna:1",
    source: "상품Q&A",
    productName: "LS-ANDOOR-B",
    customerText: "안쪽에서 잠그는 방법은요?",
    answerText: "지문 또는 번호키로 잠금을 열고 안으로 들어가면 2~3초 뒤 자동으로 잠기는 구조입니다.",
    orderSummary: "",
    searchIndex: {
      text: "LS-ANDOOR-B 안쪽에서 잠그는 방법은요?",
      words: ["ls", "andoor", "안쪽에서", "잠그는", "방법은요"],
      grams: ["안쪽", "쪽에", "에서", "잠그", "그는"]
    }
  }
];

test("환불 문의는 정책 답변을 우선 적용한다", () => {
  const engine = new ReplyEngine({ examples, policies });
  const suggestion = engine.suggestReply({
    purchaseHistory: [{ 주문번호: "20260101", 상품목록: [] }],
    messages: [{ role: "customer", text: "환불하고 싶어요" }]
  });

  assert.equal(suggestion.policyRule, "refund");
  assert.equal(suggestion.canAutoSend, false);
  assert.match(suggestion.replyText, /주문내역/);
});

test("상품 Q&A와 유사한 문의는 기존 답변을 재사용한다", () => {
  const engine = new ReplyEngine({ examples, policies });
  const suggestion = engine.suggestReply({
    purchaseHistory: [],
    messages: [{ role: "customer", text: "안쪽에서 잠그는 방법이 궁금합니다" }]
  });

  assert.equal(suggestion.policyRule, null);
  assert.equal(suggestion.evidence[0].source, "상품Q&A");
  assert.match(suggestion.replyText, /자동으로 잠기는 구조/);
});

test("주문내역 모델명과 동일한 상담이력을 우선 사용한다", () => {
  const engine = new ReplyEngine({
    examples: [
      {
        id: "history:uh319w",
        source: "상담이력",
        productName: "랜스타 LS-UH319-W USB3.0 to HDMI 영상 컨버터",
        customerText: "LS-UH319-W 제품 사용 중 화면이 안 나와요",
        answerText: "LS-UH319-W 기준으로 드라이버 설치 여부와 USB 포트 전원 상태를 먼저 확인 부탁드립니다.",
        orderSummary: ""
      },
      {
        id: "history:uc202",
        source: "상담이력",
        productName: "랜스타 LS-UC202 USB-C 컨버터",
        customerText: "LS-UC202 제품 노트북 인식이 안 됩니다",
        answerText: "LS-UC202 기준으로 C타입 포트와 케이블 연결 상태를 확인 부탁드립니다.",
        orderSummary: ""
      }
    ],
    policies
  });
  const suggestion = engine.suggestReply({
    purchaseHistory: [
      {
        주문번호: "202603100001",
        주문날짜: "2026-03-10",
        상품목록: [
          {
            상품명: "랜스타 LS-UH319-W USB3.0 to HDMI 영상 컨버터",
            상태: "배송완료"
          }
        ]
      }
    ],
    messages: [{ role: "customer", text: "모니터 연결했는데 화면이 안 나와요" }]
  });

  assert.equal(suggestion.generationSource, "retrieval_contextual");
  assert.match(suggestion.replyText, /LS-UH319-W/);
  assert.match(suggestion.replyText, /드라이버/);
  assert.equal(
    suggestion.evidence[0].productName,
    "랜스타 LS-UH319-W USB3.0 to HDMI 영상 컨버터"
  );
});

test("같은 모델이라도 증상이 다르면 화면 출력 점검형 초안을 우선 만든다", () => {
  const engine = new ReplyEngine({
    examples: [
      {
        id: "history:pivot",
        source: "상품Q&A",
        productName: "랜스타 LS-UH319-W USB3.0 to HDMI 영상 컨버터",
        customerText: "피봇 모니터 가능 한가요?",
        answerText: "세로모드는 LS-UH319-W 화이트 제품만 가능합니다.",
        orderSummary: ""
      },
      {
        id: "history:display",
        source: "상품Q&A",
        productName: "랜스타 LS-UH319-W USB3.0 to HDMI 영상 컨버터",
        customerText: "화면이 안 나오고 인식이 안 됩니다.",
        answerText:
          "드라이버 설치 여부와 다른 USB 포트 연결 여부를 확인 부탁드립니다.",
        orderSummary: ""
      }
    ],
    policies
  });

  const suggestion = engine.suggestReply({
    productNames: ["LS-UH319-W"],
    messages: [{ role: "customer", text: "제품 연결하고 모니터 연결했는데 안 나와요" }]
  });

  assert.equal(suggestion.generationSource, "retrieval_contextual");
  assert.match(suggestion.replyText, /연결 상태/);
  assert.match(suggestion.replyText, /드라이버/);
  assert.doesNotMatch(suggestion.replyText, /세로모드/);
});

test("문맥 기반 초안 근거가 충분하면 LLM 보강을 생략한다", async () => {
  let llmCallCount = 0;
  const llmClient = {
    isAvailable() {
      return true;
    },
    getStatus() {
      return {
        enabled: true,
        available: true,
        provider: "mock",
        model: "mock-1",
        baseUrl: "http://mock"
      };
    },
    async generateReplyEnhancement() {
      llmCallCount += 1;
      return {
        replyText: "이 답변은 호출되면 안 됩니다.",
        needsReview: false,
        reasoning: "",
        missingInformation: []
      };
    }
  };

  const engine = new ReplyEngine({
    examples: [
      {
        id: "history:display-1",
        source: "상품Q&A",
        productName: "랜스타 LS-UH319-W USB3.0 to HDMI 영상 컨버터",
        customerText: "모니터 연결 후 화면이 안 나오고 장치 인식이 안 됩니다.",
        answerText: "드라이버 설치 여부와 장치관리자 인식 상태를 확인 부탁드립니다.",
        orderSummary: ""
      },
      {
        id: "history:display-2",
        source: "상담이력",
        productName: "랜스타 LS-UH319-W USB3.0 to HDMI 영상 컨버터",
        customerText: "LS-UH319-W 연결 후 검은 화면이 나오고 다른 포트에서만 동작합니다.",
        answerText: "다른 USB 포트, 재부팅, 드라이버 재설치 순서로 확인 부탁드립니다.",
        orderSummary: ""
      }
    ],
    policies,
    llmClient,
    getSettings: () => ({
      llm: {
        enabled: true,
        enhanceWhenConfidenceBelow: 0.78,
        weakAnswerLength: 140,
        maxEvidenceCount: 4,
        allowAutoSend: false
      }
    })
  });

  const suggestion = await engine.suggestReplyEnhanced({
    productNames: ["LS-UH319-W"],
    messages: [
      {
        role: "customer",
        text: "제품 연결하고 모니터 연결했는데 화면이 안 나오고 인식이 안 됩니다."
      }
    ]
  });

  assert.equal(suggestion.generationSource, "retrieval_contextual");
  assert.equal(suggestion.llm.used, false);
  assert.equal(suggestion.llm.error, null);
  assert.equal(llmCallCount, 0);
});

test("배송 문의는 주문 상태 정책을 우선 적용한다", () => {
  const engine = new ReplyEngine({ examples, policies });
  const suggestion = engine.suggestReply({
    purchaseHistory: [
      {
        상품목록: [{ 상품명: "테스트 상품", 상태: "결제완료" }]
      }
    ],
    messages: [{ role: "customer", text: "배송이 시작되었을까요?" }]
  });

  assert.equal(suggestion.policyRule, "shipping");
  assert.match(suggestion.replyText, /결제완료 상태/);
});

test("기술문의에 모델명을 확인할 수 없으면 먼저 모델명을 요청한다", () => {
  const engine = new ReplyEngine({ examples, policies });
  const suggestion = engine.suggestReply({
    purchaseHistory: [],
    messages: [
      {
        role: "customer",
        text: "모니터 연결했는데 화면이 안 나옵니다. 인식도 안 돼요."
      }
    ]
  });

  assert.equal(suggestion.generationSource, "model_required");
  assert.equal(suggestion.canAutoSend, false);
  assert.match(suggestion.replyText, /모델명/);
});

test("기존 이력이 약하면 LLM으로 답변을 보강한다", async () => {
  const llmClient = {
    isAvailable() {
      return true;
    },
    getStatus() {
      return {
        enabled: true,
        available: true,
        provider: "mock",
        model: "mock-1",
        baseUrl: "http://mock"
      };
    },
    async generateReplyEnhancement() {
      return {
        replyText:
          "현재 증상으로 보아 먼저 연결 포트 변경, 케이블 재연결, 전원 재공급 순서로 점검 부탁드립니다. 그래도 동일하면 사용 기기 모델명과 연결 구성을 남겨주시면 추가 확인해 드리겠습니다.",
        needsReview: false,
        reasoning: "기존 이력이 없어서 기본 진단 절차를 보강했습니다.",
        missingInformation: ["사용 기기 모델명", "연결 구성"]
      };
    }
  };

  const engine = new ReplyEngine({
    examples,
    policies,
    llmClient,
    getSettings: () => ({
      llm: {
        enabled: true,
        enhanceWhenConfidenceBelow: 0.78,
        weakAnswerLength: 140,
        maxEvidenceCount: 4,
        allowAutoSend: false
      }
    })
  });
  const suggestion = await engine.suggestReplyEnhanced({
    purchaseHistory: [
      {
        주문번호: "202603100003",
        주문날짜: "2026-03-10",
        상품목록: [
          {
            상품명: "랜스타 LS-UH319-W USB3.0 to HDMI 영상 컨버터",
            상태: "배송완료"
          }
        ]
      }
    ],
    messages: [
      {
        role: "customer",
        text:
          "LS-UH319-W 사용 중인데 모니터 연결했을 때 화면이 안 나오고 인식이 안 됩니다. 어떻게 확인하면 될까요?"
      }
    ]
  });

  assert.equal(suggestion.generationSource, "llm_hybrid");
  assert.equal(suggestion.llm.used, true);
  assert.match(suggestion.replyText, /연결 포트 변경/);
  assert.equal(suggestion.canAutoSend, false);
});

test("동일 모델 상담 이력이 없으면 다른 모델 대신 LLM이 보강한다", async () => {
  const llmClient = {
    isAvailable() {
      return true;
    },
    getStatus() {
      return {
        enabled: true,
        available: true,
        provider: "mock",
        model: "mock-1",
        baseUrl: "http://mock"
      };
    },
    async generateReplyEnhancement() {
      return {
        replyText:
          "LS-UH319-W 기준 상담 이력이 부족하여 우선 드라이버 재설치와 다른 USB 포트 연결을 확인 부탁드립니다. 계속 동일하면 모델명과 사용 PC 환경을 함께 남겨주시면 추가 확인해 드리겠습니다.",
        needsReview: false,
        reasoning: "동일 모델 근거가 부족해 일반 점검 절차를 보강했습니다.",
        missingInformation: ["사용 PC 환경"]
      };
    }
  };

  const engine = new ReplyEngine({
    examples: [
      {
        id: "history:uc202",
        source: "상담이력",
        productName: "랜스타 LS-UC202 USB-C 컨버터",
        customerText: "LS-UC202 제품 인식이 안 됩니다",
        answerText: "LS-UC202 기준으로 케이블 상태를 확인 부탁드립니다.",
        orderSummary: ""
      }
    ],
    policies,
    llmClient,
    getSettings: () => ({
      llm: {
        enabled: true,
        enhanceWhenConfidenceBelow: 0.78,
        weakAnswerLength: 140,
        maxEvidenceCount: 4,
        allowAutoSend: false
      }
    })
  });

  const suggestion = await engine.suggestReplyEnhanced({
    purchaseHistory: [
      {
        주문번호: "202603100002",
        주문날짜: "2026-03-10",
        상품목록: [
          {
            상품명: "랜스타 LS-UH319-W USB3.0 to HDMI 영상 컨버터",
            상태: "배송완료"
          }
        ]
      }
    ],
    messages: [
      {
        role: "customer",
        text: "모니터 연결했는데 화면이 안 나오고 인식이 안 됩니다."
      }
    ]
  });

  assert.equal(suggestion.generationSource, "llm_hybrid");
  assert.equal(suggestion.llm.used, true);
  assert.match(suggestion.replyText, /LS-UH319-W 기준/);
  assert.equal(
    suggestion.evidence.some((item) => /LS-UC202/.test(item.productName ?? "")),
    false
  );
});
