/**
 * Tick Context
 *
 * Phase 4: Builds a shared context for each heartbeat tick.
 * Fetches USDC balance ONCE per tick, derives survival tier from
 * on-chain balance + daily burn rate.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { Address } from "viem";
import type {
  ConwayClient,
  HeartbeatConfig,
  TickContext,
} from "../types.js";
import { getOnChainBalance, getSurvivalTierFromBalance } from "../local/treasury.js";
import { estimateDailyBurnCents } from "../local/accounting.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;
const logger = createLogger("heartbeat.tick");

let counter = 0;
function generateTickId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  counter++;
  return `${timestamp}-${random}-${counter.toString(36)}`;
}

/**
 * Build a TickContext for the current tick.
 *
 * Phase 4: Uses on-chain USDC balance as the credit balance.
 * Survival tier derived from USDC balance + daily burn rate.
 */
export async function buildTickContext(
  db: DatabaseType,
  conway: ConwayClient,
  config: HeartbeatConfig,
  walletAddress?: Address,
): Promise<TickContext> {
  const tickId = generateTickId();
  const startedAt = new Date();

  // Phase 4: Fetch USDC balance on-chain as the primary balance
  let creditBalance = 0;
  let usdcBalance = 0;
  if (walletAddress) {
    try {
      const result = await getOnChainBalance(walletAddress);
      if (result.ok) {
        usdcBalance = result.balanceUsd;
        creditBalance = result.balanceCents;
      }
    } catch (err: any) {
      logger.error("Failed to fetch USDC balance", err instanceof Error ? err : undefined);
    }
  }

  // Estimate daily burn for tier calculation
  let dailyBurnCents = 0;
  try {
    dailyBurnCents = estimateDailyBurnCents(db);
  } catch {}

  const survivalTier = getSurvivalTierFromBalance(creditBalance, dailyBurnCents);
  const lowComputeMultiplier = config.lowComputeMultiplier ?? 4;

  return {
    tickId,
    startedAt,
    creditBalance,
    usdcBalance,
    survivalTier,
    lowComputeMultiplier,
    config,
    db,
  };
}
