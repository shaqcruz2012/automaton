/**
 * Revenue Handlers Tests
 *
 * Unit tests for the refactored skill handlers in src/skills/revenue/handlers.ts.
 * Mocks: verifyPayment, callLLM (via fetch), recordRevenue, recordExpense.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../skills/revenue/payment-gate.js", () => ({
  verifyPayment: vi.fn(),
  recordRevenue: vi.fn(),
  recordExpense: vi.fn(),
}));

vi.mock("ulid", () => ({
  ulid: vi.fn(() => "TEST-REQUEST-ID"),
}));

import {
  handleSummarizeBasic,
  handleBriefStandard,
  handleBriefPremium,
} from "../skills/revenue/handlers.js";
import { verifyPayment, recordRevenue, recordExpense } from "../skills/revenue/payment-gate.js";
import type { SkillRequest, PricingConfig } from "../skills/revenue/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const fakeDb = {} as any;

function makePricing(overrides: Partial<PricingConfig> = {}): PricingConfig {
  return {
    tiers: {
      "summarize-basic": {
        price_usd: 0.05,
        description: "Basic summarization",
        max_input_tokens: 4000,
        model: "claude-haiku-4-5-20251001",
      },
      "brief-standard": {
        price_usd: 0.25,
        description: "Standard brief",
        max_input_tokens: 8000,
        model: "claude-sonnet-4-20250514",
      },
      "brief-premium": {
        price_usd: 1.0,
        description: "Premium deep dive",
        max_input_tokens: 16000,
        model: "claude-sonnet-4-20250514",
      },
    },
    ...overrides,
  };
}

function makeRequest(overrides: Partial<SkillRequest> = {}): SkillRequest {
  return {
    content: "Some content to summarize.",
    paymentProof: "valid-proof-abc",
    ...overrides,
  };
}

/**
 * Stub global fetch to simulate a successful Anthropic LLM response.
 */
function stubFetchSuccess(content = "LLM result text") {
  const fakeFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: "text", text: content }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  });
  vi.stubGlobal("fetch", fakeFetch);
  return fakeFetch;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: payment verifies OK
  vi.mocked(verifyPayment).mockReturnValue({ verified: true });
  // Default: recordExpense returns a cost
  vi.mocked(recordExpense).mockReturnValue(2);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("revenue handlers — input validation", () => {
  it("rejects empty content with error", async () => {
    const res = await handleSummarizeBasic(
      fakeDb,
      makeRequest({ content: "" }),
      makePricing(),
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/content must not be empty/i);
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only content", async () => {
    const res = await handleSummarizeBasic(
      fakeDb,
      makeRequest({ content: "   \n\t  " }),
      makePricing(),
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/content must not be empty/i);
    expect(verifyPayment).not.toHaveBeenCalled();
  });
});

describe("revenue handlers — pricing lookup", () => {
  it("returns error when tier not found in pricing", async () => {
    const pricingMissingTier = makePricing({
      tiers: {}, // no tiers at all
    });
    const res = await handleSummarizeBasic(
      fakeDb,
      makeRequest(),
      pricingMissingTier,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found in pricing/i);
    expect(verifyPayment).not.toHaveBeenCalled();
  });
});

describe("revenue handlers — payment verification", () => {
  it("returns error when payment verification fails", async () => {
    vi.mocked(verifyPayment).mockReturnValue({
      verified: false,
      error: "Payment required: $0.05 USD",
    });

    const res = await handleSummarizeBasic(
      fakeDb,
      makeRequest(),
      makePricing(),
    );
    expect(res.success).toBe(false);
    expect(res.error).toBe("Payment required: $0.05 USD");
    expect(recordRevenue).not.toHaveBeenCalled();
    expect(recordExpense).not.toHaveBeenCalled();
  });
});

describe("revenue handlers — token limit", () => {
  it("returns error when input exceeds token limit", async () => {
    // max_input_tokens for summarize-basic is 4000
    // Token estimate = content.length / 4, so 20000 chars = ~5000 tokens > 4000
    const longContent = "x".repeat(20_000);
    const res = await handleSummarizeBasic(
      fakeDb,
      makeRequest({ content: longContent }),
      makePricing(),
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/input too large/i);
    expect(res.error).toMatch(/5000 tokens/);
    expect(res.error).toMatch(/4000 token limit/);
  });
});

describe("revenue handlers — tier delegation", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    stubFetchSuccess("Summary output");
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });

  it("handleSummarizeBasic delegates to shared handler with correct tier", async () => {
    const res = await handleSummarizeBasic(
      fakeDb,
      makeRequest(),
      makePricing(),
    );
    expect(res.success).toBe(true);
    expect(res.tier).toBe("summarize-basic");
    expect(res.result).toBe("Summary output");
    expect(res.requestId).toBeTruthy();
    expect(recordRevenue).toHaveBeenCalledOnce();
    expect(recordRevenue).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ tier: "summarize-basic" }),
    );
    expect(recordExpense).toHaveBeenCalledOnce();
    expect(recordExpense).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ tier: "summarize-basic" }),
    );
  });

  it("handleBriefStandard delegates with correct tier", async () => {
    const res = await handleBriefStandard(
      fakeDb,
      makeRequest(),
      makePricing(),
    );
    expect(res.success).toBe(true);
    expect(res.tier).toBe("brief-standard");
    expect(res.result).toBe("Summary output");
    expect(recordRevenue).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ tier: "brief-standard" }),
    );
    expect(recordExpense).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ tier: "brief-standard" }),
    );
  });

  it("handleBriefPremium delegates with correct tier", async () => {
    const res = await handleBriefPremium(
      fakeDb,
      makeRequest(),
      makePricing(),
    );
    expect(res.success).toBe(true);
    expect(res.tier).toBe("brief-premium");
    expect(res.result).toBe("Summary output");
    expect(recordRevenue).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ tier: "brief-premium" }),
    );
    expect(recordExpense).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ tier: "brief-premium" }),
    );
  });
});
