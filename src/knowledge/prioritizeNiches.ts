/**
 * Niche Allocator — Bandit-like Priority Scoring
 *
 * Computes rl_priority for each niche using a UCB-inspired heuristic:
 *   rl_priority = est_expected_margin + alpha * est_uncertainty
 *                 + beta * trend_score + gamma * gap_score + delta * moat_potential
 *
 * Niches with legal_flag = "reject" or ethics_flag = "reject" get rl_priority = 0.
 *
 * The formula balances exploitation (expected margin) with exploration
 * (uncertainty bonus for under-tested niches) and domain signals.
 */

import type BetterSqlite3 from "better-sqlite3";
import { getNicheStats } from "./niche-stats.js";
import type { NicheStats } from "./niche-stats.js";

type Database = BetterSqlite3.Database;

// ── Configuration ────────────────────────────────────────────────

/** Tunable weights for the UCB-inspired priority formula. */
export const PRIORITY_CONFIG = {
  /** Weight for uncertainty bonus (exploration incentive). Higher = more exploration. */
  alpha: 100.0,
  /** Weight for trend_score signal. */
  beta: 50.0,
  /** Weight for gap_score signal. */
  gamma: 30.0,
  /** Weight for moat_potential signal. */
  delta: 20.0,
} as const;

/** Type of the priority configuration object. */
export type PriorityConfig = typeof PRIORITY_CONFIG;

// ── Internal Types ───────────────────────────────────────────────

/** Raw row shape from the niches table for scoring inputs. */
interface NicheRow {
  niche_id: string;
  domain: string;
  description: string;
  trend_score: number;
  gap_score: number;
  moat_potential: number;
  legal_flag: string;
  ethics_flag: string;
}

// ── Main Prioritization ─────────────────────────────────────────

/**
 * Recompute rl_priority for every niche and persist to the database.
 *
 * For each niche:
 * - If legal_flag = "reject" OR ethics_flag = "reject", rl_priority = 0.
 * - Otherwise: rl_priority = est_expected_margin + alpha * est_uncertainty
 *              + beta * trend_score + gamma * gap_score + delta * moat_potential
 *
 * All updates are performed in a single transaction for consistency.
 *
 * @param db - The SQLite database instance.
 * @param config - Optional partial config to override default weights.
 * @returns The number of niches updated and the full priority list (sorted descending).
 */
export function prioritizeNiches(
  db: Database,
  config?: Partial<PriorityConfig>,
): { updated: number; priorities: Array<{ nicheId: string; rlPriority: number }> } {
  const cfg = { ...PRIORITY_CONFIG, ...config };

  // Step 1: Get aggregated stats from the niche_stats view
  const allStats = getNicheStats(db);
  const statsMap = new Map<string, NicheStats>();
  for (const s of allStats) {
    statsMap.set(s.nicheId, s);
  }

  // Step 2: Query all niches for scoring signals
  const niches = db
    .prepare(
      `SELECT niche_id, domain, description, trend_score, gap_score,
              moat_potential, legal_flag, ethics_flag
       FROM niches`,
    )
    .all() as NicheRow[];

  // Step 3: Compute rl_priority for each niche
  const priorities: Array<{ nicheId: string; rlPriority: number }> = [];

  for (const niche of niches) {
    let rlPriority: number;

    if (niche.legal_flag === "reject" || niche.ethics_flag === "reject") {
      rlPriority = 0;
    } else {
      const stats = statsMap.get(niche.niche_id);
      const estExpectedMargin = stats?.estExpectedMargin ?? 0;
      const estUncertainty = stats?.estUncertainty ?? 1.0;

      rlPriority =
        estExpectedMargin +
        cfg.alpha * estUncertainty +
        cfg.beta * niche.trend_score +
        cfg.gamma * niche.gap_score +
        cfg.delta * niche.moat_potential;
    }

    priorities.push({ nicheId: niche.niche_id, rlPriority });
  }

  // Step 4: Batch update in a transaction
  const updateStmt = db.prepare(
    "UPDATE niches SET rl_priority = ?, updated_at = datetime('now') WHERE niche_id = ?",
  );

  const runUpdates = db.transaction(() => {
    for (const p of priorities) {
      updateStmt.run(p.rlPriority, p.nicheId);
    }
  });
  runUpdates();

  // Step 5: Sort descending by rl_priority
  priorities.sort((a, b) => b.rlPriority - a.rlPriority);

  return { updated: priorities.length, priorities };
}

// ── Read Helper ──────────────────────────────────────────────────

/** Row shape for getTopNiches query result. */
interface TopNicheRow {
  niche_id: string;
  domain: string;
  description: string;
  rl_priority: number;
  trend_score: number;
  gap_score: number;
  moat_potential: number;
  legal_flag: string;
}

/**
 * Retrieve the top niches by rl_priority, sorted descending.
 *
 * @param db - The SQLite database instance.
 * @param limit - Maximum number of niches to return (default: 10).
 * @returns Array of top niches with their priority scores and domain signals.
 */
export function getTopNiches(
  db: Database,
  limit: number = 10,
): Array<{
  nicheId: string;
  domain: string;
  description: string;
  rlPriority: number;
  trendScore: number;
  gapScore: number;
  moatPotential: number;
  legalFlag: string;
}> {
  const rows = db
    .prepare(
      `SELECT niche_id, domain, description, rl_priority, trend_score,
              gap_score, moat_potential, legal_flag
       FROM niches
       ORDER BY rl_priority DESC
       LIMIT ?`,
    )
    .all(limit) as TopNicheRow[];

  return rows.map((row) => ({
    nicheId: row.niche_id,
    domain: row.domain,
    description: row.description,
    rlPriority: row.rl_priority,
    trendScore: row.trend_score,
    gapScore: row.gap_score,
    moatPotential: row.moat_potential,
    legalFlag: row.legal_flag,
  }));
}
