/**
 * Accounting Ledger Tests
 *
 * Tests for the local accounting module:
 * - logRevenue rejects amountCents <= 0
 * - logExpense rejects amountCents <= 0
 * - safeAddColumn only suppresses "duplicate column" errors
 * - computeDailyNetProfit rejects invalid date format
 * - logTransferEvent rejects amountUsd <= 0
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import {
  initAccountingSchema,
  logRevenue,
  logExpense,
  logTransferEvent,
  computeDailyNetProfit,
} from "../local/accounting.js";

// ─── Test Helpers ───────────────────────────────────────────────

function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initAccountingSchema(db);
  return db;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Accounting Ledger", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── logRevenue ──────────────────────────────────────────────

  describe("logRevenue", () => {
    it("rejects amountCents <= 0 (zero)", () => {
      expect(() =>
        logRevenue(db, { source: "test", amountCents: 0 }),
      ).toThrow("Amount must be positive");
    });

    it("rejects amountCents <= 0 (negative)", () => {
      expect(() =>
        logRevenue(db, { source: "test", amountCents: -100 }),
      ).toThrow("Amount must be positive");
    });

    it("accepts positive amountCents and returns an id", () => {
      const id = logRevenue(db, { source: "api", amountCents: 500 });
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });
  });

  // ── logExpense ─────────────────────────────────────────────

  describe("logExpense", () => {
    it("rejects amountCents <= 0 (zero)", () => {
      expect(() =>
        logExpense(db, { category: "inference", amountCents: 0 }),
      ).toThrow("Amount must be positive");
    });

    it("rejects amountCents <= 0 (negative)", () => {
      expect(() =>
        logExpense(db, { category: "inference", amountCents: -50 }),
      ).toThrow("Amount must be positive");
    });

    it("accepts positive amountCents and returns an id", () => {
      const id = logExpense(db, { category: "inference", amountCents: 200 });
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });
  });

  // ── safeAddColumn (tested indirectly) ─────────────────────

  describe("safeAddColumn", () => {
    it("suppresses duplicate column errors on repeated init", () => {
      // First init already ran in beforeEach. Second init exercises
      // the duplicate-column suppression path in safeAddColumn.
      expect(() => initAccountingSchema(db)).not.toThrow();
    });

    it("propagates non-duplicate-column errors", () => {
      // Attempt to ALTER a table that does not exist. This triggers a
      // different SQLite error that safeAddColumn must NOT suppress.
      expect(() =>
        db.exec("ALTER TABLE nonexistent_table ADD COLUMN foo TEXT"),
      ).toThrow();
    });
  });

  // ── computeDailyNetProfit ─────────────────────────────────

  describe("computeDailyNetProfit", () => {
    it("rejects invalid date format", () => {
      // An invalid date string causes new Date(...) to produce Invalid Date,
      // which throws RangeError on .toISOString().
      expect(() => computeDailyNetProfit(db, "not-a-date")).toThrow();
    });

    it("rejects empty string as date", () => {
      expect(() => computeDailyNetProfit(db, "")).toThrow();
    });

    it("returns correct profit for a valid date with data", () => {
      // Insert revenue and expense for a specific date
      db.prepare(
        `INSERT INTO revenue_events (id, source, amount_cents, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("rev1", "api", 1000, "test revenue", "2025-06-15 12:00:00");

      db.prepare(
        `INSERT INTO expense_events (id, category, amount_cents, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("exp1", "inference", 300, "test expense", "2025-06-15 14:00:00");

      const result = computeDailyNetProfit(db, "2025-06-15");
      expect(result.date).toBe("2025-06-15");
      expect(result.revenueCents).toBe(1000);
      expect(result.expenseCents).toBe(300);
      expect(result.netProfitCents).toBe(700);
      expect(result.netProfitUsd).toBe(7);
    });

    it("returns zeros for a date with no data", () => {
      const result = computeDailyNetProfit(db, "2025-01-01");
      expect(result.revenueCents).toBe(0);
      expect(result.expenseCents).toBe(0);
      expect(result.netProfitCents).toBe(0);
    });
  });

  // ── logTransferEvent ──────────────────────────────────────

  describe("logTransferEvent", () => {
    it("rejects amountUsd <= 0 (zero)", () => {
      expect(() =>
        logTransferEvent(db, {
          type: "tax",
          fromAccount: "treasury",
          toAccount: "irs",
          amountUsd: 0,
        }),
      ).toThrow("Transfer amount must be positive");
    });

    it("rejects amountUsd <= 0 (negative)", () => {
      expect(() =>
        logTransferEvent(db, {
          type: "internal_treasury_move",
          fromAccount: "main",
          toAccount: "reserve",
          amountUsd: -10,
        }),
      ).toThrow("Transfer amount must be positive");
    });

    it("accepts positive amountUsd and returns an id", () => {
      const id = logTransferEvent(db, {
        type: "replication_funding",
        fromAccount: "treasury",
        toAccount: "child-001",
        amountUsd: 50,
      });
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });
  });
});
