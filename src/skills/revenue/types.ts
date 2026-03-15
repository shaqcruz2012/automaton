/**
 * Revenue Skill Types
 *
 * Type definitions for x402-gated revenue-generating skill endpoints.
 * Each skill tier has a price, model, and token limit defined in
 * config/pricing.json.
 */

export interface SkillRequest {
  /** The input text/content to process */
  content: string;
  /** Optional niche context for accounting */
  nicheId?: string;
  /** Optional experiment context for accounting */
  experimentId?: string;
  /** x402 payment proof (tx hash or receipt) */
  paymentProof?: string;
  /** Client IP for free-tier tracking (set by gateway) */
  clientIp?: string;
}

export interface SkillResponse {
  success: boolean;
  tier: string;
  result?: string;
  error?: string;
  requestId: string;
  /** Estimated cost to the automaton for this request */
  estimatedCostCents: number;
  /** Free-tier status note shown to the caller */
  note?: string;
}

export interface TierConfig {
  price_usd: number;
  description: string;
  max_input_tokens: number;
  model: string;
}

export interface PricingConfig {
  tiers: Record<string, TierConfig>;
}
