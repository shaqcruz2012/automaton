#!/usr/bin/env node
/**
 * Inferred Analysis — Real-Time Terminal P&L Dashboard
 *
 * Displays live experiment results, agent leaderboard, and system status.
 * No external dependencies — pure Node.js with ANSI escape codes.
 *
 * Usage:
 *   node agents/dashboard.mjs
 *   node agents/dashboard.mjs --refresh 10   # 10 second refresh
 */

import { readFileSync, existsSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RESULTS_TSV = join(ROOT, "agents", "results.tsv");
const DAEMON_LOG = join(ROOT, "agents", "outputs", "daemon.log");
const PID_FILE = join(ROOT, ".daemon.pid");
const PAPERCLIP_URL = process.env.PAPERCLIP_URL || "http://localhost:3100";

// ─── CLI Args ────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let refresh = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--refresh" && args[i + 1]) refresh = parseInt(args[++i]);
  }
  return { refresh: Math.max(1, refresh) };
}

const CONFIG = parseArgs();

// ─── ANSI Escape Codes ──────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const UNDERLINE = `${ESC}4m`;

// Colors
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;
const GRAY = `${ESC}90m`;

// Bright
const BRIGHT_RED = `${ESC}91m`;
const BRIGHT_GREEN = `${ESC}92m`;
const BRIGHT_YELLOW = `${ESC}93m`;
const BRIGHT_CYAN = `${ESC}96m`;
const BRIGHT_WHITE = `${ESC}97m`;

// Background
const BG_BLUE = `${ESC}44m`;
const BG_GREEN = `${ESC}42m`;
const BG_RED = `${ESC}41m`;
const BG_GRAY = `${ESC}100m`;

// Screen
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

// ─── Data Loading ────────────────────────────────────────

function loadResults() {
  if (!existsSync(RESULTS_TSV)) return [];
  const raw = readFileSync(RESULTS_TSV, "utf-8").trim();
  const lines = raw.split("\n");
  if (lines.length < 2) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < 10) continue;
    rows.push({
      timestamp: cols[0],
      agent: cols[1],
      strategy: cols[2],
      sharpe: parseFloat(cols[3]),
      accuracy: parseFloat(cols[4]),
      actionability: parseFloat(cols[5]),
      depth: parseFloat(cols[6]),
      composite: parseFloat(cols[7]),
      score: parseFloat(cols[8]),
      experiments: parseInt(cols[9]) || 0,
      status: cols[cols.length - 1].trim().toLowerCase(),
    });
  }
  return rows;
}

function getDaemonStatus() {
  const result = { up: false, pid: null };
  if (!existsSync(PID_FILE)) return result;
  try {
    const pid = readFileSync(PID_FILE, "utf-8").trim();
    result.pid = pid;
    // Check if process is running
    execSync(`kill -0 ${pid} 2>/dev/null`, { stdio: "ignore" });
    result.up = true;
  } catch {
    result.up = false;
  }
  return result;
}

function getLastExperimentAge(rows) {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const ts = new Date(last.timestamp);
  const now = new Date();
  return Math.floor((now - ts) / 60000); // minutes
}

function getPostgresStatus() {
  try {
    execSync("pg_isready -q 2>/dev/null", { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function getPaperclipStatus() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ up: false, agents: 0 }), 2000);
    const url = new URL("/api/agents", PAPERCLIP_URL);
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(data);
          const count = Array.isArray(json) ? json.length : (json.agents?.length || 0);
          resolve({ up: true, agents: count });
        } catch {
          resolve({ up: res.statusCode === 200, agents: 0 });
        }
      });
    });
    req.on("error", () => {
      clearTimeout(timeout);
      resolve({ up: false, agents: 0 });
    });
  });
}

function loadPaperTrading() {
  const ptFile = join(ROOT, "trading", "state.json");
  if (!existsSync(ptFile)) return null;
  try {
    return JSON.parse(readFileSync(ptFile, "utf-8"));
  } catch {
    return null;
  }
}

// ─── Rendering Helpers ───────────────────────────────────

function pad(str, len, align = "left") {
  const s = String(str);
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  const diff = len - stripped.length;
  if (diff <= 0) return s;
  if (align === "right") return " ".repeat(diff) + s;
  if (align === "center") {
    const left = Math.floor(diff / 2);
    return " ".repeat(left) + s + " ".repeat(diff - left);
  }
  return s + " ".repeat(diff);
}

function statusBadge(up, label) {
  if (up) return `${BOLD}${BRIGHT_GREEN} UP ${RESET} ${label}`;
  return `${BOLD}${BRIGHT_RED} DN ${RESET} ${DIM}${label}${RESET}`;
}

function sharpeColor(val) {
  if (isNaN(val)) return `${DIM}---${RESET}`;
  const s = val.toFixed(2);
  if (val > 0.5) return `${BOLD}${BRIGHT_GREEN}${s}${RESET}`;
  if (val > 0) return `${GREEN}${s}${RESET}`;
  if (val > -1) return `${YELLOW}${s}${RESET}`;
  return `${RED}${s}${RESET}`;
}

function statusTag(status) {
  if (status === "keep") return `${BRIGHT_GREEN}KEEP  \u2713${RESET}`;
  if (status === "discard") return `${RED}DISCARD${RESET}`;
  if (status === "baseline") return `${DIM}BASE   ${RESET}`;
  return `${DIM}${status}${RESET}`;
}

function progressBar(current, target, width = 30) {
  const pct = Math.min(1, current / target);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = `${GREEN}${"█".repeat(filled)}${GRAY}${"░".repeat(empty)}${RESET}`;
  return `${bar} ${current}/${target} (${(pct * 100).toFixed(0)}%)`;
}

function horizontalLine(width) {
  return `${DIM}${"─".repeat(width)}${RESET}`;
}

function boxLine(content, width) {
  const stripped = content.replace(/\x1b\[[0-9;]*m/g, "");
  const padding = Math.max(0, width - stripped.length - 4);
  return `${DIM}│${RESET} ${content}${" ".repeat(padding)} ${DIM}│${RESET}`;
}

// ─── Compute Leaderboard ────────────────────────────────

function computeAgentStats(rows) {
  const ALL_AGENTS = [
    "alpha_researcher", "stat_arb_quant", "macro_quant",
    "vol_quant", "hf_quant", "microstructure_researcher", "econ_researcher"
  ];

  const agentMap = {};
  for (const a of ALL_AGENTS) {
    agentMap[a] = { agent: a, bestSharpe: NaN, bestStrategy: "---", total: 0, kept: 0, status: "idle" };
  }

  for (const r of rows) {
    if (r.status === "baseline") continue;
    const a = agentMap[r.agent];
    if (!a) continue;
    a.total++;
    if (r.status === "keep") a.kept++;
    if (isNaN(a.bestSharpe) || r.sharpe > a.bestSharpe) {
      a.bestSharpe = r.sharpe;
      a.bestStrategy = r.strategy;
    }
  }

  // Sort by best sharpe (NaN last)
  const list = Object.values(agentMap);
  list.sort((a, b) => {
    if (isNaN(a.bestSharpe) && isNaN(b.bestSharpe)) return 0;
    if (isNaN(a.bestSharpe)) return 1;
    if (isNaN(b.bestSharpe)) return -1;
    return b.bestSharpe - a.bestSharpe;
  });

  return list;
}

function computeEnsemble(rows) {
  const keeps = rows.filter((r) => r.status === "keep");
  if (keeps.length === 0) return null;
  const avgSharpe = keeps.reduce((s, r) => s + r.sharpe, 0) / keeps.length;
  return {
    agent: "ENSEMBLE",
    bestSharpe: avgSharpe,
    bestStrategy: "weighted_avg",
    total: keeps.length,
    kept: keeps.length,
    keepPct: "---",
    status: "---",
  };
}

// ─── Render Dashboard ───────────────────────────────────

async function render() {
  const rows = loadResults();
  const daemon = getDaemonStatus();
  const pgUp = getPostgresStatus();
  const paperclip = await getPaperclipStatus();
  const lastAge = getLastExperimentAge(rows);
  const trading = loadPaperTrading();

  const termWidth = process.stdout.columns || 100;
  const W = Math.min(termWidth, 110);

  let out = CLEAR;

  // ─── Header ───────────────────────────────────
  const now = new Date();
  const ts = now.toISOString().replace("T", " ").substring(0, 19) + " UTC";

  out += "\n";
  out += `  ${BOLD}${BRIGHT_CYAN}INFERRED ANALYSIS ${RESET}${DIM}— QUANT RESEARCH DASHBOARD${RESET}\n`;
  out += `  ${DIM}${ts}    refresh: ${CONFIG.refresh}s${RESET}\n`;
  out += `  ${horizontalLine(W - 4)}\n`;

  // ─── System Status Bar ────────────────────────
  const daemonLabel = daemon.up ? `PID ${daemon.pid}` : "stopped";
  const pcLabel = paperclip.up ? `${paperclip.agents} agents` : "offline";
  const pgLabel = pgUp ? "connected" : "offline";
  const lastLabel = lastAge !== null ? `${lastAge}m ago` : "never";

  out += `  `;
  out += `${BOLD}Daemon:${RESET} ${statusBadge(daemon.up, daemonLabel)}  `;
  out += `${BOLD}Paperclip:${RESET} ${statusBadge(paperclip.up, pcLabel)}  `;
  out += `${BOLD}PG:${RESET} ${statusBadge(pgUp, pgLabel)}  `;
  out += `${BOLD}Last exp:${RESET} ${DIM}${lastLabel}${RESET}`;
  out += "\n";
  out += `  ${horizontalLine(W - 4)}\n`;

  // ─── Agent Leaderboard ────────────────────────
  out += `\n  ${BOLD}${WHITE}AGENT LEADERBOARD${RESET}\n`;

  const hdrAgent = pad("Agent", 24);
  const hdrSharpe = pad("Sharpe", 8, "right");
  const hdrStrat = pad("Best Strategy", 20);
  const hdrExp = pad("Exps", 6, "right");
  const hdrKeep = pad("Keep%", 7, "right");
  const hdrStatus = pad("Status", 8);

  out += `  ${DIM}${hdrAgent} ${DIM}│${RESET}${DIM} ${hdrSharpe} ${DIM}│${RESET}${DIM} ${hdrStrat} ${DIM}│${RESET}${DIM} ${hdrExp} ${DIM}│${RESET}${DIM} ${hdrKeep} ${DIM}│${RESET}${DIM} ${hdrStatus}${RESET}\n`;
  out += `  ${DIM}${"─".repeat(24)}┼${"─".repeat(10)}┼${"─".repeat(22)}┼${"─".repeat(8)}┼${"─".repeat(9)}┼${"─".repeat(9)}${RESET}\n`;

  const agents = computeAgentStats(rows);
  const ensemble = computeEnsemble(rows);

  for (const a of agents) {
    const keepPct = a.total > 0 ? `${((a.kept / a.total) * 100).toFixed(1)}%` : "---";
    const nameColor = a.total > 0 ? WHITE : DIM;
    out += `  ${nameColor}${pad(a.agent, 24)}${RESET} ${DIM}│${RESET} ${pad(sharpeColor(a.bestSharpe), 8 + 10, "right")} ${DIM}│${RESET} ${pad(a.bestStrategy, 20)} ${DIM}│${RESET} ${pad(String(a.total), 6, "right")} ${DIM}│${RESET} ${pad(keepPct, 7, "right")} ${DIM}│${RESET} ${DIM}${pad(a.status, 8)}${RESET}\n`;
  }

  // Ensemble row
  if (ensemble) {
    out += `  ${DIM}${"─".repeat(24)}┼${"─".repeat(10)}┼${"─".repeat(22)}┼${"─".repeat(8)}┼${"─".repeat(9)}┼${"─".repeat(9)}${RESET}\n`;
    out += `  ${BOLD}${BRIGHT_CYAN}${pad(ensemble.agent, 24)}${RESET} ${DIM}│${RESET} ${pad(sharpeColor(ensemble.bestSharpe), 8 + 10, "right")} ${DIM}│${RESET} ${pad(ensemble.bestStrategy, 20)} ${DIM}│${RESET} ${pad(String(ensemble.total), 6, "right")} ${DIM}│${RESET} ${pad("---", 7, "right")} ${DIM}│${RESET} ${DIM}${pad("---", 8)}${RESET}\n`;
  }

  out += "\n";

  // ─── Recent Activity Feed ─────────────────────
  out += `  ${BOLD}${WHITE}RECENT ACTIVITY${RESET}\n`;
  out += `  ${DIM}${pad("Time", 6)} ${pad("Agent", 24)} ${pad("Strategy", 20)} ${pad("Sharpe", 8, "right")} ${"Status"}${RESET}\n`;
  out += `  ${horizontalLine(W - 4)}\n`;

  const recent = rows.slice(-10).reverse();
  for (const r of recent) {
    const time = r.timestamp.substring(11, 16); // HH:MM
    const sColor = sharpeColor(r.sharpe);
    const tag = statusTag(r.status);
    out += `  ${DIM}${pad(time, 6)}${RESET} ${pad(r.agent, 24)} ${pad(r.strategy, 20)} ${pad(sColor, 8 + 10, "right")} ${tag}\n`;
  }

  if (recent.length === 0) {
    out += `  ${DIM}  No experiments recorded yet.${RESET}\n`;
  }

  out += "\n";

  // ─── Portfolio Summary ────────────────────────
  if (trading) {
    out += `  ${BOLD}${WHITE}PORTFOLIO SUMMARY${RESET}  ${DIM}(paper trading)${RESET}\n`;
    out += `  ${horizontalLine(W - 4)}\n`;

    const capital = trading.capital ?? trading.initialCapital ?? 0;
    const pnlToday = trading.pnlToday ?? 0;
    const pnlTotal = trading.pnlTotal ?? trading.totalPnl ?? 0;
    const positions = trading.positions ?? [];
    const vol = trading.portfolioVol ?? trading.volatility ?? null;
    const maxDD = trading.maxDrawdown ?? null;

    const pnlTodayColor = pnlToday >= 0 ? GREEN : RED;
    const pnlTotalColor = pnlTotal >= 0 ? GREEN : RED;

    out += `  ${BOLD}Capital:${RESET} $${capital.toLocaleString()}  `;
    out += `${BOLD}P&L Today:${RESET} ${pnlTodayColor}$${pnlToday.toFixed(2)}${RESET}  `;
    out += `${BOLD}P&L Total:${RESET} ${pnlTotalColor}$${pnlTotal.toFixed(2)}${RESET}\n`;

    if (positions.length > 0) {
      out += `  ${BOLD}Open Positions:${RESET} ${positions.length}\n`;
      for (const p of positions.slice(0, 5)) {
        const sym = p.symbol || p.ticker || "???";
        const qty = p.quantity || p.size || 0;
        const upnl = p.unrealizedPnl ?? p.pnl ?? 0;
        const upnlColor = upnl >= 0 ? GREEN : RED;
        out += `    ${pad(sym, 10)} ${pad(String(qty), 8, "right")} ${upnlColor}${upnl >= 0 ? "+" : ""}$${upnl.toFixed(2)}${RESET}\n`;
      }
    } else {
      out += `  ${DIM}No open positions.${RESET}\n`;
    }

    if (vol !== null || maxDD !== null) {
      out += `  ${BOLD}Risk:${RESET}`;
      if (vol !== null) out += `  Vol: ${(vol * 100).toFixed(1)}%`;
      if (maxDD !== null) out += `  Max DD: ${RED}${(maxDD * 100).toFixed(1)}%${RESET}`;
      out += "\n";
    }
    out += "\n";
  }

  // ─── Experiment Progress ──────────────────────
  const totalExps = rows.filter((r) => r.status !== "baseline").length;
  const totalKept = rows.filter((r) => r.status === "keep").length;
  const keepRate = totalExps > 0 ? ((totalKept / totalExps) * 100).toFixed(1) : "0.0";
  const bestSharpe = rows.reduce((best, r) => {
    if (r.status === "baseline") return best;
    return isNaN(best) || r.sharpe > best ? r.sharpe : best;
  }, NaN);

  const TARGET = 100;

  out += `  ${BOLD}${WHITE}EXPERIMENT PROGRESS${RESET}\n`;
  out += `  ${progressBar(totalExps, TARGET, 35)}\n`;
  out += `  ${DIM}Keep rate:${RESET} ${BOLD}${keepRate}%${RESET}  `;
  out += `${DIM}Kept:${RESET} ${BOLD}${totalKept}${RESET}  `;
  out += `${DIM}Best Sharpe:${RESET} ${sharpeColor(bestSharpe)}\n`;

  out += `\n  ${DIM}Press Ctrl+C to exit${RESET}\n`;

  process.stdout.write(out);
}

// ─── Main Loop ───────────────────────────────────────────

async function main() {
  process.stdout.write(HIDE_CURSOR);

  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(CLEAR);
    console.log("\nDashboard closed.");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  });

  // Initial render
  await render();

  // Refresh loop
  setInterval(async () => {
    try {
      await render();
    } catch (err) {
      // Silently continue on render errors
    }
  }, CONFIG.refresh * 1000);
}

main().catch((err) => {
  process.stdout.write(SHOW_CURSOR);
  console.error("Dashboard error:", err.message);
  process.exit(1);
});
