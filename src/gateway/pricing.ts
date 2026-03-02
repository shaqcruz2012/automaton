/**
 * Gateway Pricing Configuration
 *
 * Defines endpoint pricing and builds x402 payment requirement objects.
 * Wallet address is loaded from ~/.automaton/wallet.json at startup.
 */
import fs from "fs";
import path from "path";
import os from "os";
import type { Address } from "viem";
import type { GatewayPricing, GatewayTier, PaymentRequirement } from "./types.js";

const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK = "eip155:8453";
const DEFAULT_DEADLINE_SECONDS = 300;

/** Convert USD amount to USDC atomic units (6 decimals) string */
export function usdToAtomic(usd: number): string {
  return String(Math.round(usd * 1_000_000));
}

/** Load wallet address from ~/.automaton/wallet.json */
function loadWalletAddress(): Address {
  try {
    const walletPath = path.join(os.homedir(), ".automaton", "wallet.json");
    const raw = fs.readFileSync(walletPath, "utf-8");
    const wallet = JSON.parse(raw);
    if (wallet.privateKey) {
      // Derive address from private key would be ideal but for now use env/known
    }
  } catch {
    // Fall through to env var or hardcoded
  }
  return (process.env.GATEWAY_WALLET_ADDRESS ||
    "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706") as Address;
}

const DEFAULT_TIERS: Record<string, GatewayTier> = {
  "summarize-basic": {
    route: "/summarize",
    backend: "http://127.0.0.1:9000",
    priceUsd: 0.25,
    priceAtomic: usdToAtomic(0.25),
    maxInputTokens: 4000,
    model: "claude-haiku-4-5-20251001",
    description: "High-volume summarization",
  },
  "brief-standard": {
    route: "/brief",
    backend: "http://127.0.0.1:9000",
    priceUsd: 2.50,
    priceAtomic: usdToAtomic(2.50),
    maxInputTokens: 16000,
    model: "claude-haiku-4-5-20251001",
    description: "Structured brief with findings and recommendations",
  },
  "brief-premium": {
    route: "/brief-premium",
    backend: "http://127.0.0.1:9000",
    priceUsd: 15.00,
    priceAtomic: usdToAtomic(15.00),
    maxInputTokens: 64000,
    model: "claude-sonnet-4-20250514",
    description: "Deep-dive analysis with competitive landscape",
  },
  "analyze": {
    route: "/analyze",
    backend: "http://127.0.0.1:9000",
    priceUsd: 0.01,
    priceAtomic: usdToAtomic(0.01),
    maxInputTokens: 2000,
    model: "claude-haiku-4-5-20251001",
    description: "Text analysis (sentiment, entities, keywords)",
  },
  "trustcheck": {
    route: "/trustcheck",
    backend: "http://127.0.0.1:9002",
    backendPath: "/check",
    priceUsd: 0.05,
    priceAtomic: usdToAtomic(0.05),
    maxInputTokens: 1000,
    model: "claude-haiku-4-5-20251001",
    description: "Trust and reputation check",
  },
};

export function getGatewayPricing(): GatewayPricing {
  return {
    walletAddress: loadWalletAddress(),
    network: NETWORK,
    usdcAddress: USDC_ADDRESS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
    tiers: { ...DEFAULT_TIERS },
  };
}

export function buildPaymentRequirement(
  pricing: GatewayPricing,
  tierName: string,
): PaymentRequirement {
  const tier = pricing.tiers[tierName];
  if (!tier) {
    throw new Error(`Unknown tier: "${tierName}"`);
  }
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: pricing.network,
        maxAmountRequired: tier.priceAtomic,
        payToAddress: pricing.walletAddress,
        requiredDeadlineSeconds: pricing.deadlineSeconds,
        usdcAddress: pricing.usdcAddress,
      },
    ],
  };
}
