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
import { checkNonce, reserveNonce } from "./nonces.js";
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

const MAX_BODY_BYTES = 1_048_576; // 1 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
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
      jsonResponse(res, 404, { error: "Unknown endpoint" });
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

    // Proxy to backend (use backendPath if specified, otherwise route)
    const backendUrl = resolveBackend(tier.backend);
    const backendPath = tier.backendPath ?? tier.route;
    const proxyResult = await proxyRequest({
      backend: backendUrl,
      path: backendPath,
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
