/**
 * EventStream Tests
 *
 * Tests: append validation, getRecent clamping, estimateTokens edge cases.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MIGRATION_V5, MIGRATION_V9 } from "../state/schema.js";
import { EventStream, estimateTokens } from "../memory/event-stream.js";

// ─── Test Helpers ───────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(MIGRATION_V5);
  db.exec(MIGRATION_V9);
  db.exec("INSERT INTO schema_version (version) VALUES (9)");
  return db;
}

function makeEvent(overrides: Partial<{
  type: string;
  agentAddress: string;
  goalId: string | null;
  taskId: string | null;
  content: string;
  tokenCount: number;
  compactedTo: string | null;
}> = {}) {
  return {
    type: "action" as const,
    agentAddress: "0xTEST",
    goalId: null,
    taskId: null,
    content: "test event content",
    tokenCount: 0,
    compactedTo: null,
    ...overrides,
  };
}

// ─── append Tests ───────────────────────────────────────────────

describe("EventStream.append", () => {
  let db: Database.Database;
  let stream: EventStream;

  beforeEach(() => {
    db = createTestDb();
    stream = new EventStream(db);
  });

  it("throws when agentAddress is empty", () => {
    expect(() =>
      stream.append(makeEvent({ agentAddress: "" })),
    ).toThrow("agentAddress is required");
  });

  it("throws when content is not a string", () => {
    expect(() =>
      stream.append(makeEvent({ content: 123 as unknown as string })),
    ).toThrow("content must be a string");
  });

  it("returns a ULID id on success", () => {
    const id = stream.append(makeEvent());
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

// ─── getRecent Tests ────────────────────────────────────────────

describe("EventStream.getRecent", () => {
  let db: Database.Database;
  let stream: EventStream;

  beforeEach(() => {
    db = createTestDb();
    stream = new EventStream(db);
  });

  it("clamps limit to max 1000", () => {
    // Insert 2 events, request 5000 — should not throw and should return the 2 events
    stream.append(makeEvent({ content: "event 1" }));
    stream.append(makeEvent({ content: "event 2" }));

    const events = stream.getRecent("0xTEST", 5000);
    expect(events).toHaveLength(2);
  });

  it("clamps limit to min 1", () => {
    stream.append(makeEvent({ content: "event 1" }));
    stream.append(makeEvent({ content: "event 2" }));

    const events = stream.getRecent("0xTEST", -10);
    // Min clamped to 1, so at most 1 result
    expect(events).toHaveLength(1);
  });

  it("returns correct number of events", () => {
    for (let i = 0; i < 5; i++) {
      stream.append(makeEvent({ content: `event ${i}` }));
    }

    const events = stream.getRecent("0xTEST", 3);
    expect(events).toHaveLength(3);
  });
});

// ─── estimateTokens Tests ───────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for non-string input", () => {
    // estimateTokens coerces via (text ?? ""), so null/undefined yields ""
    const result = estimateTokens(null as unknown as string);
    expect(result).toBe(0);
  });

  it("returns a positive integer for normal text", () => {
    const result = estimateTokens("Hello world, this is a test.");
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
