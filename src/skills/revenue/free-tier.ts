/**
 * Free Tier — Zero-friction trial for new users
 *
 * Allows 3 free API calls per IP address per 24-hour rolling window.
 * After exhaustion, callers must pay via x402 as normal.
 *
 * Principle: get fills first, optimize spread later.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";

type Database = BetterSqlite3.Database;

// ── Constants ─────────────────────────────────────────────────────

const FREE_CALLS_PER_DAY = 3;
const WINDOW_HOURS = 24;

// ── Schema ────────────────────────────────────────────────────────

const FREE_TIER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS free_tier_usage (
    id TEXT PRIMARY KEY,
    client_ip TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    used_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_free_tier_ip_used
    ON free_tier_usage(client_ip, used_at);
`;

/**
 * Ensure the free_tier_usage table exists.
 * Safe to call multiple times (CREATE IF NOT EXISTS).
 */
export function ensureFreeTierSchema(db: Database): void {
  db.exec(FREE_TIER_SCHEMA);
}

// ── Public API ────────────────────────────────────────────────────

export interface FreeTierResult {
  readonly eligible: boolean;
  readonly remaining: number;
}

/**
 * Check whether a client IP is eligible for a free-tier call.
 *
 * Counts usage in the last 24 hours across all skills.
 * Returns eligibility and remaining free calls.
 */
export function checkFreeTier(
  db: Database,
  clientIp: string,
): FreeTierResult {
  ensureFreeTierSchema(db);

  const cutoff = new Date(
    Date.now() - WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const row = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM free_tier_usage WHERE client_ip = ? AND used_at > ?",
    )
    .get(clientIp, cutoff) as { cnt: number } | undefined;

  const used = row?.cnt ?? 0;
  const remaining = Math.max(0, FREE_CALLS_PER_DAY - used);

  return {
    eligible: remaining > 0,
    remaining,
  };
}

/**
 * Record a free-tier usage event.
 * Call this AFTER successfully processing a free-tier request.
 */
export function recordFreeTierUsage(
  db: Database,
  clientIp: string,
  skillName: string,
): void {
  ensureFreeTierSchema(db);

  db.prepare(
    "INSERT INTO free_tier_usage (id, client_ip, skill_name, used_at) VALUES (?, ?, ?, ?)",
  ).run(ulid(), clientIp, skillName, new Date().toISOString());
}
