import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TALKTALK = {
  url: "https://partner.talk.naver.com/",
  pollIntervalMs: 12000,
  selectorsPath: "config/talktalk.selectors.sample.json",
  browserChannel: null,
  headless: false,
  storageStatePath: null,
  publicChatUrl: "",
  sourceName: ""
};

const DEFAULT_LLM = {
  enabled: true,
  enhanceWhenConfidenceBelow: 0.78,
  weakAnswerLength: 140,
  maxEvidenceCount: 4,
  allowAutoSend: false
};

function createDefaultAccount(id, name, userDataDir, metadata = {}) {
  return {
    id,
    name,
    enabled: true,
    talktalk: {
      ...DEFAULT_TALKTALK,
      userDataDir,
      ...metadata
    }
  };
}

const DEFAULT_SETTINGS = {
  mode: "review",
  monitorOnly: true,
  autoSendThreshold: 0.8,
  llm: DEFAULT_LLM,
  activeAccountId: "account-1",
  accounts: [
    createDefaultAccount(
      "account-1",
      "랜스타",
      "storage/browser-profile/account-1",
      {
        publicChatUrl: "http://talk.naver.com/W4QWIB",
        sourceName: "라인업시스템"
      }
    ),
    createDefaultAccount(
      "account-2",
      "스토어팜",
      "storage/browser-profile/account-2",
      {
        publicChatUrl: "http://talk.naver.com/WC5FMA",
        sourceName: "랜스타"
      }
    )
  ]
};

function normalizeAccountName(name, fallbackName) {
  const normalized = String(name ?? "").trim();
  if (!normalized || /^톡톡 계정 \d+$/u.test(normalized)) {
    return fallbackName;
  }

  return normalized;
}

function mergeTalkTalk(baseTalkTalk = {}, updateTalkTalk = {}) {
  return {
    ...DEFAULT_TALKTALK,
    ...baseTalkTalk,
    ...updateTalkTalk,
    userDataDir:
      updateTalkTalk.userDataDir ??
      baseTalkTalk.userDataDir ??
      DEFAULT_TALKTALK.userDataDir
  };
}

function mergeAccounts(baseAccounts = [], updateAccounts = []) {
  const baseMap = new Map(baseAccounts.map((account) => [account.id, account]));
  const updateMap = new Map(updateAccounts.map((account) => [account.id, account]));
  const ids = [
    ...new Set([
      ...DEFAULT_SETTINGS.accounts.map((account) => account.id),
      ...baseAccounts.map((account) => account.id),
      ...updateAccounts.map((account) => account.id)
    ])
  ];

  return ids.map((id, index) => {
    const defaultAccount =
      DEFAULT_SETTINGS.accounts.find((account) => account.id === id) ??
      createDefaultAccount(id, `채널 ${index + 1}`, `storage/browser-profile/${id}`);
    const baseAccount =
      baseMap.get(id) ??
      defaultAccount;
    const updateAccount = updateMap.get(id) ?? {};
    const talktalk = mergeTalkTalk(
      mergeTalkTalk(defaultAccount.talktalk, baseAccount.talktalk),
      updateAccount.talktalk ?? {}
    );

    return {
      id,
      name: normalizeAccountName(
        updateAccount.name ?? baseAccount.name,
        defaultAccount.name
      ),
      enabled: updateAccount.enabled ?? baseAccount.enabled ?? true,
      talktalk
    };
  });
}

function mergeSettings(source, updates) {
  return {
    mode: updates.mode ?? source.mode,
    monitorOnly: updates.monitorOnly ?? source.monitorOnly ?? true,
    autoSendThreshold: updates.autoSendThreshold ?? source.autoSendThreshold,
    llm: {
      ...DEFAULT_LLM,
      ...(source.llm ?? {}),
      ...(updates.llm ?? {})
    },
    activeAccountId: updates.activeAccountId ?? source.activeAccountId,
    accounts: mergeAccounts(source.accounts, updates.accounts ?? [])
  };
}

function migrateLegacySettings(rawSettings = {}) {
  if (Array.isArray(rawSettings.accounts) && rawSettings.accounts.length) {
    return rawSettings;
  }

  const legacyTalkTalk = rawSettings.talktalk ?? {};
  return {
    ...rawSettings,
    activeAccountId: rawSettings.activeAccountId ?? "account-1",
    accounts: [
      {
        id: "account-1",
        name: "랜스타",
        enabled: true,
        talktalk: {
          ...DEFAULT_TALKTALK,
          ...DEFAULT_SETTINGS.accounts[0].talktalk,
          ...legacyTalkTalk,
          userDataDir:
            legacyTalkTalk.userDataDir ?? "storage/browser-profile/account-1"
        }
      },
      createDefaultAccount(
        "account-2",
        "스토어팜",
        "storage/browser-profile/account-2",
        DEFAULT_SETTINGS.accounts[1].talktalk
      )
    ]
  };
}

function normalizeSettings(rawSettings = {}) {
  const migrated = migrateLegacySettings(rawSettings);
  const merged = mergeSettings(DEFAULT_SETTINGS, migrated);

  const validAccountIds = new Set(merged.accounts.map((account) => account.id));
  if (!validAccountIds.has(merged.activeAccountId)) {
    merged.activeAccountId = merged.accounts[0]?.id ?? DEFAULT_SETTINGS.activeAccountId;
  }

  return merged;
}

export function getActiveAccount(settings) {
  return (
    settings.accounts.find((account) => account.id === settings.activeAccountId) ??
    settings.accounts[0]
  );
}

export async function loadSettings(rootDir) {
  const storageDir = path.join(rootDir, "storage");
  const settingsPath = path.join(storageDir, "settings.json");

  await fs.mkdir(storageDir, { recursive: true });

  try {
    const content = await fs.readFile(settingsPath, "utf8");
    const normalized = normalizeSettings(JSON.parse(content));
    await fs.writeFile(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await fs.writeFile(
      settingsPath,
      `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`,
      "utf8"
    );
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(rootDir, updates) {
  const storageDir = path.join(rootDir, "storage");
  const settingsPath = path.join(storageDir, "settings.json");
  const nextSettings = normalizeSettings(
    mergeSettings(await loadSettings(rootDir), updates)
  );

  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(
    settingsPath,
    `${JSON.stringify(nextSettings, null, 2)}\n`,
    "utf8"
  );

  return nextSettings;
}
