/**
 * URL Summarizer Pro - HTTP Server
 *
 * Standalone microservice that summarizes web pages via AI.
 * Runs on a configurable port (default: 9003).
 *
 * Endpoints:
 *   GET  /health           - Health check
 *   GET  /info             - Service info + pricing
 *   POST /summarize-url    - Summarize a URL (requires API key)
 *   POST /api-keys         - Create a new API key
 *   GET  /quota            - Check remaining quota
 *
 * Usage:
 *   LLM_API_KEY=... npx tsx src/server.ts
 */

import http from "http";
import { ulid } from "ulid";
import { loadConfig, PRICING_TIERS } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { createApiKey, lookupApiKey, checkQuota, incrementUsage } from "./api-keys.js";
import type {
  SummarizeRequest,
  ErrorResponse,
  HealthResponse,
  ServiceDeclaration,
} from "./types.js";

const config = loadConfig();
const startTime = Date.now();

// ── Helpers ──────────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let aborted = false;
    const maxSize = 1_000_000; // 1MB max request body

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxSize) {
        aborted = true;
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => { if (!aborted) resolve(body); });
    req.on("error", (err) => { if (!aborted) reject(err); });
  });
}

function extractApiKey(req: http.IncomingMessage): string | null {
  // Check X-Api-Key header first
  const headerKey = req.headers["x-api-key"] as string | undefined;
  if (headerKey) return headerKey;

  // Check Authorization: Bearer <key>
  const auth = req.headers["authorization"] as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);

  // Check query parameter ?api_key=...
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const queryKey = url.searchParams.get("api_key");
  if (queryKey) return queryKey;

  return null;
}

function log(level: string, message: string, context?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module: "url-summarizer",
    message,
    ...(context ? { context } : {}),
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

function errorResponse(code: string, message: string, requestId: string): ErrorResponse {
  return { error: message, code, request_id: requestId };
}

// ── Server ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const urlPath = (req.url ?? "/").split("?")[0];
  const requestId = ulid();

  // CORS preflight
  if (method === "OPTIONS") {
    jsonResponse(res, 204, "");
    return;
  }

  // ── GET /health ──
  if (urlPath === "/health" && method === "GET") {
    const health: HealthResponse = {
      status: "healthy",
      version: config.version,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      port: config.port,
      timestamp: new Date().toISOString(),
    };
    jsonResponse(res, 200, health);
    return;
  }

  // ── GET /info ──
  if (urlPath === "/info" && method === "GET") {
    const declaration: ServiceDeclaration = {
      name: "URL Summarizer Pro",
      description: "AI-powered URL summarization with structured output",
      version: config.version,
      port: config.port,
      health_endpoint: "/health",
      revenue_model: "pay-per-use",
      price_per_call_usd: 0.01,
      success_kpi: "successful_summaries_per_day",
    };
    jsonResponse(res, 200, {
      ...declaration,
      pricing_tiers: PRICING_TIERS,
      supported_detail_levels: ["short", "medium", "long"],
    });
    return;
  }

  // ── POST /api-keys ──
  if (urlPath === "/api-keys" && method === "POST") {
    try {
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const tier = typeof parsed.tier === "string" ? parsed.tier : "free";
      const owner = typeof parsed.owner === "string" ? parsed.owner : undefined;

      // Validate tier
      if (!PRICING_TIERS.some((t) => t.name === tier)) {
        jsonResponse(res, 400, errorResponse("INVALID_TIER", `Invalid tier: ${tier}`, requestId));
        return;
      }

      const record = createApiKey(config, tier, owner);
      log("info", "API key created", { tier, owner, request_id: requestId });

      jsonResponse(res, 201, {
        api_key: record.key,
        tier: record.tier,
        created_at: record.created_at,
        request_id: requestId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 400, errorResponse("INVALID_REQUEST", message, requestId));
    }
    return;
  }

  // ── GET /quota ──
  if (urlPath === "/quota" && method === "GET") {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      jsonResponse(res, 401, errorResponse("MISSING_API_KEY", "API key required. Pass via X-Api-Key header.", requestId));
      return;
    }

    const record = lookupApiKey(config, apiKey);
    if (!record) {
      jsonResponse(res, 401, errorResponse("INVALID_API_KEY", "Invalid or disabled API key", requestId));
      return;
    }

    const { quota } = checkQuota(config, apiKey);
    jsonResponse(res, 200, { quota, request_id: requestId });
    return;
  }

  // ── POST /summarize-url ──
  if (urlPath === "/summarize-url" && method === "POST") {
    // Require API key
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      jsonResponse(res, 401, errorResponse("MISSING_API_KEY", "API key required. Pass via X-Api-Key header or Authorization: Bearer <key>.", requestId));
      return;
    }

    const record = lookupApiKey(config, apiKey);
    if (!record) {
      jsonResponse(res, 401, errorResponse("INVALID_API_KEY", "Invalid or disabled API key", requestId));
      return;
    }

    // Check quota
    const { allowed, quota } = checkQuota(config, apiKey);
    if (!allowed) {
      jsonResponse(res, 429, {
        ...errorResponse("QUOTA_EXCEEDED", `Quota exceeded for tier '${quota.tier}'. Upgrade or wait until ${quota.resets_at}.`, requestId),
        quota_remaining: 0,
        quota,
      });
      return;
    }

    // Parse request body
    let request: SummarizeRequest;
    try {
      const body = await readBody(req);
      const parsed = body.trim() ? JSON.parse(body) : {};

      if (!parsed.url || typeof parsed.url !== "string") {
        jsonResponse(res, 400, errorResponse("MISSING_URL", "Request body must include 'url' field", requestId));
        return;
      }

      request = {
        url: parsed.url,
        detail_level: parsed.detail_level ?? "medium",
        language: parsed.language ?? "English",
      };
    } catch {
      jsonResponse(res, 400, errorResponse("INVALID_JSON", "Request body must be valid JSON", requestId));
      return;
    }

    // Validate detail_level
    if (!["short", "medium", "long"].includes(request.detail_level ?? "medium")) {
      jsonResponse(res, 400, errorResponse("INVALID_DETAIL_LEVEL", "detail_level must be 'short', 'medium', or 'long'", requestId));
      return;
    }

    log("info", "Summarize request", {
      request_id: requestId,
      url: request.url,
      detail_level: request.detail_level,
      tier: record.tier,
    });

    // Run pipeline (wrapped to prevent unhandled rejection crashes)
    let result: Awaited<ReturnType<typeof runPipeline>>;
    try {
      result = await runPipeline(config, request, requestId);
    } catch (pipelineErr) {
      const msg = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
      log("error", "Unexpected pipeline error", { request_id: requestId, error: msg });
      jsonResponse(res, 500, errorResponse("INTERNAL_ERROR", "An unexpected error occurred", requestId));
      return;
    }

    if (result.ok) {
      // Increment usage on success
      incrementUsage(config, apiKey);

      log("info", "Summarize success", {
        request_id: requestId,
        word_count: result.data.word_count,
        latency_ms: result.data.latency_ms,
      });

      jsonResponse(res, 200, result.data);
    } else {
      log("warn", "Summarize failed", {
        request_id: requestId,
        code: result.code,
        error: result.error,
      });

      const statusMap: Record<string, number> = {
        INVALID_URL: 400,
        NOT_HTML: 400,
        FETCH_TIMEOUT: 504,
        DNS_ERROR: 502,
        ACCESS_DENIED: 403,
        PAYWALL: 403,
        NO_CONTENT: 422,
        LLM_NOT_CONFIGURED: 503,
        LLM_API_ERROR: 502,
        FETCH_ERROR: 502,
        SUMMARIZATION_ERROR: 500,
      };

      const status = statusMap[result.code] ?? 500;
      jsonResponse(res, status, errorResponse(result.code, result.error, requestId));
    }
    return;
  }

  // ── 404 ──
  jsonResponse(res, 404, errorResponse("NOT_FOUND", `Unknown endpoint: ${method} ${urlPath}`, requestId));
});

// ── Start ────────────────────────────────────────────────────────────

server.listen(config.port, () => {
  log("info", `URL Summarizer Pro v${config.version} listening on port ${config.port}`);
  log("info", `LLM: ${config.llmModel} via ${config.llmBaseUrl}`);
  log("info", `Free tier: ${config.freeTierDailyLimit} URLs/day`);
});

server.on("error", (err) => {
  log("error", `Server error: ${err.message}`);
  process.exit(1);
});

export { server };
