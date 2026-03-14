/**
 * Heartbeat Tasks — Null Safety Tests
 *
 * Verifies that heartbeat tasks handle malformed, missing, and
 * corrupted data gracefully instead of propagating NaN / crashing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import {
  MockConwayClient,
  MockSocialClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase, TickContext, HeartbeatLegacyContext } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────

function createMockTickContext(
  db: AutomatonDatabase,
  overrides?: Partial<TickContext>,
): TickContext {
  return {
    tickId: "test-tick-1",
    startedAt: new Date(),
    creditBalance: 10_000,
    usdcBalance: 1.5,
    survivalTier: "normal",
    lowComputeMultiplier: 4,
    config: {
      entries: [],
      defaultIntervalMs: 60_000,
      lowComputeMultiplier: 4,
    },
    db: db.raw,
    ...overrides,
  };
}

function createTaskCtx(
  db: AutomatonDatabase,
  social?: MockSocialClient,
): HeartbeatLegacyContext {
  return {
    identity: createTestIdentity(),
    config: createTestConfig(),
    db,
    conway: new MockConwayClient(),
    social,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("Heartbeat Tasks — Null Safety", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. Uptime calculation handles NaN from Date.parse ──────────

  describe("heartbeat_ping — uptime NaN guard", () => {
    it("returns uptimeSeconds 0 when start_time is unparseable", async () => {
      // Store a garbage start_time that Date.parse will return NaN for
      db.setKV("start_time", "not-a-date");

      const tickCtx = createMockTickContext(db);
      const taskCtx = createTaskCtx(db);

      const result = await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);

      // Should not wake (balance is normal)
      expect(result.shouldWake).toBe(false);

      // Verify the persisted payload has uptimeSeconds === 0 (not NaN)
      const raw = db.getKV("last_heartbeat_ping");
      expect(raw).toBeTruthy();
      const payload = JSON.parse(raw!);
      expect(payload.uptimeSeconds).toBe(0);
      expect(Number.isNaN(payload.uptimeSeconds)).toBe(false);
    });

    it("returns valid uptime when start_time is a proper ISO string", async () => {
      // Set a start_time 10 seconds in the past
      const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
      db.setKV("start_time", tenSecondsAgo);

      const tickCtx = createMockTickContext(db);
      const taskCtx = createTaskCtx(db);

      await BUILTIN_TASKS.heartbeat_ping(tickCtx, taskCtx);

      const raw = db.getKV("last_heartbeat_ping");
      const payload = JSON.parse(raw!);
      // Should be at least 9 seconds (allowing for execution time)
      expect(payload.uptimeSeconds).toBeGreaterThanOrEqual(9);
      expect(Number.isNaN(payload.uptimeSeconds)).toBe(false);
    });
  });

  // ── 2. check_social_inbox skips messages with no id ────────────

  describe("check_social_inbox — message id guards", () => {
    it("skips messages with no id", async () => {
      const social = new MockSocialClient();
      social.pollResponses.push({
        messages: [
          { id: undefined as any, from: "alice", to: "bob", content: "hi", signedAt: "", createdAt: "" },
          { id: "msg-good", from: "carol", to: "bob", content: "hello", signedAt: "", createdAt: "" },
        ],
      });

      const tickCtx = createMockTickContext(db);
      const taskCtx = createTaskCtx(db, social);

      const result = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);

      // Only the valid message should be counted
      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("1 new message");
    });

    // ── 3. check_social_inbox skips messages with non-string id ──

    it("skips messages with non-string id", async () => {
      const social = new MockSocialClient();
      social.pollResponses.push({
        messages: [
          { id: 12345 as any, from: "alice", to: "bob", content: "hi", signedAt: "", createdAt: "" },
          { id: null as any, from: "alice", to: "bob", content: "yo", signedAt: "", createdAt: "" },
          { id: "msg-valid", from: "dave", to: "bob", content: "hey", signedAt: "", createdAt: "" },
        ],
      });

      const tickCtx = createMockTickContext(db);
      const taskCtx = createTaskCtx(db, social);

      const result = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);

      // Only the valid message should be counted
      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("1 new message");
    });
  });

  // ── 4. Wake message handles null m.from — uses "unknown" ───────

  describe("check_social_inbox — null from fallback", () => {
    it("uses 'unknown' when m.from is null", async () => {
      const social = new MockSocialClient();
      social.pollResponses.push({
        messages: [
          { id: "msg-nofrom", from: null as any, to: "bob", content: "anon msg", signedAt: "", createdAt: "" },
        ],
      });

      const tickCtx = createMockTickContext(db);
      const taskCtx = createTaskCtx(db, social);

      const result = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      // The wake message should contain "unknown" fallback, not "null" or crash
      expect(result.message).toContain("unknown");
      expect(result.message).not.toContain("null");
    });

    it("uses 'unknown' when m.from is undefined", async () => {
      const social = new MockSocialClient();
      social.pollResponses.push({
        messages: [
          { id: "msg-nofrom2", from: undefined as any, to: "bob", content: "anon msg", signedAt: "", createdAt: "" },
        ],
      });

      const tickCtx = createMockTickContext(db);
      const taskCtx = createTaskCtx(db, social);

      const result = await BUILTIN_TASKS.check_social_inbox(tickCtx, taskCtx);

      expect(result.shouldWake).toBe(true);
      expect(result.message).toContain("unknown");
    });
  });

  // ── 5. creator_tax_check handles non-array JSON parse result ───

  describe("creator_tax_check — corrupted history", () => {
    it("handles non-array JSON parse result for tax history", async () => {
      // Store a JSON object (not an array) as the history
      db.setKV("creator_tax_history", JSON.stringify({ bad: "data" }));

      // Set up conditions so the tax would fire:
      // balance above threshold, creator address set, etc.
      const tickCtx = createMockTickContext(db, {
        creditBalance: 5000,   // above default threshold of 1000
        survivalTier: "normal",
      });
      const config = createTestConfig();
      (config as any).creatorAddress = "0x1234567890abcdef1234567890abcdef12345678";
      (config as any).creatorTax = {
        enabled: true,
        taxRate: 20,
        thresholdCents: 1000,
        minTransferCents: 100,
        cooldownMs: 3_600_000,
      };

      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config,
        db,
        conway: new MockConwayClient(),
      };

      // The task should not crash even though history is not an array.
      // It will likely fail on the actual USDC transfer (no real wallet),
      // but the JSON parse + Array.isArray guard should not throw.
      const result = await BUILTIN_TASKS.creator_tax_check(tickCtx, taskCtx);

      // Should return without crashing — either success or caught error
      expect(result).toBeDefined();
      expect(result.shouldWake).toBe(false);
    });

    // ── 6. creator_tax_check handles corrupted JSON gracefully ────

    it("handles corrupted (unparseable) JSON for tax history", async () => {
      // Store invalid JSON
      db.setKV("creator_tax_history", "{not valid json!!");

      const tickCtx = createMockTickContext(db, {
        creditBalance: 5000,
        survivalTier: "normal",
      });
      const config = createTestConfig();
      (config as any).creatorAddress = "0x1234567890abcdef1234567890abcdef12345678";
      (config as any).creatorTax = {
        enabled: true,
        taxRate: 20,
        thresholdCents: 1000,
        minTransferCents: 100,
        cooldownMs: 3_600_000,
      };

      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config,
        db,
        conway: new MockConwayClient(),
      };

      // The corrupted JSON will cause JSON.parse to throw.
      // The outer try/catch in creator_tax_check should handle it.
      const result = await BUILTIN_TASKS.creator_tax_check(tickCtx, taskCtx);

      // Should return without crashing
      expect(result).toBeDefined();
      expect(result.shouldWake).toBe(false);
    });
  });
});
