/**
 * Gateway Pricing Tests
 *
 * Tests: loadWalletAddress behaviour, usdToAtomic conversion,
 * getGatewayPricing tier enumeration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs and os before importing the module under test
vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(),
  },
}));

vi.mock("os", () => ({
  default: {
    homedir: vi.fn(() => "/mock-home"),
  },
}));

import fs from "fs";
import { usdToAtomic, getGatewayPricing } from "../gateway/pricing.js";

const FAKE_WALLET_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.GATEWAY_WALLET_ADDRESS;
});

afterEach(() => {
  delete process.env.GATEWAY_WALLET_ADDRESS;
});

// ---------------------------------------------------------------------------
// loadWalletAddress (exercised via getGatewayPricing)
// ---------------------------------------------------------------------------

describe("loadWalletAddress", () => {
  it("throws when GATEWAY_WALLET_ADDRESS is not set and wallet.json is missing", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    expect(() => getGatewayPricing()).toThrow(
      "GATEWAY_WALLET_ADDRESS env var is required",
    );
  });

  it("returns env var value when GATEWAY_WALLET_ADDRESS is set", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    process.env.GATEWAY_WALLET_ADDRESS = FAKE_WALLET_ADDRESS;

    const pricing = getGatewayPricing();

    expect(pricing.walletAddress).toBe(FAKE_WALLET_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// usdToAtomic
// ---------------------------------------------------------------------------

describe("usdToAtomic", () => {
  it.each([
    { usd: 0.25, expected: "250000" },
    { usd: 15.0, expected: "15000000" },
    { usd: 0.01, expected: "10000" },
    { usd: 2.5, expected: "2500000" },
    { usd: 0, expected: "0" },
    { usd: 1, expected: "1000000" },
  ])("converts $usd USD to $expected atomic units", ({ usd, expected }) => {
    expect(usdToAtomic(usd)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// getGatewayPricing
// ---------------------------------------------------------------------------

describe("getGatewayPricing", () => {
  it("returns all expected tiers", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    process.env.GATEWAY_WALLET_ADDRESS = FAKE_WALLET_ADDRESS;

    const pricing = getGatewayPricing();

    const expectedTiers = [
      "summarize-basic",
      "brief-standard",
      "brief-premium",
      "analyze",
      "trustcheck",
      "summarize-url",
    ];

    expect(Object.keys(pricing.tiers).sort()).toEqual(expectedTiers.sort());
  });

  it("includes correct network and USDC address", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    process.env.GATEWAY_WALLET_ADDRESS = FAKE_WALLET_ADDRESS;

    const pricing = getGatewayPricing();

    expect(pricing.network).toBe("eip155:8453");
    expect(pricing.usdcAddress).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
    expect(pricing.deadlineSeconds).toBe(300);
  });

  it("tier priceAtomic values match usdToAtomic of priceUsd", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    process.env.GATEWAY_WALLET_ADDRESS = FAKE_WALLET_ADDRESS;

    const pricing = getGatewayPricing();

    for (const [name, tier] of Object.entries(pricing.tiers)) {
      expect(tier.priceAtomic).toBe(usdToAtomic(tier.priceUsd));
    }
  });
});
