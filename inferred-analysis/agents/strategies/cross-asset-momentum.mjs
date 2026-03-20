#!/usr/bin/env node
/**
 * Cross-Asset Momentum with Sector Rotation — Inferred Analysis
 *
 * Implements relative momentum across multiple assets/sectors,
 * rotating into strongest performers and out of weakest.
 *
 * Strategies:
 * 1. Relative strength momentum (rank assets by N-day return)
 * 2. Dual momentum (absolute + relative)
 * 3. Sector rotation (ETF-based sector timing)
 * 4. Risk-on/risk-off regime overlay
 *
 * Usage:
 *   node agents/strategies/cross-asset-momentum.mjs
 *   import { crossAssetMomentum, sectorRotation } from './cross-asset-momentum.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Core Momentum Calculations ─────────────────────────

/**
 * Compute N-day return for each asset at each point in time.
 */
export function computeMomentum(priceArrays, lookback = 63) {
  const result = {};
  for (const [symbol, prices] of Object.entries(priceArrays)) {
    const momentum = [];
    for (let i = lookback; i < prices.length; i++) {
      momentum.push({
        date: prices[i].date,
        price: prices[i].close,
        ret: (prices[i].close - prices[i - lookback].close) / prices[i - lookback].close,
      });
    }
    result[symbol] = momentum;
  }
  return result;
}

/**
 * Rank assets by momentum at each date. Returns { date, rankings: [{symbol, ret, rank}] }
 */
export function rankAssets(momentumData) {
  const symbols = Object.keys(momentumData);
  if (symbols.length === 0) return [];

  const dates = momentumData[symbols[0]].map(m => m.date);
  const rankings = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const assetReturns = symbols
      .map(sym => ({
        symbol: sym,
        ret: momentumData[sym][i]?.ret ?? 0,
        price: momentumData[sym][i]?.price ?? 0,
      }))
      .sort((a, b) => b.ret - a.ret);

    assetReturns.forEach((a, idx) => { a.rank = idx + 1; });

    rankings.push({ date, assets: assetReturns });
  }

  return rankings;
}

// ─── Strategy 1: Relative Strength Momentum ─────────────

/**
 * Buy top N assets by relative momentum, sell bottom N.
 */
export function relativeStrength(priceArrays, options = {}) {
  const {
    lookback = 63,
    topN = 2,
    bottomN = 0,
    rebalanceDays = 21,
    skipLastDays = 5, // skip most recent days (mean-reversion effect)
  } = options;

  const adjustedLookback = lookback + skipLastDays;
  const symbols = Object.keys(priceArrays);
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));
  const signals = [];

  for (let i = adjustedLookback; i < minLen; i++) {
    const shouldRebalance = (i - adjustedLookback) % rebalanceDays === 0;
    if (!shouldRebalance && signals.length > 0) {
      signals.push({ ...signals[signals.length - 1], date: priceArrays[symbols[0]][i].date });
      continue;
    }

    // Compute momentum skipping last N days
    const rets = symbols.map(sym => ({
      symbol: sym,
      ret: (priceArrays[sym][i - skipLastDays].close - priceArrays[sym][i - adjustedLookback].close) /
           priceArrays[sym][i - adjustedLookback].close,
    })).sort((a, b) => b.ret - a.ret);

    const allocation = {};
    symbols.forEach(s => { allocation[s] = 0; });

    // Long top N equally weighted
    for (let j = 0; j < Math.min(topN, rets.length); j++) {
      allocation[rets[j].symbol] = 1 / topN;
    }
    // Short bottom N
    for (let j = 0; j < Math.min(bottomN, rets.length); j++) {
      allocation[rets[rets.length - 1 - j].symbol] = -1 / Math.max(bottomN, 1);
    }

    signals.push({
      date: priceArrays[symbols[0]][i].date,
      allocation,
    });
  }

  return signals;
}

// ─── Strategy 2: Dual Momentum ──────────────────────────

/**
 * Combines absolute and relative momentum.
 * Only go long if absolute momentum > 0 AND asset is top ranked.
 * Otherwise go to cash (risk-free proxy).
 */
export function dualMomentum(priceArrays, options = {}) {
  const {
    lookback = 126,
    topN = 1,
    rebalanceDays = 21,
    cashSymbol = "TLT", // bonds as cash proxy
  } = options;

  const symbols = Object.keys(priceArrays);
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));
  const signals = [];

  for (let i = lookback; i < minLen; i++) {
    const shouldRebalance = (i - lookback) % rebalanceDays === 0;
    if (!shouldRebalance && signals.length > 0) {
      signals.push({ ...signals[signals.length - 1], date: priceArrays[symbols[0]][i].date });
      continue;
    }

    const rets = symbols.map(sym => ({
      symbol: sym,
      ret: (priceArrays[sym][i].close - priceArrays[sym][i - lookback].close) /
           priceArrays[sym][i - lookback].close,
    })).sort((a, b) => b.ret - a.ret);

    const allocation = {};
    symbols.forEach(s => { allocation[s] = 0; });

    // Find top N with positive absolute momentum
    let allocated = 0;
    for (const asset of rets) {
      if (allocated >= topN) break;
      if (asset.ret > 0 && asset.symbol !== cashSymbol) {
        allocation[asset.symbol] = 1 / topN;
        allocated++;
      }
    }

    // If no assets have positive momentum, go to cash
    if (allocated === 0 && cashSymbol && priceArrays[cashSymbol]) {
      allocation[cashSymbol] = 1;
    }

    signals.push({
      date: priceArrays[symbols[0]][i].date,
      allocation,
    });
  }

  return signals;
}

// ─── Strategy 3: Sector Rotation ────────────────────────

const SECTOR_ETFS = {
  XLK: "Technology",
  XLF: "Financials",
  XLE: "Energy",
  XLV: "Healthcare",
  XLI: "Industrials",
  XLP: "Staples",
  XLY: "Discretionary",
  XLU: "Utilities",
  XLB: "Materials",
};

/**
 * Rotate into strongest sectors, weighted by momentum strength.
 */
export function sectorRotation(priceArrays, options = {}) {
  const {
    lookback = 63,
    topSectors = 3,
    rebalanceDays = 21,
    momentumWeighted = true,
  } = options;

  const symbols = Object.keys(priceArrays);
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));
  const signals = [];

  for (let i = lookback; i < minLen; i++) {
    const shouldRebalance = (i - lookback) % rebalanceDays === 0;
    if (!shouldRebalance && signals.length > 0) {
      signals.push({ ...signals[signals.length - 1], date: priceArrays[symbols[0]][i].date });
      continue;
    }

    const rets = symbols.map(sym => ({
      symbol: sym,
      ret: (priceArrays[sym][i].close - priceArrays[sym][i - lookback].close) /
           priceArrays[sym][i - lookback].close,
    })).sort((a, b) => b.ret - a.ret);

    const topAssets = rets.slice(0, topSectors).filter(a => a.ret > 0);
    const allocation = {};
    symbols.forEach(s => { allocation[s] = 0; });

    if (topAssets.length > 0) {
      if (momentumWeighted) {
        const totalMom = topAssets.reduce((s, a) => s + Math.max(a.ret, 0), 0);
        for (const asset of topAssets) {
          allocation[asset.symbol] = totalMom > 0 ? asset.ret / totalMom : 1 / topAssets.length;
        }
      } else {
        for (const asset of topAssets) {
          allocation[asset.symbol] = 1 / topAssets.length;
        }
      }
    }

    signals.push({
      date: priceArrays[symbols[0]][i].date,
      allocation,
    });
  }

  return signals;
}

// ─── Portfolio Backtest Engine ───────────────────────────

/**
 * Backtest a multi-asset allocation strategy.
 */
export function backtestAllocation(priceArrays, signals, options = {}) {
  const { initialCapital = 1_000_000, costBps = 15 } = options;
  const symbols = Object.keys(priceArrays);
  let capital = initialCapital;
  const positions = {}; // symbol -> { shares, cost }
  symbols.forEach(s => { positions[s] = { shares: 0, cost: 0 }; });

  const equityCurve = [];
  let peak = capital;
  let maxDrawdown = 0;
  const dailyReturns = [];
  let prevEquity = capital;
  let trades = 0;

  for (const sig of signals) {
    const dateIdx = {};
    for (const sym of symbols) {
      const idx = priceArrays[sym].findIndex(p => p.date === sig.date);
      if (idx >= 0) dateIdx[sym] = idx;
    }

    // Mark to market
    let equity = capital;
    for (const sym of symbols) {
      if (dateIdx[sym] !== undefined) {
        equity += positions[sym].shares * priceArrays[sym][dateIdx[sym]].close;
      }
    }

    // Rebalance to target allocation
    const targetAlloc = sig.allocation;
    for (const sym of symbols) {
      if (dateIdx[sym] === undefined) continue;
      const price = priceArrays[sym][dateIdx[sym]].close;
      const targetValue = equity * (targetAlloc[sym] || 0);
      const currentValue = positions[sym].shares * price;
      const diff = targetValue - currentValue;

      if (Math.abs(diff) > equity * 0.01) { // only trade if > 1% of equity
        const cost = Math.abs(diff) * costBps / 10000;
        positions[sym].shares += diff / price;
        capital -= diff + cost;
        trades++;
      }
    }

    // Recalc equity after rebalance
    equity = capital;
    for (const sym of symbols) {
      if (dateIdx[sym] !== undefined) {
        equity += positions[sym].shares * priceArrays[sym][dateIdx[sym]].close;
      }
    }

    equityCurve.push({ date: sig.date, equity });
    const dailyRet = (equity - prevEquity) / prevEquity;
    dailyReturns.push(dailyRet);
    prevEquity = equity;

    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Final equity
  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : capital;
  const totalReturn = (finalEquity - initialCapital) / initialCapital;
  const n = dailyReturns.length;
  const meanRet = n > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? dailyReturns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (n - 1) : 0;
  const sharpe = variance > 0 ? (meanRet / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  return {
    total_return: totalReturn,
    annualized_return: n > 0 ? Math.pow(1 + totalReturn, 252 / n) - 1 : 0,
    sharpe,
    max_drawdown: maxDrawdown,
    trades,
    days: n,
    final_equity: finalEquity,
  };
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Cross-Asset Momentum & Sector Rotation ═══\n");

  // Generate multi-asset price data
  const symbols = ["SPY", "QQQ", "IWM", "TLT", "GLD", "XLF", "XLE", "XLK"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }
  console.log(`Loaded ${symbols.length} assets\n`);

  // Strategy 1: Relative Strength
  console.log("─── Relative Strength (Top 3) ───");
  const rsSignals = relativeStrength(priceArrays, { topN: 3, lookback: 63 });
  const rsResult = backtestAllocation(priceArrays, rsSignals);
  console.log(`  Return: ${(rsResult.total_return * 100).toFixed(2)}%`);
  console.log(`  Sharpe: ${rsResult.sharpe.toFixed(3)}`);
  console.log(`  MaxDD:  ${(rsResult.max_drawdown * 100).toFixed(2)}%`);
  console.log(`  Trades: ${rsResult.trades}\n`);

  // Strategy 2: Dual Momentum
  console.log("─── Dual Momentum (Top 1 + Cash) ───");
  const dmSignals = dualMomentum(priceArrays, { topN: 1, lookback: 126 });
  const dmResult = backtestAllocation(priceArrays, dmSignals);
  console.log(`  Return: ${(dmResult.total_return * 100).toFixed(2)}%`);
  console.log(`  Sharpe: ${dmResult.sharpe.toFixed(3)}`);
  console.log(`  MaxDD:  ${(dmResult.max_drawdown * 100).toFixed(2)}%`);
  console.log(`  Trades: ${dmResult.trades}\n`);

  // Strategy 3: Sector Rotation
  console.log("─── Sector Rotation (Top 3 Momentum-Weighted) ───");
  const srSignals = sectorRotation(priceArrays, { topSectors: 3, lookback: 63 });
  const srResult = backtestAllocation(priceArrays, srSignals);
  console.log(`  Return: ${(srResult.total_return * 100).toFixed(2)}%`);
  console.log(`  Sharpe: ${srResult.sharpe.toFixed(3)}`);
  console.log(`  MaxDD:  ${(srResult.max_drawdown * 100).toFixed(2)}%`);
  console.log(`  Trades: ${srResult.trades}\n`);

  // Asset rankings snapshot
  const momentum = computeMomentum(priceArrays, 63);
  const rankings = rankAssets(momentum);
  const latest = rankings[rankings.length - 1];
  console.log(`─── Latest Rankings (${latest.date}) ───`);
  for (const asset of latest.assets) {
    const bar = "█".repeat(Math.max(0, Math.round(asset.ret * 100)));
    console.log(`  ${asset.rank}. ${asset.symbol.padEnd(5)} ${(asset.ret * 100).toFixed(1).padStart(6)}% ${bar}`);
  }
}

if (process.argv[1]?.includes("cross-asset-momentum")) {
  main().catch(console.error);
}
