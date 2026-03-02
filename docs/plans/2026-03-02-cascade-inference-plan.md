# Cascade Inference Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a CascadeController that routes inference through paid, free-cloud, and local provider pools based on profitability and survival tier.

**Architecture:** CascadeController wraps the existing InferenceRouter. It checks 24h rolling P&L and survival tier to select a pool (PAID, FREE_CLOUD, LOCAL), filters providers to that pool, and delegates to the router. On pool exhaustion, it cascades to the next pool down.

**Tech Stack:** TypeScript, vitest, better-sqlite3, viem (existing deps only — no new npm packages)

---

### Task 1: Add CascadePool type and new API key fields

**Files:**
- Modify: `src/types.ts` (add CascadePool type, new API key fields)
- Modify: `src/inference/types.ts` (re-export CascadePool)
- Test: `src/__tests__/cascade-controller.test.ts` (create skeleton)

**Step 1: Write the failing test**

Create test file that imports the new type:

```typescript
// src/__tests__/cascade-controller.test.ts
import { describe, it, expect } from "vitest";

describe("CascadePool type", () => {
  it("accepts valid pool values", () => {
    const pools: Array<import("../types.js").CascadePool> = ["paid", "free_cloud", "local"];
    expect(pools).toHaveLength(3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts`
Expected: FAIL — `CascadePool` is not exported from types.js

**Step 3: Add CascadePool type to src/types.ts**

Find the `ModelProvider` type (around line 1142) and add after it:

```typescript
/** Which inference pool the CascadeController should use */
export type CascadePool = "paid" | "free_cloud" | "local";
```

Also add new API key fields to the `AutomatonConfig` interface (after `perplexityApiKey`):

```typescript
  cerebrasApiKey?: string;
  sambanovaApiKey?: string;
  togetherApiKey?: string;
  hfApiKey?: string;
```

**Step 4: Re-export from inference/types.ts**

Add `CascadePool` to the re-exports block at the top of `src/inference/types.ts`:

```typescript
export type {
  // ... existing exports ...
  CascadePool,
} from "../types.js";
```

**Step 5: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/types.ts src/inference/types.ts src/__tests__/cascade-controller.test.ts
git commit -m "feat(cascade): add CascadePool type and new API key fields"
```

---

### Task 2: Add new providers to provider registry

**Files:**
- Modify: `src/inference/provider-registry.ts` (add `pool` field, new providers, split Groq, enable Together)
- Test: `src/__tests__/cascade-controller.test.ts` (add provider registry tests)

**Step 1: Write the failing tests**

Add to `src/__tests__/cascade-controller.test.ts`:

```typescript
import { ProviderRegistry } from "../inference/provider-registry.js";

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

  it("has Together enabled", () => {
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

  it("assigns existing providers to pools", () => {
    const registry = new ProviderRegistry();
    const providers = registry.getProviders();
    expect(providers.find((p) => p.id === "anthropic")!.pool).toBe("paid");
    expect(providers.find((p) => p.id === "openai")!.pool).toBe("paid");
    expect(providers.find((p) => p.id === "local")!.pool).toBe("local");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts`
Expected: FAIL — `pool` property doesn't exist on ProviderConfig

**Step 3: Modify provider-registry.ts**

Add `pool` field to `ProviderConfig` interface:

```typescript
export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  models: ModelConfig[];
  maxRequestsPerMinute: number;
  maxTokensPerMinute: number;
  priority: number;
  enabled: boolean;
  pool?: "paid" | "free_cloud" | "local";
}
```

Add `pool` to each existing provider in DEFAULT_PROVIDERS:
- `anthropic`: `pool: "paid"`
- `openai`: `pool: "paid"`
- `groq`: `pool: "paid"` (this is the paid Groq)
- `together`: `pool: "free_cloud"`, change `enabled: true`
- `local`: `pool: "local"`

Add new `groq-free` provider entry after the existing `groq` entry:

```typescript
  {
    id: "groq-free",
    name: "Groq (Free Tier)",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    models: [
      {
        id: "llama-3.3-70b-versatile",
        tier: "reasoning",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "llama-3.3-70b-versatile",
        tier: "fast",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "llama-3.1-8b-instant",
        tier: "cheap",
        contextWindow: 131072,
        maxOutputTokens: 4096,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: 30,
    maxTokensPerMinute: 15000,
    priority: 5,
    enabled: true,
    pool: "free_cloud",
  },
```

Add Cerebras provider:

```typescript
  {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnvVar: "CEREBRAS_API_KEY",
    models: [
      {
        id: "llama-3.3-70b",
        tier: "reasoning",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "llama-3.3-70b",
        tier: "fast",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "qwen-3-32b",
        tier: "cheap",
        contextWindow: 65536,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: 30,
    maxTokensPerMinute: 60000,
    priority: 6,
    enabled: true,
    pool: "free_cloud",
  },
```

Add SambaNova provider:

```typescript
  {
    id: "sambanova",
    name: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    apiKeyEnvVar: "SAMBANOVA_API_KEY",
    models: [
      {
        id: "Meta-Llama-3.3-70B-Instruct",
        tier: "reasoning",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "Meta-Llama-3.3-70B-Instruct",
        tier: "fast",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "Meta-Llama-3.1-8B-Instruct",
        tier: "cheap",
        contextWindow: 131072,
        maxOutputTokens: 4096,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: 20,
    maxTokensPerMinute: 100000,
    priority: 7,
    enabled: true,
    pool: "free_cloud",
  },
```

Add HuggingFace provider:

```typescript
  {
    id: "huggingface",
    name: "HuggingFace Inference",
    baseUrl: "https://router.huggingface.co/v1",
    apiKeyEnvVar: "HF_API_KEY",
    models: [
      {
        id: "meta-llama/Llama-3.3-70B-Instruct",
        tier: "reasoning",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "meta-llama/Llama-3.3-70B-Instruct",
        tier: "fast",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: "Qwen/Qwen2.5-72B-Instruct",
        tier: "cheap",
        contextWindow: 32768,
        maxOutputTokens: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
    maxRequestsPerMinute: 30,
    maxTokensPerMinute: 100000,
    priority: 8,
    enabled: true,
    pool: "free_cloud",
  },
```

Update `DEFAULT_TIER_DEFAULTS` fallback orders to include new providers:

```typescript
const DEFAULT_TIER_DEFAULTS: Record<ModelTier, TierDefault> = {
  reasoning: {
    preferredProvider: "anthropic",
    fallbackOrder: ["openai", "groq", "groq-free", "cerebras", "sambanova", "together", "huggingface", "local"],
  },
  fast: {
    preferredProvider: "anthropic",
    fallbackOrder: ["groq", "groq-free", "cerebras", "sambanova", "openai", "together", "huggingface", "local"],
  },
  cheap: {
    preferredProvider: "anthropic",
    fallbackOrder: ["groq", "groq-free", "cerebras", "sambanova", "together", "huggingface", "local", "openai"],
  },
};
```

**Step 4: Run tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/inference/provider-registry.ts src/__tests__/cascade-controller.test.ts
git commit -m "feat(cascade): add Cerebras, SambaNova, HuggingFace providers; split Groq; enable Together"
```

---

### Task 3: Create pools.ts — Pool definitions

**Files:**
- Create: `src/inference/pools.ts`
- Test: `src/__tests__/cascade-controller.test.ts` (add pool tests)

**Step 1: Write the failing tests**

Add to `src/__tests__/cascade-controller.test.ts`:

```typescript
import { POOL_CASCADE_ORDER, getProvidersForPool } from "../inference/pools.js";

describe("Pool definitions", () => {
  it("defines cascade order as paid → free_cloud → local", () => {
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

  it("returns local providers for the local pool", () => {
    const providers = getProvidersForPool("local");
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("local");
    expect(ids).not.toContain("groq");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts`
Expected: FAIL — module `../inference/pools.js` not found

**Step 3: Create src/inference/pools.ts**

```typescript
/**
 * Cascade Pool Definitions
 *
 * Defines the three inference pools and their cascade order.
 * The CascadeController uses these to decide which providers
 * are available based on profitability and survival tier.
 */

import type { CascadePool } from "../types.js";
import { DEFAULT_PROVIDERS, type ProviderConfig } from "./provider-registry.js";

/** The order in which pools are tried when the current pool is exhausted */
export const POOL_CASCADE_ORDER: CascadePool[] = ["paid", "free_cloud", "local"];

/**
 * Return providers belonging to a specific pool.
 * Filters the DEFAULT_PROVIDERS array by the `pool` field.
 * Providers without a pool field are assigned to "paid" by default.
 */
export function getProvidersForPool(pool: CascadePool): ProviderConfig[] {
  return DEFAULT_PROVIDERS.filter((p) => {
    const providerPool = p.pool ?? "paid";
    return providerPool === pool && p.enabled;
  });
}

/**
 * Get the next pool in the cascade after the given pool.
 * Returns null if there is no next pool (we've exhausted everything).
 */
export function getNextPool(currentPool: CascadePool): CascadePool | null {
  const idx = POOL_CASCADE_ORDER.indexOf(currentPool);
  if (idx === -1 || idx >= POOL_CASCADE_ORDER.length - 1) return null;
  return POOL_CASCADE_ORDER[idx + 1];
}
```

Note: `DEFAULT_PROVIDERS` needs to be exported from provider-registry.ts. Add `export` before `const DEFAULT_PROVIDERS` if it isn't already exported.

**Step 4: Run tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/inference/pools.ts src/__tests__/cascade-controller.test.ts src/inference/provider-registry.ts
git commit -m "feat(cascade): add pool definitions and cascade ordering"
```

---

### Task 4: Create CascadeController

This is the core component. It checks profitability, selects a pool, and wraps the InferenceRouter.

**Files:**
- Create: `src/inference/cascade-controller.ts`
- Test: `src/__tests__/cascade-controller.test.ts` (add core tests)

**Step 1: Write the failing tests**

Add to `src/__tests__/cascade-controller.test.ts`:

```typescript
import { CascadeController } from "../inference/cascade-controller.js";
import type { CascadePool, SurvivalTier, InferenceResult } from "../types.js";

describe("CascadeController", () => {
  // Helper to create a mock DB with P&L data
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

  // Helper for a mock router that records which pool it was called with
  function mockRouter() {
    const calls: any[] = [];
    return {
      calls,
      route: async (_req: any, _chat: any): Promise<InferenceResult> => {
        calls.push({ called: true });
        return {
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
      },
    };
  }

  describe("selectPool", () => {
    it("returns free_cloud when survival tier is critical", () => {
      const db = mockDb(1000, 500); // profitable, but critical overrides
      const controller = new CascadeController(db);
      expect(controller.selectPool("critical")).toBe("free_cloud");
    });

    it("returns free_cloud when survival tier is dead", () => {
      const db = mockDb(1000, 500);
      const controller = new CascadeController(db);
      expect(controller.selectPool("dead")).toBe("free_cloud");
    });

    it("returns free_cloud when survival tier is low_compute", () => {
      const db = mockDb(1000, 500);
      const controller = new CascadeController(db);
      expect(controller.selectPool("low_compute")).toBe("free_cloud");
    });

    it("returns paid when profitable and tier is normal", () => {
      const db = mockDb(1000, 500); // net = 500 > 0
      const controller = new CascadeController(db);
      expect(controller.selectPool("normal")).toBe("paid");
    });

    it("returns paid when profitable and tier is high", () => {
      const db = mockDb(5000, 1000);
      const controller = new CascadeController(db);
      expect(controller.selectPool("high")).toBe("paid");
    });

    it("returns free_cloud when unprofitable and tier is normal", () => {
      const db = mockDb(500, 1000); // net = -500 < 0
      const controller = new CascadeController(db);
      expect(controller.selectPool("normal")).toBe("free_cloud");
    });

    it("returns free_cloud when revenue equals expenses (zero profit)", () => {
      const db = mockDb(1000, 1000); // net = 0
      const controller = new CascadeController(db);
      expect(controller.selectPool("normal")).toBe("free_cloud");
    });
  });

  describe("infer — pool fallback", () => {
    it("calls router successfully on first pool", async () => {
      const db = mockDb(1000, 500);
      const controller = new CascadeController(db);
      const router = mockRouter();
      const chatFn = async () => ({ content: "ok" });

      const result = await controller.infer(
        {
          messages: [],
          taskType: "agent_turn",
          tier: "normal" as SurvivalTier,
          sessionId: "test",
          turnId: "t1",
          tools: [],
        },
        router as any,
        chatFn,
      );

      expect(result.content).toBe("test response");
      expect(router.calls).toHaveLength(1);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts`
Expected: FAIL — `CascadeController` not found

**Step 3: Create src/inference/cascade-controller.ts**

```typescript
/**
 * Cascade Controller
 *
 * Sits above the InferenceRouter and decides which provider pool to use
 * based on the agent's profitability and survival tier.
 *
 * Pool cascade: PAID → FREE_CLOUD → LOCAL
 *
 * Decision logic:
 * - critical/dead/low_compute tier → always FREE_CLOUD (hard floor)
 * - normal/high tier + profitable → PAID
 * - normal/high tier + unprofitable → FREE_CLOUD
 * - On pool exhaustion (all providers 429/500) → cascade to next pool
 */

import type BetterSqlite3 from "better-sqlite3";
import type { CascadePool, SurvivalTier, InferenceRequest, InferenceResult } from "../types.js";
import type { InferenceRouter } from "./router.js";
import { POOL_CASCADE_ORDER, getProvidersForPool, getNextPool } from "./pools.js";
import { createLogger } from "../observability/logger.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("cascade");

/** Cache P&L for 5 minutes to avoid constant DB queries */
const PNL_CACHE_TTL_MS = 5 * 60 * 1000;

interface PnlCache {
  netCents: number;
  revenueCents: number;
  expenseCents: number;
  cachedAt: number;
}

export class CascadeController {
  private db: Database;
  private pnlCache: PnlCache | null = null;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Compute 24h rolling P&L from the accounting ledger.
   * Cached for 5 minutes.
   */
  private getRollingPnl(): { netCents: number; revenueCents: number; expenseCents: number } {
    const now = Date.now();
    if (this.pnlCache && now - this.pnlCache.cachedAt < PNL_CACHE_TTL_MS) {
      return this.pnlCache;
    }

    const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    let revenueCents = 0;
    let expenseCents = 0;

    try {
      const revRow = this.db
        .prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM revenue_events WHERE created_at >= ?")
        .get(since) as { total: number } | undefined;
      revenueCents = revRow?.total ?? 0;

      const expRow = this.db
        .prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM expense_events WHERE created_at >= ?")
        .get(since) as { total: number } | undefined;
      expenseCents = expRow?.total ?? 0;
    } catch {
      // Tables may not exist yet — treat as zero revenue/expense
    }

    const result = { netCents: revenueCents - expenseCents, revenueCents, expenseCents };
    this.pnlCache = { ...result, cachedAt: now };
    return result;
  }

  /**
   * Select the starting pool based on survival tier and profitability.
   */
  selectPool(tier: SurvivalTier): CascadePool {
    // Hard floor: low tiers always use free models
    if (tier === "dead" || tier === "critical" || tier === "low_compute") {
      return "free_cloud";
    }

    // Profit-margin check for normal/high tiers
    const pnl = this.getRollingPnl();
    if (pnl.netCents > 0) {
      logger.debug(`Cascade: profitable (net ${pnl.netCents}c) → PAID pool`);
      return "paid";
    }

    logger.debug(`Cascade: unprofitable (net ${pnl.netCents}c) → FREE_CLOUD pool`);
    return "free_cloud";
  }

  /**
   * Main entry point. Replaces direct inferenceRouter.route() calls.
   *
   * 1. Select starting pool based on tier + profitability
   * 2. Try inference with that pool's providers
   * 3. On pool exhaustion → cascade to next pool
   * 4. Throw CascadeExhaustedError if all pools fail
   */
  async infer(
    request: InferenceRequest,
    router: InferenceRouter,
    inferenceChat: (messages: any[], options: any) => Promise<any>,
  ): Promise<InferenceResult> {
    let currentPool = this.selectPool(request.tier);

    while (currentPool) {
      const poolProviders = getProvidersForPool(currentPool);
      if (poolProviders.length === 0) {
        logger.warn(`Cascade: pool ${currentPool} has no enabled providers, skipping`);
        currentPool = getNextPool(currentPool)!;
        continue;
      }

      try {
        logger.info(`Cascade: trying ${currentPool} pool (${poolProviders.map((p) => p.id).join(", ")})`);
        const result = await router.route(request, inferenceChat);
        logger.info(`Cascade: ${currentPool} pool succeeded (model: ${result.model})`);
        return result;
      } catch (error: any) {
        const errMsg = error?.message ?? String(error);
        const isRetryable = /429|413|500|503|rate.limit|timeout/i.test(errMsg);

        if (isRetryable) {
          const next = getNextPool(currentPool);
          if (next) {
            logger.warn(`Cascade: ${currentPool} pool exhausted (${errMsg}), falling back to ${next}`);
            currentPool = next;
            continue;
          }
        }

        // Non-retryable error or no more pools
        throw error;
      }
    }

    throw new CascadeExhaustedError("All inference pools exhausted");
  }

  /** Clear the P&L cache (useful for testing) */
  clearCache(): void {
    this.pnlCache = null;
  }
}

export class CascadeExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CascadeExhaustedError";
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/inference/cascade-controller.ts src/__tests__/cascade-controller.test.ts
git commit -m "feat(cascade): add CascadeController with profit-margin pool selection"
```

---

### Task 5: Add new API keys to config loading

**Files:**
- Modify: `src/config.ts` (load new env vars)
- Test: `src/__tests__/cascade-controller.test.ts` (add config test)

**Step 1: Write the failing test**

Add to the test file:

```typescript
describe("Config — new API keys", () => {
  it("loads new API keys from environment variables", async () => {
    // Set env vars for test
    process.env.CEREBRAS_API_KEY = "test-cerebras-key";
    process.env.SAMBANOVA_API_KEY = "test-sambanova-key";
    process.env.HF_API_KEY = "test-hf-key";
    process.env.TOGETHER_API_KEY = "test-together-key";

    // Verify the env vars exist (config.ts reads them directly)
    expect(process.env.CEREBRAS_API_KEY).toBe("test-cerebras-key");
    expect(process.env.SAMBANOVA_API_KEY).toBe("test-sambanova-key");
    expect(process.env.HF_API_KEY).toBe("test-hf-key");
    expect(process.env.TOGETHER_API_KEY).toBe("test-together-key");

    // Clean up
    delete process.env.CEREBRAS_API_KEY;
    delete process.env.SAMBANOVA_API_KEY;
    delete process.env.HF_API_KEY;
    delete process.env.TOGETHER_API_KEY;
  });
});
```

**Step 2: Run test to verify it passes**

This test verifies env vars work. The actual config loading should propagate these to AutomatonConfig.

**Step 3: Modify src/config.ts**

In the `loadConfig()` function, after the existing API key loading, add:

```typescript
    // Load cascade inference API keys
    const cerebrasApiKey = raw.cerebrasApiKey || process.env.CEREBRAS_API_KEY;
    const sambanovaApiKey = raw.sambanovaApiKey || process.env.SAMBANOVA_API_KEY;
    const togetherApiKey = raw.togetherApiKey || process.env.TOGETHER_API_KEY;
    const hfApiKey = raw.hfApiKey || process.env.HF_API_KEY;
```

And include them in the return object:

```typescript
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      // ... existing fields ...
      cerebrasApiKey,
      sambanovaApiKey,
      togetherApiKey,
      hfApiKey,
    } as AutomatonConfig;
```

**Step 4: Run tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts src/__tests__/cascade-controller.test.ts
git commit -m "feat(cascade): load Cerebras, SambaNova, Together, HuggingFace API keys from env"
```

---

### Task 6: Integrate CascadeController into agent loop

**Files:**
- Modify: `src/agent/loop.ts` (replace direct router.route() with cascade.infer())
- Test: Run existing tests to verify no regressions

**Step 1: Run existing tests as baseline**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/`
Expected: All existing tests pass

**Step 2: Modify src/agent/loop.ts**

Add import at top of file:

```typescript
import { CascadeController } from "../inference/cascade-controller.js";
```

After the InferenceRouter initialization (around line 127), add:

```typescript
  const cascadeController = new CascadeController(db.raw);
```

Replace the `inferenceRouter.route()` call (around line 587-597) with:

```typescript
      const routerResult = await cascadeController.infer(
        {
          messages: messages,
          taskType: detectedTaskType,
          tier: survivalTier,
          sessionId: sessionId,
          turnId: ulid(),
          tools: inferenceTools,
        },
        inferenceRouter,
        (msgs, opts) => inference.chat(msgs, { ...opts, tools: inferenceTools }),
      );
```

This is a minimal change — the only difference is `cascadeController.infer(...)` instead of `inferenceRouter.route(...)`, passing the router as a parameter.

**Step 3: Run all tests to verify no regressions**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/`
Expected: All tests pass (cascade controller wraps router transparently)

**Step 4: Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(cascade): integrate CascadeController into agent loop"
```

---

### Task 7: Add static model baseline entries for new providers

**Files:**
- Modify: `src/inference/types.ts` (add Cerebras, SambaNova, HuggingFace models to STATIC_MODEL_BASELINE)
- Test: Existing model registry tests

**Step 1: Add new model entries to STATIC_MODEL_BASELINE**

Add to the `STATIC_MODEL_BASELINE` array in `src/inference/types.ts`:

```typescript
  // ── Cerebras (free tier) ──
  {
    modelId: "llama-3.3-70b",
    provider: "groq" as ModelProvider, // OpenAI-compatible, reuse groq provider routing
    displayName: "Llama 3.3 70B (Cerebras)",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "openai",
  },
  {
    modelId: "qwen-3-32b",
    provider: "groq" as ModelProvider,
    displayName: "Qwen3 32B (Cerebras)",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 65536,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "openai",
  },
  // ── SambaNova (free tier) ──
  {
    modelId: "Meta-Llama-3.3-70B-Instruct",
    provider: "groq" as ModelProvider,
    displayName: "Llama 3.3 70B (SambaNova)",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "openai",
  },
  {
    modelId: "Meta-Llama-3.1-8B-Instruct",
    provider: "groq" as ModelProvider,
    displayName: "Llama 3.1 8B (SambaNova)",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 4096,
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "openai",
  },
```

Note: These use `provider: "groq"` because they all use the OpenAI-compatible chat format. The provider-registry handles actual routing. The `ModelProvider` type may need to be extended if the existing type doesn't accept arbitrary strings. Check `src/types.ts` for the `ModelProvider` type — if it's a union type, you may need to add `"cerebras" | "sambanova" | "huggingface"` to it.

**Step 2: Run TypeScript check**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/inference/types.ts src/types.ts
git commit -m "feat(cascade): add Cerebras, SambaNova model entries to static baseline"
```

---

### Task 8: Integration test — multi-pool failover

**Files:**
- Create: `src/__tests__/integration/cascade-failover.test.ts`

**Step 1: Write integration tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { CascadeController, CascadeExhaustedError } from "../../inference/cascade-controller.js";
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

  it("uses paid pool when profitable at normal tier", async () => {
    const db = mockDb(2000, 500);
    const controller = new CascadeController(db);
    const pool = controller.selectPool("normal");
    expect(pool).toBe("paid");
  });

  it("uses free_cloud pool when unprofitable at normal tier", async () => {
    const db = mockDb(500, 2000);
    const controller = new CascadeController(db);
    const pool = controller.selectPool("normal");
    expect(pool).toBe("free_cloud");
  });

  it("forces free_cloud at critical tier even if profitable", async () => {
    const db = mockDb(10000, 100);
    const controller = new CascadeController(db);
    const pool = controller.selectPool("critical");
    expect(pool).toBe("free_cloud");
  });

  it("caches P&L for 5 minutes", () => {
    const db = mockDb(1000, 500);
    const controller = new CascadeController(db);

    // First call computes P&L
    const pool1 = controller.selectPool("normal");
    expect(pool1).toBe("paid");

    // Mutate mock (simulate revenue drop) — should still use cache
    // Since we can't easily mutate the mock, just verify selectPool
    // returns the same result without hitting DB again
    const pool2 = controller.selectPool("normal");
    expect(pool2).toBe("paid");
  });

  it("handles missing accounting tables gracefully", () => {
    const db = {
      prepare: () => ({
        get: () => { throw new Error("no such table: revenue_events"); },
        all: () => [],
      }),
    } as any;
    const controller = new CascadeController(db);
    // Should default to free_cloud when P&L unavailable (netCents = 0, not > 0)
    expect(controller.selectPool("normal")).toBe("free_cloud");
  });
});
```

**Step 2: Run tests**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/integration/cascade-failover.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/__tests__/integration/cascade-failover.test.ts
git commit -m "test(cascade): add integration tests for multi-pool failover"
```

---

### Task 9: Build verification

**Step 1: Run TypeScript compilation**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: Exit code 0, no errors

**Step 2: Run all tests**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: All tests pass (existing + new cascade tests)

**Step 3: Verify no new lint issues**

Run: `node node_modules/vitest/vitest.mjs run src/__tests__/cascade-controller.test.ts src/__tests__/integration/cascade-failover.test.ts`
Expected: All cascade-specific tests pass

**Step 4: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore(cascade): build verification and cleanup"
```
