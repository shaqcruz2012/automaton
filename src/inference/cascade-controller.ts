/**
 * Cascade Controller
 *
 * Sits above the InferenceRouter and decides which provider pool to use
 * based on the agent's profitability and survival tier.
 *
 * Pool cascade: LOCAL -> FREE_CLOUD -> PAID
 *
 * Decision logic:
 * - critical/dead/low_compute tier -> always LOCAL (local-first)
 * - normal/high tier + profitable -> PAID
 * - normal/high tier + unprofitable -> LOCAL
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

/**
 * Detect message-format / validation 400 errors that are worth cascading.
 * These typically come from providers rejecting the message structure
 * (e.g., Mistral: "Expected last role User or Tool but got assistant").
 * Auth errors (invalid API key) should NOT cascade — they'll fail everywhere.
 */
function isCascadable400(errMsg: string): boolean {
  if (!/\b400\b/.test(errMsg)) return false;
  // Message-ordering errors fail identically on every provider — don't cascade
  if (/message.order|role.*order|last.role|Expected.*role/i.test(errMsg)) return false;
  // Groq tool_use_failed: model generates XML-style function calls instead of JSON.
  // Always cascade — retrying the same provider won't fix the model's output format.
  if (/tool_use_failed|failed_generation|Failed to call a function/i.test(errMsg)) return true;
  // Only cascade on message-format / validation errors, NOT auth issues
  const validationPatterns = /format|expected|invalid.*content|validation|schema|field|parameter/i;
  const authPatterns = /api.key|auth|token|credential|unauthorized|forbidden/i;
  return validationPatterns.test(errMsg) && !authPatterns.test(errMsg);
}

/** Cache P&L for 2 minutes to avoid constant DB queries */
const PNL_CACHE_TTL_MS = 2 * 60 * 1000;

/** Default timeout for direct provider calls (used as fallback) */
const PROVIDER_TIMEOUT_MS = 60_000;

/**
 * Compute a dynamic timeout that scales with request size.
 * - 15s minimum (small safety checks ~512 tokens)
 * - 2ms per requested token
 * - 120s maximum (large reasoning tasks ~8K tokens)
 */
function computeTimeoutMs(maxTokens: number | undefined): number {
  return Math.min(120_000, Math.max(15_000, 15_000 + (maxTokens ?? 4096) * 2));
}

/** Circuit breaker: disable provider after this many consecutive failures */
const CB_FAILURE_THRESHOLD = 3;
/** Circuit breaker: keep provider disabled for this long */
const CB_DISABLE_MS = 2 * 60_000;

interface CircuitBreakerState {
  failures: number;
  disabledUntil: number;
}

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
 * Sanitize messages for OpenAI-compatible providers (Mistral, Ollama).
 * - Merges consecutive same-role messages
 * - Ensures last message is user or tool (Mistral requirement)
 */
function sanitizeMessagesForOpenAI(messages: any[]): any[] {
  // 1. Merge consecutive same-role messages
  const merged: any[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role && msg.role !== "system" && msg.role !== "tool") {
      merged[merged.length - 1] = {
        ...last,
        content: (last.content || "") + "\n" + (msg.content || ""),
        tool_calls: msg.tool_calls
          ? [...(last.tool_calls || []), ...msg.tool_calls]
          : last.tool_calls,
      };
    } else {
      merged.push({ ...msg });
    }
  }

  // 2. Ensure last message is user or tool
  if (merged.length > 0) {
    const last = merged[merged.length - 1];
    if (last.role === "assistant") {
      merged.push({ role: "user", content: "Continue." });
    }
  }

  return merged;
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

  const sanitized = sanitizeMessagesForOpenAI(messages);
  const body: Record<string, unknown> = {
    model: model.id,
    messages: sanitized,
    max_tokens: maxTokens,
    stream: false,
  };

  // Ollama defaults to 2048 context tokens unless num_ctx is explicitly set.
  // Pass the model's full contextWindow so Ollama actually uses it.
  if (provider.pool === "local" && model.contextWindow) {
    body.options = { num_ctx: model.contextWindow };
  }

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
    signal: AbortSignal.timeout(computeTimeoutMs(maxTokens)),
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
  const toolCalls = choice?.message?.tool_calls?.map((tc: any) => {
    // Ollama may return undefined/null/short/invalid tool call IDs.
    // Normalize to a 9-char alphanumeric ID so downstream code always has a valid one.
    const generateId = () => "call_" + Math.random().toString(36).slice(2, 11);
    const normalized = (tc.id || "").toString().replace(/[^a-zA-Z0-9]/g, "").slice(0, 9).padEnd(9, "0");
    const id = normalized && normalized !== "000000000" ? normalized : generateId();

    // Ollama may return function.arguments as an object instead of a string.
    const rawArgs = tc.function?.arguments;
    const args = typeof rawArgs === "object" && rawArgs !== null
      ? JSON.stringify(rawArgs)
      : rawArgs;

    return {
      id,
      type: tc.type,
      function: {
        name: tc.function?.name,
        arguments: args,
      },
    };
  });
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
  private readonly circuitBreaker = new Map<string, CircuitBreakerState>();
  /** Tracks the last call timestamp per provider for rate limit enforcement.
   *  In-memory only — resets on process restart (same as circuit breaker). */
  private readonly lastCallTimestamp = new Map<string, number>();

  constructor(db: Database) {
    this.db = db;
  }

  /** Check if a provider's circuit breaker is open (temporarily disabled). */
  private isCircuitOpen(providerId: string): boolean {
    const state = this.circuitBreaker.get(providerId);
    if (!state) return false;
    if (state.disabledUntil > Date.now()) return true;
    // Only reset if the breaker was actually opened and has now expired.
    // When disabledUntil is 0, the breaker was never opened — don't erase
    // accumulated failures, or the threshold can never be reached.
    if (state.disabledUntil > 0) {
      this.circuitBreaker.set(providerId, { failures: 0, disabledUntil: 0 });
    }
    return false;
  }

  /** Record a failure. Opens circuit after CB_FAILURE_THRESHOLD consecutive failures. */
  private recordFailure(providerId: string): void {
    const prev = this.circuitBreaker.get(providerId) ?? { failures: 0, disabledUntil: 0 };
    const failures = prev.failures + 1;
    if (failures >= CB_FAILURE_THRESHOLD) {
      logger.warn(`Cascade: circuit breaker OPEN for ${providerId} (${failures} failures, disabled for ${CB_DISABLE_MS / 1000}s)`);
    }
    this.circuitBreaker.set(providerId, { failures, disabledUntil: failures >= CB_FAILURE_THRESHOLD ? Date.now() + CB_DISABLE_MS : prev.disabledUntil });
  }

  /** Record a success. Resets the circuit breaker for this provider. */
  private recordSuccess(providerId: string): void {
    this.circuitBreaker.set(providerId, { failures: 0, disabledUntil: 0 });
  }

  /**
   * Compute 24h rolling P&L from the accounting ledger.
   * Cached for 2 minutes.
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
   * Select the starting pool based on survival tier, profitability, and task type.
   */
  selectPool(tier: SurvivalTier, taskType?: string): CascadePool {
    // Dead/critical: zero-cost local inference only (survive at all costs)
    if (tier === "dead" || tier === "critical") {
      return "local";
    }

    // Groq free tier only works for small-context tasks (heartbeat_triage ~5K tokens).
    // Agent turns accumulate large conversation context that exceeds Groq's TPM limits,
    // causing 413 on every attempt. Route only triage to free_cloud; everything else
    // goes straight to paid to avoid wasted cascade latency.
    if (taskType === "heartbeat_triage") {
      logger.debug(`Cascade: tier=${tier}, task=${taskType} -> FREE_CLOUD pool (Groq triage)`);
      return "free_cloud";
    }

    logger.debug(`Cascade: tier=${tier}, task=${taskType} -> PAID pool (skip Groq for large context)`);
    return "paid";
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
      // Circuit breaker: skip providers that have failed too many times recently
      if (this.isCircuitOpen(provider.id)) {
        logger.debug(`Cascade: skipping ${provider.id} (circuit breaker open)`);
        continue;
      }

      // Check if API key is available for this provider.
      // Local providers (Ollama/vLLM) don't need an API key.
      const apiKey = process.env[provider.apiKeyEnvVar];
      if (!apiKey && provider.pool !== "local") {
        logger.debug(`Cascade: skipping ${provider.id} (no API key: ${provider.apiKeyEnvVar})`);
        continue;
      }

      // Rate limit: enforce minimum interval between calls per provider.
      // For Mistral at 2 RPM this means 30s between calls; for Ollama at 100 RPM, 600ms.
      // This prevents us from hitting server-side 429s proactively.
      if (provider.maxRequestsPerMinute > 0) {
        const minIntervalMs = 60_000 / provider.maxRequestsPerMinute;
        const lastCall = this.lastCallTimestamp.get(provider.id) ?? 0;
        const elapsed = Date.now() - lastCall;
        if (elapsed < minIntervalMs) {
          logger.debug(
            `Cascade: skipping ${provider.id} (rate limit: ${Math.ceil(minIntervalMs - elapsed)}ms until next allowed call)`,
          );
          continue;
        }
      }

      const model = pickModel(provider, request.taskType);
      if (!model) {
        logger.debug(`Cascade: skipping ${provider.id} (no suitable model)`);
        continue;
      }

      try {
        // Force tool use on triage AND agent_turn so the model must make actual
        // tool calls instead of outputting JSON-as-text. Triage needs read_file;
        // agent_turn needs exec/check_credits/write_file/sleep. Only planning
        // and summarization should allow text-only responses.
        //
        // EXCEPTION: Groq's Llama models generate malformed XML-style function calls
        // (e.g. <function=read_file{...}>) when tool_choice is "required".
        // Use "auto" for Groq — it still makes tool calls, just doesn't guarantee them.
        const forceTools = (request.taskType === "heartbeat_triage" || request.taskType === "agent_turn")
          && request.tools?.length;
        const isGroqLlama = provider.id === "groq";
        const toolChoice = (forceTools && !isGroqLlama)
          ? "required" as const
          : "auto" as const;
        logger.info(`Cascade: trying ${provider.id} (${model.id})`);
        // Record call timestamp BEFORE the call (not after) so concurrent
        // requests don't both slip through the rate window.
        this.lastCallTimestamp.set(provider.id, Date.now());
        // Use the model's registered maxOutputTokens (e.g. 8192 for magistral)
        // instead of hardcoded 4096. Reasoning models need room for chain-of-thought
        // BEFORE emitting tool calls — 4096 caused finish_reason: "length" truncation.
        const maxTokens = request.maxTokens ?? model.maxOutputTokens ?? 4096;
        const result = await callProviderDirect(
          provider,
          model,
          request.messages,
          request.tools,
          maxTokens,
          toolChoice,
        );
        logger.info(`Cascade: ${provider.id} succeeded (${result.inputTokens}+${result.outputTokens} tokens, ${result.latencyMs}ms)`);
        this.recordSuccess(provider.id);
        return result;
      } catch (error: any) {
        const errMsg = error?.message ?? String(error);
        const isRetryable = /429|413|500|503|rate.limit|timeout/i.test(errMsg)
          || isCascadable400(errMsg);
        logger.warn(`Cascade: ${provider.id} failed: ${errMsg.slice(0, 200)}`);

        // Ollama-specific: connection refused or OOM are infrastructure issues,
        // not provider failures. Don't circuit-break — just cascade immediately.
        const isInfraError = /ECONNREFUSED|ECONNRESET|ENOTFOUND|system memory/i.test(errMsg);
        if (isInfraError) {
          logger.warn(`Cascade: ${provider.id} infrastructure error (not circuit-breaking): ${errMsg.slice(0, 200)}`);
          lastError = error;
          continue;
        }

        // Groq tool_use_failed: model generates XML instead of JSON tool calls.
        // This is a model limitation, not a provider outage — don't circuit-break.
        const isToolFormatError = /tool_use_failed|failed_generation|Failed to call a function/i.test(errMsg);
        if (isToolFormatError) {
          logger.warn(`Cascade: ${provider.id} tool format error (not circuit-breaking): ${errMsg.slice(0, 200)}`);
          lastError = error;
          continue;
        }

        this.recordFailure(provider.id);
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
    const startingPool = this.selectPool(request.tier, request.taskType);
    let currentPool: CascadePool | null = startingPool;
    let lastErrorMsg = "";
    const triedPools = new Set<CascadePool>();

    while (currentPool) {
      triedPools.add(currentPool);
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
        lastErrorMsg = errMsg;
        const isRetryable = /429|413|500|503|rate.limit|timeout|exhausted|No providers/i.test(errMsg)
          || isCascadable400(errMsg);

        if (isRetryable) {
          const next = getNextPool(currentPool);
          if (next) {
            // Guard: dead/critical tiers must never cascade into paid APIs
            if (next === "paid" && (request.tier === "dead" || request.tier === "critical")) {
              throw new CascadeExhaustedError(
                `Cascade exhausted free providers for tier=${request.tier}, refusing to cascade to paid APIs`,
              );
            }
            logger.warn(`Cascade: ${currentPool} pool exhausted (${errMsg.slice(0, 200)}), falling back to ${next}`);
            currentPool = next;
            continue;
          }
          // End of cascade chain — try LOCAL as last resort if not already tried.
          // This covers the case where PAID is the terminal pool but Ollama is available.
          if (!triedPools.has("local")) {
            logger.warn(`Cascade: ${currentPool} pool exhausted, last-resort fallback to LOCAL`);
            currentPool = "local";
            continue;
          }
        }

        // Non-retryable error or no more pools
        throw error;
      }
    }

    // Preserve the underlying error (e.g., "429: Rate limit exceeded") in the
    // message so the loop's rate-limit handler can detect it and apply backoff.
    throw new CascadeExhaustedError(
      `All inference pools exhausted${lastErrorMsg ? ` (${lastErrorMsg.slice(0, 200)})` : ""}`,
    );
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
