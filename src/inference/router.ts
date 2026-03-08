/**
 * Inference Router
 *
 * Routes inference requests through the model registry using
 * tier-based selection, budget enforcement, and provider-specific
 * message transformation.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEntry,
  SurvivalTier,
  InferenceTaskType,
  ModelProvider,
  ChatMessage,
  ModelPreference,
} from "../types.js";
import { ModelRegistry } from "./registry.js";
import { InferenceBudgetTracker } from "./budget.js";
import { DEFAULT_ROUTING_MATRIX, TASK_TIMEOUTS } from "./types.js";

type Database = BetterSqlite3.Database;

export class InferenceRouter {
  private db: Database;
  private registry: ModelRegistry;
  private budget: InferenceBudgetTracker;

  constructor(db: Database, registry: ModelRegistry, budget: InferenceBudgetTracker) {
    this.db = db;
    this.registry = registry;
    this.budget = budget;
  }

  /**
   * Route an inference request: select model, check budget,
   * transform messages, call inference, record cost.
   */
  async route(
    request: InferenceRequest,
    inferenceChat: (messages: any[], options: any) => Promise<any>,
  ): Promise<InferenceResult> {
    const { messages, taskType, tier, sessionId, turnId, tools } = request;

    // 1. Select ALL eligible candidate models (not just the first)
    const candidates = this.selectCandidates(tier, taskType);
    if (candidates.length === 0) {
      return {
        content: "",
        model: "none",
        provider: "other",
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "error",
        toolCalls: undefined,
      };
    }

    // Try each candidate model; on retryable errors (429, 413, 500, 503) try the next
    let lastError: any = null;
    for (const model of candidates) {
      try {
        return await this.routeWithModel(model, request, inferenceChat);
      } catch (error: any) {
        lastError = error;
        const errMsg = error?.message ?? String(error);
        const isRetryable = /429|413|500|503|rate.limit/i.test(errMsg);
        if (isRetryable && candidates.indexOf(model) < candidates.length - 1) {
          // Try next candidate
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  /**
   * Route with a specific model. Extracted from route() for model-level failover.
   */
  private async routeWithModel(
    model: ModelEntry,
    request: InferenceRequest,
    inferenceChat: (messages: any[], options: any) => Promise<any>,
  ): Promise<InferenceResult> {
    const { messages, taskType, tier, sessionId, turnId, tools } = request;

    // 2. Estimate cost and check budget
    // Use char/3 for conservative estimate (code/JSON is denser than prose)
    const estimatedTokens = messages.reduce((sum, m) => sum + (m.content?.length || 0) / 3, 0);
    // costPer1kInput is already in hundredths-of-cent per 1k tokens.
    // No /100 needed — that was double-dividing, making costs 100x too small.
    const estimatedCostCents = Math.ceil(
      (estimatedTokens / 1000) * model.costPer1kInput +
      (request.maxTokens || 1000) / 1000 * model.costPer1kOutput,
    );

    const budgetCheck = this.budget.checkBudget(estimatedCostCents, model.modelId);
    if (!budgetCheck.allowed) {
      return {
        content: `Budget exceeded: ${budgetCheck.reason}`,
        model: model.modelId,
        provider: model.provider,
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "budget_exceeded",
      };
    }

    // 3. Check session budget
    if (request.sessionId && this.budget.config.sessionBudgetCents > 0) {
      const sessionCost = this.budget.getSessionCost(request.sessionId);
      if (sessionCost + estimatedCostCents > this.budget.config.sessionBudgetCents) {
        return {
          content: `Session budget exceeded: ${sessionCost}c spent + ${estimatedCostCents}c estimated > ${this.budget.config.sessionBudgetCents}c limit`,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          latencyMs: 0,
          finishReason: "budget_exceeded",
        };
      }
    }

    // 4. Transform messages for provider
    const transformedMessages = this.transformMessagesForProvider(messages, model.provider);

    // 5. Build inference options
    const preference = this.getPreference(tier, taskType);
    const maxTokens = request.maxTokens || preference?.maxTokens || model.maxTokens;
    const timeout = TASK_TIMEOUTS[taskType] || 120_000;

    // Force tool use on triage AND agent_turn so the model must make actual
    // tool calls instead of outputting JSON-as-text (mirrors cascade-controller logic).
    const forceTools = (taskType === "heartbeat_triage" || taskType === "agent_turn")
      && tools?.length;
    const toolChoice = forceTools ? "required" : "auto";

    const inferenceOptions: any = {
      model: model.modelId,
      maxTokens,
      tools: tools,
      tool_choice: toolChoice,
    };

    // 6. Call inference with timeout
    const startTime = Date.now();
    let response: any;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        inferenceOptions.signal = controller.signal;
        response = await inferenceChat(transformedMessages, inferenceOptions);
      } finally {
        clearTimeout(timer);
      }
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      if (error.name === "AbortError") {
        return {
          content: `Inference timeout after ${timeout}ms`,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          latencyMs,
          finishReason: "timeout",
        };
      }
      throw error;
    }
    const latencyMs = Date.now() - startTime;

    // 7. Calculate actual cost
    // UnifiedInferenceResult.usage uses inputTokens/outputTokens (not promptTokens/completionTokens)
    const inputTokens = response.usage?.inputTokens || response.usage?.promptTokens || 0;
    const outputTokens = response.usage?.outputTokens || response.usage?.completionTokens || 0;
    const actualCostCents = Math.ceil(
      (inputTokens / 1000) * model.costPer1kInput +
      (outputTokens / 1000) * model.costPer1kOutput,
    );

    // 8. Record cost
    this.budget.recordCost({
      sessionId,
      turnId: turnId || null,
      model: model.modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      costCents: actualCostCents,
      latencyMs,
      tier,
      taskType,
      cacheHit: false,
    });

    // 9. Build result
    return {
      content: response.message?.content || "",
      model: model.modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      costCents: actualCostCents,
      latencyMs,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason || "stop",
    };
  }

  /**
   * Select the best model for a given tier and task type.
   *
   * Priority:
   *   1. First routing-matrix candidate present in the registry
   *   2. User-configured model(s) from ModelStrategyConfig
   *      (free/Ollama models are allowed at any tier, including dead)
   */
  /**
   * Select ALL eligible candidate models for failover.
   * Returns models in priority order — first candidate is preferred.
   */
  selectCandidates(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry[] {
    const results: ModelEntry[] = [];
    const seen = new Set<string>();

    // 1. Routing-matrix candidates
    const preference = this.getPreference(tier, taskType);
    if (preference) {
      for (const candidateId of preference.candidates) {
        if (seen.has(candidateId)) continue;
        const entry = this.registry.get(candidateId);
        if (entry && entry.enabled) {
          results.push(entry);
          seen.add(candidateId);
        }
      }
    }

    // 2. User-configured fallbacks
    const TIER_ORDER: Record<string, number> = {
      dead: 0, critical: 1, low_compute: 2, normal: 3, high: 4,
    };
    const tierRank = TIER_ORDER[tier] ?? 0;
    const strategy = this.budget.config;
    const fallbackIds: (string | undefined)[] =
      tier === "critical" || tier === "dead"
        ? [strategy.criticalModel, strategy.inferenceModel, strategy.lowComputeModel]
        : [strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel];

    for (const modelId of fallbackIds) {
      if (!modelId || seen.has(modelId)) continue;
      const entry = this.registry.get(modelId);
      if (!entry || !entry.enabled) continue;
      const isFree = entry.costPer1kInput === 0 && entry.costPer1kOutput === 0;
      const tierOk = tierRank >= (TIER_ORDER[entry.tierMinimum] ?? 0);
      if (isFree || tierOk) {
        results.push(entry);
        seen.add(modelId);
      }
    }

    return results;
  }

  selectModel(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry | null {
    const TIER_ORDER: Record<string, number> = {
      dead: 0, critical: 1, low_compute: 2, normal: 3, high: 4,
    };

    const tierRank = TIER_ORDER[tier] ?? 0;

    // 1. Try routing-matrix candidates
    const preference = this.getPreference(tier, taskType);
    if (preference && preference.candidates.length > 0) {
      for (const candidateId of preference.candidates) {
        const entry = this.registry.get(candidateId);
        if (entry && entry.enabled) {
          return entry;
        }
      }
    }

    // 2. Fall back to user-configured models.
    //    This handles local/Ollama setups where routing-matrix models are absent.
    const strategy = this.budget.config;
    const fallbackIds: (string | undefined)[] =
      tier === "critical" || tier === "dead"
        ? [strategy.criticalModel, strategy.inferenceModel, strategy.lowComputeModel]
        : [strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel];

    for (const modelId of fallbackIds) {
      if (!modelId) continue;
      const entry = this.registry.get(modelId);
      if (!entry || !entry.enabled) continue;
      const isFree = entry.costPer1kInput === 0 && entry.costPer1kOutput === 0;
      const tierOk = tierRank >= (TIER_ORDER[entry.tierMinimum] ?? 0);
      if (isFree || tierOk) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Transform messages for a specific provider.
   * Handles Anthropic's alternating-role requirement.
   */
  transformMessagesForProvider(messages: ChatMessage[], provider: ModelProvider): ChatMessage[] {
    if (messages.length === 0) {
      throw new Error("Cannot route inference with empty message array");
    }

    if (provider === "anthropic") {
      return this.fixAnthropicMessages(messages);
    }

    // For OpenAI-compatible backends, merge consecutive same-role messages
    return this.mergeConsecutiveSameRole(messages);
  }

  /**
   * Fix messages for Anthropic's API requirements.
   *
   * The downstream inference client (chatViaAnthropic /
   * transformMessagesForAnthropic) already handles the full Anthropic
   * message transformation including:
   *   - Extracting system messages into a top-level `system` field
   *   - Converting tool messages to user messages with tool_result blocks
   *   - Merging consecutive same-role messages
   *   - Converting assistant tool_calls to tool_use content blocks
   *
   * The router must NOT pre-transform tool messages into plain-text user
   * messages, because that destroys the tool_call_id / role:"tool" metadata
   * the downstream transformer needs to produce proper tool_result blocks.
   *
   * We only perform safe structural fixes here:
   *   - Ensure the message array is non-empty
   *   - Pass messages through unchanged so the inference client can handle them
   */
  private fixAnthropicMessages(messages: ChatMessage[]): ChatMessage[] {
    // Pass through as-is. The Anthropic inference client's
    // transformMessagesForAnthropic() handles the full conversion from
    // OpenAI-format (role:"tool") to Anthropic-format (role:"user" with
    // tool_result content blocks), including merging consecutive same-role
    // messages. Pre-transforming here would destroy the metadata needed
    // for correct tool_result block generation.
    return messages;
  }

  /**
   * Merge consecutive messages with the same role.
   */
  private mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role && msg.role !== "system" && msg.role !== "tool") {
        // Replace last element with a new merged object (immutable)
        result[result.length - 1] = {
          ...last,
          content: (last.content || "") + "\n" + (msg.content || ""),
          tool_calls: msg.tool_calls
            ? [...(last.tool_calls || []), ...msg.tool_calls.map(tc => ({ ...tc }))]
            : last.tool_calls,
        };
        continue;
      }
      result.push({ ...msg, tool_calls: msg.tool_calls?.map(tc => ({ ...tc })) });
    }

    return result;
  }

  private getPreference(tier: SurvivalTier, taskType: InferenceTaskType): ModelPreference | undefined {
    return DEFAULT_ROUTING_MATRIX[tier]?.[taskType];
  }
}
