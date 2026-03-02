import { describe, it, expect } from "vitest";
import { CascadeController, CascadeExhaustedError } from "../../inference/cascade-controller.js";
import { POOL_CASCADE_ORDER, getProvidersForPool, getNextPool } from "../../inference/pools.js";
import type { InferenceResult, SurvivalTier } from "../../types.js";

describe("Cascade failover integration", () => {
  function mockDb(revenueCents: number, expenseCents: number) {
    return {
      prepare: (sql: string) => ({
        get: (..._args: any[]) => {
          if (sql.includes("revenue_events")) return { total: revenueCents };
          if (sql.includes("expense_events")) return { total: expenseCents };
          return { total: 0 };
        },
        all: () => [],
      }),
    } as any;
  }

  const successResult: InferenceResult = {
    content: "cascade success",
    model: "llama-3.3-70b-versatile",
    provider: "groq",
    inputTokens: 100,
    outputTokens: 50,
    costCents: 0,
    latencyMs: 200,
    finishReason: "stop",
    toolCalls: undefined,
  };

  function makeRequest(tier: SurvivalTier = "normal") {
    return {
      messages: [{ role: "user" as const, content: "test" }],
      taskType: "agent_turn" as const,
      tier,
      sessionId: "test-session",
      turnId: "test-turn",
      tools: [],
    };
  }

  it("uses paid pool when profitable at normal tier", () => {
    const controller = new CascadeController(mockDb(2000, 500));
    expect(controller.selectPool("normal")).toBe("paid");
  });

  it("uses free_cloud pool when unprofitable at normal tier", () => {
    const controller = new CascadeController(mockDb(500, 2000));
    expect(controller.selectPool("normal")).toBe("free_cloud");
  });

  it("forces free_cloud at critical tier even if profitable", () => {
    const controller = new CascadeController(mockDb(10000, 100));
    expect(controller.selectPool("critical")).toBe("free_cloud");
  });

  it("forces free_cloud at dead tier even if profitable", () => {
    const controller = new CascadeController(mockDb(10000, 100));
    expect(controller.selectPool("dead")).toBe("free_cloud");
  });

  it("forces free_cloud at low_compute tier even if profitable", () => {
    const controller = new CascadeController(mockDb(10000, 100));
    expect(controller.selectPool("low_compute")).toBe("free_cloud");
  });

  it("uses paid at high tier when profitable", () => {
    const controller = new CascadeController(mockDb(5000, 1000));
    expect(controller.selectPool("high")).toBe("paid");
  });

  it("caches P&L for 5 minutes", () => {
    const controller = new CascadeController(mockDb(1000, 500));
    // First call
    expect(controller.selectPool("normal")).toBe("paid");
    // Second call should use cache (same result)
    expect(controller.selectPool("normal")).toBe("paid");
  });

  it("handles missing accounting tables gracefully", () => {
    const db = {
      prepare: () => ({
        get: () => { throw new Error("no such table: revenue_events"); },
        all: () => [],
      }),
    } as any;
    const controller = new CascadeController(db);
    // Should default to free_cloud (netCents = 0, not > 0)
    expect(controller.selectPool("normal")).toBe("free_cloud");
  });

  it("returns free_cloud when breakeven (net = 0)", () => {
    const controller = new CascadeController(mockDb(1000, 1000));
    expect(controller.selectPool("normal")).toBe("free_cloud");
  });

  it("pool cascade order is paid → free_cloud → local", () => {
    expect(POOL_CASCADE_ORDER).toEqual(["paid", "free_cloud", "local"]);
  });

  it("getNextPool chains correctly", () => {
    expect(getNextPool("paid")).toBe("free_cloud");
    expect(getNextPool("free_cloud")).toBe("local");
    expect(getNextPool("local")).toBeNull();
  });

  it("paid pool contains groq, anthropic, openai", () => {
    const ids = getProvidersForPool("paid").map((p) => p.id);
    expect(ids).toContain("groq");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
  });

  it("free_cloud pool contains groq-free, cerebras, sambanova, together, huggingface", () => {
    const ids = getProvidersForPool("free_cloud").map((p) => p.id);
    expect(ids).toContain("groq-free");
    expect(ids).toContain("cerebras");
    expect(ids).toContain("sambanova");
    expect(ids).toContain("together");
    expect(ids).toContain("huggingface");
  });

  it("successful inference returns result directly", async () => {
    const controller = new CascadeController(mockDb(1000, 500));
    const mockRouter = { route: async () => successResult } as any;

    const result = await controller.infer(makeRequest(), mockRouter, async () => ({}));
    expect(result.content).toBe("cascade success");
  });

  it("cascades to next pool on retryable error", async () => {
    const controller = new CascadeController(mockDb(1000, 500));
    let callCount = 0;
    const mockRouter = {
      route: async () => {
        callCount++;
        if (callCount === 1) throw new Error("429 rate limited");
        return successResult;
      },
    } as any;

    const result = await controller.infer(makeRequest(), mockRouter, async () => ({}));
    expect(result.content).toBe("cascade success");
    expect(callCount).toBe(2); // First pool failed, second succeeded
  });

  it("throws on non-retryable error without cascading", async () => {
    const controller = new CascadeController(mockDb(1000, 500));
    const mockRouter = {
      route: async () => { throw new Error("401 Unauthorized"); },
    } as any;

    await expect(
      controller.infer(makeRequest(), mockRouter, async () => ({})),
    ).rejects.toThrow("401 Unauthorized");
  });

  it("clearCache resets the P&L cache", () => {
    const controller = new CascadeController(mockDb(1000, 500));
    expect(controller.selectPool("normal")).toBe("paid");
    controller.clearCache();
    // After clearing, it will recompute (same mock, same result)
    expect(controller.selectPool("normal")).toBe("paid");
  });
});
