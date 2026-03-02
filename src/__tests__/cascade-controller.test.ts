import { describe, it, expect } from "vitest";
import type { CascadePool } from "../types.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { POOL_CASCADE_ORDER, getProvidersForPool, getNextPool } from "../inference/pools.js";
import { CascadeController } from "../inference/cascade-controller.js";
import type { InferenceResult, SurvivalTier } from "../types.js";

describe("CascadePool type", () => {
  it("accepts valid pool values", () => {
    const pools: CascadePool[] = ["paid", "free_cloud", "local"];
    expect(pools).toHaveLength(3);
  });
});

describe("Provider Registry — cascade pools", () => {
  it("has Cerebras in the default providers", () => {
    const registry = new ProviderRegistry();
    const providers = registry.getProviders();
    const cerebras = providers.find((p) => p.id === "cerebras");
    expect(cerebras).toBeDefined();
    expect(cerebras!.enabled).toBe(true);
    expect(cerebras!.pool).toBe("free_cloud");
  });

  it("has SambaNova in the default providers", () => {
    const registry = new ProviderRegistry();
    const providers = registry.getProviders();
    const samba = providers.find((p) => p.id === "sambanova");
    expect(samba).toBeDefined();
    expect(samba!.enabled).toBe(true);
    expect(samba!.pool).toBe("free_cloud");
  });

  it("has HuggingFace in the default providers", () => {
    const registry = new ProviderRegistry();
    const providers = registry.getProviders();
    const hf = providers.find((p) => p.id === "huggingface");
    expect(hf).toBeDefined();
    expect(hf!.enabled).toBe(true);
    expect(hf!.pool).toBe("free_cloud");
  });

  it("has Together enabled with free_cloud pool", () => {
    const registry = new ProviderRegistry();
    const providers = registry.getProviders();
    const together = providers.find((p) => p.id === "together");
    expect(together).toBeDefined();
    expect(together!.enabled).toBe(true);
    expect(together!.pool).toBe("free_cloud");
  });

  it("splits Groq into paid and free_cloud pools", () => {
    const registry = new ProviderRegistry();
    const providers = registry.getProviders();
    const groqPaid = providers.find((p) => p.id === "groq");
    const groqFree = providers.find((p) => p.id === "groq-free");
    expect(groqPaid).toBeDefined();
    expect(groqPaid!.pool).toBe("paid");
    expect(groqFree).toBeDefined();
    expect(groqFree!.pool).toBe("free_cloud");
  });

  it("assigns existing providers to correct pools", () => {
    const registry = new ProviderRegistry();
    const providers = registry.getProviders();
    expect(providers.find((p) => p.id === "anthropic")!.pool).toBe("paid");
    expect(providers.find((p) => p.id === "openai")!.pool).toBe("paid");
    expect(providers.find((p) => p.id === "local")!.pool).toBe("local");
  });
});

describe("Pool definitions", () => {
  it("defines cascade order as paid -> free_cloud -> local", () => {
    expect(POOL_CASCADE_ORDER).toEqual(["paid", "free_cloud", "local"]);
  });

  it("returns paid providers for the paid pool", () => {
    const providers = getProvidersForPool("paid");
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("groq");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).not.toContain("cerebras");
    expect(ids).not.toContain("local");
  });

  it("returns free cloud providers for the free_cloud pool", () => {
    const providers = getProvidersForPool("free_cloud");
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("groq-free");
    expect(ids).toContain("cerebras");
    expect(ids).toContain("sambanova");
    expect(ids).toContain("together");
    expect(ids).toContain("huggingface");
    expect(ids).not.toContain("anthropic");
  });

  it("returns local providers for the local pool (empty when disabled)", () => {
    const providers = getProvidersForPool("local");
    const ids = providers.map((p) => p.id);
    // local provider is disabled by default, so pool is empty
    expect(ids).not.toContain("groq");
  });

  it("getNextPool returns free_cloud after paid", () => {
    expect(getNextPool("paid")).toBe("free_cloud");
  });

  it("getNextPool returns local after free_cloud", () => {
    expect(getNextPool("free_cloud")).toBe("local");
  });

  it("getNextPool returns null after local", () => {
    expect(getNextPool("local")).toBeNull();
  });
});

describe("CascadeController", () => {
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

  describe("selectPool", () => {
    it("returns free_cloud when survival tier is critical", () => {
      const controller = new CascadeController(mockDb(1000, 500));
      expect(controller.selectPool("critical")).toBe("free_cloud");
    });

    it("returns free_cloud when survival tier is dead", () => {
      const controller = new CascadeController(mockDb(1000, 500));
      expect(controller.selectPool("dead")).toBe("free_cloud");
    });

    it("returns free_cloud when survival tier is low_compute", () => {
      const controller = new CascadeController(mockDb(1000, 500));
      expect(controller.selectPool("low_compute")).toBe("free_cloud");
    });

    it("returns paid when profitable and tier is normal", () => {
      const controller = new CascadeController(mockDb(1000, 500));
      expect(controller.selectPool("normal")).toBe("paid");
    });

    it("returns paid when profitable and tier is high", () => {
      const controller = new CascadeController(mockDb(5000, 1000));
      expect(controller.selectPool("high")).toBe("paid");
    });

    it("returns free_cloud when unprofitable and tier is normal", () => {
      const controller = new CascadeController(mockDb(500, 1000));
      expect(controller.selectPool("normal")).toBe("free_cloud");
    });

    it("returns free_cloud when revenue equals expenses", () => {
      const controller = new CascadeController(mockDb(1000, 1000));
      expect(controller.selectPool("normal")).toBe("free_cloud");
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
  });

  describe("infer", () => {
    it("calls router and returns result on success", async () => {
      const controller = new CascadeController(mockDb(1000, 500));
      const mockResult: InferenceResult = {
        content: "test response",
        model: "test-model",
        provider: "groq",
        inputTokens: 100,
        outputTokens: 50,
        costCents: 0,
        latencyMs: 200,
        finishReason: "stop",
        toolCalls: undefined,
      };
      const mockRouter = {
        route: async () => mockResult,
      } as any;

      const result = await controller.infer(
        {
          messages: [],
          taskType: "agent_turn",
          tier: "normal" as SurvivalTier,
          sessionId: "test",
          turnId: "t1",
          tools: [],
        },
        mockRouter,
        async () => ({}),
      );

      expect(result.content).toBe("test response");
    });
  });
});
