import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

import { chromium } from "playwright";

const rootDir = process.cwd();
const defaultStatePath =
  process.env.TALKTALK_STORAGE_STATE_PATH ??
  "storage/talktalk-account-1.state.json";
const statePath = path.isAbsolute(defaultStatePath)
  ? defaultStatePath
  : path.join(rootDir, defaultStatePath);
const channel =
  process.env.PLAYWRIGHT_BROWSER_CHANNEL ??
  process.env.BROWSER_CHANNEL ??
  "chrome";
const targetUrl =
  process.env.TALKTALK_URL ?? "https://talk.sell.smartstore.naver.com/";

await fs.mkdir(path.dirname(statePath), { recursive: true });

const browser = await chromium.launch({
  channel,
  headless: false
});
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

process.stdout.write(
  `브라우저에서 톡톡 파트너센터에 로그인한 뒤 Enter를 누르면 storageState를 저장합니다.\n저장 경로: ${statePath}\n`
);
await rl.question("");

await context.storageState({ path: statePath });
await rl.close();
await browser.close();

process.stdout.write(`저장 완료: ${statePath}\n`);
