/**
 * Social Client Factory Tests
 *
 * Tests createSocialClient adapter selection based on env vars,
 * priority ordering, and no-op fallback behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the logger so it doesn't pollute test output
vi.mock("../observability/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock dynamic imports for telegram and twitter adapters
const mockTelegramClient = {
  send: vi.fn().mockResolvedValue({ id: "tg-123" }),
  poll: vi.fn().mockResolvedValue({ messages: [{ id: "m1", from: "user", to: "bot", content: "hi" }] }),
  unreadCount: vi.fn().mockResolvedValue(5),
};

const mockTwitterClient = {
  send: vi.fn().mockResolvedValue({ id: "tw-456" }),
  poll: vi.fn().mockResolvedValue({ messages: [{ id: "m2", from: "@user", to: "@bot", content: "hello" }] }),
  unreadCount: vi.fn().mockResolvedValue(3),
};

vi.mock("./telegram.js", () => ({
  createTelegramClient: vi.fn(() => mockTelegramClient),
}));

vi.mock("./twitter.js", () => ({
  createTwitterClient: vi.fn(() => mockTwitterClient),
}));

// We need to adjust the mock paths since tests run from __tests__ dir
// but the module under test imports from relative paths.
// vitest resolves mocks relative to the source file, so we mock from social/ perspective.
vi.mock("../social/telegram.js", () => ({
  createTelegramClient: vi.fn(() => mockTelegramClient),
}));

vi.mock("../social/twitter.js", () => ({
  createTwitterClient: vi.fn(() => mockTwitterClient),
}));

import { createSocialClient } from "../social/client.js";

// Fake account for the factory signature
const fakeAccount = {} as import("viem").PrivateKeyAccount;

describe("createSocialClient", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all social env vars
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TWITTER_BEARER_TOKEN;
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_API_SECRET;
    delete process.env.TWITTER_ACCESS_TOKEN;
    delete process.env.TWITTER_ACCESS_SECRET;
    delete process.env.TWITTER_USERNAME;

    // Reset mocks between tests
    mockTelegramClient.send.mockClear();
    mockTelegramClient.poll.mockClear();
    mockTelegramClient.unreadCount.mockClear();
    mockTwitterClient.send.mockClear();
    mockTwitterClient.poll.mockClear();
    mockTwitterClient.unreadCount.mockClear();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // ── 1. Telegram adapter when TELEGRAM_BOT_TOKEN is set ──────────
  it("returns Telegram adapter when TELEGRAM_BOT_TOKEN is set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tg-test-token-123";

    const client = createSocialClient("http://relay", fakeAccount);

    const result = await client.send("chat-1", "hello");
    expect(result).toEqual({ id: "tg-123" });

    const pollResult = await client.poll();
    expect(pollResult.messages).toHaveLength(1);

    const count = await client.unreadCount();
    expect(count).toBe(5);
  });

  // ── 2. Twitter adapter when all required vars are set ───────────
  it("returns Twitter adapter when TWITTER_BEARER_TOKEN + TWITTER_API_KEY + TWITTER_USERNAME are set", async () => {
    process.env.TWITTER_BEARER_TOKEN = "tw-bearer";
    process.env.TWITTER_API_KEY = "tw-api-key";
    process.env.TWITTER_USERNAME = "testuser";

    const client = createSocialClient("http://relay", fakeAccount);

    const result = await client.send("@someone", "tweet");
    expect(result).toEqual({ id: "tw-456" });

    const pollResult = await client.poll();
    expect(pollResult.messages).toHaveLength(1);

    const count = await client.unreadCount();
    expect(count).toBe(3);
  });

  // ── 3. Skips Twitter when TWITTER_USERNAME is missing ───────────
  it("skips Twitter when TWITTER_USERNAME is missing despite having API keys", async () => {
    process.env.TWITTER_BEARER_TOKEN = "tw-bearer";
    process.env.TWITTER_API_KEY = "tw-api-key";
    // TWITTER_USERNAME intentionally not set

    const client = createSocialClient("http://relay", fakeAccount);

    // Should fall through to no-op
    const result = await client.send("@someone", "tweet");
    expect(result).toEqual({ id: "noop" });
  });

  // ── 4. No-op adapter when no env vars are set ──────────────────
  it("returns no-op adapter when no env vars are set", async () => {
    const client = createSocialClient("http://relay", fakeAccount);

    const sendResult = await client.send("someone", "hello");
    expect(sendResult).toEqual({ id: "noop" });

    const pollResult = await client.poll();
    expect(pollResult).toEqual({ messages: [] });

    const count = await client.unreadCount();
    expect(count).toBe(0);
  });

  // ── 5. Telegram takes priority over Twitter ─────────────────────
  it("Telegram takes priority over Twitter when both are configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tg-test-token-123";
    process.env.TWITTER_BEARER_TOKEN = "tw-bearer";
    process.env.TWITTER_API_KEY = "tw-api-key";
    process.env.TWITTER_USERNAME = "testuser";

    const client = createSocialClient("http://relay", fakeAccount);

    const result = await client.send("chat-1", "hello");
    // Should use Telegram (tg-123), not Twitter (tw-456)
    expect(result).toEqual({ id: "tg-123" });
    expect(mockTelegramClient.send).toHaveBeenCalledOnce();
    expect(mockTwitterClient.send).not.toHaveBeenCalled();
  });

  // ── 6. No-op send returns { id: "noop" } ───────────────────────
  it("no-op send returns { id: 'noop' }", async () => {
    const client = createSocialClient("http://relay", fakeAccount);
    const result = await client.send("to", "content", "replyTo");
    expect(result).toEqual({ id: "noop" });
  });

  // ── 7. No-op poll returns { messages: [] } ─────────────────────
  it("no-op poll returns { messages: [] }", async () => {
    const client = createSocialClient("http://relay", fakeAccount);
    const result = await client.poll("cursor", 10);
    expect(result).toEqual({ messages: [] });
  });

  // ── 8. No-op unreadCount returns 0 ─────────────────────────────
  it("no-op unreadCount returns 0", async () => {
    const client = createSocialClient("http://relay", fakeAccount);
    const result = await client.unreadCount();
    expect(result).toBe(0);
  });
});
