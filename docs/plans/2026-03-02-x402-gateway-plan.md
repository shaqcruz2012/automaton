# x402 Unified Gateway Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a unified HTTP gateway on port 7402 that accepts x402 USDC payments on Base for Datchi's API endpoints, verifies EIP-712 signatures off-chain, proxies to backend services, and executes USDC transfers on-chain asynchronously.

**Architecture:** Native Node.js HTTP server (no Express — matches codebase pattern in `src/registry/agent-card.ts`). Payment middleware decodes the `X-Payment` header, verifies the EIP-712 `TransferWithAuthorization` signature using viem's `verifyTypedData`, checks nonces in SQLite, proxies the request to the appropriate backend, then fires off the on-chain `transferWithAuthorization` call asynchronously. All revenue and expenses are logged via the existing accounting module.

**Tech Stack:** TypeScript (ES2022/NodeNext), viem ^2.44.2, better-sqlite3 ^11.0.0, ulid ^2.3.0, Vitest ^2.0.0

**Design doc:** `docs/plans/2026-03-02-x402-gateway-design.md`

---

## Task 1: Gateway Types

**Files:**
- Create: `src/gateway/types.ts`
- Test: `src/__tests__/gateway/types.test.ts`

**Step 1: Write the types file**

```typescript
// src/gateway/types.ts
/**
 * x402 Gateway Types
 */
import type { Address } from "viem";

/** A single pricing tier for a paid endpoint */
export interface GatewayTier {
  route: string;
  backend: string;         // e.g., "http://127.0.0.1:9000"
  priceUsd: number;        // e.g., 0.25
  priceAtomic: string;     // USDC 6-decimal string, e.g., "250000"
  maxInputTokens: number;
  model: string;
  description: string;
}

/** Full pricing configuration */
export interface GatewayPricing {
  walletAddress: Address;
  network: string;           // "eip155:8453"
  usdcAddress: Address;
  deadlineSeconds: number;   // default 300
  tiers: Record<string, GatewayTier>;
}

/** Decoded X-Payment header payload */
export interface X402Payment {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: `0x${string}`;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

/** Result of off-chain signature verification */
export interface VerifyResult {
  valid: boolean;
  error?: string;
  signerAddress?: Address;
  amountAtomic?: bigint;
}

/** Result of async on-chain execution */
export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

/** Nonce record stored in SQLite */
export interface NonceRecord {
  nonce: string;
  fromAddr: string;
  amountAtomic: string;
  tier: string;
  status: "pending" | "executed" | "failed";
  createdAt: string;
  executedAt?: string;
  txHash?: string;
  error?: string;
}

/** 402 payment requirement sent to clients */
export interface PaymentRequirement {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payToAddress: Address;
    requiredDeadlineSeconds: number;
    usdcAddress: Address;
  }>;
}
```

**Step 2: Write a compile-check test**

```typescript
// src/__tests__/gateway/types.test.ts
import { describe, it, expect } from "vitest";
import type {
  GatewayTier,
  GatewayPricing,
  X402Payment,
  VerifyResult,
  NonceRecord,
  PaymentRequirement,
} from "../../gateway/types.js";

describe("gateway types", () => {
  it("GatewayTier is structurally valid", () => {
    const tier: GatewayTier = {
      route: "/summarize",
      backend: "http://127.0.0.1:9000",
      priceUsd: 0.25,
      priceAtomic: "250000",
      maxInputTokens: 4000,
      model: "claude-haiku-4-5-20251001",
      description: "Basic summarization",
    };
    expect(tier.priceUsd).toBe(0.25);
  });

  it("PaymentRequirement matches x402 spec shape", () => {
    const req: PaymentRequirement = {
      x402Version: 1,
      accepts: [{
        scheme: "exact",
        network: "eip155:8453",
        maxAmountRequired: "250000",
        payToAddress: "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706",
        requiredDeadlineSeconds: 300,
        usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      }],
    };
    expect(req.accepts).toHaveLength(1);
    expect(req.accepts[0].scheme).toBe("exact");
  });
});
```

**Step 3: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gateway/types.test.ts`
Expected: PASS (type-only imports + structural checks)

**Step 4: Commit**

```bash
git add src/gateway/types.ts src/__tests__/gateway/types.test.ts
git commit -m "feat(gateway): add x402 gateway type definitions"
```

---

## Task 2: Pricing Configuration

**Files:**
- Create: `src/gateway/pricing.ts`
- Test: `src/__tests__/gateway/pricing.test.ts`

**Step 1: Write the failing test**

```typescript
// src/__tests__/gateway/pricing.test.ts
import { describe, it, expect } from "vitest";
import { getGatewayPricing, usdToAtomic, buildPaymentRequirement } from "../../gateway/pricing.js";

describe("gateway pricing", () => {
  it("returns pricing config with all tiers", () => {
    const pricing = getGatewayPricing();
    expect(pricing.tiers["summarize-basic"]).toBeDefined();
    expect(pricing.tiers["brief-standard"]).toBeDefined();
    expect(pricing.tiers["brief-premium"]).toBeDefined();
    expect(pricing.tiers["analyze"]).toBeDefined();
    expect(pricing.tiers["trustcheck"]).toBeDefined();
  });

  it("has correct wallet address", () => {
    const pricing = getGatewayPricing();
    expect(pricing.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("converts USD to USDC atomic units correctly", () => {
    expect(usdToAtomic(0.25)).toBe("250000");
    expect(usdToAtomic(2.5)).toBe("2500000");
    expect(usdToAtomic(15.0)).toBe("15000000");
    expect(usdToAtomic(0.01)).toBe("10000");
    expect(usdToAtomic(0.05)).toBe("50000");
  });

  it("builds a valid 402 payment requirement", () => {
    const pricing = getGatewayPricing();
    const req = buildPaymentRequirement(pricing, "summarize-basic");
    expect(req.x402Version).toBe(1);
    expect(req.accepts).toHaveLength(1);
    expect(req.accepts[0].maxAmountRequired).toBe("250000");
    expect(req.accepts[0].payToAddress).toBe(pricing.walletAddress);
    expect(req.accepts[0].scheme).toBe("exact");
  });

  it("throws for unknown tier", () => {
    const pricing = getGatewayPricing();
    expect(() => buildPaymentRequirement(pricing, "nonexistent")).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gateway/pricing.test.ts`
Expected: FAIL (module not found)

**Step 3: Write implementation**

```typescript
// src/gateway/pricing.ts
/**
 * Gateway Pricing Configuration
 *
 * Defines endpoint pricing and builds x402 payment requirement objects.
 * Wallet address is loaded from ~/.automaton/wallet.json at startup.
 */
import fs from "fs";
import path from "path";
import os from "os";
import type { Address } from "viem";
import type { GatewayPricing, GatewayTier, PaymentRequirement } from "./types.js";

const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK = "eip155:8453";
const DEFAULT_DEADLINE_SECONDS = 300;

/** Convert USD amount to USDC atomic units (6 decimals) string */
export function usdToAtomic(usd: number): string {
  return String(Math.round(usd * 1_000_000));
}

/** Load wallet address from ~/.automaton/wallet.json */
function loadWalletAddress(): Address {
  try {
    const walletPath = path.join(os.homedir(), ".automaton", "wallet.json");
    const raw = fs.readFileSync(walletPath, "utf-8");
    const wallet = JSON.parse(raw);
    if (wallet.privateKey) {
      // Derive address from private key using viem would be ideal,
      // but for now we use the known address. In production, derive it.
      // The address is deterministic from the private key.
    }
  } catch {
    // Fall through to env var or hardcoded
  }

  // Fallback: env var or known address
  return (process.env.GATEWAY_WALLET_ADDRESS ||
    "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706") as Address;
}

const DEFAULT_TIERS: Record<string, GatewayTier> = {
  "summarize-basic": {
    route: "/summarize",
    backend: "http://127.0.0.1:9000",
    priceUsd: 0.25,
    priceAtomic: usdToAtomic(0.25),
    maxInputTokens: 4000,
    model: "claude-haiku-4-5-20251001",
    description: "High-volume summarization",
  },
  "brief-standard": {
    route: "/brief",
    backend: "http://127.0.0.1:9000",
    priceUsd: 2.50,
    priceAtomic: usdToAtomic(2.50),
    maxInputTokens: 16000,
    model: "claude-haiku-4-5-20251001",
    description: "Structured brief with findings and recommendations",
  },
  "brief-premium": {
    route: "/brief-premium",
    backend: "http://127.0.0.1:9000",
    priceUsd: 15.00,
    priceAtomic: usdToAtomic(15.00),
    maxInputTokens: 64000,
    model: "claude-sonnet-4-20250514",
    description: "Deep-dive analysis with competitive landscape",
  },
  "analyze": {
    route: "/analyze",
    backend: "http://127.0.0.1:9000",
    priceUsd: 0.01,
    priceAtomic: usdToAtomic(0.01),
    maxInputTokens: 2000,
    model: "claude-haiku-4-5-20251001",
    description: "Text analysis (sentiment, entities, keywords)",
  },
  "trustcheck": {
    route: "/trustcheck",
    backend: "http://127.0.0.1:9002",
    priceUsd: 0.05,
    priceAtomic: usdToAtomic(0.05),
    maxInputTokens: 1000,
    model: "claude-haiku-4-5-20251001",
    description: "Trust and reputation check",
  },
};

/** Get the full gateway pricing configuration */
export function getGatewayPricing(): GatewayPricing {
  return {
    walletAddress: loadWalletAddress(),
    network: NETWORK,
    usdcAddress: USDC_ADDRESS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
    tiers: { ...DEFAULT_TIERS },
  };
}

/** Build a 402 PaymentRequirement response for a given tier */
export function buildPaymentRequirement(
  pricing: GatewayPricing,
  tierName: string,
): PaymentRequirement {
  const tier = pricing.tiers[tierName];
  if (!tier) {
    throw new Error(`Unknown tier: "${tierName}"`);
  }

  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: pricing.network,
        maxAmountRequired: tier.priceAtomic,
        payToAddress: pricing.walletAddress,
        requiredDeadlineSeconds: pricing.deadlineSeconds,
        usdcAddress: pricing.usdcAddress,
      },
    ],
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gateway/pricing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gateway/pricing.ts src/__tests__/gateway/pricing.test.ts
git commit -m "feat(gateway): add pricing configuration and 402 requirement builder"
```

---

## Task 3: Nonce Tracking

**Files:**
- Create: `src/gateway/nonces.ts`
- Test: `src/__tests__/gateway/nonces.test.ts`

**Step 1: Write the failing test**

```typescript
// src/__tests__/gateway/nonces.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import {
  initNonceSchema,
  checkNonce,
  reserveNonce,
  markNonceExecuted,
  markNonceFailed,
} from "../../gateway/nonces.js";

function createTestDb(): Database.Database {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nonce-test-"));
  const db = new Database(path.join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  initNonceSchema(db);
  return db;
}

describe("nonce tracking", () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("allows a fresh nonce", () => {
    expect(checkNonce(db, "0xabc123")).toBe(true);
  });

  it("rejects a previously reserved nonce", () => {
    reserveNonce(db, {
      nonce: "0xabc123",
      fromAddr: "0x1111111111111111111111111111111111111111",
      amountAtomic: "250000",
      tier: "summarize-basic",
    });
    expect(checkNonce(db, "0xabc123")).toBe(false);
  });

  it("marks nonce as executed with tx hash", () => {
    reserveNonce(db, {
      nonce: "0xabc123",
      fromAddr: "0x1111111111111111111111111111111111111111",
      amountAtomic: "250000",
      tier: "summarize-basic",
    });
    markNonceExecuted(db, "0xabc123", "0xtxhash999");

    const row = db.prepare("SELECT status, tx_hash FROM x402_nonces WHERE nonce = ?")
      .get("0xabc123") as any;
    expect(row.status).toBe("executed");
    expect(row.tx_hash).toBe("0xtxhash999");
  });

  it("marks nonce as failed with error", () => {
    reserveNonce(db, {
      nonce: "0xabc123",
      fromAddr: "0x1111111111111111111111111111111111111111",
      amountAtomic: "250000",
      tier: "summarize-basic",
    });
    markNonceFailed(db, "0xabc123", "insufficient gas");

    const row = db.prepare("SELECT status, error FROM x402_nonces WHERE nonce = ?")
      .get("0xabc123") as any;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("insufficient gas");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gateway/nonces.test.ts`
Expected: FAIL (module not found)

**Step 3: Write implementation**

```typescript
// src/gateway/nonces.ts
/**
 * Nonce Tracking for x402 Replay Prevention
 *
 * Stores EIP-712 TransferWithAuthorization nonces in SQLite.
 * Prevents the same signed payment from being used twice.
 */
import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

const NONCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS x402_nonces (
    nonce       TEXT PRIMARY KEY,
    from_addr   TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    tier        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    executed_at TEXT,
    tx_hash     TEXT,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_x402_nonces_status ON x402_nonces(status);
  CREATE INDEX IF NOT EXISTS idx_x402_nonces_from ON x402_nonces(from_addr);
`;

/** Initialize the nonce tracking table */
export function initNonceSchema(db: Database): void {
  db.exec(NONCE_SCHEMA);
}

/** Check if a nonce is available (not yet used). Returns true if available. */
export function checkNonce(db: Database, nonce: string): boolean {
  const row = db.prepare("SELECT 1 FROM x402_nonces WHERE nonce = ?").get(nonce);
  return !row;
}

/** Reserve a nonce (mark as pending) */
export function reserveNonce(
  db: Database,
  params: {
    nonce: string;
    fromAddr: string;
    amountAtomic: string;
    tier: string;
  },
): void {
  db.prepare(
    `INSERT INTO x402_nonces (nonce, from_addr, amount_atomic, tier, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(params.nonce, params.fromAddr, params.amountAtomic, params.tier);
}

/** Mark a nonce as successfully executed on-chain */
export function markNonceExecuted(db: Database, nonce: string, txHash: string): void {
  db.prepare(
    `UPDATE x402_nonces SET status = 'executed', tx_hash = ?, executed_at = datetime('now')
     WHERE nonce = ?`,
  ).run(txHash, nonce);
}

/** Mark a nonce as failed (on-chain execution failed) */
export function markNonceFailed(db: Database, nonce: string, error: string): void {
  db.prepare(
    `UPDATE x402_nonces SET status = 'failed', error = ?, executed_at = datetime('now')
     WHERE nonce = ?`,
  ).run(error, nonce);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gateway/nonces.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gateway/nonces.ts src/__tests__/gateway/nonces.test.ts
git commit -m "feat(gateway): add SQLite nonce tracking for replay prevention"
```

---

## Task 4: Off-Chain EIP-712 Signature Verification

**Files:**
- Create: `src/gateway/verify.ts`
- Test: `src/__tests__/gateway/verify.test.ts`

**Context:** This is the core of the payment gate. Uses viem's `verifyTypedData()` to recover the signer from a `TransferWithAuthorization` EIP-712 signature, then validates the authorization fields (to address, amount, timing).

**Step 1: Write the failing test**

```typescript
// src/__tests__/gateway/verify.test.ts
import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { decodePaymentHeader, verifyX402Signature } from "../../gateway/verify.js";

// Test account (DO NOT use in production)
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const testAccount = privateKeyToAccount(TEST_PRIVATE_KEY);

const DATCHI_WALLET: Address = "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706";
const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function createTestPayment(
  amount: string = "250000",
  to: Address = DATCHI_WALLET,
): Promise<string> {
  const nonce = `0x${Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex")}` as `0x${string}`;

  const now = Math.floor(Date.now() / 1000);

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: USDC_ADDRESS,
  } as const;

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const message = {
    from: testAccount.address,
    to,
    value: BigInt(amount),
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + 300),
    nonce,
  };

  const signature = await testAccount.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "eip155:8453",
    payload: {
      signature,
      authorization: {
        from: testAccount.address,
        to,
        value: amount,
        validAfter: String(now - 60),
        validBefore: String(now + 300),
        nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("decodePaymentHeader", () => {
  it("decodes a valid base64 X-Payment header", async () => {
    const header = await createTestPayment();
    const result = decodePaymentHeader(header);
    expect(result).not.toBeNull();
    expect(result!.x402Version).toBe(1);
    expect(result!.payload.authorization.from).toBe(testAccount.address);
  });

  it("returns null for invalid base64", () => {
    expect(decodePaymentHeader("not-valid-base64!!!")).toBeNull();
  });

  it("returns null for missing payload fields", () => {
    const bad = Buffer.from(JSON.stringify({ x402Version: 1 })).toString("base64");
    expect(decodePaymentHeader(bad)).toBeNull();
  });
});

describe("verifyX402Signature", () => {
  it("verifies a valid signed payment", async () => {
    const header = await createTestPayment("250000", DATCHI_WALLET);
    const payment = decodePaymentHeader(header)!;
    const result = await verifyX402Signature(payment, {
      expectedTo: DATCHI_WALLET,
      minimumAmountAtomic: BigInt("250000"),
      usdcAddress: USDC_ADDRESS,
      chainId: 8453,
    });
    expect(result.valid).toBe(true);
    expect(result.signerAddress?.toLowerCase()).toBe(testAccount.address.toLowerCase());
  });

  it("rejects when amount is too low", async () => {
    const header = await createTestPayment("100000", DATCHI_WALLET); // $0.10 < $0.25
    const payment = decodePaymentHeader(header)!;
    const result = await verifyX402Signature(payment, {
      expectedTo: DATCHI_WALLET,
      minimumAmountAtomic: BigInt("250000"),
      usdcAddress: USDC_ADDRESS,
      chainId: 8453,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Insufficient");
  });

  it("rejects when 'to' address doesn't match", async () => {
    const wrongTo: Address = "0x0000000000000000000000000000000000000001";
    const header = await createTestPayment("250000", wrongTo);
    const payment = decodePaymentHeader(header)!;
    const result = await verifyX402Signature(payment, {
      expectedTo: DATCHI_WALLET,
      minimumAmountAtomic: BigInt("250000"),
      usdcAddress: USDC_ADDRESS,
      chainId: 8453,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Recipient mismatch");
  });

  it("rejects an expired authorization", async () => {
    // Manually craft an expired payment
    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}` as `0x${string}`;
    const pastTime = Math.floor(Date.now() / 1000) - 600; // 10 min ago

    const domain = {
      name: "USD Coin", version: "2", chainId: 8453,
      verifyingContract: USDC_ADDRESS,
    } as const;
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const;

    const signature = await testAccount.signTypedData({
      domain, types, primaryType: "TransferWithAuthorization",
      message: {
        from: testAccount.address, to: DATCHI_WALLET,
        value: BigInt("250000"),
        validAfter: BigInt(pastTime - 300),
        validBefore: BigInt(pastTime),  // expired!
        nonce,
      },
    });

    const payment = {
      x402Version: 1, scheme: "exact", network: "eip155:8453",
      payload: {
        signature,
        authorization: {
          from: testAccount.address, to: DATCHI_WALLET,
          value: "250000",
          validAfter: String(pastTime - 300),
          validBefore: String(pastTime),
          nonce,
        },
      },
    };

    const result = await verifyX402Signature(payment, {
      expectedTo: DATCHI_WALLET,
      minimumAmountAtomic: BigInt("250000"),
      usdcAddress: USDC_ADDRESS,
      chainId: 8453,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gateway/verify.test.ts`
Expected: FAIL (module not found)

**Step 3: Write implementation**

```typescript
// src/gateway/verify.ts
/**
 * Off-Chain EIP-712 Signature Verification for x402 Payments
 *
 * Verifies TransferWithAuthorization signatures without making
 * any on-chain calls. Pure cryptographic verification using viem.
 */
import { verifyTypedData, type Address } from "viem";
import type { X402Payment, VerifyResult } from "./types.js";

interface VerifyOptions {
  expectedTo: Address;
  minimumAmountAtomic: bigint;
  usdcAddress: Address;
  chainId: number;
}

/** Decode a base64-encoded X-Payment header into an X402Payment object */
export function decodePaymentHeader(header: string): X402Payment | null {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);

    // Validate required structure
    if (
      typeof parsed.x402Version !== "number" ||
      typeof parsed.scheme !== "string" ||
      typeof parsed.network !== "string" ||
      !parsed.payload?.signature ||
      !parsed.payload?.authorization?.from ||
      !parsed.payload?.authorization?.to ||
      !parsed.payload?.authorization?.value ||
      !parsed.payload?.authorization?.nonce
    ) {
      return null;
    }

    return parsed as X402Payment;
  } catch {
    return null;
  }
}

/** Verify an x402 payment signature off-chain */
export async function verifyX402Signature(
  payment: X402Payment,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const { authorization, signature } = payment.payload;
  const now = Math.floor(Date.now() / 1000);

  // Check timing
  const validBefore = Number(authorization.validBefore);
  const validAfter = Number(authorization.validAfter);

  if (validBefore <= now) {
    return { valid: false, error: "Payment authorization expired" };
  }
  if (validAfter > now) {
    return { valid: false, error: "Payment authorization not yet valid" };
  }

  // Check recipient
  if (authorization.to.toLowerCase() !== options.expectedTo.toLowerCase()) {
    return {
      valid: false,
      error: `Recipient mismatch: expected ${options.expectedTo}, got ${authorization.to}`,
    };
  }

  // Check amount
  const paymentAmount = BigInt(authorization.value);
  if (paymentAmount < options.minimumAmountAtomic) {
    return {
      valid: false,
      error: `Insufficient payment: got ${authorization.value} atomic, need ${options.minimumAmountAtomic}`,
    };
  }

  // Build EIP-712 typed data and verify signature
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: options.chainId,
    verifyingContract: options.usdcAddress,
  } as const;

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const message = {
    from: authorization.from as Address,
    to: authorization.to as Address,
    value: paymentAmount,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: authorization.nonce as `0x${string}`,
  };

  try {
    const valid = await verifyTypedData({
      address: authorization.from as Address,
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message,
      signature: signature as `0x${string}`,
    });

    if (!valid) {
      return { valid: false, error: "Signature verification failed" };
    }

    return {
      valid: true,
      signerAddress: authorization.from as Address,
      amountAtomic: paymentAmount,
    };
  } catch (err: any) {
    return {
      valid: false,
      error: `Signature verification error: ${err?.message || String(err)}`,
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gateway/verify.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gateway/verify.ts src/__tests__/gateway/verify.test.ts
git commit -m "feat(gateway): add off-chain EIP-712 signature verification"
```

---

## Task 5: HTTP Proxy to Backend Services

**Files:**
- Create: `src/gateway/proxy.ts`
- Test: `src/__tests__/gateway/proxy.test.ts`

**Step 1: Write the failing test**

```typescript
// src/__tests__/gateway/proxy.test.ts
import { describe, it, expect, afterAll } from "vitest";
import http from "http";
import { proxyRequest } from "../../gateway/proxy.js";

// Spin up a tiny backend for testing
let mockServer: http.Server;
let mockPort: number;

const setupMockBackend = (): Promise<void> =>
  new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echo: body, method: req.method, url: req.url }));
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as any).port;
      resolve();
    });
  });

describe("proxy", () => {
  afterAll(() => mockServer?.close());

  it("proxies a POST request and returns the response", async () => {
    await setupMockBackend();
    const result = await proxyRequest({
      backend: `http://127.0.0.1:${mockPort}`,
      path: "/analyze",
      method: "POST",
      body: JSON.stringify({ content: "hello world" }),
      headers: { "content-type": "application/json" },
      timeoutMs: 5000,
    });

    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.method).toBe("POST");
    expect(parsed.echo).toContain("hello world");
  });

  it("returns 503 when backend is unreachable", async () => {
    const result = await proxyRequest({
      backend: "http://127.0.0.1:1", // nothing listening
      path: "/test",
      method: "GET",
      body: "",
      headers: {},
      timeoutMs: 2000,
    });
    expect(result.status).toBe(503);
    expect(result.body).toContain("Backend unreachable");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gateway/proxy.test.ts`
Expected: FAIL (module not found)

**Step 3: Write implementation**

```typescript
// src/gateway/proxy.ts
/**
 * HTTP Proxy to Backend Services
 *
 * Forwards requests from the gateway to the appropriate backend
 * service and returns the response.
 */
import http from "http";

interface ProxyRequest {
  backend: string;  // e.g., "http://127.0.0.1:9000"
  path: string;     // e.g., "/analyze"
  method: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Proxy a request to a backend service */
export function proxyRequest(req: ProxyRequest): Promise<ProxyResponse> {
  return new Promise((resolve) => {
    const timeout = req.timeoutMs ?? 30_000;

    try {
      const url = new URL(req.path, req.backend);

      const proxyReq = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: req.method,
          headers: {
            ...req.headers,
            host: url.host,
          },
          timeout,
        },
        (proxyRes) => {
          let body = "";
          proxyRes.on("data", (chunk) => (body += chunk));
          proxyRes.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [key, val] of Object.entries(proxyRes.headers)) {
              if (typeof val === "string") headers[key] = val;
            }
            resolve({
              status: proxyRes.statusCode ?? 500,
              headers,
              body,
            });
          });
        },
      );

      proxyReq.on("error", () => {
        resolve({
          status: 503,
          headers: {},
          body: JSON.stringify({ error: "Backend unreachable" }),
        });
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        resolve({
          status: 504,
          headers: {},
          body: JSON.stringify({ error: "Backend timeout" }),
        });
      });

      if (req.body) {
        proxyReq.write(req.body);
      }
      proxyReq.end();
    } catch {
      resolve({
        status: 503,
        headers: {},
        body: JSON.stringify({ error: "Backend unreachable" }),
      });
    }
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gateway/proxy.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gateway/proxy.ts src/__tests__/gateway/proxy.test.ts
git commit -m "feat(gateway): add HTTP proxy for backend services"
```

---

## Task 6: Async On-Chain Execution

**Files:**
- Create: `src/gateway/on-chain.ts`
- Test: `src/__tests__/gateway/on-chain.test.ts`

**Context:** After responding to the customer, the gateway calls USDC's `transferWithAuthorization()` on Base to actually move the customer's USDC to Datchi's wallet. This is fire-and-forget — the customer already got their response.

**Step 1: Write the failing test**

```typescript
// src/__tests__/gateway/on-chain.test.ts
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { initNonceSchema } from "../../gateway/nonces.js";
import { buildTransferWithAuthTx } from "../../gateway/on-chain.js";

function createTestDb(): Database.Database {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onchain-test-"));
  const db = new Database(path.join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  initNonceSchema(db);
  return db;
}

describe("on-chain execution", () => {
  it("builds correct TransferWithAuthorization calldata", () => {
    const calldata = buildTransferWithAuthTx({
      from: "0x1111111111111111111111111111111111111111",
      to: "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706",
      value: "250000",
      validAfter: "1709300000",
      validBefore: "1709300300",
      nonce: "0x" + "ab".repeat(32),
      signature: "0x" + "cd".repeat(65),
    });

    // Should be non-empty hex data encoding transferWithAuthorization call
    expect(calldata).toMatch(/^0x[a-f0-9]+$/);
    // Function selector for transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
    // is 0xe3ee160e
    expect(calldata.startsWith("0xe3ee160e")).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gateway/on-chain.test.ts`
Expected: FAIL (module not found)

**Step 3: Write implementation**

```typescript
// src/gateway/on-chain.ts
/**
 * Async On-Chain Execution
 *
 * Executes TransferWithAuthorization on the USDC contract
 * on Base to collect payment after the response is sent.
 *
 * This is fire-and-forget from the customer's perspective.
 * Success/failure is logged via nonce tracking.
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base } from "viem/chains";
import { markNonceExecuted, markNonceFailed } from "./nonces.js";
import { logRevenue } from "../local/accounting.js";
import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const TRANSFER_WITH_AUTH_ABI = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

interface AuthorizationParams {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
}

/** Split a 65-byte signature into v, r, s components */
function splitSignature(sig: string): { v: number; r: `0x${string}`; s: `0x${string}` } {
  const raw = sig.startsWith("0x") ? sig.slice(2) : sig;
  const r = `0x${raw.slice(0, 64)}` as `0x${string}`;
  const s = `0x${raw.slice(64, 128)}` as `0x${string}`;
  const v = parseInt(raw.slice(128, 130), 16);
  return { v, r, s };
}

/** Build the calldata for transferWithAuthorization (for testing) */
export function buildTransferWithAuthTx(params: AuthorizationParams): `0x${string}` {
  const { v, r, s } = splitSignature(params.signature);

  return encodeFunctionData({
    abi: TRANSFER_WITH_AUTH_ABI,
    functionName: "transferWithAuthorization",
    args: [
      params.from as Address,
      params.to as Address,
      BigInt(params.value),
      BigInt(params.validAfter),
      BigInt(params.validBefore),
      params.nonce as `0x${string}`,
      v,
      r,
      s,
    ],
  });
}

function getRpcUrl(): string {
  return process.env.BASE_RPC_URL || "https://mainnet.base.org";
}

/**
 * Execute TransferWithAuthorization on-chain.
 * Fire-and-forget: logs result to nonce table.
 */
export async function executeTransferOnChain(
  account: PrivateKeyAccount,
  db: Database,
  params: AuthorizationParams & { tier: string; amountCents: number },
): Promise<void> {
  try {
    const calldata = buildTransferWithAuthTx(params);

    const client = createWalletClient({
      account,
      chain: base,
      transport: http(getRpcUrl(), { timeout: 30_000 }),
    });

    const txHash = await client.sendTransaction({
      to: USDC_ADDRESS,
      data: calldata,
    });

    // Mark nonce as executed
    markNonceExecuted(db, params.nonce, txHash);

    // Log revenue
    logRevenue(db, {
      source: `gateway:${params.tier}`,
      amountCents: params.amountCents,
      description: `x402 payment for ${params.tier}`,
      metadata: {
        fromAddr: params.from,
        txHash,
        nonce: params.nonce,
      },
    });
  } catch (err: any) {
    markNonceFailed(db, params.nonce, err?.message || String(err));
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gateway/on-chain.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gateway/on-chain.ts src/__tests__/gateway/on-chain.test.ts
git commit -m "feat(gateway): add async on-chain TransferWithAuthorization execution"
```

---

## Task 7: Gateway HTTP Server

**Files:**
- Create: `src/gateway/server.ts`
- Test: `src/__tests__/gateway/server.test.ts`

**Context:** This is the main gateway server. It routes requests, returns 402 for paid endpoints without payment, verifies payment, proxies to backend, and fires off on-chain execution asynchronously.

**Step 1: Write the failing test**

```typescript
// src/__tests__/gateway/server.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { createGatewayServer } from "../../gateway/server.js";
import { initNonceSchema } from "../../gateway/nonces.js";
import { initAccountingSchema } from "../../local/accounting.js";

// Test helpers
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const customerAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function createTestDb(): Database.Database {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-test-"));
  const db = new Database(path.join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  initNonceSchema(db);
  initAccountingSchema(db);
  return db;
}

function httpGet(url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k] = v;
        }
        resolve({ status: res.statusCode ?? 0, body, headers });
      });
    }).on("error", reject);
  });
}

function httpPost(
  url: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
          }
          resolve({ status: res.statusCode ?? 0, body: data, headers });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("gateway server", () => {
  let server: http.Server;
  let port: number;
  let db: Database.Database;
  // Mock backend for proxying
  let mockBackend: http.Server;
  let mockBackendPort: number;

  beforeAll(async () => {
    db = createTestDb();

    // Start a mock backend
    await new Promise<void>((resolve) => {
      mockBackend = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: "mock-analysis", input: body }));
        });
      });
      mockBackend.listen(0, "127.0.0.1", () => {
        mockBackendPort = (mockBackend.address() as any).port;
        resolve();
      });
    });

    // Start gateway with mock backend ports
    await new Promise<void>((resolve) => {
      const gw = createGatewayServer({
        db,
        port: 0, // random port
        // Disable on-chain execution in tests
        executeOnChain: false,
        // Override backend URLs to point to mock
        backendOverrides: {
          "http://127.0.0.1:9000": `http://127.0.0.1:${mockBackendPort}`,
          "http://127.0.0.1:9002": `http://127.0.0.1:${mockBackendPort}`,
        },
      });
      server = gw.server;
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
    mockBackend?.close();
    db?.close();
  });

  it("GET /health returns 200", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.status).toBe("healthy");
  });

  it("GET /pricing returns all tiers", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/pricing`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.tiers).toBeDefined();
    expect(Object.keys(parsed.tiers).length).toBeGreaterThanOrEqual(5);
  });

  it("POST /summarize without payment returns 402", async () => {
    const res = await httpPost(
      `http://127.0.0.1:${port}/summarize`,
      JSON.stringify({ content: "test content" }),
    );
    expect(res.status).toBe(402);
    const parsed = JSON.parse(res.body);
    expect(parsed.x402Version).toBe(1);
    expect(parsed.accepts).toBeDefined();
    expect(parsed.accepts[0].scheme).toBe("exact");
  });

  it("POST /summarize with valid payment returns 200", async () => {
    // Sign a payment to Datchi's wallet
    const pricing = JSON.parse(
      (await httpGet(`http://127.0.0.1:${port}/pricing`)).body,
    );
    const walletAddr = pricing.walletAddress as Address;
    const tier = pricing.tiers["summarize-basic"];

    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}` as `0x${string}`;
    const now = Math.floor(Date.now() / 1000);

    const signature = await customerAccount.signTypedData({
      domain: {
        name: "USD Coin", version: "2", chainId: 8453,
        verifyingContract: USDC_ADDRESS,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: customerAccount.address,
        to: walletAddr,
        value: BigInt(tier.priceAtomic),
        validAfter: BigInt(now - 60),
        validBefore: BigInt(now + 300),
        nonce,
      },
    });

    const paymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "eip155:8453",
      payload: {
        signature,
        authorization: {
          from: customerAccount.address,
          to: walletAddr,
          value: tier.priceAtomic,
          validAfter: String(now - 60),
          validBefore: String(now + 300),
          nonce,
        },
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

    const res = await httpPost(
      `http://127.0.0.1:${port}/summarize`,
      JSON.stringify({ content: "test content for summary" }),
      { "X-Payment": paymentHeader },
    );

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result).toBeDefined();
  });

  it("POST /summarize with replayed nonce returns 402", async () => {
    // First: make a valid payment
    const pricing = JSON.parse(
      (await httpGet(`http://127.0.0.1:${port}/pricing`)).body,
    );
    const walletAddr = pricing.walletAddress as Address;
    const tier = pricing.tiers["summarize-basic"];

    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}` as `0x${string}`;
    const now = Math.floor(Date.now() / 1000);

    const signature = await customerAccount.signTypedData({
      domain: {
        name: "USD Coin", version: "2", chainId: 8453,
        verifyingContract: USDC_ADDRESS,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: customerAccount.address,
        to: walletAddr,
        value: BigInt(tier.priceAtomic),
        validAfter: BigInt(now - 60),
        validBefore: BigInt(now + 300),
        nonce,
      },
    });

    const paymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "eip155:8453",
      payload: {
        signature,
        authorization: {
          from: customerAccount.address,
          to: walletAddr,
          value: tier.priceAtomic,
          validAfter: String(now - 60),
          validBefore: String(now + 300),
          nonce,
        },
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

    // First request: should succeed
    const res1 = await httpPost(
      `http://127.0.0.1:${port}/summarize`,
      JSON.stringify({ content: "first request" }),
      { "X-Payment": paymentHeader },
    );
    expect(res1.status).toBe(200);

    // Second request with same nonce: should fail
    const res2 = await httpPost(
      `http://127.0.0.1:${port}/summarize`,
      JSON.stringify({ content: "replay attempt" }),
      { "X-Payment": paymentHeader },
    );
    expect(res2.status).toBe(402);
    const parsed = JSON.parse(res2.body);
    expect(parsed.error).toContain("already used");
  });

  it("GET /unknown returns 404", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gateway/server.test.ts`
Expected: FAIL (module not found)

**Step 3: Write implementation**

```typescript
// src/gateway/server.ts
/**
 * x402 Gateway Server
 *
 * Unified HTTP server on port 7402 that:
 * 1. Returns 402 + payment requirements for paid endpoints
 * 2. Verifies EIP-712 signatures off-chain
 * 3. Checks nonces for replay prevention
 * 4. Proxies to backend services
 * 5. Executes USDC transfer on-chain asynchronously
 */
import http from "http";
import type BetterSqlite3 from "better-sqlite3";
import type { PrivateKeyAccount } from "viem";
import { getGatewayPricing, buildPaymentRequirement } from "./pricing.js";
import { decodePaymentHeader, verifyX402Signature } from "./verify.js";
import { checkNonce, reserveNonce, initNonceSchema } from "./nonces.js";
import { proxyRequest } from "./proxy.js";
import { executeTransferOnChain } from "./on-chain.js";
import type { GatewayPricing, GatewayTier } from "./types.js";

type Database = BetterSqlite3.Database;

interface GatewayOptions {
  db: Database;
  port?: number;
  account?: PrivateKeyAccount;
  /** Set to false to skip on-chain execution (for testing) */
  executeOnChain?: boolean;
  /** Override backend URLs for testing */
  backendOverrides?: Record<string, string>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Payment",
  });
  res.end(JSON.stringify(data));
}

/** Find which tier a route belongs to */
function findTierForRoute(
  pricing: GatewayPricing,
  route: string,
): { name: string; tier: GatewayTier } | null {
  for (const [name, tier] of Object.entries(pricing.tiers)) {
    if (tier.route === route) return { name, tier };
  }
  return null;
}

export function createGatewayServer(options: GatewayOptions) {
  const pricing = getGatewayPricing();
  const doOnChain = options.executeOnChain !== false;
  const overrides = options.backendOverrides ?? {};

  function resolveBackend(original: string): string {
    return overrides[original] ?? original;
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    // CORS preflight
    if (method === "OPTIONS") {
      jsonResponse(res, 204, "");
      return;
    }

    // ── Free endpoints ──
    if (url === "/health" && method === "GET") {
      jsonResponse(res, 200, {
        status: "healthy",
        gateway: "x402",
        port: options.port ?? 7402,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (url === "/info" && method === "GET") {
      jsonResponse(res, 200, {
        name: "Datchi x402 Gateway",
        version: "1.0.0",
        walletAddress: pricing.walletAddress,
        network: pricing.network,
        endpoints: Object.entries(pricing.tiers).map(([name, tier]) => ({
          name,
          route: tier.route,
          priceUsd: tier.priceUsd,
          description: tier.description,
        })),
      });
      return;
    }

    if (url === "/pricing" && method === "GET") {
      jsonResponse(res, 200, {
        walletAddress: pricing.walletAddress,
        network: pricing.network,
        usdcAddress: pricing.usdcAddress,
        tiers: pricing.tiers,
      });
      return;
    }

    // ── Paid endpoints ──
    const tierMatch = findTierForRoute(pricing, url);
    if (!tierMatch) {
      jsonResponse(res, 404, { error: `Unknown endpoint: ${url}` });
      return;
    }

    if (method !== "POST") {
      jsonResponse(res, 405, { error: "Method not allowed. Use POST." });
      return;
    }

    const { name: tierName, tier } = tierMatch;

    // Check for X-Payment header
    const paymentHeader = req.headers["x-payment"] as string | undefined;
    if (!paymentHeader) {
      // Return 402 with payment requirements
      const requirement = buildPaymentRequirement(pricing, tierName);
      res.writeHead(402, {
        "Content-Type": "application/json",
        "X-Payment-Required": JSON.stringify(requirement),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "X-Payment-Required",
      });
      res.end(JSON.stringify(requirement));
      return;
    }

    // Decode payment
    const payment = decodePaymentHeader(paymentHeader);
    if (!payment) {
      jsonResponse(res, 400, { error: "Invalid X-Payment header" });
      return;
    }

    // Verify signature off-chain
    const verification = await verifyX402Signature(payment, {
      expectedTo: pricing.walletAddress,
      minimumAmountAtomic: BigInt(tier.priceAtomic),
      usdcAddress: pricing.usdcAddress,
      chainId: 8453,
    });

    if (!verification.valid) {
      // Return 402 so the client can retry with a correct payment
      const requirement = buildPaymentRequirement(pricing, tierName);
      res.writeHead(402, {
        "Content-Type": "application/json",
        "X-Payment-Required": JSON.stringify(requirement),
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({
        ...requirement,
        error: verification.error,
      }));
      return;
    }

    // Check nonce (replay prevention)
    const nonce = payment.payload.authorization.nonce;
    if (!checkNonce(options.db, nonce)) {
      const requirement = buildPaymentRequirement(pricing, tierName);
      res.writeHead(402, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({
        ...requirement,
        error: "Payment already used (nonce replay detected)",
      }));
      return;
    }

    // Reserve nonce
    reserveNonce(options.db, {
      nonce,
      fromAddr: payment.payload.authorization.from,
      amountAtomic: payment.payload.authorization.value,
      tier: tierName,
    });

    // Read request body
    const body = await readBody(req);

    // Proxy to backend
    const backendUrl = resolveBackend(tier.backend);
    const proxyResult = await proxyRequest({
      backend: backendUrl,
      path: tier.route,
      method: "POST",
      body,
      headers: {
        "content-type": req.headers["content-type"] ?? "application/json",
      },
      timeoutMs: 30_000,
    });

    // If backend failed, return error (don't charge)
    if (proxyResult.status >= 500) {
      jsonResponse(res, 503, {
        error: "Backend service unavailable",
        detail: proxyResult.body,
      });
      return;
    }

    // Return the backend response to the customer
    res.writeHead(proxyResult.status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(proxyResult.body);

    // Fire-and-forget: execute on-chain transfer
    if (doOnChain && options.account) {
      const amountCents = Math.round(tier.priceUsd * 100);
      executeTransferOnChain(options.account, options.db, {
        from: payment.payload.authorization.from,
        to: payment.payload.authorization.to,
        value: payment.payload.authorization.value,
        validAfter: payment.payload.authorization.validAfter,
        validBefore: payment.payload.authorization.validBefore,
        nonce: payment.payload.authorization.nonce,
        signature: payment.payload.signature,
        tier: tierName,
        amountCents,
      }).catch(() => {
        // Errors are already logged by executeTransferOnChain
      });
    }
  });

  return { server, pricing };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gateway/server.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gateway/server.ts src/__tests__/gateway/server.test.ts
git commit -m "feat(gateway): add x402 HTTP gateway server with payment verification"
```

---

## Task 8: Gateway Entry Point (CLI launcher)

**Files:**
- Create: `src/gateway/index.ts`

**Step 1: Write the entry point**

```typescript
// src/gateway/index.ts
/**
 * x402 Gateway Entry Point
 *
 * Starts the gateway server on port 7402 (or GATEWAY_PORT env var).
 * Loads the wallet from ~/.automaton/wallet.json for on-chain execution.
 *
 * Usage: npx tsx src/gateway/index.ts
 */
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createGatewayServer } from "./server.js";
import { initNonceSchema } from "./nonces.js";
import { initAccountingSchema } from "../local/accounting.js";

const PORT = parseInt(process.env.GATEWAY_PORT ?? "7402", 10);
const DB_PATH = process.env.GATEWAY_DB_PATH ??
  path.join(os.homedir(), ".automaton", "gateway.db");
const WALLET_PATH = process.env.WALLET_PATH ??
  path.join(os.homedir(), ".automaton", "wallet.json");

function main() {
  // Load wallet
  let account;
  try {
    const walletRaw = fs.readFileSync(WALLET_PATH, "utf-8");
    const wallet = JSON.parse(walletRaw);
    account = privateKeyToAccount(wallet.privateKey as `0x${string}`);
    console.log(`[gateway] Wallet loaded: ${account.address}`);
  } catch (err: any) {
    console.error(`[gateway] Failed to load wallet from ${WALLET_PATH}: ${err.message}`);
    console.error("[gateway] On-chain execution will be disabled.");
  }

  // Open database
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Initialize schemas
  initNonceSchema(db);
  initAccountingSchema(db);

  // Create and start server
  const { server, pricing } = createGatewayServer({
    db,
    port: PORT,
    account,
    executeOnChain: !!account,
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[gateway] x402 gateway running on http://0.0.0.0:${PORT}`);
    console.log(`[gateway] Wallet: ${pricing.walletAddress}`);
    console.log(`[gateway] Endpoints:`);
    for (const [name, tier] of Object.entries(pricing.tiers)) {
      console.log(`  ${tier.route} → $${tier.priceUsd} (${name})`);
    }
    console.log(`[gateway] On-chain execution: ${account ? "ENABLED" : "DISABLED"}`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[gateway] Shutting down...");
    server.close();
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.close();
    db.close();
    process.exit(0);
  });
}

main();
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/gateway/index.ts` (or full project `npx tsc --noEmit`)
Expected: No errors

**Step 3: Commit**

```bash
git add src/gateway/index.ts
git commit -m "feat(gateway): add CLI entry point for x402 gateway server"
```

---

## Task 9: Full Build Verification + Run All Gateway Tests

**Step 1: Run all gateway tests**

Run: `npx vitest run src/__tests__/gateway/`
Expected: All tests PASS

**Step 2: Type check the full project**

Run: `npx tsc --noEmit`
Expected: No errors (or only pre-existing ones)

**Step 3: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: No regressions

**Step 4: Manual smoke test**

Run: `npx tsx src/gateway/index.ts`
Expected: Server starts on port 7402, prints endpoint list

In another terminal:
- `curl http://localhost:7402/health` → 200
- `curl http://localhost:7402/pricing` → 200 with tiers
- `curl -X POST http://localhost:7402/summarize -d '{"content":"test"}'` → 402 with payment requirements

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat(gateway): x402 unified payment gateway complete

Implements the full x402 payment gateway on port 7402:
- Off-chain EIP-712 signature verification via viem
- SQLite nonce tracking for replay prevention
- HTTP proxy to backend services (text-analysis, trustcheck)
- Async on-chain TransferWithAuthorization execution
- Revenue/expense logging to existing accounting ledger

Design: docs/plans/2026-03-02-x402-gateway-design.md"
```

---

## Summary

| Task | Files | Description |
|------|-------|-------------|
| 1 | `src/gateway/types.ts` | Type definitions |
| 2 | `src/gateway/pricing.ts` | Pricing config + 402 builder |
| 3 | `src/gateway/nonces.ts` | SQLite nonce tracking |
| 4 | `src/gateway/verify.ts` | Off-chain EIP-712 verification |
| 5 | `src/gateway/proxy.ts` | HTTP proxy to backends |
| 6 | `src/gateway/on-chain.ts` | Async TransferWithAuthorization |
| 7 | `src/gateway/server.ts` | Main HTTP gateway server |
| 8 | `src/gateway/index.ts` | CLI entry point |
| 9 | — | Build verification + smoke test |

**Total: 8 new files, 6 test files, ~9 commits**
