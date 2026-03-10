function normalizeSnippet(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function getPartnerCodeFromPublicChatUrl(publicChatUrl) {
  const raw = String(publicChatUrl ?? "").trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    return normalizeSnippet(parsed.pathname.split("/").filter(Boolean).pop()).toLowerCase();
  } catch {
    const match = raw.match(/talk\.naver\.com\/([^/?#]+)/i);
    return normalizeSnippet(match?.[1]).toLowerCase();
  }
}

export function buildLiveChatListUrl(partnerCode) {
  if (!partnerCode) {
    return "";
  }

  return `https://partner.talk.naver.com/chat/ct/${partnerCode}?device=pc`;
}

export function buildLiveChatDetailUrl(partnerCode, userId) {
  if (!partnerCode || !userId) {
    return "";
  }

  return `https://partner.talk.naver.com/chat/ct/${partnerCode}/${userId}?device=pc`;
}

export function extractUserIdFromChatHref(href) {
  const raw = String(href ?? "").trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw, "https://partner.talk.naver.com");
    const parts = parsed.pathname.split("/").filter(Boolean);
    return normalizeSnippet(parts[parts.length - 1]);
  } catch {
    return "";
  }
}

export function extractUserIdFromChatUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw, "https://partner.talk.naver.com");
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4) {
      return "";
    }
    return normalizeSnippet(parts[3]);
  } catch {
    return "";
  }
}

export function createLiveConversationId(partnerCode, userId) {
  if (!partnerCode || !userId) {
    return "";
  }

  return `live:${partnerCode}:${userId}`;
}

export function parseLiveConversationId(conversationId) {
  const raw = String(conversationId ?? "").trim();
  const match = raw.match(/^live:([^:]+):([^:]+)$/i);
  if (!match) {
    return null;
  }

  return {
    partnerCode: normalizeSnippet(match[1]).toLowerCase(),
    userId: normalizeSnippet(match[2])
  };
}

export function stripSellerPrefix(previewText, sellerName) {
  const preview = normalizeSnippet(previewText);
  const seller = normalizeSnippet(sellerName);
  if (!preview || !seller) {
    return preview;
  }

  return preview.startsWith(seller) ? normalizeSnippet(preview.slice(seller.length)) : preview;
}

export function buildPendingCustomerText(messages = []) {
  const pending = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "customer") {
      pending.unshift(message.text);
      continue;
    }

    if (pending.length) {
      break;
    }
  }

  return normalizeSnippet(pending.join(" "));
}

export function buildMessageSignature(messages = []) {
  return messages
    .map((message) => `${message.role}:${normalizeSnippet(message.text)}`)
    .join("|");
}

export function deriveProductNamesFromMessages(messages = []) {
  const candidates = [];

  for (const message of messages) {
    const text = String(message?.text ?? "");
    if (!text) {
      continue;
    }

    const lines = text
      .split(/\n+/)
      .map((line) => normalizeSnippet(line))
      .filter(Boolean);

    for (const line of lines) {
      if (/^\[[^\]]+\]/.test(line)) {
        candidates.push(line);
      }

      const modelMatch = line.match(/모델명[:\s]*([A-Z0-9-]{4,})/i);
      if (modelMatch) {
        candidates.push(modelMatch[1].toUpperCase());
      }
    }
  }

  return unique(candidates).slice(0, 4);
}

export function summarizeLiveOrder(conversation = {}) {
  const segments = ["실시간 상담"];
  if (conversation.timeLabel) {
    segments.push(conversation.timeLabel);
  }
  if (conversation.customerName) {
    segments.push(conversation.customerName);
  }

  return segments.join(" / ");
}
