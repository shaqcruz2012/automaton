/**
 * Perplexity AI Web Search Tool
 *
 * Provides real-time web search via the Perplexity API (sonar model).
 * Used for market research, niche discovery, trend analysis, and
 * competitive intelligence.
 *
 * API key resolution order:
 *   1. process.env.PERPLEXITY_API_KEY
 *   2. ~/.automaton/keys.json  (perplexityApiKey)
 *   3. ~/.automaton/automaton.json  (perplexityApiKey)
 */

import { createLogger } from "../observability/logger.js";

const logger = createLogger("tools.web-search");

// ─── Types ──────────────────────────────────────────────────────

export interface WebSearchResult {
  answer: string;
  sources: string[];
  query: string;
  ok: boolean;
  error?: string;
}

/** Shape of the relevant bits of a Perplexity chat completion response. */
interface PerplexityResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  citations?: string[];
}

// ─── Configuration ──────────────────────────────────────────────

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_MODEL = "sonar";
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** Minimum interval between requests (basic rate-limit awareness). */
const MIN_REQUEST_INTERVAL_MS = 1_000;
let lastRequestTimestamp = 0;

// ─── API Key Resolution ─────────────────────────────────────────

/**
 * Resolve the Perplexity API key from available sources.
 * Returns undefined if no key is configured.
 */
export function resolvePerplexityApiKey(): string | undefined {
  // 1. Environment variable (highest priority)
  if (process.env.PERPLEXITY_API_KEY) {
    return process.env.PERPLEXITY_API_KEY;
  }

  // 2-3. keys.json and automaton.json (loaded via auth module)
  try {
    // Dynamic import to avoid circular dependencies at module level.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const automatonDir =
      process.env.AUTOMATON_DIR ||
      path.join(process.env.HOME || process.env.USERPROFILE || "~", ".automaton");

    // Try keys.json first
    const keysPath = path.join(automatonDir, "keys.json");
    if (fs.existsSync(keysPath)) {
      try {
        const keys = JSON.parse(fs.readFileSync(keysPath, "utf-8"));
        if (keys.perplexityApiKey) return keys.perplexityApiKey;
      } catch {
        // fall through
      }
    }

    // Fall back to automaton.json
    const configPath = path.join(automatonDir, "automaton.json");
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (config.perplexityApiKey) return config.perplexityApiKey;
      } catch {
        // fall through
      }
    }
  } catch {
    // Filesystem access failed — not critical
  }

  return undefined;
}

// ─── Core Search Function ───────────────────────────────────────

/**
 * Search the web using Perplexity AI.
 *
 * @param query   - The search query (required)
 * @param context - Optional additional context to refine the search
 * @returns WebSearchResult with answer, sources, and status
 */
export async function webSearch(
  query: string,
  context?: string,
): Promise<WebSearchResult> {
  const apiKey = resolvePerplexityApiKey();

  if (!apiKey) {
    return {
      answer: "",
      sources: [],
      query,
      ok: false,
      error:
        "No Perplexity API key configured. Set PERPLEXITY_API_KEY env var, " +
        "or add perplexityApiKey to ~/.automaton/keys.json or ~/.automaton/automaton.json.",
    };
  }

  // Basic rate limiting
  const now = Date.now();
  const elapsed = now - lastRequestTimestamp;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    const waitMs = MIN_REQUEST_INTERVAL_MS - elapsed;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestTimestamp = Date.now();

  // Build the user message, incorporating optional context
  const userContent = context
    ? `Context: ${context}\n\nQuery: ${query}`
    : query;

  const body = JSON.stringify({
    model: PERPLEXITY_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a concise market research assistant. Provide factual, " +
          "data-driven answers with specific numbers when available.",
      },
      {
        role: "user",
        content: userContent,
      },
    ],
    max_tokens: MAX_TOKENS,
  });

  logger.debug("Perplexity search request", { query, hasContext: !!context });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(PERPLEXITY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const status = response.status;
      let errorDetail = `HTTP ${status}`;

      // Rate limit handling
      if (status === 429) {
        errorDetail = "Rate limited by Perplexity API. Try again later.";
        logger.warn("Perplexity rate limited", { status });
      } else if (status === 401 || status === 403) {
        errorDetail =
          "Perplexity API key is invalid or expired. Check your configuration.";
        logger.error("Perplexity auth failed", undefined, { status });
      } else {
        try {
          const errBody = await response.text();
          errorDetail = `HTTP ${status}: ${errBody.slice(0, 200)}`;
        } catch {
          // use default
        }
        logger.error("Perplexity request failed", undefined, {
          status,
          errorDetail,
        });
      }

      return {
        answer: "",
        sources: [],
        query,
        ok: false,
        error: errorDetail,
      };
    }

    const data = (await response.json()) as PerplexityResponse;

    const answer = data.choices?.[0]?.message?.content ?? "";
    const sources = data.citations ?? [];

    logger.info("Perplexity search completed", {
      query: query.slice(0, 80),
      answerLength: answer.length,
      sourceCount: sources.length,
    });

    return {
      answer,
      sources,
      query,
      ok: true,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    const isTimeout =
      message.includes("aborted") || message.includes("abort");

    logger.error(
      isTimeout ? "Perplexity request timed out" : "Perplexity request error",
      err instanceof Error ? err : undefined,
      { query: query.slice(0, 80) },
    );

    return {
      answer: "",
      sources: [],
      query,
      ok: false,
      error: isTimeout
        ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Request failed: ${message}`,
    };
  }
}
