/**
 * Survival Error-Logging Tests
 *
 * Verifies that catch blocks in funding.ts and monitor.ts log errors
 * via console.warn instead of silently swallowing them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

// Mock treasury module so we can force getOnChainBalance to throw
vi.mock("../local/treasury.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local/treasury.js")>();
  return {
    ...actual,
    getOnChainBalance: vi.fn().mockResolvedValue({
      ok: true,
      balanceCents: 500,
      balanceUsd: 5.0,
    }),
  };
});

// Mock accounting module so we can force estimateDailyBurnCents to throw
vi.mock("../local/accounting.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../local/accounting.js")>();
  return {
    ...actual,
    estimateDailyBurnCents: vi.fn().mockReturnValue(100),
  };
});

// Import after mocks are set up
import { executeFundingStrategies } from "../survival/funding.js";
import { checkResources } from "../survival/monitor.js";
import { getOnChainBalance } from "../local/treasury.js";
import { estimateDailyBurnCents } from "../local/accounting.js";

describe("survival error logging", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getOnChainBalance).mockReset();
    vi.mocked(estimateDailyBurnCents).mockReset();
    // Default: succeed
    vi.mocked(getOnChainBalance).mockResolvedValue({
      ok: true,
      balanceCents: 500,
      balanceUsd: 5.0,
    } as any);
    vi.mocked(estimateDailyBurnCents).mockReturnValue(100);
  });

  afterEach(() => {
    db.close();
    warnSpy.mockRestore();
  });

  // ─── funding.ts ───────────────────────────────────────────────

  it("funding.ts catch block logs the error when balance fetch throws", async () => {
    const error = new Error("RPC timeout");
    vi.mocked(getOnChainBalance).mockRejectedValueOnce(error);

    const identity = createTestIdentity();
    const config = createTestConfig();

    // Should not throw — error is caught internally
    await executeFundingStrategies("low_compute", identity, config, db, conway);

    expect(warnSpy).toHaveBeenCalledWith(
      "[funding] Balance fetch failed:",
      "RPC timeout",
    );
  });

  // ─── monitor.ts: balance fetch ────────────────────────────────

  it("monitor.ts balance fetch catch block logs the error", async () => {
    const error = new Error("Network unreachable");
    vi.mocked(getOnChainBalance).mockRejectedValueOnce(error);

    const identity = createTestIdentity();

    await checkResources(identity, conway, db);

    expect(warnSpy).toHaveBeenCalledWith(
      "[monitor] Balance fetch failed:",
      "Network unreachable",
    );
  });

  // ─── monitor.ts: burn rate ────────────────────────────────────

  it("monitor.ts burn rate catch block logs the error", async () => {
    const error = new Error("Corrupt ledger data");
    vi.mocked(estimateDailyBurnCents).mockImplementationOnce(() => {
      throw error;
    });

    const identity = createTestIdentity();

    await checkResources(identity, conway, db);

    expect(warnSpy).toHaveBeenCalledWith(
      "[monitor] Burn rate estimation failed:",
      "Corrupt ledger data",
    );
  });
});
