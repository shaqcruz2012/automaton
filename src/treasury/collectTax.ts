/**
 * Creator Tax Collection
 *
 * Daily job that computes net profit for the previous UTC day and transfers
 * a configurable percentage to the creator's wallet as a tax payment.
 *
 * Safety guarantees:
 * - Never transfers if net profit is zero or negative
 * - Never transfers if the survival tier is "critical" or "dead"
 * - Never transfers if the resulting balance would drop below min_reserve_usd
 * - Never transfers if the creator_tax_address is the zero address (unconfigured)
 */

import type BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import type { TaxConfig, TaxResult } from "./types.js";
import { computeDailyNetProfit } from "../local/accounting.js";
import { logTransferEvent } from "../local/accounting.js";
import {
  getOnChainBalance,
  getSurvivalTierFromBalance,
  transferUSDC,
} from "../local/treasury.js";
import { loadWalletAccount } from "../identity/wallet.js";
import { createLogger } from "../observability/logger.js";
import type { Address } from "viem";

type Database = BetterSqlite3.Database;

const logger = createLogger("creator-tax");

/** Zero address — used as the default / unconfigured sentinel */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Safe defaults if config/tax.json is missing or unreadable */
const DEFAULT_TAX_CONFIG: TaxConfig = {
  tax_rate_profit: 0.20,
  min_reserve_usd: 50.0,
  creator_tax_address: ZERO_ADDRESS,
};

/**
 * Load tax configuration from config/tax.json.
 * Falls back to safe defaults if the file is not found or cannot be parsed.
 *
 * The config file path is resolved relative to the project root
 * (two directories up from this file in src/treasury/).
 */
export function loadTaxConfig(): TaxConfig {
  try {
    // Resolve the project root: this file lives in src/treasury/
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(thisDir, "..", "..");
    const configPath = path.join(projectRoot, "config", "tax.json");

    if (!fs.existsSync(configPath)) {
      logger.warn("config/tax.json not found, using defaults");
      return { ...DEFAULT_TAX_CONFIG };
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TaxConfig>;

    return {
      tax_rate_profit: parsed.tax_rate_profit ?? DEFAULT_TAX_CONFIG.tax_rate_profit,
      min_reserve_usd: parsed.min_reserve_usd ?? DEFAULT_TAX_CONFIG.min_reserve_usd,
      creator_tax_address: parsed.creator_tax_address ?? DEFAULT_TAX_CONFIG.creator_tax_address,
    };
  } catch (err) {
    logger.warn("Failed to load config/tax.json, using defaults", {
      error: String(err),
    });
    return { ...DEFAULT_TAX_CONFIG };
  }
}

/**
 * Collect creator tax for a given UTC date.
 *
 * Flow:
 * 1. Compute daily net profit via computeDailyNetProfit(db, date)
 * 2. If net_profit_usd <= 0, skip (no profit to tax)
 * 3. Compute tax_amount = net_profit_usd * tax_rate_profit
 * 4. Check on-chain USDC balance via getOnChainBalance()
 * 5. Check survival tier -- skip if "critical" or "dead"
 * 6. Check if balance - tax_amount >= min_reserve_usd -- skip if not
 * 7. Transfer tax_amount USDC to creator_tax_address via transferUSDC()
 * 8. Log as a transfers row of type "tax" via logTransferEvent()
 * 9. Return TaxResult
 *
 * @param db - SQLite database instance with accounting tables
 * @param date - UTC date in YYYY-MM-DD format; defaults to yesterday
 */
export async function collectCreatorTax(
  db: Database,
  date?: string,
): Promise<TaxResult> {
  // Default to yesterday's UTC date if not provided
  const targetDate =
    date ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  logger.info(`Collecting creator tax for ${targetDate}`);

  const config = loadTaxConfig();

  // ── Step 0: Validate creator address ──────────────────────────
  if (config.creator_tax_address === ZERO_ADDRESS) {
    logger.info("Skipping tax: creator_tax_address not configured");
    return {
      date: targetDate,
      netProfitUsd: 0,
      taxAmountUsd: 0,
      transferred: false,
      skippedReason: "creator_tax_address not configured",
    };
  }

  // ── Step 1: Compute daily net profit ──────────────────────────
  const dailyProfit = computeDailyNetProfit(db, targetDate);
  logger.info(`Daily profit for ${targetDate}: $${dailyProfit.netProfitUsd.toFixed(2)}`, {
    revenueCents: dailyProfit.revenueCents,
    expenseCents: dailyProfit.expenseCents,
    netProfitCents: dailyProfit.netProfitCents,
  });

  // ── Step 2: Skip if no profit ─────────────────────────────────
  if (dailyProfit.netProfitUsd <= 0) {
    logger.info("Skipping tax: no profit to tax");
    return {
      date: targetDate,
      netProfitUsd: dailyProfit.netProfitUsd,
      taxAmountUsd: 0,
      transferred: false,
      skippedReason: "no profit (net profit <= 0)",
    };
  }

  // ── Step 3: Compute tax amount ────────────────────────────────
  const taxAmountUsd = Math.round(dailyProfit.netProfitUsd * config.tax_rate_profit * 100) / 100;
  if (taxAmountUsd <= 0) {
    logger.info("Skipping tax: computed tax amount is zero");
    return {
      date: targetDate,
      netProfitUsd: dailyProfit.netProfitUsd,
      taxAmountUsd: 0,
      transferred: false,
      skippedReason: "computed tax amount is zero",
    };
  }

  // ── Step 4: Load wallet and check on-chain balance ────────────
  const walletAccount = loadWalletAccount();
  if (!walletAccount) {
    logger.warn("Skipping tax: wallet not found");
    return {
      date: targetDate,
      netProfitUsd: dailyProfit.netProfitUsd,
      taxAmountUsd,
      transferred: false,
      skippedReason: "wallet not found",
    };
  }

  const walletAddress = walletAccount.address;
  const balance = await getOnChainBalance(walletAddress);
  if (!balance.ok) {
    logger.warn("Skipping tax: balance check failed", { error: balance.error });
    return {
      date: targetDate,
      netProfitUsd: dailyProfit.netProfitUsd,
      taxAmountUsd,
      transferred: false,
      skippedReason: `balance check failed: ${balance.error}`,
    };
  }

  logger.info(`Current USDC balance: $${balance.balanceUsd.toFixed(2)}`);

  // ── Step 5: Check survival tier ───────────────────────────────
  // Pass dailyBurnCents = 0 to use absolute thresholds
  const tier = getSurvivalTierFromBalance(balance.balanceCents, 0);
  if (tier === "critical" || tier === "dead") {
    logger.warn(`Skipping tax: survival tier is "${tier}"`);
    return {
      date: targetDate,
      netProfitUsd: dailyProfit.netProfitUsd,
      taxAmountUsd,
      transferred: false,
      skippedReason: `survival tier is "${tier}"`,
    };
  }

  // ── Step 6: Check minimum reserve ─────────────────────────────
  const balanceAfterTax = balance.balanceUsd - taxAmountUsd;
  if (balanceAfterTax < config.min_reserve_usd) {
    logger.warn(
      `Skipping tax: balance after tax ($${balanceAfterTax.toFixed(2)}) ` +
        `would be below minimum reserve ($${config.min_reserve_usd.toFixed(2)})`,
    );
    return {
      date: targetDate,
      netProfitUsd: dailyProfit.netProfitUsd,
      taxAmountUsd,
      transferred: false,
      skippedReason: `balance after tax ($${balanceAfterTax.toFixed(2)}) below min_reserve_usd ($${config.min_reserve_usd.toFixed(2)})`,
    };
  }

  // ── Step 7: Transfer USDC to creator ──────────────────────────
  const creatorAddress = config.creator_tax_address as Address;
  logger.info(
    `Transferring $${taxAmountUsd.toFixed(2)} creator tax to ${creatorAddress}`,
  );

  const txResult = await transferUSDC(walletAccount, creatorAddress, taxAmountUsd);
  if (!txResult.success) {
    logger.error(`Tax transfer failed: ${txResult.error}`);
    return {
      date: targetDate,
      netProfitUsd: dailyProfit.netProfitUsd,
      taxAmountUsd,
      transferred: false,
      skippedReason: `transfer failed: ${txResult.error}`,
    };
  }

  // ── Step 8: Log transfer event ────────────────────────────────
  logTransferEvent(db, {
    type: "tax",
    fromAccount: walletAddress,
    toAccount: creatorAddress,
    amountUsd: taxAmountUsd,
    metadata: {
      date: targetDate,
      netProfitUsd: dailyProfit.netProfitUsd,
      taxRate: config.tax_rate_profit,
      txHash: txResult.txHash,
    },
  });

  logger.info(
    `Creator tax transferred: $${taxAmountUsd.toFixed(2)} (tx: ${txResult.txHash})`,
  );

  // ── Step 9: Return result ─────────────────────────────────────
  return {
    date: targetDate,
    netProfitUsd: dailyProfit.netProfitUsd,
    taxAmountUsd,
    transferred: true,
    txHash: txResult.txHash,
    balanceAfterUsd: balanceAfterTax,
  };
}
