#!/usr/bin/env node
/**
 * Regime Detector — Inferred Analysis Ensemble System
 *
 * Detects market regimes from price data to condition ensemble strategy weights.
 *
 * Three regime detection methods:
 *   1. Volatility regime (low/medium/high) — rolling vol percentile
 *   2. Trend regime (trending/mean-reverting) — Hurst exponent estimate
 *   3. Momentum regime (risk-on/risk-off) — cross-asset momentum
 *
 * Usage:
 *   import { detectVolatilityRegime, detectTrendRegime, detectMomentumRegime, detectAllRegimes } from './regime-detector.mjs';
 *   const regime = detectVolatilityRegime(prices);
 *   // => { regime: "high_vol", score: 0.85, rollingVol: 0.023, percentile: 0.85 }
 */

// ─── Volatility Regime ──────────────────────────────────────

/**
 * Classify volatility regime based on rolling realized vol percentile.
 * Uses 20-day rolling window for vol, 252-day lookback for percentile ranking.
 *
 * @param {Array} prices - Array of { date, close, ... }
 * @param {Object} opts
 * @param {number} opts.volWindow - Rolling vol window (default 20)
 * @param {number} opts.rankWindow - Percentile ranking lookback (default 252)
 * @param {number} opts.lowThreshold - Below this percentile = low_vol (default 0.33)
 * @param {number} opts.highThreshold - Above this percentile = high_vol (default 0.67)
 * @returns {{ regime: string, score: number, rollingVol: number, percentile: number, history: Array }}
 */
export function detectVolatilityRegime(prices, opts = {}) {
  const volWindow = opts.volWindow || 20;
  const rankWindow = opts.rankWindow || 252;
  const lowThreshold = opts.lowThreshold || 0.33;
  const highThreshold = opts.highThreshold || 0.67;

  // Compute daily log returns
  const logReturns = [];
  for (let i = 1; i < prices.length; i++) {
    logReturns.push(Math.log(prices[i].close / prices[i - 1].close));
  }

  // Compute rolling realized vol (annualized)
  const rollingVols = [];
  for (let i = volWindow - 1; i < logReturns.length; i++) {
    const window = logReturns.slice(i - volWindow + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((s, r) => s + (r - mean) ** 2, 0) / (window.length - 1);
    const vol = Math.sqrt(variance) * Math.sqrt(252);
    rollingVols.push({
      date: prices[i + 1].date, // offset by 1 because returns start at index 1
      vol,
    });
  }

  if (rollingVols.length === 0) {
    return { regime: "unknown", score: 0, rollingVol: 0, percentile: 0.5, history: [] };
  }

  // Compute percentile of current vol within recent history
  const lookback = Math.min(rankWindow, rollingVols.length);
  const recentVols = rollingVols.slice(-lookback).map(v => v.vol);
  const currentVol = rollingVols[rollingVols.length - 1].vol;
  const belowCount = recentVols.filter(v => v < currentVol).length;
  const percentile = belowCount / recentVols.length;

  // Classify
  let regime, score;
  if (percentile < lowThreshold) {
    regime = "low_vol";
    score = 1 - percentile / lowThreshold; // 1.0 at 0th pctile, 0.0 at threshold
  } else if (percentile > highThreshold) {
    regime = "high_vol";
    score = (percentile - highThreshold) / (1 - highThreshold);
  } else {
    regime = "medium_vol";
    score = 1 - 2 * Math.abs(percentile - 0.5); // strongest at 0.5
  }

  // Build regime history for the full series
  const history = rollingVols.map((rv, idx) => {
    const start = Math.max(0, idx - rankWindow + 1);
    const slice = rollingVols.slice(start, idx + 1).map(v => v.vol);
    const below = slice.filter(v => v < rv.vol).length;
    const pct = slice.length > 1 ? below / slice.length : 0.5;
    let r;
    if (pct < lowThreshold) r = "low_vol";
    else if (pct > highThreshold) r = "high_vol";
    else r = "medium_vol";
    return { date: rv.date, regime: r, percentile: pct, vol: rv.vol };
  });

  return { regime, score, rollingVol: currentVol, percentile, history };
}

// ─── Trend Regime (Hurst Exponent) ──────────────────────────

/**
 * Estimate the Hurst exponent using Rescaled Range (R/S) analysis.
 * H > 0.5 => trending (persistent), H < 0.5 => mean-reverting (anti-persistent)
 *
 * @param {Array} prices - Array of { date, close, ... }
 * @param {Object} opts
 * @param {number} opts.minWindow - Minimum R/S window (default 10)
 * @param {number} opts.maxWindow - Maximum R/S window (default 200)
 * @param {number} opts.lookback - How many recent prices to use (default 500)
 * @param {number} opts.trendThreshold - H above this = trending (default 0.55)
 * @param {number} opts.mrThreshold - H below this = mean-reverting (default 0.45)
 * @returns {{ regime: string, hurst: number, score: number, history: Array }}
 */
export function detectTrendRegime(prices, opts = {}) {
  const minWindow = opts.minWindow || 10;
  const maxWindow = opts.maxWindow || 200;
  const lookback = opts.lookback || 500;
  const trendThreshold = opts.trendThreshold || 0.55;
  const mrThreshold = opts.mrThreshold || 0.45;

  // Use recent prices
  const recentPrices = prices.slice(-Math.min(lookback, prices.length));

  // Compute log returns
  const logReturns = [];
  for (let i = 1; i < recentPrices.length; i++) {
    logReturns.push(Math.log(recentPrices[i].close / recentPrices[i - 1].close));
  }

  if (logReturns.length < minWindow * 2) {
    return { regime: "unknown", hurst: 0.5, score: 0, history: [] };
  }

  // R/S analysis across multiple window sizes
  const windowSizes = [];
  for (let w = minWindow; w <= Math.min(maxWindow, Math.floor(logReturns.length / 2)); w = Math.floor(w * 1.5)) {
    windowSizes.push(w);
  }

  const logN = [];
  const logRS = [];

  for (const n of windowSizes) {
    const numBlocks = Math.floor(logReturns.length / n);
    if (numBlocks < 1) continue;

    let rsSum = 0;
    let validBlocks = 0;

    for (let b = 0; b < numBlocks; b++) {
      const block = logReturns.slice(b * n, (b + 1) * n);
      const mean = block.reduce((a, v) => a + v, 0) / block.length;

      // Cumulative deviations
      let cumDev = 0;
      let maxCum = -Infinity;
      let minCum = Infinity;
      for (const r of block) {
        cumDev += r - mean;
        if (cumDev > maxCum) maxCum = cumDev;
        if (cumDev < minCum) minCum = cumDev;
      }

      const range = maxCum - minCum;
      const stdDev = Math.sqrt(block.reduce((s, r) => s + (r - mean) ** 2, 0) / block.length);

      if (stdDev > 0) {
        rsSum += range / stdDev;
        validBlocks++;
      }
    }

    if (validBlocks > 0) {
      logN.push(Math.log(n));
      logRS.push(Math.log(rsSum / validBlocks));
    }
  }

  // Linear regression: log(R/S) = H * log(n) + c
  let hurst = 0.5;
  if (logN.length >= 2) {
    const n = logN.length;
    const sumX = logN.reduce((a, b) => a + b, 0);
    const sumY = logRS.reduce((a, b) => a + b, 0);
    const sumXY = logN.reduce((s, x, i) => s + x * logRS[i], 0);
    const sumX2 = logN.reduce((s, x) => s + x * x, 0);

    hurst = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    hurst = Math.max(0, Math.min(1, hurst)); // clamp to [0, 1]
  }

  // Classify
  let regime, score;
  if (hurst > trendThreshold) {
    regime = "trending";
    score = Math.min(1, (hurst - trendThreshold) / (1 - trendThreshold));
  } else if (hurst < mrThreshold) {
    regime = "mean_reverting";
    score = Math.min(1, (mrThreshold - hurst) / mrThreshold);
  } else {
    regime = "random_walk";
    score = 1 - 2 * Math.abs(hurst - 0.5);
  }

  // Build rolling Hurst history using sliding window
  const rollingWindow = opts.rollingHurstWindow || 120;
  const history = [];
  for (let end = rollingWindow; end <= logReturns.length; end++) {
    const slice = logReturns.slice(end - rollingWindow, end);
    const h = computeHurstFast(slice, minWindow);
    const dateIdx = Math.min(end, recentPrices.length - 1);
    let r;
    if (h > trendThreshold) r = "trending";
    else if (h < mrThreshold) r = "mean_reverting";
    else r = "random_walk";
    history.push({ date: recentPrices[dateIdx].date, regime: r, hurst: h });
  }

  return { regime, hurst, score, history };
}

/**
 * Fast Hurst estimator for rolling window use.
 */
function computeHurstFast(returns, minWindow = 10) {
  const sizes = [minWindow, Math.floor(minWindow * 2), Math.floor(minWindow * 4)].filter(s => s <= Math.floor(returns.length / 2));
  if (sizes.length < 2) return 0.5;

  const logN = [];
  const logRS = [];

  for (const n of sizes) {
    const numBlocks = Math.floor(returns.length / n);
    let rsSum = 0;
    let valid = 0;

    for (let b = 0; b < numBlocks; b++) {
      const block = returns.slice(b * n, (b + 1) * n);
      const mean = block.reduce((a, v) => a + v, 0) / block.length;
      let cumDev = 0, maxC = -Infinity, minC = Infinity;
      for (const r of block) {
        cumDev += r - mean;
        if (cumDev > maxC) maxC = cumDev;
        if (cumDev < minC) minC = cumDev;
      }
      const range = maxC - minC;
      const std = Math.sqrt(block.reduce((s, r) => s + (r - mean) ** 2, 0) / block.length);
      if (std > 0) { rsSum += range / std; valid++; }
    }
    if (valid > 0) {
      logN.push(Math.log(n));
      logRS.push(Math.log(rsSum / valid));
    }
  }

  if (logN.length < 2) return 0.5;
  const nPts = logN.length;
  const sumX = logN.reduce((a, b) => a + b, 0);
  const sumY = logRS.reduce((a, b) => a + b, 0);
  const sumXY = logN.reduce((s, x, i) => s + x * logRS[i], 0);
  const sumX2 = logN.reduce((s, x) => s + x * x, 0);
  const h = (nPts * sumXY - sumX * sumY) / (nPts * sumX2 - sumX * sumX);
  return Math.max(0, Math.min(1, h));
}

// ─── Momentum Regime (Risk-On / Risk-Off) ───────────────────

/**
 * Detect risk-on/risk-off regime based on cross-timeframe momentum.
 * Uses multiple lookback windows to assess momentum breadth.
 *
 * @param {Array} prices - Array of { date, close, ... }
 * @param {Object} opts
 * @param {Array<number>} opts.lookbacks - Momentum lookback periods (default [5, 10, 20, 60])
 * @param {number} opts.riskOnThreshold - Fraction of positive momentums to be risk-on (default 0.6)
 * @param {number} opts.riskOffThreshold - Fraction below this = risk-off (default 0.4)
 * @returns {{ regime: string, score: number, momentums: Object, history: Array }}
 */
export function detectMomentumRegime(prices, opts = {}) {
  const lookbacks = opts.lookbacks || [5, 10, 20, 60];
  const riskOnThreshold = opts.riskOnThreshold || 0.6;
  const riskOffThreshold = opts.riskOffThreshold || 0.4;

  const maxLookback = Math.max(...lookbacks);
  if (prices.length < maxLookback + 1) {
    return { regime: "unknown", score: 0, momentums: {}, history: [] };
  }

  // Compute current momentum across timeframes
  const currentPrice = prices[prices.length - 1].close;
  const momentums = {};
  let positiveCount = 0;
  let totalMomentum = 0;

  for (const lb of lookbacks) {
    const pastPrice = prices[prices.length - 1 - lb].close;
    const mom = (currentPrice - pastPrice) / pastPrice;
    momentums[`mom_${lb}d`] = mom;
    if (mom > 0) positiveCount++;
    totalMomentum += mom;
  }

  const breadth = positiveCount / lookbacks.length;
  const avgMomentum = totalMomentum / lookbacks.length;

  // Classify
  let regime, score;
  if (breadth >= riskOnThreshold) {
    regime = "risk_on";
    score = (breadth - riskOnThreshold) / (1 - riskOnThreshold);
  } else if (breadth <= riskOffThreshold) {
    regime = "risk_off";
    score = (riskOffThreshold - breadth) / riskOffThreshold;
  } else {
    regime = "neutral";
    score = 1 - 2 * Math.abs(breadth - 0.5);
  }

  // Build rolling history
  const history = [];
  for (let i = maxLookback; i < prices.length; i++) {
    let posCount = 0;
    for (const lb of lookbacks) {
      const mom = (prices[i].close - prices[i - lb].close) / prices[i - lb].close;
      if (mom > 0) posCount++;
    }
    const b = posCount / lookbacks.length;
    let r;
    if (b >= riskOnThreshold) r = "risk_on";
    else if (b <= riskOffThreshold) r = "risk_off";
    else r = "neutral";
    history.push({ date: prices[i].date, regime: r, breadth: b });
  }

  return { regime, score, momentums, breadth, avgMomentum, history };
}

// ─── Combined Regime Detection ──────────────────────────────

/**
 * Run all three regime detectors and return a combined regime state.
 *
 * @param {Array} prices - Array of { date, close, ... }
 * @param {Object} opts - Options passed to individual detectors
 * @returns {{ volatility: Object, trend: Object, momentum: Object, combined: string }}
 */
export function detectAllRegimes(prices, opts = {}) {
  const volatility = detectVolatilityRegime(prices, opts);
  const trend = detectTrendRegime(prices, opts);
  const momentum = detectMomentumRegime(prices, opts);

  // Combined label: e.g. "high_vol_trending_risk_off"
  const combined = `${volatility.regime}_${trend.regime}_${momentum.regime}`;

  return { volatility, trend, momentum, combined };
}

// ─── Regime-Based Weight Maps ───────────────────────────────

/**
 * Default regime-conditioned weight profiles for ensemble strategies.
 * Maps regime combinations to strategy weight adjustments.
 *
 * Returns a multiplier map: { strategyType: multiplier }
 * where strategyType is one of: momentum, mean_reversion, breakout, trend_following
 */
export function getRegimeWeights(regimes) {
  const vol = regimes.volatility?.regime || "medium_vol";
  const trend = regimes.trend?.regime || "random_walk";
  const mom = regimes.momentum?.regime || "neutral";

  // Base weights (equal)
  const weights = {
    momentum: 1.0,
    mean_reversion: 1.0,
    breakout: 1.0,
    trend_following: 1.0,
  };

  // Volatility adjustments
  if (vol === "high_vol") {
    weights.mean_reversion *= 1.5;  // mean-reversion works better in high vol
    weights.momentum *= 0.5;        // momentum gets whipsawed
    weights.breakout *= 1.3;        // breakouts are real in high vol
    weights.trend_following *= 0.7;
  } else if (vol === "low_vol") {
    weights.mean_reversion *= 0.7;  // less opportunity
    weights.momentum *= 1.3;        // trending tends to persist
    weights.breakout *= 0.5;        // fewer breakouts
    weights.trend_following *= 1.5;
  }

  // Trend adjustments
  if (trend === "trending") {
    weights.trend_following *= 1.5;
    weights.momentum *= 1.3;
    weights.mean_reversion *= 0.5;  // don't fight trends
  } else if (trend === "mean_reverting") {
    weights.mean_reversion *= 1.5;
    weights.trend_following *= 0.5;
    weights.momentum *= 0.7;
  }

  // Momentum regime adjustments
  if (mom === "risk_on") {
    weights.momentum *= 1.2;
    weights.trend_following *= 1.2;
    weights.mean_reversion *= 0.8;
  } else if (mom === "risk_off") {
    weights.momentum *= 0.6;        // momentum crashes in risk-off
    weights.mean_reversion *= 1.3;
    weights.trend_following *= 0.8;
    weights.breakout *= 0.7;
  }

  // Normalize so weights sum to number of strategies
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const numStrategies = Object.keys(weights).length;
  for (const key of Object.keys(weights)) {
    weights[key] = (weights[key] / total) * numStrategies;
  }

  return weights;
}

// ─── CLI ─────────────────────────────────────────────────────

async function main() {
  const { generateRealisticPrices } = await import("../data/fetch.mjs");

  const args = process.argv.slice(2);
  const symbol = args.find(a => !a.startsWith("--")) || "SPY";
  const startDate = "2020-01-01";
  const endDate = "2024-12-31";

  console.log(`\n=== Regime Detection: ${symbol} ===\n`);

  const prices = generateRealisticPrices(symbol, startDate, endDate);

  const regimes = detectAllRegimes(prices);

  console.log("Volatility Regime:");
  console.log(`  Regime:     ${regimes.volatility.regime}`);
  console.log(`  Score:      ${regimes.volatility.score.toFixed(4)}`);
  console.log(`  RollingVol: ${(regimes.volatility.rollingVol * 100).toFixed(2)}%`);
  console.log(`  Percentile: ${(regimes.volatility.percentile * 100).toFixed(1)}%`);

  console.log("\nTrend Regime:");
  console.log(`  Regime:     ${regimes.trend.regime}`);
  console.log(`  Hurst:      ${regimes.trend.hurst.toFixed(4)}`);
  console.log(`  Score:      ${regimes.trend.score.toFixed(4)}`);

  console.log("\nMomentum Regime:");
  console.log(`  Regime:     ${regimes.momentum.regime}`);
  console.log(`  Score:      ${regimes.momentum.score.toFixed(4)}`);
  console.log(`  Breadth:    ${(regimes.momentum.breadth * 100).toFixed(1)}%`);
  for (const [k, v] of Object.entries(regimes.momentum.momentums)) {
    console.log(`  ${k}:  ${(v * 100).toFixed(2)}%`);
  }

  console.log(`\nCombined:     ${regimes.combined}`);

  const weights = getRegimeWeights(regimes);
  console.log("\nRegime-Conditioned Strategy Weights:");
  for (const [strat, w] of Object.entries(weights)) {
    console.log(`  ${strat.padEnd(20)} ${w.toFixed(3)}`);
  }
}

if (process.argv[1]?.includes("regime-detector")) {
  main().catch(err => {
    console.error("Regime detection failed:", err.message);
    process.exit(1);
  });
}
