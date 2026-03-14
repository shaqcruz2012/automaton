/**
 * Twitter Social Adapter Unit Tests
 *
 * Tests for createTwitterClient (sendMessage / poll paths) and
 * the internal buildOAuthSignature helper exposed via a re-export
 * shim below.  All network calls are mocked via vi.stubGlobal("fetch").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Module-level mock for observability/logger ───────────────────────────────
// vi.hoisted runs before vi.mock hoisting, so we can define the shared instance
// here and reference it safely inside the vi.mock factory.
const mockLoggerInstance = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../observability/logger.js", () => ({
  createLogger: () => mockLoggerInstance,
}));

import { createTwitterClient } from "../social/twitter.js";
import type { TwitterConfig } from "../social/twitter.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const BASE_CONFIG: TwitterConfig = {
  bearerToken: "test-bearer-token",
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
  accessToken: "test-access-token",
  accessSecret: "test-access-secret",
  username: "testbot",
};

/** Build a minimal Headers-like object that the adapter reads. */
function makeHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers(extra);
}

/** Build a mock Response-compatible object for vi.fn(). */
function mockResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: makeHeaders(extraHeaders),
    json: () => Promise.resolve(body),
  };
}

// ─── 1. Config Validation ────────────────────────────────────────────────────

describe("createTwitterClient — config validation", () => {
  it("throws when bearerToken is missing", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, bearerToken: "" }),
    ).toThrow("bearerToken is required");
  });

  it("throws when apiKey is missing", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, apiKey: "" }),
    ).toThrow("apiKey and apiSecret are required");
  });

  it("throws when apiSecret is missing", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, apiSecret: "" }),
    ).toThrow("apiKey and apiSecret are required");
  });

  it("throws when accessToken is missing", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, accessToken: "" }),
    ).toThrow("accessToken and accessSecret are required");
  });

  it("throws when accessSecret is missing", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, accessSecret: "" }),
    ).toThrow("accessToken and accessSecret are required");
  });

  it("throws when username is missing", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, username: "" }),
    ).toThrow("username is required");
  });

  it("returns a client object with send, poll, unreadCount when config is valid", () => {
    const client = createTwitterClient(BASE_CONFIG);
    expect(typeof client.send).toBe("function");
    expect(typeof client.poll).toBe("function");
    expect(typeof client.unreadCount).toBe("function");
  });
});

// ─── 2. OAuth Signature Construction ─────────────────────────────────────────
//
// buildOAuthSignature is not exported directly; we verify its observable
// side-effects by inspecting the Authorization header sent to fetch on
// a real POST call.

describe("OAuth 1.0a Authorization header", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("includes all required OAuth 1.0a fields in Authorization header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "tweet-abc" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("ignored", "Hello world");

    const callArgs = mockFetch.mock.calls[0];
    const authHeader: string = callArgs?.[1]?.headers?.Authorization ?? "";

    expect(authHeader).toMatch(/^OAuth /);
    expect(authHeader).toContain("oauth_consumer_key=");
    expect(authHeader).toContain("oauth_nonce=");
    expect(authHeader).toContain("oauth_signature_method=");
    expect(authHeader).toContain("oauth_timestamp=");
    expect(authHeader).toContain("oauth_token=");
    expect(authHeader).toContain("oauth_version=");
    expect(authHeader).toContain("oauth_signature=");
  });

  it("oauth_signature_method is HMAC-SHA1", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "tweet-abc" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("ignored", "Hello");

    const callArgs = mockFetch.mock.calls[0];
    const authHeader: string = callArgs?.[1]?.headers?.Authorization ?? "";
    expect(authHeader).toContain('oauth_signature_method="HMAC-SHA1"');
  });

  it("oauth_version is 1.0", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "tweet-abc" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("ignored", "Hello");

    const callArgs = mockFetch.mock.calls[0];
    const authHeader: string = callArgs?.[1]?.headers?.Authorization ?? "";
    expect(authHeader).toContain('oauth_version="1.0"');
  });

  it("uses the configured apiKey as oauth_consumer_key", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "tweet-xyz" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient({ ...BASE_CONFIG, apiKey: "MY-UNIQUE-KEY" });
    await client.send("ignored", "Hello");

    const callArgs = mockFetch.mock.calls[0];
    const authHeader: string = callArgs?.[1]?.headers?.Authorization ?? "";
    expect(authHeader).toContain("MY-UNIQUE-KEY");
  });

  it("two successive calls produce different nonces", async () => {
    const captured: string[] = [];
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)?.Authorization ?? "";
      const match = auth.match(/oauth_nonce="([^"]+)"/);
      if (match?.[1]) captured.push(match[1]);
      return Promise.resolve(mockResponse(201, { data: { id: "t" } }));
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("ignored", "First");
    await client.send("ignored", "Second");

    expect(captured).toHaveLength(2);
    expect(captured[0]).not.toBe(captured[1]);
  });
});

// ─── 3. send() — success path ────────────────────────────────────────────────

describe("TwitterClient.send — success path", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the tweet id on HTTP 201", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "tweet-123" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const result = await client.send("@someone", "Hello Twitter!");

    expect(result.id).toBe("tweet-123");
  });

  it("POSTs to the tweets endpoint with correct JSON body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "tweet-001" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("ignored", "Test content");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("tweets");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.text).toBe("Test content");
  });

  it("includes reply field when replyTo is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "reply-tweet" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("ignored", "Reply text", "parent-tweet-id");

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.reply).toEqual({ in_reply_to_tweet_id: "parent-tweet-id" });
  });

  it("does not include reply field when replyTo is omitted", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "t" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("ignored", "No reply");

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.reply).toBeUndefined();
  });
});

// ─── 4. send() — rate limit (429) ────────────────────────────────────────────

describe("TwitterClient.send — rate limit path", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns { id: '' } when the API responds with 429", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(429, { errors: [{ message: "Too Many Requests" }] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const result = await client.send("ignored", "Ratelimited tweet");

    expect(result.id).toBe("");
  });

  it("returns { id: '' } when write rate-limit state is active", async () => {
    // First call: returns a response that marks rate-limit exhausted via headers
    const rateLimitHeaders = {
      "x-rate-limit-remaining": "0",
      "x-rate-limit-reset": String(Math.floor((Date.now() + 60_000) / 1000)),
    };
    const mockFetch = vi
      .fn()
      // First call succeeds but headers signal exhaustion
      .mockResolvedValueOnce(
        mockResponse(201, { data: { id: "t1" } }, rateLimitHeaders),
      )
      // Second call should be blocked before reaching fetch
      .mockResolvedValueOnce(
        mockResponse(201, { data: { id: "t2" } }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("ignored", "First tweet");
    const result = await client.send("ignored", "Second tweet");

    // Second send is blocked; fetch should only have been called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.id).toBe("");
  });
});

// ─── 5. send() — network failure ─────────────────────────────────────────────

describe("TwitterClient.send — network failure", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns { id: '' } when fetch throws a network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network unreachable"));
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const result = await client.send("ignored", "Lost in transit");

    expect(result.id).toBe("");
  });

  it("does not throw — error is swallowed gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await expect(client.send("ignored", "boom")).resolves.toEqual({ id: "" });
  });
});

// ─── 6. poll() — success with messages ──────────────────────────────────────

describe("TwitterClient.poll — success with messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * poll() needs to resolve the bot's userId first via GET /users/by/username/:name,
   * then fetch /users/:id/mentions.
   */
  function setupPollFetch(
    tweets: object[],
    meta: object = { newest_id: "tweet-999", result_count: tweets.length },
  ) {
    return vi
      .fn()
      // First call: user-id resolution
      .mockResolvedValueOnce(
        mockResponse(200, { data: { id: "user-42" } }),
      )
      // Second call: mentions timeline
      .mockResolvedValueOnce(
        mockResponse(200, { data: tweets, meta }),
      );
  }

  it("returns an InboxMessage array mapped from tweet data", async () => {
    const mockFetch = setupPollFetch([
      {
        id: "tweet-1",
        text: "@testbot hello there",
        author_id: "user-999",
        created_at: "2024-01-01T10:00:00.000Z",
      },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.id).toBe("tweet-1");
    expect(msg.content).toBe("@testbot hello there");
    expect(msg.from).toBe("user-999");
    expect(msg.to).toBe("testbot");
    expect(msg.signedAt).toBe("2024-01-01T10:00:00.000Z");
    expect(msg.createdAt).toBe("2024-01-01T10:00:00.000Z");
  });

  it("returns a nextCursor equal to the newest_id from meta", async () => {
    const mockFetch = setupPollFetch(
      [{ id: "tweet-100", text: "hi", author_id: "u1" }],
      { newest_id: "tweet-100", result_count: 1 },
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { nextCursor } = await client.poll();

    expect(nextCursor).toBe("tweet-100");
  });

  it("maps referenced_tweets reply correctly to replyTo", async () => {
    const mockFetch = setupPollFetch([
      {
        id: "tweet-2",
        text: "@testbot replying",
        author_id: "user-111",
        created_at: "2024-01-02T08:00:00.000Z",
        referenced_tweets: [{ type: "replied_to", id: "parent-tweet-5" }],
      },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages[0]!.replyTo).toBe("parent-tweet-5");
  });

  it("replyTo is undefined when there are no referenced_tweets", async () => {
    const mockFetch = setupPollFetch([
      { id: "tweet-3", text: "ping", author_id: "u2" },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages[0]!.replyTo).toBeUndefined();
  });

  it("passes since_id query param when cursor is provided", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(200, { data: [], meta: { result_count: 0 } }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.poll("cursor-tweet-id-55");

    const mentionsCall = mockFetch.mock.calls[1];
    const mentionsUrl: string = mentionsCall?.[0] ?? "";
    expect(mentionsUrl).toContain("since_id=cursor-tweet-id-55");
  });

  it("respects the limit parameter via max_results", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(200, { data: [], meta: { result_count: 0 } }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.poll(undefined, 5);

    const mentionsCall = mockFetch.mock.calls[1];
    const mentionsUrl: string = mentionsCall?.[0] ?? "";
    expect(mentionsUrl).toContain("max_results=5");
  });
});

// ─── 7. poll() — empty result ────────────────────────────────────────────────

describe("TwitterClient.poll — empty result", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty messages array when data is absent", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(200, { meta: { result_count: 0 } }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages).toEqual([]);
  });

  it("returns empty messages array when data is an empty array", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(200, { data: [], meta: { result_count: 0 } }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages, nextCursor } = await client.poll();

    expect(messages).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });
});

// ─── 8. poll() — auth failure (401) ─────────────────────────────────────────

describe("TwitterClient.poll — auth failure", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty messages when user-id resolution returns 401", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(401, { errors: [{ message: "Unauthorized" }] }));
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages).toEqual([]);
  });

  it("returns empty messages when mentions endpoint returns 401", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(401, { errors: [{ message: "Unauthorized" }] }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages).toEqual([]);
  });

  it("returns empty messages when mentions endpoint returns 429", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(429, { errors: [{ message: "Too Many Requests" }] }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages).toEqual([]);
  });
});

// ─── 9. poll() — network failure ─────────────────────────────────────────────

describe("TwitterClient.poll — network failure", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty messages when fetch throws during user-id resolution", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("DNS failure"));
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages).toEqual([]);
  });

  it("returns empty messages when fetch throws during mentions request", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockRejectedValueOnce(new Error("Connection reset"));
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages).toEqual([]);
  });
});

// ─── 10. Message parsing edge cases ─────────────────────────────────────────

describe("InboxMessage mapping edge cases", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to 'unknown' when author_id is absent", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(200, {
          data: [{ id: "tweet-no-author", text: "Ghost tweet" }],
          meta: { newest_id: "tweet-no-author" },
        }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages[0]!.from).toBe("unknown");
  });

  it("uses current ISO timestamp when created_at is absent", async () => {
    const before = Date.now();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(200, {
          data: [{ id: "tweet-no-ts", text: "No timestamp", author_id: "u1" }],
          meta: { newest_id: "tweet-no-ts" },
        }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();
    const after = Date.now();

    const ts = new Date(messages[0]!.signedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("ignores non-replied_to referenced tweet types for replyTo", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(200, {
          data: [
            {
              id: "tweet-retweet",
              text: "RT something",
              author_id: "u5",
              referenced_tweets: [{ type: "retweeted", id: "original-1" }],
            },
          ],
          meta: { newest_id: "tweet-retweet" },
        }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const { messages } = await client.poll();

    expect(messages[0]!.replyTo).toBeUndefined();
  });

  it("caches userId across multiple poll calls", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValue(
        mockResponse(200, { data: [], meta: { result_count: 0 } }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.poll();
    await client.poll();
    await client.poll();

    // User-id resolution should only happen once
    const userResolutionCalls = mockFetch.mock.calls.filter((args: unknown[]) =>
      typeof args[0] === "string" && args[0].includes("users/by/username"),
    );
    expect(userResolutionCalls).toHaveLength(1);
  });
});

// ─── 11. unreadCount() ───────────────────────────────────────────────────────

describe("TwitterClient.unreadCount", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the result_count from meta", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(
        mockResponse(200, { meta: { result_count: 7 } }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const count = await client.unreadCount();

    expect(count).toBe(7);
  });

  it("returns 0 when the API returns 429", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockResolvedValueOnce(mockResponse(429, {}));
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const count = await client.unreadCount();

    expect(count).toBe(0);
  });

  it("returns 0 when fetch throws", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const count = await client.unreadCount();

    expect(count).toBe(0);
  });
});

// ─── 12. logger.error uses 3-arg signature (msg, undefined, context) ────────

describe("logger.error 3-arg signature", () => {
  beforeEach(() => {
    mockLoggerInstance.error.mockClear();
    mockLoggerInstance.warn.mockClear();
    mockLoggerInstance.info.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("send() calls logger.error with (msg, undefined, context) on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("someone", "hello");

    const errorCalls = mockLoggerInstance.error.mock.calls;
    const sendErrorCall = errorCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("Failed to send tweet"),
    );

    expect(sendErrorCall).toBeDefined();
    expect(sendErrorCall![0]).toBe("Failed to send tweet");
    expect(sendErrorCall![1]).toBeUndefined();
    expect(sendErrorCall![2]).toEqual({ error: "network down" });
  });

  it("poll() calls logger.error with (msg, undefined, context) when user ID resolution fails", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(404, { errors: [{ message: "not found" }] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.poll();

    const errorCalls = mockLoggerInstance.error.mock.calls;

    // resolveUserId logs: "Failed to resolve user ID"
    const resolveCall = errorCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("Failed to resolve user ID"),
    );
    expect(resolveCall).toBeDefined();
    expect(resolveCall![1]).toBeUndefined();
    expect(resolveCall![2]).toEqual(expect.objectContaining({ username: "testbot" }));

    // poll itself logs: "Cannot poll: user ID not resolved"
    const pollErrorCall = errorCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("Cannot poll"),
    );
    expect(pollErrorCall).toBeDefined();
    expect(pollErrorCall![1]).toBeUndefined();
    expect(pollErrorCall![2]).toEqual(expect.objectContaining({ username: "testbot" }));
  });

  it("send() calls logger.error with (msg, undefined, context) on unexpected status", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(500, { errors: [{ message: "Internal Server Error" }] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    await client.send("ignored", "some content");

    const errorCalls = mockLoggerInstance.error.mock.calls;
    const unexpectedCall = errorCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("Unexpected response"),
    );
    expect(unexpectedCall).toBeDefined();
    expect(unexpectedCall![1]).toBeUndefined();
    expect(unexpectedCall![2]).toEqual(expect.objectContaining({ status: 500 }));
  });
});

// ─── 13. Tweet length validation ────────────────────────────────────────────

describe("Tweet length validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects tweets longer than 280 characters (API returns error)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(403, { errors: [{ message: "Tweet body too long" }] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const longTweet = "a".repeat(281);
    const result = await client.send("someone", longTweet);

    expect(result.id).toBe("");

    // Verify the long content was sent in the request body
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.text).toBe(longTweet);
    expect(body.text.length).toBe(281);
  });

  it("accepts tweets of exactly 280 characters", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "tweet-280" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const tweet280 = "b".repeat(280);
    const result = await client.send("someone", tweet280);

    expect(result.id).toBe("tweet-280");

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.text).toBe(tweet280);
    expect(body.text.length).toBe(280);
  });

  it("accepts tweets shorter than 280 characters", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(201, { data: { id: "tweet-short" } }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const result = await client.send("someone", "Hello!");

    expect(result.id).toBe("tweet-short");
  });
});

// ─── 14. Empty tweet content rejection ──────────────────────────────────────

describe("Empty tweet content", () => {
  beforeEach(() => {
    mockLoggerInstance.error.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty id when API rejects empty tweet with 400", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(400, { errors: [{ message: "Tweet text is required" }] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);
    const result = await client.send("someone", "");

    expect(result.id).toBe("");

    // logger.error should have been called about unexpected response
    const errorCall = mockLoggerInstance.error.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("Unexpected response"),
    );
    expect(errorCall).toBeDefined();
  });
});

// ─── 15. Rate limit state set on 429 response ──────────────────────────────

describe("Rate limit state on 429", () => {
  beforeEach(() => {
    mockLoggerInstance.warn.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("blocks subsequent send() calls after 429 with rate limit headers", async () => {
    const resetEpochSec = Math.floor((Date.now() + 900_000) / 1000); // 15 min from now
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(429, { errors: [{ message: "Too Many Requests" }] }, {
          "x-rate-limit-remaining": "0",
          "x-rate-limit-reset": String(resetEpochSec),
        }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);

    // First send: 429 response sets rate limit state
    const result1 = await client.send("someone", "first");
    expect(result1.id).toBe("");

    // Second send: blocked before fetch is called
    const fetchCountAfterFirst = mockFetch.mock.calls.length;
    const result2 = await client.send("someone", "second");
    expect(result2.id).toBe("");
    expect(mockFetch.mock.calls.length).toBe(fetchCountAfterFirst);

    // Verify the warn about being rate-limited
    const blockedWarn = mockLoggerInstance.warn.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("Write rate-limited"),
    );
    expect(blockedWarn).toBeDefined();
  });

  it("blocks subsequent poll() calls after 429 with rate limit headers", async () => {
    const resetEpochSec = Math.floor((Date.now() + 900_000) / 1000);
    const mockFetch = vi
      .fn()
      // resolveUserId succeeds
      .mockResolvedValueOnce(mockResponse(200, { data: { id: "user-42" } }))
      // mentions endpoint returns 429
      .mockResolvedValueOnce(
        mockResponse(429, { errors: [{ message: "Too Many Requests" }] }, {
          "x-rate-limit-remaining": "0",
          "x-rate-limit-reset": String(resetEpochSec),
        }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwitterClient(BASE_CONFIG);

    const result1 = await client.poll();
    expect(result1.messages).toEqual([]);

    // Second poll: blocked without additional fetch calls
    const fetchCountAfterFirst = mockFetch.mock.calls.length;
    const result2 = await client.poll();
    expect(result2.messages).toEqual([]);
    expect(mockFetch.mock.calls.length).toBe(fetchCountAfterFirst);
  });
});

// ─── 16. Config validation — missing required fields ────────────────────────

describe("Config validation — missing required fields", () => {
  it("rejects config with empty bearerToken", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, bearerToken: "" }),
    ).toThrow("bearerToken is required");
  });

  it("rejects config with empty apiKey", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, apiKey: "" }),
    ).toThrow("apiKey and apiSecret are required");
  });

  it("rejects config with empty apiSecret", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, apiSecret: "" }),
    ).toThrow("apiKey and apiSecret are required");
  });

  it("rejects config with empty accessToken", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, accessToken: "" }),
    ).toThrow("accessToken and accessSecret are required");
  });

  it("rejects config with empty accessSecret", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, accessSecret: "" }),
    ).toThrow("accessToken and accessSecret are required");
  });

  it("rejects config with empty username", () => {
    expect(() =>
      createTwitterClient({ ...BASE_CONFIG, username: "" }),
    ).toThrow("username is required");
  });
});
