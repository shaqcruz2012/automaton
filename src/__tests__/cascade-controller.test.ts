import { describe, it, expect } from "vitest";
import type { CascadePool } from "../types.js";
import { ProviderRegistry } from "../inference/provider-registry.js";

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
