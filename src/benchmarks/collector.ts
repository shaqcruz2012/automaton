/**
 * Benchmark Collector & Report Generator
 *
 * Queries the automaton's SQLite database to collect performance,
 * financial, and health metrics, then generates a Markdown report
 * with trend analysis and bottleneck detection.
 */

import type BetterSqlite3 from "better-sqlite3";
import fs from "fs";

type Database = BetterSqlite3.Database;

// ── Types ────────────────────────────────────────────────────────

export interface TokenEconomics {
  readonly totalTurns: number;
  readonly totalTokens: number;
  readonly avgTokensPerTurn: number;
  readonly tokensPerMinute: number;
  readonly windowMinutes: number;
}

export interface FinancialHealth {
  readonly usdcBalance: number;
  readonly revenueLast24hCents: number;
  readonly expensesLast24hCents: number;
  readonly netPnlCents: number;
  readonly burnRate7dCentsPerDay: number;
  readonly survivalTier: string;
}

export interface ProviderLatency {
  readonly provider: string;
  readonly avgLatencyMs: number;
  readonly callCount: number;
}

export interface ProviderCostPer1k {
  readonly provider: string;
  readonly costPer1kTokensCents: number;
}

export interface ModelUsage {
  readonly model: string;
  readonly count: number;
  readonly pct: number;
}

export interface InferencePerformance {
  readonly avgLatencyByProvider: readonly ProviderLatency[];
  readonly cacheHitRate: number;
  readonly costPer1kByProvider: readonly ProviderCostPer1k[];
  readonly cascadeFallbackRate: number;
  readonly modelUsageDistribution: readonly ModelUsage[];
}

export interface TaskDuration {
  readonly taskName: string;
  readonly avgDurationMs: number;
}

export interface HeartbeatReliability {
  readonly totalRuns: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly successRate: number;
  readonly avgDurationByTask: readonly TaskDuration[];
  readonly failedTasks: readonly string[];
}

export interface GoalProgress {
  readonly activeGoals: number;
  readonly completionPct: number;
  readonly tasksCompleted: number;
  readonly tasksPending: number;
  readonly tasksFailed: number;
}

export interface SystemHealth {
  readonly uptimeSeconds: number;
  readonly activeAlerts: readonly string[];
  readonly contextTokenUsage: number;
}

export interface BenchmarkSnapshot {
  readonly collectedAt: string;
  readonly tokenEconomics: TokenEconomics;
  readonly financialHealth: FinancialHealth;
  readonly inferencePerformance: InferencePerformance;
  readonly heartbeatReliability: HeartbeatReliability;
  readonly goalProgress: GoalProgress;
  readonly systemHealth: SystemHealth;
}

// ── Bottleneck Detection ─────────────────────────────────────────

export interface Bottleneck {
  readonly id: string;
  readonly severity: "warning" | "critical";
  readonly message: string;
  readonly recommendation: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function safeGet<T>(db: Database, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

function safeAll<T>(db: Database, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function minutesAgoISO(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function hoursAgoISO(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function safeDivide(numerator: number, denominator: number, fallback = 0): number {
  return denominator > 0 ? numerator / denominator : fallback;
}

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

// ── Token Economics ──────────────────────────────────────────────

function collectTokenEconomics(db: Database, windowMinutes: number = 10): TokenEconomics {
  const since = minutesAgoISO(windowMinutes);

  const row = safeGet<{ cnt: number; total_tokens: number }>(
    db,
    `SELECT
       COUNT(*) as cnt,
       COALESCE(SUM(
         COALESCE(json_extract(token_usage, '$.prompt_tokens'), 0) +
         COALESCE(json_extract(token_usage, '$.completion_tokens'), 0)
       ), 0) as total_tokens
     FROM turns
     WHERE timestamp >= ?`,
    since,
  );

  const totalTurns = row?.cnt ?? 0;
  const totalTokens = row?.total_tokens ?? 0;
  const avgTokensPerTurn = roundTo(safeDivide(totalTokens, totalTurns), 1);
  const tokensPerMinute = roundTo(safeDivide(totalTokens, windowMinutes), 1);

  return { totalTurns, totalTokens, avgTokensPerTurn, tokensPerMinute, windowMinutes };
}

// ── Financial Health ─────────────────────────────────────────────

function collectFinancialHealth(db: Database): FinancialHealth {
  // USDC balance from KV financial_state
  let usdcBalance = 0;
  let survivalTier = "unknown";

  const financialRaw = safeGet<{ value: string }>(
    db,
    `SELECT value FROM kv WHERE key = ?`,
    "financial_state",
  );
  if (financialRaw) {
    try {
      const parsed = JSON.parse(financialRaw.value);
      usdcBalance = typeof parsed.usdcBalance === "number" ? parsed.usdcBalance : 0;
    } catch {
      // malformed JSON — default to 0
    }
  }

  // Survival tier from KV
  const tierRaw = safeGet<{ value: string }>(
    db,
    `SELECT value FROM kv WHERE key = ?`,
    "survival_tier",
  );
  survivalTier = tierRaw?.value ?? "unknown";

  // Revenue last 24h
  const since24h = hoursAgoISO(24);
  const revRow = safeGet<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(amount_cents), 0) as total FROM revenue_events WHERE created_at >= ?`,
    since24h,
  );
  const revenueLast24hCents = revRow?.total ?? 0;

  // Expenses last 24h
  const expRow = safeGet<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(amount_cents), 0) as total FROM expense_events WHERE created_at >= ?`,
    since24h,
  );
  const expensesLast24hCents = expRow?.total ?? 0;

  // 7-day burn rate
  const since7d = daysAgoISO(7);
  const burnRow = safeGet<{ total: number; days: number }>(
    db,
    `SELECT
       COALESCE(SUM(amount_cents), 0) as total,
       MAX(COUNT(DISTINCT date(created_at)), 1) as days
     FROM expense_events WHERE created_at >= ?`,
    since7d,
  );
  const burnTotal = burnRow?.total ?? 0;
  const burnDays = burnRow?.days ?? 1;
  const burnRate7dCentsPerDay = Math.ceil(safeDivide(burnTotal, Math.max(burnDays, 1)));

  return {
    usdcBalance,
    revenueLast24hCents,
    expensesLast24hCents,
    netPnlCents: revenueLast24hCents - expensesLast24hCents,
    burnRate7dCentsPerDay,
    survivalTier,
  };
}

// ── Inference Performance ────────────────────────────────────────

function collectInferencePerformance(db: Database, windowMinutes: number = 10): InferencePerformance {
  const since = minutesAgoISO(windowMinutes);

  // Avg latency by provider
  const latencyRows = safeAll<{ provider: string; avg_lat: number; cnt: number }>(
    db,
    `SELECT provider, AVG(latency_ms) as avg_lat, COUNT(*) as cnt
     FROM inference_costs WHERE created_at >= ?
     GROUP BY provider`,
    since,
  );
  const avgLatencyByProvider: ProviderLatency[] = latencyRows.map((r) => ({
    provider: r.provider,
    avgLatencyMs: roundTo(r.avg_lat, 1),
    callCount: r.cnt,
  }));

  // Cache hit rate
  const cacheRow = safeGet<{ total: number; hits: number }>(
    db,
    `SELECT COUNT(*) as total, COALESCE(SUM(cache_hit), 0) as hits
     FROM inference_costs WHERE created_at >= ?`,
    since,
  );
  const cacheHitRate = roundTo(
    safeDivide((cacheRow?.hits ?? 0), (cacheRow?.total ?? 0)) * 100,
    1,
  );

  // Cost per 1K tokens by provider
  const costRows = safeAll<{ provider: string; total_cost: number; total_tokens: number }>(
    db,
    `SELECT provider,
       COALESCE(SUM(cost_cents), 0) as total_cost,
       COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
     FROM inference_costs WHERE created_at >= ?
     GROUP BY provider`,
    since,
  );
  const costPer1kByProvider: ProviderCostPer1k[] = costRows.map((r) => ({
    provider: r.provider,
    costPer1kTokensCents: roundTo(safeDivide(r.total_cost * 1000, r.total_tokens), 4),
  }));

  // Cascade fallback rate: count inference calls where the tier column
  // indicates the call was NOT on the first pool in the cascade order.
  // We approximate this by checking if the provider belongs to a non-primary pool.
  // Since pool info isn't stored directly, we use a heuristic:
  // free_cloud providers (mistral, groq-free) or local (ollama) succeeding
  // when the tier suggests paid should have been used, indicates a fallback.
  // Simpler approach: count distinct (turn_id, tier) groups with >1 inference call
  // as a proxy for fallbacks.
  const fallbackRow = safeGet<{ total_turns: number; multi_call_turns: number }>(
    db,
    `SELECT
       COUNT(DISTINCT turn_id) as total_turns,
       (SELECT COUNT(*) FROM (
         SELECT turn_id FROM inference_costs
         WHERE created_at >= ? AND turn_id IS NOT NULL
         GROUP BY turn_id
         HAVING COUNT(DISTINCT provider) > 1
       )) as multi_call_turns
     FROM inference_costs
     WHERE created_at >= ? AND turn_id IS NOT NULL`,
    since,
    since,
  );
  const cascadeFallbackRate = roundTo(
    safeDivide((fallbackRow?.multi_call_turns ?? 0), (fallbackRow?.total_turns ?? 0)) * 100,
    1,
  );

  // Model usage distribution
  const totalCalls = cacheRow?.total ?? 0;
  const modelRows = safeAll<{ model: string; cnt: number }>(
    db,
    `SELECT model, COUNT(*) as cnt
     FROM inference_costs WHERE created_at >= ?
     GROUP BY model ORDER BY cnt DESC`,
    since,
  );
  const modelUsageDistribution: ModelUsage[] = modelRows.map((r) => ({
    model: r.model,
    count: r.cnt,
    pct: roundTo(safeDivide(r.cnt, totalCalls) * 100, 1),
  }));

  return {
    avgLatencyByProvider,
    cacheHitRate,
    costPer1kByProvider,
    cascadeFallbackRate,
    modelUsageDistribution,
  };
}

// ── Heartbeat Reliability ────────────────────────────────────────

function collectHeartbeatReliability(db: Database, windowHours: number = 1): HeartbeatReliability {
  const since = hoursAgoISO(windowHours);

  const totals = safeGet<{ total: number; successes: number; failures: number }>(
    db,
    `SELECT
       COUNT(*) as total,
       COALESCE(SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END), 0) as successes,
       COALESCE(SUM(CASE WHEN result = 'failure' THEN 1 ELSE 0 END), 0) as failures
     FROM heartbeat_history WHERE started_at >= ?`,
    since,
  );

  const totalRuns = totals?.total ?? 0;
  const successCount = totals?.successes ?? 0;
  const failureCount = totals?.failures ?? 0;
  const successRate = roundTo(safeDivide(successCount, totalRuns) * 100, 1);

  // Avg duration by task
  const durationRows = safeAll<{ task_name: string; avg_dur: number }>(
    db,
    `SELECT task_name, AVG(duration_ms) as avg_dur
     FROM heartbeat_history WHERE started_at >= ? AND duration_ms IS NOT NULL
     GROUP BY task_name`,
    since,
  );
  const avgDurationByTask: TaskDuration[] = durationRows.map((r) => ({
    taskName: r.task_name,
    avgDurationMs: roundTo(r.avg_dur, 1),
  }));

  // Failed tasks
  const failedRows = safeAll<{ task_name: string }>(
    db,
    `SELECT DISTINCT task_name FROM heartbeat_history
     WHERE started_at >= ? AND result = 'failure'`,
    since,
  );
  const failedTasks = failedRows.map((r) => r.task_name);

  return { totalRuns, successCount, failureCount, successRate, avgDurationByTask, failedTasks };
}

// ── Goal & Task Progress ─────────────────────────────────────────

function collectGoalProgress(db: Database): GoalProgress {
  const goalRow = safeGet<{ active: number; completed: number; total: number }>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) as active,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
       COUNT(*) as total
     FROM goals`,
  );

  const activeGoals = goalRow?.active ?? 0;
  const totalGoals = goalRow?.total ?? 0;
  const completedGoals = goalRow?.completed ?? 0;
  const completionPct = roundTo(safeDivide(completedGoals, totalGoals) * 100, 1);

  const taskRow = safeGet<{ completed: number; pending: number; failed: number }>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
       COALESCE(SUM(CASE WHEN status IN ('pending','assigned','running','blocked') THEN 1 ELSE 0 END), 0) as pending,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
     FROM task_graph`,
  );

  return {
    activeGoals,
    completionPct,
    tasksCompleted: taskRow?.completed ?? 0,
    tasksPending: taskRow?.pending ?? 0,
    tasksFailed: taskRow?.failed ?? 0,
  };
}

// ── System Health ────────────────────────────────────────────────

function collectSystemHealth(db: Database): SystemHealth {
  // Uptime from KV start_time
  const startTimeRaw = safeGet<{ value: string }>(
    db,
    `SELECT value FROM kv WHERE key = ?`,
    "start_time",
  );
  let uptimeSeconds = 0;
  if (startTimeRaw?.value) {
    const startMs = Date.parse(startTimeRaw.value);
    uptimeSeconds = Number.isNaN(startMs)
      ? 0
      : Math.floor((Date.now() - startMs) / 1000);
  }

  // Active alerts from latest metric_snapshots
  let activeAlerts: string[] = [];
  const alertRow = safeGet<{ alerts_json: string }>(
    db,
    `SELECT alerts_json FROM metric_snapshots ORDER BY snapshot_at DESC LIMIT 1`,
  );
  if (alertRow?.alerts_json) {
    try {
      const parsed = JSON.parse(alertRow.alerts_json);
      if (Array.isArray(parsed)) {
        activeAlerts = parsed.map((a: unknown) =>
          typeof a === "string" ? a : typeof a === "object" && a !== null && "message" in a
            ? String((a as { message: string }).message)
            : JSON.stringify(a),
        );
      }
    } catch {
      // malformed alerts JSON
    }
  }

  // Context token usage from working_memory
  const ctxRow = safeGet<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(token_count), 0) as total FROM working_memory`,
  );
  const contextTokenUsage = ctxRow?.total ?? 0;

  return { uptimeSeconds, activeAlerts, contextTokenUsage };
}

// ── Main Collector ───────────────────────────────────────────────

export function collectBenchmarks(db: Database): BenchmarkSnapshot {
  return {
    collectedAt: new Date().toISOString(),
    tokenEconomics: collectTokenEconomics(db),
    financialHealth: collectFinancialHealth(db),
    inferencePerformance: collectInferencePerformance(db),
    heartbeatReliability: collectHeartbeatReliability(db),
    goalProgress: collectGoalProgress(db),
    systemHealth: collectSystemHealth(db),
  };
}

// ── Bottleneck Analysis ──────────────────────────────────────────

function detectBottlenecks(snapshot: BenchmarkSnapshot): readonly Bottleneck[] {
  const bottlenecks: Bottleneck[] = [];

  // Avg latency > 5s
  const maxLatency = snapshot.inferencePerformance.avgLatencyByProvider.reduce(
    (max, p) => Math.max(max, p.avgLatencyMs),
    0,
  );
  if (maxLatency > 5000) {
    bottlenecks.push({
      id: "high_latency",
      severity: "warning",
      message: `Inference latency high (${roundTo(maxLatency, 0)}ms max avg)`,
      recommendation: "Consider switching to a faster provider or enabling local inference for low-priority tasks.",
    });
  }

  // Cache hit rate < 30%
  if (snapshot.inferencePerformance.cacheHitRate < 30) {
    bottlenecks.push({
      id: "low_cache_hit",
      severity: "warning",
      message: `Low cache hit rate (${snapshot.inferencePerformance.cacheHitRate}%)`,
      recommendation: "Review prompt templates for consistency. Enable prompt caching where supported.",
    });
  }

  // Cascade fallback rate > 50%
  if (snapshot.inferencePerformance.cascadeFallbackRate > 50) {
    bottlenecks.push({
      id: "frequent_fallbacks",
      severity: "critical",
      message: `Frequent cascade fallbacks (${snapshot.inferencePerformance.cascadeFallbackRate}%)`,
      recommendation: "Primary pool providers may be degraded. Check provider health and API key validity.",
    });
  }

  // Heartbeat failure rate > 10%
  const hbFailRate = 100 - snapshot.heartbeatReliability.successRate;
  if (snapshot.heartbeatReliability.totalRuns > 0 && hbFailRate > 10) {
    bottlenecks.push({
      id: "heartbeat_degraded",
      severity: "critical",
      message: `Heartbeat reliability degraded (${roundTo(hbFailRate, 1)}% failure rate)`,
      recommendation: "Investigate failing tasks: " +
        (snapshot.heartbeatReliability.failedTasks.join(", ") || "unknown") +
        ". Check timeouts and external dependencies.",
    });
  }

  // Burn rate > revenue rate
  const dailyRevenue = snapshot.financialHealth.revenueLast24hCents;
  const dailyBurn = snapshot.financialHealth.burnRate7dCentsPerDay;
  if (dailyBurn > 0 && dailyBurn > dailyRevenue) {
    bottlenecks.push({
      id: "overspend",
      severity: dailyRevenue === 0 ? "critical" : "warning",
      message: `Spending exceeds revenue (burn: ${dailyBurn}c/day, revenue: ${dailyRevenue}c/24h)`,
      recommendation: "Reduce inference costs by favoring free/local models. Pursue revenue-generating tasks.",
    });
  }

  // Token rate > 1000/min
  if (snapshot.tokenEconomics.tokensPerMinute > 1000) {
    bottlenecks.push({
      id: "high_token_rate",
      severity: "warning",
      message: `High token consumption (${roundTo(snapshot.tokenEconomics.tokensPerMinute, 0)} tokens/min)`,
      recommendation: "Enable aggressive summarization. Reduce context window size. Use shorter system prompts.",
    });
  }

  return bottlenecks;
}

// ── Trend Arrow ──────────────────────────────────────────────────

function trendArrow(current: number, previous: number): string {
  if (previous === 0 && current === 0) return "\u2192";
  const delta = safeDivide(current - previous, Math.abs(previous)) * 100;
  if (Math.abs(delta) < 2) return "\u2192";
  return delta > 0 ? "\u2191" : "\u2193";
}

// ── Markdown Report ──────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

function formatCents(cents: number): string {
  const usd = cents / 100;
  return `$${usd.toFixed(2)}`;
}

export function generateBenchmarkMarkdown(
  snapshot: BenchmarkSnapshot,
  history: readonly BenchmarkSnapshot[],
): string {
  const prev = history.length > 0 ? history[history.length - 1] : undefined;
  const bottlenecks = detectBottlenecks(snapshot);
  const lines: string[] = [];

  const ts = snapshot.collectedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  lines.push(`# Automaton Benchmark Report`);
  lines.push(``);
  lines.push(`> Collected: ${ts}`);
  lines.push(``);

  // ── Token Economics
  lines.push(`## Token Economics (last ${snapshot.tokenEconomics.windowMinutes} min)`);
  lines.push(``);
  const te = snapshot.tokenEconomics;
  const tePrev = prev?.tokenEconomics;
  lines.push(`| Metric | Value | Trend |`);
  lines.push(`|--------|------:|:-----:|`);
  lines.push(`| Total turns | ${te.totalTurns} | ${tePrev ? trendArrow(te.totalTurns, tePrev.totalTurns) : "-"} |`);
  lines.push(`| Total tokens | ${te.totalTokens.toLocaleString()} | ${tePrev ? trendArrow(te.totalTokens, tePrev.totalTokens) : "-"} |`);
  lines.push(`| Avg tokens/turn | ${te.avgTokensPerTurn} | ${tePrev ? trendArrow(te.avgTokensPerTurn, tePrev.avgTokensPerTurn) : "-"} |`);
  lines.push(`| Tokens/min | ${te.tokensPerMinute} | ${tePrev ? trendArrow(te.tokensPerMinute, tePrev.tokensPerMinute) : "-"} |`);
  lines.push(``);

  // ── Financial Health
  lines.push(`## Financial Health`);
  lines.push(``);
  const fh = snapshot.financialHealth;
  const fhPrev = prev?.financialHealth;
  lines.push(`| Metric | Value | Trend |`);
  lines.push(`|--------|------:|:-----:|`);
  lines.push(`| USDC balance | ${fh.usdcBalance.toFixed(4)} | ${fhPrev ? trendArrow(fh.usdcBalance, fhPrev.usdcBalance) : "-"} |`);
  lines.push(`| Revenue (24h) | ${formatCents(fh.revenueLast24hCents)} | ${fhPrev ? trendArrow(fh.revenueLast24hCents, fhPrev.revenueLast24hCents) : "-"} |`);
  lines.push(`| Expenses (24h) | ${formatCents(fh.expensesLast24hCents)} | ${fhPrev ? trendArrow(fh.expensesLast24hCents, fhPrev.expensesLast24hCents) : "-"} |`);
  lines.push(`| Net P&L (24h) | ${formatCents(fh.netPnlCents)} | ${fhPrev ? trendArrow(fh.netPnlCents, fhPrev.netPnlCents) : "-"} |`);
  lines.push(`| Burn rate (7d avg) | ${formatCents(fh.burnRate7dCentsPerDay)}/day | ${fhPrev ? trendArrow(fh.burnRate7dCentsPerDay, fhPrev.burnRate7dCentsPerDay) : "-"} |`);
  lines.push(`| Survival tier | ${fh.survivalTier} | - |`);
  lines.push(``);

  // ── Inference Performance
  lines.push(`## Inference Performance (last ${snapshot.tokenEconomics.windowMinutes} min)`);
  lines.push(``);
  const ip = snapshot.inferencePerformance;
  if (ip.avgLatencyByProvider.length > 0) {
    lines.push(`### Latency by Provider`);
    lines.push(``);
    lines.push(`| Provider | Avg Latency | Calls |`);
    lines.push(`|----------|------------:|------:|`);
    for (const p of ip.avgLatencyByProvider) {
      lines.push(`| ${p.provider} | ${p.avgLatencyMs}ms | ${p.callCount} |`);
    }
    lines.push(``);
  }

  lines.push(`| Metric | Value |`);
  lines.push(`|--------|------:|`);
  lines.push(`| Cache hit rate | ${ip.cacheHitRate}% |`);
  lines.push(`| Cascade fallback rate | ${ip.cascadeFallbackRate}% |`);
  lines.push(``);

  if (ip.costPer1kByProvider.length > 0) {
    lines.push(`### Cost per 1K Tokens`);
    lines.push(``);
    lines.push(`| Provider | Cost/1K tokens |`);
    lines.push(`|----------|---------------:|`);
    for (const c of ip.costPer1kByProvider) {
      lines.push(`| ${c.provider} | ${formatCents(c.costPer1kTokensCents)} |`);
    }
    lines.push(``);
  }

  if (ip.modelUsageDistribution.length > 0) {
    lines.push(`### Model Usage`);
    lines.push(``);
    lines.push(`| Model | Calls | Share |`);
    lines.push(`|-------|------:|------:|`);
    for (const m of ip.modelUsageDistribution) {
      lines.push(`| ${m.model} | ${m.count} | ${m.pct}% |`);
    }
    lines.push(``);
  }

  // ── Heartbeat Reliability
  lines.push(`## Heartbeat Reliability (last 1h)`);
  lines.push(``);
  const hb = snapshot.heartbeatReliability;
  lines.push(`| Metric | Value | Trend |`);
  lines.push(`|--------|------:|:-----:|`);
  lines.push(`| Total runs | ${hb.totalRuns} | ${prev ? trendArrow(hb.totalRuns, prev.heartbeatReliability.totalRuns) : "-"} |`);
  lines.push(`| Success rate | ${hb.successRate}% | ${prev ? trendArrow(hb.successRate, prev.heartbeatReliability.successRate) : "-"} |`);
  lines.push(`| Failures | ${hb.failureCount} | ${prev ? trendArrow(hb.failureCount, prev.heartbeatReliability.failureCount) : "-"} |`);
  lines.push(``);

  if (hb.avgDurationByTask.length > 0) {
    lines.push(`### Task Durations`);
    lines.push(``);
    lines.push(`| Task | Avg Duration |`);
    lines.push(`|------|-------------:|`);
    for (const t of hb.avgDurationByTask) {
      lines.push(`| ${t.taskName} | ${t.avgDurationMs}ms |`);
    }
    lines.push(``);
  }

  if (hb.failedTasks.length > 0) {
    lines.push(`**Failed tasks:** ${hb.failedTasks.join(", ")}`);
    lines.push(``);
  }

  // ── Goal & Task Progress
  lines.push(`## Goal & Task Progress`);
  lines.push(``);
  const gp = snapshot.goalProgress;
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|------:|`);
  lines.push(`| Active goals | ${gp.activeGoals} |`);
  lines.push(`| Goal completion | ${gp.completionPct}% |`);
  lines.push(`| Tasks completed | ${gp.tasksCompleted} |`);
  lines.push(`| Tasks pending | ${gp.tasksPending} |`);
  lines.push(`| Tasks failed | ${gp.tasksFailed} |`);
  lines.push(``);

  // ── System Health
  lines.push(`## System Health`);
  lines.push(``);
  const sh = snapshot.systemHealth;
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|------:|`);
  lines.push(`| Uptime | ${formatUptime(sh.uptimeSeconds)} |`);
  lines.push(`| Context tokens | ${sh.contextTokenUsage.toLocaleString()} |`);
  lines.push(`| Active alerts | ${sh.activeAlerts.length} |`);
  lines.push(``);

  if (sh.activeAlerts.length > 0) {
    lines.push(`**Alerts:**`);
    for (const a of sh.activeAlerts) {
      lines.push(`- ${a}`);
    }
    lines.push(``);
  }

  // ── Last 6 Snapshots Mini-Table
  const recentHistory = history.slice(-6);
  if (recentHistory.length > 0) {
    lines.push(`## Last ${recentHistory.length} Snapshots`);
    lines.push(``);
    lines.push(`| Time | Latency (max) | Cost/1K | Tokens/min | Revenue (24h) |`);
    lines.push(`|------|:-------------:|--------:|-----------:|--------------:|`);

    for (const h of recentHistory) {
      const time = h.collectedAt.replace("T", " ").slice(11, 19);
      const maxLat = h.inferencePerformance.avgLatencyByProvider.reduce(
        (max, p) => Math.max(max, p.avgLatencyMs),
        0,
      );
      const avgCost = h.inferencePerformance.costPer1kByProvider.length > 0
        ? roundTo(
            h.inferencePerformance.costPer1kByProvider.reduce((s, c) => s + c.costPer1kTokensCents, 0) /
              h.inferencePerformance.costPer1kByProvider.length,
            2,
          )
        : 0;
      lines.push(
        `| ${time} | ${roundTo(maxLat, 0)}ms | ${formatCents(avgCost)} | ${h.tokenEconomics.tokensPerMinute} | ${formatCents(h.financialHealth.revenueLast24hCents)} |`,
      );
    }

    // Current row
    const curMaxLat = ip.avgLatencyByProvider.reduce((max, p) => Math.max(max, p.avgLatencyMs), 0);
    const curAvgCost = ip.costPer1kByProvider.length > 0
      ? roundTo(
          ip.costPer1kByProvider.reduce((s, c) => s + c.costPer1kTokensCents, 0) /
            ip.costPer1kByProvider.length,
          2,
        )
      : 0;
    lines.push(
      `| **now** | ${roundTo(curMaxLat, 0)}ms | ${formatCents(curAvgCost)} | ${te.tokensPerMinute} | ${formatCents(fh.revenueLast24hCents)} |`,
    );
    lines.push(``);
  }

  // ── Bottleneck Analysis
  lines.push(`## Bottleneck Analysis`);
  lines.push(``);
  if (bottlenecks.length === 0) {
    lines.push(`No bottlenecks detected. All metrics within normal thresholds.`);
  } else {
    for (const b of bottlenecks) {
      const icon = b.severity === "critical" ? "[CRITICAL]" : "[WARNING]";
      lines.push(`- **${icon}** ${b.message}`);
    }
  }
  lines.push(``);

  // ── Fine-Tuning Recommendations
  lines.push(`## Fine-Tuning Recommendations`);
  lines.push(``);
  if (bottlenecks.length === 0) {
    lines.push(`System is operating within normal parameters. No immediate tuning required.`);
  } else {
    for (const b of bottlenecks) {
      lines.push(`- **${b.id}**: ${b.recommendation}`);
    }
  }
  lines.push(``);

  lines.push(`---`);
  lines.push(`*Generated by automaton benchmark collector*`);

  return lines.join("\n");
}

// ── Persistence ──────────────────────────────────────────────────

const MAX_HISTORY_ENTRIES = 144; // 24 hours at 10-min intervals

export function persistBenchmarks(
  snapshot: BenchmarkSnapshot,
  markdownPath: string,
  historyPath: string,
): void {
  // Load existing history (immutable: read, create new array, write back)
  let existingHistory: BenchmarkSnapshot[] = [];
  try {
    if (fs.existsSync(historyPath)) {
      const raw = fs.readFileSync(historyPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        existingHistory = parsed;
      }
    }
  } catch {
    // Corrupted or missing file — start fresh
    existingHistory = [];
  }

  // Append snapshot and trim to max entries
  const updatedHistory = [...existingHistory, snapshot].slice(-MAX_HISTORY_ENTRIES);

  // Write history JSON
  const historyDir = historyPath.replace(/[/\\][^/\\]+$/, "");
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
  fs.writeFileSync(historyPath, JSON.stringify(updatedHistory, null, 2), "utf-8");

  // Generate and write Markdown report
  const markdown = generateBenchmarkMarkdown(snapshot, updatedHistory.slice(0, -1));
  const mdDir = markdownPath.replace(/[/\\][^/\\]+$/, "");
  if (!fs.existsSync(mdDir)) {
    fs.mkdirSync(mdDir, { recursive: true });
  }
  fs.writeFileSync(markdownPath, markdown, "utf-8");
}
