const WORD_REGEX = /[\p{L}\p{N}]{2,}/gu;
const ORDER_STATUS_PREFIXES = [
  "결제완료",
  "구매확정",
  "배송완료",
  "배송중",
  "취소",
  "반품",
  "수거중",
  "미입금취소"
];

export function normalizeText(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function compactText(value = "") {
  return normalizeText(value).replace(/\s+/g, "");
}

export function tokenize(value = "") {
  const normalized = normalizeText(value.replace(/[^\p{L}\p{N}\s]/gu, " "));
  return Array.from(normalized.matchAll(WORD_REGEX), (match) => match[0]);
}

export function charBigrams(value = "") {
  const compact = compactText(value);
  const grams = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.push(compact.slice(index, index + 2));
  }
  return grams;
}

export function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

export function overlapScore(leftValues = [], rightValues = []) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const value of left) {
    if (right.has(value)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(left.size, right.size);
}

export function cleanAnswer(answer = "") {
  return String(answer)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function flattenPurchaseHistory(purchaseHistory = []) {
  return purchaseHistory.flatMap((order) => order.상품목록 ?? []);
}

export function extractProductNames(purchaseHistory = []) {
  return unique(
    flattenPurchaseHistory(purchaseHistory)
      .map((item) => item.상품명 ?? "")
      .map(cleanProductName)
      .map((name) => name.replace(/\d{1,3}(,\d{3})*원/g, "").trim())
      .filter(Boolean)
  );
}

export function cleanProductName(value = "") {
  let result = normalizeWhitespace(value);
  let changed = true;

  while (changed) {
    changed = false;
    for (const prefix of ORDER_STATUS_PREFIXES) {
      if (result.startsWith(prefix)) {
        result = result.slice(prefix.length).trim();
        changed = true;
      }
    }
  }

  return result;
}

export function extractOrderStatuses(purchaseHistory = []) {
  return unique(
    flattenPurchaseHistory(purchaseHistory)
      .map((item) => normalizeWhitespace(item.상태 ?? ""))
      .filter(Boolean)
  );
}

export function latestOrderDate(purchaseHistory = []) {
  const normalizedDates = purchaseHistory
    .map((order) => String(order.주문날짜 ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "")
    .filter(Boolean)
    .sort()
    .reverse();

  return normalizedDates[0] ?? "";
}

export function summarizePurchaseHistory(purchaseHistory = []) {
  if (!purchaseHistory.length) {
    return "주문 내역 없음";
  }

  const latestOrder = purchaseHistory[0];
  const orderNumber = String(latestOrder.주문번호 ?? "").match(/\d{8,}/)?.[0] ?? "주문번호 미확인";
  const date = String(latestOrder.주문날짜 ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "날짜 미확인";
  const products = extractProductNames([latestOrder]);
  const firstProduct = products[0] ?? "상품명 미확인";

  return `${date} / ${orderNumber} / ${firstProduct}`;
}

export function messageRole(rawRole = "") {
  return rawRole === "판매자" ? "seller" : "customer";
}

export function normalizeMessages(messages = []) {
  return messages
    .map((message) => ({
      role: messageRole(message.발신자),
      text: normalizeWhitespace(message.내용 ?? "")
    }))
    .filter((message) => message.text);
}

export function normalizeWhitespace(value = "") {
  return String(value)
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractPendingCustomerMessages(messages = []) {
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
  return pending;
}

export function isActionableCustomerText(value = "") {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }

  if (/[?？]/.test(value)) {
    return true;
  }

  const closingHints = [
    "감사",
    "고맙",
    "알겠습니다",
    "실례했습니다",
    "주문하겠습니다",
    "사용해 보겠습니다",
    "즐거운",
    "좋은 하루",
    "수고하세요",
    "잘 알겠습니다"
  ];
  const strongActionKeywords = [
    "가능",
    "될까요",
    "되나요",
    "어떻게",
    "안되",
    "불량",
    "환불",
    "반품",
    "배송",
    "교환",
    "고장",
    "주소",
    "오류",
    "증상",
    "연결"
  ];

  if (
    closingHints.some((hint) => normalized.includes(hint)) &&
    !strongActionKeywords.some((keyword) => normalized.includes(keyword))
  ) {
    return false;
  }

  if (strongActionKeywords.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  const courtesyPatterns = [
    "감사합니다",
    "감사해요",
    "고맙습니다",
    "감사",
    "넵",
    "네",
    "네네",
    "알겠습니다",
    "수고하세요",
    "확인 감사합니다",
    "감사드립니다"
  ];
  if (
    courtesyPatterns.some(
      (pattern) => normalized === pattern || normalized.endsWith(pattern)
    )
  ) {
    return false;
  }

  return normalized.length > 20 && !normalized.startsWith("네 ");
}

export function snippet(value = "", limit = 140) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

export function buildSearchIndexParts(...parts) {
  const joined = parts.filter(Boolean).join(" ");
  return {
    text: joined,
    words: tokenize(joined),
    grams: charBigrams(joined)
  };
}

export function scoreSearch(queryIndex, candidateIndex, productBonus = 0) {
  const wordScore = overlapScore(queryIndex.words, candidateIndex.words);
  const gramScore = overlapScore(queryIndex.grams, candidateIndex.grams);
  return Number((wordScore * 0.68 + gramScore * 0.32 + productBonus).toFixed(4));
}

export function joinLines(lines = []) {
  return lines.map((line) => normalizeWhitespace(line)).filter(Boolean).join(" ");
}
