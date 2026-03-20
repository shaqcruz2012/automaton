#!/usr/bin/env node
/**
 * Intraday Pattern Detector — Inferred Analysis
 *
 * Detects and exploits intraday patterns:
 * 1. Opening range breakout
 * 2. Intraday momentum (first-hour return predicts rest of day)
 * 3. Mean-reversion patterns (overnight gap reversal)
 * 4. Volume profile anomalies (unusual volume at specific times)
 * 5. End-of-day drift
 * 6. Day-of-week effects
 *
 * Usage:
 *   node agents/strategies/intraday-patterns.mjs
 *   import { IntradayAnalyzer, overnightGapStrategy } from './intraday-patterns.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Day-of-Week Effects ────────────────────────────────

/**
 * Analyze day-of-week return patterns.
 */
export function dayOfWeekEffect(prices) {
  const dayReturns = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (let i = 1; i < prices.length; i++) {
    const date = new Date(prices[i].date);
    const day = dayNames[date.getDay()];
    if (dayReturns[day] !== undefined) {
      dayReturns[day].push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
    }
  }

  const results = {};
  for (const [day, returns] of Object.entries(dayReturns)) {
    const n = returns.length;
    const mean = n > 0 ? returns.reduce((a, b) => a + b, 0) / n : 0;
    const std = n > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : 0;
    const tStat = std > 0 && n > 0 ? (mean / (std / Math.sqrt(n))) : 0;

    results[day] = {
      meanReturn: mean,
      std,
      tStat,
      n,
      significant: Math.abs(tStat) > 1.96,
      winRate: n > 0 ? returns.filter(r => r > 0).length / n : 0,
    };
  }

  return results;
}

// ─── Month-of-Year Effects ──────────────────────────────

/**
 * Analyze monthly seasonality.
 */
export function monthEffect(prices) {
  const monthReturns = {};
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  for (let i = 1; i < prices.length; i++) {
    const date = new Date(prices[i].date);
    const month = monthNames[date.getMonth()];
    if (!monthReturns[month]) monthReturns[month] = [];
    monthReturns[month].push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
  }

  const results = {};
  for (const month of monthNames) {
    const returns = monthReturns[month] || [];
    const n = returns.length;
    const mean = n > 0 ? returns.reduce((a, b) => a + b, 0) / n : 0;
    const std = n > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : 0;

    results[month] = {
      meanReturn: mean * 21, // scale to monthly
      dailyMean: mean,
      std,
      n,
      winRate: n > 0 ? returns.filter(r => r > 0).length / n : 0,
    };
  }

  return results;
}

// ─── Overnight Gap Analysis ─────────────────────────────

/**
 * Analyze overnight gaps (open vs previous close).
 * Tests: do gaps tend to fill (mean-revert) or continue?
 */
export function overnightGapAnalysis(prices) {
  const gaps = [];

  for (let i = 1; i < prices.length; i++) {
    const prevClose = prices[i - 1].close;
    const open = prices[i].open;
    const close = prices[i].close;

    const gapPct = (open - prevClose) / prevClose;
    const intradayReturn = (close - open) / open;
    const gapFilled = (gapPct > 0 && close <= prevClose) || (gapPct < 0 && close >= prevClose);

    gaps.push({
      date: prices[i].date,
      gapPct,
      intradayReturn,
      gapFilled,
      gapDirection: gapPct > 0 ? "up" : "down",
    });
  }

  // Statistics
  const upGaps = gaps.filter(g => g.gapPct > 0.001);
  const downGaps = gaps.filter(g => g.gapPct < -0.001);
  const largeUpGaps = gaps.filter(g => g.gapPct > 0.005);
  const largeDownGaps = gaps.filter(g => g.gapPct < -0.005);

  return {
    gaps,
    summary: {
      upGapCount: upGaps.length,
      downGapCount: downGaps.length,
      upGapFillRate: upGaps.length > 0 ? upGaps.filter(g => g.gapFilled).length / upGaps.length : 0,
      downGapFillRate: downGaps.length > 0 ? downGaps.filter(g => g.gapFilled).length / downGaps.length : 0,
      upGapAvgIntraday: upGaps.length > 0 ? upGaps.reduce((s, g) => s + g.intradayReturn, 0) / upGaps.length : 0,
      downGapAvgIntraday: downGaps.length > 0 ? downGaps.reduce((s, g) => s + g.intradayReturn, 0) / downGaps.length : 0,
      largeUpGapFillRate: largeUpGaps.length > 0 ? largeUpGaps.filter(g => g.gapFilled).length / largeUpGaps.length : 0,
      largeDownGapFillRate: largeDownGaps.length > 0 ? largeDownGaps.filter(g => g.gapFilled).length / largeDownGaps.length : 0,
    },
  };
}

// ─── Gap Reversal Strategy ──────────────────────────────

/**
 * Trade overnight gap reversals.
 * If gap up > threshold, short at open expecting gap fill.
 * If gap down > threshold, long at open expecting gap fill.
 */
export function overnightGapStrategy(prices, options = {}) {
  const {
    gapThreshold = 0.003,  // min gap to trade
    positionSize = 0.10,
    takeProfitPct = 0.005,  // close when gap partially fills
  } = options;

  const signals = [];

  for (let i = 1; i < prices.length; i++) {
    const gap = (prices[i].open - prices[i - 1].close) / prices[i - 1].close;
    let signal = 0;

    // Gap reversal: fade the gap
    if (gap > gapThreshold) signal = -1;  // gap up → short
    if (gap < -gapThreshold) signal = 1;  // gap down → long

    signals.push({
      date: prices[i].date,
      signal,
      gapPct: gap,
      price: prices[i].open, // enter at open
      closePrice: prices[i].close,
    });
  }

  return signals;
}

// ─── Opening Range Breakout ─────────────────────────────

/**
 * Opening range breakout: trade in direction of first N-bar move.
 * Uses daily OHLC to approximate (open-to-high/low ratio).
 */
export function openingRangeBreakout(prices, options = {}) {
  const { lookback = 5, threshold = 0.5 } = options;

  const signals = [];

  for (let i = lookback; i < prices.length; i++) {
    const todayRange = prices[i].high - prices[i].low;
    const openToHigh = prices[i].high - prices[i].open;
    const openToLow = prices[i].open - prices[i].low;

    // Average range for normalization
    let avgRange = 0;
    for (let j = i - lookback; j < i; j++) {
      avgRange += (prices[j].high - prices[j].low);
    }
    avgRange /= lookback;

    // Breakout direction: if price broke out of opening range significantly
    let signal = 0;
    if (todayRange > 0) {
      const highBias = openToHigh / todayRange;
      if (highBias > threshold) signal = 1;   // broke out upward
      if (highBias < (1 - threshold)) signal = -1; // broke out downward
    }

    signals.push({
      date: prices[i].date,
      signal,
      range: todayRange,
      avgRange,
      rangeRatio: avgRange > 0 ? todayRange / avgRange : 1,
      price: prices[i].close,
    });
  }

  return signals;
}

// ─── Turn-of-Month Effect ───────────────────────────────

/**
 * Turn-of-month effect: last 3 days + first 3 days of month tend to be positive.
 */
export function turnOfMonthEffect(prices) {
  const tomReturns = [];
  const nonTomReturns = [];

  for (let i = 1; i < prices.length; i++) {
    const date = new Date(prices[i].date);
    const day = date.getDate();
    const ret = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;

    // Last 3 calendar days or first 3
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const isTOM = day <= 3 || day >= lastDay - 2;

    if (isTOM) tomReturns.push(ret);
    else nonTomReturns.push(ret);
  }

  const tomMean = tomReturns.reduce((a, b) => a + b, 0) / tomReturns.length;
  const nonTomMean = nonTomReturns.reduce((a, b) => a + b, 0) / nonTomReturns.length;

  return {
    tomMeanReturn: tomMean * 252,
    nonTomMeanReturn: nonTomMean * 252,
    tomWinRate: tomReturns.filter(r => r > 0).length / tomReturns.length,
    nonTomWinRate: nonTomReturns.filter(r => r > 0).length / nonTomReturns.length,
    tomDays: tomReturns.length,
    nonTomDays: nonTomReturns.length,
    difference: (tomMean - nonTomMean) * 252,
  };
}

// ─── Backtest Helper ────────────────────────────────────

function backtestSignals(signals, options = {}) {
  const { initialCapital = 1_000_000, positionSize = 0.10, costBps = 15 } = options;
  let capital = initialCapital;
  let position = 0;
  let prevSig = 0;
  let trades = 0;
  let peak = capital;
  let maxDD = 0;
  const dailyReturns = [];
  let prevEquity = capital;

  for (const sig of signals) {
    const price = sig.closePrice || sig.price;
    if (sig.signal !== prevSig) {
      if (position !== 0) {
        capital += position * price;
        capital -= Math.abs(position * price) * costBps / 10000;
        position = 0;
        trades++;
      }
      if (sig.signal !== 0) {
        const size = capital * positionSize;
        position = sig.signal * size / price;
        capital -= size;
        trades++;
      }
      prevSig = sig.signal;
    }

    const equity = capital + position * price;
    dailyReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  if (position !== 0 && signals.length > 0) {
    capital += position * (signals[signals.length - 1].closePrice || signals[signals.length - 1].price);
  }

  const n = dailyReturns.length;
  const mean = n > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / n : 0;
  const std = n > 1 ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : 0;

  return {
    total_return: (capital - initialCapital) / initialCapital,
    sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : 0,
    max_drawdown: maxDD,
    trades,
  };
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Intraday Pattern Detector ═══\n");

  const prices = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  console.log(`Data: ${prices.length} days\n`);

  // Day-of-week effect
  console.log("─── Day-of-Week Effect ───\n");
  const dow = dayOfWeekEffect(prices);
  for (const [day, stats] of Object.entries(dow)) {
    const bar = stats.meanReturn > 0
      ? "▓".repeat(Math.min(20, Math.round(stats.meanReturn * 5000)))
      : "░".repeat(Math.min(20, Math.round(-stats.meanReturn * 5000)));
    console.log(
      `  ${day}: mean=${(stats.meanReturn * 10000).toFixed(1).padStart(5)}bps ` +
      `t=${stats.tStat.toFixed(2).padStart(5)} ` +
      `win=${(stats.winRate * 100).toFixed(0)}% ` +
      `${stats.significant ? "***" : "   "} ${bar}`
    );
  }

  // Month effect
  console.log("\n─── Monthly Seasonality ───\n");
  const months = monthEffect(prices);
  for (const [month, stats] of Object.entries(months)) {
    const bar = stats.meanReturn > 0
      ? "▓".repeat(Math.min(15, Math.round(stats.meanReturn * 200)))
      : "░".repeat(Math.min(15, Math.round(-stats.meanReturn * 200)));
    console.log(`  ${month}: ${(stats.meanReturn * 100).toFixed(2).padStart(6)}% win=${(stats.winRate * 100).toFixed(0)}% ${bar}`);
  }

  // Overnight gap analysis
  console.log("\n─── Overnight Gap Analysis ───\n");
  const gapData = overnightGapAnalysis(prices);
  const gs = gapData.summary;
  console.log(`  Up gaps:   ${gs.upGapCount} (fill rate: ${(gs.upGapFillRate * 100).toFixed(0)}%, avg intraday: ${(gs.upGapAvgIntraday * 10000).toFixed(1)}bps)`);
  console.log(`  Down gaps: ${gs.downGapCount} (fill rate: ${(gs.downGapFillRate * 100).toFixed(0)}%, avg intraday: ${(gs.downGapAvgIntraday * 10000).toFixed(1)}bps)`);
  console.log(`  Large up gap fill:   ${(gs.largeUpGapFillRate * 100).toFixed(0)}%`);
  console.log(`  Large down gap fill: ${(gs.largeDownGapFillRate * 100).toFixed(0)}%`);

  // Turn-of-month effect
  console.log("\n─── Turn-of-Month Effect ───\n");
  const tom = turnOfMonthEffect(prices);
  console.log(`  TOM return (ann):     ${(tom.tomMeanReturn * 100).toFixed(2)}% (${tom.tomDays} days, win ${(tom.tomWinRate * 100).toFixed(0)}%)`);
  console.log(`  Non-TOM return (ann): ${(tom.nonTomMeanReturn * 100).toFixed(2)}% (${tom.nonTomDays} days, win ${(tom.nonTomWinRate * 100).toFixed(0)}%)`);
  console.log(`  Difference:           ${(tom.difference * 100).toFixed(2)}%`);

  // Backtest gap reversal strategy
  console.log("\n─── Gap Reversal Strategy Backtest ───\n");
  const gapSignals = overnightGapStrategy(prices, { gapThreshold: 0.003 });
  const gapResult = backtestSignals(gapSignals);
  console.log(`  Return: ${(gapResult.total_return * 100).toFixed(2)}%`);
  console.log(`  Sharpe: ${gapResult.sharpe.toFixed(3)}`);
  console.log(`  MaxDD:  ${(gapResult.max_drawdown * 100).toFixed(2)}%`);
  console.log(`  Trades: ${gapResult.trades}`);

  // Backtest ORB strategy
  console.log("\n─── Opening Range Breakout Backtest ───\n");
  const orbSignals = openingRangeBreakout(prices);
  const orbResult = backtestSignals(orbSignals);
  console.log(`  Return: ${(orbResult.total_return * 100).toFixed(2)}%`);
  console.log(`  Sharpe: ${orbResult.sharpe.toFixed(3)}`);
  console.log(`  MaxDD:  ${(orbResult.max_drawdown * 100).toFixed(2)}%`);
  console.log(`  Trades: ${orbResult.trades}`);
}

if (process.argv[1]?.includes("intraday-patterns")) {
  main().catch(console.error);
}
