# Cascade Inference Design

## Goal

Datchi uses Groq paid tier (funded by x402 gateway revenue) for quality inference, cascading to free cloud APIs when unprofitable, and local Ollama as last resort. Survival tier acts as a hard floor — critical/dead always use free models.

## Architecture

```
Agent Loop
    │
    ▼
CascadeController
    │  Decides pool based on: profit margin + survival tier
    │
    ├─── PAID pool ──────── Groq paid, Anthropic, OpenAI
    │    (when profitable)
    │
    ├─── FREE_CLOUD pool ── Groq free, Cerebras, SambaNova, Together, HuggingFace
    │    (when unprofitable or low_compute tier)
    │
    └─── LOCAL pool ──────── Ollama (qwen2.5:7b, llama3.1:8b)
         (when all cloud fails)
```

The CascadeController wraps the existing InferenceRouter. Within each pool, the router handles model-level failover on retryable errors (429, 413, 500, 503).

## Cascade Decision Logic

```
selectPool(survivalTier, db):
  if tier in [dead, critical] → FREE_CLOUD
  if tier == low_compute      → FREE_CLOUD
  if rollingPnl(24h).net > 0  → PAID
  else                         → FREE_CLOUD
```

Pool fallback on exhaustion: PAID → FREE_CLOUD → LOCAL → throw.

24-hour rolling P&L window. Cached 5 minutes.

## New Providers (Free Cloud Pool)

| Provider | Base URL | Free Limits | Models |
|----------|----------|-------------|--------|
| Cerebras | api.cerebras.ai/v1 | 30 RPM, 1M tokens/day | Llama 3.3 70B, Qwen3 32B |
| SambaNova | api.sambanova.ai/v1 | 10-30 RPM, persistent | Llama 3.3 70B, Llama 3.1 405B |
| Together | api.together.xyz/v1 | Already registered | Llama 3.3 70B, Llama 3.1 8B |
| HuggingFace | router.huggingface.co/v1 | Rate-limited free | Multi-provider routing |

All use OpenAI-compatible chat completions API.

Groq splits into `groq` (paid pool) and `groq-free` (free_cloud pool) — same API key, tracked separately.

## API Keys

New env vars: `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `TOGETHER_API_KEY`, `HF_API_KEY`.

Added to `AutomatonConfig` in `src/types.ts` and loaded in `src/config.ts`.

## File Changes

**New files:**
- `src/inference/cascade-controller.ts` — CascadeController class
- `src/inference/pools.ts` — Pool definitions and provider groupings

**Modified files:**
- `src/inference/provider-registry.ts` — Add Cerebras, SambaNova, HuggingFace; add `pool` field; enable Together; split Groq
- `src/inference/types.ts` — Add CascadePool type, new model entries
- `src/types.ts` — New API key fields
- `src/config.ts` — Load new env vars
- `src/agent/loop.ts` — Replace `inferenceRouter.route()` with `cascadeController.infer()`
- `src/conway/inference.ts` — Route new providers (OpenAI-compatible, minimal changes)

**Test files:**
- `src/__tests__/cascade-controller.test.ts` — Pool selection, profit-margin gating, fallback
- `src/__tests__/integration/cascade-failover.test.ts` — Multi-pool failover

**Unchanged:**
- `src/inference/router.ts` — CascadeController wraps it, no changes
- `src/inference/budget.ts` — Per-call budget tracking unchanged
- `src/local/accounting.ts` — Already has P&L functions
- `src/gateway/` — x402 gateway earns USDC independently

## Profit-Margin Integration

Revenue source: x402 gateway logs to `revenue_events` table via `logRevenue()`.
Expense source: Inference costs logged to `expense_events` via `logExpense()`.
P&L query: `computePnl(db, '24h')` returns `{ revenueCents, expenseCents, netCents }`.

The CascadeController calls this on each inference request (with 5-minute cache) to determine if the agent is currently profitable.

## Error Handling

- Pool exhaustion: If all candidates in a pool return retryable errors, cascade to next pool
- Non-retryable errors (401 invalid key, 403 forbidden): Skip that provider, try next in pool
- All pools exhausted: Throw `CascadeExhaustedError` — agent enters sleep/retry state
- Rate limit tracking: Each free provider's rate limits tracked independently via existing circuit breaker

## Testing Strategy

1. Unit tests: Mock accounting P&L, verify pool selection at each survival tier
2. Unit tests: Mock router failures, verify pool fallback chain
3. Integration tests: Mock HTTP responses from each provider, verify end-to-end cascade
4. No live API tests (free tier rate limits are precious)
