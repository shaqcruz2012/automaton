/**
 * Experiment Planner
 *
 * Proposes minimal paid experiments for top-ranked niches. Reads the niches
 * table, scores them by trend * gap * moat, filters out rejected / unethical
 * niches, and creates planned experiments for the top K that don't already
 * have active or planned experiments.
 *
 * Scoring formula:
 *   combined_score = trend_score * gap_score * moat_potential
 *
 * This gives a single scalar that balances market demand (trend), competitive
 * opportunity (gap), and defensibility (moat). All three factors are
 * multiplicative so a zero in any dimension eliminates the niche.
 *
 * MVP generation is currently template-based (STUB). In production this
 * would call an LLM to tailor the spec to the specific niche.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { Experiment, MvpSpec, MvpType, PlanResult } from "./types.js";

type Database = BetterSqlite3.Database;

// ── Internal types for raw DB rows ──────────────────────────────

/** Raw row shape returned from the niches table */
interface NicheRow {
  niche_id: string;
  domain: string;
  subdomain: string;
  user_type: string;
  description: string;
  trend_score: number;
  gap_score: number;
  moat_potential: number;
  ethics_flag: string;
  legal_flag: string;
  sources: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Raw row shape returned from the experiments table */
interface ExperimentRow {
  experiment_id: string;
  niche_id: string;
  status: string;
  mvp_type: string;
  mvp_spec: string;
  budget_credits: number;
  start_ts: string | null;
  end_ts: string | null;
  metrics_json: string;
  created_at: string;
  updated_at: string;
}

// ── MVP Spec Generation (STUB) ─────────────────────────────────

/**
 * STUB: In production, this would call an LLM to generate a tailored MVP spec.
 * For now, uses template-based generation based on domain.
 *
 * Domain mapping:
 *   - "ai" / "devtools"                    -> mvpType "api"       (REST endpoint)
 *   - "saas" / "ecommerce" / "education"   -> mvpType "small_app" (simple web app)
 *   - everything else                      -> mvpType "agent_service" (automated service)
 */
function generateMvpSpec(niche: NicheRow): { mvpType: MvpType; spec: MvpSpec } {
  const domain = niche.domain.toLowerCase();
  const desc = niche.description || `${niche.domain} / ${niche.subdomain}`;

  if (domain === "ai" || domain === "devtools") {
    return {
      mvpType: "api",
      spec: {
        input: `JSON payload describing a ${desc} request`,
        output: `Processed result as JSON response`,
        ux: `REST API endpoint with OpenAPI docs; consumers integrate via HTTP`,
        successCriteria: "3+ paying customers within trial period",
        estimatedBuildHours: 8,
      },
    };
  }

  if (domain === "saas" || domain === "ecommerce" || domain === "education") {
    return {
      mvpType: "small_app",
      spec: {
        input: `User-provided data via web form for ${desc}`,
        output: `Rendered dashboard or downloadable report`,
        ux: `Single-page web app with auth, input form, and results view`,
        successCriteria: "3+ paying customers within trial period",
        estimatedBuildHours: 16,
      },
    };
  }

  // Default: agent_service
  return {
    mvpType: "agent_service",
    spec: {
      input: `Task description or trigger event for ${desc}`,
      output: `Completed task deliverable or status report`,
      ux: `Automated service triggered via webhook or scheduled job; status via API`,
      successCriteria: "3+ paying customers within trial period",
      estimatedBuildHours: 12,
    },
  };
}

// ── Row <-> Domain Conversion ───────────────────────────────────

/** Convert a raw experiment row into the domain Experiment type */
function rowToExperiment(row: ExperimentRow): Experiment {
  return {
    experimentId: row.experiment_id,
    nicheId: row.niche_id,
    status: row.status as Experiment["status"],
    mvpType: row.mvp_type as Experiment["mvpType"],
    mvpSpec: JSON.parse(row.mvp_spec) as MvpSpec,
    budgetCredits: row.budget_credits,
    startTs: row.start_ts ?? undefined,
    endTs: row.end_ts ?? undefined,
    metricsJson: JSON.parse(row.metrics_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Core Planner ────────────────────────────────────────────────

/**
 * Plan experiments for the top-ranked niches that don't already have
 * active or planned experiments.
 *
 * @param db       - better-sqlite3 Database instance
 * @param options  - optional overrides
 *   - topK: how many niches to consider (default 5)
 *   - defaultBudgetCredits: budget per experiment (default 500)
 *   - windowWeeks: experiment duration in weeks (default 2)
 *
 * @returns PlanResult with counts and the experiments created
 */
export function planExperiments(
  db: Database,
  options?: { topK?: number; defaultBudgetCredits?: number; windowWeeks?: number },
): PlanResult {
  const topK = options?.topK ?? 5;
  const budgetCredits = options?.defaultBudgetCredits ?? 500;
  const windowWeeks = options?.windowWeeks ?? 2;

  // ── Step 1: Read niches ranked by combined score ──────────────
  //
  // combined_score = trend_score * gap_score * moat_potential
  //
  // Filters:
  //   - ethics_flag != 'reject'  (allow 'ok' and 'sensitive')
  //   - legal_flag  != 'reject'
  //   - status      != 'rejected'
  //
  // We fetch more than topK to account for niches that already have
  // experiments and will be skipped.
  const fetchLimit = topK * 3;

  const niches = db
    .prepare(
      `SELECT *
       FROM niches
       WHERE ethics_flag != 'reject'
         AND legal_flag  != 'reject'
         AND status      != 'rejected'
       ORDER BY (trend_score * gap_score * moat_potential) DESC
       LIMIT ?`,
    )
    .all(fetchLimit) as NicheRow[];

  // ── Step 2: Filter to niches without active/planned experiments ─
  const hasActiveExperiment = db.prepare(
    `SELECT COUNT(*) as cnt FROM experiments WHERE niche_id = ? AND status IN ('planned', 'running')`,
  );

  const planned: Experiment[] = [];
  let skipped = 0;

  // ── Step 3: For each qualifying niche, generate and insert ────
  const now = new Date();
  const startTs = now.toISOString().replace("T", " ").slice(0, 19); // SQLite datetime format
  const endDate = new Date(now.getTime() + windowWeeks * 7 * 24 * 60 * 60 * 1000);
  const endTs = endDate.toISOString().replace("T", " ").slice(0, 19);

  const insertStmt = db.prepare(
    `INSERT INTO experiments (experiment_id, niche_id, status, mvp_type, mvp_spec, budget_credits, start_ts, end_ts, metrics_json)
     VALUES (?, ?, 'planned', ?, ?, ?, ?, ?, '{}')`,
  );

  for (const niche of niches) {
    if (planned.length >= topK) break;

    // Check if this niche already has an active or planned experiment
    const row = hasActiveExperiment.get(niche.niche_id) as { cnt: number };
    if (row.cnt > 0) {
      skipped++;
      continue;
    }

    // STUB: Generate MVP spec using template-based logic
    const { mvpType, spec } = generateMvpSpec(niche);

    const experimentId = ulid();
    const mvpSpecJson = JSON.stringify(spec);

    insertStmt.run(experimentId, niche.niche_id, mvpType, mvpSpecJson, budgetCredits, startTs, endTs);

    planned.push({
      experimentId,
      nicheId: niche.niche_id,
      status: "planned",
      mvpType,
      mvpSpec: spec,
      budgetCredits,
      startTs,
      endTs,
      metricsJson: {},
      createdAt: startTs, // approximate; DB default will be slightly different
      updatedAt: startTs,
    });
  }

  return {
    planned: planned.length,
    skipped,
    experiments: planned,
  };
}

// ── Query Helpers ───────────────────────────────────────────────

/**
 * Get all experiments associated with a specific niche.
 */
export function getExperimentsByNiche(db: Database, nicheId: string): Experiment[] {
  const rows = db
    .prepare(`SELECT * FROM experiments WHERE niche_id = ? ORDER BY created_at DESC`)
    .all(nicheId) as ExperimentRow[];

  return rows.map(rowToExperiment);
}

/**
 * Get all currently active experiments (status = 'planned' or 'running').
 */
export function getActiveExperiments(db: Database): Experiment[] {
  const rows = db
    .prepare(`SELECT * FROM experiments WHERE status IN ('planned', 'running') ORDER BY created_at DESC`)
    .all() as ExperimentRow[];

  return rows.map(rowToExperiment);
}
