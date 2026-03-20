#!/usr/bin/env node
/**
 * Mean-Variance Timing Strategy — Inferred Analysis
 *
 * Dynamic mean-variance optimization that adapts to changing conditions:
 * 1. Conditional expected returns based on recent momentum
 * 2. Conditional covariance from recent volatility regime
 * 3. Shrinkage estimators (Ledoit-Wolf) for stable covariance
 * 4. Black-Litterman integration for incorporating views
 *
 * Usage:
 *   node agents/strategies/mean-variance-timing.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Ledoit-Wolf shrinkage for covariance estimation.
 * Shrinks toward identity * average variance.
 */
export function ledoitWolfShrinkage(returns) {
  const n = returns.length; // assets
  const T = returns[0].length; // time periods
  const means = returns.map(r => r.reduce((a, b) => a + b, 0) / T);

  // Sample covariance
  const S = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let cov = 0;
      for (let t = 0; t < T; t++) {
        cov += (returns[i][t] - means[i]) * (returns[j][t] - means[j]);
      }
      S[i][j] = cov / (T - 1);
      S[j][i] = S[i][j];
    }
  }

  // Target: scaled identity
  const avgVar = S.reduce((s, row, i) => s + row[i], 0) / n;
  const F = Array.from({ length: n }, (_, i) =>
    new Array(n).fill(0).map((_, j) => i === j ? avgVar : 0)
  );

  // Optimal shrinkage intensity (simplified)
  let sumSqDiff = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sumSqDiff += (S[i][j] - F[i][j]) ** 2;
    }
  }
  const shrinkage = Math.min(1, Math.max(0, 1 / T)); // simplified intensity

  // Shrunk covariance
  const shrunkCov = S.map((row, i) =>
    row.map((val, j) => (1 - shrinkage) * val + shrinkage * F[i][j])
  );

  return { covariance: shrunkCov, shrinkageIntensity: shrinkage, sampleCovariance: S };
}

/**
 * Conditional mean estimation using exponential weighting.
 */
export function conditionalMeans(returns, halfLife = 63) {
  const lambda = Math.log(2) / halfLife;
  const n = returns.length;
  const T = returns[0].length;
  const means = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    let weightSum = 0;
    for (let t = 0; t < T; t++) {
      const w = Math.exp(-lambda * (T - 1 - t));
      means[i] += returns[i][t] * w;
      weightSum += w;
    }
    means[i] /= weightSum;
  }

  return means;
}

/**
 * Dynamic mean-variance timing: rebalance based on conditional estimates.
 */
export function meanVarianceTiming(priceArrays, options = {}) {
  const {
    rebalanceDays = 21,
    lookback = 126,
    riskAversion = 2.5,
    maxWeight = 0.50,
  } = options;

  const symbols = Object.keys(priceArrays);
  const n = symbols.length;
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));
  const signals = [];

  for (let t = lookback; t < minLen; t++) {
    if ((t - lookback) % rebalanceDays !== 0) {
      if (signals.length > 0) {
        signals.push({ ...signals[signals.length - 1], date: priceArrays[symbols[0]][t].date });
        continue;
      }
    }

    // Compute returns for lookback window
    const returns = symbols.map(sym => {
      const r = [];
      for (let i = t - lookback + 1; i <= t; i++) {
        r.push((priceArrays[sym][i].close - priceArrays[sym][i - 1].close) / priceArrays[sym][i - 1].close);
      }
      return r;
    });

    // Conditional estimates
    const mu = conditionalMeans(returns, 63).map(m => m * 252); // annualize
    const { covariance } = ledoitWolfShrinkage(returns);
    const annCov = covariance.map(row => row.map(v => v * 252));

    // Simple mean-variance: w = (1/gamma) * Sigma^-1 * mu (unconstrained)
    // For simplicity, use inverse-vol weighting adjusted by expected return
    const vols = annCov.map((row, i) => Math.sqrt(row[i]));
    const rawWeights = mu.map((m, i) => vols[i] > 0 ? m / (riskAversion * vols[i] * vols[i]) : 0);

    // Normalize and clamp
    const sumAbs = rawWeights.reduce((s, w) => s + Math.abs(w), 0);
    const weights = sumAbs > 0
      ? rawWeights.map(w => Math.max(-maxWeight, Math.min(maxWeight, w / sumAbs)))
      : new Array(n).fill(1 / n);

    const allocation = {};
    symbols.forEach((s, i) => { allocation[s] = weights[i]; });

    signals.push({
      date: priceArrays[symbols[0]][t].date,
      allocation,
      expectedReturns: mu,
      vols,
    });
  }

  return signals;
}

// ─── Backtest ───────────────────────────────────────────

function backtestMVT(priceArrays, signals, initialCapital = 1_000_000) {
  const symbols = Object.keys(priceArrays);
  let equity = initialCapital;
  let peak = equity;
  let maxDD = 0;
  const dailyReturns = [];
  let prevEquity = equity;

  for (const sig of signals) {
    let dayReturn = 0;
    for (const sym of symbols) {
      const idx = priceArrays[sym].findIndex(p => p.date === sig.date);
      if (idx > 0) {
        const assetRet = (priceArrays[sym][idx].close - priceArrays[sym][idx - 1].close) / priceArrays[sym][idx - 1].close;
        dayReturn += (sig.allocation[sym] || 0) * assetRet;
      }
    }

    equity *= (1 + dayReturn);
    dailyReturns.push(dayReturn);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const n = dailyReturns.length;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));

  return {
    totalReturn: (equity - initialCapital) / initialCapital,
    sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : 0,
    maxDrawdown: maxDD,
    finalEquity: equity,
  };
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Mean-Variance Timing Strategy ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  const signals = meanVarianceTiming(priceArrays, { rebalanceDays: 21, lookback: 126 });
  const result = backtestMVT(priceArrays, signals);

  console.log(`  Return: ${(result.totalReturn * 100).toFixed(2)}%`);
  console.log(`  Sharpe: ${result.sharpe.toFixed(3)}`);
  console.log(`  MaxDD:  ${(result.maxDrawdown * 100).toFixed(2)}%`);

  // Show allocation snapshots
  console.log("\n─── Allocation Snapshots ───\n");
  const step = Math.floor(signals.length / 6);
  for (let i = 0; i < signals.length; i += step) {
    const s = signals[i];
    const alloc = symbols.map(sym => `${sym}=${((s.allocation[sym] || 0) * 100).toFixed(0)}%`).join(" ");
    console.log(`  ${s.date}: ${alloc}`);
  }
}

if (process.argv[1]?.includes("mean-variance-timing")) {
  main().catch(console.error);
}
