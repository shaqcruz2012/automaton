import { describe, it, expect } from "vitest";
import type {
  GatewayTier,
  GatewayPricing,
  X402Payment,
  VerifyResult,
  NonceRecord,
  PaymentRequirement,
} from "../../gateway/types.js";

describe("gateway types", () => {
  it("GatewayTier is structurally valid", () => {
    const tier: GatewayTier = {
      route: "/summarize",
      backend: "http://127.0.0.1:9000",
      priceUsd: 0.25,
      priceAtomic: "250000",
      maxInputTokens: 4000,
      model: "claude-haiku-4-5-20251001",
      description: "Basic summarization",
    };
    expect(tier.priceUsd).toBe(0.25);
  });

  it("PaymentRequirement matches x402 spec shape", () => {
    const req: PaymentRequirement = {
      x402Version: 1,
      accepts: [{
        scheme: "exact",
        network: "eip155:8453",
        maxAmountRequired: "250000",
        payToAddress: "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706",
        requiredDeadlineSeconds: 300,
        usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      }],
    };
    expect(req.accepts).toHaveLength(1);
    expect(req.accepts[0].scheme).toBe("exact");
  });
});
