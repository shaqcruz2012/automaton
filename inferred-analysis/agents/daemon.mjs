#!/usr/bin/env node
/**
 * Inferred Analysis Research Daemon
 *
 * Runs the autoresearch loop on a 15-minute cycle for all research agents.
 * Each cycle: picks an agent → runs N experiments → logs results → sleeps.
 *
 * This is the 24/7 process that keeps the quant fund's AI lab running.
 *
 * Usage:
 *   node agents/daemon.mjs                           # Run forever (default)
 *   node agents/daemon.mjs --interval 900            # 15 min cycle (default)
 *   node agents/daemon.mjs --iterations 5            # 5 experiments per cycle
 *   node agents/daemon.mjs --once                    # Run one cycle then exit
 *   node agents/daemon.mjs --paperclip-url http://localhost:3100
 *
 * Environment:
 *   PAPERCLIP_URL=http://localhost:3100
 *   DAEMON_INTERVAL=900
 *   DAEMON_ITERATIONS=5
 */

import { execSync, spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOG_DIR = join(ROOT, "agents", "outputs");
const PID_FILE = join(ROOT, ".daemon.pid");
const DAEMON_LOG = join(LOG_DIR, "daemon.log");

// ─── Config ──────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    interval: parseInt(process.env.DAEMON_INTERVAL || "900"),
    iterations: parseInt(process.env.DAEMON_ITERATIONS || "5"),
    paperclipUrl: process.env.PAPERCLIP_URL || "http://localhost:3100",
    once: false,
    stop: false,
    status: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--interval") opts.interval = parseInt(args[++i]);
    if (args[i] === "--iterations") opts.iterations = parseInt(args[++i]);
    if (args[i] === "--paperclip-url") opts.paperclipUrl = args[++i];
    if (args[i] === "--once") opts.once = true;
    if (args[i] === "stop") opts.stop = true;
    if (args[i] === "status") opts.status = true;
  }
  return opts;
}

// ─── Research Agents (rotate through these) ─────────────

const RESEARCH_AGENTS = [
  "alpha_researcher",
  "stat_arb_quant",
  "macro_quant",
  "vol_quant",
  "hf_quant",
  "microstructure_researcher",
  "econ_researcher",
];

// ─── Logging ─────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(DAEMON_LOG, line + "\n");
  } catch { /* best effort */ }
}

// ─── PID Management ─────────────────────────────────────

function writePid() {
  writeFileSync(PID_FILE, String(process.pid));
}

function readPid() {
  try {
    return parseInt(readFileSync(PID_FILE, "utf-8").trim());
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanPid() {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

// ─── Run Agent Experiment Cycle ─────────────────────────

function runAgentCycle(agent, iterations, paperclipUrl) {
  log(`Starting cycle: ${agent} (${iterations} iterations)`);
  try {
    const output = execSync(
      `node "${join(__dirname, "agent-runner.mjs")}" --agent ${agent} --iterations ${iterations} --paperclip-url ${paperclipUrl}`,
      {
        cwd: ROOT,
        timeout: 300_000, // 5 min max per cycle
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Extract summary from output
    const sharpeMatch = output.match(/Best Sharpe:\s+([-\d.]+)/);
    const keptMatch = output.match(/Kept:\s+(\d+)/);
    const discardedMatch = output.match(/Discarded:\s+(\d+)/);

    const sharpe = sharpeMatch ? sharpeMatch[1] : "?";
    const kept = keptMatch ? keptMatch[1] : "?";
    const discarded = discardedMatch ? discardedMatch[1] : "?";

    log(`Completed: ${agent} — Sharpe: ${sharpe}, Kept: ${kept}, Discarded: ${discarded}`);
    return { ok: true, sharpe, kept, discarded };
  } catch (err) {
    log(`ERROR: ${agent} — ${err.message?.slice(0, 200)}`);
    return { ok: false, error: err.message };
  }
}

// ─── Paperclip Health Check ─────────────────────────────

async function checkPaperclip(url) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Main Daemon Loop ───────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Handle stop command
  if (opts.stop) {
    const pid = readPid();
    if (pid && isRunning(pid)) {
      process.kill(pid, "SIGTERM");
      console.log(`Stopped daemon (PID ${pid})`);
    } else {
      console.log("No daemon running");
    }
    return;
  }

  // Handle status command
  if (opts.status) {
    const pid = readPid();
    if (pid && isRunning(pid)) {
      console.log(`Daemon running (PID ${pid})`);
      // Show last 10 log lines
      try {
        const logContent = readFileSync(DAEMON_LOG, "utf-8");
        const lines = logContent.trim().split("\n");
        console.log(`\nLast 10 log entries:`);
        for (const line of lines.slice(-10)) {
          console.log(`  ${line}`);
        }
      } catch { /* no log yet */ }
    } else {
      console.log("Daemon not running");
    }

    // Show results summary
    const resultsPath = join(ROOT, "agents", "results.tsv");
    if (existsSync(resultsPath)) {
      const results = readFileSync(resultsPath, "utf-8").trim().split("\n");
      console.log(`\nExperiment log: ${results.length - 1} experiments`);
      const keeps = results.filter(l => l.includes("\tkeep")).length;
      const discards = results.filter(l => l.includes("\tdiscard")).length;
      const crashes = results.filter(l => l.includes("\tcrash")).length;
      console.log(`  Kept: ${keeps} | Discarded: ${discards} | Crashed: ${crashes}`);
    }
    return;
  }

  // Check for existing daemon
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(`Daemon already running (PID ${existingPid}). Use 'node agents/daemon.mjs stop' first.`);
    process.exit(1);
  }

  // Write PID
  writePid();

  // Graceful shutdown
  process.on("SIGTERM", () => {
    log("Received SIGTERM — shutting down");
    cleanPid();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    log("Received SIGINT — shutting down");
    cleanPid();
    process.exit(0);
  });

  log("═══════════════════════════════════════════════════");
  log("Inferred Analysis Research Daemon started");
  log(`  Interval: ${opts.interval}s (${(opts.interval / 60).toFixed(0)} min)`);
  log(`  Iterations per agent: ${opts.iterations}`);
  log(`  Agents: ${RESEARCH_AGENTS.length}`);
  log(`  Paperclip: ${opts.paperclipUrl}`);
  log(`  PID: ${process.pid}`);
  log(`  Mode: ${opts.once ? "single run" : "continuous"}`);
  log("═══════════════════════════════════════════════════");

  let cycleCount = 0;

  while (true) {
    cycleCount++;
    const cycleStart = Date.now();
    log(`\n─── Cycle ${cycleCount} ───`);

    // Check Paperclip
    const paperclipUp = await checkPaperclip(opts.paperclipUrl);
    if (paperclipUp) {
      log("Paperclip: connected");
    } else {
      log("Paperclip: not reachable (running standalone)");
    }

    // Rotate through agents — run one per cycle to spread work
    const agentIndex = (cycleCount - 1) % RESEARCH_AGENTS.length;
    const agent = RESEARCH_AGENTS[agentIndex];

    runAgentCycle(agent, opts.iterations, opts.paperclipUrl);

    if (opts.once) {
      log("Single-run mode — exiting");
      break;
    }

    // Calculate sleep time
    const elapsed = (Date.now() - cycleStart) / 1000;
    const sleepTime = Math.max(10, opts.interval - elapsed);
    log(`Sleeping ${sleepTime.toFixed(0)}s until next cycle...`);

    await new Promise(resolve => setTimeout(resolve, sleepTime * 1000));
  }
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
