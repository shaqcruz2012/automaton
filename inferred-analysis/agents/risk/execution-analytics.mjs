#!/usr/bin/env node
/**
 * Execution Analytics & Slippage Tracker — Inferred Analysis
 *
 * Monitors trade execution quality:
 * 1. Slippage analysis (expected vs actual fill)
 * 2. Implementation shortfall (IS) decomposition
 * 3. VWAP/TWAP benchmark comparison
 * 4. Execution cost attribution
 * 5. Timing analysis (when are fills best/worst)
 *
 * Usage:
 *   node agents/risk/execution-analytics.mjs
 *   import { ExecutionAnalyzer, implementationShortfall } from './execution-analytics.mjs'
 */

// ─── Implementation Shortfall ───────────────────────────

/**
 * Implementation Shortfall (IS) decomposition.
 * IS = Paper return - Actual return
 * Components: delay cost + market impact + timing cost + opportunity cost
 */
export function implementationShortfall(trade) {
  const {
    decisionPrice,   // price when decision was made
    arrivalPrice,    // price when order entered market
    fillPrice,       // actual weighted avg fill price
    endPrice,        // price at end of day
    quantity,        // shares traded
    side,            // "buy" or "sell"
  } = trade;

  const direction = side === "buy" ? 1 : -1;

  // Delay cost: slippage between decision and arrival
  const delayCost = direction * (arrivalPrice - decisionPrice) / decisionPrice;

  // Market impact: slippage between arrival and fill
  const marketImpact = direction * (fillPrice - arrivalPrice) / arrivalPrice;

  // Timing cost: drift from fill to end of day
  const timingCost = direction * (endPrice - fillPrice) / fillPrice;

  // Total IS
  const totalIS = direction * (fillPrice - decisionPrice) / decisionPrice;

  // Opportunity cost (for unfilled portion)
  const opportunityCost = 0; // assume fully filled

  return {
    totalIS,
    totalISBps: totalIS * 10000,
    delayCost,
    delayCostBps: delayCost * 10000,
    marketImpact,
    marketImpactBps: marketImpact * 10000,
    timingCost,
    timingCostBps: timingCost * 10000,
    opportunityCost,
    totalCostDollar: totalIS * fillPrice * Math.abs(quantity),
  };
}

// ─── Execution Analyzer ─────────────────────────────────

export class ExecutionAnalyzer {
  constructor() {
    this.trades = [];
    this.slippageHistory = [];
  }

  /**
   * Record a trade execution.
   */
  recordTrade(trade) {
    const {
      symbol, side, quantity,
      expectedPrice, fillPrice,
      timestamp, benchmarkVWAP,
    } = trade;

    const direction = side === "buy" ? 1 : -1;
    const slippage = direction * (fillPrice - expectedPrice) / expectedPrice;

    const record = {
      ...trade,
      slippage,
      slippageBps: slippage * 10000,
      vwapSlippage: benchmarkVWAP ? direction * (fillPrice - benchmarkVWAP) / benchmarkVWAP : null,
      vwapSlippageBps: benchmarkVWAP ? direction * (fillPrice - benchmarkVWAP) / benchmarkVWAP * 10000 : null,
    };

    this.trades.push(record);
    this.slippageHistory.push(slippage);
    return record;
  }

  /**
   * Get execution quality summary.
   */
  getSummary() {
    if (this.trades.length === 0) return null;

    const slippages = this.trades.map(t => t.slippageBps);
    const n = slippages.length;
    const mean = slippages.reduce((a, b) => a + b, 0) / n;
    const sorted = [...slippages].sort((a, b) => a - b);
    const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
    const std = Math.sqrt(slippages.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));

    const vwapSlippages = this.trades.filter(t => t.vwapSlippageBps !== null).map(t => t.vwapSlippageBps);
    const vwapMean = vwapSlippages.length > 0 ? vwapSlippages.reduce((a, b) => a + b, 0) / vwapSlippages.length : null;

    return {
      totalTrades: n,
      avgSlippageBps: mean,
      medianSlippageBps: median,
      stdSlippageBps: std,
      worstSlippageBps: sorted[n - 1],
      bestSlippageBps: sorted[0],
      avgVwapSlippageBps: vwapMean,
      positiveSlippagePct: slippages.filter(s => s > 0).length / n,
      totalSlippageDollar: this.trades.reduce((s, t) => s + t.slippage * t.fillPrice * Math.abs(t.quantity), 0),
    };
  }

  /**
   * Analyze slippage by time of day.
   */
  getTimingAnalysis() {
    const byHour = {};
    for (const trade of this.trades) {
      const hour = trade.timestamp ? new Date(trade.timestamp).getHours() : 12;
      if (!byHour[hour]) byHour[hour] = [];
      byHour[hour].push(trade.slippageBps);
    }

    return Object.entries(byHour).map(([hour, slippages]) => ({
      hour: parseInt(hour),
      avgSlippageBps: slippages.reduce((a, b) => a + b, 0) / slippages.length,
      trades: slippages.length,
    })).sort((a, b) => a.avgSlippageBps - b.avgSlippageBps);
  }

  /**
   * Analyze slippage by trade size.
   */
  getSizeAnalysis() {
    const small = this.trades.filter(t => Math.abs(t.quantity) < 100);
    const medium = this.trades.filter(t => Math.abs(t.quantity) >= 100 && Math.abs(t.quantity) < 1000);
    const large = this.trades.filter(t => Math.abs(t.quantity) >= 1000);

    const avgSlip = (trades) => trades.length > 0
      ? trades.reduce((s, t) => s + t.slippageBps, 0) / trades.length : 0;

    return {
      small: { count: small.length, avgSlippageBps: avgSlip(small) },
      medium: { count: medium.length, avgSlippageBps: avgSlip(medium) },
      large: { count: large.length, avgSlippageBps: avgSlip(large) },
    };
  }

  /**
   * Rolling slippage trend.
   */
  getRollingSlippage(window = 20) {
    const result = [];
    for (let i = window; i <= this.slippageHistory.length; i++) {
      const slice = this.slippageHistory.slice(i - window, i);
      result.push({
        index: i,
        avgSlippageBps: slice.reduce((a, b) => a + b, 0) / slice.length * 10000,
      });
    }
    return result;
  }
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Execution Analytics ═══\n");

  const analyzer = new ExecutionAnalyzer();

  // Simulate 100 trades
  for (let i = 0; i < 100; i++) {
    const basePrice = 100 + Math.random() * 50;
    const side = Math.random() > 0.5 ? "buy" : "sell";
    const quantity = Math.floor(50 + Math.random() * 2000);

    // Simulate realistic slippage (usually small, occasionally large)
    const slippageFactor = Math.random() < 0.9
      ? (Math.random() - 0.3) * 0.002  // usually slightly negative for buyer
      : (Math.random() - 0.3) * 0.005;  // occasionally larger

    const fillPrice = basePrice * (1 + (side === "buy" ? 1 : -1) * slippageFactor);
    const vwap = basePrice * (1 + (Math.random() - 0.5) * 0.001);

    analyzer.recordTrade({
      symbol: "SPY",
      side,
      quantity,
      expectedPrice: basePrice,
      fillPrice,
      benchmarkVWAP: vwap,
      timestamp: new Date(2024, 0, 1 + Math.floor(i / 5), 9 + Math.floor(Math.random() * 7), Math.floor(Math.random() * 60)).toISOString(),
    });
  }

  // Summary
  const summary = analyzer.getSummary();
  console.log("─── Execution Quality Summary ───\n");
  console.log(`  Total Trades:       ${summary.totalTrades}`);
  console.log(`  Avg Slippage:       ${summary.avgSlippageBps.toFixed(2)} bps`);
  console.log(`  Median Slippage:    ${summary.medianSlippageBps.toFixed(2)} bps`);
  console.log(`  Std Dev:            ${summary.stdSlippageBps.toFixed(2)} bps`);
  console.log(`  Best Fill:          ${summary.bestSlippageBps.toFixed(2)} bps`);
  console.log(`  Worst Fill:         ${summary.worstSlippageBps.toFixed(2)} bps`);
  console.log(`  Avg vs VWAP:        ${summary.avgVwapSlippageBps?.toFixed(2)} bps`);
  console.log(`  Adverse Fill Rate:  ${(summary.positiveSlippagePct * 100).toFixed(0)}%`);
  console.log(`  Total Cost:         $${summary.totalSlippageDollar.toFixed(0)}`);

  // Size analysis
  console.log("\n─── Slippage by Trade Size ───\n");
  const sizeAnalysis = analyzer.getSizeAnalysis();
  for (const [size, data] of Object.entries(sizeAnalysis)) {
    console.log(`  ${size.padEnd(8)}: ${data.count} trades, avg ${data.avgSlippageBps.toFixed(2)} bps`);
  }

  // IS decomposition example
  console.log("\n─── Implementation Shortfall Example ───\n");
  const is = implementationShortfall({
    decisionPrice: 150.00,
    arrivalPrice: 150.10,
    fillPrice: 150.15,
    endPrice: 150.05,
    quantity: 1000,
    side: "buy",
  });
  console.log(`  Decision Price: $150.00 → Fill: $150.15`);
  console.log(`  Total IS:      ${is.totalISBps.toFixed(1)} bps ($${is.totalCostDollar.toFixed(0)})`);
  console.log(`  Delay Cost:    ${is.delayCostBps.toFixed(1)} bps`);
  console.log(`  Market Impact: ${is.marketImpactBps.toFixed(1)} bps`);
  console.log(`  Timing Cost:   ${is.timingCostBps.toFixed(1)} bps`);
}

if (process.argv[1]?.includes("execution-analytics")) {
  main().catch(console.error);
}
