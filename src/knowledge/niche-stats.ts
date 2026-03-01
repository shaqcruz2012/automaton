/**
 * Niche Stats View
 *
 * Creates and queries a SQL view that aggregates per-niche financial and
 * experimental performance data. Used by the niche prioritization system
 * to compute expected margins and uncertainty estimates.
 *
 * The view joins niches with revenue_events, expense_events, and experiments
 * using subqueries to avoid cross-product issues from multiple LEFT JOINs.
 */

import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

const NICHE_STATS_VIEW = `
  CREATE VIEW IF NOT EXISTS niche_stats AS
  SELECT
    n.niche_id,
    COALESCE(rev.total, 0) AS total_revenue_cents,
    COALESCE(exp.total, 0) AS total_cost_cents,
    COALESCE(rev.total, 0) - COALESCE(exp.total, 0) AS total_margin_cents,
    COALESCE(exps.run_count, 0) AS experiments_run,
    COALESCE(exps.success_count, 0) AS successes,
    COALESCE(exps.failure_count, 0) AS failures,
    CASE
      WHEN COALESCE(exps.completed_count, 0) > 0
      THEN (COALESCE(rev.total, 0) - COALESCE(exp.total, 0)) * 1.0 / exps.completed_count
      ELSE 0.0
    END AS est_expected_margin,
    CASE
      WHEN COALESCE(exps.completed_count, 0) > 0
      THEN 1.0 / (1.0 + COALESCE(exps.completed_count, 0))
      ELSE 1.0
    END AS est_uncertainty
  FROM niches n
  LEFT JOIN (
    SELECT niche_id, SUM(amount_cents) AS total
    FROM revenue_events
    GROUP BY niche_id
  ) rev ON rev.niche_id = n.niche_id
  LEFT JOIN (
    SELECT niche_id, SUM(amount_cents) AS total
    FROM expense_events
    GROUP BY niche_id
  ) exp ON exp.niche_id = n.niche_id
  LEFT JOIN (
    SELECT niche_id,
      COUNT(*) AS run_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'killed' THEN 1 ELSE 0 END) AS failure_count,
      SUM(CASE WHEN status IN ('completed','killed') THEN 1 ELSE 0 END) AS completed_count
    FROM experiments
    GROUP BY niche_id
  ) exps ON exps.niche_id = n.niche_id;
`;

/**
 * Create the niche_stats view if it doesn't already exist.
 * Call this during database initialization, after initExperimentSchema.
 */
export function initNicheStatsView(db: Database): void {
  db.exec(NICHE_STATS_VIEW);
}

/** Aggregated stats for a single niche. */
export interface NicheStats {
  /** Unique niche identifier */
  nicheId: string;
  /** Total revenue attributed to this niche, in cents */
  totalRevenueCents: number;
  /** Total costs attributed to this niche, in cents */
  totalCostCents: number;
  /** Total margin (revenue - costs) in cents */
  totalMarginCents: number;
  /** Number of experiments run for this niche */
  experimentsRun: number;
  /** Number of experiments with status 'completed' */
  successes: number;
  /** Number of experiments with status 'killed' */
  failures: number;
  /** Estimated expected margin per completed experiment */
  estExpectedMargin: number;
  /** Uncertainty estimate: 1/(1+completed_count), ranges from 1.0 (no data) to near 0 */
  estUncertainty: number;
}

/** Raw row shape returned by the niche_stats view. */
interface NicheStatsRow {
  niche_id: string;
  total_revenue_cents: number;
  total_cost_cents: number;
  total_margin_cents: number;
  experiments_run: number;
  successes: number;
  failures: number;
  est_expected_margin: number;
  est_uncertainty: number;
}

/**
 * Map a raw SQL row to the NicheStats interface.
 */
function mapRow(row: NicheStatsRow): NicheStats {
  return {
    nicheId: row.niche_id,
    totalRevenueCents: row.total_revenue_cents,
    totalCostCents: row.total_cost_cents,
    totalMarginCents: row.total_margin_cents,
    experimentsRun: row.experiments_run,
    successes: row.successes,
    failures: row.failures,
    estExpectedMargin: row.est_expected_margin,
    estUncertainty: row.est_uncertainty,
  };
}

/**
 * Retrieve aggregated stats for all niches.
 * Returns an array of NicheStats, one per niche in the database.
 */
export function getNicheStats(db: Database): NicheStats[] {
  const rows = db
    .prepare("SELECT * FROM niche_stats")
    .all() as NicheStatsRow[];
  return rows.map(mapRow);
}

/**
 * Retrieve aggregated stats for a single niche by ID.
 * Returns null if the niche does not exist.
 */
export function getNicheStatsById(
  db: Database,
  nicheId: string,
): NicheStats | null {
  const row = db
    .prepare("SELECT * FROM niche_stats WHERE niche_id = ?")
    .get(nicheId) as NicheStatsRow | undefined;
  return row ? mapRow(row) : null;
}
