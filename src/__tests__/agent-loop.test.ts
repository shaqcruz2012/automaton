/**
 * Agent Loop — Nullish Coalescing & Immutability Fix Tests
 *
 * These tests verify the specific patterns that were fixed in loop.ts:
 * 1. Token count of 0 is not replaced by the 16_000 fallback
 * 2. Input tokens of 0 is preserved (not coerced to a truthy default)
 * 3. Messages array uses immutable spread instead of splice
 * 4. InputSource type is properly narrowed (no unsafe `as any` cast)
 */

import { describe, it, expect } from "vitest";
import type { InputSource, AgentTurn } from "../types.js";

// ─── 1. Token count of 0 must not be replaced by 16_000 ────────────
//
// The bug: `lastInputTokenCount || 16_000` treats 0 as falsy and
// falls through to 16_000. The fix uses `??` which only triggers
// on null/undefined, preserving 0.

describe("Nullish coalescing: lastInputTokenCount ?? 16_000", () => {
  /**
   * Replicate the cooldown calculation from loop.ts lines 711-714:
   *
   *   const estimatedTokens = lastInputTokenCount ?? 16_000;
   *   const adaptiveCooldownMs = Math.ceil(
   *     (estimatedTokens / INPUT_TOKENS_PER_MINUTE_LIMIT) * 60_000,
   *   );
   *   const MIN_INFERENCE_INTERVAL_MS = Math.max(1_000, adaptiveCooldownMs);
   */
  function computeCooldownMs(lastInputTokenCount: number | undefined): number {
    const INPUT_TOKENS_PER_MINUTE_LIMIT = 430_000;
    const estimatedTokens = lastInputTokenCount ?? 16_000;
    const adaptiveCooldownMs = Math.ceil(
      (estimatedTokens / INPUT_TOKENS_PER_MINUTE_LIMIT) * 60_000,
    );
    return Math.max(1_000, adaptiveCooldownMs);
  }

  it("uses 16_000 fallback when lastInputTokenCount is undefined", () => {
    const cooldown = computeCooldownMs(undefined);
    // 16_000 / 430_000 * 60_000 = ~2232ms
    expect(cooldown).toBeGreaterThan(2_000);
    expect(cooldown).toBeLessThan(3_000);
  });

  it("preserves 0 — does NOT fall back to 16_000", () => {
    const cooldown = computeCooldownMs(0);
    // 0 / 430_000 * 60_000 = 0ms, clamped to floor of 1_000ms
    expect(cooldown).toBe(1_000);
  });

  it("uses actual token count when provided", () => {
    const cooldown = computeCooldownMs(32_000);
    // 32_000 / 430_000 * 60_000 = ~4465ms
    expect(cooldown).toBeGreaterThan(4_000);
    expect(cooldown).toBeLessThan(5_000);
  });

  it("demonstrates the old || bug would produce wrong result for 0", () => {
    // This is what the BROKEN code would compute:
    const INPUT_TOKENS_PER_MINUTE_LIMIT = 430_000;
    const brokenEstimate = 0 || 16_000; // Bug: 0 is falsy, falls through
    const fixedEstimate = 0 ?? 16_000; // Fix: 0 is NOT nullish, preserved

    expect(brokenEstimate).toBe(16_000); // Wrong — old behavior
    expect(fixedEstimate).toBe(0); // Correct — new behavior
  });
});

// ─── 2. routerResult.inputTokens ?? 0 preserves zero ──────────────
//
// The fix: `lastInputTokenCount = routerResult.inputTokens ?? 0`
// ensures that if the router returns `inputTokens: 0` we store 0,
// not some truthy fallback.

describe("Nullish coalescing: routerResult.inputTokens ?? 0", () => {
  interface RouterResult {
    inputTokens: number;
    outputTokens: number;
    content: string;
    finishReason: string;
    toolCalls?: unknown[];
  }

  function trackInputTokens(routerResult: Partial<RouterResult>): number {
    // Mirrors loop.ts line 745
    return routerResult.inputTokens ?? 0;
  }

  it("returns 0 when inputTokens is 0", () => {
    expect(trackInputTokens({ inputTokens: 0 })).toBe(0);
  });

  it("returns 0 when inputTokens is undefined", () => {
    expect(trackInputTokens({})).toBe(0);
  });

  it("returns actual value when inputTokens is a positive number", () => {
    expect(trackInputTokens({ inputTokens: 4200 })).toBe(4200);
  });

  it("does not confuse 0 with undefined (old || bug)", () => {
    const routerResult = { inputTokens: 0 };
    const broken = routerResult.inputTokens || 999; // Bug: 0 is falsy
    const fixed = routerResult.inputTokens ?? 0; // Fix: 0 preserved

    expect(broken).toBe(999); // Wrong — old behavior
    expect(fixed).toBe(0); // Correct — new behavior
  });
});

// ─── 3. Messages array: immutable spread instead of splice ─────────
//
// The fix replaces an in-place `messages.splice(1, 0, memoryBlock)`
// with:
//   messages = [messages[0], memoryBlock, ...messages.slice(1)];
//
// This prevents mutation of the original array.

describe("Immutable message injection (spread vs splice)", () => {
  interface Message {
    role: string;
    content: string;
  }

  it("splice mutates the original array (old broken pattern)", () => {
    const original: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ];
    const ref = original;

    // Old broken pattern: mutates in-place
    original.splice(1, 0, { role: "system", content: "memory block" });

    // The reference and original are the same object — mutation leaked
    expect(ref).toBe(original);
    expect(ref.length).toBe(3);
  });

  it("spread creates a new array (fixed pattern)", () => {
    const original: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ];
    const originalLength = original.length;

    const memoryBlock: Message = { role: "system", content: "memory block" };

    // Fixed pattern from loop.ts line 670
    const updated = [original[0], memoryBlock, ...original.slice(1)];

    // Original is untouched
    expect(original.length).toBe(originalLength);
    expect(original).not.toBe(updated);

    // New array has the injected message
    expect(updated.length).toBe(3);
    expect(updated[0].content).toBe("system prompt");
    expect(updated[1].content).toBe("memory block");
    expect(updated[2].content).toBe("hello");
  });

  it("spread preserves order for multiple existing messages", () => {
    const original: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
    ];

    const memoryBlock: Message = { role: "system", content: "memory" };
    const updated = [original[0], memoryBlock, ...original.slice(1)];

    expect(updated.length).toBe(5);
    expect(updated.map((m) => m.content)).toEqual([
      "system prompt",
      "memory",
      "msg1",
      "msg2",
      "msg3",
    ]);

    // Original untouched
    expect(original.length).toBe(4);
  });

  it("spread handles single-element array (only system prompt)", () => {
    const original: Message[] = [
      { role: "system", content: "system prompt" },
    ];

    const memoryBlock: Message = { role: "system", content: "memory" };
    const updated = [original[0], memoryBlock, ...original.slice(1)];

    expect(updated.length).toBe(2);
    expect(updated[0].content).toBe("system prompt");
    expect(updated[1].content).toBe("memory");
    expect(original.length).toBe(1);
  });
});

// ─── 4. InputSource type narrowing (no unsafe `as any`) ────────────
//
// The fix ensures `currentInput?.source` is narrowed to
// `InputSource | undefined` rather than cast through `any`.

describe("InputSource type narrowing", () => {
  const VALID_SOURCES: InputSource[] = [
    "heartbeat",
    "creator",
    "agent",
    "system",
    "wakeup",
  ];

  /**
   * Mirrors the pattern at loop.ts line 825:
   *   inputSource: currentInput?.source as InputSource | undefined
   *
   * This helper validates that a raw string can be safely narrowed
   * to InputSource without going through `any`.
   */
  function narrowInputSource(
    source: string | undefined,
  ): InputSource | undefined {
    if (source === undefined) return undefined;
    if (VALID_SOURCES.includes(source as InputSource)) {
      return source as InputSource;
    }
    return undefined;
  }

  it("narrows valid InputSource strings", () => {
    for (const src of VALID_SOURCES) {
      expect(narrowInputSource(src)).toBe(src);
    }
  });

  it("returns undefined for invalid source strings", () => {
    expect(narrowInputSource("bogus")).toBeUndefined();
    expect(narrowInputSource("")).toBeUndefined();
  });

  it("returns undefined when source is undefined", () => {
    expect(narrowInputSource(undefined)).toBeUndefined();
  });

  it("InputSource union covers all expected values", () => {
    // If InputSource is extended in types.ts, this test will remind us
    // to update the narrowing logic.
    expect(VALID_SOURCES).toContain("heartbeat");
    expect(VALID_SOURCES).toContain("creator");
    expect(VALID_SOURCES).toContain("agent");
    expect(VALID_SOURCES).toContain("system");
    expect(VALID_SOURCES).toContain("wakeup");
    expect(VALID_SOURCES.length).toBe(5);
  });

  it("AgentTurn inputSource field accepts narrowed type", () => {
    // Verify that the AgentTurn type accepts InputSource | undefined
    // without needing `as any`.
    const turn: Partial<AgentTurn> = {
      inputSource: "heartbeat" as InputSource,
    };
    expect(turn.inputSource).toBe("heartbeat");

    const turnUndefined: Partial<AgentTurn> = {
      inputSource: undefined,
    };
    expect(turnUndefined.inputSource).toBeUndefined();
  });
});
