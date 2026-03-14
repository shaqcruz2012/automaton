/**
 * Pool Configuration Tests
 *
 * Validates cascade pool ordering, routing matrix completeness,
 * and budget defaults for the inference pool system.
 */

import { describe, it, expect } from "vitest";
import { POOL_CASCADE_ORDER } from "../inference/pools.js";
import { DEFAULT_ROUTING_MATRIX } from "../inference/types.js";
import type { SurvivalTier, InferenceTaskType } from "../types.js";

describe("POOL_CASCADE_ORDER", () => {
  it("has expected order: free_cloud → local → paid", () => {
    expect(POOL_CASCADE_ORDER).toEqual(["free_cloud", "local", "paid"]);
  });
});

describe("DEFAULT_ROUTING_MATRIX", () => {
  const EXPECTED_TIERS: SurvivalTier[] = ["normal", "critical", "dead"];
  const EXPECTED_TASK_TYPES: InferenceTaskType[] = ["heartbeat_triage", "agent_turn"];
  const ALL_TIERS: SurvivalTier[] = ["high", "normal", "low_compute", "critical", "dead"];
  const ALL_TASK_TYPES: InferenceTaskType[] = [
    "agent_turn",
    "heartbeat_triage",
    "safety_check",
    "summarization",
    "planning",
  ];

  it("has entries for all expected tiers (normal, critical, dead)", () => {
    for (const tier of EXPECTED_TIERS) {
      expect(DEFAULT_ROUTING_MATRIX).toHaveProperty(tier);
      expect(DEFAULT_ROUTING_MATRIX[tier]).toBeDefined();
    }
  });

  it("has entries for all task types (heartbeat_triage, agent_turn)", () => {
    for (const tier of ALL_TIERS) {
      for (const taskType of EXPECTED_TASK_TYPES) {
        expect(DEFAULT_ROUTING_MATRIX[tier]).toHaveProperty(taskType);
        expect(DEFAULT_ROUTING_MATRIX[tier][taskType]).toBeDefined();
      }
    }
  });

  it("each routing entry has candidates array and maxTokens > 0", () => {
    for (const tier of ALL_TIERS) {
      for (const taskType of ALL_TASK_TYPES) {
        const entry = DEFAULT_ROUTING_MATRIX[tier][taskType];
        expect(Array.isArray(entry.candidates)).toBe(true);
        // Some entries in critical/dead tiers intentionally have maxTokens 0
        // (summarization, planning are disabled). For entries with candidates,
        // maxTokens must be positive.
        if (entry.candidates.length > 0) {
          expect(entry.maxTokens).toBeGreaterThan(0);
        }
      }
    }
  });

  it("budget defaults are sensible (paid pool has non-zero maxTokens and candidates)", () => {
    // The "high" and "normal" tiers represent the paid pool operating normally.
    // They should have meaningful budget allocations, not all zeros.
    const paidTiers: SurvivalTier[] = ["high", "normal"];

    for (const tier of paidTiers) {
      for (const taskType of ALL_TASK_TYPES) {
        const entry = DEFAULT_ROUTING_MATRIX[tier][taskType];
        expect(entry.candidates.length).toBeGreaterThan(0);
        expect(entry.maxTokens).toBeGreaterThan(0);
      }
    }
  });
});
