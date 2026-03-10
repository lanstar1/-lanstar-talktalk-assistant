import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const targetUrl = process.env.TALKTALK_INSPECT_URL ?? "https://partner.talk.naver.com/";
const storageStatePath =
  process.env.TALKTALK_STORAGE_STATE_PATH ??
  path.join(rootDir, "storage", "talktalk-account-1.state.json");
const outputDir = path.join(rootDir, "tmp", "talktalk-inspect");
const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome";
const headless = process.env.PLAYWRIGHT_HEADLESS === "false" ? false : true;
const clickSelector = process.env.TALKTALK_CLICK_SELECTOR ?? "";
const clickText = process.env.TALKTALK_CLICK_TEXT ?? "";

function sanitizeForFile(value = "") {
  return String(value).replace(/[^a-z0-9_-]+/gi, "-");
}

function summarizeNode(node) {
  if (!node) {
    return null;
  }

  return {
    tag: node.tagName,
    id: node.id || "",
    classes: Array.isArray(node.classList) ? node.classList : [],
    role: node.role || "",
    name: node.name || "",
    text: node.text || "",
    href: node.href || "",
    selector: node.selector || ""
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function collectCandidates(page) {
  return page.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function selectorFor(el) {
      if (el.id) {
        return `#${CSS.escape(el.id)}`;
      }

      const parts = [el.tagName.toLowerCase()];
      const classNames = Array.from(el.classList || []).slice(0, 3);
      if (classNames.length) {
        parts.push(
          classNames.map((className) => `.${CSS.escape(className)}`).join("")
        );
      }

      if (el.getAttribute("data-testid")) {
        parts.push(`[data-testid="${el.getAttribute("data-testid")}"]`);
      }

      if (el.getAttribute("role")) {
        parts.push(`[role="${el.getAttribute("role")}"]`);
      }

      return parts.join("");
    }

    function pack(el) {
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || "",
        classList: Array.from(el.classList || []),
        role: el.getAttribute("role") || "",
        name:
          el.getAttribute("aria-label") ||
          el.getAttribute("name") ||
          "",
        text: text.slice(0, 200),
        href: el.getAttribute("href") || "",
        selector: selectorFor(el)
      };
    }

    const interactive = Array.from(
      document.querySelectorAll("button, a, input, textarea, select, [role], [data-testid]")
    )
      .filter(visible)
      .map(pack)
      .slice(0, 500);

    const named = Array.from(document.querySelectorAll("body *"))
      .filter(visible)
      .map(pack)
      .filter((item) =>
        /라인업시스템|랜스타|스토어|사용 중|계정 홈 바로가기|채팅창|프로필 홈|상담|톡톡|내 계정|마스터/i.test(
          item.text
        )
      )
      .slice(0, 300);

    return { interactive, named };
  });
}

async function collectKeywordResults(page, keywords) {
  const results = {};

  for (const keyword of keywords) {
    const textLocator = page.getByText(keyword, { exact: false });
    const count = await textLocator.count().catch(() => 0);
    if (!count) {
      results[keyword] = null;
      continue;
    }

    const node = await textLocator.first().evaluate((el) => {
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || "",
        classList: Array.from(el.classList || []),
        role: el.getAttribute("role") || "",
        name: el.getAttribute("aria-label") || "",
        text: text.slice(0, 200),
        href: el.getAttribute("href") || ""
      };
    });

    results[keyword] = { count, node };
  }

  return results;
}

async function captureState(page, label) {
  const safeLabel = sanitizeForFile(label);
  const html = await page.content();
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const screenshotPath = path.join(outputDir, `${safeLabel}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const candidates = await collectCandidates(page);
  const keywordResults = await collectKeywordResults(page, [
    "라인업시스템",
    "랜스타",
    "스토어팜",
    "계정 홈 바로가기",
    "채팅창",
    "프로필 홈",
    "사용 중",
    "상담",
    "톡톡",
    "내 계정",
    "마스터",
    "시작하기"
  ]);

  await fs.writeFile(path.join(outputDir, `${safeLabel}.html`), html, "utf8");

  return {
    label,
    pageUrl: page.url(),
    title: await page.title(),
    screenshotPath,
    bodyTextSample: bodyText.slice(0, 5000),
    keywordResults,
    namedCandidates: candidates.named.map(summarizeNode),
    interactiveCandidates: candidates.interactive.map(summarizeNode)
  };
}

async function main() {
  await ensureDir(outputDir);

  const browser = await chromium.launch({
    channel: browserChannel,
    headless
  });

  try {
    const context = await browser.newContext({
      storageState: storageStatePath,
      viewport: { width: 1600, height: 1200 }
    });
    const page = await context.newPage();

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const states = [];
    states.push(await captureState(page, "initial"));

    const confirmButtons = page.getByRole("button", { name: "확인" });
    const confirmCount = await confirmButtons.count().catch(() => 0);
    for (let index = 0; index < Math.min(confirmCount, 3); index += 1) {
      await confirmButtons.first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    states.push(await captureState(page, "after-confirm"));

    const startButton = page.getByRole("button", { name: "시작하기" });
    if (await startButton.count().catch(() => 0)) {
      await startButton.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(5000);
      states.push(await captureState(page, "after-start"));
    }

    if (clickSelector) {
      await page.locator(clickSelector).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(5000);
      states.push(await captureState(page, "after-selector-click"));
    }

    if (clickText) {
      await page.getByText(clickText, { exact: false }).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(5000);
      states.push(await captureState(page, "after-text-click"));
    }

    const report = {
      inspectedAt: new Date().toISOString(),
      targetUrl,
      storageStatePath,
      browserChannel,
      headless,
      clickSelector,
      clickText,
      states
    };

    await fs.writeFile(
      path.join(outputDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
