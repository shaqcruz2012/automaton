#!/usr/bin/env node
/**
 * Position Sizer & Risk Management Engine
 *
 * Computes optimal position sizes using multiple risk frameworks:
 *   - Kelly Criterion (full, half, fractional)
 *   - Risk Parity (inverse volatility weighting)
 *   - Volatility Targeting (scale to hit target annualized vol)
 *   - Maximum Drawdown Sizing (cap expected drawdown)
 *   - Combined Optimizer (blend all methods with constraints)
 *
 * Reads strategy performance data from results.tsv to calibrate sizing.
 *
 * Usage:
 *   node agents/risk/position-sizer.mjs --strategies alpha_researcher,stat_arb_quant --capital 100000
 *   node agents/risk/position-sizer.mjs --strategies polymarket_btc --capital 50000 --target-vol 0.10
 *   node agents/risk/position-sizer.mjs --help
 *
 * Can also be imported as a module:
 *   import { kellySize, riskParityWeights, optimizePositions } from './position-sizer.mjs'
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const RESULTS_TSV = join(AGENTS_DIR, "results.tsv");

// ─── Kelly Criterion ──────────────────────────────────────

/**
 * Kelly Criterion position sizing.
 *
 * f* = (p * b - q) / b
 *
 * where:
 *   p = probability of winning (win rate)
 *   b = ratio of average win to average loss
 *   q = 1 - p (probability of losing)
 *   fraction = Kelly fraction (0.5 = half Kelly, 1.0 = full Kelly)
 *
 * @param {number} winRate - Win probability (0-1)
 * @param {number} avgWin - Average winning return (positive)
 * @param {number} avgLoss - Average losing return (positive magnitude)
 * @param {number} fraction - Kelly fraction, default 0.5 (half Kelly)
 * @returns {number} Optimal fraction of capital to risk (0 to 1, clamped)
 */
export function kellySize(winRate, avgWin, avgLoss, fraction = 0.5) {
  if (winRate <= 0 || winRate >= 1) return 0;
  if (avgWin <= 0 || avgLoss <= 0) return 0;

  const p = winRate;
  const q = 1 - p;
  const b = avgWin / avgLoss;

  const fullKelly = (p * b - q) / b;

  // Negative Kelly means negative edge — don't bet
  if (fullKelly <= 0) return 0;

  // Apply fractional Kelly and clamp to [0, 1]
  return Math.min(Math.max(fullKelly * fraction, 0), 1);
}

// ─── Risk Parity ──────────────────────────────────────────

/**
 * Risk Parity weighting via inverse volatility.
 *
 * Each strategy gets weight proportional to 1/vol, so that each
 * contributes equal risk to the portfolio.
 *
 * @param {number[]} strategyVols - Array of annualized volatilities for each strategy
 * @returns {number[]} Normalized weights summing to 1
 */
export function riskParityWeights(strategyVols) {
  if (!strategyVols || strategyVols.length === 0) return [];

  // Filter out zero/negative vols — assign zero weight
  const invVols = strategyVols.map(v => (v > 0 ? 1 / v : 0));
  const total = invVols.reduce((s, w) => s + w, 0);

  if (total === 0) {
    // All vols are zero/negative — equal weight
    const n = strategyVols.length;
    return strategyVols.map(() => 1 / n);
  }

  return invVols.map(w => w / total);
}

// ─── Volatility Targeting ─────────────────────────────────

/**
 * Scale position size to hit a target portfolio volatility.
 *
 * scalar = targetVol / currentVol
 * newSize = currentSize * scalar
 *
 * @param {number} currentVol - Current realized annualized volatility
 * @param {number} targetVol - Desired annualized volatility (e.g. 0.10 = 10%)
 * @param {number} currentSize - Current position size as fraction of capital
 * @returns {number} Adjusted position size (clamped to [0, 1])
 */
export function volTargetSize(currentVol, targetVol, currentSize) {
  if (currentVol <= 0 || targetVol <= 0 || currentSize <= 0) return 0;

  const scalar = targetVol / currentVol;
  return Math.min(Math.max(currentSize * scalar, 0), 1);
}

// ─── Maximum Drawdown Sizing ──────────────────────────────

/**
 * Size position so expected max drawdown stays within limit.
 *
 * If a strategy's historical max drawdown is 20% at full size,
 * and max allowed is 5%, scale to 5/20 = 0.25 of capital.
 *
 * @param {number} expectedDD - Expected/historical max drawdown (positive, e.g. 0.20 = 20%)
 * @param {number} maxAllowedDD - Maximum acceptable drawdown (positive, e.g. 0.05 = 5%)
 * @param {number} capital - Total capital (used for absolute $ output)
 * @returns {{ fraction: number, dollars: number }} Position size
 */
export function maxDrawdownSize(expectedDD, maxAllowedDD, capital) {
  if (expectedDD <= 0 || maxAllowedDD <= 0 || capital <= 0) {
    return { fraction: 0, dollars: 0 };
  }

  const fraction = Math.min(maxAllowedDD / expectedDD, 1);
  return {
    fraction,
    dollars: fraction * capital,
  };
}

// ─── Combined Optimizer ───────────────────────────────────

/**
 * Default constraints for position sizing.
 */
const DEFAULT_CONSTRAINTS = {
  maxSinglePosition: 0.20,   // 20% max in one strategy
  minPosition: 0.01,         // 1% minimum if allocated at all
  maxLeverage: 1.0,          // No leverage (sum of weights <= 1)
  targetVol: 0.10,           // 10% annualized portfolio vol target
  maxDrawdown: 0.05,         // 5% max acceptable portfolio drawdown
  kellyFraction: 0.5,        // Half Kelly
};

/**
 * Combined position optimizer.
 *
 * Takes strategy metrics and produces constrained position sizes
 * by blending Kelly, risk parity, vol targeting, and drawdown limits.
 *
 * Algorithm:
 *   1. Compute Kelly size for each strategy (edge-based)
 *   2. Compute risk parity weights (diversification)
 *   3. Blend: 50% Kelly + 50% risk parity
 *   4. Apply vol targeting scalar
 *   5. Apply max drawdown cap per strategy
 *   6. Enforce constraints (min/max position, leverage limit)
 *
 * @param {Array<{
 *   name: string,
 *   winRate: number,
 *   avgWin: number,
 *   avgLoss: number,
 *   volatility: number,
 *   maxDrawdown: number,
 *   sharpe: number
 * }>} strategies - Array of strategy metric objects
 * @param {number} capital - Total capital in dollars
 * @param {object} constraints - Override default constraints
 * @returns {Array<{ name: string, weight: number, dollars: number, method: object }>}
 */
export function optimizePositions(strategies, capital, constraints = {}) {
  const C = { ...DEFAULT_CONSTRAINTS, ...constraints };

  if (!strategies || strategies.length === 0) return [];

  // Step 1: Kelly sizes
  const kellySizes = strategies.map(s =>
    kellySize(s.winRate, s.avgWin, s.avgLoss, C.kellyFraction)
  );

  // Step 2: Risk parity weights
  const vols = strategies.map(s => s.volatility || 0.15);
  const rpWeights = riskParityWeights(vols);

  // Step 3: Blend — 50% Kelly, 50% risk parity
  let blended = strategies.map((_, i) => {
    const kelly = kellySizes[i];
    const rp = rpWeights[i];
    return kelly * 0.5 + rp * 0.5;
  });

  // Step 4: Vol targeting — estimate portfolio vol and scale
  const portfolioVol = estimatePortfolioVol(blended, vols);
  if (portfolioVol > 0) {
    const volScalar = C.targetVol / portfolioVol;
    blended = blended.map(w => w * volScalar);
  }

  // Step 5: Max drawdown cap per strategy
  blended = blended.map((w, i) => {
    const stratDD = strategies[i].maxDrawdown || 0.10;
    if (stratDD > 0) {
      const ddCap = maxDrawdownSize(stratDD, C.maxDrawdown, 1).fraction;
      return Math.min(w, ddCap);
    }
    return w;
  });

  // Step 6: Enforce constraints
  blended = blended.map(w => {
    if (w < C.minPosition) return 0;    // Below minimum — zero out
    return Math.min(w, C.maxSinglePosition);
  });

  // Enforce leverage limit — normalize if sum exceeds maxLeverage
  const totalWeight = blended.reduce((s, w) => s + w, 0);
  if (totalWeight > C.maxLeverage) {
    const scale = C.maxLeverage / totalWeight;
    blended = blended.map(w => w * scale);
  }

  // Build output
  return strategies.map((s, i) => ({
    name: s.name,
    weight: Math.round(blended[i] * 10000) / 10000,  // 4 decimal places
    dollars: Math.round(blended[i] * capital * 100) / 100,
    method: {
      kelly: Math.round(kellySizes[i] * 10000) / 10000,
      riskParity: Math.round(rpWeights[i] * 10000) / 10000,
      blendedRaw: Math.round((kellySizes[i] * 0.5 + rpWeights[i] * 0.5) * 10000) / 10000,
    },
  }));
}

/**
 * Estimate portfolio volatility from weights and individual vols.
 * Assumes zero correlation (conservative for risk parity).
 * vol_p = sqrt(sum(w_i^2 * vol_i^2))
 */
function estimatePortfolioVol(weights, vols) {
  let variance = 0;
  for (let i = 0; i < weights.length; i++) {
    variance += weights[i] ** 2 * vols[i] ** 2;
  }
  return Math.sqrt(variance);
}

// ─── Results.tsv Parser ───────────────────────────────────

/**
 * Parse results.tsv and extract per-strategy metrics for sizing.
 */
function loadStrategyMetrics(strategyNames) {
  if (!existsSync(RESULTS_TSV)) {
    console.error(`results.tsv not found at ${RESULTS_TSV}`);
    return [];
  }

  const raw = readFileSync(RESULTS_TSV, "utf-8").trim();
  const lines = raw.split("\n").slice(1); // skip header

  // Group experiments by agent
  const byAgent = {};
  for (const line of lines) {
    const parts = line.split("\t");
    const agent = parts[1];
    const sharpe = parseFloat(parts[3]) || 0;
    const maxDD = Math.abs(parseFloat(parts[7]) || 0);
    const winRate = parseFloat(parts[8]) || 0;
    const trades = parseInt(parts[9]) || 0;
    const status = parts[10] || parts[parts.length - 1] || "";

    if (!byAgent[agent]) byAgent[agent] = [];
    byAgent[agent].push({ sharpe, maxDD, winRate, trades, status });
  }

  // Compute per-strategy metrics
  return strategyNames.map(name => {
    const experiments = byAgent[name];
    if (!experiments || experiments.length === 0) {
      return {
        name,
        winRate: 0.5,
        avgWin: 0.01,
        avgLoss: 0.01,
        volatility: 0.20,
        maxDrawdown: 0.10,
        sharpe: 0,
        experimentCount: 0,
      };
    }

    // Use "keep" experiments for win/loss stats
    const keeps = experiments.filter(e => e.status === "keep");
    const discards = experiments.filter(e => e.status === "discard" || e.status === "crash");
    const total = keeps.length + discards.length;

    // Win rate = fraction of experiments that were "keep"
    const winRate = total > 0 ? keeps.length / total : 0.5;

    // Average positive sharpe (wins) and average negative sharpe (losses)
    const winSharpes = experiments.filter(e => e.sharpe > 0).map(e => e.sharpe);
    const lossSharpes = experiments.filter(e => e.sharpe <= 0).map(e => Math.abs(e.sharpe));

    const avgWin = winSharpes.length > 0
      ? winSharpes.reduce((s, v) => s + v, 0) / winSharpes.length
      : 0.01;
    const avgLoss = lossSharpes.length > 0
      ? lossSharpes.reduce((s, v) => s + v, 0) / lossSharpes.length
      : 0.01;

    // Max drawdown — use worst observed
    const maxDD = Math.max(...experiments.map(e => e.maxDD), 0.01);

    // Volatility proxy — stddev of sharpe ratios (crude but functional)
    const sharpes = experiments.map(e => e.sharpe);
    const meanSharpe = sharpes.reduce((s, v) => s + v, 0) / sharpes.length;
    const variance = sharpes.reduce((s, v) => s + (v - meanSharpe) ** 2, 0) / sharpes.length;
    const vol = Math.sqrt(variance) || 0.20;

    const bestSharpe = Math.max(...sharpes);

    return {
      name,
      winRate,
      avgWin,
      avgLoss,
      volatility: vol,
      maxDrawdown: maxDD,
      sharpe: bestSharpe,
      experimentCount: experiments.length,
    };
  });
}

// ─── CLI ──────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    strategies: [],
    capital: 100000,
    targetVol: 0.10,
    maxDrawdown: 0.05,
    kellyFraction: 0.5,
    maxPosition: 0.20,
    maxLeverage: 1.0,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--strategies") opts.strategies = args[++i].split(",");
    if (args[i] === "--capital") opts.capital = parseFloat(args[++i]);
    if (args[i] === "--target-vol") opts.targetVol = parseFloat(args[++i]);
    if (args[i] === "--max-drawdown") opts.maxDrawdown = parseFloat(args[++i]);
    if (args[i] === "--kelly-fraction") opts.kellyFraction = parseFloat(args[++i]);
    if (args[i] === "--max-position") opts.maxPosition = parseFloat(args[++i]);
    if (args[i] === "--max-leverage") opts.maxLeverage = parseFloat(args[++i]);
    if (args[i] === "--help" || args[i] === "-h") opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
Position Sizer — Risk Management Engine

Usage:
  node agents/risk/position-sizer.mjs --strategies <names> --capital <amount>

Options:
  --strategies <s1,s2,...>   Comma-separated strategy/agent names
  --capital <n>              Total capital in dollars (default: 100000)
  --target-vol <n>           Target annualized portfolio vol (default: 0.10)
  --max-drawdown <n>         Max acceptable drawdown (default: 0.05)
  --kelly-fraction <n>       Kelly fraction: 1.0=full, 0.5=half (default: 0.5)
  --max-position <n>         Max single position weight (default: 0.20)
  --max-leverage <n>         Max total leverage (default: 1.0)
  --help                     Show this help

Examples:
  node agents/risk/position-sizer.mjs --strategies alpha_researcher,stat_arb_quant --capital 100000
  node agents/risk/position-sizer.mjs --strategies polymarket_btc --capital 50000 --kelly-fraction 0.25
`);
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.strategies.length === 0) {
    // Auto-detect strategies from results.tsv
    if (existsSync(RESULTS_TSV)) {
      const raw = readFileSync(RESULTS_TSV, "utf-8").trim();
      const lines = raw.split("\n").slice(1);
      const agents = new Set();
      for (const line of lines) {
        const agent = line.split("\t")[1];
        if (agent) agents.add(agent);
      }
      opts.strategies = [...agents];
      if (opts.strategies.length === 0) {
        console.error("No strategies found in results.tsv. Use --strategies to specify.");
        process.exit(1);
      }
      console.log(`Auto-detected strategies: ${opts.strategies.join(", ")}\n`);
    } else {
      console.error("No results.tsv found and no --strategies specified.");
      process.exit(1);
    }
  }

  // Load metrics from results.tsv
  const metrics = loadStrategyMetrics(opts.strategies);

  console.log("=".repeat(70));
  console.log("  POSITION SIZER — Risk Management Engine");
  console.log("=".repeat(70));
  console.log(`  Capital:        $${opts.capital.toLocaleString()}`);
  console.log(`  Target Vol:     ${(opts.targetVol * 100).toFixed(1)}%`);
  console.log(`  Max Drawdown:   ${(opts.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  Kelly Fraction: ${opts.kellyFraction}`);
  console.log(`  Max Position:   ${(opts.maxPosition * 100).toFixed(0)}%`);
  console.log(`  Max Leverage:   ${opts.maxLeverage}x`);
  console.log("=".repeat(70));

  // Print per-strategy metrics
  console.log("\n--- Strategy Metrics (from results.tsv) ---\n");
  console.log(
    "Strategy".padEnd(25) +
    "WinRate".padStart(8) +
    "AvgWin".padStart(8) +
    "AvgLoss".padStart(8) +
    "Vol".padStart(8) +
    "MaxDD".padStart(8) +
    "Sharpe".padStart(8) +
    "Exps".padStart(6)
  );
  console.log("-".repeat(79));

  for (const m of metrics) {
    console.log(
      m.name.padEnd(25) +
      (m.winRate * 100).toFixed(1).padStart(7) + "%" +
      m.avgWin.toFixed(4).padStart(8) +
      m.avgLoss.toFixed(4).padStart(8) +
      (m.volatility * 100).toFixed(1).padStart(7) + "%" +
      (m.maxDrawdown * 100).toFixed(1).padStart(7) + "%" +
      m.sharpe.toFixed(4).padStart(8) +
      String(m.experimentCount).padStart(6)
    );
  }

  // Individual sizing methods
  console.log("\n--- Individual Sizing Methods ---\n");

  for (const m of metrics) {
    console.log(`  ${m.name}:`);
    const kelly = kellySize(m.winRate, m.avgWin, m.avgLoss, opts.kellyFraction);
    console.log(`    Kelly (${opts.kellyFraction}x):     ${(kelly * 100).toFixed(2)}% = $${(kelly * opts.capital).toFixed(0)}`);

    const ddSize = maxDrawdownSize(m.maxDrawdown, opts.maxDrawdown, opts.capital);
    console.log(`    Max DD cap:         ${(ddSize.fraction * 100).toFixed(2)}% = $${ddSize.dollars.toFixed(0)}`);

    const vtSize = volTargetSize(m.volatility, opts.targetVol, kelly || 0.10);
    console.log(`    Vol-targeted:       ${(vtSize * 100).toFixed(2)}% = $${(vtSize * opts.capital).toFixed(0)}`);
  }

  // Risk parity
  const vols = metrics.map(m => m.volatility);
  const rpWeights = riskParityWeights(vols);
  console.log("\n--- Risk Parity Weights ---\n");
  for (let i = 0; i < metrics.length; i++) {
    console.log(`  ${metrics[i].name}: ${(rpWeights[i] * 100).toFixed(2)}% = $${(rpWeights[i] * opts.capital).toFixed(0)}`);
  }

  // Combined optimizer
  console.log("\n--- Combined Optimal Positions ---\n");
  const positions = optimizePositions(metrics, opts.capital, {
    targetVol: opts.targetVol,
    maxDrawdown: opts.maxDrawdown,
    kellyFraction: opts.kellyFraction,
    maxSinglePosition: opts.maxPosition,
    maxLeverage: opts.maxLeverage,
  });

  console.log(
    "Strategy".padEnd(25) +
    "Weight".padStart(8) +
    "Dollars".padStart(12) +
    "Kelly".padStart(8) +
    "RiskPar".padStart(8) +
    "Blended".padStart(8)
  );
  console.log("-".repeat(69));

  let totalWeight = 0;
  let totalDollars = 0;

  for (const p of positions) {
    console.log(
      p.name.padEnd(25) +
      (p.weight * 100).toFixed(2).padStart(7) + "%" +
      ("$" + p.dollars.toFixed(0)).padStart(12) +
      (p.method.kelly * 100).toFixed(1).padStart(7) + "%" +
      (p.method.riskParity * 100).toFixed(1).padStart(7) + "%" +
      (p.method.blendedRaw * 100).toFixed(1).padStart(7) + "%"
    );
    totalWeight += p.weight;
    totalDollars += p.dollars;
  }

  console.log("-".repeat(69));
  console.log(
    "TOTAL".padEnd(25) +
    (totalWeight * 100).toFixed(2).padStart(7) + "%" +
    ("$" + totalDollars.toFixed(0)).padStart(12)
  );
  console.log(
    "CASH".padEnd(25) +
    ((1 - totalWeight) * 100).toFixed(2).padStart(7) + "%" +
    ("$" + (opts.capital - totalDollars).toFixed(0)).padStart(12)
  );

  console.log("\n" + "=".repeat(70));
}

// Run if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("position-sizer.mjs") ||
  process.argv[1].includes("position-sizer")
);
if (isMain) {
  main().catch(err => {
    console.error("Position sizer failed:", err.message);
    process.exit(1);
  });
}
