#!/usr/bin/env node
/**
 * Strategy Ensemble Combiner — Inferred Analysis
 *
 * Advanced methods for combining multiple strategy signals:
 * 1. Inverse-variance weighting
 * 2. Kelly criterion-based allocation
 * 3. Online learning (multiplicative weights / Hedge algorithm)
 * 4. Bayesian model averaging
 * 5. Stacking with meta-learner
 *
 * Usage:
 *   node agents/ensemble/strategy-combiner.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Equal weight combination.
 */
export function equalWeightCombine(strategyReturns) {
  const names = Object.keys(strategyReturns);
  const n = names.length;
  const T = Math.min(...names.map(s => strategyReturns[s].length));
  const combined = [];

  for (let t = 0; t < T; t++) {
    let r = 0;
    for (const name of names) {
      r += (strategyReturns[name][t] || 0) / n;
    }
    combined.push(r);
  }
  return combined;
}

/**
 * Inverse-variance weighting: allocate more to lower-vol strategies.
 */
export function inverseVarianceCombine(strategyReturns, lookback = 63) {
  const names = Object.keys(strategyReturns);
  const T = Math.min(...names.map(s => strategyReturns[s].length));
  const combined = [];

  for (let t = 0; t < T; t++) {
    if (t < lookback) {
      // Equal weight for warm-up period
      let r = 0;
      for (const name of names) r += strategyReturns[name][t] / names.length;
      combined.push(r);
      continue;
    }

    // Compute rolling variance for each strategy
    const vars = names.map(name => {
      const slice = strategyReturns[name].slice(t - lookback, t);
      const mean = slice.reduce((a, b) => a + b, 0) / lookback;
      return slice.reduce((s, x) => s + (x - mean) ** 2, 0) / (lookback - 1);
    });

    const invVars = vars.map(v => v > 1e-10 ? 1 / v : 0);
    const sumInvVar = invVars.reduce((a, b) => a + b, 0);
    const weights = sumInvVar > 0 ? invVars.map(iv => iv / sumInvVar) : new Array(names.length).fill(1 / names.length);

    let r = 0;
    names.forEach((name, i) => { r += weights[i] * strategyReturns[name][t]; });
    combined.push(r);
  }

  return combined;
}

/**
 * Kelly criterion-based allocation.
 */
export function kellyCombine(strategyReturns, lookback = 126, fractionKelly = 0.5) {
  const names = Object.keys(strategyReturns);
  const T = Math.min(...names.map(s => strategyReturns[s].length));
  const combined = [];

  for (let t = 0; t < T; t++) {
    if (t < lookback) {
      let r = 0;
      for (const name of names) r += strategyReturns[name][t] / names.length;
      combined.push(r);
      continue;
    }

    const weights = names.map(name => {
      const slice = strategyReturns[name].slice(t - lookback, t);
      const mean = slice.reduce((a, b) => a + b, 0) / lookback;
      const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / (lookback - 1);
      // Kelly fraction: f* = mu / sigma^2
      return variance > 1e-10 ? fractionKelly * mean / variance : 0;
    });

    // Normalize if sum of abs weights > 1
    const sumAbs = weights.reduce((s, w) => s + Math.abs(w), 0);
    const scale = sumAbs > 1 ? 1 / sumAbs : 1;

    let r = 0;
    names.forEach((name, i) => { r += weights[i] * scale * strategyReturns[name][t]; });
    combined.push(r);
  }
  return combined;
}

/**
 * Online learning: Multiplicative Weights Update (Hedge algorithm).
 */
export function hedgeAlgorithm(strategyReturns, eta = 0.1) {
  const names = Object.keys(strategyReturns);
  const n = names.length;
  const T = Math.min(...names.map(s => strategyReturns[s].length));
  const combined = [];
  const weightHistory = [];

  // Initialize uniform weights
  let weights = new Array(n).fill(1 / n);

  for (let t = 0; t < T; t++) {
    // Combine using current weights
    let r = 0;
    names.forEach((name, i) => { r += weights[i] * strategyReturns[name][t]; });
    combined.push(r);
    weightHistory.push([...weights]);

    // Update weights: multiplicative update
    const newWeights = names.map((name, i) => {
      const expertReturn = strategyReturns[name][t];
      return weights[i] * Math.exp(eta * expertReturn);
    });

    const sumW = newWeights.reduce((a, b) => a + b, 0);
    weights = newWeights.map(w => w / sumW);
  }

  return { combined, weights, weightHistory };
}

/**
 * Bayesian model averaging with rolling likelihood.
 */
export function bayesianModelAvg(strategyReturns, lookback = 63) {
  const names = Object.keys(strategyReturns);
  const n = names.length;
  const T = Math.min(...names.map(s => strategyReturns[s].length));
  const combined = [];

  // Prior: uniform
  let logPosterior = new Array(n).fill(0);

  for (let t = 0; t < T; t++) {
    // Softmax to get weights from log-posteriors
    const maxLP = Math.max(...logPosterior);
    const expLP = logPosterior.map(lp => Math.exp(lp - maxLP));
    const sumExp = expLP.reduce((a, b) => a + b, 0);
    const weights = expLP.map(e => e / sumExp);

    let r = 0;
    names.forEach((name, i) => { r += weights[i] * strategyReturns[name][t]; });
    combined.push(r);

    // Update log-posteriors using Gaussian likelihood
    if (t >= lookback) {
      for (let i = 0; i < n; i++) {
        const slice = strategyReturns[names[i]].slice(t - lookback, t);
        const mean = slice.reduce((a, b) => a + b, 0) / lookback;
        const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / lookback;
        // Log-likelihood ∝ Sharpe ratio (signal-to-noise)
        const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;
        logPosterior[i] = sharpe * Math.sqrt(lookback); // t-stat
      }
    }
  }

  return combined;
}

/**
 * Stacking meta-learner: train weights on validation fold.
 */
export function stackingCombine(strategyReturns, trainFraction = 0.5) {
  const names = Object.keys(strategyReturns);
  const T = Math.min(...names.map(s => strategyReturns[s].length));
  const trainEnd = Math.floor(T * trainFraction);

  // Train: find weights that minimize MSE on training set
  // Simple approach: use Sharpe-weighted combination from training period
  const trainWeights = names.map(name => {
    const slice = strategyReturns[name].slice(0, trainEnd);
    const mean = slice.reduce((a, b) => a + b, 0) / trainEnd;
    const std = Math.sqrt(slice.reduce((s, x) => s + (x - mean) ** 2, 0) / (trainEnd - 1));
    return std > 0 ? mean / (std * std) : 0; // Sharpe-weighted
  });

  const sumAbs = trainWeights.reduce((s, w) => s + Math.abs(w), 0);
  const weights = sumAbs > 0 ? trainWeights.map(w => w / sumAbs) : new Array(names.length).fill(1 / names.length);

  const combined = [];
  for (let t = 0; t < T; t++) {
    let r = 0;
    names.forEach((name, i) => { r += weights[i] * strategyReturns[name][t]; });
    combined.push(r);
  }

  return { combined, weights: Object.fromEntries(names.map((n, i) => [n, weights[i]])) };
}

/**
 * Compare all combination methods.
 */
export function compareCombinationMethods(strategyReturns) {
  const methods = {
    equalWeight: equalWeightCombine(strategyReturns),
    inverseVariance: inverseVarianceCombine(strategyReturns),
    kelly: kellyCombine(strategyReturns),
    hedge: hedgeAlgorithm(strategyReturns).combined,
    bayesian: bayesianModelAvg(strategyReturns),
    stacking: stackingCombine(strategyReturns).combined,
  };

  const results = {};
  for (const [name, returns] of Object.entries(methods)) {
    const n = returns.length;
    const mean = returns.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
    let equity = 1, peak = 1, maxDD = 0;
    for (const r of returns) {
      equity *= (1 + r);
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    results[name] = {
      totalReturn: equity - 1,
      sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : 0,
      maxDD,
      annVol: std * Math.sqrt(252),
    };
  }

  return results;
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Strategy Ensemble Combiner ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD", "XLE"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  const n = Math.min(...symbols.map(s => priceArrays[s].length)) - 1;

  // Simulate strategy returns
  const strategyReturns = {
    Momentum: [],
    MeanRevert: [],
    Carry: [],
    Trend: [],
  };

  for (let i = 1; i <= n; i++) {
    const spyR = (priceArrays.SPY[i].close - priceArrays.SPY[i - 1].close) / priceArrays.SPY[i - 1].close;
    const qqqR = (priceArrays.QQQ[i].close - priceArrays.QQQ[i - 1].close) / priceArrays.QQQ[i - 1].close;
    const tltR = (priceArrays.TLT[i].close - priceArrays.TLT[i - 1].close) / priceArrays.TLT[i - 1].close;
    const gldR = (priceArrays.GLD[i].close - priceArrays.GLD[i - 1].close) / priceArrays.GLD[i - 1].close;

    strategyReturns.Momentum.push(spyR * 1.2 + 0.0001);
    strategyReturns.MeanRevert.push(-spyR * 0.3 + tltR * 0.7 + 0.0002);
    strategyReturns.Carry.push(tltR * 0.5 + gldR * 0.3 + 0.00015);
    strategyReturns.Trend.push(qqqR * 0.8 + spyR * 0.3 - 0.0001);
  }

  const results = compareCombinationMethods(strategyReturns);

  console.log("  Method            Return   Sharpe  MaxDD   Vol");
  console.log("  " + "─".repeat(52));
  for (const [method, stats] of Object.entries(results)) {
    console.log(`  ${method.padEnd(18)} ${(stats.totalReturn * 100).toFixed(1).padStart(6)}% ${stats.sharpe.toFixed(3).padStart(7)} ${(stats.maxDD * 100).toFixed(1).padStart(5)}% ${(stats.annVol * 100).toFixed(1).padStart(5)}%`);
  }

  // Show Hedge algorithm weight evolution
  const hedgeResult = hedgeAlgorithm(strategyReturns, 0.5);
  console.log("\n─── Hedge Algorithm Weight Evolution ───\n");
  const names = Object.keys(strategyReturns);
  const step = Math.floor(hedgeResult.weightHistory.length / 8);
  for (let i = 0; i < hedgeResult.weightHistory.length; i += step) {
    const w = hedgeResult.weightHistory[i];
    const bars = names.map((name, j) => `${name.slice(0, 4)}=${(w[j] * 100).toFixed(0)}%`).join(" ");
    console.log(`  t=${String(i).padStart(4)}: ${bars}`);
  }
}

if (process.argv[1]?.includes("strategy-combiner")) {
  main().catch(console.error);
}
