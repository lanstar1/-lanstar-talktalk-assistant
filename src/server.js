import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TalkTalkWorker } from "./automation/talktalk-worker.js";
import { loadKnowledgeBase } from "./lib/data-store.js";
import { LlmClient } from "./lib/llm-client.js";
import { loadProductCatalog } from "./lib/product-catalog.js";
import { ReplyEngine } from "./lib/reply-engine.js";
import { getActiveAccount, loadSettings, saveSettings } from "./lib/settings.js";
import {
  isUploadAuthorized,
  isValidStorageState,
  resolveStorageStatePath
} from "./lib/storage-state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

const store = await loadKnowledgeBase(rootDir);
const productCatalog = await loadProductCatalog(rootDir);
let settings = await loadSettings(rootDir);
const llmClient = new LlmClient();
const engine = new ReplyEngine({
  examples: store.retrievalExamples,
  policies: store.policies,
  llmClient,
  productCatalog,
  getSettings: () => settings
});
const worker = new TalkTalkWorker({
  rootDir,
  engine,
  getSettings: () => settings
});

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function getMemoryStats() {
  const memory = process.memoryUsage();
  return {
    rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
    heapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
    heapTotalMb: Math.round((memory.heapTotal / 1024 / 1024) * 10) / 10,
    externalMb: Math.round((memory.external / 1024 / 1024) * 10) / 10
  };
}

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

function getAdminUploadToken() {
  return process.env.ADMIN_UPLOAD_TOKEN ?? null;
}

function getStorageStateStatus() {
  const statePath = resolveStorageStatePath(rootDir);
  return fs
    .stat(statePath)
    .then((stat) => ({
      exists: true,
      path: statePath,
      size: stat.size,
      updatedAt: stat.mtime.toISOString()
    }))
    .catch((error) => {
      if (error.code === "ENOENT") {
        return {
          exists: false,
          path: statePath,
          size: 0,
          updatedAt: null
        };
      }

      throw error;
    });
}

function bootstrapPayload() {
  const liveOnly = settings.monitorOnly !== false;
  return {
    ok: true,
    stats: store.stats,
    system: {
      memory: getMemoryStats()
    },
    settings,
    activeAccount: getActiveAccount(settings),
    llmStatus: engine.getLlmStatus(),
    productCatalog: productCatalog.getStats(),
    automation: worker.getStatus(),
    live: worker.getLiveOverview(),
    conversations: liveOnly ? [] : store.getConversationSummaries()
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
        llmStatus: engine.getLlmStatus(),
        memory: getMemoryStats()
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
        messages: body.messages ?? conversation?.messages ?? [],
        productNames: body.productNames ?? conversation?.productNames ?? []
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

    if (request.method === "GET" && pathname === "/api/live/overview") {
      sendJson(response, 200, { ok: true, live: worker.getLiveOverview() });
      return;
    }

    if (pathname.startsWith("/api/admin/")) {
      const uploadToken = getAdminUploadToken();
      if (!uploadToken) {
        sendError(response, 404, "관리자 업로드 기능이 비활성화되어 있습니다.");
        return;
      }

      if (!isUploadAuthorized(request.headers, uploadToken)) {
        sendError(response, 401, "관리자 인증에 실패했습니다.");
        return;
      }
    }

    if (request.method === "GET" && pathname === "/api/admin/storage-state-status") {
      sendJson(response, 200, {
        ok: true,
        storageState: await getStorageStateStatus()
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/admin/storage-state") {
      const body = await parseBody(request);
      if (!isValidStorageState(body)) {
        sendError(response, 400, "storageState 형식이 올바르지 않습니다.");
        return;
      }

      const statePath = resolveStorageStatePath(rootDir);
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(`${statePath}.tmp`, JSON.stringify(body, null, 2), "utf8");
      await fs.rename(`${statePath}.tmp`, statePath);

      sendJson(response, 200, {
        ok: true,
        storageState: {
          ...(await getStorageStateStatus()),
          cookies: body.cookies.length,
          origins: body.origins.length
        }
      });
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
      if (settings.monitorOnly !== false) {
        sendError(
          response,
          403,
          "테스트 모드에서는 고객에게 실제 답변을 전송할 수 없습니다."
        );
        return;
      }

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

    if (request.method === "POST" && pathname === "/api/live/select") {
      const body = await parseBody(request);
      const conversationId = String(body.conversationId ?? "").trim();
      if (!conversationId) {
        sendError(response, 400, "선택할 실시간 대화 ID가 비어 있습니다.");
        return;
      }

      const live = await worker.selectLiveConversation(conversationId);
      sendJson(response, 200, { ok: true, live });
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

  if (truthy(process.env.TALKTALK_AUTOSTART)) {
    worker.start().catch((error) => {
      process.stderr.write(`[autostart] ${error.message}\n`);
    });
  }
});
