import { describe, expect, it } from "vitest";
import {
  ContextManager,
  type TokenCounter,
} from "../memory/context-manager.js";

function fixedTokenCounter(tokensPerMessage: number): TokenCounter {
  const cache = new Map<string, number>();

  const countTokens = (text: string): number => {
    const key = `k::${text}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    cache.set(key, tokensPerMessage);
    return tokensPerMessage;
  };

  return {
    countTokens,
    cache,
    countBatch: (texts: string[]) => texts.map((text) => countTokens(text)),
  };
}

function makeTurn(index: number): any {
  return {
    input: `turn-${index}`,
    inputSource: "user",
  };
}

describe("ContextManager immutability and budget", () => {
  it("getUtilization returns a copy — mutating the returned object does not affect internal state", () => {
    const manager = new ContextManager(fixedTokenCounter(10));
    manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1)],
      modelContextWindow: 200,
      reserveTokens: 20,
    });

    const first = manager.getUtilization();
    first.totalTokens = 999_999;
    first.usedTokens = 0;
    first.recommendation = "emergency";

    const second = manager.getUtilization();
    expect(second.totalTokens).toBe(200);
    expect(second.usedTokens).toBeGreaterThan(0);
    expect(second.recommendation).toBe("ok");
  });

  it("renderTurn clones chat messages — mutating output does not affect input", () => {
    const manager = new ContextManager(fixedTokenCounter(5));
    const inputMessage = { role: "user" as const, content: "original-content" };

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [inputMessage],
      modelContextWindow: 200,
      reserveTokens: 0,
    });

    const outputMessage = assembled.messages.find(
      (m) => m.content === "original-content",
    );
    expect(outputMessage).toBeDefined();

    outputMessage!.content = "mutated-content";

    expect(inputMessage.content).toBe("original-content");
  });

  it("context budget includes system prompt tokens", () => {
    const manager = new ContextManager(fixedTokenCounter(10));

    const assembled = manager.assembleContext({
      systemPrompt: "This is the system prompt",
      recentTurns: [],
      modelContextWindow: 200,
      reserveTokens: 20,
    });

    expect(assembled.budget.systemPromptTokens).toBeGreaterThan(0);
    expect(assembled.budget.systemPromptTokens).toBe(10);
  });

  it("recent turns are included in context", () => {
    const manager = new ContextManager(fixedTokenCounter(5));

    const assembled = manager.assembleContext({
      systemPrompt: "sys",
      recentTurns: [makeTurn(1), makeTurn(2), makeTurn(3)],
      modelContextWindow: 200,
      reserveTokens: 0,
    });

    const text = assembled.messages.map((m) => m.content).join("\n");
    expect(text).toContain("turn-1");
    expect(text).toContain("turn-2");
    expect(text).toContain("turn-3");
    expect(assembled.utilization.turnsInContext).toBe(3);
  });
});
