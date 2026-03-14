/**
 * Revenue Skill Handlers
 *
 * Three x402-gated skill endpoints that generate revenue for the automaton.
 * Each handler follows the same pattern:
 *   1. Look up tier config from pricing
 *   2. Verify x402 payment
 *   3. Check input token limits
 *   4. Call LLM via Anthropic/OpenAI API
 *   5. Log revenue (only on success)
 *   6. Log expense with actual token counts
 *   7. Return SkillResponse
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { SkillRequest, SkillResponse, PricingConfig } from "./types.js";
import { verifyPayment, recordRevenue, recordExpense } from "./payment-gate.js";

type Database = BetterSqlite3.Database;

// ─── LLM Helper ───────────────────────────────────────────────────────────────

interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Call an LLM API directly via fetch().
 *
 * Routes to the Anthropic Messages API for claude-* models and
 * to the OpenAI Chat Completions API for gpt-* models.
 * Includes a 60 s timeout via AbortController.
 */
async function callLLM(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<LLMResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    if (/^claude/i.test(model)) {
      return await callAnthropic(model, systemPrompt, userContent, maxTokens, controller.signal);
    }
    if (/^gpt/i.test(model)) {
      return await callOpenAI(model, systemPrompt, userContent, maxTokens, controller.signal);
    }
    throw new Error(`Unsupported model prefix: ${model}. Expected claude-* or gpt-*.`);
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropic(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  signal: AbortSignal,
): Promise<LLMResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as Record<string, unknown>;

  type ContentBlock = { type: string; text?: string };
  const content = Array.isArray(data.content) ? data.content as ContentBlock[] : [];
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Anthropic returned empty response content");
  }

  const usage = data.usage as Record<string, number> | undefined;
  return {
    content: text,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

async function callOpenAI(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  signal: AbortSignal,
): Promise<LLMResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const text = (message?.content as string | undefined)?.trim() ?? "";

  if (!text) {
    throw new Error("OpenAI returned empty response content");
  }

  const usage = data.usage as Record<string, number> | undefined;
  return {
    content: text,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

// ─── Skill Tier Configuration ─────────────────────────────────────────────────

interface SkillTierConfig {
  readonly systemPrompt: string;
  readonly maxOutputTokens: number;
}

const SKILL_TIERS: Readonly<Record<string, SkillTierConfig>> = {
  "summarize-basic": {
    systemPrompt:
      "You are a concise summarizer. Produce a clear, structured summary of the provided content. " +
      "Use bullet points for key takeaways. Keep it under 500 words.",
    maxOutputTokens: 2048,
  },
  "brief-standard": {
    systemPrompt:
      "You are a business analyst. Produce a structured brief with these sections:\n" +
      "## Key Findings\n" +
      "## Risks & Concerns\n" +
      "## Recommendations\n\n" +
      "Be thorough but concise. Support findings with evidence from the source material.",
    maxOutputTokens: 4096,
  },
  "brief-premium": {
    systemPrompt:
      "You are a senior strategy consultant. Produce a comprehensive deep-dive analysis with these sections:\n" +
      "## Executive Summary\n" +
      "## Key Findings\n" +
      "## Competitive Landscape\n" +
      "## Risk Assessment\n" +
      "## Strategic Recommendations\n" +
      "## Action Items\n\n" +
      "Be thorough, cite specific evidence, and provide actionable insights.",
    maxOutputTokens: 8192,
  },
};

// ─── Shared Handler ───────────────────────────────────────────────────────────

/**
 * Common handler logic for all skill tiers.
 *
 * Steps:
 *   1. Validate input content is non-empty
 *   2. Look up tier config from pricing + SKILL_TIERS
 *   3. Verify x402 payment
 *   4. Check input token limits
 *   5. Call LLM
 *   6. Log revenue (only on success)
 *   7. Log expense with actual token counts
 *   8. Return SkillResponse
 */
async function handleSkillRequest(
  db: Database,
  request: SkillRequest,
  pricing: PricingConfig,
  tierName: string,
): Promise<SkillResponse> {
  const requestId = ulid();

  // Step 1: Validate input content
  if (!request.content || request.content.trim().length === 0) {
    return {
      success: false,
      tier: tierName,
      error: "Request content must not be empty",
      requestId,
      estimatedCostCents: 0,
    };
  }

  const skillTier = SKILL_TIERS[tierName];
  if (!skillTier) {
    return {
      success: false,
      tier: tierName,
      error: `Unknown skill tier "${tierName}"`,
      requestId,
      estimatedCostCents: 0,
    };
  }

  // Step 2: Look up pricing tier
  const tierConfig = pricing.tiers[tierName];
  if (!tierConfig) {
    return {
      success: false,
      tier: tierName,
      error: `Tier "${tierName}" not found in pricing configuration`,
      requestId,
      estimatedCostCents: 0,
    };
  }

  // Step 3: Verify x402 payment
  const payment = verifyPayment(request.paymentProof, tierConfig.price_usd);
  if (!payment.verified) {
    return {
      success: false,
      tier: tierName,
      error: payment.error,
      requestId,
      estimatedCostCents: 0,
    };
  }

  // Step 4: Estimate input tokens (rough: content.length / 4)
  const inputTokensEstimate = Math.ceil(request.content.length / 4);

  if (inputTokensEstimate > tierConfig.max_input_tokens) {
    return {
      success: false,
      tier: tierName,
      error: `Input too large: ~${inputTokensEstimate} tokens exceeds ${tierConfig.max_input_tokens} token limit for ${tierName}`,
      requestId,
      estimatedCostCents: 0,
    };
  }

  // Step 5: Call LLM
  let llmResponse: LLMResponse;
  try {
    llmResponse = await callLLM(
      tierConfig.model,
      skillTier.systemPrompt,
      request.content,
      skillTier.maxOutputTokens,
    );
  } catch (err) {
    return {
      success: false,
      tier: tierName,
      error: `Inference failed: ${err instanceof Error ? err.message : String(err)}`,
      requestId,
      estimatedCostCents: 0,
    };
  }

  // Step 6: Log revenue (only after successful inference)
  const amountCents = Math.round(tierConfig.price_usd * 100);
  recordRevenue(db, {
    tier: tierName,
    amountCents,
    requestId,
    nicheId: request.nicheId,
    experimentId: request.experimentId,
    paymentProof: request.paymentProof,
  });

  // Step 7: Log expense with actual token counts
  const estimatedCostCents = recordExpense(db, {
    tier: tierName,
    model: tierConfig.model,
    inputTokensEstimate: llmResponse.inputTokens + llmResponse.outputTokens,
    requestId,
    nicheId: request.nicheId,
    experimentId: request.experimentId,
  });

  return {
    success: true,
    tier: tierName,
    result: llmResponse.content,
    requestId,
    estimatedCostCents,
  };
}

// ─── Exported Handlers ────────────────────────────────────────────────────────

/** /summarize-basic -- High-volume, low-ticket summarization */
export function handleSummarizeBasic(db: Database, request: SkillRequest, pricing: PricingConfig): Promise<SkillResponse> {
  return handleSkillRequest(db, request, pricing, "summarize-basic");
}

/** /brief-standard -- Mid-ticket structured brief */
export function handleBriefStandard(db: Database, request: SkillRequest, pricing: PricingConfig): Promise<SkillResponse> {
  return handleSkillRequest(db, request, pricing, "brief-standard");
}

/** /brief-premium -- Low-volume, high-ticket deep dive */
export function handleBriefPremium(db: Database, request: SkillRequest, pricing: PricingConfig): Promise<SkillResponse> {
  return handleSkillRequest(db, request, pricing, "brief-premium");
}
