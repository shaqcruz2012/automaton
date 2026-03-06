/**
 * Cascade Controller
 *
 * Sits above the InferenceRouter and decides which provider pool to use
 * based on the agent's profitability and survival tier.
 *
 * Pool cascade: PAID -> FREE_CLOUD -> LOCAL
 *
 * Decision logic:
 * - critical/dead/low_compute tier -> always FREE_CLOUD (hard floor)
 * - normal/high tier + profitable -> PAID
 * - normal/high tier + unprofitable -> FREE_CLOUD
 * - On pool exhaustion (all providers 429/500) -> cascade to next pool
 *
 * For the PAID pool: delegates to the InferenceRouter (which knows about
 * Anthropic native API, OpenAI, Groq paid).
 *
 * For FREE_CLOUD and LOCAL pools: iterates through each provider directly
 * using OpenAI-compatible /v1/chat/completions calls (Mistral free, Ollama).
 */

import type BetterSqlite3 from "better-sqlite3";
import type { CascadePool, SurvivalTier, InferenceRequest, InferenceResult } from "../types.js";
import type { InferenceRouter } from "./router.js";
import { getProvidersForPool, getNextPool } from "./pools.js";
import type { ProviderConfig, ModelConfig } from "./provider-registry.js";
import { createLogger } from "../observability/logger.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("cascade");

/** Cache P&L for 5 minutes to avoid constant DB queries */
const PNL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Timeout for direct provider calls */
const PROVIDER_TIMEOUT_MS = 60_000;

interface PnlCache {
  netCents: number;
  revenueCents: number;
  expenseCents: number;
  cachedAt: number;
}

/**
 * Pick the best model from a provider for the given task.
 * Prefers: reasoning for agent_turn/planning, fast for heartbeat, cheap for safety.
 */
function pickModel(provider: ProviderConfig, taskType: string): ModelConfig | null {
  const models = provider.models;
  if (models.length === 0) return null;

  // Map task types to preferred tiers
  const tierPref: Record<string, string[]> = {
    agent_turn: ["reasoning", "fast", "cheap"],
    planning: ["reasoning", "fast", "cheap"],
    heartbeat_triage: ["fast", "cheap", "reasoning"],
    safety_check: ["cheap", "fast", "reasoning"],
    summarization: ["fast", "reasoning", "cheap"],
  };

  const preferred = tierPref[taskType] ?? ["fast", "reasoning", "cheap"];
  for (const tier of preferred) {
    const match = models.find((m) => m.tier === tier);
    if (match) return match;
  }
  return models[0]; // fallback to first available
}

/**
 * Call an OpenAI-compatible /v1/chat/completions endpoint directly.
 * Used for free-tier providers (Mistral) and local (Ollama).
 */
async function callProviderDirect(
  provider: ProviderConfig,
  model: ModelConfig,
  messages: any[],
  tools: any[] | undefined,
  maxTokens: number,
  toolChoice: "auto" | "required" = "auto",
): Promise<InferenceResult> {
  const apiKey = process.env[provider.apiKeyEnvVar] || "";
  const url = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    max_tokens: maxTokens,
    stream: false,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  const startMs = Date.now();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Inference error (${provider.id}): ${response.status}: ${errorText}`,
    );
  }

  const json = await response.json() as any;
  const latencyMs = Date.now() - startMs;

  const choice = json.choices?.[0];
  // Normalize content: some providers return an array of content parts
  const rawContent = choice?.message?.content;
  const content = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((p: any) => p.text ?? p.content ?? "").join("")
      : String(rawContent ?? "");
  const toolCalls = choice?.message?.tool_calls?.map((tc: any) => ({
    id: tc.id,
    type: tc.type,
    function: {
      name: tc.function?.name,
      arguments: tc.function?.arguments,
    },
  }));
  const finishReason = choice?.finish_reason ?? "stop";
  const usage = json.usage ?? {};

  return {
    content,
    model: model.id,
    provider: provider.id as any,
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    costCents: 0, // free tier
    latencyMs,
    finishReason,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
  };
}

export class CascadeController {
  private db: Database;
  private pnlCache: PnlCache | null = null;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Compute 24h rolling P&L from the accounting ledger.
   * Cached for 5 minutes.
   */
  private getRollingPnl(): { netCents: number; revenueCents: number; expenseCents: number } {
    const now = Date.now();
    if (this.pnlCache && now - this.pnlCache.cachedAt < PNL_CACHE_TTL_MS) {
      return this.pnlCache;
    }

    const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    let revenueCents = 0;
    let expenseCents = 0;

    try {
      const revRow = this.db
        .prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM revenue_events WHERE created_at >= ?")
        .get(since) as { total: number } | undefined;
      revenueCents = revRow?.total ?? 0;

      const expRow = this.db
        .prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM expense_events WHERE created_at >= ?")
        .get(since) as { total: number } | undefined;
      expenseCents = expRow?.total ?? 0;
    } catch {
      // Tables may not exist yet -- treat as zero revenue/expense
    }

    const result = { netCents: revenueCents - expenseCents, revenueCents, expenseCents };
    this.pnlCache = { ...result, cachedAt: now };
    return result;
  }

  /**
   * Select the starting pool based on survival tier and profitability.
   */
  selectPool(tier: SurvivalTier): CascadePool {
    // Hard floor: low tiers always use free models
    if (tier === "dead" || tier === "critical" || tier === "low_compute") {
      return "free_cloud";
    }

    // Profit-margin check for normal/high tiers
    const pnl = this.getRollingPnl();
    if (pnl.netCents > 0) {
      logger.debug(`Cascade: profitable (net ${pnl.netCents}c) -> PAID pool`);
      return "paid";
    }

    logger.debug(`Cascade: unprofitable (net ${pnl.netCents}c) -> FREE_CLOUD pool`);
    return "free_cloud";
  }

  /**
   * Try each provider in a pool directly via OpenAI-compatible API.
   * Returns the first successful result or throws the last error.
   */
  private async tryPoolDirect(
    pool: CascadePool,
    request: InferenceRequest,
  ): Promise<InferenceResult> {
    const providers = getProvidersForPool(pool);
    let lastError: Error | null = null;

    for (const provider of providers) {
      // Check if API key is available for this provider
      const apiKey = process.env[provider.apiKeyEnvVar];
      if (!apiKey) {
        logger.debug(`Cascade: skipping ${provider.id} (no API key: ${provider.apiKeyEnvVar})`);
        continue;
      }

      const model = pickModel(provider, request.taskType);
      if (!model) {
        logger.debug(`Cascade: skipping ${provider.id} (no suitable model)`);
        continue;
      }

      try {
        // Force tool use on triage turns so the agent doesn't just emit text
        // saying "I can't help". On triage, it must call at least one tool
        // (e.g. read_file, check_credits) to make progress.
        const toolChoice = request.taskType === "heartbeat_triage" && request.tools?.length
          ? "required" as const
          : "auto" as const;
        logger.info(`Cascade: trying ${provider.id} (${model.id})`);
        const result = await callProviderDirect(
          provider,
          model,
          request.messages,
          request.tools,
          4096,
          toolChoice,
        );
        logger.info(`Cascade: ${provider.id} succeeded (${result.inputTokens}+${result.outputTokens} tokens, ${result.latencyMs}ms)`);
        return result;
      } catch (error: any) {
        const errMsg = error?.message ?? String(error);
        const isRetryable = /429|413|500|503|rate.limit|timeout/i.test(errMsg);
        logger.warn(`Cascade: ${provider.id} failed: ${errMsg.slice(0, 200)}`);
        lastError = error;

        if (!isRetryable) {
          // Non-retryable (401/403) — skip this provider, try next
          continue;
        }
        // Retryable — try next provider in this pool
        continue;
      }
    }

    throw lastError ?? new Error(`No providers available in ${pool} pool`);
  }

  /**
   * Main entry point. Replaces direct inferenceRouter.route() calls.
   *
   * 1. Select starting pool based on tier + profitability
   * 2. For PAID pool: delegate to InferenceRouter (handles Anthropic native API etc.)
   * 3. For FREE_CLOUD/LOCAL: iterate through each provider directly
   * 4. On pool exhaustion -> cascade to next pool
   * 5. Throw CascadeExhaustedError if all pools fail
   */
  async infer(
    request: InferenceRequest,
    router: InferenceRouter,
    inferenceChat: (messages: any[], options: any) => Promise<any>,
  ): Promise<InferenceResult> {
    let currentPool: CascadePool | null = this.selectPool(request.tier);

    while (currentPool) {
      const poolProviders = getProvidersForPool(currentPool);
      if (poolProviders.length === 0) {
        logger.warn(`Cascade: pool ${currentPool} has no enabled providers, skipping`);
        currentPool = getNextPool(currentPool);
        continue;
      }

      try {
        logger.info(`Cascade: trying ${currentPool} pool (${poolProviders.map((p) => p.id).join(", ")})`);

        let result: InferenceResult;

        if (currentPool === "paid") {
          // PAID pool: use the InferenceRouter which understands Anthropic native API,
          // OpenAI, and Groq paid tier with all their special handling
          result = await router.route(request, inferenceChat);
        } else {
          // FREE_CLOUD and LOCAL pools: iterate through providers directly
          // using OpenAI-compatible /v1/chat/completions calls
          result = await this.tryPoolDirect(currentPool, request);
        }

        logger.info(`Cascade: ${currentPool} pool succeeded (model: ${result.model}, provider: ${result.provider})`);
        return result;
      } catch (error: any) {
        const errMsg = error?.message ?? String(error);
        const isRetryable = /429|413|500|503|rate.limit|timeout|exhausted|No providers/i.test(errMsg);

        if (isRetryable) {
          const next = getNextPool(currentPool);
          if (next) {
            logger.warn(`Cascade: ${currentPool} pool exhausted (${errMsg.slice(0, 200)}), falling back to ${next}`);
            currentPool = next;
            continue;
          }
        }

        // Non-retryable error or no more pools
        throw error;
      }
    }

    throw new CascadeExhaustedError("All inference pools exhausted");
  }

  /** Clear the P&L cache (useful for testing) */
  clearCache(): void {
    this.pnlCache = null;
  }
}

export class CascadeExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CascadeExhaustedError";
  }
}
