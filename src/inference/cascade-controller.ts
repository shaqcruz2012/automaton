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
 */

import type BetterSqlite3 from "better-sqlite3";
import type { CascadePool, SurvivalTier, InferenceRequest, InferenceResult } from "../types.js";
import type { InferenceRouter } from "./router.js";
import { getProvidersForPool, getNextPool } from "./pools.js";
import { createLogger } from "../observability/logger.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("cascade");

/** Cache P&L for 5 minutes to avoid constant DB queries */
const PNL_CACHE_TTL_MS = 5 * 60 * 1000;

interface PnlCache {
  netCents: number;
  revenueCents: number;
  expenseCents: number;
  cachedAt: number;
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
   * Main entry point. Replaces direct inferenceRouter.route() calls.
   *
   * 1. Select starting pool based on tier + profitability
   * 2. Try inference with that pool's providers
   * 3. On pool exhaustion -> cascade to next pool
   * 4. Throw CascadeExhaustedError if all pools fail
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
        const result = await router.route(request, inferenceChat);
        logger.info(`Cascade: ${currentPool} pool succeeded (model: ${result.model})`);
        return result;
      } catch (error: any) {
        const errMsg = error?.message ?? String(error);
        const isRetryable = /429|413|500|503|rate.limit|timeout/i.test(errMsg);

        if (isRetryable) {
          const next = getNextPool(currentPool);
          if (next) {
            logger.warn(`Cascade: ${currentPool} pool exhausted (${errMsg}), falling back to ${next}`);
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
