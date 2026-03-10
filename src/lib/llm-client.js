function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function parseJsonObject(text = "") {
  const trimmed = String(text).trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function parseRetryAfterMs(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(String(value ?? ""));
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErrorMessage(status, statusText, detail = "") {
  return detail
    ? `LLM 요청 실패 (${status} ${statusText}): ${detail}`
    : `LLM 요청 실패 (${status} ${statusText})`;
}

function buildPromptPayload(context) {
  return {
    brandName: context.brandName,
    tone: "존댓말, 상세하고 실무적으로",
    customerName: context.customerName,
    customerQuestion: context.customerText,
    productNames: context.productNames,
    supportSignals: context.supportSignals ?? [],
    detectedModelIdentifiers: context.modelIdentifiers ?? [],
    recentMessages: context.messages.slice(-6),
    purchaseSummary: context.purchaseSummary,
    ruleBasedDraft: context.baseReplyText,
    whyLlmWasCalled: context.enhancementReason,
    reviewFlags: context.flags.map((flag) => ({
      label: flag.label,
      reason: flag.reason
    })),
    evidence: context.evidence.map((item) => ({
      id: item.id,
      source: item.source,
      productName: item.productName,
      customerText: item.customerText,
      answerText: item.answerText,
      score: item.score
    })),
    hardRules: [
      "운영정책과 주문정보를 임의로 바꾸지 말 것",
      "근거 없는 제품 스펙을 추정하지 말 것",
      "정보가 부족하면 필요한 확인 항목을 먼저 요청할 것",
      "민감정보를 요구하거나 노출하지 말 것",
      "답변은 고객에게 바로 보낼 수 있는 한국어 존댓말로 작성할 것"
    ],
    outputSchema: {
      replyText: "고객에게 보낼 최종 답변 문자열",
      needsReview: "true 또는 false",
      reasoning: "왜 이렇게 답했는지 1문장 요약",
      missingInformation: ["추가로 받아야 할 정보들"],
      usedEvidenceIds: ["참고한 evidence id 목록"]
    }
  };
}

export class LlmClient {
  constructor(config = {}) {
    const provider = String(
      config.provider ??
        process.env.LLM_PROVIDER ??
        (process.env.OPENAI_API_KEY ? "openai" : "none")
    ).toLowerCase();

    this.provider = provider;
    this.model =
      config.model ??
      process.env.LLM_MODEL ??
      process.env.OPENAI_MODEL ??
      (provider === "openai"
        ? "gpt-4.1-mini"
        : provider === "ollama"
          ? process.env.OLLAMA_MODEL
          : "") ??
      "";
    this.baseUrl = trimTrailingSlash(
      config.baseUrl ??
        process.env.LLM_BASE_URL ??
        (provider === "ollama"
          ? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"
          : "https://api.openai.com/v1")
    );
    this.apiKey =
      config.apiKey ??
      process.env.LLM_API_KEY ??
      process.env.OPENAI_API_KEY ??
      "";
    this.timeoutMs = Number(
      config.timeoutMs ?? process.env.LLM_TIMEOUT_MS ?? 25000
    );
    this.temperature = Number(
      config.temperature ?? process.env.LLM_TEMPERATURE ?? 0.2
    );
    this.maxTokens = Number(
      config.maxTokens ?? process.env.LLM_MAX_TOKENS ?? 700
    );
    this.retryDelaysMs = (
      Array.isArray(config.retryDelaysMs)
        ? config.retryDelaysMs
        : String(process.env.LLM_RETRY_DELAYS_MS ?? "800,1800").split(",")
    )
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
    this.enabled =
      config.enabled ?? truthy(process.env.LLM_ENABLED ?? (provider !== "none"));
  }

  isAvailable() {
    if (!this.enabled || !this.model || this.provider === "none") {
      return false;
    }

    if (this.provider === "ollama") {
      return Boolean(this.baseUrl);
    }

    return Boolean(this.baseUrl && this.apiKey);
  }

  getStatus() {
    return {
      enabled: this.enabled,
      available: this.isAvailable(),
      provider: this.provider,
      model: this.model || null,
      baseUrl: this.provider === "none" ? null : this.baseUrl || null
    };
  }

  async generateReplyEnhancement(context) {
    if (!this.isAvailable()) {
      return null;
    }

    const systemPrompt = [
      `${context.brandName} 네이버 톡톡 고객상담 보조 모델입니다.`,
      "당신의 역할은 기존 답변 초안과 근거 자료를 바탕으로 고객 문제 해결력이 더 높은 최종 답변을 만드는 것입니다.",
      "근거가 약하면 추정하지 말고 확인 절차와 추가 질문을 제시하세요.",
      "응답은 반드시 JSON 객체만 출력하세요."
    ].join(" ");

    const userPrompt = JSON.stringify(buildPromptPayload(context), null, 2);

    if (this.provider === "ollama") {
      return this.requestOllama(systemPrompt, userPrompt);
    }

    return this.requestOpenAiCompatible(systemPrompt, userPrompt);
  }

  async requestOpenAiCompatible(systemPrompt, userPrompt) {
    const retryableStatusCodes = new Set([408, 409, 429, 500, 502, 503, 504]);

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        })
      });

      const rawBody = await response.text();
      if (response.ok) {
        const payload = parseJsonObject(rawBody);
        const content =
          payload?.choices?.[0]?.message?.content ??
          payload?.choices?.[0]?.text ??
          "";
        const parsed = parseJsonObject(content);
        if (!parsed?.replyText) {
          throw new Error("LLM 응답에서 replyText를 읽지 못했습니다.");
        }

        return parsed;
      }

      const errorPayload = parseJsonObject(rawBody);
      const detail =
        errorPayload?.error?.message ??
        errorPayload?.message ??
        rawBody.trim();
      const error = new Error(
        formatErrorMessage(response.status, response.statusText, detail)
      );

      if (
        attempt < this.retryDelaysMs.length &&
        retryableStatusCodes.has(response.status)
      ) {
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get("retry-after")) ??
          this.retryDelaysMs[attempt];
        if (retryAfterMs > 0) {
          await sleep(retryAfterMs);
        }
        continue;
      }

      throw error;
    }
  }

  async requestOllama(systemPrompt, userPrompt) {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        options: {
          temperature: this.temperature,
          num_predict: this.maxTokens
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(
        `Ollama 요청 실패 (${response.status} ${response.statusText})`
      );
    }

    const payload = await response.json();
    const content = payload.message?.content ?? "";
    const parsed = parseJsonObject(content);
    if (!parsed?.replyText) {
      throw new Error("Ollama 응답에서 replyText를 읽지 못했습니다.");
    }

    return parsed;
  }
}
