/**
 * Experiment Schema
 *
 * Defines the SQLite schema for the experiments table which stores
 * planned and running MVP experiments tied to discovered niches.
 *
 * Follows the same schema-init pattern as src/knowledge/niche-schema.ts:
 * CREATE TABLE IF NOT EXISTS + idempotent index creation.
 */

import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

const EXPERIMENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS experiments (
    experiment_id TEXT PRIMARY KEY,
    niche_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','running','completed','killed')),
    mvp_type TEXT NOT NULL CHECK(mvp_type IN ('api','small_app','agent_service')),
    mvp_spec TEXT NOT NULL DEFAULT '{}',
    budget_credits INTEGER NOT NULL DEFAULT 500,
    start_ts TEXT,
    end_ts TEXT,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_experiments_niche ON experiments(niche_id);
  CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
`;

/**
 * Ensure the experiments table and indexes exist.
 * Call this during database initialization, after initNicheSchema.
 */
export function initExperimentSchema(db: Database): void {
  db.exec(EXPERIMENT_SCHEMA);
}
