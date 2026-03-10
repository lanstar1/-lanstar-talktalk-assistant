import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getActiveAccount, loadSettings, saveSettings } from "../src/lib/settings.js";

test("기존 단일 계정 설정을 다계정 구조로 마이그레이션한다", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lanstar-settings-"));
  const storageDir = path.join(rootDir, "storage");
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(
    path.join(storageDir, "settings.json"),
    JSON.stringify(
      {
        mode: "review",
        autoSendThreshold: 0.8,
        talktalk: {
          url: "https://talk.sell.smartstore.naver.com/",
          pollIntervalMs: 7000,
          selectorsPath: "config/custom.json",
          userDataDir: "storage/browser-profile",
          browserChannel: "chrome"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const settings = await loadSettings(rootDir);

  assert.equal(settings.accounts.length, 1);
  assert.equal(settings.activeAccountId, "account-2");
  assert.equal(settings.monitorOnly, true);
  assert.equal(settings.accounts[0].name, "스토어팜");
  assert.equal(settings.accounts[0].talktalk.publicChatUrl, "http://talk.naver.com/WC5FMA");
  assert.equal(settings.accounts[0].talktalk.sourceName, "랜스타");
  assert.equal(settings.accounts[0].talktalk.pollIntervalMs, 7000);
  assert.equal(settings.accounts[0].talktalk.selectorsPath, "config/custom.json");
  assert.equal(settings.accounts[0].talktalk.userDataDir, "storage/browser-profile");
  assert.equal(getActiveAccount(settings).id, "account-2");
});

test("활성 계정을 저장하면 해당 계정이 반환된다", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lanstar-settings-save-"));
  const settings = await saveSettings(rootDir, { activeAccountId: "account-2" });

  assert.equal(settings.activeAccountId, "account-2");
  assert.equal(settings.monitorOnly, true);
  assert.equal(getActiveAccount(settings).name, "스토어팜");
});

test("replaceAccounts 옵션으로 기존 채널을 제거하고 스토어팜만 유지한다", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lanstar-settings-prune-"));
  const storageDir = path.join(rootDir, "storage");
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(
    path.join(storageDir, "settings.json"),
    JSON.stringify(
      {
        activeAccountId: "account-1",
        accounts: [
          {
            id: "account-1",
            name: "랜스타",
            enabled: true,
            talktalk: {
              publicChatUrl: "http://talk.naver.com/W4QWIB"
            }
          },
          {
            id: "account-2",
            name: "스토어팜",
            enabled: true,
            talktalk: {
              publicChatUrl: "http://talk.naver.com/WC5FMA"
            }
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const settings = await saveSettings(rootDir, {
    replaceAccounts: true,
    activeAccountId: "account-2",
    accounts: [
      {
        id: "account-2",
        name: "스토어팜",
        enabled: true,
        talktalk: {
          publicChatUrl: "http://talk.naver.com/WC5FMA",
          sourceName: "랜스타",
          userDataDir: "storage/browser-profile/account-2"
        }
      }
    ]
  });

  assert.equal(settings.activeAccountId, "account-2");
  assert.equal(settings.accounts.length, 1);
  assert.equal(settings.accounts[0].name, "스토어팜");
  assert.equal(settings.accounts[0].talktalk.publicChatUrl, "http://talk.naver.com/WC5FMA");
});
