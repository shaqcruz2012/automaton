# x402 Unified Gateway Design

## Problem

Datchi has standalone API services (text-analysis:9000, data-processing:9001, trustcheck:9002, payment-validator:6000) but no unified payment layer. Customers can't pay USDC for API calls, and Datchi can't spend USDC for its own compute. The existing code has x402 signing (`src/conway/x402.ts`), treasury balance reads (`src/local/treasury.ts`), and revenue skill stubs (`src/skills/revenue/`) but nothing wired together into a working payment gateway.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Engine-Native HTTP Gateway | Single TypeScript server in `src/gateway/`, reuses existing viem/x402 code |
| Payment direction | Both | Customers pay Datchi (receive side) AND Datchi pays for compute (spend side) |
| Verification | Real on-chain x402 EIP-712 | TransferWithAuthorization, not stubs |
| Verification timing | Off-chain first | Verify EIP-712 signature cryptographically, proxy immediately, execute USDC transfer on-chain async |
| Port | 7402 | Mnemonic for x402 |
| Nonce tracking | SQLite | Same DB as accounting ledger |

## Architecture

```
Customer                  Gateway (:7402)                    Backend Services
   |                          |                                    |
   |-- POST /summarize ------>|                                    |
   |<-- 402 + requirements ---|                                    |
   |                          |                                    |
   |-- POST /summarize ------>|                                    |
   |   X-Payment: <signed>    |                                    |
   |                          |-- 1. Decode X-Payment header       |
   |                          |-- 2. Verify EIP-712 sig (off-chain)|
   |                          |-- 3. Check nonce not replayed      |
   |                          |-- 4. Check amount >= tier price    |
   |                          |-- 5. Proxy to backend ------------>|
   |<-- 200 + result ---------|<-- result -------------------------|
   |                          |-- 6. Execute TransferWithAuth      |
   |                          |     on-chain (async, fire-and-forget)
   |                          |-- 7. Log revenue + expense         |
```

## Route Map

### Free endpoints (no payment required)

| Route | Handler | Description |
|-------|---------|-------------|
| `GET /health` | Gateway | Health check |
| `GET /info` | Gateway | Service info + wallet address |
| `GET /pricing` | Gateway | Returns all tier prices and payment requirements |

### Paid endpoints (x402 payment required)

| Route | Backend | Price (USD) | Max Input |
|-------|---------|-------------|-----------|
| `POST /summarize` | text-analysis:9000 | $0.25 | 4K tokens |
| `POST /brief` | text-analysis:9000 | $2.50 | 16K tokens |
| `POST /brief-premium` | text-analysis:9000 | $15.00 | 64K tokens |
| `POST /analyze` | text-analysis:9000 | $0.01 | 2K tokens |
| `POST /trustcheck` | trustcheck:9002 | $0.05 | 1K tokens |

### 402 Response Format

When a paid endpoint is hit without `X-Payment`:

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "maxAmountRequired": "250000",
    "payToAddress": "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706",
    "requiredDeadlineSeconds": 300,
    "usdcAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  }]
}
```

`maxAmountRequired` is in USDC atomic units (6 decimals). $0.25 = 250000 atomic.

## Payment Verification Flow

### Step 1: Decode X-Payment header

```
Base64 decode -> JSON -> { x402Version, scheme, network, payload: { signature, authorization } }
```

### Step 2: Off-chain EIP-712 signature verification

Use viem's `verifyTypedData()` to recover the signer address from the TransferWithAuthorization typed data. This is pure cryptography -- no gas, no RPC calls, instant.

Verify:
- Recovered signer matches `authorization.from`
- `authorization.to` matches Datchi's wallet
- `authorization.value` >= tier price in atomic units
- `authorization.validBefore` > now
- `authorization.validAfter` < now

### Step 3: Nonce check

Query SQLite `x402_nonces` table. If nonce exists, reject as replay. If not, insert with status `pending`.

### Step 4: Proxy to backend

Forward the request body to the appropriate backend service. Return the response to the customer immediately.

### Step 5: Async on-chain execution

Fire-and-forget: call USDC's `transferWithAuthorization()` on Base using the signed authorization. This executes the actual USDC transfer. Update nonce status to `executed` or `failed`.

### Step 6: Accounting

Log revenue (amount received) and expense (estimated inference cost) to the SQLite accounting ledger via existing `logRevenue()`/`logExpense()` functions.

## Nonce Tracking Schema

```sql
CREATE TABLE IF NOT EXISTS x402_nonces (
  nonce       TEXT PRIMARY KEY,
  from_addr   TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  tier        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | executed | failed
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT,
  tx_hash     TEXT,
  error       TEXT
);
```

## Spend Side

The existing `x402Fetch()` in `src/conway/x402.ts` handles Datchi paying for x402-gated services. It:
1. Makes an initial request
2. If 402, parses payment requirements
3. Signs EIP-712 TransferWithAuthorization
4. Retries with X-Payment header

This already works with Datchi's funded wallet (0.00073 ETH for gas, $8.51 USDC). The spend side needs:
- Verification that `x402Fetch()` works end-to-end against a real x402 endpoint
- Connection to the inference router so Datchi can pay for premium API calls
- Budget limits per-request via `maxPaymentCents` parameter (already supported)

## Pricing Configuration

Stored in `src/gateway/pricing.ts` as a typed config object:

```typescript
interface GatewayPricing {
  tiers: Record<string, {
    route: string;
    backend: string;
    priceUsd: number;
    priceAtomic: string; // USDC 6-decimal atomic units
    maxInputTokens: number;
    model: string;
  }>;
}
```

## Error Handling

| Scenario | Response |
|----------|----------|
| No X-Payment header | 402 + payment requirements |
| Invalid base64 / JSON | 400 Bad Request |
| Signature verification fails | 402 + "Invalid payment signature" |
| Amount too low | 402 + "Insufficient payment" |
| Nonce replayed | 402 + "Payment already used" |
| Authorization expired | 402 + "Payment authorization expired" |
| Backend service down | 503 Service Unavailable (no payment consumed) |
| On-chain execution fails | Log error, payment was already verified off-chain so customer got their response |

Key principle: If the backend is unreachable, return 503 **before** accepting the payment. The customer only pays if they get a result.

## File Structure

```
src/gateway/
  server.ts       -- HTTP server on :7402, route dispatch
  middleware.ts    -- x402 payment verification middleware
  pricing.ts      -- Tier definitions and pricing config
  routes.ts       -- Route handlers (free + paid endpoints)
  proxy.ts        -- HTTP proxy to backend services
  nonces.ts       -- SQLite nonce tracking
  on-chain.ts     -- Async TransferWithAuthorization execution
  types.ts        -- Gateway-specific types
```

## Testing Strategy

1. **Unit tests**: Signature verification with known test vectors, nonce tracking, pricing logic
2. **Integration test**: Full 402 flow with a mock backend (no real USDC)
3. **Smoke test**: Hit the real gateway with a small payment on Base mainnet ($0.01)

## Wallet

- Address: `0xad045ca2979269Bb7471DC9750BfFeaa24E8A706`
- Key location: `~/.automaton/wallet.json`
- Gas: 0.00073 ETH on Base (~$1.50, enough for ~1500 L2 transactions)
- USDC: $8.51 on Base

## Out of Scope

- Multi-chain support (Base only for now)
- Subscription/recurring payments
- Rate limiting per-customer
- Customer authentication beyond payment verification
- Frontend/dashboard for payment analytics
