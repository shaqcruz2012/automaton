/**
 * Policy Engine Tests
 *
 * Tests for the PolicyEngine class:
 * 1. Returns "allow" when no rules trigger
 * 2. Returns "deny" when a rule denies
 * 3. Continues evaluation when a rule throws (doesn't crash)
 * 4. Handles null request.args gracefully (JSON.stringify doesn't throw)
 * 5. Error logging uses instanceof check, not unsafe cast
 * 6. All evaluated rules are tracked in rulesEvaluated
 * 7. Triggered rules are tracked in rulesTriggered
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PolicyEngine } from "../agent/policy-engine.js";
import type {
  AutomatonTool,
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
  ToolContext,
  SpendTrackerInterface,
} from "../types.js";
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

// ─── Test Helpers ───────────────────────────────────────────────

function createRawTestDb(): Database.Database {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS policy_decisions (
      id TEXT PRIMARY KEY,
      turn_id TEXT,
      tool_name TEXT NOT NULL,
      tool_args_hash TEXT NOT NULL,
      risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','caution','dangerous','forbidden')),
      decision TEXT NOT NULL CHECK(decision IN ('allow','deny','quarantine')),
      rules_evaluated TEXT NOT NULL DEFAULT '[]',
      rules_triggered TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL DEFAULT '',
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS spend_tracking (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      recipient TEXT,
      domain TEXT,
      category TEXT NOT NULL CHECK(category IN ('transfer','x402','inference','other')),
      window_hour TEXT NOT NULL,
      window_day TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

function createMockSpendTracker(): SpendTrackerInterface {
  return {
    recordSpend: () => {},
    getHourlySpend: () => 0,
    getDailySpend: () => 0,
    getTotalSpend: () => 0,
    checkLimit: () => ({
      allowed: true,
      currentHourlySpend: 0,
      currentDailySpend: 0,
      limitHourly: 10000,
      limitDaily: 25000,
    }),
    pruneOldRecords: () => 0,
  };
}

function createMockTool(overrides: Partial<AutomatonTool> = {}): AutomatonTool {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
    riskLevel: "safe",
    category: "vm",
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<PolicyRequest> = {},
): PolicyRequest {
  return {
    tool: createMockTool(),
    args: { foo: "bar" },
    context: {} as ToolContext,
    turnContext: {
      inputSource: "creator",
      turnToolCallCount: 0,
      sessionSpend: createMockSpendTracker(),
    },
    ...overrides,
  };
}

function makeRule(overrides: Partial<PolicyRule> & { id: string }): PolicyRule {
  return {
    description: `Rule: ${overrides.id}`,
    priority: 100,
    appliesTo: { by: "all" },
    evaluate: () => null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("PolicyEngine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createRawTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns 'allow' when no rules trigger", () => {
    const noopRule = makeRule({
      id: "noop",
      evaluate: () => null,
    });
    const engine = new PolicyEngine(db, [noopRule]);
    const decision = engine.evaluate(createRequest());

    expect(decision.action).toBe("allow");
    expect(decision.reasonCode).toBe("ALLOWED");
    expect(decision.humanMessage).toBe("All policy checks passed");
  });

  it("returns 'deny' when a rule denies", () => {
    const denyRule = makeRule({
      id: "hard-deny",
      evaluate: (): PolicyRuleResult => ({
        rule: "hard-deny",
        action: "deny",
        reasonCode: "BLOCKED",
        humanMessage: "Blocked by test rule",
      }),
    });
    const engine = new PolicyEngine(db, [denyRule]);
    const decision = engine.evaluate(createRequest());

    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("BLOCKED");
    expect(decision.humanMessage).toBe("Blocked by test rule");
  });

  it("continues evaluation when a rule throws (doesn't crash)", () => {
    const throwingRule = makeRule({
      id: "throws",
      priority: 10,
      evaluate: () => {
        throw new Error("kaboom");
      },
    });
    const allowRule = makeRule({
      id: "after-throw",
      priority: 20,
      evaluate: (): PolicyRuleResult => ({
        rule: "after-throw",
        action: "allow",
        reasonCode: "OK",
        humanMessage: "Allowed",
      }),
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new PolicyEngine(db, [throwingRule, allowRule]);
    const decision = engine.evaluate(createRequest());

    // Engine did not crash; it continued past the throwing rule
    expect(decision.action).toBe("allow");
    // The throwing rule was evaluated (attempted) but the after-throw rule also ran
    expect(decision.rulesEvaluated).toContain("throws");
    expect(decision.rulesEvaluated).toContain("after-throw");
    expect(decision.rulesTriggered).toContain("after-throw");

    consoleSpy.mockRestore();
  });

  it("handles null request.args gracefully (JSON.stringify doesn't throw)", () => {
    const engine = new PolicyEngine(db, []);
    // Pass args as null (cast to satisfy TS) to exercise the `?? {}` fallback
    const request = createRequest({ args: null as unknown as Record<string, unknown> });

    const decision = engine.evaluate(request);

    expect(decision.action).toBe("allow");
    // argsHash should be a valid SHA-256 hex string for '{}'
    expect(decision.argsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("error logging uses instanceof check, not unsafe cast", () => {
    const throwingRule = makeRule({
      id: "non-error-throw",
      evaluate: () => {
        // Throw a non-Error value to exercise the String(err) branch
        throw "string-error";
      },
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new PolicyEngine(db, [throwingRule]);
    engine.evaluate(createRequest());

    expect(consoleSpy).toHaveBeenCalledWith(
      "Policy rule evaluation failed",
      expect.objectContaining({
        ruleId: "non-error-throw",
        error: "string-error",
      }),
    );

    consoleSpy.mockRestore();
  });

  it("all evaluated rules are tracked in rulesEvaluated", () => {
    const ruleA = makeRule({
      id: "rule-a",
      priority: 10,
      evaluate: () => null,
    });
    const ruleB = makeRule({
      id: "rule-b",
      priority: 20,
      evaluate: (): PolicyRuleResult => ({
        rule: "rule-b",
        action: "allow",
        reasonCode: "OK",
        humanMessage: "ok",
      }),
    });
    const ruleC = makeRule({
      id: "rule-c",
      priority: 30,
      evaluate: () => null,
    });

    const engine = new PolicyEngine(db, [ruleA, ruleB, ruleC]);
    const decision = engine.evaluate(createRequest());

    expect(decision.rulesEvaluated).toEqual(["rule-a", "rule-b", "rule-c"]);
  });

  it("triggered rules are tracked in rulesTriggered", () => {
    const nullRule = makeRule({
      id: "silent",
      priority: 10,
      evaluate: () => null,
    });
    const triggerA = makeRule({
      id: "trigger-a",
      priority: 20,
      evaluate: (): PolicyRuleResult => ({
        rule: "trigger-a",
        action: "allow",
        reasonCode: "OK_A",
        humanMessage: "ok a",
      }),
    });
    const triggerB = makeRule({
      id: "trigger-b",
      priority: 30,
      evaluate: (): PolicyRuleResult => ({
        rule: "trigger-b",
        action: "quarantine",
        reasonCode: "Q_B",
        humanMessage: "quarantine b",
      }),
    });

    const engine = new PolicyEngine(db, [nullRule, triggerA, triggerB]);
    const decision = engine.evaluate(createRequest());

    // Only rules that returned a non-null result appear in rulesTriggered
    expect(decision.rulesTriggered).toEqual(["trigger-a", "trigger-b"]);
    // The silent rule was evaluated but not triggered
    expect(decision.rulesTriggered).not.toContain("silent");
    expect(decision.rulesEvaluated).toContain("silent");
  });
});
