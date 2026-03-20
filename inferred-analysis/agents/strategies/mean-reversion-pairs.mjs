#!/usr/bin/env node
/**
 * Statistical Arbitrage: Mean-Reversion Pairs Trading — Inferred Analysis
 *
 * Implements cointegration-based pairs trading:
 * 1. Find cointegrated pairs (Engle-Granger two-step)
 * 2. Compute spread z-score
 * 3. Trade spread mean-reversion with dynamic hedge ratios
 *
 * Usage:
 *   node agents/strategies/mean-reversion-pairs.mjs
 *   import { findPairs, pairsStrategy } from './mean-reversion-pairs.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Cointegration Testing (Simplified Engle-Granger) ───

/**
 * Ordinary Least Squares regression: y = alpha + beta * x
 * Returns { alpha, beta, residuals }
 */
export function ols(y, x) {
  const n = y.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;

  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }

  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  const residuals = y.map((yi, i) => yi - alpha - beta * x[i]);

  return { alpha, beta, residuals };
}

/**
 * Augmented Dickey-Fuller test statistic (simplified).
 * Tests if residuals are stationary (i.e. pair is cointegrated).
 * Returns t-statistic — more negative = more stationary.
 * Critical values (5%): -2.86 for n=100, -3.41 for n=500
 */
export function adfStat(series) {
  const n = series.length;
  if (n < 20) return 0;

  // dy[t] = gamma * y[t-1] + epsilon
  const dy = [];
  const yLag = [];
  for (let i = 1; i < n; i++) {
    dy.push(series[i] - series[i - 1]);
    yLag.push(series[i - 1]);
  }

  // OLS: dy = gamma * yLag
  const reg = ols(dy, yLag);
  const gamma = reg.beta;

  // t-statistic
  const residVar = reg.residuals.reduce((s, r) => s + r * r, 0) / (reg.residuals.length - 1);
  const yLagVar = yLag.reduce((s, y) => s + (y - yLag.reduce((a, b) => a + b, 0) / yLag.length) ** 2, 0);
  const se = Math.sqrt(residVar / Math.max(yLagVar, 1e-10));

  return se > 0 ? gamma / se : 0;
}

/**
 * Test if two price series are cointegrated.
 * Returns { cointegrated, hedgeRatio, adf, halfLife }
 */
export function testCointegration(pricesA, pricesB, significance = -2.86) {
  const closesA = pricesA.map(p => p.close);
  const closesB = pricesB.map(p => p.close);
  const n = Math.min(closesA.length, closesB.length);

  const reg = ols(closesA.slice(0, n), closesB.slice(0, n));
  const adf = adfStat(reg.residuals);

  // Half-life of mean reversion (Ornstein-Uhlenbeck)
  const spreadLag = reg.residuals.slice(0, -1);
  const spreadDiff = reg.residuals.slice(1).map((r, i) => r - spreadLag[i]);
  const hlReg = ols(spreadDiff, spreadLag);
  const halfLife = hlReg.beta < 0 ? -Math.log(2) / hlReg.beta : Infinity;

  return {
    cointegrated: adf < significance,
    hedgeRatio: reg.beta,
    alpha: reg.alpha,
    adf,
    halfLife,
    spreadMean: reg.residuals.reduce((a, b) => a + b, 0) / reg.residuals.length,
    spreadStd: Math.sqrt(reg.residuals.reduce((s, r) => s + r * r, 0) / reg.residuals.length),
  };
}

/**
 * Find all cointegrated pairs from a set of assets.
 */
export function findPairs(priceArrays, significance = -2.86) {
  const symbols = Object.keys(priceArrays);
  const pairs = [];

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const result = testCointegration(priceArrays[symbols[i]], priceArrays[symbols[j]], significance);
      if (result.cointegrated && result.halfLife > 1 && result.halfLife < 126) {
        pairs.push({
          symbolA: symbols[i],
          symbolB: symbols[j],
          ...result,
        });
      }
    }
  }

  return pairs.sort((a, b) => a.adf - b.adf); // most cointegrated first
}

// ─── Z-Score Spread Calculation ─────────────────────────

/**
 * Compute rolling z-score of the spread.
 */
export function computeSpread(pricesA, pricesB, hedgeRatio, window = 21) {
  const n = Math.min(pricesA.length, pricesB.length);
  const spread = [];

  for (let i = 0; i < n; i++) {
    spread.push({
      date: pricesA[i].date,
      value: pricesA[i].close - hedgeRatio * pricesB[i].close,
      priceA: pricesA[i].close,
      priceB: pricesB[i].close,
    });
  }

  // Rolling z-score
  for (let i = window; i < spread.length; i++) {
    const windowSlice = spread.slice(i - window, i).map(s => s.value);
    const mean = windowSlice.reduce((a, b) => a + b, 0) / window;
    const std = Math.sqrt(windowSlice.reduce((s, v) => s + (v - mean) ** 2, 0) / window);
    spread[i].zScore = std > 0 ? (spread[i].value - mean) / std : 0;
    spread[i].mean = mean;
    spread[i].std = std;
  }

  return spread;
}

// ─── Pairs Trading Strategy ─────────────────────────────

/**
 * Generate pairs trading signals from spread z-scores.
 */
export function pairsStrategy(pricesA, pricesB, options = {}) {
  const {
    hedgeRatio = 1,
    lookback = 21,
    entryZ = 2.0,
    exitZ = 0.5,
    stopZ = 4.0,
    positionSize = 0.10,
  } = options;

  const spread = computeSpread(pricesA, pricesB, hedgeRatio, lookback);
  const signals = [];
  let inPosition = 0; // 1 = long spread, -1 = short spread, 0 = flat

  for (let i = lookback; i < spread.length; i++) {
    const z = spread[i].zScore;
    if (z === undefined) continue;

    let signal = inPosition;

    // Entry signals
    if (inPosition === 0) {
      if (z < -entryZ) signal = 1;  // spread too low → long spread (buy A, sell B)
      if (z > entryZ) signal = -1;  // spread too high → short spread (sell A, buy B)
    }

    // Exit signals
    if (inPosition === 1 && z > -exitZ) signal = 0;
    if (inPosition === -1 && z < exitZ) signal = 0;

    // Stop loss
    if (inPosition === 1 && z < -stopZ) signal = 0;
    if (inPosition === -1 && z > stopZ) signal = 0;

    inPosition = signal;

    signals.push({
      date: spread[i].date,
      signal,
      zScore: z,
      spread: spread[i].value,
      priceA: spread[i].priceA,
      priceB: spread[i].priceB,
    });
  }

  return signals;
}

/**
 * Backtest a pairs strategy.
 */
export function backtestPairs(signals, hedgeRatio, options = {}) {
  const { initialCapital = 1_000_000, positionSize = 0.10, costBps = 15 } = options;
  let capital = initialCapital;
  let posA = 0, posB = 0;
  let prevSignal = 0;
  let trades = 0;
  let peak = capital;
  let maxDD = 0;
  const dailyReturns = [];
  let prevEquity = capital;

  for (const sig of signals) {
    if (sig.signal !== prevSignal) {
      // Close existing
      if (posA !== 0) {
        capital += posA * sig.priceA + posB * sig.priceB;
        const closeCost = (Math.abs(posA * sig.priceA) + Math.abs(posB * sig.priceB)) * costBps / 10000;
        capital -= closeCost;
        posA = 0;
        posB = 0;
        trades++;
      }

      // Open new
      if (sig.signal !== 0) {
        const tradeSize = capital * positionSize;
        const cost = tradeSize * 2 * costBps / 10000; // both legs
        posA = sig.signal * (tradeSize / sig.priceA);
        posB = -sig.signal * hedgeRatio * (tradeSize / sig.priceB);
        capital -= tradeSize + cost;
        trades++;
      }

      prevSignal = sig.signal;
    }

    const equity = capital + posA * sig.priceA + posB * sig.priceB;
    const ret = (equity - prevEquity) / prevEquity;
    dailyReturns.push(ret);
    prevEquity = equity;

    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Close final
  if (posA !== 0 && signals.length > 0) {
    const last = signals[signals.length - 1];
    capital += posA * last.priceA + posB * last.priceB;
  }

  const n = dailyReturns.length;
  const totalReturn = (capital - initialCapital) / initialCapital;
  const meanRet = n > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / n : 0;
  const stdRet = n > 1 ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (n - 1)) : 0;

  return {
    total_return: totalReturn,
    annualized_return: n > 0 ? Math.pow(1 + totalReturn, 252 / n) - 1 : 0,
    sharpe: stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0,
    max_drawdown: maxDD,
    trades,
    days: n,
    final_capital: capital,
  };
}

// ─── Dynamic Hedge Ratio ────────────────────────────────

/**
 * Rolling OLS hedge ratio (Kalman filter simplified as exponential moving average).
 */
export function rollingHedgeRatio(pricesA, pricesB, window = 63) {
  const closesA = pricesA.map(p => p.close);
  const closesB = pricesB.map(p => p.close);
  const ratios = [];

  for (let i = window; i < closesA.length; i++) {
    const ySlice = closesA.slice(i - window, i);
    const xSlice = closesB.slice(i - window, i);
    const reg = ols(ySlice, xSlice);
    ratios.push({
      date: pricesA[i].date,
      hedgeRatio: reg.beta,
      alpha: reg.alpha,
    });
  }

  return ratios;
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Statistical Arbitrage: Pairs Trading ═══\n");

  const symbols = ["SPY", "QQQ", "IWM", "XLK", "XLF", "AAPL"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  // Find cointegrated pairs
  console.log("─── Cointegration Scan ───");
  const pairs = findPairs(priceArrays);
  console.log(`Found ${pairs.length} cointegrated pairs:\n`);

  for (const pair of pairs) {
    console.log(`  ${pair.symbolA}/${pair.symbolB}: ADF=${pair.adf.toFixed(2)}, hedge=${pair.hedgeRatio.toFixed(3)}, halfLife=${pair.halfLife.toFixed(0)} days`);
  }

  // Backtest best pair
  if (pairs.length > 0) {
    const best = pairs[0];
    console.log(`\n─── Backtesting ${best.symbolA}/${best.symbolB} ───`);

    const signals = pairsStrategy(
      priceArrays[best.symbolA],
      priceArrays[best.symbolB],
      { hedgeRatio: best.hedgeRatio, lookback: Math.round(best.halfLife), entryZ: 2.0, exitZ: 0.5 }
    );

    const result = backtestPairs(signals, best.hedgeRatio);
    console.log(`  Return:  ${(result.total_return * 100).toFixed(2)}%`);
    console.log(`  Sharpe:  ${result.sharpe.toFixed(3)}`);
    console.log(`  MaxDD:   ${(result.max_drawdown * 100).toFixed(2)}%`);
    console.log(`  Trades:  ${result.trades}`);
    console.log(`  Days:    ${result.days}`);

    // Z-score distribution
    const zScores = signals.map(s => s.zScore).filter(z => z !== undefined);
    const longCount = signals.filter(s => s.signal === 1).length;
    const shortCount = signals.filter(s => s.signal === -1).length;
    const flatCount = signals.filter(s => s.signal === 0).length;
    console.log(`\n  Signal distribution: Long=${longCount} Short=${shortCount} Flat=${flatCount}`);
    console.log(`  Z-score range: [${Math.min(...zScores).toFixed(2)}, ${Math.max(...zScores).toFixed(2)}]`);
  }

  // Rolling hedge ratio analysis
  if (pairs.length > 0) {
    const best = pairs[0];
    console.log(`\n─── Rolling Hedge Ratio (${best.symbolA}/${best.symbolB}) ───`);
    const ratios = rollingHedgeRatio(priceArrays[best.symbolA], priceArrays[best.symbolB], 63);
    const hrValues = ratios.map(r => r.hedgeRatio);
    console.log(`  Mean:  ${(hrValues.reduce((a, b) => a + b, 0) / hrValues.length).toFixed(4)}`);
    console.log(`  Std:   ${Math.sqrt(hrValues.reduce((s, v) => s + (v - hrValues.reduce((a, b) => a + b, 0) / hrValues.length) ** 2, 0) / hrValues.length).toFixed(4)}`);
    console.log(`  Range: [${Math.min(...hrValues).toFixed(4)}, ${Math.max(...hrValues).toFixed(4)}]`);
  }
}

if (process.argv[1]?.includes("mean-reversion-pairs")) {
  main().catch(console.error);
}
