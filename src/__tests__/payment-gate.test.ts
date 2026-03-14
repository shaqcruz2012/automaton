/**
 * Payment Gate Tests
 *
 * Tests for the payment-gate module:
 * - verifyPayment rejects when PAYMENT_VERIFICATION_ENABLED is not set
 * - verifyPayment rejects when PAYMENT_VERIFICATION_ENABLED is "false"
 * - verifyPayment rejects empty paymentProof when enabled
 * - verifyPayment accepts non-empty proof when enabled
 * - recordRevenue calls logRevenue with correct params
 * - recordExpense calculates cost correctly for different models
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the accounting module before importing payment-gate
vi.mock("../local/accounting.js", () => ({
  logRevenue: vi.fn().mockReturnValue("mock-revenue-id"),
  logExpense: vi.fn().mockReturnValue("mock-expense-id"),
}));

import {
  verifyPayment,
  recordRevenue,
  recordExpense,
} from "../skills/revenue/payment-gate.js";
import { logRevenue, logExpense } from "../local/accounting.js";

// ─── Test Helpers ───────────────────────────────────────────────

function withEnv(
  key: string,
  value: string | undefined,
  fn: () => void,
): void {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

/** Stub database object — accounting functions are mocked so DB is never hit */
const fakeDb = {} as any;

// ─── Tests ──────────────────────────────────────────────────────

describe("verifyPayment", () => {
  it("rejects when PAYMENT_VERIFICATION_ENABLED is not set", () => {
    withEnv("PAYMENT_VERIFICATION_ENABLED", undefined, () => {
      const result = verifyPayment("some-proof", 5.0);
      expect(result.verified).toBe(false);
      expect(result.error).toContain("Payment verification is disabled");
    });
  });

  it('rejects when PAYMENT_VERIFICATION_ENABLED is "false"', () => {
    withEnv("PAYMENT_VERIFICATION_ENABLED", "false", () => {
      const result = verifyPayment("some-proof", 5.0);
      expect(result.verified).toBe(false);
      expect(result.error).toContain("Payment verification is disabled");
    });
  });

  it("rejects empty paymentProof when enabled", () => {
    withEnv("PAYMENT_VERIFICATION_ENABLED", "true", () => {
      const resultUndefined = verifyPayment(undefined, 10.0);
      expect(resultUndefined.verified).toBe(false);
      expect(resultUndefined.error).toContain("Payment required");
      expect(resultUndefined.error).toContain("$10.00");

      const resultEmpty = verifyPayment("", 10.0);
      expect(resultEmpty.verified).toBe(false);
      expect(resultEmpty.error).toContain("Payment required");

      const resultWhitespace = verifyPayment("   ", 10.0);
      expect(resultWhitespace.verified).toBe(false);
      expect(resultWhitespace.error).toContain("Payment required");
    });
  });

  it("accepts non-empty proof when enabled", () => {
    withEnv("PAYMENT_VERIFICATION_ENABLED", "true", () => {
      const result = verifyPayment("valid-proof-abc123", 5.0);
      expect(result.verified).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});

describe("recordRevenue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls logRevenue with correct params", () => {
    recordRevenue(fakeDb, {
      tier: "premium",
      amountCents: 500,
      requestId: "req-123",
      nicheId: "niche-a",
      experimentId: "exp-1",
      paymentProof: "proof-xyz",
    });

    expect(logRevenue).toHaveBeenCalledOnce();
    expect(logRevenue).toHaveBeenCalledWith(fakeDb, {
      source: "skill:premium",
      amountCents: 500,
      description: "Revenue from premium skill invocation",
      metadata: {
        requestId: "req-123",
        paymentProof: "proof-xyz",
      },
      nicheId: "niche-a",
      experimentId: "exp-1",
    });
  });
});

describe("recordExpense", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calculates cost correctly for claude-haiku-4-5-20251001", () => {
    // input: 10,000 tokens at 0.08 cents/1K = 0.8 cents
    // output: 2,000 tokens at 0.40 cents/1K = 0.8 cents
    // total: 0.8 + 0.8 + 1 infra = 2.6 → ceil = 3
    const cost = recordExpense(fakeDb, {
      tier: "basic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 10_000,
      outputTokens: 2_000,
      requestId: "req-h1",
    });

    expect(cost).toBe(3);
    expect(logExpense).toHaveBeenCalledOnce();
    expect(logExpense).toHaveBeenCalledWith(fakeDb, {
      category: "inference",
      amountCents: 3,
      description:
        "Cost for basic skill (model: claude-haiku-4-5-20251001, ~10000 input + ~2000 output tokens)",
      metadata: {
        requestId: "req-h1",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 10_000,
        outputTokens: 2_000,
        tokenCostCents: 1.6,
        infraOverheadCents: 1,
      },
      nicheId: undefined,
      experimentId: undefined,
    });
  });

  it("calculates cost correctly for claude-sonnet-4-20250514", () => {
    // input: 5,000 tokens at 0.30 cents/1K = 1.5 cents
    // output: 1,000 tokens at 1.50 cents/1K = 1.5 cents
    // total: 1.5 + 1.5 + 1 = 4.0 → ceil = 4
    const cost = recordExpense(fakeDb, {
      tier: "premium",
      model: "claude-sonnet-4-20250514",
      inputTokens: 5_000,
      outputTokens: 1_000,
      requestId: "req-s1",
    });

    expect(cost).toBe(4);
  });

  it("calculates cost correctly for gpt-4o-mini", () => {
    // input: 20,000 tokens at 0.015 cents/1K = 0.3 cents
    // output: 5,000 tokens at 0.06 cents/1K = 0.3 cents
    // total: 0.3 + 0.3 + 1 = 1.6 → ceil = 2
    const cost = recordExpense(fakeDb, {
      tier: "basic",
      model: "gpt-4o-mini",
      inputTokens: 20_000,
      outputTokens: 5_000,
      requestId: "req-g1",
    });

    expect(cost).toBe(2);
  });

  it("calculates cost correctly for gpt-4o", () => {
    // input: 10,000 tokens at 0.25 cents/1K = 2.5 cents
    // output: 3,000 tokens at 1.00 cents/1K = 3.0 cents
    // total: 2.5 + 3.0 + 1 = 6.5 → ceil = 7
    const cost = recordExpense(fakeDb, {
      tier: "premium",
      model: "gpt-4o",
      inputTokens: 10_000,
      outputTokens: 3_000,
      requestId: "req-g2",
    });

    expect(cost).toBe(7);
  });

  it("defaults to haiku input rate and output rate for unknown models", () => {
    // input: 10,000 tokens at 0.08 cents/1K (default) = 0.8 cents
    // output: 2,000 tokens at 0.40 cents/1K (default) = 0.8 cents
    // total: 0.8 + 0.8 + 1 = 2.6 → ceil = 3
    const cost = recordExpense(fakeDb, {
      tier: "basic",
      model: "unknown-model-xyz",
      inputTokens: 10_000,
      outputTokens: 2_000,
      requestId: "req-u1",
    });

    expect(cost).toBe(3);
  });
});
