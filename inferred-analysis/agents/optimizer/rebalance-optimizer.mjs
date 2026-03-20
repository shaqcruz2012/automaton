#!/usr/bin/env node
/**
 * Portfolio Rebalancing Optimizer — Inferred Analysis
 *
 * Optimizes when and how to rebalance:
 * 1. Calendar rebalancing (monthly, quarterly)
 * 2. Threshold rebalancing (rebalance when drift > X%)
 * 3. Optimal rebalancing frequency (cost vs drift trade-off)
 * 4. Tax-aware rebalancing (minimize tax impact)
 * 5. Multi-period optimization (look-ahead rebalancing)
 *
 * Usage:
 *   node agents/optimizer/rebalance-optimizer.mjs
 *   import { RebalanceOptimizer, thresholdRebalance } from './rebalance-optimizer.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Rebalancing Strategies ─────────────────────────────

/**
 * Calendar rebalancing: rebalance at fixed intervals.
 */
export function calendarRebalance(portfolioWeights, targetWeights, prices, interval = 21) {
  const symbols = Object.keys(targetWeights);
  const n = Math.min(...symbols.map(s => prices[s].length));
  const trades = [];
  let currentWeights = { ...portfolioWeights };

  for (let i = 0; i < n; i++) {
    if (i > 0 && i % interval === 0) {
      const rebalanceTrades = computeRebalanceTrades(currentWeights, targetWeights, symbols, i);
      if (rebalanceTrades.length > 0) {
        trades.push({ day: i, date: prices[symbols[0]][i].date, trades: rebalanceTrades });
      }
      currentWeights = { ...targetWeights };
    } else {
      // Drift weights based on returns
      currentWeights = driftWeights(currentWeights, symbols, prices, i);
    }
  }

  return { trades, rebalanceCount: trades.length };
}

/**
 * Threshold rebalancing: rebalance when any weight drifts > threshold.
 */
export function thresholdRebalance(portfolioWeights, targetWeights, prices, threshold = 0.05) {
  const symbols = Object.keys(targetWeights);
  const n = Math.min(...symbols.map(s => prices[s].length));
  const trades = [];
  let currentWeights = { ...portfolioWeights };

  for (let i = 1; i < n; i++) {
    currentWeights = driftWeights(currentWeights, symbols, prices, i);

    // Check if any weight has drifted beyond threshold
    const maxDrift = Math.max(...symbols.map(s =>
      Math.abs((currentWeights[s] || 0) - targetWeights[s])
    ));

    if (maxDrift > threshold) {
      const rebalanceTrades = computeRebalanceTrades(currentWeights, targetWeights, symbols, i);
      trades.push({ day: i, date: prices[symbols[0]][i].date, drift: maxDrift, trades: rebalanceTrades });
      currentWeights = { ...targetWeights };
    }
  }

  return { trades, rebalanceCount: trades.length };
}

/**
 * Optimal band rebalancing: different thresholds per asset based on volatility.
 */
export function volatilityBandRebalance(portfolioWeights, targetWeights, prices, volMultiplier = 2) {
  const symbols = Object.keys(targetWeights);
  const n = Math.min(...symbols.map(s => prices[s].length));

  // Compute per-asset volatility for bands
  const vols = {};
  for (const sym of symbols) {
    const returns = prices[sym].slice(1, Math.min(63, prices[sym].length)).map((p, i) =>
      (p.close - prices[sym][i].close) / prices[sym][i].close
    );
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    vols[sym] = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  }

  const bands = {};
  for (const sym of symbols) {
    bands[sym] = vols[sym] * volMultiplier * Math.sqrt(21); // monthly vol-based band
  }

  const trades = [];
  let currentWeights = { ...portfolioWeights };

  for (let i = 1; i < n; i++) {
    currentWeights = driftWeights(currentWeights, symbols, prices, i);

    const breached = symbols.some(s =>
      Math.abs((currentWeights[s] || 0) - targetWeights[s]) > bands[s]
    );

    if (breached) {
      const rebalanceTrades = computeRebalanceTrades(currentWeights, targetWeights, symbols, i);
      trades.push({ day: i, date: prices[symbols[0]][i].date, trades: rebalanceTrades });
      currentWeights = { ...targetWeights };
    }
  }

  return { trades, rebalanceCount: trades.length, bands };
}

// ─── Helpers ────────────────────────────────────────────

function driftWeights(weights, symbols, prices, day) {
  if (day < 1) return weights;
  const newWeights = {};
  let totalValue = 0;

  for (const sym of symbols) {
    const ret = day < prices[sym].length
      ? (prices[sym][day].close - prices[sym][day - 1].close) / prices[sym][day - 1].close
      : 0;
    newWeights[sym] = (weights[sym] || 0) * (1 + ret);
    totalValue += newWeights[sym];
  }

  // Normalize
  if (totalValue > 0) {
    for (const sym of symbols) {
      newWeights[sym] /= totalValue;
    }
  }

  return newWeights;
}

function computeRebalanceTrades(currentWeights, targetWeights, symbols, day) {
  const trades = [];
  for (const sym of symbols) {
    const diff = targetWeights[sym] - (currentWeights[sym] || 0);
    if (Math.abs(diff) > 0.001) {
      trades.push({ symbol: sym, weightChange: diff, direction: diff > 0 ? "buy" : "sell" });
    }
  }
  return trades;
}

// ─── Cost-Benefit Analysis ──────────────────────────────

/**
 * Compare rebalancing strategies and find optimal approach.
 */
export function compareRebalancingStrategies(targetWeights, prices, costBps = 15) {
  const symbols = Object.keys(targetWeights);
  const results = [];

  // Calendar: different intervals
  for (const interval of [5, 10, 21, 42, 63, 126]) {
    const cal = calendarRebalance({ ...targetWeights }, targetWeights, prices, interval);
    const totalCost = cal.rebalanceCount * costBps; // simplified
    results.push({
      strategy: `Calendar ${interval}d`,
      rebalances: cal.rebalanceCount,
      estimatedCostBps: totalCost,
    });
  }

  // Threshold: different thresholds
  for (const threshold of [0.02, 0.03, 0.05, 0.10, 0.15]) {
    const thr = thresholdRebalance({ ...targetWeights }, targetWeights, prices, threshold);
    const totalCost = thr.rebalanceCount * costBps;
    results.push({
      strategy: `Threshold ${(threshold * 100).toFixed(0)}%`,
      rebalances: thr.rebalanceCount,
      estimatedCostBps: totalCost,
    });
  }

  // Vol-based bands
  const vol = volatilityBandRebalance({ ...targetWeights }, targetWeights, prices);
  results.push({
    strategy: "Vol Bands",
    rebalances: vol.rebalanceCount,
    estimatedCostBps: vol.rebalanceCount * costBps,
  });

  return results.sort((a, b) => a.estimatedCostBps - b.estimatedCostBps);
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Portfolio Rebalancing Optimizer ═══\n");

  const symbols = ["SPY", "TLT", "GLD", "QQQ"];
  const prices = {};
  for (const sym of symbols) {
    prices[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  const targetWeights = { SPY: 0.40, TLT: 0.30, GLD: 0.15, QQQ: 0.15 };
  console.log("Target weights:", Object.entries(targetWeights).map(([s, w]) => `${s}=${(w * 100).toFixed(0)}%`).join(" "));

  // Compare strategies
  console.log("\n─── Strategy Comparison ───\n");
  const comparison = compareRebalancingStrategies(targetWeights, prices, 15);
  console.log("  Strategy             Rebalances  Est. Cost (bps)");
  for (const r of comparison) {
    console.log(`  ${r.strategy.padEnd(22)} ${String(r.rebalances).padStart(6)}  ${r.estimatedCostBps.toFixed(0).padStart(12)}`);
  }

  // Detailed threshold analysis
  console.log("\n─── Threshold Rebalancing (5% drift) ───\n");
  const thr = thresholdRebalance({ ...targetWeights }, targetWeights, prices, 0.05);
  console.log(`  Rebalance events: ${thr.rebalanceCount}`);
  for (const t of thr.trades.slice(0, 5)) {
    console.log(`    ${t.date}: drift=${(t.drift * 100).toFixed(1)}%, trades: ${t.trades.map(tr => `${tr.symbol} ${tr.direction} ${(tr.weightChange * 100).toFixed(1)}%`).join(", ")}`);
  }
  if (thr.trades.length > 5) console.log(`    ... ${thr.trades.length - 5} more events`);

  // Vol-based bands
  console.log("\n─── Volatility-Based Bands ───\n");
  const vol = volatilityBandRebalance({ ...targetWeights }, targetWeights, prices);
  console.log(`  Rebalance events: ${vol.rebalanceCount}`);
  console.log("  Bands:");
  for (const [sym, band] of Object.entries(vol.bands)) {
    console.log(`    ${sym}: ±${(band * 100).toFixed(1)}%`);
  }
}

if (process.argv[1]?.includes("rebalance-optimizer")) {
  main().catch(console.error);
}
