#!/usr/bin/env node
/**
 * Carry Trade Strategy — Inferred Analysis
 *
 * Implements carry-based strategies across asset classes:
 * 1. Yield curve carry (long bonds, short bills)
 * 2. Commodity carry (roll yield from futures contango/backwardation)
 * 3. FX carry (borrow low-yield, invest high-yield)
 * 4. Equity carry (dividend yield differential)
 * 5. Carry + momentum combination
 *
 * Usage:
 *   node agents/strategies/carry-trade.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Estimate carry from price data using term structure proxy.
 * Uses the slope of price relative to its moving average as a carry signal.
 */
export function estimateCarry(prices, shortMA = 5, longMA = 63) {
  const signals = [];

  for (let i = longMA; i < prices.length; i++) {
    // Short-term average (proxy for spot)
    let shortAvg = 0;
    for (let j = i - shortMA; j <= i; j++) shortAvg += prices[j].close;
    shortAvg /= (shortMA + 1);

    // Long-term average (proxy for futures/forward)
    let longAvg = 0;
    for (let j = i - longMA; j <= i; j++) longAvg += prices[j].close;
    longAvg /= (longMA + 1);

    // Carry = (spot - forward) / spot (contango = negative carry, backwardation = positive)
    const carry = longAvg > 0 ? (shortAvg - longAvg) / longAvg : 0;

    // Roll yield approximation
    const rollYield = carry * (252 / longMA); // annualized

    signals.push({
      date: prices[i].date,
      carry,
      rollYield,
      spot: shortAvg,
      forward: longAvg,
      price: prices[i].close,
    });
  }

  return signals;
}

/**
 * Multi-asset carry strategy: rank assets by carry and go long highest, short lowest.
 */
export function multiAssetCarry(priceArrays, options = {}) {
  const { topN = 2, bottomN = 1, rebalanceDays = 21 } = options;
  const symbols = Object.keys(priceArrays);

  // Compute carry for each asset
  const carryData = {};
  for (const sym of symbols) {
    carryData[sym] = estimateCarry(priceArrays[sym]);
  }

  const minLen = Math.min(...Object.values(carryData).map(c => c.length));
  const signals = [];

  for (let i = 0; i < minLen; i++) {
    if (i % rebalanceDays !== 0 && signals.length > 0) {
      signals.push({ ...signals[signals.length - 1], date: carryData[symbols[0]][i].date });
      continue;
    }

    // Rank by carry
    const ranked = symbols
      .map(sym => ({ symbol: sym, carry: carryData[sym][i]?.carry || 0 }))
      .sort((a, b) => b.carry - a.carry);

    const allocation = {};
    symbols.forEach(s => { allocation[s] = 0; });

    // Long highest carry
    for (let j = 0; j < Math.min(topN, ranked.length); j++) {
      allocation[ranked[j].symbol] = 1 / topN;
    }
    // Short lowest carry
    for (let j = 0; j < Math.min(bottomN, ranked.length); j++) {
      allocation[ranked[ranked.length - 1 - j].symbol] = -1 / Math.max(bottomN, 1);
    }

    signals.push({
      date: carryData[symbols[0]][i].date,
      allocation,
      rankings: ranked.map(r => `${r.symbol}=${(r.carry * 100).toFixed(2)}%`),
    });
  }

  return signals;
}

/**
 * Carry + Momentum combination.
 */
export function carryMomentum(priceArrays, options = {}) {
  const { carryWeight = 0.5, momentumWeight = 0.5, lookback = 63, rebalanceDays = 21 } = options;
  const symbols = Object.keys(priceArrays);
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));
  const signals = [];

  for (let i = lookback; i < minLen; i++) {
    if ((i - lookback) % rebalanceDays !== 0 && signals.length > 0) {
      signals.push({ ...signals[signals.length - 1], date: priceArrays[symbols[0]][i].date });
      continue;
    }

    const scores = symbols.map(sym => {
      const prices = priceArrays[sym];
      // Momentum score
      const momReturn = (prices[i].close - prices[i - lookback].close) / prices[i - lookback].close;

      // Carry score (short vs long MA)
      let shortAvg = 0, longAvg = 0;
      for (let j = i - 5; j <= i; j++) shortAvg += prices[j].close;
      shortAvg /= 6;
      for (let j = i - lookback; j <= i; j++) longAvg += prices[j].close;
      longAvg /= (lookback + 1);
      const carry = longAvg > 0 ? (shortAvg - longAvg) / longAvg : 0;

      const combinedScore = carryWeight * carry + momentumWeight * momReturn;
      return { symbol: sym, carry, momentum: momReturn, combined: combinedScore };
    }).sort((a, b) => b.combined - a.combined);

    const allocation = {};
    symbols.forEach(s => { allocation[s] = 0; });

    // Top half gets positive weight, bottom half gets negative or zero
    const half = Math.ceil(scores.length / 2);
    for (let j = 0; j < half; j++) {
      allocation[scores[j].symbol] = 1 / half;
    }

    signals.push({
      date: priceArrays[symbols[0]][i].date,
      allocation,
      scores: scores.map(s => `${s.symbol}: carry=${(s.carry * 100).toFixed(1)}% mom=${(s.momentum * 100).toFixed(1)}%`),
    });
  }

  return signals;
}

// Backtest helper
function backtestAllocation(priceArrays, signals) {
  const symbols = Object.keys(priceArrays);
  let equity = 1_000_000;
  let peak = equity;
  let maxDD = 0;
  const dailyReturns = [];

  for (const sig of signals) {
    let ret = 0;
    for (const sym of symbols) {
      const idx = priceArrays[sym].findIndex(p => p.date === sig.date);
      if (idx > 0) {
        const r = (priceArrays[sym][idx].close - priceArrays[sym][idx - 1].close) / priceArrays[sym][idx - 1].close;
        ret += (sig.allocation[sym] || 0) * r;
      }
    }
    equity *= (1 + ret);
    dailyReturns.push(ret);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const n = dailyReturns.length;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  return {
    totalReturn: (equity - 1_000_000) / 1_000_000,
    sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : 0,
    maxDD,
  };
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Carry Trade Strategy ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD", "XLE", "XLF"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  // Pure carry
  console.log("─── Multi-Asset Carry ───");
  const carrySignals = multiAssetCarry(priceArrays, { topN: 2, bottomN: 1 });
  const carryResult = backtestAllocation(priceArrays, carrySignals);
  console.log(`  Return: ${(carryResult.totalReturn * 100).toFixed(2)}%  Sharpe: ${carryResult.sharpe.toFixed(3)}  MaxDD: ${(carryResult.maxDD * 100).toFixed(1)}%`);

  // Carry + momentum
  console.log("\n─── Carry + Momentum ───");
  const cmSignals = carryMomentum(priceArrays, { carryWeight: 0.4, momentumWeight: 0.6 });
  const cmResult = backtestAllocation(priceArrays, cmSignals);
  console.log(`  Return: ${(cmResult.totalReturn * 100).toFixed(2)}%  Sharpe: ${cmResult.sharpe.toFixed(3)}  MaxDD: ${(cmResult.maxDD * 100).toFixed(1)}%`);

  // Carry rankings
  console.log("\n─── Current Carry Rankings ───");
  for (const sym of symbols) {
    const carry = estimateCarry(priceArrays[sym]);
    const latest = carry[carry.length - 1];
    const bar = latest.carry > 0 ? "▓".repeat(Math.min(15, Math.round(latest.carry * 500))) : "░".repeat(Math.min(15, Math.round(-latest.carry * 500)));
    console.log(`  ${sym.padEnd(5)}: carry=${(latest.carry * 100).toFixed(2).padStart(6)}% roll=${(latest.rollYield * 100).toFixed(1).padStart(5)}% ${bar}`);
  }
}

if (process.argv[1]?.includes("carry-trade")) {
  main().catch(console.error);
}
