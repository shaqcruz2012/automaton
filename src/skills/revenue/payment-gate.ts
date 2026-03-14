/**
 * Payment Gate — x402 Payment Verification & Accounting
 *
 * Handles payment verification for revenue skill endpoints and
 * logs revenue/expense events to the accounting ledger.
 *
 * STUB: Payment verification currently checks for presence of
 * paymentProof only. In production, this would verify the payment
 * on-chain or via the x402 protocol's TransferWithAuthorization.
 */

import type BetterSqlite3 from "better-sqlite3";
import { logRevenue, logExpense } from "../../local/accounting.js";

type Database = BetterSqlite3.Database;

/**
 * Verify that an x402 payment has been made for the requested tier.
 *
 * STUB: In production, this would verify the payment on-chain or via
 * the x402 protocol. For now, it checks that paymentProof is present
 * and non-empty (simulating successful verification).
 *
 * A full implementation would:
 * 1. Decode the paymentProof (base64 → JSON with signature + authorization)
 * 2. Verify the EIP-712 TransferWithAuthorization signature on-chain
 * 3. Confirm the transfer amount matches or exceeds tierPriceUsd
 * 4. Check that the payment hasn't been replayed (nonce tracking)
 */
export function verifyPayment(
  paymentProof: string | undefined,
  tierPriceUsd: number,
): { verified: boolean; error?: string } {
  const verificationEnabled =
    process.env.PAYMENT_VERIFICATION_ENABLED === "true";

  // When verification is disabled (default), reject ALL payments.
  // This prevents accidental free LLM calls in dev/test environments.
  if (!verificationEnabled) {
    return {
      verified: false,
      error:
        "Payment verification is disabled. Set PAYMENT_VERIFICATION_ENABLED=true and configure x402 verification.",
    };
  }

  // STUB: Only check that paymentProof is present and non-empty
  if (!paymentProof || paymentProof.trim().length === 0) {
    return {
      verified: false,
      error: `Payment required: $${tierPriceUsd.toFixed(2)} USD via x402 protocol. Provide a valid paymentProof.`,
    };
  }

  // STUB: In production, verify the payment amount covers the tier price.
  // For now, any non-empty proof is accepted when explicitly opted in.
  console.warn(
    "STUB: Payment verification is not fully implemented. Accepting non-empty proof as valid.",
  );
  return { verified: true };
}

/**
 * Log revenue from a successful skill invocation.
 * Calls logRevenue from the accounting module.
 */
export function recordRevenue(
  db: Database,
  params: {
    tier: string;
    amountCents: number;
    requestId: string;
    nicheId?: string;
    experimentId?: string;
    paymentProof?: string;
  },
): void {
  logRevenue(db, {
    source: `skill:${params.tier}`,
    amountCents: params.amountCents,
    description: `Revenue from ${params.tier} skill invocation`,
    metadata: {
      requestId: params.requestId,
      paymentProof: params.paymentProof,
    },
    nicheId: params.nicheId,
    experimentId: params.experimentId,
  });
}

/**
 * Estimate and log the cost of processing a request.
 * Estimates based on input token count and model used.
 *
 * Cost estimation formulas (per 1M tokens → per 1K tokens → cents per 1K):
 * - claude-haiku-4-5-20251001: input $0.80/1M (0.08¢/1K), output $4.00/1M (0.40¢/1K)
 * - claude-sonnet-4-20250514:  input $3.00/1M (0.30¢/1K), output $15.00/1M (1.50¢/1K)
 * - gpt-4o-mini:               input $0.15/1M (0.015¢/1K), output $0.60/1M (0.06¢/1K)
 * - gpt-4o:                    input $2.50/1M (0.25¢/1K),  output $10.00/1M (1.00¢/1K)
 * - Plus fixed infra overhead of $0.01 per request (1 cent)
 *
 * @returns estimated cost in cents
 */
export function recordExpense(
  db: Database,
  params: {
    tier: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    requestId: string;
    nicheId?: string;
    experimentId?: string;
  },
): number {
  // Cost per 1K tokens in cents (input / output)
  const inputCostPer1k: Record<string, number> = {
    "claude-haiku-4-5-20251001": 0.08,
    "claude-sonnet-4-20250514": 0.30,
    "gpt-4o-mini": 0.015,
    "gpt-4o": 0.25,
  };
  const outputCostPer1k: Record<string, number> = {
    "claude-haiku-4-5-20251001": 0.40,
    "claude-sonnet-4-20250514": 1.50,
    "gpt-4o-mini": 0.06,
    "gpt-4o": 1.00,
  };

  const inputRate = inputCostPer1k[params.model] ?? 0.08;
  const outputRate = outputCostPer1k[params.model] ?? 0.40;
  const tokenCostCents =
    (params.inputTokens / 1000) * inputRate +
    (params.outputTokens / 1000) * outputRate;

  // Fixed infra overhead: $0.01 = 1 cent per request
  const infraOverheadCents = 1;

  const totalCostCents = Math.ceil(tokenCostCents + infraOverheadCents);

  logExpense(db, {
    category: "inference",
    amountCents: totalCostCents,
    description: `Cost for ${params.tier} skill (model: ${params.model}, ~${params.inputTokens} input + ~${params.outputTokens} output tokens)`,
    metadata: {
      requestId: params.requestId,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      tokenCostCents,
      infraOverheadCents,
    },
    nicheId: params.nicheId,
    experimentId: params.experimentId,
  });

  return totalCostCents;
}
