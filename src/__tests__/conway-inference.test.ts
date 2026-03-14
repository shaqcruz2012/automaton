/**
 * Tests for conway/inference.ts — null guards and edge cases
 *
 * Covers:
 * 1. Throws when choice.message is undefined
 * 2. Uses ?? (not ||) for token counts — 0 is valid
 * 3. resp.text() failure in error path doesn't mask original error
 * 4. opts.maxTokens=0 is preserved (not replaced by default)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInferenceClient } from "../conway/inference.js";

// ─── Helpers ────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-type": "application/json" }),
  });
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return createInferenceClient({
    apiUrl: "https://test.local",
    apiKey: "test-key",
    defaultModel: "test-model",
    maxTokens: 1024,
    ...overrides,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Tests ──────────────────────────────────────────────────────

describe("conway inference null guards", () => {
  describe("choice.message undefined", () => {
    it("throws when choice.message is undefined", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "resp-1",
          model: "test-model",
          choices: [{ finish_reason: "stop" }], // no message field
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );

      const client = makeClient();
      await expect(
        client.chat([{ role: "user", content: "hello" }]),
      ).rejects.toThrow(/no message/i);
    });

    it("throws when choices array is empty", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "resp-2",
          model: "test-model",
          choices: [],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      );

      const client = makeClient();
      await expect(
        client.chat([{ role: "user", content: "hello" }]),
      ).rejects.toThrow(/no completion choice/i);
    });
  });

  describe("token counts use ?? (0 is valid)", () => {
    it("preserves 0 token counts instead of replacing with defaults", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "resp-3",
          model: "test-model",
          choices: [
            {
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        }),
      );

      const client = makeClient();
      const result = await client.chat([{ role: "user", content: "hello" }]);

      // If || were used instead of ??, these would be replaced with fallback values.
      // With ??, 0 is preserved as a valid count.
      expect(result.usage.promptTokens).toBe(0);
      expect(result.usage.completionTokens).toBe(0);
      expect(result.usage.totalTokens).toBe(0);
    });

    it("falls back to 0 when usage is entirely missing", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "resp-4",
          model: "test-model",
          choices: [
            {
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
          // no usage field at all
        }),
      );

      const client = makeClient();
      const result = await client.chat([{ role: "user", content: "hello" }]);

      expect(result.usage.promptTokens).toBe(0);
      expect(result.usage.completionTokens).toBe(0);
      expect(result.usage.totalTokens).toBe(0);
    });
  });

  describe("resp.text() failure in error path", () => {
    it("does not mask original HTTP error when resp.text() throws", async () => {
      const badResponse = {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.reject(new Error("body stream already consumed")),
        json: () => Promise.reject(new Error("body stream already consumed")),
        headers: new Headers(),
      } as unknown as Response;

      globalThis.fetch = vi.fn().mockResolvedValue(badResponse);

      const client = makeClient();
      const err = await client
        .chat([{ role: "user", content: "hello" }])
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      // The error message should contain the HTTP status, not be masked
      // by the text() read failure. The code uses .catch(() => "(body unreadable)")
      // so it should gracefully handle the text() failure.
      expect(err.message).toContain("500");
      expect(err.message).toContain("body unreadable");
    });

    it("includes response body text when resp.text() succeeds", async () => {
      const errorBody = "rate limit exceeded";
      const badResponse = new Response(errorBody, {
        status: 429,
        statusText: "Too Many Requests",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(badResponse);

      const client = makeClient();
      const err = await client
        .chat([{ role: "user", content: "hello" }])
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("429");
      expect(err.message).toContain("rate limit exceeded");
    });
  });

  describe("opts.maxTokens=0 is preserved", () => {
    it("sends maxTokens=0 in request body when explicitly set", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(200, {
          id: "resp-5",
          model: "test-model",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      });

      const client = makeClient({ maxTokens: 4096 });
      await client.chat([{ role: "user", content: "hello" }], {
        maxTokens: 0,
      });

      expect(capturedBody).not.toBeNull();
      // opts.maxTokens=0 should be preserved via ?? — not replaced by the default 4096
      // If || were used: 0 || 4096 = 4096 (wrong)
      // With ??:          0 ?? 4096 = 0     (correct)
      expect(capturedBody!.max_tokens).toBe(0);
    });

    it("uses default maxTokens when opts.maxTokens is undefined", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(200, {
          id: "resp-6",
          model: "test-model",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      });

      const client = makeClient({ maxTokens: 4096 });
      await client.chat([{ role: "user", content: "hello" }]);

      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.max_tokens).toBe(4096);
    });
  });
});
