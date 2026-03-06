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
  } catch (err) {
    // If the file exists but is corrupted, log and refuse to start with empty store
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      module: "url-summarizer.api-keys",
      message: `Failed to load API keys from ${keysPath}: ${message}`,
    }));
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

/**
 * Atomically check quota and reserve a slot (pre-increment).
 * This prevents concurrent requests from bypassing the quota limit.
 * Call refundQuota() if the request fails after reservation.
 */
export function reserveQuota(
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
  }

  const allowed = usage.count < limit;

  // Atomically pre-increment to reserve the slot
  if (allowed) {
    s.usage.set(apiKey, { ...usage, count: usage.count + 1 });
  } else {
    s.usage.set(apiKey, usage);
  }

  // Calculate reset time (UTC) — use year/month components to avoid month-end overflow
  const periodStart = new Date(usage.period_start);
  let resetDate: Date;
  if (isFree) {
    resetDate = new Date(usage.period_start);
    resetDate.setUTCDate(resetDate.getUTCDate() + 1);
    resetDate.setUTCHours(0, 0, 0, 0);
  } else {
    const resetYear = periodStart.getUTCMonth() === 11
      ? periodStart.getUTCFullYear() + 1
      : periodStart.getUTCFullYear();
    const resetMonth = (periodStart.getUTCMonth() + 1) % 12;
    resetDate = new Date(Date.UTC(resetYear, resetMonth, 1, 0, 0, 0, 0));
  }

  return {
    allowed,
    quota: {
      tier: record.tier,
      used: allowed ? usage.count + 1 : usage.count,
      limit,
      remaining: allowed ? Math.max(0, limit - usage.count - 1) : 0,
      resets_at: resetDate.toISOString(),
    },
  };
}

/** Read-only quota check without incrementing (for GET /quota endpoint) */
export function getQuotaInfo(
  config: ServiceConfig,
  apiKey: string,
): QuotaInfo {
  const s = getStore(config);
  const record = s.keys.get(apiKey);

  if (!record || !record.enabled) {
    return { tier: "unknown", used: 0, limit: 0, remaining: 0, resets_at: new Date().toISOString() };
  }

  const tier = PRICING_TIERS.find((t) => t.name === record.tier);
  const isFree = record.tier === "free";
  const limit = isFree ? config.freeTierDailyLimit : (tier?.monthlyLimit ?? 0);

  let usage = s.usage.get(apiKey);
  const now = new Date();

  if (usage) {
    const periodStart = new Date(usage.period_start);
    const nowDay = now.toISOString().slice(0, 10);
    const startDay = periodStart.toISOString().slice(0, 10);
    const expired = isFree
      ? nowDay !== startDay
      : now.getUTCMonth() !== periodStart.getUTCMonth() || now.getUTCFullYear() !== periodStart.getUTCFullYear();
    if (expired) usage = undefined;
  }

  const used = usage?.count ?? 0;
  const remaining = Math.max(0, limit - used);

  const periodStartDate = usage ? new Date(usage.period_start) : now;
  let resetDate: Date;
  if (isFree) {
    resetDate = new Date(periodStartDate);
    resetDate.setUTCDate(resetDate.getUTCDate() + 1);
    resetDate.setUTCHours(0, 0, 0, 0);
  } else {
    const resetYear = periodStartDate.getUTCMonth() === 11
      ? periodStartDate.getUTCFullYear() + 1
      : periodStartDate.getUTCFullYear();
    const resetMonth = (periodStartDate.getUTCMonth() + 1) % 12;
    resetDate = new Date(Date.UTC(resetYear, resetMonth, 1, 0, 0, 0, 0));
  }

  return { tier: record.tier, used, limit, remaining, resets_at: resetDate.toISOString() };
}

/** Refund a reserved quota slot on request failure */
export function refundQuota(config: ServiceConfig, apiKey: string): void {
  const s = getStore(config);
  const usage = s.usage.get(apiKey);
  if (usage && usage.count > 0) {
    s.usage.set(apiKey, { ...usage, count: usage.count - 1 });
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
  // Atomic write: write to temp file then rename to prevent corruption on crash
  const tmpPath = keysPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), "utf-8");
  fs.renameSync(tmpPath, keysPath);
}

/** Reset the in-memory store (for testing) */
export function resetStore(): void {
  store = null;
}
