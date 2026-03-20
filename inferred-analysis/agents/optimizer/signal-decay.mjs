#!/usr/bin/env node
/**
 * Signal Decay Analysis Module — Inferred Analysis
 *
 * Analyzes how quickly trading signals lose predictive power.
 * Measures IC decay curves, signal half-life, turnover, autocorrelation,
 * optimal holding period, and signal crowding detection.
 *
 * Usage:
 *   node agents/optimizer/signal-decay.mjs                          # SPY momentum demo
 *   node agents/optimizer/signal-decay.mjs --symbol QQQ             # Different symbol
 *   node agents/optimizer/signal-decay.mjs --lookback 10            # 10-day momentum
 *   node agents/optimizer/signal-decay.mjs --start 2021-01-01       # Custom date range
 *
 * Exports:
 *   analyzeSignalDecay()     — full decay analysis suite
 *   getICDecayCurve()        — IC at multiple forward horizons
 *   optimalHoldingPeriod()   — where risk-adjusted return peaks
 *   signalCrowdingTest()     — detect alpha erosion over time
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Statistical Helpers ─────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
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

/**
 * Spearman rank correlation between two equal-length arrays.
 * IC is typically measured as rank correlation between signal and forward return.
 */
function spearmanCorrelation(x, y) {
  const n = x.length;
  if (n < 3) return 0;

  const rankX = toRanks(x);
  const rankY = toRanks(y);

  return pearsonCorrelation(rankX, rankY);
}

/** Pearson correlation coefficient */
function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n < 3) return 0;

  const mx = mean(x);
  const my = mean(y);

  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }

  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : 0;
}

/** Convert values to fractional ranks (average rank for ties) */
function toRanks(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j;
  }
  return ranks;
}

/** Approximate standard normal CDF */
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

// ─── Signal Generation ───────────────────────────────────

/**
 * Generate momentum signal: trailing return over lookback period.
 * Returns array of { date, signal, price } aligned with the price array.
 */
function generateMomentumSignal(prices, lookback = 20) {
  const signals = [];
  for (let i = lookback; i < prices.length; i++) {
    const pastPrice = prices[i - lookback].close;
    const currentPrice = prices[i].close;
    const momentum = (currentPrice - pastPrice) / pastPrice;
    signals.push({
      date: prices[i].date,
      signal: momentum,
      price: currentPrice,
      index: i,
    });
  }
  return signals;
}

/**
 * Compute forward returns at a given horizon from prices.
 * Returns array aligned with signals (trimmed at the end where horizon extends past data).
 */
function computeForwardReturns(prices, signals, horizon) {
  const result = [];
  for (const sig of signals) {
    const futureIdx = sig.index + horizon;
    if (futureIdx >= prices.length) break;
    const fwdReturn = (prices[futureIdx].close - prices[sig.index].close) / prices[sig.index].close;
    result.push({
      date: sig.date,
      signal: sig.signal,
      forwardReturn: fwdReturn,
    });
  }
  return result;
}

// ─── Core Analysis Functions ─────────────────────────────

/**
 * Compute IC (Information Coefficient) at multiple forward horizons.
 * IC = Spearman rank correlation between signal and forward return.
 *
 * @param {Array} prices - OHLCV price array from generateRealisticPrices
 * @param {Array} signals - Array of { date, signal, price, index }
 * @param {number[]} horizons - Forward horizons in trading days
 * @returns {{ horizons, ics, tStats, pValues, significant }}
 */
export function getICDecayCurve(prices, signals, horizons = [1, 2, 5, 10, 21, 63]) {
  const results = [];

  for (const h of horizons) {
    const pairs = computeForwardReturns(prices, signals, h);
    if (pairs.length < 30) {
      results.push({ horizon: h, ic: NaN, tStat: NaN, pValue: NaN, significant: false, n: pairs.length });
      continue;
    }

    const signalVals = pairs.map(p => p.signal);
    const returnVals = pairs.map(p => p.forwardReturn);
    const ic = spearmanCorrelation(signalVals, returnVals);

    // t-test for correlation significance: t = ic * sqrt(n-2) / sqrt(1-ic^2)
    const n = pairs.length;
    const tStat = ic * Math.sqrt(n - 2) / Math.sqrt(Math.max(1e-10, 1 - ic * ic));
    const pValue = 2 * (1 - normalCDF(Math.abs(tStat)));

    results.push({
      horizon: h,
      ic,
      tStat,
      pValue,
      significant: pValue < 0.05,
      n,
    });
  }

  return {
    horizons: results.map(r => r.horizon),
    ics: results.map(r => r.ic),
    tStats: results.map(r => r.tStat),
    pValues: results.map(r => r.pValue),
    significant: results.map(r => r.significant),
    details: results,
  };
}

/**
 * Compute signal half-life: the horizon at which IC drops to 50% of peak IC.
 * Uses linear interpolation between measured horizons.
 *
 * @param {{ horizons: number[], ics: number[] }} decayCurve - from getICDecayCurve
 * @returns {{ halfLife: number, peakIC: number, peakHorizon: number }}
 */
function computeHalfLife(decayCurve) {
  const { horizons, ics } = decayCurve;

  // Find peak IC (absolute value — signal can be negative)
  let peakIdx = 0;
  let peakAbsIC = 0;
  for (let i = 0; i < ics.length; i++) {
    if (Math.abs(ics[i]) > peakAbsIC && !isNaN(ics[i])) {
      peakAbsIC = Math.abs(ics[i]);
      peakIdx = i;
    }
  }

  const peakIC = ics[peakIdx];
  const peakHorizon = horizons[peakIdx];
  const halfTarget = peakAbsIC * 0.5;

  // Search for where |IC| drops below half of peak, starting after peak
  let halfLife = NaN;
  for (let i = peakIdx + 1; i < ics.length; i++) {
    if (isNaN(ics[i])) continue;
    if (Math.abs(ics[i]) <= halfTarget) {
      // Linear interpolation between previous and current horizon
      const prevAbsIC = Math.abs(ics[i - 1]);
      const currAbsIC = Math.abs(ics[i]);
      const frac = (prevAbsIC - halfTarget) / (prevAbsIC - currAbsIC);
      halfLife = horizons[i - 1] + frac * (horizons[i] - horizons[i - 1]);
      break;
    }
  }

  // If IC never drops below half, half-life exceeds measurement window
  if (isNaN(halfLife)) {
    const lastValidIC = ics.filter(ic => !isNaN(ic));
    if (lastValidIC.length > 0 && Math.abs(lastValidIC[lastValidIC.length - 1]) > halfTarget) {
      halfLife = Infinity; // signal persists beyond measurement horizon
    }
  }

  return { halfLife, peakIC, peakHorizon };
}

/**
 * Analyze signal turnover: how frequently signal values change substantially.
 * High turnover implies faster decay and higher transaction costs.
 *
 * @param {Array} signals - Array of { signal }
 * @returns {{ dailyTurnover, annualizedTurnover, avgAbsChange, autocorrelations }}
 */
function analyzeTurnover(signals) {
  if (signals.length < 2) {
    return { dailyTurnover: 0, annualizedTurnover: 0, avgAbsChange: 0, autocorrelations: {} };
  }

  const signalVals = signals.map(s => s.signal);

  // Daily turnover: fraction of signal that changes each day
  // Defined as mean(|signal_t - signal_{t-1}|) / mean(|signal_t|)
  const absChanges = [];
  for (let i = 1; i < signalVals.length; i++) {
    absChanges.push(Math.abs(signalVals[i] - signalVals[i - 1]));
  }

  const meanAbsSignal = mean(signalVals.map(Math.abs));
  const avgAbsChange = mean(absChanges);
  const dailyTurnover = meanAbsSignal > 0 ? avgAbsChange / meanAbsSignal : 0;
  const annualizedTurnover = dailyTurnover * 252;

  // Signal autocorrelation at multiple lags
  const lags = [1, 2, 5, 10, 21, 63];
  const autocorrelations = {};
  for (const lag of lags) {
    if (lag >= signalVals.length) {
      autocorrelations[lag] = NaN;
      continue;
    }
    const x = signalVals.slice(0, signalVals.length - lag);
    const y = signalVals.slice(lag);
    autocorrelations[lag] = pearsonCorrelation(x, y);
  }

  return { dailyTurnover, annualizedTurnover, avgAbsChange, autocorrelations };
}

/**
 * Find optimal holding period: where risk-adjusted return peaks before costs erode alpha.
 * Tests multiple holding periods, computes Sharpe-like ratio net of transaction costs.
 *
 * @param {Array} prices - OHLCV price array
 * @param {Array} signals - Signal array with { signal, index }
 * @param {Object} opts - { costBps, testPeriods }
 * @returns {{ optimalPeriod, results }}
 */
export function optimalHoldingPeriod(prices, signals, opts = {}) {
  const costBps = opts.costBps || 15; // total round-trip cost in bps
  const costFrac = costBps / 10000;
  const testPeriods = opts.testPeriods || [1, 2, 3, 5, 7, 10, 15, 21, 42, 63];

  const results = [];

  for (const period of testPeriods) {
    // Simulate holding for `period` days after each signal
    // Rebalance every `period` days based on signal
    const holdingReturns = [];
    let tradesCount = 0;

    for (let i = 0; i < signals.length; i += period) {
      const sig = signals[i];
      const exitIdx = sig.index + period;
      if (exitIdx >= prices.length) break;

      const entryPrice = prices[sig.index].close;
      const exitPrice = prices[exitIdx].close;
      const grossReturn = (exitPrice - entryPrice) / entryPrice;

      // Signal-weighted return: long if signal > 0, short if < 0
      const direction = sig.signal > 0 ? 1 : sig.signal < 0 ? -1 : 0;
      const signalReturn = direction * grossReturn;

      // Deduct round-trip transaction cost
      const netReturn = signalReturn - costFrac;
      holdingReturns.push(netReturn);
      tradesCount++;
    }

    if (holdingReturns.length < 5) {
      results.push({ period, sharpe: NaN, meanReturn: NaN, stdReturn: NaN, trades: tradesCount, n: holdingReturns.length });
      continue;
    }

    const m = mean(holdingReturns);
    const s = std(holdingReturns);
    // Annualize: there are 252/period rebalances per year
    const rebalancesPerYear = 252 / period;
    const annReturn = m * rebalancesPerYear;
    const annVol = s * Math.sqrt(rebalancesPerYear);
    const sharpe = annVol > 0 ? annReturn / annVol : 0;

    results.push({
      period,
      sharpe,
      meanReturn: m,
      stdReturn: s,
      annReturn,
      annVol,
      trades: tradesCount,
      n: holdingReturns.length,
    });
  }

  // Find period with highest Sharpe
  let bestIdx = 0;
  let bestSharpe = -Infinity;
  for (let i = 0; i < results.length; i++) {
    if (!isNaN(results[i].sharpe) && results[i].sharpe > bestSharpe) {
      bestSharpe = results[i].sharpe;
      bestIdx = i;
    }
  }

  return {
    optimalPeriod: results[bestIdx]?.period ?? NaN,
    bestSharpe: results[bestIdx]?.sharpe ?? NaN,
    results,
  };
}

/**
 * Signal crowding detection: test whether a signal's effectiveness degrades over time.
 * Splits the sample into equal time windows and measures IC in each.
 * A declining trend in IC suggests crowding / alpha erosion.
 *
 * @param {Array} prices - OHLCV price array
 * @param {Array} signals - Signal array with { signal, index }
 * @param {Object} opts - { nWindows, horizon }
 * @returns {{ windows, icTrend, trendSlope, trendPValue, isCrowded }}
 */
export function signalCrowdingTest(prices, signals, opts = {}) {
  const nWindows = opts.nWindows || 5;
  const horizon = opts.horizon || 5; // forward return horizon for IC measurement

  const windowSize = Math.floor(signals.length / nWindows);
  if (windowSize < 30) {
    return {
      windows: [],
      icTrend: [],
      trendSlope: NaN,
      trendPValue: NaN,
      isCrowded: false,
      message: "Insufficient data for crowding test (need 30+ signals per window)",
    };
  }

  const windows = [];
  const icTrend = [];

  for (let w = 0; w < nWindows; w++) {
    const start = w * windowSize;
    const end = w === nWindows - 1 ? signals.length : (w + 1) * windowSize;
    const windowSignals = signals.slice(start, end);

    const pairs = computeForwardReturns(prices, windowSignals, horizon);
    if (pairs.length < 10) {
      windows.push({ window: w + 1, startDate: windowSignals[0]?.date, endDate: windowSignals[windowSignals.length - 1]?.date, ic: NaN, n: pairs.length });
      icTrend.push(NaN);
      continue;
    }

    const ic = spearmanCorrelation(
      pairs.map(p => p.signal),
      pairs.map(p => p.forwardReturn)
    );

    windows.push({
      window: w + 1,
      startDate: windowSignals[0]?.date,
      endDate: windowSignals[windowSignals.length - 1]?.date,
      ic,
      n: pairs.length,
    });
    icTrend.push(ic);
  }

  // Linear regression of IC on window index to detect trend
  const validICs = icTrend.filter(v => !isNaN(v));
  const validIdxs = icTrend.map((v, i) => ({ v, i })).filter(x => !isNaN(x.v));

  let trendSlope = NaN;
  let trendPValue = NaN;
  let isCrowded = false;

  if (validIdxs.length >= 3) {
    const xs = validIdxs.map(x => x.i);
    const ys = validIdxs.map(x => x.v);
    const mx = mean(xs);
    const my = mean(ys);

    let num = 0, denom = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      denom += (xs[i] - mx) ** 2;
    }

    trendSlope = denom > 0 ? num / denom : 0;

    // Standard error of slope
    const yHat = xs.map(x => my + trendSlope * (x - mx));
    const residuals = ys.map((y, i) => y - yHat[i]);
    const sse = residuals.reduce((s, r) => s + r * r, 0);
    const mse = sse / (xs.length - 2);
    const sxx = denom;
    const seBeta = Math.sqrt(mse / sxx);
    const tStat = seBeta > 0 ? trendSlope / seBeta : 0;
    trendPValue = 2 * (1 - normalCDF(Math.abs(tStat)));

    // Signal is crowded if slope is significantly negative
    isCrowded = trendSlope < 0 && trendPValue < 0.10;
  }

  return {
    windows,
    icTrend,
    trendSlope,
    trendPValue,
    isCrowded,
  };
}

/**
 * Full signal decay analysis suite.
 * Combines IC decay curve, half-life, turnover, autocorrelation,
 * optimal holding period, and crowding test.
 *
 * @param {Array} prices - OHLCV price array from generateRealisticPrices
 * @param {Object} opts - { lookback, horizons, costBps, nWindows }
 * @returns {Object} Complete decay analysis results
 */
export function analyzeSignalDecay(prices, opts = {}) {
  const lookback = opts.lookback || 20;
  const horizons = opts.horizons || [1, 2, 5, 10, 21, 63];
  const costBps = opts.costBps || 15;
  const nWindows = opts.nWindows || 5;

  // Generate momentum signal
  const signals = generateMomentumSignal(prices, lookback);

  // 1. IC decay curve
  const icDecay = getICDecayCurve(prices, signals, horizons);

  // 2. Half-life
  const halfLife = computeHalfLife(icDecay);

  // 3. Turnover analysis
  const turnover = analyzeTurnover(signals);

  // 4. Optimal holding period
  const holding = optimalHoldingPeriod(prices, signals, { costBps });

  // 5. Crowding test
  const crowding = signalCrowdingTest(prices, signals, { nWindows, horizon: 5 });

  return {
    signal: {
      type: "momentum",
      lookback,
      nSignals: signals.length,
      dateRange: signals.length > 0
        ? `${signals[0].date} -> ${signals[signals.length - 1].date}`
        : "N/A",
    },
    icDecay,
    halfLife,
    turnover,
    holding,
    crowding,
  };
}

// ─── Output Formatting ──────────────────────────────────

function formatPct(v) { return (v * 100).toFixed(2) + "%"; }
function formatNum(v, d = 4) { return isNaN(v) ? "N/A" : v.toFixed(d); }
function pad(s, w = 12) { return String(s).padStart(w); }

function printICDecayCurve(icDecay) {
  console.log("\n  IC Decay Curve (Spearman rank correlation: signal vs forward return)");
  console.log("  " + "-".repeat(72));
  console.log("  Horizon(d)    IC          t-stat      p-value     Sig?    N");
  console.log("  " + "-".repeat(72));

  for (const d of icDecay.details) {
    const sig = d.significant ? " ***" : "    ";
    console.log(
      `  ${String(d.horizon).padStart(6)}d    ` +
      `${pad(formatNum(d.ic))}  ` +
      `${pad(formatNum(d.tStat, 2))}  ` +
      `${pad(d.pValue < 0.001 ? "<0.001" : formatNum(d.pValue, 4))}  ` +
      `${sig}  ` +
      `${pad(String(d.n), 6)}`
    );
  }

  // ASCII bar chart of IC values
  console.log("\n  IC Decay Visualization:");
  const maxAbsIC = Math.max(...icDecay.ics.filter(v => !isNaN(v)).map(Math.abs), 0.001);
  const barWidth = 40;

  for (const d of icDecay.details) {
    const ic = isNaN(d.ic) ? 0 : d.ic;
    const barLen = Math.round(Math.abs(ic) / maxAbsIC * barWidth);
    const bar = ic >= 0
      ? " ".repeat(barWidth) + "|" + "#".repeat(barLen)
      : " ".repeat(barWidth - barLen) + "#".repeat(barLen) + "|";
    console.log(`  ${String(d.horizon).padStart(3)}d ${bar} ${formatNum(ic)}`);
  }
}

function printHalfLife(halfLife) {
  console.log("\n  Signal Half-Life");
  console.log("  " + "-".repeat(40));
  console.log(`  Peak IC:        ${formatNum(halfLife.peakIC)}`);
  console.log(`  Peak Horizon:   ${halfLife.peakHorizon}d`);
  console.log(`  Half-Life:      ${halfLife.halfLife === Infinity ? ">63d (persists beyond window)" : isNaN(halfLife.halfLife) ? "N/A" : formatNum(halfLife.halfLife, 1) + "d"}`);
}

function printTurnover(turnover) {
  console.log("\n  Turnover Analysis");
  console.log("  " + "-".repeat(50));
  console.log(`  Daily Turnover:       ${formatPct(turnover.dailyTurnover)}`);
  console.log(`  Annualized Turnover:  ${formatNum(turnover.annualizedTurnover, 1)}x`);
  console.log(`  Avg |Signal Change|:  ${formatNum(turnover.avgAbsChange, 6)}`);

  console.log("\n  Signal Autocorrelation:");
  console.log("  " + "-".repeat(40));
  for (const [lag, ac] of Object.entries(turnover.autocorrelations)) {
    const barLen = Math.round(Math.abs(ac) * 30);
    const bar = "#".repeat(barLen);
    console.log(`  Lag ${String(lag).padStart(3)}:  ${pad(formatNum(ac))}  ${bar}`);
  }
}

function printHoldingPeriod(holding) {
  console.log("\n  Optimal Holding Period (net of transaction costs)");
  console.log("  " + "-".repeat(72));
  console.log("  Period(d)  Sharpe    Ann.Ret    Ann.Vol    Mean Ret   Trades   N");
  console.log("  " + "-".repeat(72));

  for (const r of holding.results) {
    const isOpt = r.period === holding.optimalPeriod ? " <-- OPTIMAL" : "";
    console.log(
      `  ${String(r.period).padStart(6)}d  ` +
      `${pad(formatNum(r.sharpe, 2))}  ` +
      `${pad(isNaN(r.annReturn) ? "N/A" : formatPct(r.annReturn))}  ` +
      `${pad(isNaN(r.annVol) ? "N/A" : formatPct(r.annVol))}  ` +
      `${pad(isNaN(r.meanReturn) ? "N/A" : formatPct(r.meanReturn))}  ` +
      `${pad(String(r.trades), 6)}  ` +
      `${pad(String(r.n), 4)}` +
      `${isOpt}`
    );
  }

  console.log(`\n  Optimal Period: ${holding.optimalPeriod}d (Sharpe: ${formatNum(holding.bestSharpe, 2)})`);
}

function printCrowding(crowding) {
  console.log("\n  Signal Crowding Test (IC stability across time windows)");
  console.log("  " + "-".repeat(60));

  if (crowding.message) {
    console.log(`  ${crowding.message}`);
    return;
  }

  console.log("  Window    Date Range                      IC          N");
  console.log("  " + "-".repeat(60));

  for (const w of crowding.windows) {
    console.log(
      `  ${String(w.window).padStart(4)}     ` +
      `${(w.startDate + " -> " + w.endDate).padEnd(30)}  ` +
      `${pad(formatNum(w.ic))}  ` +
      `${pad(String(w.n), 6)}`
    );
  }

  console.log();
  console.log(`  IC Trend Slope:  ${formatNum(crowding.trendSlope, 6)}`);
  console.log(`  Trend p-value:   ${isNaN(crowding.trendPValue) ? "N/A" : formatNum(crowding.trendPValue, 4)}`);
  console.log(`  Crowding Signal: ${crowding.isCrowded ? "YES -- IC is degrading over time (alpha erosion)" : "NO -- IC is stable across time windows"}`);

  // Visual trend
  const validICs = crowding.icTrend.filter(v => !isNaN(v));
  if (validICs.length > 0) {
    const maxAbs = Math.max(...validICs.map(Math.abs), 0.001);
    console.log("\n  IC Trend:");
    for (let i = 0; i < crowding.icTrend.length; i++) {
      const ic = crowding.icTrend[i];
      if (isNaN(ic)) continue;
      const barLen = Math.round(Math.abs(ic) / maxAbs * 25);
      const bar = ic >= 0 ? "+" .repeat(barLen) : "-".repeat(barLen);
      console.log(`  W${i + 1}: ${bar} ${formatNum(ic)}`);
    }
  }
}

// ─── CLI ─────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    symbol: "SPY",
    lookback: 20,
    startDate: "2020-01-01",
    endDate: "2025-03-01",
    costBps: 15,
    nWindows: 5,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--symbol":    opts.symbol = args[++i]; break;
      case "--lookback":  opts.lookback = parseInt(args[++i]); break;
      case "--start":     opts.startDate = args[++i]; break;
      case "--end":       opts.endDate = args[++i]; break;
      case "--cost-bps":  opts.costBps = parseInt(args[++i]); break;
      case "--windows":   opts.nWindows = parseInt(args[++i]); break;
      case "--help":
        console.log(`Signal Decay Analysis

Options:
  --symbol <ticker>    Symbol to analyze (default: SPY)
  --lookback <N>       Momentum lookback in days (default: 20)
  --start <date>       Start date (default: 2020-01-01)
  --end <date>         End date (default: 2025-03-01)
  --cost-bps <N>       Round-trip cost in basis points (default: 15)
  --windows <N>        Number of windows for crowding test (default: 5)
  --help               Show this help`);
        process.exit(0);
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs();
  const t0 = Date.now();

  console.log("Signal Decay Analysis -- Inferred Analysis");
  console.log("=".repeat(66));
  console.log(`Symbol: ${opts.symbol}  |  Lookback: ${opts.lookback}d  |  Cost: ${opts.costBps}bps`);
  console.log(`Period: ${opts.startDate} -> ${opts.endDate}`);

  // Generate price data
  const prices = generateRealisticPrices(opts.symbol, opts.startDate, opts.endDate);
  console.log(`Data: ${prices.length} trading days\n`);

  // Run full analysis
  const result = analyzeSignalDecay(prices, {
    lookback: opts.lookback,
    costBps: opts.costBps,
    nWindows: opts.nWindows,
  });

  // Print results
  console.log(`Signal: ${result.signal.type} (${result.signal.lookback}d lookback)`);
  console.log(`Signals generated: ${result.signal.nSignals}`);
  console.log(`Date range: ${result.signal.dateRange}`);

  printICDecayCurve(result.icDecay);
  printHalfLife(result.halfLife);
  printTurnover(result.turnover);
  printHoldingPeriod(result.holding);
  printCrowding(result.crowding);

  // Summary
  console.log("\n" + "=".repeat(66));
  console.log("  SUMMARY");
  console.log("=".repeat(66));
  console.log(`  Signal Half-Life:      ${result.halfLife.halfLife === Infinity ? ">63d" : isNaN(result.halfLife.halfLife) ? "N/A" : formatNum(result.halfLife.halfLife, 1) + "d"}`);
  console.log(`  Peak IC:               ${formatNum(result.halfLife.peakIC)} at ${result.halfLife.peakHorizon}d`);
  console.log(`  Daily Turnover:        ${formatPct(result.turnover.dailyTurnover)}`);
  console.log(`  Optimal Hold Period:   ${result.holding.optimalPeriod}d (Sharpe: ${formatNum(result.holding.bestSharpe, 2)})`);
  console.log(`  Signal Crowding:       ${result.crowding.isCrowded ? "DETECTED" : "Not detected"}`);
  console.log(`  1d Autocorrelation:    ${formatNum(result.turnover.autocorrelations[1])}`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsed}s`);
}

// Run CLI if called directly
const isMain = process.argv[1]?.includes("signal-decay");
if (isMain) {
  main().catch(err => {
    console.error("Signal decay analysis failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
