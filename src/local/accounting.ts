/**
 * Local Accounting Ledger
 *
 * Phase 4: Tracks revenue, expenses, and transfers in the existing SQLite
 * database. Uses the existing `transactions`, `spend_tracking`, and
 * `inference_costs` tables, plus new `revenue_events` and `expense_events`
 * tables for detailed P&L tracking.
 *
 * Every inference call, sandbox operation, and external API call logs
 * an expense. Every paid service call received logs revenue.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";

type Database = BetterSqlite3.Database;

// ── Schema Migration ─────────────────────────────────────────────

const ACCOUNTING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS revenue_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS expense_events (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('inference','sandbox','transfer','api','other')),
    amount_cents INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_revenue_created ON revenue_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_expense_created ON expense_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_expense_category ON expense_events(category);
`;

/**
 * Ensure the accounting tables exist.
 * Call this during database initialization.
 */
export function initAccountingSchema(db: Database): void {
  db.exec(ACCOUNTING_SCHEMA);
}

// ── Revenue ──────────────────────────────────────────────────────

export interface RevenueEvent {
  id?: string;
  source: string;
  amountCents: number;
  description?: string;
  metadata?: Record<string, unknown>;
}

export function logRevenue(db: Database, event: RevenueEvent): string {
  const id = event.id || ulid();
  db.prepare(
    `INSERT INTO revenue_events (id, source, amount_cents, description, metadata)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.source,
    event.amountCents,
    event.description || "",
    JSON.stringify(event.metadata || {}),
  );
  return id;
}

// ── Expenses ─────────────────────────────────────────────────────

export type ExpenseCategory = "inference" | "sandbox" | "transfer" | "api" | "other";

export interface ExpenseEvent {
  id?: string;
  category: ExpenseCategory;
  amountCents: number;
  description?: string;
  metadata?: Record<string, unknown>;
}

export function logExpense(db: Database, event: ExpenseEvent): string {
  const id = event.id || ulid();
  db.prepare(
    `INSERT INTO expense_events (id, category, amount_cents, description, metadata)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.category,
    event.amountCents,
    event.description || "",
    JSON.stringify(event.metadata || {}),
  );
  return id;
}

// ── Transfer Log ─────────────────────────────────────────────────

export interface TransferLog {
  id?: string;
  toAddress: string;
  amountCents: number;
  txHash?: string;
  description?: string;
}

export function logTransfer(db: Database, transfer: TransferLog): string {
  const id = transfer.id || ulid();

  // Log in expense_events
  logExpense(db, {
    id,
    category: "transfer",
    amountCents: transfer.amountCents,
    description: transfer.description || `Transfer to ${transfer.toAddress}`,
    metadata: { toAddress: transfer.toAddress, txHash: transfer.txHash },
  });

  // Also log in the existing transactions table for backward compatibility
  db.prepare(
    `INSERT OR IGNORE INTO transactions (id, type, amount_cents, description)
     VALUES (?, ?, ?, ?)`,
  ).run(
    id,
    "transfer_out",
    transfer.amountCents,
    transfer.description || `USDC transfer to ${transfer.toAddress}`,
  );

  return id;
}

// ── P&L Computation ──────────────────────────────────────────────

export interface PnlReport {
  /** Total revenue in cents */
  totalRevenueCents: number;
  /** Total expenses in cents */
  totalExpenseCents: number;
  /** Net P&L in cents (revenue - expenses) */
  netCents: number;
  /** Expense breakdown by category */
  expenseByCategory: Record<string, number>;
  /** Period start (ISO string) */
  periodStart: string;
  /** Period end (ISO string) */
  periodEnd: string;
}

/**
 * Compute P&L for a given period.
 * @param period - "day", "week", "month", or "all"
 */
export function computePnl(db: Database, period: string = "all"): PnlReport {
  const now = new Date();
  let periodStart: string;

  switch (period) {
    case "day":
      periodStart = new Date(now.getTime() - 86_400_000).toISOString();
      break;
    case "week":
      periodStart = new Date(now.getTime() - 7 * 86_400_000).toISOString();
      break;
    case "month":
      periodStart = new Date(now.getTime() - 30 * 86_400_000).toISOString();
      break;
    default:
      periodStart = "1970-01-01T00:00:00.000Z";
  }

  const periodEnd = now.toISOString();

  // Total revenue
  const revRow = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) as total FROM revenue_events WHERE created_at >= ?`,
  ).get(periodStart) as { total: number };

  // Total expenses
  const expRow = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) as total FROM expense_events WHERE created_at >= ?`,
  ).get(periodStart) as { total: number };

  // Expense breakdown by category
  const catRows = db.prepare(
    `SELECT category, COALESCE(SUM(amount_cents), 0) as total
     FROM expense_events WHERE created_at >= ? GROUP BY category`,
  ).all(periodStart) as Array<{ category: string; total: number }>;

  const expenseByCategory: Record<string, number> = {};
  for (const row of catRows) {
    expenseByCategory[row.category] = row.total;
  }

  return {
    totalRevenueCents: revRow.total,
    totalExpenseCents: expRow.total,
    netCents: revRow.total - expRow.total,
    expenseByCategory,
    periodStart,
    periodEnd,
  };
}

// ── Daily Burn Estimation ────────────────────────────────────────

/**
 * Estimate daily burn rate from the expense ledger.
 * Uses a rolling 7-day average. Returns cents per day.
 */
export function estimateDailyBurnCents(db: Database): number {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const row = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) as total FROM expense_events WHERE created_at >= ?`,
  ).get(sevenDaysAgo) as { total: number };

  if (row.total === 0) return 0;

  // Count the actual number of days with data
  const dayCountRow = db.prepare(
    `SELECT COUNT(DISTINCT date(created_at)) as days FROM expense_events WHERE created_at >= ?`,
  ).get(sevenDaysAgo) as { days: number };

  const days = Math.max(dayCountRow.days, 1);
  return Math.ceil(row.total / days);
}

// ── Ledger Balance ───────────────────────────────────────────────

/**
 * Get the local ledger balance (total revenue - total expenses).
 * This is a soft balance for anomaly detection, NOT the source of truth.
 */
export function getLocalLedgerBalance(db: Database): number {
  const pnl = computePnl(db, "all");
  return pnl.netCents;
}
