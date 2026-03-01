/**
 * Credits Management — Migration Wrapper
 *
 * MIGRATION NOTE (Phase 4): Delegates entirely to src/local/treasury.ts.
 * Survival tiers are now based on USDC balance and daily burn rate,
 * not Conway metered credits.
 *
 * Exports are kept for backward compatibility with callers.
 */

import type {
  FinancialState,
  SurvivalTier,
} from "../types.js";
import {
  getSurvivalTierFromBalance,
  formatBalance,
} from "../local/treasury.js";

/**
 * Check the current financial state.
 * Phase 4: creditsCents now represents the USDC balance in cents.
 */
export async function checkFinancialState(
  _conway: unknown,
  usdcBalance: number,
): Promise<FinancialState> {
  const creditsCents = Math.floor(usdcBalance * 100);
  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Determine the survival tier based on balance in cents.
 * Phase 4: Delegates to treasury's USDC-based tier calculation.
 * Without daily burn data, uses absolute thresholds.
 */
export function getSurvivalTier(creditsCents: number): SurvivalTier {
  return getSurvivalTierFromBalance(creditsCents);
}

/**
 * Format a balance for display.
 */
export function formatCredits(cents: number): string {
  return formatBalance(cents);
}
