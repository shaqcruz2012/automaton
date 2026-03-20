#!/usr/bin/env node
/**
 * Turnover & Cost Analyzer — Inferred Analysis
 *
 * Analyzes portfolio turnover and its impact on net returns:
 * 1. Turnover measurement (one-way, two-way)
 * 2. Cost decomposition (commission, spread, impact)
 * 3. Net-of-cost performance
 * 4. Optimal rebalancing frequency
 * 5. Tax-lot optimization (FIFO, LIFO, tax-loss harvesting)
 *
 * Usage:
 *   node agents/optimizer/turnover-analyzer.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Compute turnover between two weight vectors.
 * @returns {{ oneWay: number, twoWay: number }}
 */
export function computeTurnover(oldWeights, newWeights) {
  const symbols = new Set([...Object.keys(oldWeights), ...Object.keys(newWeights)]);
  let totalChange = 0;

  for (const sym of symbols) {
    totalChange += Math.abs((newWeights[sym] || 0) - (oldWeights[sym] || 0));
  }

  return { oneWay: totalChange / 2, twoWay: totalChange };
}

/**
 * Estimate transaction costs for a rebalance.
 */
export function estimateRebalanceCost(oldWeights, newWeights, portfolioValue, costModel = {}) {
  const { commissionBps = 1, spreadBps = 5, impactBps = 2 } = costModel;
  const symbols = new Set([...Object.keys(oldWeights), ...Object.keys(newWeights)]);

  let totalCost = 0;
  const breakdown = {};

  for (const sym of symbols) {
    const change = Math.abs((newWeights[sym] || 0) - (oldWeights[sym] || 0));
    const tradeDollar = change * portfolioValue;

    const commission = tradeDollar * commissionBps / 10000;
    const spread = tradeDollar * spreadBps / 10000;
    const impact = tradeDollar * impactBps / 10000;
    const total = commission + spread + impact;

    breakdown[sym] = { tradeDollar, commission, spread, impact, total };
    totalCost += total;
  }

  return { totalCost, costPct: totalCost / portfolioValue, breakdown };
}

/**
 * Analyze turnover over a series of allocation signals.
 */
export class TurnoverAnalyzer {
  constructor(signals, portfolioValue = 1_000_000) {
    this.signals = signals; // array of { date, allocation: { sym: weight } }
    this.portfolioValue = portfolioValue;
  }

  getTurnoverSeries(costModel = {}) {
    const series = [];
    for (let i = 1; i < this.signals.length; i++) {
      const to = computeTurnover(this.signals[i - 1].allocation, this.signals[i].allocation);
      const cost = estimateRebalanceCost(
        this.signals[i - 1].allocation, this.signals[i].allocation, this.portfolioValue, costModel
      );

      series.push({
        date: this.signals[i].date,
        oneWayTurnover: to.oneWay,
        twoWayTurnover: to.twoWay,
        costDollars: cost.totalCost,
        costPct: cost.costPct,
      });
    }
    return series;
  }

  getSummary(costModel = {}) {
    const series = this.getTurnoverSeries(costModel);
    const n = series.length;
    if (n === 0) return null;

    const avgTurnover = series.reduce((s, t) => s + t.oneWayTurnover, 0) / n;
    const annualizedTurnover = avgTurnover * 252;
    const totalCost = series.reduce((s, t) => s + t.costDollars, 0);
    const avgDailyCost = totalCost / n;
    const annualizedCost = avgDailyCost * 252;
    const maxTurnover = Math.max(...series.map(t => t.oneWayTurnover));

    return {
      avgDailyTurnover: avgTurnover,
      annualizedTurnover,
      totalCostDollars: totalCost,
      annualizedCostDollars: annualizedCost,
      annualizedCostPct: annualizedCost / this.portfolioValue,
      maxDailyTurnover: maxTurnover,
      rebalanceCount: series.filter(t => t.oneWayTurnover > 0.001).length,
    };
  }

  /**
   * Find optimal rebalancing frequency by balancing tracking error vs costs.
   */
  findOptimalFrequency(targetWeights, priceArrays, costModel = {}) {
    const frequencies = [1, 5, 10, 21, 63, 126, 252];
    const results = [];

    for (const freq of frequencies) {
      // Simulate rebalancing at this frequency
      const signals = [];
      const symbols = Object.keys(targetWeights);
      const minLen = Math.min(...symbols.map(s => priceArrays[s].length));
      let currentWeights = { ...targetWeights };

      for (let t = 1; t < minLen; t++) {
        // Drift weights based on returns
        let totalVal = 0;
        const vals = {};
        for (const sym of symbols) {
          const ret = (priceArrays[sym][t].close - priceArrays[sym][t - 1].close) / priceArrays[sym][t - 1].close;
          vals[sym] = (currentWeights[sym] || 0) * (1 + ret);
          totalVal += vals[sym];
        }

        if (totalVal > 0) {
          for (const sym of symbols) {
            currentWeights[sym] = vals[sym] / totalVal;
          }
        }

        if (t % freq === 0) {
          signals.push({ date: priceArrays[symbols[0]][t].date, allocation: { ...currentWeights } });
          currentWeights = { ...targetWeights }; // rebalance
        } else {
          signals.push({ date: priceArrays[symbols[0]][t].date, allocation: { ...currentWeights } });
        }
      }

      const analyzer = new TurnoverAnalyzer(signals, this.portfolioValue);
      const summary = analyzer.getSummary(costModel);

      // Tracking error: deviation from target
      let trackingErrorSum = 0;
      let count = 0;
      for (const sig of signals) {
        let te = 0;
        for (const sym of symbols) {
          te += ((sig.allocation[sym] || 0) - targetWeights[sym]) ** 2;
        }
        trackingErrorSum += Math.sqrt(te);
        count++;
      }

      results.push({
        frequency: freq,
        label: freq === 1 ? "Daily" : freq === 5 ? "Weekly" : freq === 21 ? "Monthly" : freq === 63 ? "Quarterly" : freq === 252 ? "Annual" : `${freq}d`,
        annualizedTurnover: summary?.annualizedTurnover || 0,
        annualizedCost: summary?.annualizedCostPct || 0,
        avgTrackingError: count > 0 ? trackingErrorSum / count : 0,
      });
    }

    return results;
  }

  /**
   * Tax-loss harvesting opportunities.
   */
  taxLossHarvesting(positions, priceArrays) {
    const opportunities = [];

    for (const [sym, pos] of Object.entries(positions)) {
      if (!priceArrays[sym] || priceArrays[sym].length === 0) continue;
      const currentPrice = priceArrays[sym][priceArrays[sym].length - 1].close;
      const costBasis = pos.costBasis || pos.entryPrice || currentPrice;
      const unrealizedPnL = (currentPrice - costBasis) * (pos.shares || 0);
      const pnlPct = costBasis > 0 ? (currentPrice - costBasis) / costBasis : 0;

      if (unrealizedPnL < 0) {
        opportunities.push({
          symbol: sym,
          shares: pos.shares || 0,
          costBasis,
          currentPrice,
          unrealizedLoss: unrealizedPnL,
          lossPct: pnlPct,
          taxSavings: Math.abs(unrealizedPnL) * 0.37, // top marginal rate
        });
      }
    }

    return opportunities.sort((a, b) => a.unrealizedLoss - b.unrealizedLoss);
  }

  formatReport(costModel = {}) {
    const summary = this.getSummary(costModel);
    if (!summary) return "No data";

    let out = `\n${"═".repeat(50)}\n  TURNOVER & COST ANALYSIS\n${"═".repeat(50)}\n\n`;
    out += `  Rebalance Events:    ${summary.rebalanceCount}\n`;
    out += `  Avg Daily Turnover:  ${(summary.avgDailyTurnover * 100).toFixed(3)}%\n`;
    out += `  Annualized Turnover: ${(summary.annualizedTurnover * 100).toFixed(1)}%\n`;
    out += `  Max Daily Turnover:  ${(summary.maxDailyTurnover * 100).toFixed(2)}%\n`;
    out += `  Total Cost:          $${summary.totalCostDollars.toFixed(0)}\n`;
    out += `  Annualized Cost:     $${summary.annualizedCostDollars.toFixed(0)} (${(summary.annualizedCostPct * 100).toFixed(3)}%)\n`;
    out += `\n${"═".repeat(50)}\n`;
    return out;
  }
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Turnover & Cost Analyzer ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  // Simulate a momentum strategy with monthly rebalancing
  const signals = [];
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));

  for (let t = 63; t < minLen; t++) {
    if ((t - 63) % 21 !== 0) continue;

    const scores = symbols.map(sym => {
      const ret = (priceArrays[sym][t].close - priceArrays[sym][t - 63].close) / priceArrays[sym][t - 63].close;
      return { symbol: sym, score: ret };
    }).sort((a, b) => b.score - a.score);

    const allocation = {};
    symbols.forEach(s => { allocation[s] = 0; });
    allocation[scores[0].symbol] = 0.5;
    allocation[scores[1].symbol] = 0.3;
    allocation[scores[2].symbol] = 0.2;

    signals.push({ date: priceArrays[symbols[0]][t].date, allocation });
  }

  const analyzer = new TurnoverAnalyzer(signals, 1_000_000);
  console.log(analyzer.formatReport({ commissionBps: 1, spreadBps: 5, impactBps: 3 }));

  // Optimal frequency
  console.log("─── Optimal Rebalancing Frequency ───\n");
  const targetWeights = { SPY: 0.4, QQQ: 0.3, TLT: 0.2, GLD: 0.1 };
  const freqResults = analyzer.findOptimalFrequency(targetWeights, priceArrays);
  console.log("  Freq.       Turnover    Cost     TrackErr");
  for (const r of freqResults) {
    console.log(`  ${r.label.padEnd(10)} ${(r.annualizedTurnover * 100).toFixed(1).padStart(7)}%  ${(r.annualizedCost * 10000).toFixed(1).padStart(6)}bps  ${(r.avgTrackingError * 100).toFixed(2).padStart(7)}%`);
  }
}

if (process.argv[1]?.includes("turnover-analyzer")) {
  main().catch(console.error);
}
