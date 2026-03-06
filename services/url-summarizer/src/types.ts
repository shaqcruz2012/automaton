/**
 * URL Summarizer Types
 *
 * Request/response types for the summarization API.
 */

export type DetailLevel = "short" | "medium" | "long";

export interface SummarizeRequest {
  /** The URL to summarize */
  readonly url: string;
  /** Level of detail: short (~2 sentences), medium (~1 paragraph), long (~3 paragraphs) */
  readonly detail_level?: DetailLevel;
  /** Target language for the summary (default: English) */
  readonly language?: string;
}

export interface SummarizeResponse {
  /** Extracted page title */
  readonly title: string;
  /** Generated summary text */
  readonly summary: string;
  /** Key points extracted from the content */
  readonly key_points: readonly string[];
  /** Word count of the original content */
  readonly word_count: number;
  /** The source URL that was summarized */
  readonly source_url: string;
  /** Unique request ID for tracking */
  readonly request_id: string;
  /** Processing time in milliseconds */
  readonly latency_ms: number;
}

export interface ErrorResponse {
  readonly error: string;
  readonly code: string;
  readonly request_id: string;
  /** Remaining quota (if applicable) */
  readonly quota_remaining?: number;
}

export interface QuotaInfo {
  readonly tier: string;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly resets_at: string;
}

export interface ApiKeyRecord {
  readonly key: string;
  readonly tier: string;
  readonly created_at: string;
  readonly owner?: string;
  readonly enabled: boolean;
}

export interface UsageRecord {
  readonly key: string;
  /** Usage count in current period */
  count: number;
  /** Period start (ISO string) */
  period_start: string;
  /** Period type: "daily" for free, "monthly" for paid */
  period_type: "daily" | "monthly";
}

export interface HealthResponse {
  readonly status: "healthy" | "degraded";
  readonly version: string;
  readonly uptime_seconds: number;
  readonly port: number;
  readonly timestamp: string;
}

export interface ServiceDeclaration {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly port: number;
  readonly health_endpoint: string;
  readonly revenue_model: "pay-per-use" | "subscription" | "outcome-based";
  readonly price_per_call_usd: number;
  readonly success_kpi: string;
}
