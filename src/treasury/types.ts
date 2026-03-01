/**
 * Treasury Tax Types
 *
 * Configuration and result types for the daily creator tax mechanism.
 */

export interface TaxConfig {
  /** Fraction of daily net profit to transfer (e.g., 0.20 = 20%) */
  tax_rate_profit: number;
  /** Minimum USDC balance to maintain (skip tax if balance would drop below) */
  min_reserve_usd: number;
  /** Creator's wallet address to receive tax payments */
  creator_tax_address: string;
}

export interface TaxResult {
  date: string;
  netProfitUsd: number;
  taxAmountUsd: number;
  transferred: boolean;
  skippedReason?: string;
  txHash?: string;
  balanceAfterUsd?: number;
}
