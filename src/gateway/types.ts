/**
 * x402 Gateway Types
 */
import type { Address } from "viem";

/** A single pricing tier for a paid endpoint */
export interface GatewayTier {
  route: string;
  backend: string;         // e.g., "http://127.0.0.1:9000"
  backendPath?: string;    // Path on backend (defaults to route if omitted)
  priceUsd: number;        // e.g., 0.25
  priceAtomic: string;     // USDC 6-decimal string, e.g., "250000"
  maxInputTokens: number;
  model: string;
  description: string;
}

/** Full pricing configuration */
export interface GatewayPricing {
  walletAddress: Address;
  network: string;           // "eip155:8453"
  usdcAddress: Address;
  deadlineSeconds: number;   // default 300
  tiers: Record<string, GatewayTier>;
}

/** Decoded X-Payment header payload */
export interface X402Payment {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: `0x${string}`;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

/** Result of off-chain signature verification */
export interface VerifyResult {
  valid: boolean;
  error?: string;
  signerAddress?: Address;
  amountAtomic?: bigint;
}

/** Result of async on-chain execution */
export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

/** Nonce record stored in SQLite */
export interface NonceRecord {
  nonce: string;
  fromAddr: string;
  amountAtomic: string;
  tier: string;
  status: "pending" | "executed" | "failed";
  createdAt: string;
  executedAt?: string;
  txHash?: string;
  error?: string;
}

/** 402 payment requirement sent to clients */
export interface PaymentRequirement {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payToAddress: Address;
    requiredDeadlineSeconds: number;
    usdcAddress: Address;
  }>;
}
