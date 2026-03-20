#!/usr/bin/env node
/**
 * Feature Importance Analysis — Inferred Analysis
 *
 * Discovers which features/indicators drive alpha:
 * 1. Permutation importance
 * 2. Information coefficient (IC) analysis
 * 3. Feature engineering (technical indicators)
 * 4. Feature selection (forward/backward)
 * 5. Stability analysis across time windows
 *
 * Usage:
 *   node agents/optimizer/feature-importance.mjs
 *   import { computeFeatureImportance, engineerFeatures } from './feature-importance.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Technical Indicator Features ───────────────────────

/**
 * RSI (Relative Strength Index).
 */
function rsi(prices, period = 14) {
  const values = [];
  for (let i = period; i < prices.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const change = prices[j].close - prices[j - 1].close;
      if (change > 0) gains += change;
      else losses -= change;
    }
    const rs = losses > 0 ? gains / losses : 100;
    values.push({ date: prices[i].date, value: 100 - 100 / (1 + rs) });
  }
  return values;
}

/**
 * MACD (Moving Average Convergence Divergence).
 */
function macd(prices, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(prices.map(p => p.close), fast);
  const emaSlow = ema(prices.map(p => p.close), slow);
  const offset = slow - fast;
  const macdLine = emaFast.slice(offset).map((f, i) => f - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const signalOffset = signal - 1;

  return macdLine.slice(signalOffset).map((m, i) => ({
    date: prices[slow + signalOffset + i]?.date,
    macd: m,
    signal: signalLine[i],
    histogram: m - signalLine[i],
  }));
}

function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result.slice(period - 1);
}

/**
 * Bollinger Band %B.
 */
function bollingerPctB(prices, period = 20, numStd = 2) {
  const values = [];
  for (let i = period - 1; i < prices.length; i++) {
    const slice = prices.slice(i - period + 1, i + 1).map(p => p.close);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    const upper = mean + numStd * std;
    const lower = mean - numStd * std;
    const pctB = (upper - lower) > 0 ? (prices[i].close - lower) / (upper - lower) : 0.5;
    values.push({ date: prices[i].date, value: pctB });
  }
  return values;
}

/**
 * ATR (Average True Range).
 */
function atr(prices, period = 14) {
  const values = [];
  for (let i = period; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tr = Math.max(
        prices[j].high - prices[j].low,
        Math.abs(prices[j].high - prices[j - 1].close),
        Math.abs(prices[j].low - prices[j - 1].close)
      );
      sum += tr;
    }
    values.push({ date: prices[i].date, value: sum / period });
  }
  return values;
}

/**
 * OBV (On-Balance Volume).
 */
function obv(prices) {
  const values = [{ date: prices[0].date, value: 0 }];
  let cumOBV = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i].close > prices[i - 1].close) cumOBV += prices[i].volume;
    else if (prices[i].close < prices[i - 1].close) cumOBV -= prices[i].volume;
    values.push({ date: prices[i].date, value: cumOBV });
  }
  return values;
}

/**
 * Realized volatility estimators.
 */
function realizedVol(prices, window = 21) {
  const values = [];
  for (let i = window; i < prices.length; i++) {
    const returns = [];
    for (let j = i - window + 1; j <= i; j++) {
      returns.push(Math.log(prices[j].close / prices[j - 1].close));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const vol = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1) * 252);
    values.push({ date: prices[i].date, value: vol });
  }
  return values;
}

/**
 * Parkinson volatility (high-low range).
 */
function parkinsonVol(prices, window = 21) {
  const values = [];
  for (let i = window; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      sum += Math.log(prices[j].high / prices[j].low) ** 2;
    }
    values.push({ date: prices[i].date, value: Math.sqrt(sum / (4 * window * Math.log(2)) * 252) });
  }
  return values;
}

/**
 * Returns at multiple horizons.
 */
function multiHorizonReturns(prices, horizons = [1, 5, 21]) {
  const result = {};
  for (const h of horizons) {
    const values = [];
    for (let i = h; i < prices.length; i++) {
      values.push({ date: prices[i].date, value: (prices[i].close - prices[i - h].close) / prices[i - h].close });
    }
    result[`ret_${h}d`] = values;
  }
  return result;
}

/**
 * Volume features.
 */
function volumeFeatures(prices, window = 21) {
  const values = [];
  for (let i = window; i < prices.length; i++) {
    const avgVol = prices.slice(i - window, i).reduce((s, p) => s + p.volume, 0) / window;
    const relVol = avgVol > 0 ? prices[i].volume / avgVol : 1;

    // OBV slope
    let obvSlope = 0;
    if (i >= window + 5) {
      const obvRecent = prices.slice(i - 5, i + 1).reduce((s, p, idx) => {
        if (idx === 0) return 0;
        return s + (p.close > prices[i - 5 + idx - 1].close ? p.volume : -p.volume);
      }, 0);
      obvSlope = obvRecent / (avgVol * 5);
    }

    values.push({ date: prices[i].date, relativeVolume: relVol, obvSlope });
  }
  return values;
}

// ─── Feature Engineering ────────────────────────────────

/**
 * Generate all features from price data.
 * Returns { featureNames, featureMatrix, dates, forwardReturns }
 */
export function engineerFeatures(prices, forwardHorizon = 5) {
  const maxLookback = 50;
  const startIdx = maxLookback;
  const endIdx = prices.length - forwardHorizon;

  if (endIdx <= startIdx) return null;

  // Compute all indicators
  const rsiValues = rsi(prices, 14);
  const macdValues = macd(prices);
  const bbValues = bollingerPctB(prices, 20);
  const atrValues = atr(prices, 14);
  const rvValues = realizedVol(prices, 21);
  const pvValues = parkinsonVol(prices, 21);
  const hrReturns = multiHorizonReturns(prices, [1, 5, 21]);
  const volFeats = volumeFeatures(prices, 21);

  // Align all features to common dates
  const dates = [];
  const featureNames = ["rsi", "macd_hist", "bb_pctb", "atr_norm", "realized_vol", "parkinson_vol", "ret_1d", "ret_5d", "ret_21d", "rel_volume", "obv_slope"];
  const featureMatrix = [];
  const forwardReturns = [];

  for (let i = startIdx; i < endIdx; i++) {
    const date = prices[i].date;
    const fwdRet = (prices[i + forwardHorizon].close - prices[i].close) / prices[i].close;

    // Find matching indicator values
    const rsiVal = rsiValues.find(v => v.date === date);
    const macdVal = macdValues.find(v => v.date === date);
    const bbVal = bbValues.find(v => v.date === date);
    const atrVal = atrValues.find(v => v.date === date);
    const rvVal = rvValues.find(v => v.date === date);
    const pvVal = pvValues.find(v => v.date === date);
    const ret1d = hrReturns.ret_1d.find(v => v.date === date);
    const ret5d = hrReturns.ret_5d.find(v => v.date === date);
    const ret21d = hrReturns.ret_21d.find(v => v.date === date);
    const volFeat = volFeats.find(v => v.date === date);

    if (!rsiVal || !bbVal || !atrVal || !rvVal || !ret1d || !ret5d || !ret21d) continue;

    const row = [
      rsiVal?.value || 50,
      macdVal?.histogram || 0,
      bbVal?.value || 0.5,
      atrVal ? atrVal.value / prices[i].close : 0, // normalize ATR
      rvVal?.value || 0.15,
      pvVal?.value || 0.15,
      ret1d?.value || 0,
      ret5d?.value || 0,
      ret21d?.value || 0,
      volFeat?.relativeVolume || 1,
      volFeat?.obvSlope || 0,
    ];

    dates.push(date);
    featureMatrix.push(row);
    forwardReturns.push(fwdRet);
  }

  return { featureNames, featureMatrix, dates, forwardReturns };
}

// ─── Information Coefficient (IC) ───────────────────────

/**
 * Compute rank correlation (Spearman) between feature and forward returns.
 */
function rankCorrelation(x, y) {
  const n = x.length;
  if (n < 5) return 0;

  const rankX = getRanks(x);
  const rankY = getRanks(y);

  const mx = rankX.reduce((a, b) => a + b, 0) / n;
  const my = rankY.reduce((a, b) => a + b, 0) / n;

  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rankX[i] - mx) * (rankY[i] - my);
    sx += (rankX[i] - mx) ** 2;
    sy += (rankY[i] - my) ** 2;
  }

  const denom = Math.sqrt(sx * sy);
  return denom > 0 ? cov / denom : 0;
}

function getRanks(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  indexed.forEach((item, rank) => { ranks[item.i] = rank + 1; });
  return ranks;
}

/**
 * Compute IC analysis for all features.
 */
export function getICAnalysis(featureNames, featureMatrix, forwardReturns, windowSize = 63) {
  const n = featureMatrix.length;
  const numFeatures = featureNames.length;
  const results = [];

  for (let f = 0; f < numFeatures; f++) {
    const featureValues = featureMatrix.map(row => row[f]);

    // Overall IC
    const overallIC = rankCorrelation(featureValues, forwardReturns);

    // Rolling IC
    const rollingICs = [];
    for (let i = windowSize; i < n; i++) {
      const fSlice = featureValues.slice(i - windowSize, i);
      const rSlice = forwardReturns.slice(i - windowSize, i);
      rollingICs.push(rankCorrelation(fSlice, rSlice));
    }

    const meanIC = rollingICs.length > 0 ? rollingICs.reduce((a, b) => a + b, 0) / rollingICs.length : 0;
    const stdIC = rollingICs.length > 1
      ? Math.sqrt(rollingICs.reduce((s, ic) => s + (ic - meanIC) ** 2, 0) / (rollingICs.length - 1))
      : 0;
    const icIR = stdIC > 0 ? meanIC / stdIC : 0; // Information Ratio of IC

    results.push({
      feature: featureNames[f],
      overallIC,
      meanIC,
      stdIC,
      icIR,
      positiveICPct: rollingICs.filter(ic => ic > 0).length / Math.max(rollingICs.length, 1),
      maxIC: rollingICs.length > 0 ? Math.max(...rollingICs) : 0,
      minIC: rollingICs.length > 0 ? Math.min(...rollingICs) : 0,
    });
  }

  return results.sort((a, b) => Math.abs(b.icIR) - Math.abs(a.icIR));
}

// ─── Permutation Importance ─────────────────────────────

/**
 * Compute permutation importance by shuffling each feature.
 */
export function computeFeatureImportance(featureMatrix, forwardReturns, featureNames, numPermutations = 10) {
  // Baseline: IC of each feature
  const baselineICs = featureNames.map((_, f) => {
    return Math.abs(rankCorrelation(featureMatrix.map(row => row[f]), forwardReturns));
  });

  const importance = featureNames.map((name, f) => {
    let totalDrop = 0;

    for (let p = 0; p < numPermutations; p++) {
      // Shuffle feature f
      const shuffled = featureMatrix.map(row => [...row]);
      const featureCol = shuffled.map(row => row[f]);
      // Fisher-Yates shuffle
      for (let i = featureCol.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [featureCol[i], featureCol[j]] = [featureCol[j], featureCol[i]];
      }
      shuffled.forEach((row, i) => { row[f] = featureCol[i]; });

      const shuffledIC = Math.abs(rankCorrelation(shuffled.map(row => row[f]), forwardReturns));
      totalDrop += baselineICs[f] - shuffledIC;
    }

    return {
      feature: name,
      baselineIC: baselineICs[f],
      importance: totalDrop / numPermutations,
      normalizedImportance: 0, // filled below
    };
  });

  // Normalize
  const maxImp = Math.max(...importance.map(i => Math.abs(i.importance)), 1e-10);
  importance.forEach(i => { i.normalizedImportance = i.importance / maxImp; });

  return importance.sort((a, b) => b.importance - a.importance);
}

// ─── Feature Selection ──────────────────────────────────

/**
 * Forward feature selection: greedily add best feature.
 */
export function selectFeatures(featureMatrix, forwardReturns, featureNames, maxFeatures = 5) {
  const selected = [];
  const remaining = featureNames.map((_, i) => i);
  const scores = [];

  for (let step = 0; step < maxFeatures && remaining.length > 0; step++) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const idx of remaining) {
      // Score = |IC| of this feature combined with already selected
      const combinedSignal = featureMatrix.map((row, i) => {
        let s = row[idx];
        for (const sel of selected) {
          s += row[sel]; // simple additive combination
        }
        return s;
      });

      const ic = Math.abs(rankCorrelation(combinedSignal, forwardReturns));
      if (ic > bestScore) {
        bestScore = ic;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(bestIdx);
      remaining.splice(remaining.indexOf(bestIdx), 1);
      scores.push({ feature: featureNames[bestIdx], ic: bestScore, step: step + 1 });
    }
  }

  return scores;
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Feature Importance Analysis ═══\n");

  const prices = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  console.log(`Price data: ${prices.length} days\n`);

  // Engineer features
  const data = engineerFeatures(prices, 5);
  if (!data) { console.log("Insufficient data"); return; }
  console.log(`Features: ${data.featureNames.length}, Samples: ${data.featureMatrix.length}\n`);

  // IC Analysis
  console.log("─── Information Coefficient Analysis ───\n");
  const icResults = getICAnalysis(data.featureNames, data.featureMatrix, data.forwardReturns);
  console.log("  Feature        Overall IC  Mean IC  Std IC   IC IR  Pos%");
  for (const r of icResults) {
    console.log(
      `  ${r.feature.padEnd(15)} ` +
      `${r.overallIC.toFixed(4).padStart(9)} ` +
      `${r.meanIC.toFixed(4).padStart(8)} ` +
      `${r.stdIC.toFixed(4).padStart(7)} ` +
      `${r.icIR.toFixed(3).padStart(6)} ` +
      `${(r.positiveICPct * 100).toFixed(0).padStart(4)}%`
    );
  }

  // Permutation Importance
  console.log("\n─── Permutation Importance ───\n");
  const importance = computeFeatureImportance(data.featureMatrix, data.forwardReturns, data.featureNames, 5);
  console.log("  Feature        Baseline IC  Importance  Normalized");
  for (const imp of importance) {
    const bar = "█".repeat(Math.max(0, Math.round(imp.normalizedImportance * 20)));
    console.log(
      `  ${imp.feature.padEnd(15)} ` +
      `${imp.baselineIC.toFixed(4).padStart(10)} ` +
      `${imp.importance.toFixed(4).padStart(10)} ` +
      `${imp.normalizedImportance.toFixed(3).padStart(9)}  ${bar}`
    );
  }

  // Feature Selection
  console.log("\n─── Forward Feature Selection ───\n");
  const selected = selectFeatures(data.featureMatrix, data.forwardReturns, data.featureNames, 5);
  for (const s of selected) {
    console.log(`  Step ${s.step}: +${s.feature.padEnd(15)} Combined IC=${s.ic.toFixed(4)}`);
  }
}

if (process.argv[1]?.includes("feature-importance")) {
  main().catch(console.error);
}
