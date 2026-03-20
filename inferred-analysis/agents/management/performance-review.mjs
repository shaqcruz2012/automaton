#!/usr/bin/env node
/**
 * Agent Performance Review & Workforce Management
 *
 * Evaluates each agent's research performance from results.tsv,
 * assigns ratings (A-F), takes workforce actions, and reports.
 *
 * Usage:
 *   node agents/management/performance-review.mjs                        # Full review
 *   node agents/management/performance-review.mjs --agent alpha_researcher  # Single agent
 *   node agents/management/performance-review.mjs --actions              # Execute recommended actions
 *   node agents/management/performance-review.mjs --telegram             # Send report via Telegram
 *
 * Environment:
 *   PAPERCLIP_URL=http://localhost:3100
 *   TELEGRAM_BOT_TOKEN=your-bot-token
 *   TELEGRAM_CHAT_ID=your-chat-id
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const ROOT = join(AGENTS_DIR, "..");
const RESULTS_PATH = join(AGENTS_DIR, "results.tsv");

// ─── Config ──────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    agent: args.includes("--agent") ? args[args.indexOf("--agent") + 1] : null,
    actions: args.includes("--actions"),
    telegram: args.includes("--telegram"),
    json: args.includes("--json"),
    paperclipUrl: process.env.PAPERCLIP_URL || "http://localhost:3100",
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  };
}

// Known agents from daemon.mjs
const KNOWN_AGENTS = [
  "alpha_researcher",
  "stat_arb_quant",
  "macro_quant",
  "vol_quant",
  "hf_quant",
  "microstructure_researcher",
  "econ_researcher",
];

// Ensemble and polymarket agents tracked separately
const SPECIALIST_AGENTS = ["polymarket_btc"];

// ─── Data Loading ────────────────────────────────────────

function loadResults() {
  if (!existsSync(RESULTS_PATH)) {
    console.error(`No results file found at ${RESULTS_PATH}`);
    process.exit(1);
  }

  const raw = readFileSync(RESULTS_PATH, "utf-8").trim();
  const lines = raw.split("\n");
  const header = lines[0];
  const rows = lines.slice(1);

  const experiments = [];
  for (const line of rows) {
    const parts = line.split("\t");
    if (parts.length < 5) continue;

    const agent = parts[1];
    // Skip ensemble rows — different format
    if (agent?.startsWith("ensemble_")) continue;

    const timestamp = parts[0];
    const strategy = parts[2];
    const sharpe = parseFloat(parts[3]);
    // Status is second-to-last field based on observed data format
    // Format: timestamp, agent, strategy, sharpe, ...metrics..., trades, status, [description]
    // Find the status field — it's "keep", "discard", "baseline", or "crash"
    let status = "unknown";
    for (const p of parts) {
      const trimmed = p.trim();
      if (["keep", "discard", "baseline", "crash"].includes(trimmed)) {
        status = trimmed;
      }
    }

    experiments.push({ timestamp, agent, strategy, sharpe, status, raw: parts });
  }

  return experiments;
}

// ─── Metric Calculations ─────────────────────────────────

function computeAgentMetrics(agentName, experiments) {
  const agentExps = experiments.filter(e => e.agent === agentName);
  if (agentExps.length === 0) return null;

  // Filter to non-baseline experiments for performance metrics
  const nonBaseline = agentExps.filter(e => e.status !== "baseline");
  const total = nonBaseline.length;
  const keeps = nonBaseline.filter(e => e.status === "keep").length;
  const discards = nonBaseline.filter(e => e.status === "discard").length;
  const crashes = nonBaseline.filter(e => e.status === "crash").length;
  const keepRate = total > 0 ? keeps / total : 0;

  // Sharpe values (exclude -Infinity and NaN)
  const validSharpes = nonBaseline
    .map(e => e.sharpe)
    .filter(s => isFinite(s) && !isNaN(s));

  const bestSharpe = validSharpes.length > 0 ? Math.max(...validSharpes) : -Infinity;
  const avgSharpe = validSharpes.length > 0
    ? validSharpes.reduce((a, b) => a + b, 0) / validSharpes.length
    : -Infinity;

  // Sharpe variance (consistency score — lower is more consistent)
  const variance = validSharpes.length > 1
    ? validSharpes.reduce((sum, s) => sum + (s - avgSharpe) ** 2, 0) / (validSharpes.length - 1)
    : 0;
  const consistency = variance > 0 ? 1 / (1 + Math.sqrt(variance)) : 1;

  // Sharpe improvement trajectory — compare first half vs second half
  const halfIdx = Math.floor(validSharpes.length / 2);
  let trajectory = 0; // -1 declining, 0 flat, 1 improving
  if (validSharpes.length >= 4) {
    const firstHalf = validSharpes.slice(0, halfIdx);
    const secondHalf = validSharpes.slice(halfIdx);
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const diff = secondAvg - firstAvg;
    if (diff > 0.1) trajectory = 1;
    else if (diff < -0.1) trajectory = -1;
    else trajectory = 0;
  }

  // Time since last improvement (last keep)
  const keepExps = nonBaseline.filter(e => e.status === "keep");
  const lastKeepIdx = nonBaseline.length - 1 -
    [...nonBaseline].reverse().findIndex(e => e.status === "keep");
  const experimentsSinceLastKeep = lastKeepIdx >= 0 && lastKeepIdx < nonBaseline.length
    ? nonBaseline.length - 1 - lastKeepIdx
    : nonBaseline.length; // never kept

  // Last N experiments for rating window
  const last20 = nonBaseline.slice(-20);
  const last30 = nonBaseline.slice(-30);
  const last50 = nonBaseline.slice(-50);

  const keepsInLast20 = last20.filter(e => e.status === "keep").length;
  const keepsInLast30 = last30.filter(e => e.status === "keep").length;
  const keepsInLast50 = last50.filter(e => e.status === "keep").length;
  const keepRateLast20 = last20.length > 0 ? keepsInLast20 / last20.length : 0;
  const keepRateLast30 = last30.length > 0 ? keepsInLast30 / last30.length : 0;
  const keepRateLast50 = last50.length > 0 ? keepsInLast50 / last50.length : 0;

  // Recent trajectory (last 10 experiments)
  const last10Sharpes = nonBaseline.slice(-10)
    .map(e => e.sharpe)
    .filter(s => isFinite(s) && !isNaN(s));
  let recentTrajectory = 0;
  if (last10Sharpes.length >= 4) {
    const rHalf = Math.floor(last10Sharpes.length / 2);
    const rFirst = last10Sharpes.slice(0, rHalf).reduce((a, b) => a + b, 0) / rHalf;
    const rSecond = last10Sharpes.slice(rHalf).reduce((a, b) => a + b, 0) / (last10Sharpes.length - rHalf);
    if (rSecond - rFirst > 0.05) recentTrajectory = 1;
    else if (rSecond - rFirst < -0.05) recentTrajectory = -1;
  }

  // Strategies used
  const strategies = [...new Set(nonBaseline.map(e => e.strategy))];

  return {
    agent: agentName,
    total,
    keeps,
    discards,
    crashes,
    keepRate,
    bestSharpe,
    avgSharpe,
    consistency,
    variance,
    trajectory,
    recentTrajectory,
    experimentsSinceLastKeep,
    keepsInLast20,
    keepsInLast30,
    keepsInLast50,
    keepRateLast20,
    keepRateLast30,
    keepRateLast50,
    strategies,
    firstTimestamp: agentExps[0]?.timestamp,
    lastTimestamp: agentExps[agentExps.length - 1]?.timestamp,
  };
}

// ─── Rating System ───────────────────────────────────────

function rateAgent(metrics) {
  if (!metrics || metrics.total === 0) {
    return { grade: "N/A", reason: "No experiments recorded" };
  }

  const {
    keepRate, trajectory, recentTrajectory, bestSharpe,
    keepsInLast20, keepsInLast30, keepsInLast50,
    keepRateLast20, keepRateLast30, total,
  } = metrics;

  const improving = trajectory === 1 || recentTrajectory === 1;

  // F: Zero keeps in last 50 experiments OR negative trajectory
  if (total >= 50 && keepsInLast50 === 0) {
    return { grade: "F", reason: `Zero keeps in last ${Math.min(total, 50)} experiments` };
  }
  if (total >= 10 && trajectory === -1 && recentTrajectory === -1 && keepRate < 0.05) {
    return { grade: "F", reason: "Negative trajectory with <5% keep rate" };
  }

  // A: Keep rate > 20% AND improving Sharpe AND best Sharpe > -0.5
  if (keepRate > 0.20 && improving && bestSharpe > -0.5) {
    return { grade: "A", reason: `Keep rate ${(keepRate * 100).toFixed(1)}%, improving trajectory, best Sharpe ${bestSharpe.toFixed(4)}` };
  }

  // B: Keep rate > 10% OR improving trajectory
  if (keepRate > 0.10 || improving) {
    const reasons = [];
    if (keepRate > 0.10) reasons.push(`Keep rate ${(keepRate * 100).toFixed(1)}%`);
    if (improving) reasons.push("Improving trajectory");
    return { grade: "B", reason: reasons.join(", ") };
  }

  // D: Keep rate < 5%, no improvement in last 30 experiments
  if (keepRate < 0.05 && total >= 30 && keepsInLast30 === 0) {
    return { grade: "D", reason: `Keep rate ${(keepRate * 100).toFixed(1)}%, no keeps in last 30` };
  }

  // C: Keep rate > 5%, no improvement in last 20 experiments
  if (keepRate >= 0.05 || (total < 30 && keepsInLast20 === 0)) {
    return { grade: "C", reason: `Keep rate ${(keepRate * 100).toFixed(1)}%, stagnating` };
  }

  // Default to C for anything that doesn't clearly fit
  return { grade: "C", reason: `Keep rate ${(keepRate * 100).toFixed(1)}%, needs evaluation` };
}

// ─── Actions ─────────────────────────────────────────────

function determineActions(grade, metrics) {
  const actions = [];
  const defaultIterations = 5;

  switch (grade) {
    case "A":
      actions.push({
        type: "increase_iterations",
        detail: "Increase iterations per cycle to 8",
        iterations: 8,
      });
      actions.push({
        type: "promote_to_ensemble",
        detail: "Promote best strategy to ensemble consideration",
      });
      break;

    case "B":
      actions.push({
        type: "maintain",
        detail: "Maintain current allocation",
        iterations: defaultIterations,
      });
      break;

    case "C":
      actions.push({
        type: "reduce_iterations",
        detail: "Reduce iterations per cycle to 3",
        iterations: 3,
      });
      actions.push({
        type: "watchlist",
        detail: "Add to performance watchlist",
      });
      break;

    case "D":
      actions.push({
        type: "reset_strategy",
        detail: "Reset strategy to baseline template",
        iterations: 3,
      });
      actions.push({
        type: "reassign_symbol",
        detail: "Consider reassigning to different symbol/market",
      });
      actions.push({
        type: "create_issue",
        detail: "Create improvement plan issue in Paperclip",
      });
      break;

    case "F":
      actions.push({
        type: "fire",
        detail: "Pause agent in Paperclip, reallocate budget to A-rated agents",
        iterations: 0,
      });
      break;

    default:
      actions.push({
        type: "observe",
        detail: "Insufficient data — continue observing",
        iterations: defaultIterations,
      });
  }

  return actions;
}

// ─── Auto-Hire Logic ─────────────────────────────────────

function generateHireRecommendations(reviews) {
  const recommendations = [];
  const ratedAgents = reviews.filter(r => r.metrics);

  // If all agents are B+ rated, suggest hiring
  const activeGrades = ratedAgents.map(r => r.rating.grade);
  const allBPlus = activeGrades.length > 0 &&
    activeGrades.every(g => g === "A" || g === "B");

  if (allBPlus && ratedAgents.length >= 3) {
    recommendations.push({
      type: "hire_new",
      reason: "All agents performing at B+ level — team has capacity for expansion",
      suggestion: "Consider hiring a specialist for an uncovered market segment",
    });
  }

  // Identify strategy gaps
  const allStrategies = new Set();
  const coveredStrategies = new Set();
  const STRATEGY_UNIVERSE = [
    "mean_reversion", "momentum_crossover", "price_channel",
    "rsi_contrarian", "adaptive_momentum", "volatility_breakout",
    "btc_ma_crossover", "btc_order_flow", "btc_bollinger",
    "btc_rsi", "btc_vwap_reversion",
  ];

  for (const r of ratedAgents) {
    if (r.metrics) {
      for (const s of r.metrics.strategies) coveredStrategies.add(s);
    }
  }

  const uncovered = STRATEGY_UNIVERSE.filter(s => !coveredStrategies.has(s));
  if (uncovered.length > 0) {
    recommendations.push({
      type: "coverage_gap",
      reason: `${uncovered.length} strategies have no agent coverage`,
      uncoveredStrategies: uncovered,
      suggestion: `Hire specialists for: ${uncovered.slice(0, 3).join(", ")}`,
    });
  }

  // Check for agents with no data (listed but never run)
  const agentsWithNoData = KNOWN_AGENTS.filter(
    a => !ratedAgents.find(r => r.agent === a)
  );
  if (agentsWithNoData.length > 0) {
    recommendations.push({
      type: "inactive_agents",
      reason: `${agentsWithNoData.length} registered agents have never run`,
      agents: agentsWithNoData,
      suggestion: "Either activate or decommission these agents",
    });
  }

  return recommendations;
}

// ─── Report Formatting ──────────────────────────────────

function trajectorySymbol(t) {
  if (t === 1) return "^"; // improving
  if (t === -1) return "v"; // declining
  return "-"; // flat
}

function gradeEmoji(grade) {
  const map = { A: "S", B: "+", C: "~", D: "!", F: "X", "N/A": "?" };
  return map[grade] || "?";
}

function formatReportCard(review) {
  const { agent, metrics, rating, actions } = review;
  let card = "";

  card += `[${gradeEmoji(rating.grade)}] ${agent} — Grade: ${rating.grade}\n`;

  if (!metrics) {
    card += `    No experiment data available.\n`;
    return card;
  }

  card += `    Experiments: ${metrics.total} | Kept: ${metrics.keeps} | Discarded: ${metrics.discards}\n`;
  card += `    Keep Rate: ${(metrics.keepRate * 100).toFixed(1)}%\n`;
  card += `    Best Sharpe: ${isFinite(metrics.bestSharpe) ? metrics.bestSharpe.toFixed(4) : "N/A"}`;
  card += ` | Avg: ${isFinite(metrics.avgSharpe) ? metrics.avgSharpe.toFixed(4) : "N/A"}\n`;
  card += `    Consistency: ${(metrics.consistency * 100).toFixed(0)}%`;
  card += ` | Trajectory: ${trajectorySymbol(metrics.trajectory)}`;
  card += ` | Recent: ${trajectorySymbol(metrics.recentTrajectory)}\n`;
  card += `    Since last keep: ${metrics.experimentsSinceLastKeep} experiments\n`;
  card += `    Strategies: ${metrics.strategies.join(", ")}\n`;
  card += `    Rating reason: ${rating.reason}\n`;

  if (actions.length > 0) {
    card += `    Actions:\n`;
    for (const a of actions) {
      card += `      -> ${a.detail}\n`;
    }
  }

  return card;
}

function formatFullReport(reviews, hireRecs) {
  const now = new Date().toISOString();
  let report = "";

  report += `========================================\n`;
  report += `  AGENT PERFORMANCE REVIEW\n`;
  report += `  ${now}\n`;
  report += `========================================\n\n`;

  // Sort by grade (A first)
  const gradeOrder = { A: 0, B: 1, C: 2, D: 3, F: 4, "N/A": 5 };
  const sorted = [...reviews].sort(
    (a, b) => (gradeOrder[a.rating.grade] ?? 5) - (gradeOrder[b.rating.grade] ?? 5)
  );

  // Grade distribution
  const gradeCounts = {};
  for (const r of reviews) {
    gradeCounts[r.rating.grade] = (gradeCounts[r.rating.grade] || 0) + 1;
  }
  report += `GRADE DISTRIBUTION: `;
  for (const g of ["A", "B", "C", "D", "F", "N/A"]) {
    if (gradeCounts[g]) report += `${g}:${gradeCounts[g]} `;
  }
  report += `\n\n`;

  // Team summary
  const withMetrics = reviews.filter(r => r.metrics);
  if (withMetrics.length > 0) {
    const totalExps = withMetrics.reduce((s, r) => s + r.metrics.total, 0);
    const totalKeeps = withMetrics.reduce((s, r) => s + r.metrics.keeps, 0);
    const teamKeepRate = totalExps > 0 ? totalKeeps / totalExps : 0;
    const bestOverall = withMetrics.reduce(
      (best, r) => r.metrics.bestSharpe > best ? r.metrics.bestSharpe : best,
      -Infinity
    );

    report += `TEAM SUMMARY\n`;
    report += `  Active agents: ${withMetrics.length}/${KNOWN_AGENTS.length + SPECIALIST_AGENTS.length}\n`;
    report += `  Total experiments: ${totalExps}\n`;
    report += `  Total keeps: ${totalKeeps}\n`;
    report += `  Team keep rate: ${(teamKeepRate * 100).toFixed(1)}%\n`;
    report += `  Best Sharpe (team): ${isFinite(bestOverall) ? bestOverall.toFixed(4) : "N/A"}\n`;
    report += `\n`;
  }

  report += `────────────────────────────────────────\n`;
  report += `INDIVIDUAL REPORT CARDS\n`;
  report += `────────────────────────────────────────\n\n`;

  for (const r of sorted) {
    report += formatReportCard(r);
    report += `\n`;
  }

  // Hire recommendations
  if (hireRecs.length > 0) {
    report += `────────────────────────────────────────\n`;
    report += `WORKFORCE RECOMMENDATIONS\n`;
    report += `────────────────────────────────────────\n\n`;
    for (const rec of hireRecs) {
      report += `  [${rec.type.toUpperCase()}]\n`;
      report += `    ${rec.reason}\n`;
      report += `    Suggestion: ${rec.suggestion}\n`;
      if (rec.uncoveredStrategies) {
        report += `    Uncovered: ${rec.uncoveredStrategies.join(", ")}\n`;
      }
      if (rec.agents) {
        report += `    Agents: ${rec.agents.join(", ")}\n`;
      }
      report += `\n`;
    }
  }

  report += `========================================\n`;
  report += `  END OF REVIEW\n`;
  report += `========================================\n`;

  return report;
}

function formatTelegramReport(reviews, hireRecs) {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  let msg = `*Agent Performance Review*\n${now}\n\n`;

  // Grade distribution
  const gradeCounts = {};
  for (const r of reviews) {
    gradeCounts[r.rating.grade] = (gradeCounts[r.rating.grade] || 0) + 1;
  }
  msg += `*Grades:* `;
  for (const g of ["A", "B", "C", "D", "F"]) {
    if (gradeCounts[g]) msg += `${g}:${gradeCounts[g]} `;
  }
  msg += `\n\n`;

  // Individual grades
  const gradeOrder = { A: 0, B: 1, C: 2, D: 3, F: 4, "N/A": 5 };
  const sorted = [...reviews].sort(
    (a, b) => (gradeOrder[a.rating.grade] ?? 5) - (gradeOrder[b.rating.grade] ?? 5)
  );

  for (const r of sorted) {
    if (!r.metrics) {
      msg += `*${r.rating.grade}* ${r.agent} — no data\n`;
      continue;
    }
    const kr = (r.metrics.keepRate * 100).toFixed(0);
    const bs = isFinite(r.metrics.bestSharpe) ? r.metrics.bestSharpe.toFixed(3) : "N/A";
    const traj = trajectorySymbol(r.metrics.trajectory);
    msg += `*${r.rating.grade}* ${r.agent}: ${kr}% keep, Sharpe ${bs} ${traj}\n`;
  }

  // Key actions
  const fireTargets = reviews.filter(r => r.rating.grade === "F");
  const promoteTargets = reviews.filter(r => r.rating.grade === "A");
  if (fireTargets.length > 0 || promoteTargets.length > 0) {
    msg += `\n*Actions:*\n`;
    for (const r of promoteTargets) {
      msg += `  Promote: ${r.agent}\n`;
    }
    for (const r of fireTargets) {
      msg += `  Fire: ${r.agent}\n`;
    }
  }

  if (hireRecs.length > 0) {
    msg += `\n*Hiring:*\n`;
    for (const rec of hireRecs) {
      msg += `  ${rec.suggestion}\n`;
    }
  }

  return msg;
}

// ─── Paperclip Integration ──────────────────────────────

async function getPaperclipAgents(baseUrl) {
  try {
    const companiesRes = await fetch(`${baseUrl}/api/companies`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!companiesRes.ok) return null;
    const companies = await companiesRes.json();
    if (!companies?.length) return null;

    const company = companies[0];
    const agentsRes = await fetch(`${baseUrl}/api/companies/${company.id}/agents`, {
      signal: AbortSignal.timeout(5000),
    });
    const agents = await agentsRes.json();
    return { company, agents };
  } catch {
    return null;
  }
}

async function pauseAgent(baseUrl, companyId, agentId) {
  try {
    const res = await fetch(`${baseUrl}/api/companies/${companyId}/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function createIssue(baseUrl, companyId, agentName, plan) {
  try {
    const res = await fetch(`${baseUrl}/api/companies/${companyId}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Performance improvement plan: ${agentName}`,
        description: plan,
        priority: "high",
        agent: agentName,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function executeActions(reviews, paperclipUrl) {
  const results = [];
  const paperclip = await getPaperclipAgents(paperclipUrl);

  for (const review of reviews) {
    const { agent, rating, actions } = review;

    for (const action of actions) {
      const result = { agent, action: action.type, status: "skipped", detail: action.detail };

      if (action.type === "fire" && paperclip) {
        const pcAgent = paperclip.agents.find(
          a => a.name === agent || a.role === agent
        );
        if (pcAgent) {
          const ok = await pauseAgent(paperclipUrl, paperclip.company.id, pcAgent.id);
          result.status = ok ? "executed" : "failed";
        } else {
          result.status = "agent_not_found_in_paperclip";
        }
      }

      if (action.type === "create_issue" && paperclip) {
        const plan = [
          `Agent ${agent} rated ${rating.grade}: ${rating.reason}`,
          `Recommended: ${actions.map(a => a.detail).join("; ")}`,
          `Review date: ${new Date().toISOString()}`,
        ].join("\n");
        const ok = await createIssue(paperclipUrl, paperclip.company.id, agent, plan);
        result.status = ok ? "executed" : "failed";
      }

      results.push(result);
    }
  }

  return results;
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
    return true;
  } catch (err) {
    console.error(`Telegram send failed: ${err.message}`);
    return false;
  }
}

// ─── Daemon Integration Export ───────────────────────────

/**
 * Called by daemon after each full rotation.
 * Returns adjusted iteration counts per agent.
 *
 * Usage in daemon.mjs:
 *   import { reviewAndAdjust } from "./management/performance-review.mjs";
 *   const adjustments = reviewAndAdjust();
 *   // adjustments = { alpha_researcher: 8, stat_arb_quant: 5, ... }
 */
export function reviewAndAdjust() {
  try {
    const experiments = loadResults();
    const allAgents = [...new Set([...KNOWN_AGENTS, ...SPECIALIST_AGENTS])];
    const adjustments = {};

    for (const agent of allAgents) {
      const metrics = computeAgentMetrics(agent, experiments);
      const rating = rateAgent(metrics);
      const actions = determineActions(rating.grade, metrics);

      // Find iteration adjustment
      const iterAction = actions.find(a => a.iterations !== undefined);
      adjustments[agent] = {
        iterations: iterAction ? iterAction.iterations : 5,
        grade: rating.grade,
      };
    }

    return adjustments;
  } catch (err) {
    console.error(`Performance review failed: ${err.message}`);
    return null;
  }
}

/**
 * Full review returning structured data for programmatic use.
 */
export function runReview(agentFilter = null) {
  const experiments = loadResults();
  const allAgents = agentFilter
    ? [agentFilter]
    : [...new Set([
        ...KNOWN_AGENTS,
        ...SPECIALIST_AGENTS,
        ...experiments.map(e => e.agent).filter(a => !a.startsWith("ensemble_")),
      ])];

  const reviews = [];
  for (const agent of allAgents) {
    const metrics = computeAgentMetrics(agent, experiments);
    const rating = rateAgent(metrics);
    const actions = determineActions(rating.grade, metrics);
    reviews.push({ agent, metrics, rating, actions });
  }

  const hireRecs = agentFilter ? [] : generateHireRecommendations(reviews);
  return { reviews, hireRecs };
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  const { reviews, hireRecs } = runReview(opts.agent);

  // Execute actions if requested
  if (opts.actions) {
    console.log("Executing recommended actions...\n");
    const results = await executeActions(reviews, opts.paperclipUrl);
    for (const r of results) {
      console.log(`  [${r.status.toUpperCase()}] ${r.agent}: ${r.action} — ${r.detail}`);
    }
    console.log();
  }

  // Output
  if (opts.json) {
    console.log(JSON.stringify({ reviews, hireRecs }, null, 2));
    return;
  }

  if (opts.telegram) {
    const msg = formatTelegramReport(reviews, hireRecs);
    if (opts.telegramToken && opts.telegramChatId) {
      const ok = await sendTelegram(opts.telegramToken, opts.telegramChatId, msg);
      if (ok) {
        console.log("Report sent to Telegram.");
      } else {
        console.error("Failed to send Telegram report. Printing to stdout:\n");
        console.log(msg);
      }
    } else {
      console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required.\n");
      console.log(msg);
    }
    return;
  }

  // Default: print full report
  const report = formatFullReport(reviews, hireRecs);
  console.log(report);
}

main().catch(err => {
  console.error(`Performance review failed: ${err.message}`);
  process.exit(1);
});
