/**
 * Revenue Skills Registry
 *
 * Exports all revenue skill handlers, loads pricing configuration,
 * and provides a dispatcher for routing skill requests to handlers.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type BetterSqlite3 from "better-sqlite3";
import type { SkillRequest, SkillResponse, PricingConfig } from "./types.js";
import {
  handleSummarizeBasic,
  handleBriefStandard,
  handleBriefPremium,
} from "./handlers.js";

type Database = BetterSqlite3.Database;

// Re-export types for convenience
export type { SkillRequest, SkillResponse, PricingConfig } from "./types.js";
export type { TierConfig } from "./types.js";

// Re-export handlers
export { handleSummarizeBasic, handleBriefStandard, handleBriefPremium };

// Re-export URL summarizer earning skill
export { summarizeUrlForClient, SKILL_METADATA as URL_SUMMARIZER_METADATA } from "./url-summarizer.js";

// Re-export payment gate functions
export { verifyPayment, recordRevenue, recordExpense } from "./payment-gate.js";

/**
 * Built-in default pricing config, used as fallback when
 * config/pricing.json is not found on disk.
 */
const DEFAULT_PRICING: PricingConfig = {
  tiers: {
    "summarize-basic": {
      price_usd: 0.25,
      description: "High-volume summarization of text, articles, or documents",
      max_input_tokens: 4000,
      model: "claude-haiku-4-5-20251001",
    },
    "brief-standard": {
      price_usd: 2.5,
      description: "Structured brief with key findings, risks, and recommendations",
      max_input_tokens: 16000,
      model: "claude-haiku-4-5-20251001",
    },
    "brief-premium": {
      price_usd: 15.0,
      description: "Deep-dive analysis with competitive landscape and strategic recommendations",
      max_input_tokens: 64000,
      model: "claude-sonnet-4-20250514",
    },
  },
};

/**
 * Load pricing configuration from config/pricing.json.
 * Falls back to built-in defaults if file not found.
 *
 * Resolves the config path relative to the project root
 * (three levels up from src/skills/revenue/).
 */
export function loadPricingConfig(): PricingConfig {
  try {
    // Resolve project root: this file is at src/skills/revenue/index.ts
    // so project root is three directories up.
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "..", "..", "..");
    const configPath = path.join(projectRoot, "config", "pricing.json");

    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as PricingConfig;

      // Basic validation: ensure tiers object exists
      if (parsed && typeof parsed.tiers === "object" && parsed.tiers !== null) {
        return parsed;
      }
    }
  } catch {
    // Fall through to defaults on any error
  }

  return DEFAULT_PRICING;
}

/**
 * Registry of all revenue skill handlers.
 */
export const REVENUE_SKILLS = {
  "summarize-basic": handleSummarizeBasic,
  "brief-standard": handleBriefStandard,
  "brief-premium": handleBriefPremium,
} as const;

export type RevenueSkillName = keyof typeof REVENUE_SKILLS;

/**
 * Dispatch a revenue skill request to the appropriate handler.
 *
 * Loads pricing config, looks up the skill handler, and invokes it.
 * Returns an error response if the skill name is not recognized.
 */
export async function dispatchRevenueSkill(
  db: Database,
  skillName: string,
  request: SkillRequest,
): Promise<SkillResponse> {
  const pricing = loadPricingConfig();

  if (!(skillName in REVENUE_SKILLS)) {
    return {
      success: false,
      tier: skillName,
      error: `Unknown revenue skill: "${skillName}". Available skills: ${Object.keys(REVENUE_SKILLS).join(", ")}`,
      requestId: "",
      estimatedCostCents: 0,
    };
  }

  const handler = REVENUE_SKILLS[skillName as RevenueSkillName];
  return handler(db, request, pricing);
}
