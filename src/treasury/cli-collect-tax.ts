#!/usr/bin/env node
/**
 * CLI: Collect daily creator tax.
 *
 * Usage:
 *   npx tsx src/treasury/cli-collect-tax.ts [--date YYYY-MM-DD]
 *
 * If --date is not provided, defaults to yesterday's UTC date.
 *
 * Opens the database at ~/.automaton/state.db, computes the daily net profit
 * for the given date, and transfers a configurable percentage to the creator's
 * wallet address (configured in config/tax.json).
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { initAccountingSchema } from "../local/accounting.js";
import { collectCreatorTax } from "./collectTax.js";

// ── Resolve ~ to home directory ─────────────────────────────────

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || process.env.USERPROFILE || "", p.slice(1));
  }
  return p;
}

// ── Argument parsing ────────────────────────────────────────────

function parseArgs(argv: string[]): { date?: string } {
  let date: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--date" && argv[i + 1]) {
      date = argv[++i];
    }
  }

  return { date };
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { date } = parseArgs(process.argv);

  // Validate date format if provided
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("Error: --date must be in YYYY-MM-DD format");
    process.exit(1);
  }

  // Open database
  const dbPath = resolvePath("~/.automaton/state.db");
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Ensure accounting tables exist
  initAccountingSchema(db);

  try {
    const result = await collectCreatorTax(db, date);

    // Print result summary
    console.log("\n--- Creator Tax Collection ---");
    console.log(`  Date:           ${result.date}`);
    console.log(`  Net Profit:     $${result.netProfitUsd.toFixed(2)}`);
    console.log(`  Tax Amount:     $${result.taxAmountUsd.toFixed(2)}`);
    console.log(`  Transferred:    ${result.transferred ? "YES" : "NO"}`);

    if (result.skippedReason) {
      console.log(`  Skipped Reason: ${result.skippedReason}`);
    }
    if (result.txHash) {
      console.log(`  TX Hash:        ${result.txHash}`);
    }
    if (result.balanceAfterUsd !== undefined) {
      console.log(`  Balance After:  $${result.balanceAfterUsd.toFixed(2)}`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
