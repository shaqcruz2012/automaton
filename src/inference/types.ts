/**
 * Inference & Model Strategy — Internal Types
 *
 * Re-exports shared types from types.ts and defines internal constants
 * for the inference routing subsystem.
 */

export type {
  SurvivalTier,
  ModelProvider,
  CascadePool,
  InferenceTaskType,
  ModelEntry,
  ModelPreference,
  RoutingMatrix,
  InferenceRequest,
  InferenceResult,
  InferenceCostRow,
  ModelRegistryRow,
  ModelStrategyConfig,
  ChatMessage,
} from "../types.js";

import type {
  RoutingMatrix,
  ModelEntry,
  ModelStrategyConfig,
} from "../types.js";

// === Default Retry Policy ===

export const DEFAULT_RETRY_POLICY = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
} as const;

// === Per-Task Timeout Overrides (ms) ===

export const TASK_TIMEOUTS: Record<string, number> = {
  heartbeat_triage: 120_000,
  safety_check: 120_000,
  summarization: 180_000,
  agent_turn: 300_000,
  planning: 300_000,
};

// === Static Model Baseline ===
// Known models with realistic pricing (hundredths of cents per 1k tokens)

export const STATIC_MODEL_BASELINE: Omit<ModelEntry, "lastSeen" | "createdAt" | "updatedAt">[] = [
  // ── Anthropic (primary) ──────────────────────────────────────
  {
    modelId: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    displayName: "Claude Haiku 4",
    tierMinimum: "critical",
    costPer1kInput: 8,     // $0.80/M input
    costPer1kOutput: 32,   // $3.20/M output
    maxTokens: 8192,
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  {
    modelId: "claude-sonnet-4-20250514",
    provider: "anthropic",
    displayName: "Claude Sonnet 4",
    tierMinimum: "normal",
    costPer1kInput: 30,    // $3.00/M input
    costPer1kOutput: 150,  // $15.00/M output
    maxTokens: 8192,
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  // ── Groq (free, fast) ───────────────────────────────────────
  {
    modelId: "llama-3.3-70b-versatile",
    provider: "groq",
    displayName: "Llama 3.3 70B (Groq)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  {
    modelId: "llama-3.1-8b-instant",
    provider: "groq",
    displayName: "Llama 3.1 8B Instant (Groq)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  // ── OpenAI (secondary/fallback) ──────────────────────────────
  {
    modelId: "gpt-5.2",
    provider: "openai",
    displayName: "GPT-5.2",
    tierMinimum: "normal",
    costPer1kInput: 18,    // $1.75/M = 175 cents/M = 0.175 cents/1k = 17.5 hundredths ≈ 18
    costPer1kOutput: 140,  // $14.00/M = 1400 cents/M = 1.4 cents/1k = 140 hundredths
    maxTokens: 32768,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-4.1",
    provider: "openai",
    displayName: "GPT-4.1",
    tierMinimum: "normal",
    costPer1kInput: 20,    // $2.00/M
    costPer1kOutput: 80,   // $8.00/M
    maxTokens: 32768,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-4.1-mini",
    provider: "openai",
    displayName: "GPT-4.1 Mini",
    tierMinimum: "low_compute",
    costPer1kInput: 4,     // $0.40/M
    costPer1kOutput: 16,   // $1.60/M
    maxTokens: 16384,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-4.1-nano",
    provider: "openai",
    displayName: "GPT-4.1 Nano",
    tierMinimum: "critical",
    costPer1kInput: 1,     // $0.10/M
    costPer1kOutput: 4,    // $0.40/M
    maxTokens: 16384,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-5-mini",
    provider: "openai",
    displayName: "GPT-5 Mini",
    tierMinimum: "low_compute",
    costPer1kInput: 8,     // $0.80/M
    costPer1kOutput: 32,   // $3.20/M
    maxTokens: 16384,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-5.3",
    provider: "openai",
    displayName: "GPT-5.3",
    tierMinimum: "normal",
    costPer1kInput: 20,    // $2.00/M
    costPer1kOutput: 80,   // $8.00/M
    maxTokens: 32768,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  // ── Cerebras (free tier) ──────────────────────────────────────
  {
    modelId: "qwen-3-235b-instruct",
    provider: "cerebras",
    displayName: "Qwen3 235B Instruct (Cerebras)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  {
    modelId: "llama-4-scout-17b-16e-instruct",
    provider: "cerebras",
    displayName: "Llama 4 Scout 17B (Cerebras)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  {
    modelId: "llama3.1-8b",
    provider: "cerebras",
    displayName: "Llama 3.1 8B (Cerebras)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  // ── SambaNova (free tier) ─────────────────────────────────────
  {
    modelId: "Meta-Llama-3.3-70B-Instruct",
    provider: "sambanova",
    displayName: "Llama 3.3 70B (SambaNova)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  {
    modelId: "Meta-Llama-3.1-8B-Instruct",
    provider: "sambanova",
    displayName: "Llama 3.1 8B (SambaNova)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 4096,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  // ── HuggingFace (free tier) ───────────────────────────────────
  {
    modelId: "meta-llama/Llama-3.3-70B-Instruct",
    provider: "huggingface",
    displayName: "Llama 3.3 70B (HuggingFace)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  {
    modelId: "Qwen/Qwen2.5-72B-Instruct",
    provider: "huggingface",
    displayName: "Qwen 2.5 72B (HuggingFace)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 32768,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  // ── Mistral (free tier — 2 req/min) ─────────────────────────────
  {
    modelId: "magistral-small-latest",
    provider: "mistral",
    displayName: "Magistral Small (Mistral Free)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  {
    modelId: "mistral-small-latest",
    provider: "mistral",
    displayName: "Mistral Small (Mistral Free)",
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
  },
];

// === Default Routing Matrix ===
// Maps (tier, taskType) -> ModelPreference with candidate models

export const DEFAULT_ROUTING_MATRIX: RoutingMatrix = {
  high: {
    agent_turn: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"], maxTokens: 8192, ceilingCents: -1 },
    heartbeat_triage: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
    safety_check: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: 20 },
    summarization: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: 15 },
    planning: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"], maxTokens: 8192, ceilingCents: -1 },
  },
  normal: {
    agent_turn: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: -1 },
    heartbeat_triage: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
    safety_check: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: 10 },
    summarization: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: 10 },
    planning: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: -1 },
  },
  low_compute: {
    agent_turn: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 4096, ceilingCents: 10 },
    heartbeat_triage: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 1024, ceilingCents: 2 },
    safety_check: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
    summarization: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
    planning: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 5 },
  },
  critical: {
    agent_turn: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 2048, ceilingCents: 3 },
    heartbeat_triage: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 512, ceilingCents: 1 },
    safety_check: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "claude-haiku-4-5-20251001"], maxTokens: 1024, ceilingCents: 2 },
    summarization: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    planning: { candidates: [], maxTokens: 0, ceilingCents: 0 },
  },
  dead: {
    agent_turn: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], maxTokens: 2048, ceilingCents: 0 },
    heartbeat_triage: { candidates: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], maxTokens: 512, ceilingCents: 0 },
    safety_check: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    summarization: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    planning: { candidates: [], maxTokens: 0, ceilingCents: 0 },
  },
};

// === Default Model Strategy Config ===

export const DEFAULT_MODEL_STRATEGY_CONFIG: ModelStrategyConfig = {
  inferenceModel: "llama-3.3-70b-versatile",
  lowComputeModel: "llama-3.3-70b-versatile",
  criticalModel: "llama-3.3-70b-versatile",
  maxTokensPerTurn: 4096,
  hourlyBudgetCents: 0,
  sessionBudgetCents: 0,
  perCallCeilingCents: 0,
  enableModelFallback: true,
  anthropicApiVersion: "2023-06-01",
};
