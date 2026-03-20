#!/usr/bin/env node
/**
 * Notification System — Inferred Analysis
 *
 * Sends status reports to you via Telegram or stdout.
 * Integrates with the daemon to provide regular updates on agent performance.
 *
 * Usage:
 *   node agents/notify.mjs                     # Print report to stdout
 *   node agents/notify.mjs --telegram           # Send via Telegram
 *   node agents/notify.mjs --watch 900          # Auto-report every 15 min
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN=your-bot-token
 *   TELEGRAM_CHAT_ID=your-chat-id
 *   PAPERCLIP_URL=http://localhost:3100
 */

import { readFileSync, existsSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─── Config ──────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    telegram: args.includes("--telegram"),
    watch: args.includes("--watch") ? parseInt(args[args.indexOf("--watch") + 1] || "900") : 0,
    paperclipUrl: process.env.PAPERCLIP_URL || "http://localhost:3100",
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  };
}

// ─── Paperclip Data ──────────────────────────────────────

async function getPaperclipStatus(baseUrl) {
  try {
    const healthRes = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!healthRes.ok) return null;
    const health = await healthRes.json();

    const companiesRes = await fetch(`${baseUrl}/api/companies`, { signal: AbortSignal.timeout(5000) });
    const companies = await companiesRes.json();
    if (!companies?.length) return { health, agents: [], company: null };

    const company = companies[0];
    const agentsRes = await fetch(`${baseUrl}/api/companies/${company.id}/agents`, { signal: AbortSignal.timeout(5000) });
    const agents = await agentsRes.json();

    return { health, agents, company };
  } catch {
    return null;
  }
}

// ─── Experiment Data ─────────────────────────────────────

function getExperimentSummary() {
  const resultsPath = join(ROOT, "agents", "results.tsv");
  if (!existsSync(resultsPath)) return null;

  const lines = readFileSync(resultsPath, "utf-8").trim().split("\n").slice(1); // skip header
  if (lines.length === 0) return null;

  const experiments = lines.map(line => {
    const parts = line.split("\t");
    return {
      timestamp: parts[0],
      agent: parts[1],
      strategy: parts[2],
      sharpe: parseFloat(parts[3]) || 0,
      status: parts[parts.length - 2] || parts[10] || "unknown",
    };
  });

  const total = experiments.length;
  const keeps = experiments.filter(e => e.status === "keep").length;
  const discards = experiments.filter(e => e.status === "discard").length;
  const crashes = experiments.filter(e => e.status === "crash").length;
  const keepRate = total > 0 ? ((keeps / total) * 100).toFixed(1) : "0";

  // Best Sharpe
  const bestExp = experiments.reduce((best, e) => e.sharpe > best.sharpe ? e : best, experiments[0]);

  // Per-agent breakdown
  const byAgent = {};
  for (const e of experiments) {
    if (!byAgent[e.agent]) byAgent[e.agent] = { total: 0, keeps: 0, bestSharpe: -Infinity };
    byAgent[e.agent].total++;
    if (e.status === "keep") byAgent[e.agent].keeps++;
    if (e.sharpe > byAgent[e.agent].bestSharpe) byAgent[e.agent].bestSharpe = e.sharpe;
  }

  // Recent experiments (last 10)
  const recent = experiments.slice(-10);

  // Last 24h activity
  const oneDayAgo = Date.now() - 86400000;
  const last24h = experiments.filter(e => new Date(e.timestamp).getTime() > oneDayAgo);

  return {
    total, keeps, discards, crashes, keepRate,
    bestExp, byAgent, recent, last24h,
    firstTimestamp: experiments[0]?.timestamp,
    lastTimestamp: experiments[experiments.length - 1]?.timestamp,
  };
}

// ─── Daemon Status ───────────────────────────────────────

function getDaemonStatus() {
  const pidFile = join(ROOT, ".daemon.pid");
  if (!existsSync(pidFile)) return { running: false };

  const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, stalePid: pid };
  }
}

// ─── Report Generation ─────────────────────────────────

async function generateReport(paperclipUrl) {
  const now = new Date().toISOString();
  const daemon = getDaemonStatus();
  const experiments = getExperimentSummary();
  const paperclip = await getPaperclipStatus(paperclipUrl);

  let report = `📊 *Inferred Analysis — Status Report*\n`;
  report += `🕐 ${now}\n\n`;

  // System Health
  report += `*System Health*\n`;
  report += `  Daemon: ${daemon.running ? `✅ Running (PID ${daemon.pid})` : "❌ Stopped"}\n`;
  report += `  Paperclip: ${paperclip ? "✅ Connected" : "❌ Unreachable"}\n`;
  if (paperclip?.company) {
    report += `  Company: ${paperclip.company.name}\n`;
    report += `  Agents: ${paperclip.agents.length} total\n`;
    const idle = paperclip.agents.filter(a => a.status === "idle").length;
    const active = paperclip.agents.filter(a => a.status === "active" || a.status === "running").length;
    report += `    Idle: ${idle} | Active: ${active}\n`;
  }
  report += `\n`;

  // Experiment Summary
  if (experiments) {
    report += `*Research Performance*\n`;
    report += `  Total experiments: ${experiments.total}\n`;
    report += `  ✅ Kept: ${experiments.keeps} | ❌ Discarded: ${experiments.discards} | 💥 Crashed: ${experiments.crashes}\n`;
    report += `  Keep rate: ${experiments.keepRate}%\n`;
    report += `  Best Sharpe: ${experiments.bestExp.sharpe.toFixed(4)} (${experiments.bestExp.agent} — ${experiments.bestExp.strategy})\n`;

    if (experiments.last24h.length > 0) {
      const last24hKeeps = experiments.last24h.filter(e => e.status === "keep").length;
      report += `\n*Last 24h*\n`;
      report += `  Experiments: ${experiments.last24h.length}\n`;
      report += `  Kept: ${last24hKeeps}\n`;
    }

    // Agent leaderboard
    report += `\n*Agent Leaderboard*\n`;
    const agents = Object.entries(experiments.byAgent)
      .sort((a, b) => b[1].bestSharpe - a[1].bestSharpe);
    for (const [name, data] of agents) {
      const medal = data.bestSharpe === experiments.bestExp.sharpe ? "🏆" : "  ";
      report += `${medal} ${name}: Sharpe ${data.bestSharpe.toFixed(4)} (${data.keeps}/${data.total} kept)\n`;
    }

    // Recent activity
    if (experiments.recent.length > 0) {
      report += `\n*Recent Experiments*\n`;
      for (const e of experiments.recent.slice(-5)) {
        const icon = e.status === "keep" ? "✅" : e.status === "crash" ? "💥" : "❌";
        report += `${icon} ${e.agent}: ${e.strategy} → Sharpe ${e.sharpe.toFixed(4)}\n`;
      }
    }
  } else {
    report += `*Research*: No experiments yet\n`;
  }

  return report;
}

// ─── Telegram Sender ─────────────────────────────────────

async function sendTelegram(token, chatId, message) {
  if (!token || !chatId) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Telegram API error: ${err}`);
      return false;
    }

    console.log("Telegram message sent successfully");
    return true;
  } catch (err) {
    console.error(`Telegram send failed: ${err.message}`);
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  async function sendReport() {
    const report = await generateReport(opts.paperclipUrl);

    if (opts.telegram) {
      if (!opts.telegramToken || !opts.telegramChatId) {
        console.error("\nTo use Telegram notifications, set:");
        console.error("  export TELEGRAM_BOT_TOKEN=your-bot-token");
        console.error("  export TELEGRAM_CHAT_ID=your-chat-id");
        console.error("\nPrinting report to stdout instead:\n");
        console.log(report);
        return;
      }
      await sendTelegram(opts.telegramToken, opts.telegramChatId, report);
    } else {
      console.log(report);
    }
  }

  if (opts.watch > 0) {
    console.log(`Notification watcher started (every ${opts.watch}s)`);
    while (true) {
      await sendReport();
      await new Promise(r => setTimeout(r, opts.watch * 1000));
    }
  } else {
    await sendReport();
  }
}

main().catch(err => {
  console.error("Notify failed:", err.message);
  process.exit(1);
});
