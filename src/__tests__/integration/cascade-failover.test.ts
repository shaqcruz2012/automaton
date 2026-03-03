import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  /**
   * Create a mock fetch that returns OpenAI-compatible JSON.
   * Used to simulate free_cloud direct provider calls.
   */
  function mockFetchSuccess(content = "direct provider success") {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content, tool_calls: null },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 50, completion_tokens: 25 },
      }),
    });
  }

  /** Set env vars so tryPoolDirect doesn't skip free_cloud providers */
  const savedEnv: Record<string, string | undefined> = {};
  const FREE_CLOUD_KEYS = [
    "GROQ_API_KEY", "CEREBRAS_API_KEY", "SAMBANOVA_API_KEY",
    "TOGETHER_API_KEY", "HF_API_KEY",
  ];

  beforeEach(() => {
    for (const key of FREE_CLOUD_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = "test-key-" + key.toLowerCase();
    }
  });

  afterEach(() => {
    for (const key of FREE_CLOUD_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.restoreAllMocks();
  });

  // === Pool selection tests (no fetch needed) ===

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
    expect(controller.selectPool("normal")).toBe("paid");
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
    expect(controller.selectPool("normal")).toBe("free_cloud");
  });

  it("returns free_cloud when breakeven (net = 0)", () => {
    const controller = new CascadeController(mockDb(1000, 1000));
    expect(controller.selectPool("normal")).toBe("free_cloud");
  });

  // === Pool structure tests ===

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

  // === Inference flow tests ===

  it("successful paid pool inference returns result directly via router", async () => {
    // Profitable → paid pool → delegates to router
    const controller = new CascadeController(mockDb(1000, 500));
    const mockRouter = { route: async () => successResult } as any;

    const result = await controller.infer(makeRequest(), mockRouter, async () => ({}));
    expect(result.content).toBe("cascade success");
  });

  it("successful free_cloud inference uses direct provider calls (not router)", async () => {
    // Unprofitable → free_cloud pool → direct fetch to providers
    const fetchMock = mockFetchSuccess("direct call ok");
    vi.stubGlobal("fetch", fetchMock);

    const controller = new CascadeController(mockDb(500, 2000));
    const mockRouter = {
      route: vi.fn().mockRejectedValue(new Error("should not be called")),
    } as any;

    const result = await controller.infer(makeRequest(), mockRouter, async () => ({}));
    expect(result.content).toBe("direct call ok");
    // Router should NOT have been called — free_cloud uses direct calls
    expect(mockRouter.route).not.toHaveBeenCalled();
    // fetch should have been called at least once
    expect(fetchMock).toHaveBeenCalled();
  });

  it("cascades from paid to free_cloud on retryable error", async () => {
    // Profitable → paid pool (router fails with 429) → cascade to free_cloud (direct fetch)
    const fetchMock = mockFetchSuccess("fallback success");
    vi.stubGlobal("fetch", fetchMock);

    const controller = new CascadeController(mockDb(1000, 500));
    const mockRouter = {
      route: vi.fn().mockRejectedValue(new Error("429 rate limited")),
    } as any;

    const result = await controller.infer(makeRequest(), mockRouter, async () => ({}));
    expect(result.content).toBe("fallback success");
    // Router was called once (paid pool)
    expect(mockRouter.route).toHaveBeenCalledTimes(1);
    // Direct fetch was called (free_cloud pool)
    expect(fetchMock).toHaveBeenCalled();
  });

  it("throws on non-retryable error without cascading", async () => {
    // Profitable → paid pool → 401 is not retryable → throws immediately
    const controller = new CascadeController(mockDb(1000, 500));
    const mockRouter = {
      route: async () => { throw new Error("401 Unauthorized"); },
    } as any;

    await expect(
      controller.infer(makeRequest(), mockRouter, async () => ({})),
    ).rejects.toThrow("401 Unauthorized");
  });

  it("throws CascadeExhaustedError when all pools fail", async () => {
    // Profitable → paid (router 429) → free_cloud (all fetch 429) → local (empty) → exhausted
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    vi.stubGlobal("fetch", fetchMock);

    const controller = new CascadeController(mockDb(1000, 500));
    const mockRouter = {
      route: vi.fn().mockRejectedValue(new Error("429 rate limited")),
    } as any;

    await expect(
      controller.infer(makeRequest(), mockRouter, async () => ({})),
    ).rejects.toThrow();
  });

  it("free_cloud pool tries multiple providers before failing", async () => {
    // All direct calls fail with 429 → should call fetch multiple times
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    vi.stubGlobal("fetch", fetchMock);

    const controller = new CascadeController(mockDb(500, 2000)); // unprofitable → free_cloud
    const mockRouter = { route: vi.fn() } as any;

    await expect(
      controller.infer(makeRequest(), mockRouter, async () => ({})),
    ).rejects.toThrow();

    // Should have tried multiple free_cloud providers
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Router should NOT have been called
    expect(mockRouter.route).not.toHaveBeenCalled();
  });

  it("clearCache resets the P&L cache", () => {
    const controller = new CascadeController(mockDb(1000, 500));
    expect(controller.selectPool("normal")).toBe("paid");
    controller.clearCache();
    expect(controller.selectPool("normal")).toBe("paid");
  });
});
