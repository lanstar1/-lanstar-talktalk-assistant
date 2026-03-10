import fs from "node:fs/promises";
import path from "node:path";

import {
  canonicalizeModelIdentifier,
  normalizeWhitespace,
  unique
} from "./text-utils.js";

const OPTIONAL_VARIANT_SUFFIXES = new Set([
  "N",
  "LANMART",
  "LINEUP",
  "SHOP",
  "MALL",
  "STORE",
  "SMARTSTORE"
]);

function stringifyStructuredValue(value) {
  if (value == null) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map((item) => stringifyStructuredValue(item)).filter(Boolean).join(" / ");
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${stringifyStructuredValue(item)}`)
      .filter(Boolean)
      .join(" / ");
  }

  return normalizeWhitespace(String(value));
}

function extractModelTokens(value = "") {
  return String(value).toUpperCase().match(/[A-Z0-9]+/g) ?? [];
}

function addAlias(target, value) {
  const alias = canonicalizeModelIdentifier(value);
  if (alias.length < 5) {
    return;
  }

  target.add(alias);
  if (alias.startsWith("LS") && alias.length > 4) {
    target.add(alias.slice(2));
  }
}

function buildAliases(model = "") {
  const aliases = new Set();
  addAlias(aliases, model);

  const tokens = extractModelTokens(model);
  if (!tokens.length) {
    return [...aliases];
  }

  addAlias(aliases, tokens.join(""));

  let trimmed = tokens.slice();
  while (trimmed.length > 2 && OPTIONAL_VARIANT_SUFFIXES.has(trimmed.at(-1))) {
    trimmed = trimmed.slice(0, -1);
    addAlias(aliases, trimmed.join(""));
  }

  return [...aliases];
}

function buildFamilyIdentifiers(model = "") {
  const families = new Set();
  const tokens = extractModelTokens(model);

  if (tokens[0] === "LS" && tokens[1]) {
    addAlias(families, `${tokens[0]}${tokens[1]}`);
  }

  let trimmed = tokens.slice();
  while (trimmed.length > 2 && OPTIONAL_VARIANT_SUFFIXES.has(trimmed.at(-1))) {
    trimmed = trimmed.slice(0, -1);
  }
  if (trimmed[0] === "LS" && trimmed[1]) {
    addAlias(families, `${trimmed[0]}${trimmed[1]}`);
  }

  return [...families];
}

function buildProfileSummary(model, profile = {}) {
  const parts = [
    model,
    profile.카테고리 ? `카테고리: ${normalizeWhitespace(profile.카테고리)}` : "",
    profile.형태 ? `형태: ${normalizeWhitespace(profile.형태)}` : "",
    profile.용도 ? `용도: ${normalizeWhitespace(profile.용도)}` : "",
    profile.규격 ? `규격: ${stringifyStructuredValue(profile.규격)}` : ""
  ].filter(Boolean);

  return parts.join(" / ");
}

function normalizeEntry(model, profile = {}) {
  const canonicalModel = canonicalizeModelIdentifier(model);
  const aliases = buildAliases(model);
  const familyIdentifiers = buildFamilyIdentifiers(model);
  const summary = buildProfileSummary(model, profile);

  return {
    model,
    canonicalModel,
    aliases,
    aliasSet: new Set(aliases),
    familyIdentifiers,
    familySet: new Set(familyIdentifiers),
    formFactor: normalizeWhitespace(profile.형태 ?? ""),
    material: normalizeWhitespace(profile.재질 ?? ""),
    category: normalizeWhitespace(profile.카테고리 ?? ""),
    usage: normalizeWhitespace(profile.용도 ?? ""),
    specs: profile.규격 ?? "",
    specsText: stringifyStructuredValue(profile.규격),
    summary
  };
}

function collectRawModelCandidates(rawHints = []) {
  const candidates = [];

  for (const hint of rawHints.flat()) {
    const text = normalizeWhitespace(hint);
    if (!text) {
      continue;
    }

    const matches = text.match(/[A-Za-z0-9][A-Za-z0-9().-]{3,}/g) ?? [];
    candidates.push(...matches);
  }

  return unique(candidates);
}

function buildQueryFamilies(rawHints = []) {
  const families = new Set();

  for (const candidate of collectRawModelCandidates(rawHints)) {
    const tokens = extractModelTokens(candidate);
    if (tokens[0] === "LS" && tokens[1]) {
      addAlias(families, `${tokens[0]}${tokens[1]}`);
    }

    let trimmed = tokens.slice();
    while (trimmed.length > 2 && OPTIONAL_VARIANT_SUFFIXES.has(trimmed.at(-1))) {
      trimmed = trimmed.slice(0, -1);
    }
    if (trimmed[0] === "LS" && trimmed[1]) {
      addAlias(families, `${trimmed[0]}${trimmed[1]}`);
    }
  }

  return [...families];
}

function rankExactCandidate(entry, queryIdentifier) {
  let score = 1;
  if (entry.canonicalModel === queryIdentifier) {
    score += 0.2;
  }

  score -= Math.max(0, entry.canonicalModel.length - queryIdentifier.length) * 0.001;
  return score;
}

function rankFamilyCandidate(entry, familyIdentifier) {
  let score = 0.5;
  if (entry.canonicalModel === familyIdentifier) {
    score += 0.3;
  }

  score -= Math.max(0, entry.canonicalModel.length - familyIdentifier.length) * 0.001;
  return score;
}

export class ProductCatalog {
  constructor(entries = [], sourcePath = null) {
    this.entries = entries;
    this.sourcePath = sourcePath;
    this.aliasMap = new Map();
    this.familyMap = new Map();

    for (const entry of entries) {
      for (const alias of entry.aliases) {
        const bucket = this.aliasMap.get(alias) ?? [];
        bucket.push(entry);
        this.aliasMap.set(alias, bucket);
      }

      for (const familyIdentifier of entry.familyIdentifiers) {
        const bucket = this.familyMap.get(familyIdentifier) ?? [];
        bucket.push(entry);
        this.familyMap.set(familyIdentifier, bucket);
      }
    }
  }

  getStats() {
    return {
      count: this.entries.length,
      sourcePath: this.sourcePath
    };
  }

  findBestMatch({ modelIdentifiers = [], rawHints = [] } = {}) {
    const normalizedIdentifiers = unique(
      modelIdentifiers.map((identifier) => canonicalizeModelIdentifier(identifier))
    ).filter(Boolean);

    const exactCandidates = normalizedIdentifiers.flatMap((identifier) =>
      (this.aliasMap.get(identifier) ?? []).map((entry) => ({
        entry,
        identifier,
        matchType: entry.canonicalModel === identifier ? "exact" : "variant",
        score: rankExactCandidate(entry, identifier)
      }))
    );

    if (exactCandidates.length) {
      const best = exactCandidates.sort((left, right) => right.score - left.score)[0];
      return {
        model: best.entry.model,
        matchedIdentifier: best.identifier,
        matchType: best.matchType,
        summary: best.entry.summary,
        category: best.entry.category,
        formFactor: best.entry.formFactor,
        material: best.entry.material,
        usage: best.entry.usage,
        specs: best.entry.specs,
        specsText: best.entry.specsText
      };
    }

    const familyIdentifiers = buildQueryFamilies(rawHints);
    const familyCandidates = familyIdentifiers.flatMap((familyIdentifier) =>
      (this.familyMap.get(familyIdentifier) ?? []).map((entry) => ({
        entry,
        identifier: familyIdentifier,
        matchType: "family",
        score: rankFamilyCandidate(entry, familyIdentifier)
      }))
    );

    if (!familyCandidates.length) {
      return null;
    }

    const best = familyCandidates.sort((left, right) => right.score - left.score)[0];
    return {
      model: best.entry.model,
      matchedIdentifier: best.identifier,
      matchType: best.matchType,
      summary: best.entry.summary,
      category: best.entry.category,
      formFactor: best.entry.formFactor,
      material: best.entry.material,
      usage: best.entry.usage,
      specs: best.entry.specs,
      specsText: best.entry.specsText
    };
  }
}

export async function loadProductCatalog(rootDir) {
  const configuredPath =
    process.env.PRODUCT_ANALYSIS_PATH ??
    path.join(rootDir, "data", "product_analysis.json");

  try {
    const content = await fs.readFile(configuredPath, "utf8");
    const raw = JSON.parse(content);
    const entries = Object.entries(raw ?? {})
      .filter(([model, profile]) => normalizeWhitespace(model) && profile)
      .map(([model, profile]) => normalizeEntry(model, profile));

    return new ProductCatalog(entries, configuredPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return new ProductCatalog([], configuredPath);
    }

    throw error;
  }
}
