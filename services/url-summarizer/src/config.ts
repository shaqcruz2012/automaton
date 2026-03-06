/**
 * URL Summarizer Configuration
 *
 * All configuration is environment-driven with sane defaults.
 * No config file needed for basic operation.
 */

export interface ServiceConfig {
  /** HTTP server port */
  readonly port: number;
  /** Service version */
  readonly version: string;
  /** LLM provider base URL (OpenAI-compatible) */
  readonly llmBaseUrl: string;
  /** LLM API key */
  readonly llmApiKey: string;
  /** Model to use for summarization */
  readonly llmModel: string;
  /** Max tokens for LLM response */
  readonly llmMaxTokens: number;
  /** Path to API keys data file */
  readonly apiKeysPath: string;
  /** Free tier daily limit */
  readonly freeTierDailyLimit: number;
  /** Request timeout for URL fetching (ms) */
  readonly fetchTimeoutMs: number;
  /** Max content length to process (chars) */
  readonly maxContentChars: number;
  /** Log level */
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export interface PricingTier {
  readonly name: string;
  readonly monthlyLimit: number;
  readonly pricePerCall: number;
  readonly monthlyPrice: number;
}

export const PRICING_TIERS: readonly PricingTier[] = [
  { name: "free", monthlyLimit: 25, pricePerCall: 0, monthlyPrice: 0 }, // daily limit (25/day), displayed as monthlyLimit for schema consistency
  { name: "starter", monthlyLimit: 1_000, pricePerCall: 0.01, monthlyPrice: 9 },
  { name: "pro", monthlyLimit: 10_000, pricePerCall: 0.008, monthlyPrice: 49 },
  { name: "scale", monthlyLimit: 100_000, pricePerCall: 0.005, monthlyPrice: 299 },
] as const;

export function loadConfig(): ServiceConfig {
  return {
    port: intEnv("URL_SUMMARIZER_PORT", 9003),
    version: "1.0.0",
    llmBaseUrl: strEnv("LLM_BASE_URL", "https://api.mistral.ai/v1"),
    llmApiKey: strEnv("LLM_API_KEY", strEnv("MISTRAL_API_KEY", "")),
    llmModel: strEnv("LLM_MODEL", "mistral-small-latest"),
    llmMaxTokens: intEnv("LLM_MAX_TOKENS", 1024),
    apiKeysPath: strEnv("API_KEYS_PATH", "./data/api-keys.json"),
    freeTierDailyLimit: intEnv("FREE_TIER_DAILY_LIMIT", 25),
    fetchTimeoutMs: intEnv("FETCH_TIMEOUT_MS", 15_000),
    maxContentChars: intEnv("MAX_CONTENT_CHARS", 50_000),
    logLevel: strEnv("LOG_LEVEL", "info") as ServiceConfig["logLevel"],
  };
}

function strEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function intEnv(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
