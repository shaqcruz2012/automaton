/**
 * Niche Discovery Schema
 *
 * Defines the SQLite schema for the niches table which stores discovered
 * market niches along with their trend/gap/moat scores and legal flags.
 *
 * Follows the same schema-init pattern as src/local/accounting.ts:
 * CREATE TABLE IF NOT EXISTS + idempotent index creation.
 */

import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

const NICHE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS niches (
    niche_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    subdomain TEXT NOT NULL DEFAULT '',
    user_type TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    trend_score REAL NOT NULL DEFAULT 0.0,
    gap_score REAL NOT NULL DEFAULT 0.0,
    moat_potential REAL NOT NULL DEFAULT 0.0,
    ethics_flag TEXT NOT NULL DEFAULT 'ok' CHECK(ethics_flag IN ('ok','sensitive','reject')),
    legal_flag TEXT NOT NULL DEFAULT 'ok' CHECK(legal_flag IN ('ok','sensitive','reject')),
    sources TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_niches_domain ON niches(domain);
  CREATE INDEX IF NOT EXISTS idx_niches_legal ON niches(legal_flag);
  CREATE INDEX IF NOT EXISTS idx_niches_status ON niches(status);
`;

/**
 * Ensure the niches table and indexes exist.
 * Call this during database initialization, after initAccountingSchema.
 */
export function initNicheSchema(db: Database): void {
  db.exec(NICHE_SCHEMA);
}
