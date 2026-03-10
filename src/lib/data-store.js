import fs from "node:fs/promises";
import path from "node:path";

import {
  buildSearchIndexParts,
  extractModelIdentifiers,
  extractPendingCustomerMessages,
  extractProductNames,
  extractSupportSignals,
  isActionableCustomerText,
  latestOrderDate,
  messageRole,
  normalizeWhitespace,
  scoreSearch,
  snippet,
  summarizePurchaseHistory,
  unique
} from "./text-utils.js";

function createRetrievalExample(example) {
  const searchIndex = buildSearchIndexParts(example.customerText);
  const modelIdentifiers = extractModelIdentifiers(
    example.productName,
    example.customerText
  );
  const supportSignals = extractSupportSignals(
    example.productName,
    example.customerText,
    example.answerText
  );

  return {
    ...example,
    searchIndex,
    modelIdentifiers,
    supportSignals
  };
}

function normalizeQnaEntries(entries = []) {
  return entries
    .filter((entry) => entry.문의 && entry.답변)
    .map((entry, index) =>
      createRetrievalExample({
        id: `qna:${index + 1}`,
        source: "상품Q&A",
        productName: normalizeWhitespace(entry.상품명 ?? ""),
        customerText: normalizeWhitespace(entry.문의 ?? ""),
        answerText: normalizeWhitespace(entry.답변 ?? ""),
        orderSummary: ""
      })
    );
}

function splitConversationTurns(conversation) {
  const turns = [];
  let currentCustomerLines = [];
  let currentSellerLines = [];

  const flush = () => {
    if (!currentCustomerLines.length || !currentSellerLines.length) {
      currentCustomerLines = [];
      currentSellerLines = [];
      return;
    }

    turns.push({
      id: `${conversation.id}:turn:${turns.length + 1}`,
      source: "상담이력",
      productName: conversation.productNames.join(" / "),
      customerText: currentCustomerLines.join(" "),
      answerText: currentSellerLines.join("\n"),
      orderSummary: conversation.orderSummary
    });

    currentCustomerLines = [];
    currentSellerLines = [];
  };

  for (const message of conversation.messages) {
    if (message.role === "customer") {
      if (currentSellerLines.length) {
        flush();
      }
      currentCustomerLines.push(message.text);
      continue;
    }

    if (!currentCustomerLines.length) {
      continue;
    }
    currentSellerLines.push(message.text);
  }

  flush();

  return turns.map(createRetrievalExample);
}

function normalizeConversation(rawConversation, index) {
  const purchaseHistory = rawConversation.구매이력 ?? [];
  const messages = (rawConversation.대화내용 ?? [])
    .map((message) => ({
      role: messageRole(message.발신자),
      text: normalizeWhitespace(message.내용 ?? "")
    }))
    .filter((message) => message.text);

  const productNames = extractProductNames(purchaseHistory);
  const pendingCustomerLines = extractPendingCustomerMessages(messages);
  const pendingCustomerText = pendingCustomerLines.join(" ");

  return {
    id: `talk:${index + 1}`,
    customerName: normalizeWhitespace(rawConversation.고객명 ?? "고객"),
    purchaseHistory,
    orderSummary: summarizePurchaseHistory(purchaseHistory),
    latestOrderDate: latestOrderDate(purchaseHistory),
    productNames,
    messages,
    awaitingReply:
      messages.length > 0 &&
      messages[messages.length - 1].role === "customer" &&
      isActionableCustomerText(pendingCustomerText),
    pendingCustomerText,
    preview: pendingCustomerText || messages[messages.length - 1]?.text || "대화 내용 없음"
  };
}

function rankConversations(conversations) {
  return conversations
    .slice()
    .sort((left, right) => {
      if (left.awaitingReply !== right.awaitingReply) {
        return left.awaitingReply ? -1 : 1;
      }
      if (left.latestOrderDate !== right.latestOrderDate) {
        return right.latestOrderDate.localeCompare(left.latestOrderDate);
      }
      return right.messages.length - left.messages.length;
    });
}

export class KnowledgeBaseStore {
  constructor({ policies, qnaCount, conversations, retrievalExamples }) {
    this.policies = policies;
    this.conversations = rankConversations(conversations);
    this.retrievalExamples = retrievalExamples;
    this.conversationMap = new Map(
      this.conversations.map((conversation) => [conversation.id, conversation])
    );
    this.stats = {
      qnaCount,
      conversationCount: this.conversations.length,
      retrievalCount: retrievalExamples.length,
      productCount: unique(
        this.conversations.flatMap((conversation) => conversation.productNames)
      ).length,
      awaitingReplyCount: this.conversations.filter((item) => item.awaitingReply)
        .length
    };
  }

  getConversationSummaries(limit = 120) {
    return this.conversations.slice(0, limit).map((conversation) => ({
      id: conversation.id,
      customerName: conversation.customerName,
      awaitingReply: conversation.awaitingReply,
      latestOrderDate: conversation.latestOrderDate,
      orderSummary: conversation.orderSummary,
      productNames: conversation.productNames,
      preview: snippet(conversation.preview, 110),
      messageCount: conversation.messages.length
    }));
  }

  getConversationById(id) {
    return this.conversationMap.get(id) ?? null;
  }

  searchConversations(query = "", limit = 80) {
    const normalized = normalizeWhitespace(query);
    if (!normalized) {
      return this.getConversationSummaries(limit);
    }

    const queryIndex = buildSearchIndexParts(normalized);
    return this.conversations
      .map((conversation) => {
        const candidateIndex = buildSearchIndexParts(
          conversation.customerName,
          conversation.productNames.join(" "),
          conversation.preview,
          conversation.orderSummary
        );
        const productBonus = conversation.productNames.some((name) =>
          normalized.includes(name.toLowerCase())
        )
          ? 0.15
          : 0;
        return {
          conversation,
          score: scoreSearch(queryIndex, candidateIndex, productBonus)
        };
      })
      .filter((item) => item.score > 0.03)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ conversation }) => ({
        id: conversation.id,
        customerName: conversation.customerName,
        awaitingReply: conversation.awaitingReply,
        latestOrderDate: conversation.latestOrderDate,
        orderSummary: conversation.orderSummary,
        productNames: conversation.productNames,
        preview: snippet(conversation.preview, 110),
        messageCount: conversation.messages.length
      }));
  }
}

export async function loadKnowledgeBase(rootDir) {
  const qnaDir = path.join(rootDir, "data", "qna", "qna");
  const policyPath = path.join(rootDir, "config", "policies.json");
  const filenames = await fs.readdir(qnaDir);

  const qnaFile = filenames.find((filename) =>
    filename.startsWith("lanstar_qna_result_")
  );
  const talkFiles = filenames
    .filter((filename) => filename.startsWith("talk_order_data_"))
    .sort();

  if (!qnaFile || !talkFiles.length) {
    throw new Error(
      "data/qna/qna 경로에 Q&A 또는 톡톡 주문 데이터 파일이 없습니다."
    );
  }

  const [policyContent, qnaContent, ...talkContents] = await Promise.all([
    fs.readFile(policyPath, "utf8"),
    fs.readFile(path.join(qnaDir, qnaFile), "utf8"),
    ...talkFiles.map((filename) => fs.readFile(path.join(qnaDir, filename), "utf8"))
  ]);

  const policies = JSON.parse(policyContent);
  const qnaEntries = JSON.parse(qnaContent);
  const talkEntries = talkContents.flatMap((content) => JSON.parse(content));

  const qnaExamples = normalizeQnaEntries(qnaEntries);
  const conversations = talkEntries.map((entry, index) =>
    normalizeConversation(entry, index)
  );
  const retrievalExamples = [
    ...qnaExamples,
    ...conversations.flatMap(splitConversationTurns)
  ];

  return new KnowledgeBaseStore({
    policies,
    qnaCount: qnaExamples.length,
    conversations,
    retrievalExamples
  });
}
