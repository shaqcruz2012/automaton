/**
 * Treasury Tax Collection Tests
 *
 * Comprehensive unit tests for collectCreatorTax in src/treasury/collectTax.ts.
 * All external I/O is mocked — no real blockchain calls, no real filesystem reads.
 *
 * Test cases:
 *  1.  No-transfer: zero profit
 *  2.  No-transfer: negative profit
 *  3.  No-transfer: critical survival tier
 *  4.  No-transfer: dead survival tier
 *  5.  No-transfer: min_reserve_usd guard
 *  6.  No-transfer: zero address (unconfigured)
 *  7.  Successful transfer — correct amount, logTransferEvent called
 *  8.  Custom tax rate — tax = profit * rate
 *  9.  Missing config file — falls back to DEFAULT_TAX_CONFIG
 * 10.  On-chain balance fetch failure — no transfer, no crash
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Database } from "better-sqlite3";

// ── Mocks (must be declared before any import of the module under test) ────────

vi.mock("../local/accounting.js", () => ({
  computeDailyNetProfit: vi.fn(),
  logTransferEvent: vi.fn(),
}));

vi.mock("../local/treasury.js", () => ({
  getOnChainBalance: vi.fn(),
  getSurvivalTierFromBalance: vi.fn(),
  transferUSDC: vi.fn(),
}));

vi.mock("../identity/wallet.js", () => ({
  loadWalletAccount: vi.fn(),
}));

vi.mock("../observability/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock fs so we can control config/tax.json existence without touching the disk.
// We only need to intercept existsSync and readFileSync; all other fs calls
// (e.g., from viem internals) are left as the real implementation via the
// actual module. We expose them as vi.fn() so tests can configure return values.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const mockExistsSync = vi.fn(actual.existsSync);
  const mockReadFileSync = vi.fn(actual.readFileSync) as typeof actual.readFileSync;
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockExistsSync,
      readFileSync: mockReadFileSync,
    },
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { collectCreatorTax, loadTaxConfig } from "../treasury/collectTax.js";
import {
  computeDailyNetProfit,
  logTransferEvent,
} from "../local/accounting.js";
import {
  getOnChainBalance,
  getSurvivalTierFromBalance,
  transferUSDC,
} from "../local/treasury.js";
import { loadWalletAccount } from "../identity/wallet.js";
import fs from "fs";

// ── Typed mock helpers ─────────────────────────────────────────────────────────

const mockComputeDailyNetProfit = vi.mocked(computeDailyNetProfit);
const mockLogTransferEvent = vi.mocked(logTransferEvent);
const mockGetOnChainBalance = vi.mocked(getOnChainBalance);
const mockGetSurvivalTierFromBalance = vi.mocked(getSurvivalTierFromBalance);
const mockTransferUSDC = vi.mocked(transferUSDC);
const mockLoadWalletAccount = vi.mocked(loadWalletAccount);
const mockFsExistsSync = vi.mocked(fs.existsSync);
// Use a loosely typed mock to avoid TypeScript overload resolution issues with
// readFileSync — tests only ever return plain JSON strings, not Buffers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFsReadFileSync = fs.readFileSync as unknown as { mockReturnValue: (v: string) => void; mockImplementation: (fn: () => never) => void };

// ── Shared fixtures ────────────────────────────────────────────────────────────

const FAKE_WALLET = {
  address: "0xABCDEF1234567890ABCDEf1234567890ABCDEf12" as `0x${string}`,
  sign: vi.fn(),
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
  signTypedData: vi.fn(),
  type: "local" as const,
  source: "privateKey" as const,
  publicKey: "0x0" as `0x${string}`,
};

const CREATOR_ADDRESS = "0x1111111111111111111111111111111111111111";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TEST_DATE = "2026-03-14";
const FAKE_TX_HASH = "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

/** Healthy balance: $200.00 USDC */
const HEALTHY_BALANCE = {
  ok: true as const,
  balanceUsd: 200.0,
  balanceCents: 20000,
  balanceAtomic: 200_000_000n,
};

/** A DailyProfit object with a given netProfitUsd */
function makeProfit(netProfitUsd: number) {
  const netProfitCents = Math.round(netProfitUsd * 100);
  return {
    date: TEST_DATE,
    revenueCents: netProfitCents > 0 ? netProfitCents + 1000 : 0,
    expenseCents: netProfitCents > 0 ? 1000 : Math.abs(netProfitCents),
    netProfitCents,
    netProfitUsd,
  };
}

/** A tax.json config payload */
function makeTaxConfig(overrides: Partial<{
  tax_rate_profit: number;
  min_reserve_usd: number;
  creator_tax_address: string;
}> = {}) {
  return {
    tax_rate_profit: 0.20,
    min_reserve_usd: 50.0,
    creator_tax_address: CREATOR_ADDRESS,
    ...overrides,
  };
}

// Stub the DB — collectCreatorTax receives it but we mock all DB-dependent calls
const fakeDb = {} as unknown as Database;

// ── Test Suite ────────────────────────────────────────────────────────────────

describe("collectCreatorTax", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // By default: config file exists and returns a healthy config
    mockFsExistsSync.mockReturnValue(true);
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify(makeTaxConfig()),
    );

    // By default: healthy profit, wallet, balance, tier, and successful transfer
    mockComputeDailyNetProfit.mockReturnValue(makeProfit(100.0));
    mockLoadWalletAccount.mockReturnValue(FAKE_WALLET as any);
    mockGetOnChainBalance.mockResolvedValue(HEALTHY_BALANCE);
    mockGetSurvivalTierFromBalance.mockReturnValue("normal");
    mockTransferUSDC.mockResolvedValue({
      success: true,
      txHash: FAKE_TX_HASH,
      amountUsd: 20.0,
      toAddress: CREATOR_ADDRESS,
    });
    mockLogTransferEvent.mockReturnValue("transfer-id-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Zero profit ───────────────────────────────────────────────────────────

  describe("no-transfer: zero profit", () => {
    it("returns transferred: false with a no-profit reason when netProfitUsd is 0", async () => {
      mockComputeDailyNetProfit.mockReturnValue(makeProfit(0));

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/no profit/i);
      expect(result.taxAmountUsd).toBe(0);
      expect(mockTransferUSDC).not.toHaveBeenCalled();
      expect(mockLogTransferEvent).not.toHaveBeenCalled();
    });
  });

  // ── 2. Negative profit ───────────────────────────────────────────────────────

  describe("no-transfer: negative profit", () => {
    it("returns transferred: false when daily net profit is negative", async () => {
      mockComputeDailyNetProfit.mockReturnValue(makeProfit(-50.0));

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.netProfitUsd).toBe(-50.0);
      expect(result.skippedReason).toMatch(/no profit/i);
      expect(mockTransferUSDC).not.toHaveBeenCalled();
    });
  });

  // ── 3. Critical survival tier ────────────────────────────────────────────────

  describe("no-transfer: critical survival tier", () => {
    it("skips when getSurvivalTierFromBalance returns 'critical'", async () => {
      mockGetSurvivalTierFromBalance.mockReturnValue("critical");

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/critical/i);
      expect(mockTransferUSDC).not.toHaveBeenCalled();
    });
  });

  // ── 4. Dead survival tier ────────────────────────────────────────────────────

  describe("no-transfer: dead survival tier", () => {
    it("skips when getSurvivalTierFromBalance returns 'dead'", async () => {
      mockGetSurvivalTierFromBalance.mockReturnValue("dead");

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/dead/i);
      expect(mockTransferUSDC).not.toHaveBeenCalled();
    });
  });

  // ── 5. min_reserve_usd guard ─────────────────────────────────────────────────

  describe("no-transfer: min_reserve_usd guard", () => {
    it("skips when balance after tax would fall below min_reserve_usd", async () => {
      // Balance $60, tax would be 20% of $100 = $20, leaving $40 < min_reserve $50
      mockGetOnChainBalance.mockResolvedValue({
        ok: true,
        balanceUsd: 60.0,
        balanceCents: 6000,
        balanceAtomic: 60_000_000n,
      });
      mockComputeDailyNetProfit.mockReturnValue(makeProfit(100.0));
      // Tier is fine — the reserve check is the blocker
      mockGetSurvivalTierFromBalance.mockReturnValue("normal");

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/min_reserve_usd|minimum reserve|below/i);
      expect(mockTransferUSDC).not.toHaveBeenCalled();
    });

    it("transfers when balance after tax is exactly equal to min_reserve_usd", async () => {
      // Balance $70, tax = 20% of $100 = $20, leaving $50 == min_reserve $50 → should transfer
      mockGetOnChainBalance.mockResolvedValue({
        ok: true,
        balanceUsd: 70.0,
        balanceCents: 7000,
        balanceAtomic: 70_000_000n,
      });
      mockComputeDailyNetProfit.mockReturnValue(makeProfit(100.0));
      mockGetSurvivalTierFromBalance.mockReturnValue("normal");

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(true);
    });
  });

  // ── 6. Zero address (unconfigured) ───────────────────────────────────────────

  describe("no-transfer: zero address", () => {
    it("skips when creator_tax_address is the zero address", async () => {
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify(makeTaxConfig({ creator_tax_address: ZERO_ADDRESS })),
      );

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/not configured|zero/i);
      // computeDailyNetProfit should NOT have been called — address check is first
      expect(mockComputeDailyNetProfit).not.toHaveBeenCalled();
      expect(mockTransferUSDC).not.toHaveBeenCalled();
    });
  });

  // ── 7. Successful transfer ───────────────────────────────────────────────────

  describe("successful transfer", () => {
    it("calls transferUSDC with the correct tax amount", async () => {
      // 20% of $100 profit = $20.00 tax
      mockComputeDailyNetProfit.mockReturnValue(makeProfit(100.0));

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(true);
      expect(result.taxAmountUsd).toBe(20.0);
      expect(mockTransferUSDC).toHaveBeenCalledOnce();
      const [walletArg, addressArg, amountArg] = mockTransferUSDC.mock.calls[0];
      expect(walletArg).toBe(FAKE_WALLET);
      expect(addressArg).toBe(CREATOR_ADDRESS);
      expect(amountArg).toBe(20.0);
    });

    it("calls logTransferEvent once after a successful transfer", async () => {
      await collectCreatorTax(fakeDb, TEST_DATE);

      expect(mockLogTransferEvent).toHaveBeenCalledOnce();
      const [dbArg, eventArg] = mockLogTransferEvent.mock.calls[0];
      expect(dbArg).toBe(fakeDb);
      expect(eventArg.type).toBe("tax");
      expect(eventArg.toAccount).toBe(CREATOR_ADDRESS);
      expect(eventArg.amountUsd).toBe(20.0);
    });

    it("includes txHash and balanceAfterUsd in the result", async () => {
      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.txHash).toBe(FAKE_TX_HASH);
      expect(result.balanceAfterUsd).toBeCloseTo(180.0); // $200 - $20
      expect(result.date).toBe(TEST_DATE);
    });

    it("does not include skippedReason when the transfer succeeds", async () => {
      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.skippedReason).toBeUndefined();
    });
  });

  // ── 8. Custom tax rate ───────────────────────────────────────────────────────

  describe("custom tax rate", () => {
    it("computes tax_amount = profit * tax_rate_profit (10%)", async () => {
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify(makeTaxConfig({ tax_rate_profit: 0.10 })),
      );
      mockComputeDailyNetProfit.mockReturnValue(makeProfit(100.0));
      mockTransferUSDC.mockResolvedValue({
        success: true,
        txHash: FAKE_TX_HASH,
        amountUsd: 10.0,
        toAddress: CREATOR_ADDRESS,
      });

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(true);
      expect(result.taxAmountUsd).toBe(10.0);
      const [, , amountArg] = mockTransferUSDC.mock.calls[0];
      expect(amountArg).toBe(10.0);
    });

    it("computes tax_amount = profit * tax_rate_profit (5%) on $50 profit", async () => {
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify(makeTaxConfig({ tax_rate_profit: 0.05 })),
      );
      mockComputeDailyNetProfit.mockReturnValue(makeProfit(50.0));
      mockTransferUSDC.mockResolvedValue({
        success: true,
        txHash: FAKE_TX_HASH,
        amountUsd: 2.5,
        toAddress: CREATOR_ADDRESS,
      });

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(true);
      expect(result.taxAmountUsd).toBeCloseTo(2.5);
    });

    it("rounds the tax amount to two decimal places", async () => {
      // $33.33 profit * 10% = $3.333 → rounds to $3.33
      mockFsReadFileSync.mockReturnValue(
        JSON.stringify(makeTaxConfig({ tax_rate_profit: 0.10 })),
      );
      mockComputeDailyNetProfit.mockReturnValue(makeProfit(33.33));
      mockTransferUSDC.mockResolvedValue({
        success: true,
        txHash: FAKE_TX_HASH,
        amountUsd: 3.33,
        toAddress: CREATOR_ADDRESS,
      });

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      // taxAmountUsd must be a multiple of 0.01
      expect(result.taxAmountUsd % 0.01).toBeCloseTo(0, 5);
    });
  });

  // ── 9. Missing config file ────────────────────────────────────────────────────

  describe("missing config file", () => {
    it("falls back to DEFAULT_TAX_CONFIG (zero address → no transfer) when file is absent", async () => {
      // File does not exist → DEFAULT_TAX_CONFIG has zero address
      mockFsExistsSync.mockReturnValue(false);

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      // The default creator_tax_address is the zero address, so transfer is skipped
      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/not configured|zero/i);
      expect(mockTransferUSDC).not.toHaveBeenCalled();
    });

    it("falls back to DEFAULT_TAX_CONFIG when config file JSON is malformed", async () => {
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockImplementation(() => {
        throw new SyntaxError("Unexpected token at position 0");
      });

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      // Falls back to defaults which have zero address → skipped
      expect(result.transferred).toBe(false);
      expect(mockTransferUSDC).not.toHaveBeenCalled();
    });
  });

  // ── 10. On-chain balance fetch failure ───────────────────────────────────────

  describe("on-chain balance fetch failure", () => {
    it("returns transferred: false when getOnChainBalance returns ok: false", async () => {
      mockGetOnChainBalance.mockResolvedValue({
        ok: false,
        balanceUsd: 0,
        balanceCents: 0,
        balanceAtomic: 0n,
        error: "RPC timeout",
      });

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/balance check failed|RPC/i);
      expect(mockTransferUSDC).not.toHaveBeenCalled();
      expect(mockLogTransferEvent).not.toHaveBeenCalled();
    });

    it("includes the RPC error message in skippedReason", async () => {
      mockGetOnChainBalance.mockResolvedValue({
        ok: false,
        balanceUsd: 0,
        balanceCents: 0,
        balanceAtomic: 0n,
        error: "connection refused",
      });

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/connection refused/i);
      expect(mockTransferUSDC).not.toHaveBeenCalled();
    });
  });

  // ── 11. Wallet not found ─────────────────────────────────────────────────────

  describe("no-transfer: wallet not found", () => {
    it("skips when loadWalletAccount returns null", async () => {
      mockLoadWalletAccount.mockReturnValue(null);

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/wallet/i);
      expect(mockGetOnChainBalance).not.toHaveBeenCalled();
      expect(mockTransferUSDC).not.toHaveBeenCalled();
    });
  });

  // ── 12. Transfer failure ─────────────────────────────────────────────────────

  describe("transfer failure", () => {
    it("returns transferred: false and does not call logTransferEvent when transferUSDC fails", async () => {
      mockTransferUSDC.mockResolvedValue({
        success: false,
        amountUsd: 20.0,
        toAddress: CREATOR_ADDRESS,
        error: "Out of gas",
      });

      const result = await collectCreatorTax(fakeDb, TEST_DATE);

      expect(result.transferred).toBe(false);
      expect(result.skippedReason).toMatch(/transfer failed|Out of gas/i);
      expect(mockLogTransferEvent).not.toHaveBeenCalled();
    });
  });

  // ── 13. Date defaulting ──────────────────────────────────────────────────────

  describe("date defaulting", () => {
    it("defaults to yesterday when no date is provided", async () => {
      await collectCreatorTax(fakeDb);

      expect(mockComputeDailyNetProfit).toHaveBeenCalledOnce();
      const [, dateArg] = mockComputeDailyNetProfit.mock.calls[0];
      // Should be a valid YYYY-MM-DD string
      expect(dateArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Should not be today
      const today = new Date().toISOString().slice(0, 10);
      expect(dateArg).not.toBe(today);
    });
  });
});

// ── loadTaxConfig unit tests ──────────────────────────────────────────────────

describe("loadTaxConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns defaults when config/tax.json does not exist", () => {
    mockFsExistsSync.mockReturnValue(false);

    const config = loadTaxConfig();

    expect(config.tax_rate_profit).toBe(0.20);
    expect(config.min_reserve_usd).toBe(50.0);
    expect(config.creator_tax_address).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("merges partial config with defaults", () => {
    mockFsExistsSync.mockReturnValue(true);
    // Only override tax_rate_profit
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify({ tax_rate_profit: 0.05 }),
    );

    const config = loadTaxConfig();

    expect(config.tax_rate_profit).toBe(0.05);
    expect(config.min_reserve_usd).toBe(50.0); // default
    expect(config.creator_tax_address).toBe(
      "0x0000000000000000000000000000000000000000",
    ); // default
  });

  it("returns defaults on JSON parse failure", () => {
    mockFsExistsSync.mockReturnValue(true);
    mockFsReadFileSync.mockReturnValue("{ bad json");

    const config = loadTaxConfig();

    expect(config.tax_rate_profit).toBe(0.20);
    expect(config.min_reserve_usd).toBe(50.0);
  });

  it("uses all values from a fully specified config", () => {
    const fullConfig = {
      tax_rate_profit: 0.15,
      min_reserve_usd: 100.0,
      creator_tax_address: CREATOR_ADDRESS,
    };
    mockFsExistsSync.mockReturnValue(true);
    mockFsReadFileSync.mockReturnValue(
      JSON.stringify(fullConfig),
    );

    const config = loadTaxConfig();

    expect(config.tax_rate_profit).toBe(0.15);
    expect(config.min_reserve_usd).toBe(100.0);
    expect(config.creator_tax_address).toBe(CREATOR_ADDRESS);
  });
});
