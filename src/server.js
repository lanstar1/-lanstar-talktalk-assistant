import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TalkTalkWorker } from "./automation/talktalk-worker.js";
import { loadKnowledgeBase } from "./lib/data-store.js";
import { LlmClient } from "./lib/llm-client.js";
import { ReplyEngine } from "./lib/reply-engine.js";
import { getActiveAccount, loadSettings, saveSettings } from "./lib/settings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

const store = await loadKnowledgeBase(rootDir);
let settings = await loadSettings(rootDir);
const llmClient = new LlmClient();
const engine = new ReplyEngine({
  examples: store.retrievalExamples,
  policies: store.policies,
  llmClient,
  getSettings: () => settings
});
const worker = new TalkTalkWorker({
  rootDir,
  engine,
  getSettings: () => settings
});

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendError(response, statusCode, message, extra = {}) {
  sendJson(response, statusCode, {
    ok: false,
    error: message,
    ...extra
  });
}

async function parseBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function bootstrapPayload() {
  return {
    ok: true,
    stats: store.stats,
    settings,
    activeAccount: getActiveAccount(settings),
    llmStatus: engine.getLlmStatus(),
    automation: worker.getStatus(),
    conversations: store.getConversationSummaries()
  };
}

function getRoutePath(requestUrl) {
  return new URL(requestUrl, "http://127.0.0.1").pathname;
}

async function serveStatic(request, response) {
  const pathname = getRoutePath(request.url);
  const relativePath =
    pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.join(publicDir, relativePath);

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8"
      }[ext] ?? "application/octet-stream";

    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(response, 404, "파일을 찾을 수 없습니다.");
      return;
    }
    sendError(response, 500, error.message);
  }
}

const server = http.createServer(async (request, response) => {
  const pathname = getRoutePath(request.url);

  try {
    if (request.method === "GET" && pathname === "/api/bootstrap") {
      sendJson(response, 200, bootstrapPayload());
      return;
    }

    if (request.method === "GET" && pathname === "/healthz") {
      sendJson(response, 200, {
        ok: true,
        uptime: process.uptime(),
        llmStatus: engine.getLlmStatus()
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/search") {
      const url = new URL(request.url, "http://127.0.0.1");
      const results = store.searchConversations(url.searchParams.get("q") ?? "");
      sendJson(response, 200, { ok: true, conversations: results });
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/api/conversations/")) {
      const conversationId = decodeURIComponent(pathname.split("/").pop());
      const conversation = store.getConversationById(conversationId);
      if (!conversation) {
        sendError(response, 404, "대화를 찾을 수 없습니다.");
        return;
      }

      sendJson(response, 200, { ok: true, conversation });
      return;
    }

    if (request.method === "POST" && pathname === "/api/suggest") {
      const body = await parseBody(request);
      const conversation =
        body.conversationId && store.getConversationById(body.conversationId);

      const payload = {
        customerName: body.customerName ?? conversation?.customerName ?? "고객",
        purchaseHistory: body.purchaseHistory ?? conversation?.purchaseHistory ?? [],
        messages: body.messages ?? conversation?.messages ?? []
      };

      const suggestion = await engine.suggestReplyEnhanced(payload);
      sendJson(response, 200, { ok: true, suggestion });
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings") {
      const body = await parseBody(request);
      const shouldRestartWorker =
        Object.hasOwn(body, "activeAccountId") || Object.hasOwn(body, "accounts");
      if (shouldRestartWorker && worker.getStatus().running) {
        await worker.stop();
      }
      settings = await saveSettings(rootDir, body);
      sendJson(response, 200, { ok: true, settings, llmStatus: engine.getLlmStatus() });
      return;
    }

    if (request.method === "GET" && pathname === "/api/automation/status") {
      sendJson(response, 200, { ok: true, automation: worker.getStatus() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/automation/start") {
      await worker.start();
      sendJson(response, 200, { ok: true, automation: worker.getStatus() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/automation/stop") {
      await worker.stop();
      sendJson(response, 200, { ok: true, automation: worker.getStatus() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/automation/manual-send") {
      const body = await parseBody(request);
      const replyText = String(body.replyText ?? "").trim();
      if (!replyText) {
        sendError(response, 400, "전송할 답변이 비어 있습니다.");
        return;
      }

      const automation = await worker.sendManualDraft(replyText);
      sendJson(response, 200, { ok: true, automation });
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    sendError(response, 500, error.message);
  }
});

const port = Number(process.env.PORT ?? 4321);
const host = process.env.HOST ?? (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");

server.listen(port, host, () => {
  process.stdout.write(
    `Lanstar TalkTalk Assistant listening on http://${host}:${port}\n`
  );
});
