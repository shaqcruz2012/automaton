import { describe, it, expect } from "vitest";
import { getGatewayPricing, usdToAtomic, buildPaymentRequirement } from "../../gateway/pricing.js";

describe("gateway pricing", () => {
  it("returns pricing config with all tiers", () => {
    const pricing = getGatewayPricing();
    expect(pricing.tiers["summarize-basic"]).toBeDefined();
    expect(pricing.tiers["brief-standard"]).toBeDefined();
    expect(pricing.tiers["brief-premium"]).toBeDefined();
    expect(pricing.tiers["analyze"]).toBeDefined();
    expect(pricing.tiers["trustcheck"]).toBeDefined();
  });

  it("has correct wallet address", () => {
    const pricing = getGatewayPricing();
    expect(pricing.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("converts USD to USDC atomic units correctly", () => {
    expect(usdToAtomic(0.25)).toBe("250000");
    expect(usdToAtomic(2.5)).toBe("2500000");
    expect(usdToAtomic(15.0)).toBe("15000000");
    expect(usdToAtomic(0.01)).toBe("10000");
    expect(usdToAtomic(0.05)).toBe("50000");
  });

  it("builds a valid 402 payment requirement", () => {
    const pricing = getGatewayPricing();
    const req = buildPaymentRequirement(pricing, "summarize-basic");
    expect(req.x402Version).toBe(1);
    expect(req.accepts).toHaveLength(1);
    expect(req.accepts[0].maxAmountRequired).toBe("250000");
    expect(req.accepts[0].payToAddress).toBe(pricing.walletAddress);
    expect(req.accepts[0].scheme).toBe("exact");
  });

  it("throws for unknown tier", () => {
    const pricing = getGatewayPricing();
    expect(() => buildPaymentRequirement(pricing, "nonexistent")).toThrow();
  });
});
