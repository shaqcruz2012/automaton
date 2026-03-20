#!/usr/bin/env node
/**
 * Cross-Validation Frameworks — Inferred Analysis
 *
 * Time-aware CV methods for strategy validation. Standard k-fold ignores
 * temporal ordering; this module prevents data leakage via walk-forward,
 * purged k-fold, and CPCV splits. Includes deflated Sharpe ratio for
 * multiple testing correction.
 *
 * Usage:
 *   node agents/optimizer/cross-validation.mjs
 *   node agents/optimizer/cross-validation.mjs --symbol SPY --folds 10
 *   node agents/optimizer/cross-validation.mjs --method cpcv --splits 6 --test-splits 2
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Walk-Forward Cross-Validation ──────────────────────────

/**
 * Walk-forward CV splits. Slides a train+test window through the data.
 * @param {Array} data - Price data array
 * @param {number} trainSize - Training window size
 * @param {number} testSize - Test window size
 * @param {number} stepSize - Step between folds
 * @returns {Array<{trainStart: number, trainEnd: number, testStart: number, testEnd: number, fold: number}>}
 */
export function walkForwardCV(data, trainSize, testSize, stepSize) {
  const folds = [];
  let fold = 0;
  for (let s = 0; s + trainSize + testSize <= data.length; s += stepSize) {
    folds.push({
      trainStart: s, trainEnd: s + trainSize - 1,
      testStart: s + trainSize, testEnd: s + trainSize + testSize - 1,
      fold: fold++,
    });
  }
  return folds;
}

// ─── Purged K-Fold ──────────────────────────────────────────

/**
 * Purged k-fold CV for time series. Removes observations near train/test
 * boundary (purge) and applies embargo after test set to avoid leakage.
 * @param {Array} data - Price observations
 * @param {number} k - Number of folds
 * @param {number} purgeGap - Observations to purge at boundary
 * @param {number} embargoGap - Embargo observations after test set
 * @returns {Array<{fold: number, trainIndices: number[], testIndices: number[]}>}
 */
export function purgedKFold(data, k, purgeGap = 3, embargoGap = 5) {
  const n = data.length;
  const foldSize = Math.floor(n / k);
  const folds = [];
  for (let i = 0; i < k; i++) {
    const testStart = i * foldSize;
    const testEnd = i === k - 1 ? n - 1 : (i + 1) * foldSize - 1;
    const testIndices = [];
    for (let j = testStart; j <= testEnd; j++) testIndices.push(j);
    const purgeStart = Math.max(0, testStart - purgeGap);
    const embargoEnd = Math.min(n - 1, testEnd + embargoGap);
    const trainIndices = [];
    for (let j = 0; j < n; j++) {
      if (j >= testStart && j <= testEnd) continue;
      if (j >= purgeStart && j < testStart) continue;
      if (j > testEnd && j <= embargoEnd) continue;
      trainIndices.push(j);
    }
    folds.push({ fold: i, trainIndices, testIndices });
  }
  return folds;
}

// ─── Combinatorial Purged CV ────────────────────────────────

/** Generate all k-element combinations from arr. */
function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [...combinations(rest, k - 1).map((c) => [first, ...c]), ...combinations(rest, k)];
}

/**
 * CPCV from Marcos Lopez de Prado. Splits data into nSplits groups, generates
 * all C(nSplits, nTestSplits) test combinations for exhaustive path coverage.
 * @param {Array} data - Price observations
 * @param {number} nSplits - Total groups
 * @param {number} nTestSplits - Groups used as test per combination
 * @returns {Array<{combo: number, testGroups: number[], trainIndices: number[], testIndices: number[]}>}
 */
export function combinatorialPurgedCV(data, nSplits, nTestSplits) {
  const n = data.length;
  const groupSize = Math.floor(n / nSplits);
  const groups = Array.from({ length: nSplits }, (_, i) => ({
    start: i * groupSize,
    end: i === nSplits - 1 ? n - 1 : (i + 1) * groupSize - 1,
  }));
  const combos = combinations(Array.from({ length: nSplits }, (_, i) => i), nTestSplits);
  return combos.map((testGroups, idx) => {
    const testSet = new Set();
    for (const g of testGroups)
      for (let j = groups[g].start; j <= groups[g].end; j++) testSet.add(j);
    const trainIndices = [], testIndices = [];
    for (let j = 0; j < n; j++) (testSet.has(j) ? testIndices : trainIndices).push(j);
    return { combo: idx, testGroups, trainIndices, testIndices };
  });
}

// ─── Utility Functions ──────────────────────────────────────

/** Annualized Sharpe ratio from daily returns. */
function calcSharpe(returns) {
  if (!returns || returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1));
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
}

/** Standard normal CDF (Abramowitz & Stegun approximation). */
function normalCDF(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const y = 1.0 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

/** Skewness of returns. */
function calcSkew(returns) {
  const n = returns.length, mean = returns.reduce((s, r) => s + r, 0) / n;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n);
  if (std === 0) return 0;
  return (returns.reduce((s, r) => s + ((r - mean) / std) ** 3, 0) * n) / ((n - 1) * (n - 2));
}

/** Excess kurtosis of returns. */
function calcKurtosis(returns) {
  const n = returns.length, mean = returns.reduce((s, r) => s + r, 0) / n;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n);
  if (std === 0) return 0;
  return returns.reduce((s, r) => s + ((r - mean) / std) ** 4, 0) / n - 3;
}

// ─── CrossValidator Class ───────────────────────────────────

/**
 * CV engine for strategy parameter optimization. Grid search over param space,
 * tracks train/test Sharpe, detects backtest overfitting via PBO.
 */
export class CrossValidator {
  /** @param {Function} strategyFn - (data, params) => daily returns array */
  /** @param {Object} paramGrid - e.g. { lookback: [10,20], threshold: [0.5,1.0] } */
  constructor(strategyFn, paramGrid) {
    this.strategyFn = strategyFn;
    this.paramGrid = paramGrid;
    this.results = [];
  }

  /**
   * Exhaustive grid search with cross-validation.
   * @param {Array} data - Price data
   * @param {string} cvMethod - "walkforward", "purged", or "cpcv"
   * @param {Object} [cvOpts] - CV method options
   * @returns {Array} Results sorted by test Sharpe descending
   */
  gridSearch(data, cvMethod = "walkforward", cvOpts = {}) {
    const paramCombos = this._expandGrid(this.paramGrid);
    const folds = this._getFolds(data, cvMethod, cvOpts);
    this.results = [];
    for (const params of paramCombos) {
      const foldResults = [];
      for (const fold of folds) {
        const trainData = this._sliceData(data, fold);
        const testData = this._sliceTestData(data, fold);
        const { trainSharpe, testSharpe } = this.evaluate(params, trainData, testData);
        foldResults.push({ trainSharpe, testSharpe });
      }
      const avgTrain = foldResults.reduce((s, r) => s + r.trainSharpe, 0) / foldResults.length;
      const avgTest = foldResults.reduce((s, r) => s + r.testSharpe, 0) / foldResults.length;
      const std = Math.sqrt(foldResults.reduce((s, r) => s + (r.testSharpe - avgTest) ** 2, 0) / foldResults.length);
      this.results.push({
        params, avgTrainSharpe: +avgTrain.toFixed(4), avgTestSharpe: +avgTest.toFixed(4),
        testSharpeStd: +std.toFixed(4), nFolds: foldResults.length, foldResults,
      });
    }
    this.results.sort((a, b) => b.avgTestSharpe - a.avgTestSharpe);
    return this.results;
  }

  /**
   * Run strategy with params on train/test data, return Sharpe ratios.
   * @param {Object} params - Strategy parameters
   * @param {Array} trainData - Training data
   * @param {Array} testData - Test data
   * @returns {{trainSharpe: number, testSharpe: number}}
   */
  evaluate(params, trainData, testData) {
    return {
      trainSharpe: calcSharpe(this.strategyFn(trainData, params)),
      testSharpe: calcSharpe(this.strategyFn(testData, params)),
    };
  }

  /** @returns {Array} Sorted results with train/test metrics. */
  getResults() { return this.results; }

  /**
   * Probability of Backtest Overfitting (PBO). Compares in-sample rank vs
   * out-of-sample rank using Spearman correlation.
   * @returns {{pbo: number, rankCorrelation: number, overfit: boolean}}
   */
  detectOverfitting() {
    if (this.results.length < 4) return { pbo: 0, rankCorrelation: 1, overfit: false };
    const n = this.results.length;
    const trainRanked = [...this.results]
      .sort((a, b) => b.avgTrainSharpe - a.avgTrainSharpe)
      .map((r, i) => ({ ...r, trainRank: i + 1 }));
    const testRankMap = new Map();
    [...this.results].sort((a, b) => b.avgTestSharpe - a.avgTestSharpe)
      .forEach((r, i) => testRankMap.set(JSON.stringify(r.params), i + 1));
    let sumD2 = 0, degraded = 0;
    for (const r of trainRanked) {
      const testRank = testRankMap.get(JSON.stringify(r.params));
      sumD2 += (r.trainRank - testRank) ** 2;
      if (r.trainRank <= n / 2 && testRank > n / 2) degraded++;
    }
    const rankCorrelation = +(1 - (6 * sumD2) / (n * (n * n - 1))).toFixed(4);
    const pbo = +(degraded / Math.ceil(n / 2)).toFixed(4);
    return { pbo, rankCorrelation, overfit: pbo > 0.5 || rankCorrelation < 0.3 };
  }

  /** @returns {string} ASCII summary of CV results. */
  formatReport() {
    const { pbo, rankCorrelation, overfit } = this.detectOverfitting();
    const L = [];
    L.push("╔══════════════════════════════════════════════════════════════╗");
    L.push("║          CROSS-VALIDATION RESULTS REPORT                   ║");
    L.push("╚══════════════════════════════════════════════════════════════╝");
    L.push("");
    L.push(`  Configurations tested:     ${this.results.length}`);
    L.push(`  Folds per config:          ${this.results[0]?.nFolds || 0}`);
    L.push(`  Rank correlation (IS/OOS): ${rankCorrelation}`);
    L.push(`  Prob of overfitting:       ${(pbo * 100).toFixed(1)}%`);
    L.push(`  Overfitting detected:      ${overfit ? "YES" : "NO"}`);
    L.push("");
    L.push("  ┌─────┬────────────────────────────┬───────────┬───────────┬──────────┐");
    L.push("  │ Rank│ Parameters                 │ Train SR  │ Test SR   │ Std      │");
    L.push("  ├─────┼────────────────────────────┼───────────┼───────────┼──────────┤");
    for (const [i, r] of this.results.slice(0, 15).entries()) {
      const p = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ").padEnd(26).slice(0, 26);
      L.push(`  │ ${String(i + 1).padStart(3)} │ ${p} │ ${r.avgTrainSharpe.toFixed(3).padStart(9)} │ ${r.avgTestSharpe.toFixed(3).padStart(9)} │ ${r.testSharpeStd.toFixed(3).padStart(8)} │`);
    }
    L.push("  └─────┴────────────────────────────┴───────────┴───────────┴──────────┘");
    if (overfit) {
      L.push("");
      L.push("  WARNING: High probability of backtest overfitting detected.");
      L.push("  IS performance does not predict OOS. Reduce parameter space.");
    }
    return L.join("\n");
  }

  /** Expand parameter grid into all combinations. */
  _expandGrid(grid) {
    const keys = Object.keys(grid);
    if (!keys.length) return [{}];
    let combos = [{}];
    for (const key of keys) {
      const expanded = [];
      for (const combo of combos) for (const val of grid[key]) expanded.push({ ...combo, [key]: val });
      combos = expanded;
    }
    return combos;
  }

  /** Get CV folds by method name. */
  _getFolds(data, method, opts) {
    if (method === "walkforward") return walkForwardCV(data, opts.trainSize || Math.floor(data.length * 0.5), opts.testSize || Math.floor(data.length * 0.1), opts.stepSize || Math.floor(data.length * 0.1));
    if (method === "purged") return purgedKFold(data, opts.k || 5, opts.purgeGap || 3, opts.embargoGap || 5);
    if (method === "cpcv") return combinatorialPurgedCV(data, opts.nSplits || 6, opts.nTestSplits || 2);
    throw new Error(`Unknown CV method: ${method}`);
  }

  /** Slice training data from fold. */
  _sliceData(data, fold) {
    return fold.trainIndices ? fold.trainIndices.map((i) => data[i]) : data.slice(fold.trainStart, fold.trainEnd + 1);
  }

  /** Slice test data from fold. */
  _sliceTestData(data, fold) {
    return fold.testIndices ? fold.testIndices.map((i) => data[i]) : data.slice(fold.testStart, fold.testEnd + 1);
  }
}

// ─── Deflated Sharpe Ratio ──────────────────────────────────

/**
 * Deflated Sharpe Ratio — adjusts for multiple testing (Bailey & de Prado 2014).
 * @param {number} sharpe - Observed best Sharpe ratio
 * @param {number} nTrials - Number of configurations tested
 * @param {number} skew - Return skewness
 * @param {number} kurtosis - Return excess kurtosis
 * @param {number} T - Number of return observations
 * @returns {{deflatedSharpe: number, pValue: number, significant: boolean}}
 */
export function deflatedSharpe(sharpe, nTrials, skew, kurtosis, T) {
  const gamma = 0.5772156649;
  const logN = Math.log(nTrials);
  const eMSR = Math.sqrt(2 * logN) - (Math.log(Math.PI) + gamma) / (2 * Math.sqrt(2 * logN));
  const sharpeVar = (1 + 0.5 * sharpe ** 2 - skew * sharpe + ((kurtosis - 3) / 4) * sharpe ** 2) / T;
  const testStat = (sharpe - eMSR) / Math.sqrt(sharpeVar);
  const pValue = 1 - normalCDF(testStat);
  return { deflatedSharpe: +testStat.toFixed(4), pValue: +pValue.toFixed(4), significant: pValue < 0.05 };
}

// ─── Demo Strategy ──────────────────────────────────────────

/** Simple momentum: long when price > lookback MA, flat otherwise. */
function momentumStrategy(data, params) {
  const { lookback = 20 } = params;
  const returns = [];
  for (let i = lookback; i < data.length; i++) {
    const ma = data.slice(i - lookback, i).reduce((s, d) => s + d.close, 0) / lookback;
    const signal = data[i - 1].close > ma ? 1 : 0;
    returns.push(signal * (data[i].close - data[i - 1].close) / data[i - 1].close);
  }
  return returns;
}

// ─── CLI ────────────────────────────────────────────────────

/** CLI entry point — full cross-validation demo with momentum strategy. */
function main() {
  const args = process.argv.slice(2);
  const opts = { symbol: "SPY", method: "walkforward", folds: 5, splits: 6, testSplits: 2 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbol") opts.symbol = args[++i];
    if (args[i] === "--method") opts.method = args[++i];
    if (args[i] === "--folds") opts.folds = parseInt(args[++i]);
    if (args[i] === "--splits") opts.splits = parseInt(args[++i]);
    if (args[i] === "--test-splits") opts.testSplits = parseInt(args[++i]);
  }

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       Cross-Validation Engine — Inferred Analysis           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  console.log(`  Generating price data for ${opts.symbol}...`);
  const data = generateRealisticPrices(opts.symbol, "2018-01-01", "2025-01-01");
  console.log(`  Data points: ${data.length}\n`);

  const paramGrid = { lookback: [5, 10, 20, 40, 60], holdDays: [1, 3, 5, 10] };
  console.log(`  Parameter grid: ${Object.entries(paramGrid).map(([k, v]) => `${k}=[${v}]`).join(", ")}`);
  console.log(`  Total combinations: ${Object.values(paramGrid).reduce((p, v) => p * v.length, 1)}`);
  console.log(`  CV method: ${opts.method}\n`);

  const cv = new CrossValidator(momentumStrategy, paramGrid);
  const cvOpts = {
    trainSize: Math.floor(data.length * 0.4), testSize: Math.floor(data.length * 0.1),
    stepSize: Math.floor(data.length * 0.1), k: opts.folds,
    nSplits: opts.splits, nTestSplits: opts.testSplits,
  };

  console.log("  Running grid search...");
  const results = cv.gridSearch(data, opts.method, cvOpts);
  console.log(`  Completed: ${results.length} configurations evaluated\n`);
  console.log(cv.formatReport());
  console.log();

  if (results.length > 0) {
    const best = results[0];
    const bestReturns = momentumStrategy(data, best.params);
    const skew = calcSkew(bestReturns), kurt = calcKurtosis(bestReturns);
    const dsr = deflatedSharpe(best.avgTestSharpe, results.length, skew, kurt, bestReturns.length);

    console.log("  ── Deflated Sharpe Ratio (Best Configuration) ──");
    console.log(`  Observed test Sharpe:    ${best.avgTestSharpe.toFixed(4)}`);
    console.log(`  Deflated Sharpe stat:    ${dsr.deflatedSharpe}`);
    console.log(`  p-value:                 ${dsr.pValue}`);
    console.log(`  Significant (p<0.05):    ${dsr.significant ? "YES" : "NO"}`);
    console.log(`  Trials:                  ${results.length}`);
    console.log(`  Skewness:                ${skew.toFixed(4)}`);
    console.log(`  Excess kurtosis:         ${kurt.toFixed(4)}\n`);

    const { pbo, rankCorrelation, overfit } = cv.detectOverfitting();
    console.log("  ── Overfitting Analysis ──");
    console.log(`  PBO:                     ${(pbo * 100).toFixed(1)}%`);
    console.log(`  IS/OOS rank correlation: ${rankCorrelation}`);
    console.log(`  Verdict:                 ${overfit ? "LIKELY OVERFIT" : "Acceptable"}`);
  }
  console.log("\n  Done.");
}

const isMain = process.argv[1] && process.argv[1].includes("cross-validation");
if (isMain) main();
