/**
 * Resource Monitor
 *
 * Phase 4: Monitors the automaton's resources using the local treasury
 * (USDC on Base) instead of Conway credits.
 * Survival tiers are derived from on-chain USDC balance + daily burn rate.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  AutomatonIdentity,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import {
  getOnChainBalance,
  getSurvivalTierFromBalance,
  formatBalance,
} from "../local/treasury.js";
import { estimateDailyBurnCents } from "../local/accounting.js";

export interface ResourceStatus {
  financial: FinancialState;
  tier: SurvivalTier;
  previousTier: SurvivalTier | null;
  tierChanged: boolean;
  sandboxHealthy: boolean;
}

/**
 * Check all resources and return current status.
 * Phase 4: Uses on-chain USDC balance as the source of truth for credits.
 */
export async function checkResources(
  identity: AutomatonIdentity,
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<ResourceStatus> {
  // Phase 4: Read USDC balance on-chain as the primary balance
  let usdcBalance = 0;
  let balanceCents = 0;
  try {
    const result = await getOnChainBalance(identity.address);
    if (result.ok) {
      usdcBalance = result.balanceUsd;
      balanceCents = result.balanceCents;
    }
  } catch {}

  // creditsCents now equals the USDC balance in cents
  const creditsCents = balanceCents;

  // Check sandbox health
  let sandboxHealthy = true;
  try {
    const result = await conway.exec("echo ok", 5000);
    sandboxHealthy = result.exitCode === 0;
  } catch {
    sandboxHealthy = false;
  }

  const financial: FinancialState = {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };

  // Estimate daily burn from the expense ledger
  let dailyBurnCents = 0;
  try {
    dailyBurnCents = estimateDailyBurnCents(db.raw);
  } catch {}

  const tier = getSurvivalTierFromBalance(creditsCents, dailyBurnCents);
  const prevTierStr = db.getKV("current_tier");
  const previousTier = (prevTierStr as SurvivalTier) || null;
  const tierChanged = previousTier !== null && previousTier !== tier;

  // Store current tier
  db.setKV("current_tier", tier);

  // Store financial state
  db.setKV("financial_state", JSON.stringify(financial));

  return {
    financial,
    tier,
    previousTier,
    tierChanged,
    sandboxHealthy,
  };
}

/**
 * Generate a human-readable resource report.
 */
export function formatResourceReport(status: ResourceStatus): string {
  const lines = [
    `=== RESOURCE STATUS ===`,
    `Balance: ${formatBalance(status.financial.creditsCents)}`,
    `USDC: ${status.financial.usdcBalance.toFixed(6)}`,
    `Tier: ${status.tier}${status.tierChanged ? ` (changed from ${status.previousTier})` : ""}`,
    `Sandbox: ${status.sandboxHealthy ? "healthy" : "UNHEALTHY"}`,
    `Checked: ${status.financial.lastChecked}`,
    `========================`,
  ];
  return lines.join("\n");
}
