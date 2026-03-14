/**
 * Local Worker Security Tests
 *
 * Tests for the path traversal and sensitive-file guards in the local worker's
 * read_file and write_file tool handlers.
 *
 * The guards use path.resolve to normalize paths and then check the basename
 * against a blocklist of sensitive filenames and extensions.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { isSensitiveWorkerPath } from "../orchestration/local-worker.js";

// ─── read_file guards ──────────────────────────────────────────

describe("local worker read_file guards", () => {
  it("blocks wallet.json", () => {
    expect(isSensitiveWorkerPath("wallet.json")).toBe(true);
  });

  it("blocks .env", () => {
    expect(isSensitiveWorkerPath(".env")).toBe(true);
  });

  it("blocks .key files", () => {
    expect(isSensitiveWorkerPath("server.key")).toBe(true);
    expect(isSensitiveWorkerPath("tls.key")).toBe(true);
    expect(isSensitiveWorkerPath("/etc/ssl/private/myhost.key")).toBe(true);
  });

  it("blocks .pem files", () => {
    expect(isSensitiveWorkerPath("cert.pem")).toBe(true);
    expect(isSensitiveWorkerPath("private.pem")).toBe(true);
    expect(isSensitiveWorkerPath("/home/user/certs/ca.pem")).toBe(true);
  });

  it("blocks automaton.json", () => {
    expect(isSensitiveWorkerPath("automaton.json")).toBe(true);
  });

  it("allows normal files", () => {
    expect(isSensitiveWorkerPath("readme.md")).toBe(false);
    expect(isSensitiveWorkerPath("src/index.ts")).toBe(false);
    expect(isSensitiveWorkerPath("data.csv")).toBe(false);
    expect(isSensitiveWorkerPath("package.json")).toBe(false);
  });
});

// ─── write_file guards ─────────────────────────────────────────

describe("local worker write_file guards", () => {
  it("blocks wallet.json", () => {
    expect(isSensitiveWorkerPath("wallet.json")).toBe(true);
  });

  it("blocks .env", () => {
    expect(isSensitiveWorkerPath(".env")).toBe(true);
  });

  it("blocks .key files", () => {
    expect(isSensitiveWorkerPath("deploy.key")).toBe(true);
  });

  it("blocks .pem files", () => {
    expect(isSensitiveWorkerPath("server.pem")).toBe(true);
  });

  it("blocks automaton.json", () => {
    expect(isSensitiveWorkerPath("automaton.json")).toBe(true);
  });

  it("allows normal files", () => {
    expect(isSensitiveWorkerPath("output.txt")).toBe(false);
    expect(isSensitiveWorkerPath("src/utils/helper.ts")).toBe(false);
  });
});

// ─── path normalization ─────────────────────────────────────────

describe("local worker path normalization", () => {
  it("uses path.resolve to normalize paths before checking", () => {
    // path.resolve converts relative paths to absolute, so the basename
    // extraction works regardless of how the path is expressed.
    const resolved = path.resolve("some/nested/../wallet.json");
    expect(path.basename(resolved)).toBe("wallet.json");
    expect(isSensitiveWorkerPath("some/nested/../wallet.json")).toBe(true);
  });

  it("blocks path traversal via ../../.env", () => {
    expect(isSensitiveWorkerPath("../../.env")).toBe(true);
  });

  it("blocks path traversal via ../../../wallet.json", () => {
    expect(isSensitiveWorkerPath("../../../wallet.json")).toBe(true);
  });

  it("blocks path traversal via ../../secrets/server.key", () => {
    expect(isSensitiveWorkerPath("../../secrets/server.key")).toBe(true);
  });

  it("blocks path traversal via deeply nested .pem", () => {
    expect(isSensitiveWorkerPath("../../../etc/ssl/cert.pem")).toBe(true);
  });

  it("does not false-positive on safe files with traversal components", () => {
    expect(isSensitiveWorkerPath("../../src/index.ts")).toBe(false);
    expect(isSensitiveWorkerPath("../readme.md")).toBe(false);
  });
});
