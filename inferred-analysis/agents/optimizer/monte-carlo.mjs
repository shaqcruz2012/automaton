#!/usr/bin/env node
/**
 * Monte Carlo Simulation Engine — Inferred Analysis
 *
 * Validates trading strategies via statistical simulation.
 * Takes a strategy's historical returns (from backtest or results.tsv),
 * runs N simulations using multiple resampling methods, and outputs
 * distribution statistics with confidence intervals.
 *
 * Methods:
 *   1. Bootstrap resampling (iid daily returns with replacement)
 *   2. Block bootstrap (preserves autocorrelation structure)
 *   3. Parametric (fit normal or t-distribution, simulate from params)
 *
 * Usage:
 *   node agents/optimizer/monte-carlo.mjs --strategy agents/strategies/alpha_researcher.js --simulations 10000
 *   node agents/optimizer/monte-carlo.mjs --symbol SPY --simulations 5000
 *   node agents/optimizer/monte-carlo.mjs --results results.tsv --simulations 10000
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { generateRealisticPrices } from "../data/fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

// ─── Argument Parsing ────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    strategy: null,
    symbol: "SPY",
    simulations: 10_000,
    results: null,
    blockSize: 20,       // block bootstrap block length (trading days ~ 1 month)
    startDate: "2020-01-01",
    endDate: "2024-12-31",
    initialCapital: 1_000_000,
    method: "all",       // bootstrap, block, parametric, or all
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--strategy":   opts.strategy = args[++i]; break;
      case "--symbol":     opts.symbol = args[++i]; break;
      case "--simulations": opts.simulations = parseInt(args[++i]); break;
      case "--results":    opts.results = args[++i]; break;
      case "--block-size": opts.blockSize = parseInt(args[++i]); break;
      case "--start":      opts.startDate = args[++i]; break;
      case "--end":        opts.endDate = args[++i]; break;
      case "--capital":    opts.initialCapital = parseFloat(args[++i]); break;
      case "--method":     opts.method = args[++i]; break;
      case "--help":
        console.log(`Monte Carlo Simulation Engine

Options:
  --strategy <path>      Strategy JS file to backtest (e.g. agents/strategies/alpha_researcher.js)
  --symbol <ticker>      Symbol for buy-and-hold comparison (default: SPY)
  --simulations <N>      Number of simulations (default: 10000)
  --results <path>       TSV file with daily returns column
  --block-size <N>       Block length for block bootstrap (default: 20)
  --start <date>         Backtest start date (default: 2020-01-01)
  --end <date>           Backtest end date (default: 2024-12-31)
  --capital <amount>     Initial capital (default: 1000000)
  --method <type>        bootstrap, block, parametric, or all (default: all)
  --help                 Show this help`);
        process.exit(0);
    }
  }

  return opts;
}

// ─── Random Number Generation ────────────────────────────

/** Box-Muller transform for standard normal variates */
function randn() {
  const u1 = Math.random() * 0.9998 + 0.0001;
  const u2 = Math.random() * 0.9998 + 0.0001;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Student-t variate via ratio of normal and chi-squared */
function randt(df) {
  // Generate chi-squared with df degrees of freedom
  let chi2 = 0;
  for (let i = 0; i < df; i++) {
    const z = randn();
    chi2 += z * z;
  }
  return randn() / Math.sqrt(chi2 / df);
}

/** Random integer in [0, max) */
function randInt(max) {
  return Math.floor(Math.random() * max);
}

// ─── Statistical Functions ───────────────────────────────

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(sorted) {
  return percentile(sorted, 50);
}

// ─── Simulation Metrics ─────────────────────────────────

/**
 * From an array of daily returns, compute terminal wealth,
 * max drawdown, Sharpe ratio, and Calmar ratio.
 */
function computeSimMetrics(dailyReturns, initialCapital) {
  const n = dailyReturns.length;
  if (n === 0) return { terminalWealth: initialCapital, maxDrawdown: 0, sharpe: 0, calmar: 0 };

  // Build equity curve
  let equity = initialCapital;
  let peak = equity;
  let maxDD = 0;

  for (const r of dailyReturns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const terminalWealth = equity;

  // Sharpe (annualized, assuming 252 trading days)
  const m = mean(dailyReturns);
  const s = std(dailyReturns);
  const sharpe = s > 0 ? (m / s) * Math.sqrt(252) : 0;

  // Calmar = annualized return / max drawdown
  const totalReturn = (terminalWealth - initialCapital) / initialCapital;
  const annReturn = Math.pow(1 + totalReturn, 252 / n) - 1;
  const calmar = (maxDD > 0 && isFinite(annReturn)) ? annReturn / maxDD : 0;

  return { terminalWealth, maxDrawdown: maxDD, sharpe, calmar };
}

// ─── Simulation Methods ─────────────────────────────────

/**
 * Method 1: Standard bootstrap — sample daily returns with replacement (iid)
 */
function bootstrapSimulation(returns, nSims, initialCapital) {
  const n = returns.length;
  const results = [];

  for (let sim = 0; sim < nSims; sim++) {
    const sampled = new Array(n);
    for (let i = 0; i < n; i++) {
      sampled[i] = returns[randInt(n)];
    }
    results.push(computeSimMetrics(sampled, initialCapital));
  }

  return results;
}

/**
 * Method 2: Block bootstrap — sample blocks of consecutive returns
 * to preserve autocorrelation and volatility clustering.
 */
function blockBootstrapSimulation(returns, nSims, initialCapital, blockSize) {
  const n = returns.length;
  const results = [];
  const maxStart = n - blockSize;

  if (maxStart <= 0) {
    // Fall back to standard bootstrap if series too short
    return bootstrapSimulation(returns, nSims, initialCapital);
  }

  for (let sim = 0; sim < nSims; sim++) {
    const sampled = [];
    while (sampled.length < n) {
      const start = randInt(maxStart + 1);
      for (let j = 0; j < blockSize && sampled.length < n; j++) {
        sampled.push(returns[start + j]);
      }
    }
    results.push(computeSimMetrics(sampled, initialCapital));
  }

  return results;
}

/**
 * Method 3: Parametric simulation — fit distribution parameters,
 * then simulate from the fitted distribution.
 * Fits both normal and Student-t; uses t if excess kurtosis > 0.5.
 */
function parametricSimulation(returns, nSims, initialCapital) {
  const n = returns.length;
  const mu = mean(returns);
  const sigma = std(returns);

  // Compute excess kurtosis to decide normal vs t
  const m4 = returns.reduce((s, r) => s + ((r - mu) / sigma) ** 4, 0) / n;
  const excessKurtosis = m4 - 3;

  // Estimate degrees of freedom for t-distribution from kurtosis
  // For t with df > 4: excess_kurtosis = 6 / (df - 4)
  // So df = 6 / kurtosis + 4
  let useT = excessKurtosis > 0.5;
  let df = 5; // default
  if (useT && excessKurtosis > 0) {
    df = Math.max(3, Math.min(30, Math.round(6 / excessKurtosis + 4)));
  }

  const results = [];

  for (let sim = 0; sim < nSims; sim++) {
    const sampled = new Array(n);
    if (useT) {
      // Scale t-distribution to match observed mean/std
      // Var(t_df) = df / (df - 2) for df > 2
      const tScale = sigma / Math.sqrt(df / (df - 2));
      for (let i = 0; i < n; i++) {
        sampled[i] = mu + tScale * randt(df);
      }
    } else {
      for (let i = 0; i < n; i++) {
        sampled[i] = mu + sigma * randn();
      }
    }
    results.push(computeSimMetrics(sampled, initialCapital));
  }

  return { results, distribution: useT ? `t(df=${df})` : "normal", excessKurtosis };
}

// ─── Strategy Execution ──────────────────────────────────

/**
 * Run a strategy backtest and extract daily returns.
 * Loads the strategy file, extracts generateSignals and CONFIG,
 * then runs through the same backtest engine as template.js.
 */
function runStrategyBacktest(prices, strategyPath) {
  const absPath = resolve(process.cwd(), strategyPath);
  if (!existsSync(absPath)) {
    throw new Error(`Strategy file not found: ${absPath}`);
  }

  const code = readFileSync(absPath, "utf-8");

  // Extract CONFIG from strategy file
  const configMatch = code.match(/const\s+CONFIG\s*=\s*(\{[\s\S]*?\n\});/);
  const config = configMatch ? eval(`(${configMatch[1]})`) : {
    lookback: 20, threshold: 0.02, stopLoss: -0.05, takeProfit: 0.10,
    positionSize: 0.10, initialCapital: 1_000_000,
    transactionCostBps: 10, slippageBps: 5,
  };

  // Extract generateSignals function
  const fnMatch = code.match(/function\s+generateSignals\s*\(prices\)\s*\{([\s\S]*?)\n\}/);
  if (!fnMatch) {
    throw new Error("Could not extract generateSignals from strategy file");
  }

  // Build the generateSignals function with the strategy's CONFIG in scope.
  // The function body may declare its own lookback/threshold, so we only
  // inject CONFIG — let the strategy body handle variable declarations.
  const generateSignals = new Function("prices", "CONFIG", fnMatch[1]);

  const signals = generateSignals(prices, config);

  // Run backtest — same engine as template.js
  let capital = config.initialCapital || 1_000_000;
  let position = 0;
  let trades = 0;
  const dailyReturns = [];
  let prevEquity = capital;
  let peakEquity = capital;
  let maxDrawdown = 0;

  const costBps = ((config.transactionCostBps || 10) + (config.slippageBps || 5)) / 10000;

  for (const sig of signals) {
    const targetPosition = sig.signal;
    const currentPosition = position > 0 ? 1 : position < 0 ? -1 : 0;

    if (targetPosition !== currentPosition) {
      if (position !== 0) {
        const proceeds = position * sig.price;
        const cost = Math.abs(proceeds) * costBps;
        capital += proceeds - cost;
        position = 0;
        trades++;
      }
      if (targetPosition !== 0) {
        const tradeCapital = capital * (config.positionSize || 0.10);
        const cost = tradeCapital * costBps;
        position = (targetPosition * (tradeCapital - cost)) / sig.price;
        capital -= tradeCapital;
        trades++;
      }
    }

    const equity = capital + position * sig.price;
    const dailyReturn = (equity - prevEquity) / prevEquity;
    dailyReturns.push(dailyReturn);
    prevEquity = equity;

    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Close final position
  if (position !== 0 && signals.length > 0) {
    const lastPrice = signals[signals.length - 1].price;
    capital += position * lastPrice;
  }

  return { dailyReturns, trades, finalCapital: capital, maxDrawdown, initialCapital: config.initialCapital || 1_000_000 };
}

/**
 * Generate buy-and-hold daily returns from price data.
 */
function buyAndHoldReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
  }
  return returns;
}

/**
 * Load daily returns from a TSV file.
 * Expects a header row; looks for column named "return" or "daily_return".
 */
function loadReturnsFromTSV(path) {
  const absPath = resolve(process.cwd(), path);
  const lines = readFileSync(absPath, "utf-8").trim().split("\n");
  const header = lines[0].split("\t").map(h => h.trim().toLowerCase());

  let col = header.indexOf("return");
  if (col === -1) col = header.indexOf("daily_return");
  if (col === -1) col = header.indexOf("returns");
  if (col === -1) {
    // Try last numeric column
    col = header.length - 1;
  }

  const returns = [];
  for (let i = 1; i < lines.length; i++) {
    const val = parseFloat(lines[i].split("\t")[col]);
    if (!isNaN(val)) returns.push(val);
  }

  return returns;
}

// ─── Output Formatting ──────────────────────────────────

function formatPct(v) { return (v * 100).toFixed(2) + "%"; }
function formatDollar(v) { return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function formatNum(v, d = 4) { return v.toFixed(d); }

/**
 * Compute and print distribution statistics for a set of simulation results.
 */
function analyzeDistribution(results, label, initialCapital) {
  const n = results.length;
  const terminalWealths = results.map(r => r.terminalWealth).sort((a, b) => a - b);
  const maxDDs = results.map(r => r.maxDrawdown).sort((a, b) => a - b);
  const sharpes = results.map(r => r.sharpe).sort((a, b) => a - b);
  const calmars = results.map(r => r.calmar).sort((a, b) => a - b);

  const totalReturns = terminalWealths.map(w => (w - initialCapital) / initialCapital);

  // Probability of profit
  const profitCount = totalReturns.filter(r => r > 0).length;
  const probProfit = profitCount / n;

  // Probability of ruin (>50% drawdown)
  const ruinCount = maxDDs.filter(dd => dd > 0.50).length;
  const probRuin = ruinCount / n;

  // VaR at 5% — the 5th percentile of returns (loss threshold)
  const var5 = percentile(totalReturns.sort((a, b) => a - b), 5);

  // CVaR / Expected Shortfall at 5% — mean of returns below VaR
  const tailReturns = totalReturns.filter(r => r <= var5);
  const cvar5 = tailReturns.length > 0 ? mean(tailReturns) : var5;

  // Sharpe confidence interval — is Sharpe statistically > 0?
  const sharpeMean = mean(sharpes);
  const sharpeStd = std(sharpes);
  const sharpeZ = sharpeStd > 0 ? sharpeMean / (sharpeStd / Math.sqrt(n)) : 0;
  // Two-sided test: is Sharpe statistically different from 0?
  const sharpePval = 2 * (1 - normalCDF(Math.abs(sharpeZ)));
  const sharpeSig = sharpePval < 0.05;

  console.log(`\n${"=".repeat(66)}`);
  console.log(`  ${label}`);
  console.log(`${"=".repeat(66)}`);
  console.log(`  Simulations: ${n.toLocaleString()}\n`);

  console.log("  Metric              Median      5th Pctl    95th Pctl");
  console.log("  " + "-".repeat(60));
  console.log(`  Terminal Wealth    ${pad(formatDollar(median(terminalWealths)))} ${pad(formatDollar(percentile(terminalWealths, 5)))} ${formatDollar(percentile(terminalWealths, 95))}`);
  console.log(`  Total Return       ${pad(formatPct(median(totalReturns.sort((a,b)=>a-b))))} ${pad(formatPct(percentile(totalReturns, 5)))} ${formatPct(percentile(totalReturns, 95))}`);
  console.log(`  Max Drawdown       ${pad(formatPct(median(maxDDs)))} ${pad(formatPct(percentile(maxDDs, 5)))} ${formatPct(percentile(maxDDs, 95))}`);
  console.log(`  Sharpe Ratio       ${pad(formatNum(median(sharpes)))} ${pad(formatNum(percentile(sharpes, 5)))} ${formatNum(percentile(sharpes, 95))}`);
  console.log(`  Calmar Ratio       ${pad(formatNum(median(calmars)))} ${pad(formatNum(percentile(calmars, 5)))} ${formatNum(percentile(calmars, 95))}`);

  console.log();
  console.log(`  Prob. of Profit:     ${formatPct(probProfit)}`);
  console.log(`  Prob. of Ruin:       ${formatPct(probRuin)}  (>50% drawdown)`);
  console.log(`  Value at Risk (5%):  ${formatPct(var5)}`);
  console.log(`  Expected Shortfall:  ${formatPct(cvar5)}  (CVaR at 5%)`);

  console.log();
  console.log(`  Sharpe Confidence Interval:`);
  console.log(`    Mean Sharpe:       ${formatNum(sharpeMean)}`);
  console.log(`    95% CI:            [${formatNum(percentile(sharpes, 2.5))}, ${formatNum(percentile(sharpes, 97.5))}]`);
  console.log(`    Z-statistic:       ${formatNum(sharpeZ, 2)}`);
  console.log(`    p-value (H0: S=0): ${sharpePval.toFixed(6)}`);
  console.log(`    Significant:       ${sharpeSig ? "YES -- Sharpe is statistically different from 0" : "NO -- cannot reject Sharpe = 0"}`);

  // ASCII histogram of terminal wealth
  printHistogram(terminalWealths, "Terminal Wealth Distribution", initialCapital);

  return {
    median: { terminalWealth: median(terminalWealths), maxDrawdown: median(maxDDs), sharpe: median(sharpes), calmar: median(calmars) },
    p5: { terminalWealth: percentile(terminalWealths, 5), maxDrawdown: percentile(maxDDs, 5), sharpe: percentile(sharpes, 5), calmar: percentile(calmars, 5) },
    p95: { terminalWealth: percentile(terminalWealths, 95), maxDrawdown: percentile(maxDDs, 95), sharpe: percentile(sharpes, 95), calmar: percentile(calmars, 95) },
    probProfit, probRuin, var5, cvar5,
    sharpeMean, sharpeCI: [percentile(sharpes, 2.5), percentile(sharpes, 97.5)],
    sharpePval, sharpeSignificant: sharpeSig,
  };
}

function pad(s, w = 12) { return s.padStart(w); }

/** Approximate standard normal CDF using Abramowitz & Stegun */
function normalCDF(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Print an ASCII histogram of a sorted array of values.
 */
function printHistogram(sorted, title, refLine = null) {
  const n = sorted.length;
  const nBins = 40;
  const min = sorted[0];
  const max = sorted[n - 1];
  const binWidth = (max - min) / nBins;

  if (binWidth === 0) {
    console.log(`\n  ${title}: all values identical (${formatDollar(min)})`);
    return;
  }

  const bins = new Array(nBins).fill(0);
  for (const v of sorted) {
    let bin = Math.floor((v - min) / binWidth);
    if (bin >= nBins) bin = nBins - 1;
    bins[bin]++;
  }

  const maxCount = Math.max(...bins);
  const barMax = 50;

  console.log(`\n  ${title}`);
  console.log(`  ${"-".repeat(66)}`);

  // Print every 4th bin to keep it readable
  for (let i = 0; i < nBins; i += 2) {
    const lo = min + i * binWidth;
    const count = bins[i] + (i + 1 < nBins ? bins[i + 1] : 0);
    const barLen = Math.round((count / maxCount) * barMax);
    const bar = "#".repeat(barLen);
    const label = formatDollar(lo).padStart(14);

    // Mark reference line (initial capital)
    let marker = " ";
    if (refLine !== null && lo <= refLine && lo + 2 * binWidth > refLine) {
      marker = "|";
    }

    console.log(`  ${label} ${marker} ${bar} ${count}`);
  }

  if (refLine !== null) {
    console.log(`  ${"".padStart(15)} ^-- initial capital (${formatDollar(refLine)})`);
  }
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const t0 = Date.now();

  console.log("Monte Carlo Simulation Engine — Inferred Analysis");
  console.log("─".repeat(50));

  // Step 1: Get daily returns
  let strategyReturns;
  let strategyLabel;
  let initialCapital = opts.initialCapital;

  if (opts.results) {
    // Load from TSV
    strategyReturns = loadReturnsFromTSV(opts.results);
    strategyLabel = `Strategy (from ${opts.results})`;
    console.log(`Loaded ${strategyReturns.length} daily returns from ${opts.results}`);
  } else {
    // Generate price data
    let prices;
    const symbol = opts.symbol || "SPY";

    // Try cached real data first
    const cachePath = join(__dirname, "..", "data", "cache", `${symbol.toUpperCase()}.json`);
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      prices = cached.prices;
      console.log(`Data: ${symbol} (cached real) -- ${prices.length} days`);
    } else {
      prices = generateRealisticPrices(symbol, opts.startDate, opts.endDate);
      console.log(`Data: ${symbol} (synthetic-realistic) -- ${prices.length} days`);
    }

    if (opts.strategy) {
      // Run strategy backtest
      const bt = runStrategyBacktest(prices, opts.strategy);
      strategyReturns = bt.dailyReturns;
      initialCapital = bt.initialCapital;
      strategyLabel = `Strategy: ${opts.strategy}`;
      console.log(`Backtest: ${strategyReturns.length} days, ${bt.trades} trades, final capital: ${formatDollar(bt.finalCapital)}`);
    } else {
      // Use buy-and-hold returns for the symbol
      strategyReturns = buyAndHoldReturns(prices);
      strategyLabel = `Buy & Hold: ${symbol}`;
      console.log(`Buy & Hold: ${strategyReturns.length} daily returns`);
    }

    // Step 2: Also run buy-and-hold Monte Carlo for comparison
    const bhReturns = buyAndHoldReturns(prices);

    console.log(`\nRunning ${opts.simulations.toLocaleString()} simulations per method...`);

    // ── Strategy Monte Carlo ──

    if (opts.method === "all" || opts.method === "bootstrap") {
      const stBoot = bootstrapSimulation(strategyReturns, opts.simulations, initialCapital);
      analyzeDistribution(stBoot, `BOOTSTRAP -- ${strategyLabel}`, initialCapital);
    }

    if (opts.method === "all" || opts.method === "block") {
      const stBlock = blockBootstrapSimulation(strategyReturns, opts.simulations, initialCapital, opts.blockSize);
      analyzeDistribution(stBlock, `BLOCK BOOTSTRAP (block=${opts.blockSize}) -- ${strategyLabel}`, initialCapital);
    }

    if (opts.method === "all" || opts.method === "parametric") {
      const { results: stParam, distribution, excessKurtosis } = parametricSimulation(strategyReturns, opts.simulations, initialCapital);
      const paramLabel = `PARAMETRIC (${distribution}, kurtosis=${excessKurtosis.toFixed(2)}) -- ${strategyLabel}`;
      analyzeDistribution(stParam, paramLabel, initialCapital);
    }

    // ── Buy & Hold Monte Carlo (comparison) ──

    if (opts.strategy) {
      console.log(`\n${"*".repeat(66)}`);
      console.log("  BENCHMARK COMPARISON: Buy & Hold Monte Carlo");
      console.log(`${"*".repeat(66)}`);

      const bhBoot = bootstrapSimulation(bhReturns, opts.simulations, initialCapital);
      const bhStats = analyzeDistribution(bhBoot, `BOOTSTRAP -- Buy & Hold: ${symbol}`, initialCapital);

      // Strategy vs benchmark summary
      const stBoot = bootstrapSimulation(strategyReturns, opts.simulations, initialCapital);
      const stStats = analyzeDistribution(stBoot, `[COMPARISON] BOOTSTRAP -- ${strategyLabel}`, initialCapital);

      console.log(`\n${"=".repeat(66)}`);
      console.log("  STRATEGY vs BUY & HOLD (Bootstrap)");
      console.log(`${"=".repeat(66)}`);
      console.log(`  Metric              Strategy     Buy&Hold     Edge`);
      console.log("  " + "-".repeat(60));

      const edge = (label, sv, bv, fmt) => {
        const diff = sv - bv;
        const arrow = diff > 0 ? " +" : " ";
        console.log(`  ${label.padEnd(20)} ${pad(fmt(sv))} ${pad(fmt(bv))} ${arrow}${fmt(diff)}`);
      };

      edge("Median Sharpe", stStats.median.sharpe, bhStats.median.sharpe, v => formatNum(v));
      edge("Median Return", (stStats.median.terminalWealth - initialCapital) / initialCapital, (bhStats.median.terminalWealth - initialCapital) / initialCapital, formatPct);
      edge("Prob. of Profit", stStats.probProfit, bhStats.probProfit, formatPct);
      edge("Prob. of Ruin", stStats.probRuin, bhStats.probRuin, formatPct);
      edge("VaR 5%", stStats.var5, bhStats.var5, formatPct);
      edge("CVaR 5%", stStats.cvar5, bhStats.cvar5, formatPct);
      edge("Median MaxDD", stStats.median.maxDrawdown, bhStats.median.maxDrawdown, formatPct);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nCompleted in ${elapsed}s`);
    return;
  }

  // Results-only path (no price data for benchmark comparison)
  console.log(`\nRunning ${opts.simulations.toLocaleString()} simulations per method...`);

  if (opts.method === "all" || opts.method === "bootstrap") {
    const boot = bootstrapSimulation(strategyReturns, opts.simulations, initialCapital);
    analyzeDistribution(boot, `BOOTSTRAP -- ${strategyLabel}`, initialCapital);
  }

  if (opts.method === "all" || opts.method === "block") {
    const block = blockBootstrapSimulation(strategyReturns, opts.simulations, initialCapital, opts.blockSize);
    analyzeDistribution(block, `BLOCK BOOTSTRAP (block=${opts.blockSize}) -- ${strategyLabel}`, initialCapital);
  }

  if (opts.method === "all" || opts.method === "parametric") {
    const { results: param, distribution, excessKurtosis } = parametricSimulation(strategyReturns, opts.simulations, initialCapital);
    analyzeDistribution(param, `PARAMETRIC (${distribution}, kurtosis=${excessKurtosis.toFixed(2)}) -- ${strategyLabel}`, initialCapital);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsed}s`);
}

main().catch(err => {
  console.error("Monte Carlo simulation failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
