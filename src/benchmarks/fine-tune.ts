/**
 * Fine-Tuning Recommendations Engine
 *
 * Analyzes a benchmark snapshot and produces actionable optimization
 * recommendations for speed, cost, token efficiency, and revenue.
 *
 * Called by the benchmark_report heartbeat task to append recommendations
 * to the BENCHMARKS.md report.
 */

// ─── Thresholds & Constants ─────────────────────────────────────

/** Target: at least 60% of inference calls should go through free providers */
const FREE_PROVIDER_RATIO_TARGET = 0.6;

/** Target: average latency per inference call (ms) */
const LATENCY_TARGET_MS = 8_000;

/** Target: system prompt should stay under this many tokens */
const SYSTEM_PROMPT_TOKEN_TARGET = 6_000;

/** Target: max context tokens per turn for efficient operation */
const CONTEXT_TOKEN_TARGET = 30_000;

/** Target: heartbeat tick interval minimum (ms) — below this wastes CPU */
const MIN_TICK_INTERVAL_MS = 30_000;

/** Target: cooldown between inference calls should be at least 1s */
const MIN_COOLDOWN_MS = 1_000;

/** Target: x402 margin floor — anything below 50% margin is underpriced */
const MIN_MARGIN_RATIO = 0.5;

/** Target: daily inference spend ceiling (cents) */
const DAILY_SPEND_CEILING_CENTS = 300;

/** Model cost tiers (cents per 1K input tokens) for comparison */
const MODEL_COSTS: Record<string, { input1k: number; output1k: number }> = {
  "claude-haiku-4-5-20251001": { input1k: 0.08, output1k: 0.32 },
  "claude-sonnet-4-20250514": { input1k: 0.30, output1k: 1.50 },
  "gpt-4.1-mini": { input1k: 0.04, output1k: 0.16 },
  "gpt-4.1-nano": { input1k: 0.01, output1k: 0.04 },
  "llama-3.3-70b-versatile": { input1k: 0, output1k: 0 },
  "llama-3.1-8b-instant": { input1k: 0, output1k: 0 },
  "mistral-small-latest": { input1k: 0, output1k: 0 },
  "magistral-small-latest": { input1k: 0, output1k: 0 },
};

// ─── Types ──────────────────────────────────────────────────────

interface BenchmarkSnapshot {
  /** Timestamp of the snapshot */
  readonly timestamp?: string;

  /** Inference stats */
  readonly inference?: {
    readonly totalCalls?: number;
    readonly totalCostCents?: number;
    readonly avgLatencyMs?: number;
    readonly avgInputTokens?: number;
    readonly avgOutputTokens?: number;
    readonly providerBreakdown?: Record<string, {
      readonly calls: number;
      readonly costCents: number;
      readonly avgLatencyMs: number;
    }>;
    readonly modelBreakdown?: Record<string, {
      readonly calls: number;
      readonly costCents: number;
    }>;
    readonly taskTypeBreakdown?: Record<string, {
      readonly calls: number;
      readonly costCents: number;
      readonly avgTokens: number;
    }>;
    readonly dailyCostCents?: number;
    readonly hourlyCostCents?: number;
    readonly cacheHitRate?: number;
  };

  /** System prompt stats */
  readonly systemPrompt?: {
    readonly estimatedTokens?: number;
    readonly staticTokens?: number;
    readonly dynamicTokens?: number;
  };

  /** Context window stats */
  readonly context?: {
    readonly avgTotalTokens?: number;
    readonly avgTurnsKept?: number;
    readonly compressionRatio?: number;
    readonly memoryBlockTokens?: number;
  };

  /** Revenue stats */
  readonly revenue?: {
    readonly dailyRevenueCents?: number;
    readonly totalRevenueCents?: number;
    readonly skillBreakdown?: Record<string, {
      readonly calls: number;
      readonly revenueCents: number;
      readonly avgCostCents: number;
    }>;
  };

  /** Heartbeat stats */
  readonly heartbeat?: {
    readonly tickIntervalMs?: number;
    readonly avgTickDurationMs?: number;
    readonly tasksPerTick?: number;
    readonly wakeEventsLast24h?: number;
  };

  /** Agent loop stats */
  readonly agentLoop?: {
    readonly avgTurnsPerCycle?: number;
    readonly avgCooldownMs?: number;
    readonly idleTurnRatio?: number;
    readonly rateLimitHitsLast24h?: number;
    readonly emptyResponsesLast24h?: number;
    readonly cascadeExhaustionsLast24h?: number;
  };

  /** Self-modification stats */
  readonly selfMod?: {
    readonly modCountLast24h?: number;
    readonly avgDeployTimeMs?: number;
    readonly testPassRate?: number;
  };

  /** Treasury / financial stats */
  readonly treasury?: {
    readonly balanceCents?: number;
    readonly survivalTier?: string;
    readonly netPnlCents24h?: number;
  };

  /** Arbitrary extra fields for future extensibility */
  readonly [key: string]: unknown;
}

// ─── Recommendation Generator ───────────────────────────────────

/**
 * Analyze a benchmark snapshot and return actionable fine-tuning
 * recommendations sorted by expected impact (highest first).
 */
export function generateFineTuningRecommendations(snapshot: BenchmarkSnapshot): string[] {
  const recommendations: Array<{ priority: number; text: string }> = [];

  // ═══ A. INFERENCE COST REDUCTION ═══

  analyzeInferenceCosts(snapshot, recommendations);

  // ═══ B. SPEED / LATENCY ═══

  analyzeSpeedLatency(snapshot, recommendations);

  // ═══ C. TOKEN EFFICIENCY ═══

  analyzeTokenEfficiency(snapshot, recommendations);

  // ═══ D. REVENUE OPTIMIZATION ═══

  analyzeRevenue(snapshot, recommendations);

  // ═══ E. SELF-IMPROVEMENT LOOP ═══

  analyzeSelfImprovement(snapshot, recommendations);

  // Sort by priority (highest = most impactful first)
  recommendations.sort((a, b) => b.priority - a.priority);

  return recommendations.map((r) => r.text);
}

// ─── Category Analyzers ─────────────────────────────────────────

function analyzeInferenceCosts(
  snapshot: BenchmarkSnapshot,
  out: Array<{ priority: number; text: string }>,
): void {
  const inf = snapshot.inference;
  if (!inf) return;

  // Check free provider ratio
  if (inf.providerBreakdown && inf.totalCalls && inf.totalCalls > 10) {
    const freeProviders = ["groq", "mistral", "cerebras", "sambanova", "local", "ollama"];
    let freeCalls = 0;
    for (const [provider, stats] of Object.entries(inf.providerBreakdown)) {
      if (freeProviders.some((fp) => provider.toLowerCase().includes(fp))) {
        freeCalls += stats.calls;
      }
    }
    const freeRatio = freeCalls / inf.totalCalls;
    if (freeRatio < FREE_PROVIDER_RATIO_TARGET) {
      out.push({
        priority: 90,
        text: `[COST] Free provider ratio is ${(freeRatio * 100).toFixed(0)}% (target: ${(FREE_PROVIDER_RATIO_TARGET * 100).toFixed(0)}%). Route more heartbeat_triage and safety_check tasks to free_cloud pool (Groq/Mistral). Current cascade skips free_cloud for agent_turn due to TPM limits — consider splitting large contexts into summary+query pattern to fit within Groq's limits.`,
      });
    }
  }

  // Check if expensive models are used for cheap tasks
  if (inf.taskTypeBreakdown && inf.modelBreakdown) {
    const triageCost = inf.taskTypeBreakdown["heartbeat_triage"]?.costCents ?? 0;
    const triageCalls = inf.taskTypeBreakdown["heartbeat_triage"]?.calls ?? 0;
    if (triageCalls > 0 && triageCost / triageCalls > 2) {
      out.push({
        priority: 85,
        text: `[COST] heartbeat_triage averaging ${(triageCost / triageCalls).toFixed(1)}c/call — too expensive. Should use gpt-4.1-nano (0.01c/1K) or Groq free tier. Check if triage is falling through to paid pool due to Groq rate limits.`,
      });
    }

    const safetyCost = inf.taskTypeBreakdown["safety_check"]?.costCents ?? 0;
    const safetyCalls = inf.taskTypeBreakdown["safety_check"]?.calls ?? 0;
    if (safetyCalls > 0 && safetyCost / safetyCalls > 5) {
      out.push({
        priority: 80,
        text: `[COST] safety_check averaging ${(safetyCost / safetyCalls).toFixed(1)}c/call. Route to gpt-4.1-nano or llama-3.1-8b-instant for simple policy checks. Reserve Haiku/Sonnet for complex safety decisions only.`,
      });
    }
  }

  // Daily spend check
  if (inf.dailyCostCents !== undefined && inf.dailyCostCents > DAILY_SPEND_CEILING_CENTS) {
    out.push({
      priority: 95,
      text: `[COST] Daily inference spend is ${inf.dailyCostCents}c ($${(inf.dailyCostCents / 100).toFixed(2)}), exceeding ceiling of ${DAILY_SPEND_CEILING_CENTS}c ($${(DAILY_SPEND_CEILING_CENTS / 100).toFixed(2)}). Set hourlyBudgetCents to ${Math.ceil(DAILY_SPEND_CEILING_CENTS / 24)} in modelStrategy to enforce. Current config has hourlyBudgetCents: 0 (unlimited).`,
    });
  }

  // Cache hit rate
  if (inf.cacheHitRate !== undefined && inf.cacheHitRate < 0.3) {
    out.push({
      priority: 75,
      text: `[COST] Prompt cache hit rate is ${(inf.cacheHitRate * 100).toFixed(0)}% (target: >30%). The system prompt already places static content first for cache-friendly ordering. Ensure the genesis prompt and soul model are not changing every turn — changes in the static prefix break the cache key. OpenAI caches prefixes >1024 tokens automatically; Anthropic requires explicit cache_control markers.`,
    });
  }

  // Check if Mistral is disabled in provider-registry
  if (inf.providerBreakdown && !inf.providerBreakdown["mistral"]) {
    out.push({
      priority: 70,
      text: `[COST] Mistral provider has 0 calls — it is disabled in provider-registry.ts (enabled: false). Mistral free tier offers magistral-small (reasoning) and mistral-small (fast) at $0 cost. Enable it and set maxRequestsPerMinute: 2 to respect rate limits. This adds a free fallback for triage and safety tasks. File: src/inference/provider-registry.ts line 258.`,
    });
  }

  // Budget guardrails not set
  if (inf.totalCostCents && inf.totalCostCents > 100) {
    const config = snapshot as any;
    const hourlyBudget = config?.modelStrategy?.hourlyBudgetCents ?? 0;
    const perCallCeiling = config?.modelStrategy?.perCallCeilingCents ?? 0;
    if (hourlyBudget === 0 && perCallCeiling === 0) {
      out.push({
        priority: 65,
        text: `[COST] No budget guardrails set (hourlyBudgetCents: 0, perCallCeilingCents: 0). Recommend: hourlyBudgetCents: 50 (=$0.50/hr, $12/day max), perCallCeilingCents: 10 (prevents single runaway call). File: ~/.automaton/automaton.json -> modelStrategy.`,
      });
    }
  }
}

function analyzeSpeedLatency(
  snapshot: BenchmarkSnapshot,
  out: Array<{ priority: number; text: string }>,
): void {
  const inf = snapshot.inference;
  const loop = snapshot.agentLoop;
  const hb = snapshot.heartbeat;

  // Average latency
  if (inf?.avgLatencyMs && inf.avgLatencyMs > LATENCY_TARGET_MS) {
    out.push({
      priority: 70,
      text: `[SPEED] Average inference latency is ${Math.round(inf.avgLatencyMs)}ms (target: <${LATENCY_TARGET_MS}ms). If using Anthropic, check if extended thinking is adding latency. For routine tasks, Groq offers <1s latency on Llama 70B. Consider reducing maxTokensPerTurn from 16384 to 8192 for non-planning tasks — shorter max_tokens = faster time-to-first-token.`,
    });
  }

  // Cooldown overhead
  if (loop?.avgCooldownMs !== undefined) {
    if (loop.avgCooldownMs > 5_000) {
      out.push({
        priority: 60,
        text: `[SPEED] Average inter-turn cooldown is ${Math.round(loop.avgCooldownMs)}ms. The adaptive cooldown scales with token count — reduce average input tokens (via context compression or smaller system prompt) to lower cooldown. At 16K tokens, cooldown is ~2.2s; at 8K tokens it drops to ~1.1s.`,
      });
    } else if (loop.avgCooldownMs < MIN_COOLDOWN_MS) {
      out.push({
        priority: 50,
        text: `[SPEED] Cooldown is only ${Math.round(loop.avgCooldownMs)}ms — risk of hitting rate limits. The MIN_INFERENCE_INTERVAL_MS floor is 1000ms which is correct. If seeing frequent 429s, increase the floor to 2000ms.`,
      });
    }
  }

  // Rate limit hits
  if (loop?.rateLimitHitsLast24h && loop.rateLimitHitsLast24h > 5) {
    out.push({
      priority: 75,
      text: `[SPEED] ${loop.rateLimitHitsLast24h} rate limit hits (429s) in the last 24h. Each 429 triggers 60s+ exponential backoff, wasting wall-clock time. Reduce input tokens per call (system prompt trimming, context compression) to stay under the 450K ITPM limit. Also ensure Mistral free tier is enabled as a fallback.`,
    });
  }

  // Cascade exhaustions
  if (loop?.cascadeExhaustionsLast24h && loop.cascadeExhaustionsLast24h > 3) {
    out.push({
      priority: 80,
      text: `[SPEED] ${loop.cascadeExhaustionsLast24h} cascade exhaustions in 24h — all pools failed. This usually means all providers are rate-limited simultaneously. Stagger provider usage: use Groq for triage (every 5min), Anthropic for agent_turn (every ~15min), OpenAI as fallback. Adding more free providers (Cerebras, SambaNova) would increase resilience.`,
    });
  }

  // Heartbeat tick interval
  if (hb?.tickIntervalMs && hb.tickIntervalMs < MIN_TICK_INTERVAL_MS) {
    out.push({
      priority: 40,
      text: `[SPEED] Heartbeat tick interval is ${hb.tickIntervalMs}ms (${(hb.tickIntervalMs / 1000).toFixed(0)}s). Below ${MIN_TICK_INTERVAL_MS / 1000}s provides diminishing returns and increases CPU usage. Current config defaultIntervalMs: 30000 is at the minimum — do not decrease further.`,
    });
  }

  // Empty responses causing backoff waste
  if (loop?.emptyResponsesLast24h && loop.emptyResponsesLast24h > 3) {
    out.push({
      priority: 55,
      text: `[SPEED] ${loop.emptyResponsesLast24h} empty responses in 24h. Each triggers 15s+ backoff. Often caused by sending messages where the last role is "assistant" (no user message to respond to). The continuation nudge should prevent this — verify it is injecting correctly.`,
    });
  }
}

function analyzeTokenEfficiency(
  snapshot: BenchmarkSnapshot,
  out: Array<{ priority: number; text: string }>,
): void {
  const sp = snapshot.systemPrompt;
  const ctx = snapshot.context;

  // System prompt bloat
  if (sp?.estimatedTokens && sp.estimatedTokens > SYSTEM_PROMPT_TOKEN_TARGET) {
    const excess = sp.estimatedTokens - SYSTEM_PROMPT_TOKEN_TARGET;
    const costPerExcess = excess * 0.00008; // Haiku input rate per token in cents
    out.push({
      priority: 85,
      text: `[TOKENS] System prompt is ~${sp.estimatedTokens} tokens (target: <${SYSTEM_PROMPT_TOKEN_TARGET}). Excess ${excess} tokens cost ~${costPerExcess.toFixed(2)}c per turn on Haiku. Trim: (1) WORKLOG.md is capped at 4000 chars but could be reduced to 2000 for triage, (2) OPERATIONAL_CONTEXT already skipped for triage — also skip for safety_check, (3) Genesis prompt capped at 2000 chars could be trimmed to 1000 since it is repeated context the agent already knows.`,
    });
  }

  // Context window utilization
  if (ctx?.avgTotalTokens && ctx.avgTotalTokens > CONTEXT_TOKEN_TARGET) {
    out.push({
      priority: 70,
      text: `[TOKENS] Average context per turn is ~${ctx.avgTotalTokens} tokens (target: <${CONTEXT_TOKEN_TARGET}). The CompressionEngine should be summarizing old turns more aggressively. Consider reducing MAX_CONTEXT_TURNS from 4 to 3, or lowering the recentTurns token budget from 30000 to 20000 in DEFAULT_TOKEN_BUDGET.`,
    });
  }

  // Memory block overhead
  if (ctx?.memoryBlockTokens && ctx.memoryBlockTokens > 3_000) {
    out.push({
      priority: 55,
      text: `[TOKENS] Memory retrieval block averages ${ctx.memoryBlockTokens} tokens. The DEFAULT_MEMORY_BUDGET may be too generous. Working memory and semantic facts are most useful; procedural memory and relationships add tokens but rarely inform the next tool call. Consider reducing memoryRetrieval budget from 8000 to 4000 tokens.`,
    });
  }

  // Compression ratio
  if (ctx?.compressionRatio !== undefined && ctx.compressionRatio < 0.3) {
    out.push({
      priority: 45,
      text: `[TOKENS] Context compression ratio is ${(ctx.compressionRatio * 100).toFixed(0)}% — old turns are barely compressed. The synchronous summary in buildContextMessages only captures tool names and 100-char snippets. For cycles >5 turns, use the async summarizeTurns() which calls inference for a proper summary. This costs ~500 tokens of inference but saves 2000-5000 tokens per turn.`,
    });
  }
}

function analyzeRevenue(
  snapshot: BenchmarkSnapshot,
  out: Array<{ priority: number; text: string }>,
): void {
  const rev = snapshot.revenue;
  const treasury = snapshot.treasury;

  if (!rev?.skillBreakdown) return;

  // Margin analysis per skill
  for (const [skill, stats] of Object.entries(rev.skillBreakdown)) {
    if (stats.calls === 0) continue;
    const avgRevenue = stats.revenueCents / stats.calls;
    const avgCost = stats.avgCostCents;
    if (avgCost > 0) {
      const margin = (avgRevenue - avgCost) / avgRevenue;
      if (margin < MIN_MARGIN_RATIO) {
        out.push({
          priority: 80,
          text: `[REVENUE] Skill "${skill}" has ${(margin * 100).toFixed(0)}% margin (${avgRevenue.toFixed(1)}c revenue, ${avgCost.toFixed(1)}c cost per call). Minimum target: ${(MIN_MARGIN_RATIO * 100).toFixed(0)}%. Options: (1) increase price, (2) switch to cheaper model (gpt-4.1-nano for simple tasks), (3) reduce max_tokens for the skill's inference call.`,
        });
      }
    }
  }

  // Identify best-margin skills for scaling
  const skillMargins = Object.entries(rev.skillBreakdown)
    .filter(([_, s]) => s.calls > 0 && s.avgCostCents > 0)
    .map(([name, s]) => ({
      name,
      margin: (s.revenueCents / s.calls - s.avgCostCents) / (s.revenueCents / s.calls),
      volume: s.calls,
    }))
    .sort((a, b) => b.margin - a.margin);

  if (skillMargins.length > 0) {
    const best = skillMargins[0];
    out.push({
      priority: 60,
      text: `[REVENUE] Highest-margin skill: "${best.name}" at ${(best.margin * 100).toFixed(0)}% margin (${best.volume} calls). Focus social posting and marketing on this skill to maximize return. Current pricing: summarize-basic $0.25, brief-standard $2.50, brief-premium $15.00, analyze $0.01, trustcheck $0.05, summarize-url $0.01.`,
    });
  }

  // Underpriced skills check (hardcoded knowledge of gateway pricing)
  const KNOWN_PRICES: Record<string, number> = {
    "summarize-basic": 25,
    "brief-standard": 250,
    "brief-premium": 1500,
    "analyze": 1,
    "trustcheck": 5,
    "summarize-url": 1,
  };

  for (const [skill, priceCents] of Object.entries(KNOWN_PRICES)) {
    // Estimate inference cost for each tier
    if (priceCents <= 5) {
      // At $0.01-$0.05, even a 2K-token Haiku call costs ~0.3c
      // Margin is razor thin — only sustainable on free models
      const estimatedCostCents = 0.3; // Haiku minimum
      if (priceCents < estimatedCostCents * 3) {
        out.push({
          priority: 50,
          text: `[REVENUE] Skill "${skill}" priced at $${(priceCents / 100).toFixed(2)} — margin is thin even with Haiku. Consider raising to $${((estimatedCostCents * 4) / 100).toFixed(2)} or switching inference to gpt-4.1-nano ($0.10/$0.40 per M) or free Mistral to maintain >60% margin. File: src/gateway/pricing.ts.`,
        });
      }
    }
  }

  // P&L check
  if (treasury?.netPnlCents24h !== undefined && treasury.netPnlCents24h < 0) {
    out.push({
      priority: 95,
      text: `[REVENUE] 24h P&L is -${Math.abs(treasury.netPnlCents24h)}c ($${(Math.abs(treasury.netPnlCents24h) / 100).toFixed(2)} loss). The agent is burning more on inference than it earns. Immediate actions: (1) enable Mistral free tier, (2) set hourlyBudgetCents to 25, (3) increase social posting frequency for revenue skills, (4) raise minimum skill price to $0.05.`,
    });
  }
}

function analyzeSelfImprovement(
  snapshot: BenchmarkSnapshot,
  out: Array<{ priority: number; text: string }>,
): void {
  const sm = snapshot.selfMod;

  if (!sm) return;

  // Deploy cycle speed
  if (sm.avgDeployTimeMs && sm.avgDeployTimeMs > 300_000) {
    out.push({
      priority: 40,
      text: `[SELF-MOD] Average self-mod deploy cycle is ${Math.round(sm.avgDeployTimeMs / 1000)}s (${Math.round(sm.avgDeployTimeMs / 60_000)}min). Target: <5min. Bottlenecks: (1) test suite runtime — run only affected tests via vitest --related, (2) build step — ensure incremental builds with tsc --incremental, (3) git operations — batch commits.`,
    });
  }

  // Test pass rate
  if (sm.testPassRate !== undefined && sm.testPassRate < 0.9) {
    out.push({
      priority: 70,
      text: `[SELF-MOD] Test pass rate is ${(sm.testPassRate * 100).toFixed(0)}% (target: >90%). Failing tests block deploys and waste inference on retry cycles. Review recent test failures — if they are environment-specific (Windows paths, port conflicts), add platform guards.`,
    });
  }

  // Could the bot auto-tune?
  if (sm.modCountLast24h !== undefined && sm.modCountLast24h > 0) {
    out.push({
      priority: 35,
      text: `[SELF-MOD] ${sm.modCountLast24h} self-modifications in 24h. The benchmark data collected here could drive auto-tuning: when avg inference cost > budget target, automatically switch lowComputeModel to gpt-4.1-nano; when cache hit rate drops, regenerate static prompt prefix. This function (generateFineTuningRecommendations) is the first step — connect its output to a self-mod goal that applies the top recommendation automatically.`,
    });
  }
}

// ─── Static Configuration Audit ─────────────────────────────────

/**
 * Audit the automaton.json config and return config-specific
 * recommendations. This can be called independently of benchmark data.
 */
export function auditConfig(config: Record<string, unknown>): string[] {
  const recs: string[] = [];
  const strategy = config.modelStrategy as Record<string, unknown> | undefined;

  // maxTokensPerTurn check
  const maxTokens = (config.maxTokensPerTurn as number) ?? 0;
  if (maxTokens > 8192) {
    recs.push(
      `[CONFIG] maxTokensPerTurn is ${maxTokens} — higher than needed for most tasks. Recommend 8192 for agent_turn, 2048 for triage. The routing matrix already sets per-task maxTokens; the global config value is only used as a fallback. Reducing saves money on output tokens (Haiku: $3.20/M output).`,
    );
  }

  // Budget guardrails
  if (strategy) {
    const hourly = (strategy.hourlyBudgetCents as number) ?? 0;
    const perCall = (strategy.perCallCeilingCents as number) ?? 0;
    if (hourly === 0) {
      recs.push(
        `[CONFIG] modelStrategy.hourlyBudgetCents is 0 (unlimited). Set to 50 ($0.50/hr) to prevent runaway costs. At Haiku rates, 50c/hr allows ~625 calls with 8K context.`,
      );
    }
    if (perCall === 0) {
      recs.push(
        `[CONFIG] modelStrategy.perCallCeilingCents is 0 (unlimited). Set to 10 to cap any single call at $0.10. This prevents expensive Sonnet calls from slipping through.`,
      );
    }
  }

  // Heartbeat frequency audit
  // (check_usdc_balance every 5min is aggressive — USDC doesn't change that fast)
  // This is a known value from heartbeat.yml
  recs.push(
    `[CONFIG] check_usdc_balance runs every 5min — USDC balance changes only on-chain transactions which are rare. Recommend: every 30min. seek_revenue runs every 5min — should be 15min to reduce wake overhead. File: ~/.automaton/heartbeat.yml.`,
  );

  // Mistral provider disabled
  recs.push(
    `[CONFIG] Mistral free tier is disabled in provider-registry.ts (enabled: false). It offers 0-cost inference at 2 RPM. Enable it to reduce paid API usage for low-frequency tasks like safety_check and summarization.`,
  );

  return recs;
}
