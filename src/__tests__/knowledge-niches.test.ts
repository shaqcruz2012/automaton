/**
 * Knowledge — Niche Management Unit Tests
 *
 * Covers:
 *   prioritizeNiches()       — UCB-inspired rl_priority computation + DB persistence
 *   getTopNiches()           — Reads ranked niches from the DB
 *   getNicheStats()          — Aggregated stats for all niches (via view)
 *   getNicheStatsById()      — Per-niche lookup
 *   initNicheStatsView()     — View creation (idempotent)
 *   updateNichesFromBatch()  — YC/HN item classification, scoring, upsert
 *   PRIORITY_CONFIG          — Exported weight constants
 *
 * All database and external I/O calls are mocked. No real SQLite instance is
 * used, keeping tests fast and fully isolated.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database, Statement } from "better-sqlite3";

// ── Mocks (declared before imports of modules under test) ──────────────────

vi.mock("../observability/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../policy/legal.js", () => ({
  evaluateNicheLegalRisk: vi.fn(),
}));

vi.mock("../tools/web-search.js", () => ({
  webSearch: vi.fn(),
  resolvePerplexityApiKey: vi.fn(),
}));

vi.mock("ulid", () => ({
  ulid: vi.fn(() => "01HZFAKEULID0000000000001"),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import {
  prioritizeNiches,
  getTopNiches,
  PRIORITY_CONFIG,
} from "../knowledge/prioritizeNiches.js";

import {
  getNicheStats,
  getNicheStatsById,
  initNicheStatsView,
} from "../knowledge/niche-stats.js";

import {
  updateNichesFromBatch,
  enrichNicheWithWebSearch,
} from "../knowledge/updateNiches.js";

import { initNicheSchema } from "../knowledge/niche-schema.js";

import { evaluateNicheLegalRisk } from "../policy/legal.js";
import { resolvePerplexityApiKey, webSearch } from "../tools/web-search.js";

// ── Typed mock references ──────────────────────────────────────────────────

const mockEvaluateNicheLegalRisk = vi.mocked(evaluateNicheLegalRisk);
const mockResolvePerplexityApiKey = vi.mocked(resolvePerplexityApiKey);
const mockWebSearch = vi.mocked(webSearch);

// ── DB mock factory ────────────────────────────────────────────────────────

/**
 * Build a minimal better-sqlite3 Database mock.
 * Callers can override `prepareImpl` to control what `.prepare().all/get/run`
 * returns for a given SQL string.
 */
function makeMockDb(prepareImpl?: (sql: string) => Partial<Statement>): Database {
  const defaultStatement: Partial<Statement> = {
    all: vi.fn(() => []),
    get: vi.fn(() => undefined),
    run: vi.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
  };

  const transactionFn = vi.fn((fn: () => void) => {
    return () => fn();
  });

  const db = {
    prepare: vi.fn((sql: string) => {
      if (prepareImpl) {
        return { ...defaultStatement, ...prepareImpl(sql) };
      }
      return defaultStatement;
    }),
    exec: vi.fn(),
    transaction: transactionFn,
  } as unknown as Database;

  return db;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A raw row from the niche_stats view. */
function makeStatsRow(overrides: Partial<{
  niche_id: string;
  total_revenue_cents: number;
  total_cost_cents: number;
  total_margin_cents: number;
  experiments_run: number;
  successes: number;
  failures: number;
  est_expected_margin: number;
  est_uncertainty: number;
}> = {}) {
  return {
    niche_id: "niche-1",
    total_revenue_cents: 10000,
    total_cost_cents: 4000,
    total_margin_cents: 6000,
    experiments_run: 3,
    successes: 2,
    failures: 1,
    est_expected_margin: 2000,
    est_uncertainty: 0.25,
    ...overrides,
  };
}

/** A raw row from the niches table (for prioritizeNiches queries). */
function makeNicheRow(overrides: Partial<{
  niche_id: string;
  domain: string;
  description: string;
  trend_score: number;
  gap_score: number;
  moat_potential: number;
  legal_flag: string;
  ethics_flag: string;
}> = {}) {
  return {
    niche_id: "niche-1",
    domain: "saas",
    description: "B2B SaaS tool",
    trend_score: 0.7,
    gap_score: 0.5,
    moat_potential: 0.4,
    legal_flag: "ok",
    ethics_flag: "ok",
    ...overrides,
  };
}

/** A raw row for getTopNiches queries. */
function makeTopNicheRow(overrides: Partial<{
  niche_id: string;
  domain: string;
  description: string;
  rl_priority: number;
  trend_score: number;
  gap_score: number;
  moat_potential: number;
  legal_flag: string;
}> = {}) {
  return {
    niche_id: "niche-1",
    domain: "saas",
    description: "B2B SaaS tool",
    rl_priority: 150.0,
    trend_score: 0.7,
    gap_score: 0.5,
    moat_potential: 0.4,
    legal_flag: "ok",
    ...overrides,
  };
}

// =============================================================================
// prioritizeNiches()
// =============================================================================

describe("prioritizeNiches()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Empty niches table ───────────────────────────────────────────────────

  it("returns updated=0 and empty priorities when there are no niches", () => {
    const db = makeMockDb(() => ({
      all: vi.fn(() => []),
    }));

    const result = prioritizeNiches(db);

    expect(result.updated).toBe(0);
    expect(result.priorities).toEqual([]);
  });

  // ── 2. Basic formula correctness ───────────────────────────────────────────

  it("computes rl_priority = margin + alpha*uncertainty + beta*trend + gamma*gap + delta*moat", () => {
    const nicheRow = makeNicheRow({
      niche_id: "n1",
      trend_score: 0.8,
      gap_score: 0.6,
      moat_potential: 0.5,
      legal_flag: "ok",
      ethics_flag: "ok",
    });

    const statsRow = makeStatsRow({
      niche_id: "n1",
      est_expected_margin: 500,
      est_uncertainty: 0.5,
    });

    let callCount = 0;
    const db = makeMockDb((sql) => {
      if (sql.includes("niche_stats")) {
        return { all: vi.fn(() => [statsRow]) };
      }
      if (sql.includes("FROM niches")) {
        return { all: vi.fn(() => [nicheRow]) };
      }
      callCount++;
      return { run: vi.fn() };
    });

    const result = prioritizeNiches(db);

    // Expected:
    //   500 + 100*0.5 + 50*0.8 + 30*0.6 + 20*0.5
    //   = 500 + 50 + 40 + 18 + 10 = 618
    expect(result.priorities).toHaveLength(1);
    expect(result.priorities[0].nicheId).toBe("n1");
    expect(result.priorities[0].rlPriority).toBeCloseTo(618, 1);
  });

  // ── 3. Rejected by legal_flag ──────────────────────────────────────────────

  it("sets rl_priority to 0 when legal_flag is 'reject'", () => {
    const nicheRow = makeNicheRow({
      niche_id: "n-reject",
      legal_flag: "reject",
      ethics_flag: "ok",
    });

    const db = makeMockDb((sql) => {
      if (sql.includes("niche_stats")) {
        return { all: vi.fn(() => []) };
      }
      if (sql.includes("FROM niches")) {
        return { all: vi.fn(() => [nicheRow]) };
      }
      return { run: vi.fn() };
    });

    const result = prioritizeNiches(db);

    expect(result.priorities[0].rlPriority).toBe(0);
  });

  // ── 4. Rejected by ethics_flag ─────────────────────────────────────────────

  it("sets rl_priority to 0 when ethics_flag is 'reject'", () => {
    const nicheRow = makeNicheRow({
      niche_id: "n-ethics",
      legal_flag: "ok",
      ethics_flag: "reject",
    });

    const db = makeMockDb((sql) => {
      if (sql.includes("niche_stats")) {
        return { all: vi.fn(() => []) };
      }
      if (sql.includes("FROM niches")) {
        return { all: vi.fn(() => [nicheRow]) };
      }
      return { run: vi.fn() };
    });

    const result = prioritizeNiches(db);

    expect(result.priorities[0].rlPriority).toBe(0);
  });

  // ── 5. Default uncertainty of 1.0 when no stats ────────────────────────────

  it("uses estUncertainty=1.0 (maximum exploration) when no stats exist for a niche", () => {
    const nicheRow = makeNicheRow({
      niche_id: "n-no-stats",
      trend_score: 0,
      gap_score: 0,
      moat_potential: 0,
      legal_flag: "ok",
      ethics_flag: "ok",
    });

    const db = makeMockDb((sql) => {
      if (sql.includes("niche_stats")) {
        return { all: vi.fn(() => []) }; // no stats for this niche
      }
      if (sql.includes("FROM niches")) {
        return { all: vi.fn(() => [nicheRow]) };
      }
      return { run: vi.fn() };
    });

    const result = prioritizeNiches(db);

    // rl_priority = 0 + 100*1.0 + 0 + 0 + 0 = 100
    expect(result.priorities[0].rlPriority).toBeCloseTo(100, 1);
  });

  // ── 6. Results are sorted descending by rl_priority ────────────────────────

  it("returns priorities sorted descending by rl_priority", () => {
    const niches = [
      makeNicheRow({ niche_id: "low",  trend_score: 0.1, gap_score: 0.1, moat_potential: 0.1 }),
      makeNicheRow({ niche_id: "high", trend_score: 0.9, gap_score: 0.9, moat_potential: 0.9 }),
      makeNicheRow({ niche_id: "mid",  trend_score: 0.5, gap_score: 0.5, moat_potential: 0.5 }),
    ];

    const db = makeMockDb((sql) => {
      if (sql.includes("niche_stats")) {
        return { all: vi.fn(() => []) };
      }
      if (sql.includes("FROM niches")) {
        return { all: vi.fn(() => niches) };
      }
      return { run: vi.fn() };
    });

    const result = prioritizeNiches(db);

    const scores = result.priorities.map((p) => p.rlPriority);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  // ── 7. updated count equals number of niches ───────────────────────────────

  it("returns updated count equal to the number of niches processed", () => {
    const niches = [
      makeNicheRow({ niche_id: "a" }),
      makeNicheRow({ niche_id: "b" }),
      makeNicheRow({ niche_id: "c" }),
    ];

    const db = makeMockDb((sql) => {
      if (sql.includes("niche_stats")) {
        return { all: vi.fn(() => []) };
      }
      if (sql.includes("FROM niches")) {
        return { all: vi.fn(() => niches) };
      }
      return { run: vi.fn() };
    });

    const result = prioritizeNiches(db);

    expect(result.updated).toBe(3);
  });

  // ── 8. Custom config overrides defaults ────────────────────────────────────

  it("applies a custom alpha weight when provided via config override", () => {
    const nicheRow = makeNicheRow({
      niche_id: "cfg",
      trend_score: 0,
      gap_score: 0,
      moat_potential: 0,
      legal_flag: "ok",
      ethics_flag: "ok",
    });

    const db = makeMockDb((sql) => {
      if (sql.includes("niche_stats")) {
        return {
          all: vi.fn(() => [makeStatsRow({
            niche_id: "cfg",
            est_expected_margin: 0,
            est_uncertainty: 1.0,
          })]),
        };
      }
      if (sql.includes("FROM niches")) {
        return { all: vi.fn(() => [nicheRow]) };
      }
      return { run: vi.fn() };
    });

    const result = prioritizeNiches(db, { alpha: 200 });

    // rl_priority = 0 + 200*1.0 = 200
    expect(result.priorities[0].rlPriority).toBeCloseTo(200, 1);
  });

  // ── 9. PRIORITY_CONFIG exports the default weights ─────────────────────────

  it("exports PRIORITY_CONFIG with the expected default weights", () => {
    expect(PRIORITY_CONFIG.alpha).toBe(100.0);
    expect(PRIORITY_CONFIG.beta).toBe(50.0);
    expect(PRIORITY_CONFIG.gamma).toBe(30.0);
    expect(PRIORITY_CONFIG.delta).toBe(20.0);
  });

  // ── 10. DB transaction is used for all updates ─────────────────────────────

  it("wraps priority updates inside a single DB transaction", () => {
    const niches = [
      makeNicheRow({ niche_id: "t1" }),
      makeNicheRow({ niche_id: "t2" }),
    ];

    const db = makeMockDb((sql) => {
      if (sql.includes("niche_stats")) return { all: vi.fn(() => []) };
      if (sql.includes("FROM niches")) return { all: vi.fn(() => niches) };
      return { run: vi.fn() };
    });

    prioritizeNiches(db);

    expect(db.transaction).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// getTopNiches()
// =============================================================================

describe("getTopNiches()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 11. Returns mapped results ─────────────────────────────────────────────

  it("maps DB rows to the expected output shape", () => {
    const row = makeTopNicheRow({
      niche_id: "top-1",
      domain: "ai",
      description: "AI-powered coding assistant",
      rl_priority: 250.0,
      trend_score: 0.9,
      gap_score: 0.7,
      moat_potential: 0.8,
      legal_flag: "ok",
    });

    const db = makeMockDb(() => ({
      all: vi.fn(() => [row]),
    }));

    const results = getTopNiches(db, 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      nicheId: "top-1",
      domain: "ai",
      description: "AI-powered coding assistant",
      rlPriority: 250.0,
      trendScore: 0.9,
      gapScore: 0.7,
      moatPotential: 0.8,
      legalFlag: "ok",
    });
  });

  // ── 12. Default limit is 10 ────────────────────────────────────────────────

  it("uses a default limit of 10 when none is specified", () => {
    const preparedAllMock = vi.fn(() => []);
    const db = makeMockDb(() => ({
      all: preparedAllMock,
    }));

    getTopNiches(db);

    expect(preparedAllMock).toHaveBeenCalledWith(10);
  });

  // ── 13. Returns empty array for empty table ─────────────────────────────────

  it("returns an empty array when the table has no rows", () => {
    const db = makeMockDb(() => ({
      all: vi.fn(() => []),
    }));

    const results = getTopNiches(db, 5);

    expect(results).toEqual([]);
  });
});

// =============================================================================
// getNicheStats() and getNicheStatsById()
// =============================================================================

describe("getNicheStats()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 14. Maps all rows to NicheStats ────────────────────────────────────────

  it("maps all niche_stats view rows to NicheStats objects", () => {
    const row = makeStatsRow({
      niche_id: "n-stats",
      total_revenue_cents: 5000,
      total_cost_cents: 2000,
      total_margin_cents: 3000,
      experiments_run: 4,
      successes: 3,
      failures: 1,
      est_expected_margin: 750,
      est_uncertainty: 0.2,
    });

    const db = makeMockDb(() => ({
      all: vi.fn(() => [row]),
    }));

    const stats = getNicheStats(db);

    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({
      nicheId: "n-stats",
      totalRevenueCents: 5000,
      totalCostCents: 2000,
      totalMarginCents: 3000,
      experimentsRun: 4,
      successes: 3,
      failures: 1,
      estExpectedMargin: 750,
      estUncertainty: 0.2,
    });
  });

  // ── 15. Returns empty array when no rows exist ─────────────────────────────

  it("returns an empty array when the view has no rows", () => {
    const db = makeMockDb(() => ({
      all: vi.fn(() => []),
    }));

    const stats = getNicheStats(db);

    expect(stats).toEqual([]);
  });

  // ── 16. Maps multiple rows ─────────────────────────────────────────────────

  it("maps multiple rows, preserving order", () => {
    const rows = [
      makeStatsRow({ niche_id: "a", total_revenue_cents: 100 }),
      makeStatsRow({ niche_id: "b", total_revenue_cents: 200 }),
      makeStatsRow({ niche_id: "c", total_revenue_cents: 300 }),
    ];

    const db = makeMockDb(() => ({
      all: vi.fn(() => rows),
    }));

    const stats = getNicheStats(db);

    expect(stats).toHaveLength(3);
    expect(stats.map((s) => s.nicheId)).toEqual(["a", "b", "c"]);
    expect(stats.map((s) => s.totalRevenueCents)).toEqual([100, 200, 300]);
  });
});

describe("getNicheStatsById()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 17. Returns mapped row for existing niche ──────────────────────────────

  it("returns NicheStats for a niche that exists", () => {
    const row = makeStatsRow({ niche_id: "existing" });

    const db = makeMockDb(() => ({
      get: vi.fn(() => row),
    }));

    const stats = getNicheStatsById(db, "existing");

    expect(stats).not.toBeNull();
    expect(stats!.nicheId).toBe("existing");
  });

  // ── 18. Returns null for missing niche ─────────────────────────────────────

  it("returns null when the niche_id does not exist in the view", () => {
    const db = makeMockDb(() => ({
      get: vi.fn(() => undefined),
    }));

    const stats = getNicheStatsById(db, "nonexistent");

    expect(stats).toBeNull();
  });
});

// =============================================================================
// initNicheStatsView()
// =============================================================================

describe("initNicheStatsView()", () => {
  it("calls db.exec once to create the view", () => {
    const db = makeMockDb();

    initNicheStatsView(db);

    expect(db.exec).toHaveBeenCalledOnce();
    expect((db.exec as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      "CREATE VIEW IF NOT EXISTS niche_stats",
    );
  });
});

// =============================================================================
// initNicheSchema()
// =============================================================================

describe("initNicheSchema()", () => {
  it("calls db.exec to create the niches table and indexes", () => {
    const db = makeMockDb();

    initNicheSchema(db);

    // exec is called for the main schema, and ALTER TABLE may throw (caught internally)
    expect(db.exec).toHaveBeenCalled();
    const firstCall = (db.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(firstCall).toContain("CREATE TABLE IF NOT EXISTS niches");
  });

  it("is idempotent — calling twice does not throw", () => {
    const db = makeMockDb();

    expect(() => {
      initNicheSchema(db);
      initNicheSchema(db);
    }).not.toThrow();
  });
});

// =============================================================================
// updateNichesFromBatch()
// =============================================================================

describe("updateNichesFromBatch()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default legal screening: return "ok" for all niches
    mockEvaluateNicheLegalRisk.mockReturnValue({ flag: "ok", reasons: [] });
  });

  // ── 19. Empty inputs produce no DB writes ─────────────────────────────────

  it("returns created=0, updated=0, rejected=0 for empty YC and HN inputs", () => {
    const db = makeMockDb();

    const result = updateNichesFromBatch(db, [], []);

    expect(result).toEqual({ created: 0, updated: 0, rejected: 0 });
  });

  // ── 20. New YC item is inserted as created ─────────────────────────────────

  it("increments created count for a new YC item not in the DB", () => {
    const findExistingGet = vi.fn(() => undefined); // no existing row
    const upsertRun = vi.fn();

    const db = makeMockDb((sql) => {
      if (sql.includes("SELECT niche_id FROM niches")) {
        return { get: findExistingGet };
      }
      return { run: upsertRun };
    });

    const result = updateNichesFromBatch(
      db,
      [{ name: "AI Startup", description: "Machine learning platform for developers", tags: ["ai", "ml"] }],
      [],
    );

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.rejected).toBe(0);
  });

  // ── 21. Existing domain+subdomain is updated, not created ─────────────────

  it("increments updated count when domain+subdomain already exists in DB", () => {
    const findExistingGet = vi.fn(() => ({ niche_id: "existing-id" }));
    const upsertRun = vi.fn();

    const db = makeMockDb((sql) => {
      if (sql.includes("SELECT niche_id FROM niches")) {
        return { get: findExistingGet };
      }
      return { run: upsertRun };
    });

    const result = updateNichesFromBatch(
      db,
      [{ name: "DevTools Corp", description: "Developer tools SDK and CLI", tags: ["dev tools"] }],
      [],
    );

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
  });

  // ── 22. Legal reject flag increments rejected count ───────────────────────

  it("increments rejected count when evaluateNicheLegalRisk returns 'reject'", () => {
    mockEvaluateNicheLegalRisk.mockReturnValue({
      flag: "reject",
      reasons: ["Prohibited keyword detected: \"gambling\""],
    });

    const findExistingGet = vi.fn(() => undefined);
    const upsertRun = vi.fn();

    const db = makeMockDb((sql) => {
      if (sql.includes("SELECT niche_id FROM niches")) {
        return { get: findExistingGet };
      }
      return { run: upsertRun };
    });

    const result = updateNichesFromBatch(
      db,
      [{ name: "Casino Platform", description: "Online casino games", tags: ["gambling"] }],
      [],
    );

    expect(result.rejected).toBe(1);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  // ── 23. HN item with no matching keywords falls back to 'general' domain ──

  it("classifies HN items with no matching keywords as 'general' domain", () => {
    const capturedUpsertArgs: unknown[][] = [];
    const upsertRun = vi.fn((...args: unknown[]) => capturedUpsertArgs.push(args));
    const findExistingGet = vi.fn(() => undefined);

    const db = makeMockDb((sql) => {
      if (sql.includes("SELECT niche_id FROM niches")) {
        return { get: findExistingGet };
      }
      return { run: upsertRun };
    });

    updateNichesFromBatch(
      db,
      [],
      [{ title: "Interesting Unclassifiable News Story", points: 42 }],
    );

    // The upsert should have been called with domain = 'general'
    expect(upsertRun).toHaveBeenCalled();
    const firstCallArgs = capturedUpsertArgs[0] as string[];
    expect(firstCallArgs[1]).toBe("general"); // domain is second positional arg
  });

  // ── 24. YC items with health keywords are classified as 'health' domain ───

  it("classifies YC items containing health keywords as 'health' domain", () => {
    const capturedArgs: unknown[][] = [];
    const upsertRun = vi.fn((...args: unknown[]) => capturedArgs.push(args));
    const findExistingGet = vi.fn(() => undefined);

    const db = makeMockDb((sql) => {
      if (sql.includes("SELECT niche_id FROM niches")) {
        return { get: findExistingGet };
      }
      return { run: upsertRun };
    });

    updateNichesFromBatch(
      db,
      [{ name: "MedTech", description: "Health monitoring platform for patients", tags: ["medical"] }],
      [],
    );

    expect(upsertRun).toHaveBeenCalled();
    const firstCallArgs = capturedArgs[0] as string[];
    expect(firstCallArgs[1]).toBe("health"); // domain
  });

  // ── 25. Uses a DB transaction for all upserts ──────────────────────────────

  it("wraps all upserts in a single DB transaction", () => {
    const db = makeMockDb((sql) => {
      if (sql.includes("SELECT niche_id FROM niches")) {
        return { get: vi.fn(() => undefined) };
      }
      return { run: vi.fn() };
    });

    updateNichesFromBatch(
      db,
      [
        { name: "AI Tool A", description: "Machine learning SDK", tags: ["ai"] },
        { name: "AI Tool B", description: "LLM-powered assistant", tags: ["llm"] },
      ],
      [],
    );

    expect(db.transaction).toHaveBeenCalledOnce();
  });

  // ── 26. Multiple items from the same domain are merged into one candidate ──

  it("merges multiple YC items with the same domain+subdomain into a single DB row", () => {
    const upsertRun = vi.fn();
    const findExistingGet = vi.fn(() => undefined);

    const db = makeMockDb((sql) => {
      if (sql.includes("SELECT niche_id FROM niches")) {
        return { get: findExistingGet };
      }
      return { run: upsertRun };
    });

    updateNichesFromBatch(
      db,
      [
        { name: "AI Startup A", description: "Machine learning pipeline", tags: ["ai"] },
        { name: "AI Startup B", description: "AI model training platform", tags: ["ai"] },
      ],
      [],
    );

    // Both map to ai::ml — only one candidate → one upsert
    expect(upsertRun).toHaveBeenCalledTimes(1);
    const result = updateNichesFromBatch(db, [
      { name: "AI Startup A", description: "Machine learning pipeline", tags: ["ai"] },
      { name: "AI Startup B", description: "AI model training platform", tags: ["ai"] },
    ], []);
    expect(result.created).toBe(1);
  });
});

// =============================================================================
// enrichNicheWithWebSearch()
// =============================================================================

describe("enrichNicheWithWebSearch()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 27. Returns empty enrichment when no API key is configured ─────────────

  it("returns ok:false enrichment when no Perplexity API key is configured", async () => {
    mockResolvePerplexityApiKey.mockReturnValue(undefined);

    const result = await enrichNicheWithWebSearch({ name: "AI Tools", domain: "ai" });

    expect(result.ok).toBe(false);
    expect(result.marketSize).toBe("");
    expect(result.competition).toBe("");
    expect(result.trends).toBe("");
    expect(result.sources).toEqual([]);
    expect(mockWebSearch).not.toHaveBeenCalled();
  });

  // ── 28. Returns enrichment on successful web search ────────────────────────

  it("returns structured enrichment when web search succeeds", async () => {
    mockResolvePerplexityApiKey.mockReturnValue("pplx-test-key");
    mockWebSearch.mockResolvedValue({
      ok: true,
      answer:
        "Market Size: The AI tools market is valued at $12B globally. " +
        "Competition: Key players include OpenAI, Anthropic, and Google. " +
        "Trends: Rapid adoption in enterprise software development.",
      sources: ["https://example.com/report1", "https://example.com/report2"],
    });

    const result = await enrichNicheWithWebSearch({ name: "AI Tools", domain: "ai" });

    expect(result.ok).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(typeof result.marketSize).toBe("string");
    expect(typeof result.competition).toBe("string");
    expect(typeof result.trends).toBe("string");
  });

  // ── 29. Returns ok:false when web search fails ─────────────────────────────

  it("returns ok:false when webSearch returns ok:false", async () => {
    mockResolvePerplexityApiKey.mockReturnValue("pplx-test-key");
    mockWebSearch.mockResolvedValue({
      ok: false,
      answer: "",
      sources: [],
      error: "API rate limit exceeded",
    });

    const result = await enrichNicheWithWebSearch({ name: "Fintech", domain: "finance" });

    expect(result.ok).toBe(false);
    expect(result.marketSize).toBe("");
  });
});
