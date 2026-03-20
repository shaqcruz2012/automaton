#!/usr/bin/env node
/**
 * Correlation Monitor — Portfolio Correlation & Regime Detection
 *
 * Computes rolling correlation matrices between strategy return series,
 * detects correlation regime changes, identifies hedging opportunities,
 * and outputs ASCII correlation heatmaps.
 *
 * Usage:
 *   node agents/risk/correlation-monitor.mjs --window 60
 *   node agents/risk/correlation-monitor.mjs --window 30 --symbols SPY,QQQ,TLT,GLD
 *   node agents/risk/correlation-monitor.mjs --alert-threshold 0.6
 *
 * Can also be imported as a module:
 *   import { computeCorrelationMatrix, detectRegimeChange } from './correlation-monitor.mjs'
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generateRealisticPrices } from "../data/fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Math Utilities ─────────────────────────────────────

/**
 * Compute daily log returns from price series.
 * @param {Array<{close: number}>} prices
 * @returns {number[]}
 */
export function computeReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1].close > 0 && prices[i].close > 0) {
      returns.push(Math.log(prices[i].close / prices[i - 1].close));
    } else {
      returns.push(0);
    }
  }
  return returns;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Pearson correlation between two arrays.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Correlation in [-1, 1]
 */
export function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;

  const ax = a.slice(0, n);
  const bx = b.slice(0, n);
  const ma = mean(ax);
  const mb = mean(bx);

  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - ma;
    const db = bx[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }

  const denom = Math.sqrt(va * vb);
  if (denom === 0) return 0;
  return cov / denom;
}

// ─── Correlation Matrix ─────────────────────────────────

/**
 * Compute full pairwise correlation matrix from a map of return series.
 *
 * @param {Object<string, number[]>} returnSeries - { symbol: [r1, r2, ...] }
 * @param {number} window - Rolling window length (0 = use all data)
 * @returns {{ symbols: string[], matrix: number[][], avgPairwise: number }}
 */
export function computeCorrelationMatrix(returnSeries, window = 0) {
  const symbols = Object.keys(returnSeries);
  const n = symbols.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(0));

  // Trim series to window
  const trimmed = {};
  for (const sym of symbols) {
    const series = returnSeries[sym];
    trimmed[sym] = window > 0 && series.length > window
      ? series.slice(-window)
      : series;
  }

  let pairwiseSum = 0;
  let pairCount = 0;

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const corr = pearsonCorrelation(trimmed[symbols[i]], trimmed[symbols[j]]);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
      pairwiseSum += corr;
      pairCount++;
    }
  }

  const avgPairwise = pairCount > 0 ? pairwiseSum / pairCount : 0;

  return { symbols, matrix, avgPairwise };
}

// ─── Rolling Correlation ─────────────────────────────────

/**
 * Compute rolling correlation between two series over successive windows.
 * Returns array of { index, correlation }.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} window
 * @returns {Array<{index: number, correlation: number}>}
 */
export function rollingCorrelation(a, b, window) {
  const n = Math.min(a.length, b.length);
  const results = [];
  for (let i = window; i <= n; i++) {
    const aSlice = a.slice(i - window, i);
    const bSlice = b.slice(i - window, i);
    results.push({ index: i, correlation: pearsonCorrelation(aSlice, bSlice) });
  }
  return results;
}

// ─── Regime Detection ────────────────────────────────────

/**
 * Detect correlation regime changes by comparing short-term avg correlation
 * to long-term avg correlation.
 *
 * @param {Object<string, number[]>} returnSeries
 * @param {number} shortWindow - Short-term window (e.g. 20 days)
 * @param {number} longWindow - Long-term window (e.g. 120 days)
 * @param {number} threshold - Alert threshold for avg pairwise correlation
 * @returns {{ currentRegime: string, avgCorrShort: number, avgCorrLong: number, alert: boolean, message: string }}
 */
export function detectRegimeChange(returnSeries, shortWindow = 20, longWindow = 120, threshold = 0.6) {
  const shortResult = computeCorrelationMatrix(returnSeries, shortWindow);
  const longResult = computeCorrelationMatrix(returnSeries, longWindow);

  const diff = shortResult.avgPairwise - longResult.avgPairwise;
  const isHighCorr = shortResult.avgPairwise > threshold;
  const isRising = diff > 0.15;
  const isFalling = diff < -0.15;

  let regime = "STABLE";
  if (isHighCorr && isRising) regime = "CONVERGENCE";
  else if (isHighCorr) regime = "HIGH_CORRELATION";
  else if (isRising) regime = "RISING";
  else if (isFalling) regime = "DIVERGENCE";

  const alert = isHighCorr;
  let message = `Regime: ${regime} | Avg corr (${shortWindow}d): ${shortResult.avgPairwise.toFixed(3)} | Avg corr (${longWindow}d): ${longResult.avgPairwise.toFixed(3)}`;
  if (alert) {
    message = `ALERT: High correlation regime detected! Avg pairwise = ${shortResult.avgPairwise.toFixed(3)} > ${threshold} threshold. Diversification benefit reduced.`;
  }

  return {
    currentRegime: regime,
    avgCorrShort: shortResult.avgPairwise,
    avgCorrLong: longResult.avgPairwise,
    alert,
    message,
  };
}

// ─── Diversification Ratio ──────────────────────────────

/**
 * Compute portfolio diversification ratio.
 *
 * DR = (weighted avg vol) / (portfolio vol)
 * DR > 1 means diversification benefit exists.
 * DR = 1 means perfect correlation (no diversification).
 *
 * @param {number[]} weights - Portfolio weights
 * @param {number[]} vols - Individual annualized volatilities
 * @param {number[][]} corrMatrix - Correlation matrix
 * @returns {{ ratio: number, weightedAvgVol: number, portfolioVol: number }}
 */
export function diversificationRatio(weights, vols, corrMatrix) {
  const n = weights.length;

  // Weighted average vol
  let weightedAvgVol = 0;
  for (let i = 0; i < n; i++) {
    weightedAvgVol += Math.abs(weights[i]) * vols[i];
  }

  // Portfolio variance = w' * Sigma * w
  // Sigma_ij = vol_i * vol_j * corr_ij
  let portfolioVariance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      portfolioVariance += weights[i] * weights[j] * vols[i] * vols[j] * corrMatrix[i][j];
    }
  }

  const portfolioVol = Math.sqrt(Math.max(portfolioVariance, 0));
  const ratio = portfolioVol > 0 ? weightedAvgVol / portfolioVol : 1;

  return { ratio, weightedAvgVol, portfolioVol };
}

// ─── Hedging Opportunities ──────────────────────────────

/**
 * Find the most negatively correlated pairs — prime hedging candidates.
 *
 * @param {string[]} symbols
 * @param {number[][]} corrMatrix
 * @param {number} topN - Number of pairs to return
 * @returns {Array<{sym1: string, sym2: string, correlation: number}>}
 */
export function findHedgingPairs(symbols, corrMatrix, topN = 5) {
  const pairs = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      pairs.push({
        sym1: symbols[i],
        sym2: symbols[j],
        correlation: corrMatrix[i][j],
      });
    }
  }
  pairs.sort((a, b) => a.correlation - b.correlation);
  return pairs.slice(0, topN);
}

/**
 * Compute optimal hedge ratio using OLS regression.
 *
 * Regress returns of asset Y on returns of asset X:
 *   Y = alpha + beta * X + epsilon
 *
 * Hedge ratio = -beta (short beta units of X to hedge 1 unit of Y)
 *
 * @param {number[]} returnsY - Returns of the asset to hedge
 * @param {number[]} returnsX - Returns of the hedging instrument
 * @returns {{ beta: number, alpha: number, rSquared: number, hedgeRatio: number }}
 */
export function olsHedgeRatio(returnsY, returnsX) {
  const n = Math.min(returnsY.length, returnsX.length);
  if (n < 5) return { beta: 0, alpha: 0, rSquared: 0, hedgeRatio: 0 };

  const y = returnsY.slice(0, n);
  const x = returnsX.slice(0, n);

  const mx = mean(x);
  const my = mean(y);

  let ssxy = 0, ssxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    ssxy += dx * (y[i] - my);
    ssxx += dx * dx;
  }

  if (ssxx === 0) return { beta: 0, alpha: 0, rSquared: 0, hedgeRatio: 0 };

  const beta = ssxy / ssxx;
  const alpha = my - beta * mx;

  // R-squared
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = alpha + beta * x[i];
    ssRes += (y[i] - predicted) ** 2;
    ssTot += (y[i] - my) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return {
    beta: +beta.toFixed(6),
    alpha: +alpha.toFixed(8),
    rSquared: +rSquared.toFixed(4),
    hedgeRatio: +(-beta).toFixed(6),
  };
}

// ─── Correlation Stability ──────────────────────────────

/**
 * Track correlation stability: compute how much the correlation structure
 * has changed between two time periods.
 *
 * Uses Frobenius norm of the difference between two correlation matrices.
 *
 * @param {Object<string, number[]>} returnSeries
 * @param {number} window
 * @returns {{ stabilityScore: number, isStable: boolean, message: string }}
 */
export function correlationStability(returnSeries, window = 60) {
  const symbols = Object.keys(returnSeries);
  const minLen = Math.min(...symbols.map(s => returnSeries[s].length));

  if (minLen < window * 2) {
    return { stabilityScore: 1, isStable: true, message: "Insufficient data for stability check" };
  }

  // Split into two halves
  const firstHalf = {};
  const secondHalf = {};
  for (const sym of symbols) {
    const s = returnSeries[sym];
    firstHalf[sym] = s.slice(Math.max(0, s.length - window * 2), s.length - window);
    secondHalf[sym] = s.slice(-window);
  }

  const m1 = computeCorrelationMatrix(firstHalf);
  const m2 = computeCorrelationMatrix(secondHalf);

  // Frobenius norm of difference
  const n = symbols.length;
  let frobSq = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      frobSq += (m1.matrix[i][j] - m2.matrix[i][j]) ** 2;
    }
  }
  const frobNorm = Math.sqrt(frobSq);

  // Normalize by matrix size
  const maxNorm = n * Math.sqrt(2); // theoretical max for correlation matrices
  const stabilityScore = 1 - Math.min(frobNorm / maxNorm, 1);

  const isStable = stabilityScore > 0.7;
  const message = isStable
    ? `Correlation structure STABLE (score: ${stabilityScore.toFixed(3)}, Frobenius diff: ${frobNorm.toFixed(4)})`
    : `WARNING: Correlation structure UNSTABLE (score: ${stabilityScore.toFixed(3)}, Frobenius diff: ${frobNorm.toFixed(4)}). Hedge ratios may be unreliable.`;

  return { stabilityScore, isStable, message };
}

// ─── ASCII Heatmap ──────────────────────────────────────

/**
 * Render a correlation matrix as ASCII art heatmap.
 *
 * Uses block characters with color coding:
 *   Strong positive (>0.7):  ##  (bright)
 *   Moderate positive:       ++
 *   Weak:                    ..
 *   Moderate negative:       --
 *   Strong negative (<-0.7): XX
 *
 * @param {string[]} symbols
 * @param {number[][]} matrix
 * @returns {string}
 */
export function asciiHeatmap(symbols, matrix) {
  const n = symbols.length;
  const maxLabel = Math.max(...symbols.map(s => s.length), 5);
  const cellWidth = 7;

  const lines = [];

  // Header
  let header = " ".repeat(maxLabel + 2);
  for (const sym of symbols) {
    header += sym.padStart(cellWidth);
  }
  lines.push(header);
  lines.push(" ".repeat(maxLabel + 2) + "-".repeat(cellWidth * n));

  // Rows
  for (let i = 0; i < n; i++) {
    let row = symbols[i].padEnd(maxLabel) + " |";
    for (let j = 0; j < n; j++) {
      const v = matrix[i][j];
      let cell;
      if (i === j) {
        cell = "  1.00";
      } else if (v >= 0.7) {
        cell = ` ${v.toFixed(2)}`;
        cell = `##${v.toFixed(2).slice(1)}`;
      } else if (v >= 0.3) {
        cell = `++${v.toFixed(2).slice(1)}`;
      } else if (v >= -0.3) {
        cell = ` ${v.toFixed(2)}`;
      } else if (v >= -0.7) {
        cell = `--${Math.abs(v).toFixed(2).slice(1)}`;
      } else {
        cell = `XX${Math.abs(v).toFixed(2).slice(1)}`;
      }
      row += cell.padStart(cellWidth);
    }
    lines.push(row);
  }

  // Legend
  lines.push("");
  lines.push("Legend: ## strong+ (>0.7) | ++ moderate+ | .. weak | -- moderate- | XX strong- (<-0.7)");

  return lines.join("\n");
}

// ─── Telegram Alert Formatting ──────────────────────────

/**
 * Format correlation alerts for Telegram notification.
 *
 * @param {{ currentRegime: string, avgCorrShort: number, avgCorrLong: number, alert: boolean, message: string }} regime
 * @param {Array<{sym1: string, sym2: string, correlation: number}>} hedgePairs
 * @param {{ ratio: number }} divRatio
 * @param {{ stabilityScore: number, isStable: boolean }} stability
 * @returns {string}
 */
export function formatTelegramAlert(regime, hedgePairs, divRatio, stability) {
  const lines = [];

  const icon = regime.alert ? "🚨" : "📊";
  lines.push(`${icon} <b>Correlation Monitor</b>`);
  lines.push("");

  lines.push(`<b>Regime:</b> ${regime.currentRegime}`);
  lines.push(`Avg Corr (short): ${regime.avgCorrShort.toFixed(3)}`);
  lines.push(`Avg Corr (long):  ${regime.avgCorrLong.toFixed(3)}`);
  lines.push(`Diversification Ratio: ${divRatio.ratio.toFixed(3)}`);
  lines.push(`Stability: ${stability.stabilityScore.toFixed(3)} (${stability.isStable ? "STABLE" : "UNSTABLE"})`);
  lines.push("");

  if (regime.alert) {
    lines.push("⚠️ <b>High correlation detected!</b>");
    lines.push("Diversification benefit is reduced.");
    lines.push("Consider reducing position sizes or adding uncorrelated assets.");
    lines.push("");
  }

  if (hedgePairs.length > 0) {
    lines.push("<b>Best Hedge Pairs:</b>");
    for (const p of hedgePairs.slice(0, 3)) {
      lines.push(`  ${p.sym1}/${p.sym2}: corr = ${p.correlation.toFixed(3)}`);
    }
  }

  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    window: 60,
    shortWindow: 20,
    longWindow: 120,
    alertThreshold: 0.6,
    symbols: ["SPY", "QQQ", "IWM", "TLT", "GLD", "XLF", "XLE", "XLK"],
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--window") opts.window = parseInt(args[++i]);
    if (args[i] === "--short-window") opts.shortWindow = parseInt(args[++i]);
    if (args[i] === "--long-window") opts.longWindow = parseInt(args[++i]);
    if (args[i] === "--alert-threshold") opts.alertThreshold = parseFloat(args[++i]);
    if (args[i] === "--symbols") opts.symbols = args[++i].split(",").map(s => s.trim().toUpperCase());
    if (args[i] === "--help" || args[i] === "-h") opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
Correlation Monitor — Portfolio Correlation & Regime Detection

Usage:
  node agents/risk/correlation-monitor.mjs --window 60
  node agents/risk/correlation-monitor.mjs --symbols SPY,QQQ,TLT,GLD --alert-threshold 0.6

Options:
  --window <n>            Rolling window in days (default: 60)
  --short-window <n>      Short window for regime detection (default: 20)
  --long-window <n>       Long window for regime detection (default: 120)
  --alert-threshold <n>   Avg pairwise corr threshold for alert (default: 0.6)
  --symbols <s1,s2,...>   Comma-separated symbols (default: SPY,QQQ,IWM,TLT,GLD,XLF,XLE,XLK)
  --help                  Show this help
`);
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  console.log("=".repeat(75));
  console.log("  CORRELATION MONITOR — Portfolio Correlation & Regime Detection");
  console.log("=".repeat(75));
  console.log(`  Symbols:         ${opts.symbols.join(", ")}`);
  console.log(`  Window:          ${opts.window} days`);
  console.log(`  Short Window:    ${opts.shortWindow} days`);
  console.log(`  Long Window:     ${opts.longWindow} days`);
  console.log(`  Alert Threshold: ${opts.alertThreshold}`);
  console.log("=".repeat(75));

  // Load price data
  console.log("\n--- Loading Price Data ---\n");
  const priceData = {};
  for (const sym of opts.symbols) {
    priceData[sym] = generateRealisticPrices(sym);
  }

  // Compute returns
  const returnSeries = {};
  const volBySym = {};
  for (const sym of opts.symbols) {
    const returns = computeReturns(priceData[sym]);
    returnSeries[sym] = returns;
    volBySym[sym] = stddev(returns) * Math.sqrt(252); // annualize
  }

  // 1. Correlation matrix
  console.log("\n--- Correlation Matrix ---\n");
  const { symbols, matrix, avgPairwise } = computeCorrelationMatrix(returnSeries, opts.window);
  console.log(asciiHeatmap(symbols, matrix));
  console.log(`\n  Average pairwise correlation: ${avgPairwise.toFixed(4)}`);

  // 2. Regime detection
  console.log("\n--- Regime Detection ---\n");
  const regime = detectRegimeChange(returnSeries, opts.shortWindow, opts.longWindow, opts.alertThreshold);
  console.log(`  ${regime.message}`);

  // 3. Diversification ratio (equal-weight portfolio)
  console.log("\n--- Diversification Ratio (Equal Weight) ---\n");
  const equalWeights = opts.symbols.map(() => 1 / opts.symbols.length);
  const vols = opts.symbols.map(s => volBySym[s]);
  const divRatio = diversificationRatio(equalWeights, vols, matrix);
  console.log(`  Weighted Avg Vol:  ${(divRatio.weightedAvgVol * 100).toFixed(2)}%`);
  console.log(`  Portfolio Vol:     ${(divRatio.portfolioVol * 100).toFixed(2)}%`);
  console.log(`  Diversification Ratio: ${divRatio.ratio.toFixed(4)}`);
  if (divRatio.ratio > 1.5) {
    console.log("  -> Good diversification benefit");
  } else if (divRatio.ratio > 1.1) {
    console.log("  -> Moderate diversification benefit");
  } else {
    console.log("  -> Poor diversification — strategies too correlated");
  }

  // 4. Hedging opportunities
  console.log("\n--- Hedging Opportunities ---\n");
  const hedgePairs = findHedgingPairs(symbols, matrix, 5);
  console.log("  Most negatively correlated pairs (best hedge candidates):\n");
  console.log("  " + "Pair".padEnd(15) + "Corr".padStart(8) + "   HedgeRatio".padStart(14) + "  R-squared".padStart(12));
  console.log("  " + "-".repeat(50));

  for (const pair of hedgePairs) {
    const idxA = symbols.indexOf(pair.sym1);
    const idxB = symbols.indexOf(pair.sym2);
    const ols = olsHedgeRatio(returnSeries[pair.sym1], returnSeries[pair.sym2]);
    console.log(
      "  " +
      `${pair.sym1}/${pair.sym2}`.padEnd(15) +
      pair.correlation.toFixed(4).padStart(8) +
      ols.hedgeRatio.toFixed(4).padStart(14) +
      ols.rSquared.toFixed(4).padStart(12)
    );
  }

  // Suggest beta-neutral hedge
  console.log("\n  Beta-neutral hedge suggestions:");
  for (const pair of hedgePairs.slice(0, 3)) {
    if (pair.correlation < 0) {
      const ols = olsHedgeRatio(returnSeries[pair.sym1], returnSeries[pair.sym2]);
      console.log(`    Long 1 unit ${pair.sym1} + ${ols.hedgeRatio > 0 ? "Long" : "Short"} ${Math.abs(ols.hedgeRatio).toFixed(4)} units ${pair.sym2}`);
      console.log(`    Expected variance reduction: ${(ols.rSquared * 100).toFixed(1)}%`);
    }
  }

  // 5. Correlation stability
  console.log("\n--- Correlation Stability ---\n");
  const stability = correlationStability(returnSeries, opts.window);
  console.log(`  ${stability.message}`);

  // 6. Telegram alert
  console.log("\n--- Telegram Alert (formatted) ---\n");
  const telegramMsg = formatTelegramAlert(regime, hedgePairs, divRatio, stability);
  console.log(telegramMsg);

  console.log("\n" + "=".repeat(75));

  // Return structured result for programmatic use
  return {
    correlationMatrix: { symbols, matrix, avgPairwise },
    regime,
    diversificationRatio: divRatio,
    hedgePairs,
    stability,
    telegramAlert: telegramMsg,
  };
}

// Run if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("correlation-monitor.mjs") ||
  process.argv[1].includes("correlation-monitor")
);
if (isMain) {
  main().catch(err => {
    console.error("Correlation monitor failed:", err.message);
    process.exit(1);
  });
}
