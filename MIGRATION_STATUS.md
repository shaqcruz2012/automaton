# Datchi Migration Status

Migration from Conway Cloud to fully sovereign local infrastructure.

## Phases

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Prepare the Fork | Done |
| 1 | Replace Inference (direct OpenAI/Anthropic/Ollama) | Done |
| 2 | Replace Sandbox (local Docker/host execution) | Done |
| 3 | Replace Auth & Identity (local wallet + provider keys) | Done |
| 4 | Replace Credits, Billing & Survival Tiers (on-chain USDC) | Done |
| 5b | Clean Up Remaining Conway References | Done |

## Key Architecture Changes

- **Identity**: Wallet-based (`~/.automaton/wallet.json`), no SIWE provisioning required
- **Inference**: Direct API keys for OpenAI, Anthropic, Ollama via `~/.automaton/keys.json`
- **Sandbox**: Local Docker/host execution, no Conway sandbox API
- **Treasury**: On-chain USDC on Base L2 (chain 8453), read via viem
- **Accounting**: SQLite ledger (`revenue_events`, `expense_events` tables)
- **Survival Tiers**: Derived from USDC balance + daily burn rate (runway days)
- **Social**: Relay disabled (no-op stub), ready for local/self-hosted relay
- **Registry**: ERC-8004 on Base L2 (unchanged, was never Conway-dependent)

## Conway Cloud Residuals

The `src/conway/` directory is retained for backward compatibility:
- `client.ts` — Conway API client (unused in normal operation)
- `http-client.ts` — Generic resilient HTTP client (reused for external APIs)
- `x402.ts` — x402 payment protocol (USDC signing, kept for future use)
- `topup.ts` — Stubbed out (returns no-op)
- `inference.ts` — Conway Compute wrapper (unused, agent uses direct keys)

No production code path calls `api.conway.tech` or `social.conway.tech`.
