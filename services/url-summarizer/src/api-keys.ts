/**
 * API Key Management
 *
 * File-backed API key store with in-memory quota tracking.
 * Keys are stored in a JSON file; usage counts are in-memory
 * with periodic flush (TODO: Redis-friendly abstraction).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { ApiKeyRecord, UsageRecord, QuotaInfo } from "./types.js";
import { PRICING_TIERS, type ServiceConfig } from "./config.js";

interface KeyStore {
  readonly keys: ReadonlyMap<string, ApiKeyRecord>;
  readonly usage: Map<string, UsageRecord>;
}

let store: KeyStore | null = null;

function getStore(config: ServiceConfig): KeyStore {
  if (store) return store;

  const keys = new Map<string, ApiKeyRecord>();
  const usage = new Map<string, UsageRecord>();

  // Load keys from file
  const keysPath = path.resolve(config.apiKeysPath);
  try {
    if (fs.existsSync(keysPath)) {
      const raw = JSON.parse(fs.readFileSync(keysPath, "utf-8")) as ApiKeyRecord[];
      for (const record of raw) {
        keys.set(record.key, record);
      }
    }
  } catch {
    // Start with empty store on any error
  }

  store = { keys, usage };
  return store;
}

/** Generate a new API key with the format `dsk_...` */
export function generateApiKey(): string {
  const bytes = crypto.randomBytes(24);
  return `dsk_${bytes.toString("base64url")}`;
}

/** Create a new API key and persist it */
export function createApiKey(
  config: ServiceConfig,
  tier: string = "free",
  owner?: string,
): ApiKeyRecord {
  const s = getStore(config);

  const record: ApiKeyRecord = {
    key: generateApiKey(),
    tier,
    created_at: new Date().toISOString(),
    owner,
    enabled: true,
  };

  // Immutable: create new map with added entry
  const updatedKeys = new Map(s.keys);
  updatedKeys.set(record.key, record);
  store = { keys: updatedKeys, usage: s.usage };

  persistKeys(config);
  return record;
}

/** Look up an API key. Returns null if not found or disabled. */
export function lookupApiKey(
  config: ServiceConfig,
  apiKey: string,
): ApiKeyRecord | null {
  const s = getStore(config);
  const record = s.keys.get(apiKey);
  if (!record || !record.enabled) return null;
  return record;
}

/** Check and increment quota for an API key. Returns quota info. */
export function checkQuota(
  config: ServiceConfig,
  apiKey: string,
): { allowed: boolean; quota: QuotaInfo } {
  const s = getStore(config);
  const record = s.keys.get(apiKey);

  if (!record || !record.enabled) {
    return {
      allowed: false,
      quota: {
        tier: "unknown",
        used: 0,
        limit: 0,
        remaining: 0,
        resets_at: new Date().toISOString(),
      },
    };
  }

  const tier = PRICING_TIERS.find((t) => t.name === record.tier);
  const isFree = record.tier === "free";
  const periodType = isFree ? "daily" : "monthly";

  // Determine limit
  const limit = isFree ? config.freeTierDailyLimit : (tier?.monthlyLimit ?? 0);

  // Get or create usage record
  let usage = s.usage.get(apiKey);
  const now = new Date();

  // Check if usage period has expired (UTC-based for deterministic behavior)
  if (usage) {
    const periodStart = new Date(usage.period_start);
    const nowDay = now.toISOString().slice(0, 10);
    const startDay = periodStart.toISOString().slice(0, 10);
    const expired = isFree
      ? nowDay !== startDay
      : now.getUTCMonth() !== periodStart.getUTCMonth() || now.getUTCFullYear() !== periodStart.getUTCFullYear();

    if (expired) {
      usage = undefined; // reset
    }
  }

  if (!usage) {
    usage = {
      key: apiKey,
      count: 0,
      period_start: now.toISOString(),
      period_type: periodType,
    };
    s.usage.set(apiKey, usage);
  }

  const remaining = Math.max(0, limit - usage.count);
  const allowed = usage.count < limit;

  // Calculate reset time (UTC)
  const resetDate = new Date(usage.period_start);
  if (isFree) {
    resetDate.setUTCDate(resetDate.getUTCDate() + 1);
    resetDate.setUTCHours(0, 0, 0, 0);
  } else {
    resetDate.setUTCMonth(resetDate.getUTCMonth() + 1);
    resetDate.setUTCDate(1);
    resetDate.setUTCHours(0, 0, 0, 0);
  }

  return {
    allowed,
    quota: {
      tier: record.tier,
      used: usage.count,
      limit,
      remaining: allowed ? remaining : 0,
      resets_at: resetDate.toISOString(),
    },
  };
}

/** Increment usage counter after a successful request (immutable replace) */
export function incrementUsage(config: ServiceConfig, apiKey: string): void {
  const s = getStore(config);
  const usage = s.usage.get(apiKey);
  if (usage) {
    s.usage.set(apiKey, { ...usage, count: usage.count + 1 });
  }
}

/** Persist keys to disk */
function persistKeys(config: ServiceConfig): void {
  const s = getStore(config);
  const keysPath = path.resolve(config.apiKeysPath);

  // Ensure directory exists
  const dir = path.dirname(keysPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const records = Array.from(s.keys.values());
  fs.writeFileSync(keysPath, JSON.stringify(records, null, 2), "utf-8");
}

/** Reset the in-memory store (for testing) */
export function resetStore(): void {
  store = null;
}
