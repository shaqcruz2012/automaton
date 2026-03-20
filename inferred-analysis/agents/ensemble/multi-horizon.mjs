#!/usr/bin/env node
/**
 * Multi-Horizon Signal Aggregator — Inferred Analysis
 *
 * Combines signals operating at different time horizons:
 * 1. Intraday (minutes-hours) → microstructure, order flow
 * 2. Short-term (1-5 days) → mean reversion, momentum ignition
 * 3. Medium-term (5-63 days) → trend following, earnings momentum
 * 4. Long-term (63-252 days) → value, carry, macro
 *
 * Handles horizon-specific decay, turnover budgets, and signal conflicts.
 *
 * Usage:
 *   node agents/ensemble/multi-horizon.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Define horizon buckets.
 */
export const HORIZONS = {
  INTRADAY: { name: "Intraday", minDays: 0, maxDays: 1, decayHalfLife: 0.5, turnoverBudget: 5.0 },
  SHORT: { name: "Short-Term", minDays: 1, maxDays: 5, decayHalfLife: 2, turnoverBudget: 2.0 },
  MEDIUM: { name: "Medium-Term", minDays: 5, maxDays: 63, decayHalfLife: 15, turnoverBudget: 0.5 },
  LONG: { name: "Long-Term", minDays: 63, maxDays: 252, decayHalfLife: 60, turnoverBudget: 0.1 },
};

/**
 * Multi-horizon signal aggregator.
 */
export class MultiHorizonAggregator {
  constructor(options = {}) {
    this.horizonWeights = options.horizonWeights || { INTRADAY: 0.1, SHORT: 0.25, MEDIUM: 0.4, LONG: 0.25 };
    this.conflictResolution = options.conflictResolution || "weighted"; // weighted | veto | cascade
    this.signals = {}; // { horizon: { symbol: { value, confidence, timestamp } } }

    for (const h of Object.keys(HORIZONS)) {
      this.signals[h] = {};
    }
  }

  /**
   * Register a signal at a specific horizon.
   */
  addSignal(horizon, symbol, value, confidence = 1.0) {
    if (!HORIZONS[horizon]) return;
    this.signals[horizon][symbol] = {
      value: Math.max(-1, Math.min(1, value)),
      confidence: Math.max(0, Math.min(1, confidence)),
      timestamp: Date.now(),
      age: 0,
    };
  }

  /**
   * Decay signals based on age.
   */
  decaySignals(currentTime = Date.now()) {
    for (const [horizon, horizonDef] of Object.entries(HORIZONS)) {
      for (const [symbol, signal] of Object.entries(this.signals[horizon] || {})) {
        const ageDays = (currentTime - signal.timestamp) / (86400 * 1000);
        const decay = Math.exp(-Math.LN2 * ageDays / horizonDef.decayHalfLife);
        signal.value *= decay;
        signal.confidence *= decay;
        signal.age = ageDays;
      }
    }
  }

  /**
   * Aggregate signals for a symbol across all horizons.
   */
  getAggregateSignal(symbol) {
    const components = [];
    let totalWeight = 0;
    let weightedSignal = 0;

    for (const [horizon, horizonDef] of Object.entries(HORIZONS)) {
      const sig = this.signals[horizon]?.[symbol];
      if (!sig || Math.abs(sig.value) < 0.01) continue;

      const weight = (this.horizonWeights[horizon] || 0) * sig.confidence;
      components.push({
        horizon,
        name: horizonDef.name,
        signal: sig.value,
        confidence: sig.confidence,
        weight,
        age: sig.age,
      });
      weightedSignal += weight * sig.value;
      totalWeight += weight;
    }

    const aggregated = totalWeight > 0 ? weightedSignal / totalWeight : 0;

    // Check for conflicts
    const signs = components.filter(c => Math.abs(c.signal) > 0.1).map(c => Math.sign(c.signal));
    const hasConflict = signs.length > 1 && !signs.every(s => s === signs[0]);

    let finalSignal = aggregated;
    if (hasConflict && this.conflictResolution === "veto") {
      finalSignal = 0; // no trade when horizons disagree
    } else if (hasConflict && this.conflictResolution === "cascade") {
      // Longer horizon wins
      const longestHorizon = components.sort((a, b) =>
        (HORIZONS[b.horizon]?.maxDays || 0) - (HORIZONS[a.horizon]?.maxDays || 0)
      )[0];
      finalSignal = longestHorizon ? longestHorizon.signal * longestHorizon.confidence : 0;
    }

    return {
      symbol,
      signal: finalSignal,
      rawAggregated: aggregated,
      hasConflict,
      components,
      conviction: Math.abs(finalSignal) * (hasConflict ? 0.5 : 1),
    };
  }

  /**
   * Get portfolio-wide signals.
   */
  getAllSignals() {
    const allSymbols = new Set();
    for (const horizon of Object.keys(HORIZONS)) {
      for (const sym of Object.keys(this.signals[horizon] || {})) {
        allSymbols.add(sym);
      }
    }

    return [...allSymbols].map(sym => this.getAggregateSignal(sym))
      .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal));
  }

  /**
   * Compute turnover budget remaining per horizon.
   */
  getTurnoverBudget(currentAllocations, targetAllocations) {
    const budgets = {};
    for (const [horizon, def] of Object.entries(HORIZONS)) {
      const symbols = Object.keys(this.signals[horizon] || {});
      let turnover = 0;
      for (const sym of symbols) {
        turnover += Math.abs((targetAllocations[sym] || 0) - (currentAllocations[sym] || 0));
      }
      budgets[horizon] = {
        name: def.name,
        annualBudget: def.turnoverBudget,
        dailyBudget: def.turnoverBudget / 252,
        currentTurnover: turnover,
        withinBudget: turnover <= def.turnoverBudget / 252,
      };
    }
    return budgets;
  }

  /**
   * Format multi-horizon report.
   */
  formatReport() {
    const signals = this.getAllSignals();
    let out = `\n${"═".repeat(60)}\n  MULTI-HORIZON SIGNAL AGGREGATOR\n`;
    out += `  Conflict Resolution: ${this.conflictResolution}\n`;
    out += `${"═".repeat(60)}\n\n`;

    // Horizon weights
    out += `  Horizon Weights:\n`;
    for (const [h, w] of Object.entries(this.horizonWeights)) {
      out += `    ${(HORIZONS[h]?.name || h).padEnd(14)} ${(w * 100).toFixed(0)}%\n`;
    }

    // Signal table
    out += `\n  Symbol   Agg.Signal  Conviction  Conflict  Components\n`;
    out += `  ${"─".repeat(55)}\n`;

    for (const sig of signals.slice(0, 10)) {
      const compStr = sig.components.map(c =>
        `${c.name.slice(0, 3)}=${c.signal > 0 ? "+" : ""}${c.signal.toFixed(2)}`
      ).join(" ");
      out += `  ${sig.symbol.padEnd(7)} ${(sig.signal >= 0 ? "+" : "") + sig.signal.toFixed(3).padStart(7)}  ` +
        `${sig.conviction.toFixed(2).padStart(8)}    ${sig.hasConflict ? "YES" : " NO"}     ${compStr}\n`;
    }

    out += `\n${"═".repeat(60)}\n`;
    return out;
  }
}

/**
 * Generate multi-horizon signals from price data.
 */
export function generateMultiHorizonSignals(prices, symbol) {
  const signals = {};

  const n = prices.length;
  if (n < 252) return signals;

  // Short-term: 5-day RSI
  let gains = 0, losses = 0;
  for (let i = n - 5; i < n; i++) {
    const r = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;
    if (r > 0) gains += r; else losses -= r;
  }
  const rsi = gains + losses > 0 ? gains / (gains + losses) : 0.5;
  signals.SHORT = { value: (0.5 - rsi) * 2, confidence: 0.7 }; // contrarian

  // Medium-term: 63-day momentum
  const medMom = (prices[n - 1].close - prices[n - 63].close) / prices[n - 63].close;
  signals.MEDIUM = { value: Math.max(-1, Math.min(1, medMom * 5)), confidence: 0.8 };

  // Long-term: 252-day trend
  const longMom = (prices[n - 1].close - prices[n - 252].close) / prices[n - 252].close;
  const sma200 = prices.slice(n - 200).reduce((s, p) => s + p.close, 0) / 200;
  const aboveSMA = prices[n - 1].close > sma200 ? 1 : -1;
  signals.LONG = { value: aboveSMA * Math.min(1, Math.abs(longMom) * 3), confidence: 0.9 };

  return signals;
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Multi-Horizon Signal Aggregator ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD", "XLE", "XLF"];
  const agg = new MultiHorizonAggregator({ conflictResolution: "weighted" });

  for (const sym of symbols) {
    const prices = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
    const signals = generateMultiHorizonSignals(prices, sym);

    for (const [horizon, sig] of Object.entries(signals)) {
      agg.addSignal(horizon, sym, sig.value, sig.confidence);
    }
  }

  console.log(agg.formatReport());
}

if (process.argv[1]?.includes("multi-horizon")) {
  main().catch(console.error);
}
