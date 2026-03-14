/**
 * ProviderRegistry Tests
 *
 * Tests: resolveApiKey, resolveCandidates, getModel, and config parse failure handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { ProviderRegistry, DEFAULT_PROVIDERS } from "../inference/provider-registry.js";
import type { ProviderConfig } from "../inference/provider-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal provider for testing — only fields that matter for key resolution. */
function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: overrides.id ?? "test-provider",
    name: overrides.name ?? "Test Provider",
    baseUrl: overrides.baseUrl ?? "https://api.test.com/v1",
    apiKeyEnvVar: overrides.apiKeyEnvVar ?? "TEST_API_KEY",
    pool: overrides.pool ?? "paid",
    models: overrides.models ?? [
      {
        id: "test-model",
        tier: "fast",
        contextWindow: 8192,
        maxOutputTokens: 4096,
        costPerInputToken: 1,
        costPerOutputToken: 2,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: overrides.maxRequestsPerMinute ?? 100,
    maxTokensPerMinute: overrides.maxTokensPerMinute ?? 100000,
    priority: overrides.priority ?? 0,
    enabled: overrides.enabled ?? true,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("ProviderRegistry", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot env vars we will modify so we can restore them.
    for (const key of [
      "TEST_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "LOCAL_API_KEY",
      "AUTOMATON_CREDITS_BALANCE",
      "AUTOMATON_INFERENCE_TASK_TYPE",
    ]) {
      savedEnv[key] = process.env[key];
    }

    // Clear all relevant env vars by default.
    delete process.env.TEST_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.LOCAL_API_KEY;
    delete process.env.AUTOMATON_CREDITS_BALANCE;
    delete process.env.AUTOMATON_INFERENCE_TASK_TYPE;
  });

  afterEach(() => {
    // Restore original env.
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // -----------------------------------------------------------------------
  // 1. resolveApiKey returns the env var value when set
  // -----------------------------------------------------------------------
  describe("resolveApiKey", () => {
    it("returns the env var value when set", () => {
      process.env.TEST_API_KEY = "sk-test-secret-123";

      const provider = makeProvider({ apiKeyEnvVar: "TEST_API_KEY" });
      const registry = new ProviderRegistry([provider]);

      const resolved = registry.getModel("test-provider", "test-model");
      expect(resolved.apiKey).toBe("sk-test-secret-123");
    });

    // ---------------------------------------------------------------------
    // 2. resolveApiKey returns null when env var is not set (not a fake string)
    // ---------------------------------------------------------------------
    it("returns null when env var is not set", () => {
      // TEST_API_KEY is deleted in beforeEach — no value set.
      const provider = makeProvider({ apiKeyEnvVar: "TEST_API_KEY" });
      const registry = new ProviderRegistry([provider]);

      // getModel should throw because the key resolves to null.
      expect(() => registry.getModel("test-provider", "test-model")).toThrow(
        /API key not configured/,
      );
    });

    it("returns null when env var is an empty string", () => {
      process.env.TEST_API_KEY = "";

      const provider = makeProvider({ apiKeyEnvVar: "TEST_API_KEY" });
      const registry = new ProviderRegistry([provider]);

      expect(() => registry.getModel("test-provider", "test-model")).toThrow(
        /API key not configured/,
      );
    });

    // ---------------------------------------------------------------------
    // 3. resolveApiKey returns null for local provider (no key needed)
    // ---------------------------------------------------------------------
    it("returns 'local' for local provider even without env var", () => {
      // Ensure LOCAL_API_KEY is NOT set.
      delete process.env.LOCAL_API_KEY;

      const localProvider = makeProvider({
        id: "local",
        apiKeyEnvVar: "LOCAL_API_KEY",
        pool: "local",
      });
      const registry = new ProviderRegistry([localProvider]);

      const resolved = registry.getModel("local", "test-model");
      expect(resolved.apiKey).toBe("local");
    });
  });

  // -----------------------------------------------------------------------
  // 4. resolveCandidates skips providers with null API key
  // -----------------------------------------------------------------------
  describe("resolveCandidates", () => {
    it("skips providers whose API key resolves to null", () => {
      // Provider A has no key set -> should be skipped.
      const providerA = makeProvider({
        id: "no-key-provider",
        apiKeyEnvVar: "MISSING_KEY_VAR",
        priority: 0,
        models: [
          {
            id: "model-a",
            tier: "fast",
            contextWindow: 8192,
            maxOutputTokens: 4096,
            costPerInputToken: 1,
            costPerOutputToken: 2,
            supportsTools: true,
            supportsVision: false,
            supportsStreaming: true,
          },
        ],
      });

      // Provider B has a key set -> should be included.
      process.env.TEST_API_KEY = "sk-good-key";
      const providerB = makeProvider({
        id: "has-key-provider",
        apiKeyEnvVar: "TEST_API_KEY",
        priority: 1,
        models: [
          {
            id: "model-b",
            tier: "fast",
            contextWindow: 8192,
            maxOutputTokens: 4096,
            costPerInputToken: 1,
            costPerOutputToken: 2,
            supportsTools: true,
            supportsVision: false,
            supportsStreaming: true,
          },
        ],
      });

      const registry = new ProviderRegistry(
        [providerA, providerB],
        {
          reasoning: { preferredProvider: "no-key-provider", fallbackOrder: ["has-key-provider"] },
          fast: { preferredProvider: "no-key-provider", fallbackOrder: ["has-key-provider"] },
          cheap: { preferredProvider: "no-key-provider", fallbackOrder: ["has-key-provider"] },
        },
      );

      const candidates = registry.resolveCandidates("fast");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].provider.id).toBe("has-key-provider");
      expect(candidates[0].apiKey).toBe("sk-good-key");
    });
  });

  // -----------------------------------------------------------------------
  // 5. getModel throws descriptive error for missing API key
  // -----------------------------------------------------------------------
  describe("getModel", () => {
    it("throws descriptive error for missing API key", () => {
      const provider = makeProvider({
        id: "anthropic",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
      });
      const registry = new ProviderRegistry([provider]);

      expect(() => registry.getModel("anthropic", "test-model")).toThrow(
        "API key not configured for provider 'anthropic' (env: ANTHROPIC_API_KEY)",
      );
    });

    it("throws for unknown provider", () => {
      const registry = new ProviderRegistry([makeProvider()]);
      expect(() => registry.getModel("nonexistent", "any-model")).toThrow(
        /Unknown provider 'nonexistent'/,
      );
    });

    it("throws for unknown model on valid provider", () => {
      process.env.TEST_API_KEY = "sk-key";
      const registry = new ProviderRegistry([makeProvider()]);
      expect(() => registry.getModel("test-provider", "nonexistent-model")).toThrow(
        /Unknown model 'nonexistent-model'/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 6. Config parse failure logs warning instead of silently swallowing
  // -----------------------------------------------------------------------
  describe("fromConfig", () => {
    it("logs warning on config parse failure instead of silently swallowing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Write invalid JSON to a temp path.
      const tmpPath = "provider-registry-test-invalid.json";
      fs.writeFileSync(tmpPath, "{ not valid json !!!", "utf-8");

      try {
        const registry = ProviderRegistry.fromConfig(tmpPath);

        // Should still return a functional registry with defaults.
        expect(registry).toBeInstanceOf(ProviderRegistry);

        // Should have logged a warning.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain("[ProviderRegistry] Failed to load config:");
      } finally {
        warnSpy.mockRestore();
        fs.unlinkSync(tmpPath);
      }
    });

    it("returns default registry when config file does not exist", () => {
      const registry = ProviderRegistry.fromConfig("/nonexistent/path/config.json");
      expect(registry).toBeInstanceOf(ProviderRegistry);
    });
  });
});
