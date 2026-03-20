#!/usr/bin/env node
/**
 * Risk Monitor — Real-Time Portfolio Risk Surveillance
 *
 * Monitors active strategy portfolio for risk breaches:
 *   - Portfolio drawdown vs threshold
 *   - Strategy correlation spikes (>0.8)
 *   - Single strategy daily loss limits
 *   - Portfolio volatility vs target
 *   - Exposure and Greeks-equivalent metrics
 *
 * Reads from results.tsv and strategy files to build risk picture.
 *
 * Usage:
 *   node agents/risk/risk-monitor.mjs                          # Default thresholds
 *   node agents/risk/risk-monitor.mjs --threshold 0.05         # 5% drawdown threshold
 *   node agents/risk/risk-monitor.mjs --telegram               # Send alerts via Telegram
 *   node agents/risk/risk-monitor.mjs --watch 60               # Re-check every 60 seconds
 *   node agents/risk/risk-monitor.mjs --help
 *
 * Can also be imported:
 *   import { checkPortfolioRisk, computeCorrelationMatrix } from './risk-monitor.mjs'
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const RESULTS_TSV = join(AGENTS_DIR, "results.tsv");

// ---- Configuration defaults ----

const DEFAULT_CONFIG = {
  drawdownThreshold: 0.05,    // 5% portfolio drawdown alert
  correlationThreshold: 0.80, // Alert when strategy correlation > 0.8
  dailyLossLimit: 0.02,       // 2% single-strategy daily loss limit
  targetVol: 0.10,            // 10% annualized target vol
  volBreachMultiple: 1.5,     // Alert when vol exceeds target by 50%+
  maxSingleExposure: 0.25,    // 25% max single-strategy exposure
  maxGrossExposure: 1.0,      // 100% max gross exposure (no leverage)
};

// ---- Results.tsv Parser ----

/**
 * Parse results.tsv into structured experiment records.
 */
function loadExperiments() {
  if (!existsSync(RESULTS_TSV)) return [];

  const raw = readFileSync(RESULTS_TSV, "utf-8").trim();
  const lines = raw.split("\n");
  if (lines.length < 2) return [];

  const header = lines[0].split("\t");
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length < 6) continue;

    records.push({
      timestamp: parts[0],
      agent: parts[1],
      experiment: parts[2],
      sharpe: parseFloat(parts[3]) || 0,
      sortino: parseFloat(parts[4]) || 0,
      calmar: parseFloat(parts[5]) || 0,
      totalReturn: parseFloat(parts[6]) || 0,
      maxDrawdown: Math.abs(parseFloat(parts[7]) || 0),
      winRate: parseFloat(parts[8]) || 0,
      trades: parseInt(parts[9]) || 0,
      status: parts[10] || "unknown",
    });
  }

  return records;
}

/**
 * Group experiments by agent and compute per-agent metrics.
 */
function buildStrategyProfiles(experiments) {
  const byAgent = {};

  for (const exp of experiments) {
    if (!byAgent[exp.agent]) byAgent[exp.agent] = [];
    byAgent[exp.agent].push(exp);
  }

  const profiles = {};

  for (const [agent, exps] of Object.entries(byAgent)) {
    const sharpes = exps.map(e => e.sharpe).filter(s => isFinite(s));
    const returns = exps.map(e => e.totalReturn).filter(r => isFinite(r));
    const drawdowns = exps.map(e => e.maxDrawdown).filter(d => isFinite(d) && d > 0);
    const winRates = exps.map(e => e.winRate).filter(w => w > 0);

    const meanSharpe = sharpes.length > 0
      ? sharpes.reduce((s, v) => s + v, 0) / sharpes.length : 0;
    const meanReturn = returns.length > 0
      ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
    const maxDD = drawdowns.length > 0
      ? Math.max(...drawdowns) : 0;
    const meanWinRate = winRates.length > 0
      ? winRates.reduce((s, v) => s + v, 0) / winRates.length : 0.5;

    // Volatility proxy: standard deviation of returns across experiments
    const returnVol = stddev(returns);

    // Sharpe vol: volatility of sharpe ratios across experiments
    const sharpeVol = stddev(sharpes);

    // Recent performance (last 5 experiments)
    const recent = exps.slice(-5);
    const recentReturns = recent.map(e => e.totalReturn).filter(r => isFinite(r));
    const recentMeanReturn = recentReturns.length > 0
      ? recentReturns.reduce((s, v) => s + v, 0) / recentReturns.length : 0;

    // Keeps vs discards
    const keeps = exps.filter(e => e.status === "keep").length;
    const discards = exps.filter(e => e.status === "discard" || e.status === "crash").length;

    profiles[agent] = {
      name: agent,
      experimentCount: exps.length,
      meanSharpe,
      meanReturn,
      recentMeanReturn,
      maxDrawdown: maxDD,
      meanWinRate,
      returnVol,
      sharpeVol,
      keeps,
      discards,
      keepRate: (keeps + discards) > 0 ? keeps / (keeps + discards) : 0,
      returnSeries: returns,
      sharpeSeries: sharpes,
      lastExperiment: exps[exps.length - 1],
    };
  }

  return profiles;
}

// ---- Math Helpers ----

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Compute Pearson correlation between two arrays.
 */
function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  const xs = x.slice(-n);
  const ys = y.slice(-n);

  const mx = mean(xs);
  const my = mean(ys);

  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }

  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return 0;

  return num / denom;
}

// ---- Exported Risk Functions ----

/**
 * Compute correlation matrix between all strategy return series.
 *
 * @param {Object} profiles - Strategy profiles from buildStrategyProfiles
 * @returns {{ names: string[], matrix: number[][] }} Correlation matrix
 */
export function computeCorrelationMatrix(profiles) {
  const names = Object.keys(profiles);
  const n = names.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1.0;
      } else if (j > i) {
        const corr = pearsonCorrelation(
          profiles[names[i]].returnSeries,
          profiles[names[j]].returnSeries
        );
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }
  }

  return { names, matrix };
}

/**
 * Compute portfolio-level exposure and Greeks-equivalent risk metrics.
 *
 * "Greeks-equivalent" for a quant strategy portfolio:
 *   - Delta:  net directional exposure (sum of return sensitivities)
 *   - Gamma:  convexity of returns (how non-linear are strategy payoffs)
 *   - Theta:  time decay proxy (performance degradation over recent windows)
 *   - Vega:   sensitivity to volatility changes
 *
 * @param {Object} profiles - Strategy profiles
 * @param {number[]} weights - Portfolio weights per strategy
 * @returns {Object} Greeks-equivalent metrics
 */
export function computeGreeksEquivalent(profiles, weights) {
  const names = Object.keys(profiles);
  if (names.length === 0) return { delta: 0, gamma: 0, theta: 0, vega: 0 };

  const w = weights || names.map(() => 1 / names.length);

  // Delta: weighted average recent return (directional bias)
  let delta = 0;
  for (let i = 0; i < names.length; i++) {
    delta += w[i] * profiles[names[i]].recentMeanReturn;
  }

  // Gamma: weighted average of return kurtosis proxy
  // (difference between mean of squared returns and squared mean of returns)
  let gamma = 0;
  for (let i = 0; i < names.length; i++) {
    const returns = profiles[names[i]].returnSeries;
    if (returns.length < 3) continue;
    const m = mean(returns);
    const m2 = mean(returns.map(r => r * r));
    gamma += w[i] * (m2 - m * m);
  }

  // Theta: performance decay — difference between all-time mean and recent mean
  let theta = 0;
  for (let i = 0; i < names.length; i++) {
    const p = profiles[names[i]];
    theta += w[i] * (p.recentMeanReturn - p.meanReturn);
  }

  // Vega: weighted average return volatility (sensitivity to vol)
  let vega = 0;
  for (let i = 0; i < names.length; i++) {
    vega += w[i] * profiles[names[i]].returnVol;
  }

  return {
    delta: round4(delta),
    gamma: round4(gamma),
    theta: round4(theta),
    vega: round4(vega),
  };
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Main portfolio risk check. Returns alerts and metrics.
 *
 * @param {Object} config - Risk thresholds (merged with defaults)
 * @returns {{ alerts: Array, metrics: Object, profiles: Object }}
 */
export function checkPortfolioRisk(config = {}) {
  const C = { ...DEFAULT_CONFIG, ...config };
  const experiments = loadExperiments();

  if (experiments.length === 0) {
    return {
      alerts: [{ level: "info", message: "No experiment data found in results.tsv" }],
      metrics: {},
      profiles: {},
    };
  }

  const profiles = buildStrategyProfiles(experiments);
  const names = Object.keys(profiles);
  const alerts = [];

  // Equal weights as default (no live position data — use equal allocation)
  const weights = names.map(() => 1 / names.length);

  // --- Check 1: Portfolio drawdown ---
  const portfolioDD = computePortfolioDrawdown(profiles, weights);
  if (portfolioDD > C.drawdownThreshold) {
    alerts.push({
      level: "critical",
      type: "drawdown",
      message: `Portfolio drawdown ${(portfolioDD * 100).toFixed(2)}% exceeds threshold ${(C.drawdownThreshold * 100).toFixed(1)}%`,
      value: portfolioDD,
      threshold: C.drawdownThreshold,
    });
  }

  // --- Check 2: Correlation spikes ---
  const { names: corrNames, matrix } = computeCorrelationMatrix(profiles);
  for (let i = 0; i < corrNames.length; i++) {
    for (let j = i + 1; j < corrNames.length; j++) {
      if (Math.abs(matrix[i][j]) > C.correlationThreshold) {
        alerts.push({
          level: "warning",
          type: "correlation",
          message: `Correlation spike: ${corrNames[i]} <-> ${corrNames[j]} = ${matrix[i][j].toFixed(3)} (threshold: ${C.correlationThreshold})`,
          pair: [corrNames[i], corrNames[j]],
          value: matrix[i][j],
          threshold: C.correlationThreshold,
        });
      }
    }
  }

  // --- Check 3: Single strategy daily loss ---
  for (const name of names) {
    const p = profiles[name];
    const recentLoss = p.recentMeanReturn;
    if (recentLoss < -C.dailyLossLimit) {
      alerts.push({
        level: "warning",
        type: "daily_loss",
        message: `${name} recent avg return ${(recentLoss * 100).toFixed(2)}% exceeds daily loss limit ${(C.dailyLossLimit * 100).toFixed(1)}%`,
        strategy: name,
        value: recentLoss,
        threshold: -C.dailyLossLimit,
      });
    }
  }

  // --- Check 4: Portfolio vol vs target ---
  const portfolioVol = computePortfolioVolatility(profiles, weights);
  const volBreachLevel = C.targetVol * C.volBreachMultiple;
  if (portfolioVol > volBreachLevel) {
    alerts.push({
      level: "critical",
      type: "volatility",
      message: `Portfolio vol ${(portfolioVol * 100).toFixed(2)}% exceeds ${(C.volBreachMultiple * 100).toFixed(0)}% of target (${(C.targetVol * 100).toFixed(1)}% target, breach at ${(volBreachLevel * 100).toFixed(1)}%)`,
      value: portfolioVol,
      threshold: volBreachLevel,
    });
  }

  // --- Check 5: Single strategy exposure ---
  for (let i = 0; i < names.length; i++) {
    if (weights[i] > C.maxSingleExposure) {
      alerts.push({
        level: "warning",
        type: "exposure",
        message: `${names[i]} exposure ${(weights[i] * 100).toFixed(1)}% exceeds max ${(C.maxSingleExposure * 100).toFixed(0)}%`,
        strategy: names[i],
        value: weights[i],
        threshold: C.maxSingleExposure,
      });
    }
  }

  // --- Compute Greeks-equivalent ---
  const greeks = computeGreeksEquivalent(profiles, weights);

  // --- Build metrics summary ---
  const metrics = {
    strategyCount: names.length,
    totalExperiments: experiments.length,
    portfolioDrawdown: round4(portfolioDD),
    portfolioVol: round4(portfolioVol),
    targetVol: C.targetVol,
    volRatio: portfolioVol > 0 ? round4(portfolioVol / C.targetVol) : 0,
    grossExposure: round4(weights.reduce((s, w) => s + Math.abs(w), 0)),
    greeks,
    correlationMatrix: { names: corrNames, matrix },
    weights: Object.fromEntries(names.map((n, i) => [n, round4(weights[i])])),
  };

  return { alerts, metrics, profiles };
}

// ---- Portfolio-Level Computations ----

/**
 * Estimate portfolio max drawdown from weighted strategy drawdowns.
 * Conservative: uses correlated worst case (sum of weighted drawdowns).
 */
function computePortfolioDrawdown(profiles, weights) {
  const names = Object.keys(profiles);
  let portDD = 0;
  for (let i = 0; i < names.length; i++) {
    portDD += weights[i] * profiles[names[i]].maxDrawdown;
  }
  return portDD;
}

/**
 * Estimate portfolio volatility.
 * vol_p = sqrt(sum(w_i^2 * vol_i^2)) — assumes zero correlation (optimistic).
 */
function computePortfolioVolatility(profiles, weights) {
  const names = Object.keys(profiles);
  let variance = 0;
  for (let i = 0; i < names.length; i++) {
    const vol = profiles[names[i]].returnVol || 0.15;
    variance += weights[i] ** 2 * vol ** 2;
  }
  return Math.sqrt(variance);
}

// ---- Output Formatters ----

/**
 * Format risk report for stdout (human readable).
 */
function formatStdout(result) {
  const { alerts, metrics, profiles } = result;
  const lines = [];

  lines.push("=".repeat(70));
  lines.push("  RISK MONITOR — Portfolio Surveillance Report");
  lines.push("=".repeat(70));
  lines.push(`  Timestamp:       ${new Date().toISOString()}`);
  lines.push(`  Strategies:      ${metrics.strategyCount}`);
  lines.push(`  Experiments:     ${metrics.totalExperiments}`);
  lines.push("=".repeat(70));

  // Alerts
  lines.push("");
  if (alerts.length === 0) {
    lines.push("  [OK] No risk alerts triggered.");
  } else {
    lines.push(`  [!!] ${alerts.length} ALERT(S) TRIGGERED:`);
    lines.push("");
    for (const a of alerts) {
      const icon = a.level === "critical" ? "CRITICAL" : "WARNING ";
      lines.push(`    [${icon}] ${a.message}`);
    }
  }

  // Portfolio Metrics
  lines.push("");
  lines.push("--- Portfolio Metrics ---");
  lines.push("");
  lines.push(`  Drawdown:        ${(metrics.portfolioDrawdown * 100).toFixed(2)}%`);
  lines.push(`  Volatility:      ${(metrics.portfolioVol * 100).toFixed(2)}% (target: ${(metrics.targetVol * 100).toFixed(1)}%, ratio: ${metrics.volRatio.toFixed(2)}x)`);
  lines.push(`  Gross Exposure:  ${(metrics.grossExposure * 100).toFixed(1)}%`);

  // Greeks-equivalent
  lines.push("");
  lines.push("--- Greeks-Equivalent Metrics ---");
  lines.push("");
  const g = metrics.greeks;
  lines.push(`  Delta (directional bias):    ${g.delta >= 0 ? "+" : ""}${(g.delta * 100).toFixed(2)}%`);
  lines.push(`  Gamma (return convexity):    ${(g.gamma * 100).toFixed(4)}%`);
  lines.push(`  Theta (performance decay):   ${g.theta >= 0 ? "+" : ""}${(g.theta * 100).toFixed(2)}%`);
  lines.push(`  Vega  (vol sensitivity):     ${(g.vega * 100).toFixed(2)}%`);

  // Per-Strategy Breakdown
  lines.push("");
  lines.push("--- Per-Strategy Risk Profile ---");
  lines.push("");
  lines.push(
    "Strategy".padEnd(25) +
    "Exps".padStart(6) +
    "KeepRt".padStart(8) +
    "Sharpe".padStart(8) +
    "MaxDD".padStart(8) +
    "RetVol".padStart(8) +
    "Weight".padStart(8)
  );
  lines.push("-".repeat(71));

  const names = Object.keys(profiles);
  for (const name of names) {
    const p = profiles[name];
    const w = metrics.weights[name] || 0;
    lines.push(
      name.padEnd(25) +
      String(p.experimentCount).padStart(6) +
      ((p.keepRate * 100).toFixed(1) + "%").padStart(8) +
      p.meanSharpe.toFixed(4).padStart(8) +
      (p.maxDrawdown * 100).toFixed(1).padStart(7) + "%" +
      (p.returnVol * 100).toFixed(1).padStart(7) + "%" +
      (w * 100).toFixed(1).padStart(7) + "%"
    );
  }

  // Correlation Matrix
  const corr = metrics.correlationMatrix;
  if (corr.names.length > 1) {
    lines.push("");
    lines.push("--- Correlation Matrix ---");
    lines.push("");

    // Header
    const nameWidth = 20;
    const cellWidth = 10;
    let header = "".padEnd(nameWidth);
    for (const n of corr.names) {
      header += n.slice(0, cellWidth - 1).padStart(cellWidth);
    }
    lines.push(header);
    lines.push("-".repeat(nameWidth + corr.names.length * cellWidth));

    for (let i = 0; i < corr.names.length; i++) {
      let row = corr.names[i].padEnd(nameWidth);
      for (let j = 0; j < corr.names.length; j++) {
        const val = corr.matrix[i][j];
        const fmt = (i === j ? "1.000" : val.toFixed(3));
        row += fmt.padStart(cellWidth);
      }
      lines.push(row);
    }
  }

  lines.push("");
  lines.push("=".repeat(70));

  return lines.join("\n");
}

/**
 * Format risk report for Telegram (Markdown).
 */
function formatTelegram(result) {
  const { alerts, metrics, profiles } = result;
  let msg = "";

  msg += "*Risk Monitor Report*\n";
  msg += `${new Date().toISOString()}\n\n`;

  // Alerts
  if (alerts.length === 0) {
    msg += "All clear - no risk alerts.\n\n";
  } else {
    msg += `*${alerts.length} ALERT(S):*\n`;
    for (const a of alerts) {
      const icon = a.level === "critical" ? "[CRITICAL]" : "[WARNING]";
      msg += `${icon} ${a.message}\n`;
    }
    msg += "\n";
  }

  // Key metrics
  msg += "*Portfolio Metrics*\n";
  msg += `  Drawdown: ${(metrics.portfolioDrawdown * 100).toFixed(2)}%\n`;
  msg += `  Vol: ${(metrics.portfolioVol * 100).toFixed(2)}% (target ${(metrics.targetVol * 100).toFixed(1)}%)\n`;
  msg += `  Exposure: ${(metrics.grossExposure * 100).toFixed(1)}%\n\n`;

  // Greeks
  const g = metrics.greeks;
  msg += "*Greeks-Equivalent*\n";
  msg += `  Delta: ${g.delta >= 0 ? "+" : ""}${(g.delta * 100).toFixed(2)}%\n`;
  msg += `  Gamma: ${(g.gamma * 100).toFixed(4)}%\n`;
  msg += `  Theta: ${g.theta >= 0 ? "+" : ""}${(g.theta * 100).toFixed(2)}%\n`;
  msg += `  Vega: ${(g.vega * 100).toFixed(2)}%\n\n`;

  // Strategy summary
  msg += "*Strategies*\n";
  for (const [name, p] of Object.entries(profiles)) {
    msg += `  ${name}: Sharpe ${p.meanSharpe.toFixed(3)} | DD ${(p.maxDrawdown * 100).toFixed(1)}% | Keep ${(p.keepRate * 100).toFixed(0)}%\n`;
  }

  // Correlation alerts
  const corrAlerts = alerts.filter(a => a.type === "correlation");
  if (corrAlerts.length > 0) {
    msg += "\n*Correlation Spikes*\n";
    for (const a of corrAlerts) {
      msg += `  ${a.pair[0]} <-> ${a.pair[1]}: ${a.value.toFixed(3)}\n`;
    }
  }

  return msg;
}

// ---- Telegram Sender ----

async function sendTelegram(token, chatId, message) {
  if (!token || !chatId) return false;
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
      console.error(`Telegram API error: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Telegram send failed: ${err.message}`);
    return false;
  }
}

// ---- CLI ----

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    threshold: 0.05,
    correlationThreshold: 0.80,
    dailyLossLimit: 0.02,
    targetVol: 0.10,
    telegram: false,
    watch: 0,
    help: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold") opts.threshold = parseFloat(args[++i]);
    if (args[i] === "--correlation") opts.correlationThreshold = parseFloat(args[++i]);
    if (args[i] === "--daily-loss") opts.dailyLossLimit = parseFloat(args[++i]);
    if (args[i] === "--target-vol") opts.targetVol = parseFloat(args[++i]);
    if (args[i] === "--telegram") opts.telegram = true;
    if (args[i] === "--watch") opts.watch = parseInt(args[++i] || "60");
    if (args[i] === "--json") opts.json = true;
    if (args[i] === "--help" || args[i] === "-h") opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
Risk Monitor — Real-Time Portfolio Risk Surveillance

Usage:
  node agents/risk/risk-monitor.mjs [options]

Options:
  --threshold <n>       Portfolio drawdown alert threshold (default: 0.05 = 5%)
  --correlation <n>     Strategy correlation alert threshold (default: 0.80)
  --daily-loss <n>      Single-strategy daily loss limit (default: 0.02 = 2%)
  --target-vol <n>      Target portfolio vol (default: 0.10 = 10%)
  --telegram            Send alerts via Telegram (requires env vars)
  --watch <seconds>     Re-check on interval (default: off)
  --json                Output raw JSON instead of formatted report
  --help                Show this help

Environment:
  TELEGRAM_BOT_TOKEN    Telegram bot token for alert delivery
  TELEGRAM_CHAT_ID      Telegram chat ID for alert delivery

Examples:
  node agents/risk/risk-monitor.mjs --threshold 0.05
  node agents/risk/risk-monitor.mjs --telegram --watch 300
  node agents/risk/risk-monitor.mjs --json
`);
}

async function runCheck(opts) {
  const result = checkPortfolioRisk({
    drawdownThreshold: opts.threshold,
    correlationThreshold: opts.correlationThreshold,
    dailyLossLimit: opts.dailyLossLimit,
    targetVol: opts.targetVol,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const stdoutReport = formatStdout(result);
  console.log(stdoutReport);

  if (opts.telegram) {
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    const chatId = process.env.TELEGRAM_CHAT_ID || "";
    if (!token || !chatId) {
      console.error("\nTo use Telegram alerts, set:");
      console.error("  export TELEGRAM_BOT_TOKEN=your-bot-token");
      console.error("  export TELEGRAM_CHAT_ID=your-chat-id");
    } else if (result.alerts.length > 0) {
      const telegramMsg = formatTelegram(result);
      const sent = await sendTelegram(token, chatId, telegramMsg);
      console.log(sent ? "\nTelegram alert sent." : "\nTelegram alert failed.");
    } else {
      console.log("\nNo alerts to send via Telegram.");
    }
  }

  return result;
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.watch > 0) {
    console.log(`Risk monitor watching every ${opts.watch}s. Press Ctrl+C to stop.\n`);
    while (true) {
      await runCheck(opts);
      console.log(`\nNext check in ${opts.watch}s...\n`);
      await new Promise(r => setTimeout(r, opts.watch * 1000));
    }
  } else {
    await runCheck(opts);
  }
}

// Run if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("risk-monitor.mjs") ||
  process.argv[1].includes("risk-monitor")
);
if (isMain) {
  main().catch(err => {
    console.error("Risk monitor failed:", err.message);
    process.exit(1);
  });
}
