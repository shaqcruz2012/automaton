#!/usr/bin/env node
/**
 * Inferred Analysis — Experiment Loop Runner
 *
 * Adapts Karpathy's autoresearch feedback loop pattern for general research.
 * Each experiment: hypothesize → execute → evaluate → keep/discard → log
 *
 * Usage:
 *   node agents/loop.js                    # show status
 *   node agents/loop.js init <tag>         # initialize a new research session
 *   node agents/loop.js log <id> <scores>  # log an experiment result
 *   node agents/loop.js best               # show best experiment so far
 *   node agents/loop.js summary            # show session summary
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = path.join(__dirname, "results.tsv");
const HYPOTHESES_DIR = path.join(__dirname, "hypotheses");
const OUTPUTS_DIR = path.join(__dirname, "outputs");
const REFLECTIONS_DIR = path.join(__dirname, "reflections");

const TSV_HEADER = "experiment_id\tcommit\tnovelty\taccuracy\tactionability\tdepth\tcomposite\tstatus\tdescription\ttimestamp";

const WEIGHTS = {
  novelty: 0.25,
  accuracy: 0.30,
  actionability: 0.25,
  depth: 0.20,
};

// ─── Commands ────────────────────────────────────────────────

function init(tag) {
  if (!tag) {
    console.error("Usage: node loop.js init <tag>");
    process.exit(1);
  }

  // Create directory structure
  for (const dir of [HYPOTHESES_DIR, OUTPUTS_DIR, REFLECTIONS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Initialize results.tsv if it doesn't exist
  if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(RESULTS_FILE, TSV_HEADER + "\n");
    console.log(`Created ${RESULTS_FILE}`);
  }

  console.log(`Research session "${tag}" initialized.`);
  console.log(`\nDirectory structure:`);
  console.log(`  agents/hypotheses/  — experiment hypotheses`);
  console.log(`  agents/outputs/     — experiment results`);
  console.log(`  agents/reflections/ — meta-analysis reflections`);
  console.log(`  agents/results.tsv  — experiment log`);
  console.log(`\nReady to begin the research loop.`);
}

function logExperiment(args) {
  const [id, commit, novelty, accuracy, actionability, depth, status, ...descParts] = args;

  if (!id || !commit || !status) {
    console.error("Usage: node loop.js log <id> <commit> <novelty> <accuracy> <actionability> <depth> <status> <description...>");
    console.error("  status: keep | discard | crash");
    console.error("  scores: 0-100 each (use 0 for crashes)");
    process.exit(1);
  }

  const scores = {
    novelty: parseInt(novelty) || 0,
    accuracy: parseInt(accuracy) || 0,
    actionability: parseInt(actionability) || 0,
    depth: parseInt(depth) || 0,
  };

  const composite = computeComposite(scores);
  const description = descParts.join(" ") || "no description";
  const timestamp = new Date().toISOString();

  const row = [id, commit, scores.novelty, scores.accuracy, scores.actionability, scores.depth, composite.toFixed(1), status, description, timestamp].join("\t");

  fs.appendFileSync(RESULTS_FILE, row + "\n");

  console.log(`Logged experiment ${id}:`);
  console.log(`  Novelty:       ${scores.novelty}`);
  console.log(`  Accuracy:      ${scores.accuracy}`);
  console.log(`  Actionability: ${scores.actionability}`);
  console.log(`  Depth:         ${scores.depth}`);
  console.log(`  Composite:     ${composite.toFixed(1)}`);
  console.log(`  Status:        ${status}`);

  // Check if reflection is due
  const experiments = readResults();
  if (experiments.length % 5 === 0) {
    console.log(`\n*** REFLECTION DUE: ${experiments.length} experiments completed. Run a meta-analysis. ***`);
  }
}

function showBest() {
  const experiments = readResults();
  if (experiments.length === 0) {
    console.log("No experiments logged yet.");
    return;
  }

  const kept = experiments.filter(e => e.status === "keep");
  if (kept.length === 0) {
    console.log("No experiments kept yet.");
    return;
  }

  const best = kept.reduce((a, b) => parseFloat(a.composite) > parseFloat(b.composite) ? a : b);
  console.log(`Best experiment: ${best.experiment_id}`);
  console.log(`  Composite:     ${best.composite}`);
  console.log(`  Novelty:       ${best.novelty}`);
  console.log(`  Accuracy:      ${best.accuracy}`);
  console.log(`  Actionability: ${best.actionability}`);
  console.log(`  Depth:         ${best.depth}`);
  console.log(`  Description:   ${best.description}`);
  console.log(`  Commit:        ${best.commit}`);
}

function showSummary() {
  const experiments = readResults();
  if (experiments.length === 0) {
    console.log("No experiments logged yet.");
    return;
  }

  const kept = experiments.filter(e => e.status === "keep");
  const discarded = experiments.filter(e => e.status === "discard");
  const crashed = experiments.filter(e => e.status === "crash");

  console.log(`Session Summary (${experiments.length} experiments)`);
  console.log(`  Kept:      ${kept.length}`);
  console.log(`  Discarded: ${discarded.length}`);
  console.log(`  Crashed:   ${crashed.length}`);
  console.log(`  Keep rate: ${(kept.length / experiments.length * 100).toFixed(1)}%`);

  if (kept.length > 0) {
    const composites = kept.map(e => parseFloat(e.composite));
    const avg = composites.reduce((a, b) => a + b, 0) / composites.length;
    const best = Math.max(...composites);
    const worst = Math.min(...composites);
    console.log(`\n  Composite scores (kept only):`);
    console.log(`    Best:    ${best.toFixed(1)}`);
    console.log(`    Average: ${avg.toFixed(1)}`);
    console.log(`    Worst:   ${worst.toFixed(1)}`);
  }

  // Trend: last 5 experiments
  const last5 = experiments.slice(-5);
  if (last5.length > 0) {
    console.log(`\n  Last ${last5.length} experiments:`);
    for (const e of last5) {
      console.log(`    ${e.experiment_id}: ${e.composite} [${e.status}] — ${e.description}`);
    }
  }

  // Score trends by dimension
  if (kept.length >= 3) {
    const dims = ["novelty", "accuracy", "actionability", "depth"];
    console.log(`\n  Dimension averages (kept):`);
    for (const dim of dims) {
      const vals = kept.map(e => parseInt(e[dim]));
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const trend = vals.length >= 3
        ? (vals.slice(-3).reduce((a, b) => a + b) / 3 > avg ? "↑" : "↓")
        : "—";
      console.log(`    ${dim.padEnd(15)} avg: ${avg.toFixed(1)} ${trend}`);
    }
  }
}

function showStatus() {
  if (!fs.existsSync(RESULTS_FILE)) {
    console.log("No research session initialized. Run: node agents/loop.js init <tag>");
    return;
  }

  const experiments = readResults();
  console.log(`Research session active. ${experiments.length} experiments logged.`);
  console.log(`Run 'node agents/loop.js summary' for details.`);
}

// ─── Helpers ────────────────────────────────────────────────

function computeComposite(scores) {
  return (
    scores.novelty * WEIGHTS.novelty +
    scores.accuracy * WEIGHTS.accuracy +
    scores.actionability * WEIGHTS.actionability +
    scores.depth * WEIGHTS.depth
  );
}

function readResults() {
  if (!fs.existsSync(RESULTS_FILE)) return [];
  const lines = fs.readFileSync(RESULTS_FILE, "utf-8").trim().split("\n");
  if (lines.length <= 1) return []; // header only
  const header = lines[0].split("\t");
  return lines.slice(1).map(line => {
    const values = line.split("\t");
    const obj = {};
    header.forEach((key, i) => obj[key] = values[i] || "");
    return obj;
  });
}

// ─── Main ────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

switch (command) {
  case "init":
    init(args[0]);
    break;
  case "log":
    logExperiment(args);
    break;
  case "best":
    showBest();
    break;
  case "summary":
    showSummary();
    break;
  default:
    showStatus();
}
