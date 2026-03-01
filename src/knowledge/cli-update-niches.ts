#!/usr/bin/env node
/**
 * CLI: Update niches from YC/HN batch data.
 *
 * Usage:
 *   npx tsx src/knowledge/cli-update-niches.ts [--yc data/yc_batch.json] [--hn data/hn_batch.json]
 *
 * Both flags are optional. At least one must be provided.
 * JSON files should contain arrays of YCItem or HNItem objects.
 *
 * The database path follows the main app convention: ~/.automaton/state.db
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { initNicheSchema } from "./niche-schema.js";
import { updateNichesFromBatch } from "./updateNiches.js";
import type { YCItem, HNItem } from "./updateNiches.js";

// ── Resolve ~ to home directory (same as src/config.ts resolvePath) ──

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

// ── Argument parsing ─────────────────────────────────────────────

function parseArgs(argv: string[]): { ycPath?: string; hnPath?: string } {
  let ycPath: string | undefined;
  let hnPath: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--yc" && argv[i + 1]) {
      ycPath = argv[++i];
    } else if (argv[i] === "--hn" && argv[i + 1]) {
      hnPath = argv[++i];
    }
  }

  return { ycPath, hnPath };
}

// ── Main ─────────────────────────────────────────────────────────

function main(): void {
  const { ycPath, hnPath } = parseArgs(process.argv);

  if (!ycPath && !hnPath) {
    console.error("Usage: cli-update-niches [--yc <path>] [--hn <path>]");
    console.error("At least one of --yc or --hn must be provided.");
    process.exit(1);
  }

  // Load YC data
  let ycItems: YCItem[] = [];
  if (ycPath) {
    const resolved = path.resolve(ycPath);
    if (!fs.existsSync(resolved)) {
      console.error(`YC file not found: ${resolved}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(resolved, "utf-8");
    ycItems = JSON.parse(raw) as YCItem[];
    console.log(`Loaded ${ycItems.length} YC items from ${resolved}`);
  }

  // Load HN data
  let hnItems: HNItem[] = [];
  if (hnPath) {
    const resolved = path.resolve(hnPath);
    if (!fs.existsSync(resolved)) {
      console.error(`HN file not found: ${resolved}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(resolved, "utf-8");
    hnItems = JSON.parse(raw) as HNItem[];
    console.log(`Loaded ${hnItems.length} HN items from ${resolved}`);
  }

  // Open database (same default path as main app)
  const dbPath = resolvePath("~/.automaton/state.db");
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Ensure niches table exists
  initNicheSchema(db);

  // Run the update
  const result = updateNichesFromBatch(db, ycItems, hnItems);

  // Print results
  console.log("\n--- Niche Update Results ---");
  console.log(`  Created:  ${result.created}`);
  console.log(`  Updated:  ${result.updated}`);
  console.log(`  Rejected: ${result.rejected}`);
  console.log(`  Total:    ${result.created + result.updated + result.rejected}`);

  // Close database
  db.close();
}

main();
