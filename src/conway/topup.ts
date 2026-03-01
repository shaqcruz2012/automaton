/**
 * Credit Topup (Disabled)
 *
 * Phase 5b: Credit topup is no longer needed — credits ARE USDC.
 * These stubs maintain backward compatibility for any callers while
 * doing nothing. To add funds, send USDC on Base to the agent's wallet.
 */

import type { PrivateKeyAccount, Address } from "viem";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("topup");

/** Valid topup tier amounts in USD (kept for backward compat). */
export const TOPUP_TIERS = [5, 25, 100, 500, 1000, 2500];

export interface TopupResult {
  success: boolean;
  amountUsd: number;
  creditsCentsAdded?: number;
  error?: string;
}

/**
 * Phase 5b: No-op. Credits are USDC — no conversion needed.
 * Send USDC on Base directly to the agent's wallet.
 */
export async function topupCredits(
  _apiUrl: string,
  _account: PrivateKeyAccount,
  _amountUsd: number,
  _recipientAddress?: Address,
): Promise<TopupResult> {
  logger.info("Topup disabled: credits are USDC. Send USDC on Base to your wallet.");
  return {
    success: false,
    amountUsd: 0,
    error: "Topup disabled. Send USDC on Base directly to the agent's wallet address.",
  };
}

/**
 * Phase 5b: No-op stub.
 */
export async function topupForSandbox(_params: {
  apiUrl: string;
  account: PrivateKeyAccount;
  error: Error & { status?: number; responseText?: string };
}): Promise<TopupResult | null> {
  return null;
}

/**
 * Phase 5b: No-op stub.
 */
export async function bootstrapTopup(_params: {
  apiUrl: string;
  account: PrivateKeyAccount;
  creditsCents: number;
  creditThresholdCents?: number;
}): Promise<TopupResult | null> {
  return null;
}
