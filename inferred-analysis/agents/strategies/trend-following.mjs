#!/usr/bin/env node
/**
 * Trend Following System — Inferred Analysis
 *
 * Multi-timeframe trend following with:
 * 1. Moving average crossover (fast/slow)
 * 2. Donchian channel breakout
 * 3. ADX trend strength filter
 * 4. Turtle trading rules
 * 5. Time-series momentum
 * 6. Trend conviction scoring
 *
 * Usage:
 *   node agents/strategies/trend-following.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Simple moving average.
 */
function sma(prices, period, endIdx) {
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    sum += prices[i].close;
  }
  return sum / period;
}

/**
 * Exponential moving average.
 */
function ema(prices, period) {
  const result = [prices[0].close];
  const k = 2 / (period + 1);
  for (let i = 1; i < prices.length; i++) {
    result.push(prices[i].close * k + result[i - 1] * (1 - k));
  }
  return result;
}

/**
 * Average True Range.
 */
function atr(prices, period) {
  const trs = [0];
  for (let i = 1; i < prices.length; i++) {
    const high = prices[i].high || prices[i].close * 1.005;
    const low = prices[i].low || prices[i].close * 0.995;
    const prevClose = prices[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  const result = new Array(prices.length).fill(0);
  let sum = 0;
  for (let i = 1; i <= period && i < trs.length; i++) sum += trs[i];
  result[period] = sum / period;
  for (let i = period + 1; i < trs.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + trs[i]) / period;
  }
  return result;
}

/**
 * ADX (Average Directional Index) for trend strength.
 */
function adx(prices, period = 14) {
  const result = new Array(prices.length).fill(0);
  if (prices.length < period * 2) return result;

  const pDM = [0], nDM = [0];
  for (let i = 1; i < prices.length; i++) {
    const high = prices[i].high || prices[i].close * 1.005;
    const low = prices[i].low || prices[i].close * 0.995;
    const prevHigh = prices[i - 1].high || prices[i - 1].close * 1.005;
    const prevLow = prices[i - 1].low || prices[i - 1].close * 0.995;

    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    pDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    nDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const atrVals = atr(prices, period);
  const smoothPDM = new Array(prices.length).fill(0);
  const smoothNDM = new Array(prices.length).fill(0);
  const dx = new Array(prices.length).fill(0);

  for (let i = 1; i <= period; i++) {
    smoothPDM[period] += pDM[i];
    smoothNDM[period] += nDM[i];
  }

  for (let i = period + 1; i < prices.length; i++) {
    smoothPDM[i] = smoothPDM[i - 1] - smoothPDM[i - 1] / period + pDM[i];
    smoothNDM[i] = smoothNDM[i - 1] - smoothNDM[i - 1] / period + nDM[i];

    const pDI = atrVals[i] > 0 ? smoothPDM[i] / atrVals[i] : 0;
    const nDI = atrVals[i] > 0 ? smoothNDM[i] / atrVals[i] : 0;
    const sumDI = pDI + nDI;
    dx[i] = sumDI > 0 ? Math.abs(pDI - nDI) / sumDI : 0;
  }

  // Smooth DX to get ADX
  let adxSum = 0;
  for (let i = period; i < period * 2 && i < prices.length; i++) adxSum += dx[i];
  result[period * 2 - 1] = adxSum / period;
  for (let i = period * 2; i < prices.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + dx[i]) / period;
  }
  return result;
}

/**
 * Donchian Channel breakout signals.
 */
export function donchianBreakout(prices, lookback = 20) {
  const signals = [];

  for (let i = lookback; i < prices.length; i++) {
    let highest = -Infinity, lowest = Infinity;
    for (let j = i - lookback; j < i; j++) {
      const h = prices[j].high || prices[j].close * 1.005;
      const l = prices[j].low || prices[j].close * 0.995;
      if (h > highest) highest = h;
      if (l < lowest) lowest = l;
    }

    const current = prices[i].close;
    let signal = 0;
    if (current > highest) signal = 1; // breakout long
    else if (current < lowest) signal = -1; // breakout short

    signals.push({
      date: prices[i].date,
      signal,
      upper: highest,
      lower: lowest,
      price: current,
      channelWidth: (highest - lowest) / current,
    });
  }

  return signals;
}

/**
 * Multi-timeframe moving average crossover.
 */
export function maCrossover(prices, options = {}) {
  const { fast = 10, medium = 50, slow = 200 } = options;
  const signals = [];
  const emaFast = ema(prices, fast);
  const emaMedium = ema(prices, medium);
  const emaSlow = ema(prices, slow);
  const adxVals = adx(prices, 14);

  for (let i = slow; i < prices.length; i++) {
    let signal = 0;
    let conviction = 0;

    // Triple MA alignment
    const fastAboveMed = emaFast[i] > emaMedium[i];
    const medAboveSlow = emaMedium[i] > emaSlow[i];
    const fastAboveSlow = emaFast[i] > emaSlow[i];

    if (fastAboveMed && medAboveSlow) {
      signal = 1; // strong uptrend
      conviction = 3;
    } else if (!fastAboveMed && !medAboveSlow) {
      signal = -1; // strong downtrend
      conviction = 3;
    } else if (fastAboveSlow) {
      signal = 0.5;
      conviction = 1;
    } else {
      signal = -0.5;
      conviction = 1;
    }

    // ADX filter: only trade when trend is strong
    const trendStrength = adxVals[i];
    if (trendStrength < 0.15) {
      signal *= 0.3; // reduce signal in weak trends
      conviction = 0;
    }

    signals.push({
      date: prices[i].date,
      signal,
      conviction,
      emaFast: emaFast[i],
      emaMedium: emaMedium[i],
      emaSlow: emaSlow[i],
      adx: trendStrength,
      price: prices[i].close,
    });
  }
  return signals;
}

/**
 * Time-series momentum (TSMOM).
 */
export function timeSeriesMomentum(prices, lookbacks = [21, 63, 126, 252]) {
  const signals = [];
  const maxLookback = Math.max(...lookbacks);

  for (let i = maxLookback; i < prices.length; i++) {
    let totalSignal = 0;
    const details = {};

    for (const lb of lookbacks) {
      const ret = (prices[i].close - prices[i - lb].close) / prices[i - lb].close;
      const signal = ret > 0 ? 1 : -1;
      totalSignal += signal;
      details[`mom_${lb}`] = ret;
    }

    // Normalize to [-1, 1]
    const normalizedSignal = totalSignal / lookbacks.length;

    // Volatility scaling
    let vol = 0;
    for (let j = i - 21; j < i; j++) {
      const r = (prices[j + 1].close - prices[j].close) / prices[j].close;
      vol += r * r;
    }
    vol = Math.sqrt(vol / 21) * Math.sqrt(252);
    const targetVol = 0.15;
    const volScalar = vol > 0 ? targetVol / vol : 1;

    signals.push({
      date: prices[i].date,
      signal: normalizedSignal,
      volScaledSignal: normalizedSignal * Math.min(2, volScalar),
      annualVol: vol,
      ...details,
    });
  }

  return signals;
}

/**
 * Turtle trading system (simplified).
 */
export function turtleSystem(prices, options = {}) {
  const { entryLookback = 20, exitLookback = 10, atrPeriod = 20, riskPerTrade = 0.01 } = options;
  const signals = [];
  const atrVals = atr(prices, atrPeriod);
  let position = 0; // 0 = flat, 1 = long, -1 = short
  let entryPrice = 0;
  let stopLoss = 0;

  for (let i = Math.max(entryLookback, atrPeriod); i < prices.length; i++) {
    let entryHigh = -Infinity, entryLow = Infinity;
    let exitHigh = -Infinity, exitLow = Infinity;

    for (let j = i - entryLookback; j < i; j++) {
      const h = prices[j].high || prices[j].close * 1.005;
      const l = prices[j].low || prices[j].close * 0.995;
      if (h > entryHigh) entryHigh = h;
      if (l < entryLow) entryLow = l;
    }
    for (let j = i - exitLookback; j < i; j++) {
      const h = prices[j].high || prices[j].close * 1.005;
      const l = prices[j].low || prices[j].close * 0.995;
      if (h > exitHigh) exitHigh = h;
      if (l < exitLow) exitLow = l;
    }

    const current = prices[i].close;
    const currentATR = atrVals[i];
    let signal = position;

    // Entry signals
    if (position === 0) {
      if (current > entryHigh) {
        signal = 1;
        entryPrice = current;
        stopLoss = current - 2 * currentATR;
      } else if (current < entryLow) {
        signal = -1;
        entryPrice = current;
        stopLoss = current + 2 * currentATR;
      }
    }

    // Exit signals
    if (position === 1) {
      if (current < exitLow || current < stopLoss) signal = 0;
    } else if (position === -1) {
      if (current > exitHigh || current > stopLoss) signal = 0;
    }

    // Position sizing by ATR
    const unitSize = currentATR > 0 ? riskPerTrade / (currentATR / current) : 0;

    position = signal;

    signals.push({
      date: prices[i].date,
      signal,
      unitSize: Math.min(1, unitSize),
      atr: currentATR,
      entryChannel: [entryLow, entryHigh],
      exitChannel: [exitLow, exitHigh],
      price: current,
    });
  }
  return signals;
}

/**
 * Backtest trend following signals.
 */
function backtestTrend(prices, signals) {
  let equity = 1_000_000, peak = equity, maxDD = 0;
  const dailyRet = [];

  for (let i = 1; i < signals.length; i++) {
    const idx = prices.findIndex(p => p.date === signals[i].date);
    if (idx <= 0) continue;
    const r = (prices[idx].close - prices[idx - 1].close) / prices[idx - 1].close;
    const posRet = signals[i - 1].signal * r;
    equity *= (1 + posRet);
    dailyRet.push(posRet);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const n = dailyRet.length;
  const mean = dailyRet.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(dailyRet.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));

  return {
    totalReturn: (equity - 1_000_000) / 1_000_000,
    sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : 0,
    maxDD,
    finalEquity: equity,
  };
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Trend Following System ═══\n");

  const prices = generateRealisticPrices("SPY", "2015-01-01", "2024-12-31");

  // MA Crossover
  console.log("─── MA Crossover ───");
  const maSigs = maCrossover(prices);
  const maResult = backtestTrend(prices, maSigs);
  console.log(`  Return: ${(maResult.totalReturn * 100).toFixed(2)}%  Sharpe: ${maResult.sharpe.toFixed(3)}  MaxDD: ${(maResult.maxDD * 100).toFixed(1)}%`);

  // Donchian Breakout
  console.log("\n─── Donchian Breakout (20-day) ───");
  const donSigs = donchianBreakout(prices, 20);
  const donResult = backtestTrend(prices, donSigs);
  console.log(`  Return: ${(donResult.totalReturn * 100).toFixed(2)}%  Sharpe: ${donResult.sharpe.toFixed(3)}  MaxDD: ${(donResult.maxDD * 100).toFixed(1)}%`);

  // TSMOM
  console.log("\n─── Time-Series Momentum ───");
  const tsSigs = timeSeriesMomentum(prices);
  const tsResult = backtestTrend(prices, tsSigs.map(s => ({ ...s, signal: s.volScaledSignal })));
  console.log(`  Return: ${(tsResult.totalReturn * 100).toFixed(2)}%  Sharpe: ${tsResult.sharpe.toFixed(3)}  MaxDD: ${(tsResult.maxDD * 100).toFixed(1)}%`);

  // Turtle
  console.log("\n─── Turtle System ───");
  const turtleSigs = turtleSystem(prices);
  const turtleResult = backtestTrend(prices, turtleSigs);
  console.log(`  Return: ${(turtleResult.totalReturn * 100).toFixed(2)}%  Sharpe: ${turtleResult.sharpe.toFixed(3)}  MaxDD: ${(turtleResult.maxDD * 100).toFixed(1)}%`);

  // Signal snapshot
  console.log("\n─── Current Signals ───\n");
  const latestMA = maSigs[maSigs.length - 1];
  const latestDon = donSigs[donSigs.length - 1];
  const latestTS = tsSigs[tsSigs.length - 1];
  console.log(`  MA Crossover:  signal=${latestMA.signal.toFixed(2)} ADX=${latestMA.adx.toFixed(3)} conviction=${latestMA.conviction}`);
  console.log(`  Donchian:      signal=${latestDon.signal} width=${(latestDon.channelWidth * 100).toFixed(1)}%`);
  console.log(`  TSMOM:         signal=${latestTS.signal.toFixed(2)} vol=${(latestTS.annualVol * 100).toFixed(1)}%`);
}

if (process.argv[1]?.includes("trend-following")) {
  main().catch(console.error);
}
