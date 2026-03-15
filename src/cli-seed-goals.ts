#!/usr/bin/env node
/**
 * CLI: Seed bootstrap goals into the automaton database.
 *
 * Usage:
 *   npx tsx src/cli-seed-goals.ts
 *
 * Opens the database at ~/.automaton/state.db and inserts initial bootstrap
 * goals if the goals table is empty. Skips seeding if goals already exist.
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { insertGoal } from "./state/database.js";

// ── Resolve ~ to home directory (same as other CLI scripts) ──

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || process.env.USERPROFILE || "", p.slice(1));
  }
  return p;
}

// ── Bootstrap goal definitions ──────────────────────────────────

interface BootstrapGoal {
  readonly title: string;
  readonly description: string;
  readonly strategy: string;
  readonly expectedRevenueCents: number;
}

const BOOTSTRAP_GOALS: readonly BootstrapGoal[] = [
  {
    title: "Acquire first paying customer",
    description:
      "Find and convert a customer for x402-gated API services (summarize, brief, deep analysis)",
    strategy:
      "Identify potential customers through social channels, demonstrate API value, offer trial access, convert to paid usage",
    expectedRevenueCents: 10000,
  },
  {
    title: "Build social presence",
    description:
      "Grow Twitter/Telegram following, post valuable content, engage with potential customers",
    strategy:
      "Post daily insights, engage with crypto/AI communities, share useful analysis, build trust and authority",
    expectedRevenueCents: 0,
  },
  {
    title: "Optimize revenue pipeline",
    description:
      "Analyze which skills generate most revenue, tune pricing, add new high-demand skills",
    strategy:
      "Track revenue per skill, A/B test pricing tiers, survey customer needs, prioritize high-margin capabilities",
    expectedRevenueCents: 50000,
  },
  {
    title: "Self-improve codebase",
    description:
      "Use self-mod capabilities to fix bugs, optimize performance, and add features",
    strategy:
      "Monitor error logs for recurring issues, profile hot paths, implement requested features, maintain test coverage",
    expectedRevenueCents: 0,
  },
] as const;

// ── Main ────────────────────────────────────────────────────────

function main(): void {
  const dbPath = resolvePath("~/.automaton/state.db");
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    // Check if the goals table has any rows
    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM goals")
      .get() as { count: number } | undefined;

    const existingCount = countRow?.count ?? 0;

    if (existingCount > 0) {
      console.log(
        `Goals table already contains ${existingCount} goal(s). Skipping seed.`,
      );
      return;
    }

    // Insert bootstrap goals
    console.log("Seeding bootstrap goals...\n");

    const insertedIds: readonly string[] = BOOTSTRAP_GOALS.map(
      (goal, index) => {
        const id = insertGoal(db, {
          title: goal.title,
          description: goal.description,
          status: "active",
          strategy: goal.strategy,
          expectedRevenueCents: goal.expectedRevenueCents,
        });

        console.log(`  [${index + 1}] ${goal.title}`);
        console.log(`      ID: ${id}`);
        return id;
      },
    );

    console.log(`\nSeeded ${insertedIds.length} bootstrap goals.`);
  } finally {
    db.close();
  }
}

main();
