/**
 * Local Auth & API Key Management
 *
 * Phase 3: Manages inference provider API keys locally.
 * Keys are loaded from (in priority order):
 *   1. Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, OLLAMA_BASE_URL)
 *   2. ~/.automaton/keys.json (dedicated key store)
 *   3. automaton.json config (openaiApiKey, anthropicApiKey, ollamaBaseUrl)
 *
 * No legacy API key required for local operation.
 */

import fs from "fs";
import path from "path";
import { getAutomatonDir } from "../identity/wallet.js";

export interface ProviderKeys {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  /** Legacy API key — optional, only needed for cloud features */
  conwayApiKey?: string;
}

const KEYS_FILENAME = "keys.json";

/**
 * Load all provider API keys from available sources.
 * Priority: env vars > keys.json > automaton.json config
 */
export function loadProviderKeys(): ProviderKeys {
  // Start with keys from the dedicated key store
  const stored = loadKeysFile();

  // Layer on config values (lower priority than keys.json)
  const configKeys = loadKeysFromConfig();

  // Merge: keys.json overrides config
  const merged: ProviderKeys = {
    ...configKeys,
    ...stored,
  };

  // Environment variables override everything (Anthropic checked first as primary provider)
  if (process.env.ANTHROPIC_API_KEY) {
    merged.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY) {
    merged.openaiApiKey = process.env.OPENAI_API_KEY;
  }
  if (process.env.OLLAMA_BASE_URL) {
    merged.ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
  }
  if (process.env.CONWAY_API_KEY) {
    merged.conwayApiKey = process.env.CONWAY_API_KEY;
  }

  return merged;
}

/**
 * Save provider keys to ~/.automaton/keys.json
 */
export function saveProviderKeys(keys: ProviderKeys): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const keysPath = path.join(dir, KEYS_FILENAME);

  // Only save non-empty values
  const toSave: Record<string, string> = {};
  if (keys.openaiApiKey) toSave.openaiApiKey = keys.openaiApiKey;
  if (keys.anthropicApiKey) toSave.anthropicApiKey = keys.anthropicApiKey;
  if (keys.ollamaBaseUrl) toSave.ollamaBaseUrl = keys.ollamaBaseUrl;
  if (keys.conwayApiKey) toSave.conwayApiKey = keys.conwayApiKey;

  fs.writeFileSync(keysPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });
}

/**
 * Check if we have at least one inference provider configured.
 */
export function hasInferenceProvider(): boolean {
  const keys = loadProviderKeys();
  return !!(keys.anthropicApiKey || keys.openaiApiKey || keys.ollamaBaseUrl);
}

/**
 * Load the legacy API key (for backward compatibility).
 * Returns the key from env, keys.json, or config.json.
 */
export function loadApiKey(): string | null {
  // Env var first
  if (process.env.CONWAY_API_KEY) {
    return process.env.CONWAY_API_KEY;
  }

  // keys.json
  const stored = loadKeysFile();
  if (stored.conwayApiKey) return stored.conwayApiKey;

  // Legacy: config.json (used by old provision flow)
  const configJsonPath = path.join(getAutomatonDir(), "config.json");
  if (fs.existsSync(configJsonPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configJsonPath, "utf-8"));
      if (config.apiKey) return config.apiKey;
    } catch {
      // fall through
    }
  }

  return null;
}

// ── Internal helpers ──────────────────────────────────────────────

function loadKeysFile(): ProviderKeys {
  const keysPath = path.join(getAutomatonDir(), KEYS_FILENAME);
  if (!fs.existsSync(keysPath)) return {};

  try {
    return JSON.parse(fs.readFileSync(keysPath, "utf-8")) as ProviderKeys;
  } catch {
    return {};
  }
}

function loadKeysFromConfig(): ProviderKeys {
  const configPath = path.join(getAutomatonDir(), "automaton.json");
  if (!fs.existsSync(configPath)) return {};

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const keys: ProviderKeys = {};
    if (config.openaiApiKey) keys.openaiApiKey = config.openaiApiKey;
    if (config.anthropicApiKey) keys.anthropicApiKey = config.anthropicApiKey;
    if (config.ollamaBaseUrl) keys.ollamaBaseUrl = config.ollamaBaseUrl;
    if (config.conwayApiKey) keys.conwayApiKey = config.conwayApiKey;
    return keys;
  } catch {
    return {};
  }
}
