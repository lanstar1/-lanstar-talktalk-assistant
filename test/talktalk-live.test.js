import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLiveChatDetailUrl,
  buildLiveChatListUrl,
  buildPendingCustomerText,
  createLiveConversationId,
  deriveProductNamesFromMessages,
  extractUserIdFromChatHref,
  extractUserIdFromChatUrl,
  getPartnerCodeFromPublicChatUrl,
  parseLiveConversationId,
  stripSellerPrefix
} from "../src/lib/talktalk-live.js";

test("공개 채팅 URL에서 채널 코드를 추출한다", () => {
  assert.equal(
    getPartnerCodeFromPublicChatUrl("http://talk.naver.com/W4QWIB"),
    "w4qwib"
  );
  assert.equal(
    getPartnerCodeFromPublicChatUrl("https://talk.naver.com/WC5FMA"),
    "wc5fma"
  );
});

test("실시간 채팅 URL과 대화 ID를 생성한다", () => {
  assert.equal(
    buildLiveChatListUrl("w4qwib"),
    "https://partner.talk.naver.com/chat/ct/w4qwib?device=pc"
  );
  assert.equal(
    buildLiveChatDetailUrl("w4qwib", "sHWT"),
    "https://partner.talk.naver.com/chat/ct/w4qwib/sHWT?device=pc"
  );
  assert.equal(createLiveConversationId("w4qwib", "sHWT"), "live:w4qwib:sHWT");
});

test("실시간 대화 URL과 ID에서 userId를 추출한다", () => {
  assert.equal(
    extractUserIdFromChatHref("/chat/ct/w4qwib/sHWT"),
    "sHWT"
  );
  assert.equal(
    extractUserIdFromChatUrl("https://partner.talk.naver.com/chat/ct/w4qwib/sHWT?device=pc"),
    "sHWT"
  );
  assert.deepEqual(parseLiveConversationId("live:w4qwib:sHWT"), {
    partnerCode: "w4qwib",
    userId: "sHWT"
  });
});

test("판매자 이름이 앞에 붙은 목록 미리보기를 정리한다", () => {
  assert.equal(
    stripSellerPrefix("라인업시스템확장컨버터들은 전부 드라이버 설치가 필요 합니다", "라인업시스템"),
    "확장컨버터들은 전부 드라이버 설치가 필요 합니다"
  );
});

test("마지막 연속 고객 메시지만 대기 텍스트로 묶는다", () => {
  assert.equal(
    buildPendingCustomerText([
      { role: "customer", text: "첫 문의" },
      { role: "seller", text: "답변" },
      { role: "customer", text: "추가 질문 1" },
      { role: "customer", text: "추가 질문 2" }
    ]),
    "추가 질문 1 추가 질문 2"
  );
});

test("메시지에서 제품명과 모델명을 뽑아낸다", () => {
  assert.deepEqual(
    deriveProductNamesFromMessages([
      {
        role: "customer",
        text: "[LANstar] USB to HDMI 듀얼 모니터 컨버터 [30949]\n판매금액 62,400원"
      },
      {
        role: "customer",
        text: "모델명 LS-UH319D-N"
      }
    ]),
    ["[LANstar] USB to HDMI 듀얼 모니터 컨버터 [30949]", "LS-UH319D-N"]
  );
});
