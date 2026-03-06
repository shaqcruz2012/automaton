/**
 * Summarization Pipeline
 *
 * Orchestrates the full flow: URL fetch → content extraction → LLM summarization.
 * Handles all error cases with structured error codes.
 */

import type { ServiceConfig } from "./config.js";
import type { SummarizeRequest, SummarizeResponse, DetailLevel } from "./types.js";
import { extractContent } from "./extractor.js";
import { summarizeText, LlmError } from "./summarizer.js";

export type PipelineResult =
  | { readonly ok: true; readonly data: SummarizeResponse }
  | { readonly ok: false; readonly error: string; readonly code: string };

/**
 * Run the full summarization pipeline for a URL.
 */
export async function runPipeline(
  config: ServiceConfig,
  request: SummarizeRequest,
  requestId: string,
): Promise<PipelineResult> {
  const startMs = Date.now();
  const detailLevel: DetailLevel = request.detail_level ?? "medium";
  const language = request.language ?? "English";

  // Step 1: Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return { ok: false, error: "Only http and https URLs are supported", code: "INVALID_URL" };
    }
  } catch {
    return { ok: false, error: "Invalid URL format", code: "INVALID_URL" };
  }

  // Step 1b: Block private/internal addresses (SSRF prevention)
  if (isPrivateHost(parsedUrl.hostname)) {
    return { ok: false, error: "Private/internal URLs are not allowed", code: "INVALID_URL" };
  }

  // Step 2: Fetch URL content
  let html: string;
  try {
    html = await fetchUrl(parsedUrl.toString(), config.fetchTimeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("timeout") || message.includes("abort")) {
      return { ok: false, error: "URL fetch timed out", code: "FETCH_TIMEOUT" };
    }
    if (message.includes("ENOTFOUND") || message.includes("DNS")) {
      return { ok: false, error: "Domain not found", code: "DNS_ERROR" };
    }
    if (message.includes("403") || message.includes("Forbidden")) {
      return { ok: false, error: "Access denied (403 Forbidden)", code: "ACCESS_DENIED" };
    }
    if (message.includes("paywall") || message.includes("subscription")) {
      return { ok: false, error: "Content behind paywall", code: "PAYWALL" };
    }

    return { ok: false, error: `Failed to fetch URL: ${message.slice(0, 200)}`, code: "FETCH_ERROR" };
  }

  // Step 3: Check content type - reject non-HTML
  if (!looksLikeHtml(html)) {
    return { ok: false, error: "URL does not return HTML content", code: "NOT_HTML" };
  }

  // Step 4: Extract readable content
  const extracted = extractContent(html);

  if (extracted.wordCount < 10) {
    return { ok: false, error: "Could not extract meaningful content from URL", code: "NO_CONTENT" };
  }

  // Step 5: Truncate if too long
  const text = extracted.text.length > config.maxContentChars
    ? extracted.text.slice(0, config.maxContentChars)
    : extracted.text;

  // Step 6: Summarize via LLM
  try {
    const result = await summarizeText(config, text, {
      detailLevel,
      title: extracted.title,
      language,
    });

    const latencyMs = Date.now() - startMs;

    return {
      ok: true,
      data: {
        title: extracted.title,
        summary: result.summary,
        key_points: result.keyPoints,
        word_count: extracted.wordCount,
        source_url: request.url,
        request_id: requestId,
        latency_ms: latencyMs,
      },
    };
  } catch (err) {
    if (err instanceof LlmError) {
      return { ok: false, error: err.message, code: err.code };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Summarization failed: ${message.slice(0, 200)}`, code: "SUMMARIZATION_ERROR" };
  }
}

/** Fetch a URL and return its HTML content */
async function fetchUrl(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "DatchiBot/1.0 (URL Summarizer; +https://datchi.app)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/pdf")) {
    throw new Error("PDF content not supported");
  }

  return response.text();
}

/** Block private/internal IP addresses to prevent SSRF */
function isPrivateHost(hostname: string): boolean {
  const BLOCKED = [
    /^localhost$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^\[::1\]$/,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./, // link-local / cloud metadata
    /^fd[0-9a-f]{2}:/i, // IPv6 ULA
  ];
  return BLOCKED.some((re) => re.test(hostname));
}

/** Quick heuristic: does the response look like HTML? */
function looksLikeHtml(content: string): boolean {
  const trimmed = content.trimStart().slice(0, 500).toLowerCase();
  return (
    trimmed.includes("<!doctype html") ||
    trimmed.includes("<html") ||
    trimmed.includes("<head") ||
    trimmed.includes("<body")
  );
}
