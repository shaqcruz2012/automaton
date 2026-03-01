/**
 * Datchi x402 API Service — Revenue Scaffold
 *
 * Ready-to-deploy API server with x402 payment gates.
 * Earns USDC on Base for every paid API call.
 *
 * QUICK START:
 *   cd services/x402-api
 *   npm install
 *   node server.js
 *
 * CUSTOMIZATION (Datchi — modify these to add your own endpoints):
 *   1. Add new routes below the "PAID ENDPOINTS" section
 *   2. Set price per call via the paymentMiddleware config
 *   3. Expose port via: cloudflared tunnel --url http://localhost:9402
 *
 * PRICING GUIDE (x402 on Base, USDC):
 *   $0.001 - Simple data lookups, health checks
 *   $0.005 - Computed results, aggregations
 *   $0.01  - AI-powered responses, complex queries
 *   $0.05  - Batch operations, report generation
 */

import express from "express";

// x402 middleware — gates endpoints behind USDC payment
let paymentMiddleware;
try {
  const x402 = await import("@x402/express");
  paymentMiddleware = x402.paymentMiddleware || x402.default?.paymentMiddleware;
} catch {
  // Fallback: if @x402/express not installed, use a pass-through
  // that returns 402 manually (Datchi can install the package later)
  console.warn("[x402] @x402/express not found — using manual 402 fallback");
  paymentMiddleware = null;
}

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "9402", 10);
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706";

// Coinbase facilitator for x402 payment verification (fee-free on Base)
const FACILITATOR_URL = "https://x402.org/facilitator";

// ── Free Endpoints (discovery, health) ──────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "Datchi API",
    version: "0.1.0",
    status: "alive",
    endpoints: {
      "/health": { price: "free", description: "Health check" },
      "/api/data": { price: "$0.001 USDC", description: "Data lookup endpoint" },
      "/api/analyze": { price: "$0.005 USDC", description: "Analysis endpoint" },
      "/api/generate": { price: "$0.01 USDC", description: "AI generation endpoint" },
    },
    payment: {
      protocol: "x402",
      network: "base",
      token: "USDC",
      recipient: WALLET_ADDRESS,
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "alive",
    uptime: process.uptime(),
    wallet: WALLET_ADDRESS,
  });
});

// ── Payment Gate Helper ─────────────────────────────────────────

/**
 * Creates x402 payment middleware for a given price.
 * If @x402/express is available, uses native middleware.
 * Otherwise, returns manual 402 response with payment instructions.
 */
function gate(priceUsd) {
  if (paymentMiddleware) {
    return paymentMiddleware(FACILITATOR_URL, {
      recipient: WALLET_ADDRESS,
      amount: priceUsd,
      network: "base",
      token: "USDC",
    });
  }

  // Manual 402 fallback — still works with x402-compatible clients
  return (req, res, next) => {
    const payment = req.headers["x-payment"];
    if (payment) {
      // Client included payment — in production, verify via facilitator
      // For now, pass through (Datchi should install @x402/express for real verification)
      next();
      return;
    }
    res.status(402).json({
      error: "Payment Required",
      "x-payment-required": {
        scheme: "exact",
        network: "base",
        token: "USDC",
        recipient: WALLET_ADDRESS,
        amount: String(priceUsd),
        facilitator: FACILITATOR_URL,
        description: `Pay $${priceUsd} USDC on Base to access this endpoint`,
      },
    });
  };
}

// ── PAID ENDPOINTS ──────────────────────────────────────────────
// Datchi: Add your revenue-generating endpoints here.
// Each endpoint is gated by x402 — callers pay USDC per request.

// Example: Data lookup — $0.001 per call
app.get("/api/data", gate(0.001), (req, res) => {
  const query = req.query.q || "default";
  res.json({
    query,
    result: {
      timestamp: new Date().toISOString(),
      data: `Result for: ${query}`,
      source: "datchi-api",
    },
    meta: { price: "$0.001", network: "base" },
  });
});

// Example: Analysis — $0.005 per call
app.post("/api/analyze", gate(0.005), (req, res) => {
  const { input } = req.body || {};
  res.json({
    analysis: {
      input: input || "(no input)",
      summary: "Analysis placeholder — customize this endpoint",
      confidence: 0.85,
    },
    meta: { price: "$0.005", network: "base" },
  });
});

// Example: AI generation — $0.01 per call
app.post("/api/generate", gate(0.01), (req, res) => {
  const { prompt } = req.body || {};
  res.json({
    generation: {
      prompt: prompt || "(no prompt)",
      output: "Generated content placeholder — connect to inference client",
      model: "datchi-v1",
    },
    meta: { price: "$0.01", network: "base" },
  });
});

// ── Metrics (free — helps track revenue) ────────────────────────

let totalRequests = 0;
let paidRequests = 0;

app.use((req, _res, next) => {
  totalRequests++;
  if (req.headers["x-payment"]) paidRequests++;
  next();
});

app.get("/metrics", (_req, res) => {
  res.json({
    totalRequests,
    paidRequests,
    uptime: process.uptime(),
    wallet: WALLET_ADDRESS,
  });
});

// ── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Datchi API] Listening on port ${PORT}`);
  console.log(`[Datchi API] Wallet: ${WALLET_ADDRESS}`);
  console.log(`[Datchi API] x402 payment gate: ${paymentMiddleware ? "native" : "manual fallback"}`);
  console.log(`[Datchi API] Expose via: cloudflared tunnel --url http://localhost:${PORT}`);
});
