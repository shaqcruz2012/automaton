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
 * STUB: Cost estimation formulas:
 * - claude-haiku-4-5-20251001: ~$0.80 per 1M input tokens → ~$0.0008 per 1K tokens
 *   → 0.08 cents per 1K tokens
 * - claude-sonnet-4-20250514: ~$3.00 per 1M input tokens → ~$0.003 per 1K tokens
 *   → 0.30 cents per 1K tokens
 * - gpt-4o-mini: ~$0.15 per 1M input tokens → ~$0.00015 per 1K tokens (fallback)
 * - gpt-4o: ~$2.50 per 1M input tokens → ~$0.0025 per 1K tokens (fallback)
 * - Plus fixed infra overhead of $0.01 per request (1 cent)
 *
 * These are input-only estimates; output token costs are not included
 * since we're generating stub responses. In production, output costs
 * would be added based on actual completion token counts.
 *
 * @returns estimated cost in cents
 */
export function recordExpense(
  db: Database,
  params: {
    tier: string;
    model: string;
    inputTokensEstimate: number;
    requestId: string;
    nicheId?: string;
    experimentId?: string;
  },
): number {
  // Cost per 1K input tokens in cents
  // claude-haiku-4-5-20251001: $0.80/1M = $0.0008/1K = 0.08 cents/1K
  // claude-sonnet-4-20250514: $3.00/1M = $0.003/1K = 0.30 cents/1K
  // gpt-4o-mini: $0.15/1M = $0.00015/1K = 0.015 cents/1K (fallback)
  // gpt-4o:      $2.50/1M = $0.0025/1K  = 0.25 cents/1K (fallback)
  const costPer1kTokensCents: Record<string, number> = {
    "claude-haiku-4-5-20251001": 0.08,
    "claude-sonnet-4-20250514": 0.30,
    "gpt-4o-mini": 0.015,
    "gpt-4o": 0.25,
  };

  const perTokenCost = costPer1kTokensCents[params.model] ?? 0.08; // default to claude-haiku rate
  const tokenCostCents = (params.inputTokensEstimate / 1000) * perTokenCost;

  // Fixed infra overhead: $0.01 = 1 cent per request
  const infraOverheadCents = 1;

  const totalCostCents = Math.ceil(tokenCostCents + infraOverheadCents);

  logExpense(db, {
    category: "inference",
    amountCents: totalCostCents,
    description: `Cost for ${params.tier} skill (model: ${params.model}, ~${params.inputTokensEstimate} input tokens)`,
    metadata: {
      requestId: params.requestId,
      model: params.model,
      inputTokensEstimate: params.inputTokensEstimate,
      tokenCostCents,
      infraOverheadCents,
    },
    nicheId: params.nicheId,
    experimentId: params.experimentId,
  });

  return totalCostCents;
}
