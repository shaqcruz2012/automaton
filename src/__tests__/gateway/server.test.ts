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

async function signPaymentForTier(
  walletAddr: Address,
  priceAtomic: string,
): Promise<string> {
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
      value: BigInt(priceAtomic),
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
        value: priceAtomic,
        validAfter: String(now - 60),
        validBefore: String(now + 300),
        nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
}

describe("gateway server", () => {
  let server: http.Server;
  let port: number;
  let db: Database.Database;
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

    // Start gateway with mock backend
    await new Promise<void>((resolve) => {
      const gw = createGatewayServer({
        db,
        port: 0,
        executeOnChain: false,
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
    const pricing = JSON.parse(
      (await httpGet(`http://127.0.0.1:${port}/pricing`)).body,
    );
    const walletAddr = pricing.walletAddress as Address;
    const tier = pricing.tiers["summarize-basic"];
    const paymentHeader = await signPaymentForTier(walletAddr, tier.priceAtomic);

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
    const pricing = JSON.parse(
      (await httpGet(`http://127.0.0.1:${port}/pricing`)).body,
    );
    const walletAddr = pricing.walletAddress as Address;
    const tier = pricing.tiers["summarize-basic"];
    const paymentHeader = await signPaymentForTier(walletAddr, tier.priceAtomic);

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
