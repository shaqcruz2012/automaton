/**
 * Budget Defaults Tests
 *
 * Validates that exported budget constants in types.ts are internally
 * consistent and hold reasonable values.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOKEN_BUDGET,
  MAX_CHILDREN,
  DEFAULT_CONFIG,
  DEFAULT_MODEL_STRATEGY_CONFIG,
} from "../types.js";
import type { InferenceToolDefinition, InferenceOptions } from "../types.js";

// ─── Test 1: DEFAULT_TOKEN_BUDGET components sum to total ────────

describe("DEFAULT_TOKEN_BUDGET", () => {
  it("component budgets sum exactly to total", () => {
    const { total, systemPrompt, recentTurns, toolResults, memoryRetrieval } =
      DEFAULT_TOKEN_BUDGET;

    const componentSum =
      systemPrompt + recentTurns + toolResults + memoryRetrieval;

    expect(componentSum).toBe(total);
  });

  it("every component is a positive integer", () => {
    const { total, systemPrompt, recentTurns, toolResults, memoryRetrieval } =
      DEFAULT_TOKEN_BUDGET;

    for (const value of [
      total,
      systemPrompt,
      recentTurns,
      toolResults,
      memoryRetrieval,
    ]) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

// ─── Test 2: MAX_CHILDREN matches DEFAULT_CONFIG.maxChildren ─────

describe("MAX_CHILDREN", () => {
  it("equals DEFAULT_CONFIG.maxChildren", () => {
    expect(MAX_CHILDREN).toBe(DEFAULT_CONFIG.maxChildren);
  });
});

// ─── Test 3: InferenceToolDefinition is used (compile-time check) ─

describe("InferenceToolDefinition", () => {
  it("is assignable to InferenceOptions.tools element type", () => {
    // This test verifies at compile time that InferenceOptions.tools
    // uses InferenceToolDefinition[] rather than unknown[].
    // If the type were unknown[], this structured literal would still
    // compile, but the reverse assignment below would fail.
    const tool: InferenceToolDefinition = {
      type: "function",
      function: {
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object" },
      },
    };

    const options: InferenceOptions = { tools: [tool] };
    expect(options.tools).toHaveLength(1);

    // Verify the typed fields survive the round-trip (would not be
    // accessible if the array element type were unknown).
    const first = options.tools![0];
    expect(first.type).toBe("function");
    expect(first.function.name).toBe("test_tool");
  });
});

// ─── Test 4: DEFAULT_MODEL_STRATEGY_CONFIG has reasonable values ──

describe("DEFAULT_MODEL_STRATEGY_CONFIG", () => {
  it("has non-empty model identifiers", () => {
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.inferenceModel.length).toBeGreaterThan(
      0,
    );
    expect(
      DEFAULT_MODEL_STRATEGY_CONFIG.lowComputeModel.length,
    ).toBeGreaterThan(0);
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.criticalModel.length).toBeGreaterThan(
      0,
    );
  });

  it("maxTokensPerTurn is a positive integer", () => {
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.maxTokensPerTurn).toBeGreaterThan(0);
    expect(
      Number.isInteger(DEFAULT_MODEL_STRATEGY_CONFIG.maxTokensPerTurn),
    ).toBe(true);
  });

  it("budget-cents fields are non-negative integers (zero means no limit)", () => {
    for (const field of [
      "hourlyBudgetCents",
      "sessionBudgetCents",
      "perCallCeilingCents",
    ] as const) {
      const value = DEFAULT_MODEL_STRATEGY_CONFIG[field];
      expect(value).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("enableModelFallback is explicitly set", () => {
    expect(typeof DEFAULT_MODEL_STRATEGY_CONFIG.enableModelFallback).toBe(
      "boolean",
    );
  });

  it("anthropicApiVersion is a non-empty date string", () => {
    expect(
      DEFAULT_MODEL_STRATEGY_CONFIG.anthropicApiVersion.length,
    ).toBeGreaterThan(0);
    // Expect YYYY-MM-DD format
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.anthropicApiVersion).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});
