/**
 * URL Summarizer – validateUrl SSRF prevention tests
 *
 * Covers protocol enforcement, localhost blocking, and private/internal
 * IP range rejection to prevent Server-Side Request Forgery.
 */

import { describe, it, expect, vi } from "vitest";

// Mock heavy dependencies so the module can be imported without OOM
vi.mock("better-sqlite3", () => ({ default: {} }));
vi.mock("ulid", () => ({ ulid: () => "01TEST" }));
vi.mock("../../local/accounting.js", () => ({
  logRevenue: vi.fn(),
  logExpense: vi.fn(),
}));
vi.mock("../../observability/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { validateUrl } from "../skills/revenue/url-summarizer.js";

// ─── Helpers ────────────────────────────────────────────────────

/** Assert that validateUrl does NOT throw for the given URL */
function expectAccepted(url: string): void {
  expect(() => validateUrl(url)).not.toThrow();
}

/** Assert that validateUrl throws with a message matching `pattern` */
function expectBlocked(url: string, pattern: RegExp): void {
  expect(() => validateUrl(url)).toThrow(pattern);
}

// ─── Tests ──────────────────────────────────────────────────────

describe("validateUrl", () => {
  // ── Accepted protocols ──────────────────────────────────────

  it("accepts valid https URLs", () => {
    expectAccepted("https://example.com");
    expectAccepted("https://example.com/path?q=1#frag");
  });

  it("accepts valid http URLs", () => {
    expectAccepted("http://example.com");
    expectAccepted("http://example.com:8080/api");
  });

  // ── Rejected protocols ──────────────────────────────────────

  it("rejects file:// protocol", () => {
    expectBlocked("file:///etc/passwd", /Blocked URL protocol/);
  });

  it("rejects ftp:// protocol", () => {
    expectBlocked("ftp://files.example.com/data.csv", /Blocked URL protocol/);
  });

  // ── Localhost blocking ──────────────────────────────────────

  it("blocks localhost", () => {
    expectBlocked("http://localhost/admin", /localhost/);
    expectBlocked("https://localhost:3000", /localhost/);
  });

  it("blocks 127.0.0.1", () => {
    expectBlocked("http://127.0.0.1/secret", /private\/internal IP/);
    expectBlocked("http://127.0.0.1:9003/health", /private\/internal IP/);
  });

  // ── Private IP ranges ──────────────────────────────────────

  it("blocks 10.x.x.x (10.0.0.0/8)", () => {
    expectBlocked("http://10.0.0.1/api", /private\/internal IP/);
    expectBlocked("http://10.255.255.255", /private\/internal IP/);
  });

  it("blocks 172.16.x.x (172.16.0.0/12)", () => {
    expectBlocked("http://172.16.0.1", /private\/internal IP/);
    expectBlocked("http://172.31.255.255", /private\/internal IP/);
  });

  it("blocks 192.168.x.x (192.168.0.0/16)", () => {
    expectBlocked("http://192.168.0.1", /private\/internal IP/);
    expectBlocked("http://192.168.255.255", /private\/internal IP/);
  });

  it("blocks 169.254.x.x (link-local / cloud metadata)", () => {
    expectBlocked("http://169.254.169.254/latest/meta-data", /private\/internal IP/);
    expectBlocked("http://169.254.0.1", /private\/internal IP/);
  });

  it("blocks 0.0.0.0", () => {
    expectBlocked("http://0.0.0.0", /private\/internal IP/);
    expectBlocked("http://0.0.0.0:8080", /private\/internal IP/);
  });

  // ── Invalid URLs ────────────────────────────────────────────

  it("rejects invalid URLs", () => {
    expectBlocked("not-a-url", /Invalid URL/);
    expectBlocked("", /Invalid URL/);
    expectBlocked("://missing-protocol", /Invalid URL/);
  });

  // ── Public IPs allowed ──────────────────────────────────────

  it("accepts public IPs like 8.8.8.8", () => {
    expectAccepted("http://8.8.8.8");
    expectAccepted("https://1.1.1.1/dns-query");
  });
});
