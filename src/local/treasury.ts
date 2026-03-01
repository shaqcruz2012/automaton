/**
 * Local Treasury
 *
 * Phase 4: Replaces legacy metered credit ledger with local accounting
 * backed by the agent's actual USDC balance on Base L2.
 *
 * - getOnChainBalance(): Read USDC balance on Base via viem
 * - getLocalLedgerBalance(): Sum revenue minus expenses from SQLite
 * - getEffectiveBalance(): On-chain balance as source of truth
 * - transferUSDC(): Sign and send USDC transfer using agent's wallet
 * - getSurvivalTier(): Determine tier from USDC balance + daily burn
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  encodeFunctionData,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base } from "viem/chains";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("treasury");

// ── Constants ────────────────────────────────────────────────────

/** USDC on Base mainnet */
const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;

const BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const TRANSFER_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** Default Base RPC (can be overridden via BASE_RPC_URL env var) */
function getRpcUrl(): string {
  return process.env.BASE_RPC_URL || "https://mainnet.base.org";
}

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(getRpcUrl(), { timeout: 15_000 }),
  });
}

// ── On-Chain Balance ─────────────────────────────────────────────

export interface BalanceResult {
  /** USDC balance in dollars (e.g., 42.50) */
  balanceUsd: number;
  /** USDC balance in cents (e.g., 4250) */
  balanceCents: number;
  /** Raw atomic units (6 decimals) */
  balanceAtomic: bigint;
  /** Whether the read succeeded */
  ok: boolean;
  error?: string;
}

/**
 * Read the agent's USDC balance on Base.
 */
export async function getOnChainBalance(address: Address): Promise<BalanceResult> {
  try {
    const client = getPublicClient();
    const balance = await client.readContract({
      address: USDC_ADDRESS,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address],
    });

    const balanceUsd = Number(balance) / 10 ** USDC_DECIMALS;
    return {
      balanceUsd,
      balanceCents: Math.floor(balanceUsd * 100),
      balanceAtomic: balance,
      ok: true,
    };
  } catch (err: any) {
    return {
      balanceUsd: 0,
      balanceCents: 0,
      balanceAtomic: 0n,
      ok: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Get balance in the legacy "credits cents" format for backward compatibility.
 * Maps USDC dollars to cents (e.g., $42.50 -> 4250 cents).
 */
export async function getBalanceAsCreditsCents(address: Address): Promise<number> {
  const result = await getOnChainBalance(address);
  return result.balanceCents;
}

// ── USDC Transfer ────────────────────────────────────────────────

export interface TransferResult {
  success: boolean;
  txHash?: string;
  amountUsd: number;
  toAddress: string;
  error?: string;
}

/**
 * Sign and send a USDC transfer on Base.
 */
export async function transferUSDC(
  account: PrivateKeyAccount,
  to: Address,
  amountUsd: number,
): Promise<TransferResult> {
  if (amountUsd <= 0) {
    return { success: false, amountUsd, toAddress: to, error: "Amount must be positive" };
  }

  try {
    // Check balance first
    const balance = await getOnChainBalance(account.address);
    if (!balance.ok) {
      return { success: false, amountUsd, toAddress: to, error: `Balance check failed: ${balance.error}` };
    }
    if (balance.balanceUsd < amountUsd) {
      return {
        success: false,
        amountUsd,
        toAddress: to,
        error: `Insufficient USDC: have $${balance.balanceUsd.toFixed(2)}, need $${amountUsd.toFixed(2)}`,
      };
    }

    const amountAtomic = parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);

    const client = createWalletClient({
      account,
      chain: base,
      transport: http(getRpcUrl(), { timeout: 30_000 }),
    });

    const txHash = await client.sendTransaction({
      to: USDC_ADDRESS,
      data: encodeFunctionData({
        abi: TRANSFER_ABI,
        functionName: "transfer",
        args: [to, amountAtomic],
      }),
    });

    logger.info(`USDC transfer sent: $${amountUsd} to ${to}, tx: ${txHash}`);

    return {
      success: true,
      txHash,
      amountUsd,
      toAddress: to,
    };
  } catch (err: any) {
    logger.error(`USDC transfer failed: ${err.message}`);
    return {
      success: false,
      amountUsd,
      toAddress: to,
      error: err?.message || String(err),
    };
  }
}

// ── Survival Tiers (USDC-based) ──────────────────────────────────

import type { SurvivalTier } from "../types.js";

/**
 * Determine survival tier from USDC balance and estimated daily burn.
 *
 * - normal:      balance > 30 days of estimated daily burn
 * - low_compute: balance covers 7–30 days
 * - critical:    balance covers < 7 days
 * - dead:        balance < $0.10 USDC
 *
 * Also supports the legacy "high" tier when balance is very healthy.
 *
 * @param balanceCents - USDC balance in cents
 * @param dailyBurnCents - estimated daily burn in cents (from expense ledger)
 */
export function getSurvivalTierFromBalance(
  balanceCents: number,
  dailyBurnCents: number = 0,
): SurvivalTier {
  // Dead: essentially zero
  if (balanceCents < 10) return "dead"; // < $0.10

  // If we don't have burn data, fall back to absolute thresholds
  if (dailyBurnCents <= 0) {
    if (balanceCents >= 50000) return "high";    // > $500
    if (balanceCents >= 5000) return "normal";   // > $50
    if (balanceCents >= 500) return "low_compute"; // > $5
    return "critical";
  }

  // Runway-based tiers
  const runwayDays = balanceCents / dailyBurnCents;
  if (runwayDays > 90) return "high";
  if (runwayDays > 30) return "normal";
  if (runwayDays > 7) return "low_compute";
  return "critical";
}

/**
 * Format a balance for display.
 */
export function formatBalance(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
