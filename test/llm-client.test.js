import test from "node:test";
import assert from "node:assert/strict";

import { LlmClient } from "../src/lib/llm-client.js";

function buildContext() {
  return {
    brandName: "랜스타",
    customerName: "테스트 고객",
    customerText: "모니터 연결했는데 화면이 안 나옵니다.",
    productNames: ["LS-UH319-W"],
    supportSignals: ["display_no_signal", "connection"],
    modelIdentifiers: ["LSUH319W"],
    messages: [{ role: "customer", text: "모니터 연결했는데 화면이 안 나옵니다." }],
    purchaseSummary: "주문 내역 없음",
    baseReplyText: "연결 상태를 확인 부탁드립니다.",
    enhancementReason: "needs_reasoning",
    flags: [],
    evidence: []
  };
}

test("OpenAI 429 응답은 재시도 후 성공하면 보강 답변을 반환한다", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: { message: "rate limit" } }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "content-type": "application/json"
        }
      });
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                replyText: "드라이버 재설치와 다른 USB 포트 확인 부탁드립니다.",
                needsReview: false,
                reasoning: "재시도 후 정상 응답",
                missingInformation: []
              })
            }
          }
        ]
      }),
      {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };

  try {
    const client = new LlmClient({
      provider: "openai",
      model: "gpt-4.1-mini",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      enabled: true,
      retryDelaysMs: [0]
    });

    const result = await client.generateReplyEnhancement(buildContext());
    assert.equal(callCount, 2);
    assert.match(result.replyText, /드라이버 재설치/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI 오류 메시지는 응답 본문까지 포함해 전달한다", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message:
            "You exceeded your current quota, please check your plan and billing details."
        }
      }),
      {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "content-type": "application/json"
        }
      }
    );

  try {
    const client = new LlmClient({
      provider: "openai",
      model: "gpt-4.1-mini",
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      enabled: true,
      retryDelaysMs: []
    });

    await assert.rejects(
      () => client.generateReplyEnhancement(buildContext()),
      /check your plan and billing details/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
