/**
 * Twitter/X Social Adapter
 *
 * Implements SocialClientInterface using the Twitter API v2.
 * Uses raw HTTP calls (no npm packages) with OAuth 2.0 Bearer token.
 *
 * Setup: Get API keys at developer.x.com, set these env vars:
 *   TWITTER_BEARER_TOKEN — for reading (app-level)
 *   TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET — for posting (user-level OAuth 1.0a)
 */

import * as crypto from "node:crypto";
import type { SocialClientInterface, InboxMessage } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("social.twitter");

const TWITTER_API_BASE = "https://api.twitter.com/2/";
const TWITTER_REQUEST_TIMEOUT_MS = 30_000;

// ─── Configuration ──────────────────────────────────────────────

export interface TwitterConfig {
  bearerToken: string;
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
  username: string; // bot's twitter handle without @
}

// ─── OAuth 1.0a Signature ───────────────────────────────────────

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

interface OAuthParams {
  method: string;
  url: string;
  bodyParams?: Record<string, string>;
  config: TwitterConfig;
}

function buildOAuthSignature(params: OAuthParams): Record<string, string> {
  const { method, url, bodyParams, config } = params;

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.apiKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: generateTimestamp(),
    oauth_token: config.accessToken,
    oauth_version: "1.0",
  };

  // Collect all parameters (oauth + body) for the signature base
  const allParams: Record<string, string> = { ...oauthParams };
  if (bodyParams) {
    for (const [k, v] of Object.entries(bodyParams)) {
      allParams[k] = v;
    }
  }

  // Sort parameters alphabetically by key
  const sortedKeys = Object.keys(allParams).sort();
  const parameterString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");

  // Construct the signature base string
  const signatureBase = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(parameterString),
  ].join("&");

  // Create the signing key
  const signingKey = `${percentEncode(config.apiSecret)}&${percentEncode(config.accessSecret)}`;

  // Generate HMAC-SHA1 signature
  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");

  return { ...oauthParams, oauth_signature: signature };
}

function buildAuthorizationHeader(oauthParams: Record<string, string>): string {
  const entries = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ");
  return `OAuth ${entries}`;
}

// ─── Rate Limit Handling ────────────────────────────────────────

interface RateLimitState {
  readonly limited: boolean;
  readonly resetsAt: number; // epoch ms, 0 if not limited
}

function createRateLimitState(limited: boolean, resetsAt: number): RateLimitState {
  return Object.freeze({ limited, resetsAt });
}

const INITIAL_RATE_LIMIT: RateLimitState = createRateLimitState(false, 0);

function checkRateLimit(state: RateLimitState): { blocked: boolean; updatedState: RateLimitState } {
  if (!state.limited) {
    return { blocked: false, updatedState: state };
  }
  if (Date.now() >= state.resetsAt) {
    return { blocked: false, updatedState: INITIAL_RATE_LIMIT };
  }
  return { blocked: true, updatedState: state };
}

function parseRateLimitHeaders(
  headers: Headers,
  currentState: RateLimitState,
): RateLimitState {
  const remaining = headers.get("x-rate-limit-remaining");
  const resetHeader = headers.get("x-rate-limit-reset");

  if (remaining !== null && parseInt(remaining, 10) === 0 && resetHeader) {
    const resetsAt = parseInt(resetHeader, 10) * 1000;
    logger.warn("Rate limit exhausted, pausing requests", {
      resetsAt: new Date(resetsAt).toISOString(),
    });
    return createRateLimitState(true, resetsAt);
  }
  return currentState;
}

// ─── API Helpers ────────────────────────────────────────────────

async function twitterGet(
  path: string,
  queryParams: Record<string, string>,
  bearerToken: string,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const queryString = Object.entries(queryParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `${TWITTER_API_BASE}${path}${queryString ? `?${queryString}` : ""}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(TWITTER_REQUEST_TIMEOUT_MS),
  });

  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body, headers: response.headers };
}

async function twitterPost(
  path: string,
  payload: Record<string, unknown>,
  config: TwitterConfig,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const url = `${TWITTER_API_BASE}${path}`;

  const oauthParams = buildOAuthSignature({
    method: "POST",
    url,
    config,
  });

  const authHeader = buildAuthorizationHeader(oauthParams);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TWITTER_REQUEST_TIMEOUT_MS),
  });

  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body, headers: response.headers };
}

// ─── User ID Resolution ─────────────────────────────────────────

async function resolveUserId(
  username: string,
  bearerToken: string,
): Promise<string | null> {
  const { status, body } = await twitterGet(
    `users/by/username/${encodeURIComponent(username)}`,
    {},
    bearerToken,
  );

  if (status === 200 && body && typeof body === "object") {
    const data = body as { data?: { id?: string } };
    return data.data?.id ?? null;
  }

  logger.error("Failed to resolve user ID", undefined, { username, status });
  return null;
}

// ─── Tweet → InboxMessage Mapper ────────────────────────────────

interface TweetData {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
}

function tweetToInboxMessage(tweet: TweetData, botUsername: string): InboxMessage {
  const replyToTweet = tweet.referenced_tweets?.find(
    (ref) => ref.type === "replied_to",
  );

  return {
    id: tweet.id,
    from: tweet.author_id ?? "unknown",
    to: botUsername,
    content: tweet.text,
    signedAt: tweet.created_at ?? new Date().toISOString(),
    createdAt: tweet.created_at ?? new Date().toISOString(),
    replyTo: replyToTweet?.id,
  };
}

// ─── Client Implementation ──────────────────────────────────────

interface TwitterClientState {
  readonly userId: string | null;
  readonly lastSeenId: string | null;
  readonly readRateLimit: RateLimitState;
  readonly writeRateLimit: RateLimitState;
}

function createInitialState(): TwitterClientState {
  return Object.freeze({
    userId: null,
    lastSeenId: null,
    readRateLimit: INITIAL_RATE_LIMIT,
    writeRateLimit: INITIAL_RATE_LIMIT,
  });
}

function updateState(
  state: TwitterClientState,
  updates: Partial<TwitterClientState>,
): TwitterClientState {
  return Object.freeze({ ...state, ...updates });
}

export function createTwitterClient(
  config: TwitterConfig,
): SocialClientInterface {
  // Validate required config
  if (!config.bearerToken) {
    throw new Error("TwitterConfig.bearerToken is required");
  }
  if (!config.apiKey || !config.apiSecret) {
    throw new Error("TwitterConfig.apiKey and apiSecret are required");
  }
  if (!config.accessToken || !config.accessSecret) {
    throw new Error("TwitterConfig.accessToken and accessSecret are required");
  }
  if (!config.username) {
    throw new Error("TwitterConfig.username is required");
  }

  let state = createInitialState();

  async function ensureUserId(): Promise<string | null> {
    if (state.userId) {
      return state.userId;
    }
    const userId = await resolveUserId(config.username, config.bearerToken);
    if (userId) {
      state = updateState(state, { userId });
    }
    return userId;
  }

  // ─── send ───────────────────────────────────────────────────

  const send = async (
    _to: string,
    content: string,
    replyTo?: string,
  ): Promise<{ id: string }> => {
    const { blocked, updatedState } = checkRateLimit(state.writeRateLimit);
    state = updateState(state, { writeRateLimit: updatedState });

    if (blocked) {
      logger.warn("Write rate-limited, skipping tweet");
      return { id: "" };
    }

    const payload: Record<string, unknown> = { text: content };
    if (replyTo) {
      payload.reply = { in_reply_to_tweet_id: replyTo };
    }

    try {
      const { status, body, headers } = await twitterPost(
        "tweets",
        payload,
        config,
      );

      state = updateState(state, {
        writeRateLimit: parseRateLimitHeaders(headers, state.writeRateLimit),
      });

      if (status === 429) {
        logger.warn("Twitter API returned 429 on send, rate-limited");
        return { id: "" };
      }

      if (status === 201 && body && typeof body === "object") {
        const data = body as { data?: { id?: string } };
        const tweetId = data.data?.id ?? "";
        logger.info("Tweet posted", { tweetId, replyTo });
        return { id: tweetId };
      }

      logger.error("Unexpected response from Twitter POST /tweets", undefined, {
        status,
        body,
      });
      return { id: "" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to send tweet", undefined, { error: message });
      return { id: "" };
    }
  };

  // ─── poll ───────────────────────────────────────────────────

  const poll = async (
    cursor?: string,
    limit?: number,
  ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> => {
    const { blocked, updatedState } = checkRateLimit(state.readRateLimit);
    state = updateState(state, { readRateLimit: updatedState });

    if (blocked) {
      logger.warn("Read rate-limited, returning empty poll");
      return { messages: [] };
    }

    const userId = await ensureUserId();
    if (!userId) {
      logger.error("Cannot poll: user ID not resolved", undefined, {
        username: config.username,
      });
      return { messages: [] };
    }

    const queryParams: Record<string, string> = {
      "tweet.fields": "author_id,created_at,referenced_tweets,in_reply_to_user_id",
      max_results: String(Math.min(limit ?? 20, 100)),
    };

    // Use cursor (since_id) for pagination
    const sinceId = cursor ?? state.lastSeenId;
    if (sinceId) {
      queryParams.since_id = sinceId;
    }

    try {
      const { status, body, headers } = await twitterGet(
        `users/${userId}/mentions`,
        queryParams,
        config.bearerToken,
      );

      state = updateState(state, {
        readRateLimit: parseRateLimitHeaders(headers, state.readRateLimit),
      });

      if (status === 429) {
        logger.warn("Twitter API returned 429 on poll, rate-limited");
        return { messages: [] };
      }

      if (status !== 200 || !body || typeof body !== "object") {
        logger.error("Unexpected response from Twitter mentions endpoint", undefined, {
          status,
          body,
        });
        return { messages: [] };
      }

      const response = body as {
        data?: TweetData[];
        meta?: { newest_id?: string; next_token?: string; result_count?: number };
      };

      const tweets = response.data ?? [];
      if (tweets.length === 0) {
        return { messages: [] };
      }

      const messages = tweets.map((tweet) =>
        tweetToInboxMessage(tweet, config.username),
      );

      // Track the newest tweet ID for future polls
      const newestId = response.meta?.newest_id ?? tweets[0]?.id;
      if (newestId) {
        state = updateState(state, { lastSeenId: newestId });
      }

      const nextCursor = newestId ?? undefined;

      logger.info("Polled Twitter mentions", {
        count: messages.length,
        newestId,
      });

      return { messages, nextCursor };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to poll Twitter mentions", undefined, { error: message });
      return { messages: [] };
    }
  };

  // ─── unreadCount ────────────────────────────────────────────

  const unreadCount = async (): Promise<number> => {
    const { blocked, updatedState } = checkRateLimit(state.readRateLimit);
    state = updateState(state, { readRateLimit: updatedState });

    if (blocked) {
      logger.warn("Read rate-limited, returning 0 unread");
      return 0;
    }

    const userId = await ensureUserId();
    if (!userId) {
      return 0;
    }

    const queryParams: Record<string, string> = {
      max_results: "1",
    };

    if (state.lastSeenId) {
      queryParams.since_id = state.lastSeenId;
    }

    try {
      const { status, body, headers } = await twitterGet(
        `users/${userId}/mentions`,
        queryParams,
        config.bearerToken,
      );

      state = updateState(state, {
        readRateLimit: parseRateLimitHeaders(headers, state.readRateLimit),
      });

      if (status === 429) {
        logger.warn("Twitter API returned 429 on unreadCount");
        return 0;
      }

      if (status !== 200 || !body || typeof body !== "object") {
        return 0;
      }

      const response = body as {
        meta?: { result_count?: number };
      };

      return response.meta?.result_count ?? 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to fetch unread count", undefined, { error: message });
      return 0;
    }
  };

  logger.info("Twitter client created", { username: config.username });

  return { send, poll, unreadCount };
}
