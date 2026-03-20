#!/usr/bin/env node
/**
 * Transaction Cost Model with Market Impact — Inferred Analysis
 *
 * Models realistic trading costs:
 * 1. Spread costs (bid-ask)
 * 2. Market impact (Almgren-Chriss, square-root model)
 * 3. Timing risk
 * 4. Opportunity cost
 * 5. Optimal execution (TWAP, VWAP, IS benchmarks)
 *
 * Usage:
 *   node agents/risk/transaction-cost-model.mjs
 *   import { TransactionCostModel, optimalExecution } from './transaction-cost-model.mjs'
 */

// ─── Market Impact Models ───────────────────────────────

/**
 * Square-root market impact model.
 * Impact = sigma * sqrt(Q / V) * sign(Q)
 * Where: sigma = daily vol, Q = order shares, V = daily volume
 */
export function squareRootImpact(orderShares, dailyVolume, dailyVol, participationRate = 0.10) {
  const normalizedSize = Math.abs(orderShares) / dailyVolume;
  const impact = dailyVol * Math.sqrt(normalizedSize) * Math.sign(orderShares);
  return {
    permanentImpact: impact * 0.5, // half is permanent
    temporaryImpact: impact * 0.5, // half decays
    totalImpact: impact,
    participationRate: Math.abs(orderShares) / dailyVolume,
  };
}

/**
 * Almgren-Chriss optimal execution model.
 * Balances market impact vs timing risk.
 * Returns optimal trade schedule.
 */
export function almgrenChriss(totalShares, timeSlots, dailyVol, dailyVolume, riskAversion = 1e-6) {
  const eta = dailyVol * 0.01; // temporary impact coeff
  const gamma = dailyVol * 0.001; // permanent impact coeff
  const sigma = dailyVol / Math.sqrt(252); // per-slot volatility

  const tau = 1 / timeSlots; // time per slot
  const kappa = Math.sqrt(riskAversion * sigma * sigma / (eta * (1 / tau)));

  // Optimal trajectory
  const trajectory = [];
  let remaining = totalShares;

  for (let k = 0; k < timeSlots; k++) {
    const t = k / timeSlots;
    const tradeSize = remaining * (1 - Math.exp(-kappa * tau)) / (1 - Math.exp(-kappa * (1 - t)));
    const trade = Math.min(tradeSize, remaining);

    trajectory.push({
      slot: k,
      tradeShares: trade,
      remaining: remaining - trade,
      participationRate: trade / (dailyVolume / timeSlots),
    });

    remaining -= trade;
  }

  // Cost estimate
  const totalImpact = squareRootImpact(totalShares, dailyVolume, dailyVol);
  const timingRisk = sigma * Math.sqrt(timeSlots * tau) * Math.abs(totalShares);

  return {
    trajectory,
    estimatedImpactCost: Math.abs(totalImpact.totalImpact * totalShares),
    timingRisk,
    totalExpectedCost: Math.abs(totalImpact.totalImpact * totalShares) + timingRisk * 0.5,
  };
}

// ─── Transaction Cost Model ─────────────────────────────

export class TransactionCostModel {
  constructor(options = {}) {
    this.spreadBps = options.spreadBps || 2;       // bid-ask spread in bps
    this.commissionBps = options.commissionBps || 1; // commission in bps
    this.slippageBps = options.slippageBps || 3;     // execution slippage
    this.impactModel = options.impactModel || "square_root";
    this.avgDailyVolume = options.avgDailyVolume || 10_000_000;
    this.dailyVol = options.dailyVol || 0.015;
  }

  /**
   * Estimate total cost for a trade.
   * Returns cost breakdown in basis points.
   */
  estimateCost(orderValue, orderShares, price) {
    const volume = this.avgDailyVolume;

    // 1. Spread cost (half-spread for market orders)
    const spreadCost = this.spreadBps / 2;

    // 2. Commission
    const commissionCost = this.commissionBps;

    // 3. Market impact
    const impact = squareRootImpact(orderShares, volume, this.dailyVol);
    const impactBps = Math.abs(impact.totalImpact) * 10000;

    // 4. Slippage
    const slippage = this.slippageBps;

    // 5. Opportunity cost (price may move while waiting)
    const opCost = this.dailyVol * Math.sqrt(1 / 252) * 10000 * 0.1; // 10% of daily vol

    const totalBps = spreadCost + commissionCost + impactBps + slippage + opCost;
    const totalDollars = orderValue * totalBps / 10000;

    return {
      spreadBps: spreadCost,
      commissionBps: commissionCost,
      impactBps,
      slippageBps: slippage,
      opportunityCostBps: opCost,
      totalBps,
      totalDollars,
      participationRate: impact.participationRate,
      netReturn: -totalBps / 10000, // cost as negative return
    };
  }

  /**
   * Compute break-even holding period.
   * How many days must you hold for expected alpha to exceed costs?
   */
  breakEvenDays(expectedDailyAlphaBps, orderShares) {
    const cost = this.estimateCost(
      orderShares * 100, // approximate value
      orderShares,
      100
    );
    const roundTripBps = cost.totalBps * 2; // entry + exit
    return roundTripBps / expectedDailyAlphaBps;
  }

  /**
   * Optimal trade size given expected alpha and costs.
   * Maximizes net expected return: alpha * size - cost(size)
   */
  optimalTradeSize(expectedAlphaBps, maxSize, price = 100) {
    let bestSize = 0;
    let bestNet = -Infinity;

    // Grid search (simple but effective for this dimensionality)
    for (let frac = 0.01; frac <= 1.0; frac += 0.01) {
      const size = maxSize * frac;
      const cost = this.estimateCost(size * price, size, price);
      const grossReturn = expectedAlphaBps;
      const netReturn = grossReturn - cost.totalBps;

      if (netReturn > bestNet) {
        bestNet = netReturn;
        bestSize = size;
      }
    }

    return {
      optimalShares: bestSize,
      optimalFraction: bestSize / maxSize,
      expectedNetAlphaBps: bestNet,
      costAtOptimal: this.estimateCost(bestSize * price, bestSize, price),
    };
  }
}

// ─── Execution Benchmarks ───────────────────────────────

/**
 * TWAP (Time-Weighted Average Price) execution.
 * Splits order evenly across time slots.
 */
export function twapSchedule(totalShares, numSlots) {
  const perSlot = totalShares / numSlots;
  return Array.from({ length: numSlots }, (_, i) => ({
    slot: i,
    shares: perSlot,
    cumulative: perSlot * (i + 1),
  }));
}

/**
 * VWAP (Volume-Weighted Average Price) execution.
 * Trades proportional to expected volume profile.
 */
export function vwapSchedule(totalShares, volumeProfile) {
  const totalVol = volumeProfile.reduce((a, b) => a + b, 0);
  let cumulative = 0;

  return volumeProfile.map((vol, i) => {
    const shares = totalShares * (vol / totalVol);
    cumulative += shares;
    return { slot: i, shares, cumulative, volumeFraction: vol / totalVol };
  });
}

/**
 * Typical U-shaped intraday volume profile (13 30-min slots).
 */
export function typicalVolumeProfile() {
  // Higher volume at open and close
  return [15, 10, 7, 6, 5, 5, 5, 5, 6, 7, 8, 10, 14];
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Transaction Cost Model ═══\n");

  const model = new TransactionCostModel({
    spreadBps: 2,
    commissionBps: 1,
    avgDailyVolume: 50_000_000,
    dailyVol: 0.015,
  });

  // Cost estimates for different trade sizes
  console.log("─── Cost Breakdown by Order Size ───");
  console.log("  Size ($)      Spread  Comm  Impact  Slip  OpCost  TOTAL");

  for (const size of [10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000]) {
    const shares = size / 100; // assume $100 stock
    const cost = model.estimateCost(size, shares, 100);
    console.log(
      `  $${(size / 1000).toFixed(0).padStart(6)}K` +
      `  ${cost.spreadBps.toFixed(1).padStart(6)}` +
      `  ${cost.commissionBps.toFixed(1).padStart(4)}` +
      `  ${cost.impactBps.toFixed(1).padStart(6)}` +
      `  ${cost.slippageBps.toFixed(1).padStart(4)}` +
      `  ${cost.opportunityCostBps.toFixed(1).padStart(6)}` +
      `  ${cost.totalBps.toFixed(1).padStart(5)} bps ($${cost.totalDollars.toFixed(0)})`
    );
  }

  // Break-even analysis
  console.log("\n─── Break-Even Holding Period ───");
  for (const alpha of [1, 2, 5, 10, 20]) {
    const days = model.breakEvenDays(alpha, 1000);
    console.log(`  Alpha=${alpha}bps/day → break-even in ${days.toFixed(1)} days`);
  }

  // Optimal trade sizing
  console.log("\n─── Optimal Trade Size ───");
  const optimal = model.optimalTradeSize(5, 50_000);
  console.log(`  Expected alpha: 5 bps`);
  console.log(`  Max shares: 50,000`);
  console.log(`  Optimal: ${optimal.optimalShares.toFixed(0)} shares (${(optimal.optimalFraction * 100).toFixed(0)}%)`);
  console.log(`  Net alpha at optimal: ${optimal.expectedNetAlphaBps.toFixed(1)} bps`);

  // Almgren-Chriss execution
  console.log("\n─── Almgren-Chriss Optimal Execution ───");
  const ac = almgrenChriss(100_000, 13, 0.015, 50_000_000);
  console.log(`  Slots: 13 (30-min intervals)`);
  console.log(`  Estimated impact: $${ac.estimatedImpactCost.toFixed(0)}`);
  console.log(`  Timing risk: $${ac.timingRisk.toFixed(0)}`);
  console.log(`  Total expected cost: $${ac.totalExpectedCost.toFixed(0)}`);
  console.log("\n  Execution schedule:");
  for (const slot of ac.trajectory.slice(0, 5)) {
    console.log(`    Slot ${slot.slot}: trade ${slot.tradeShares.toFixed(0)} shares, ${(slot.participationRate * 100).toFixed(1)}% participation`);
  }
  console.log(`    ... (${ac.trajectory.length - 5} more slots)`);

  // VWAP schedule
  console.log("\n─── VWAP Execution Schedule ───");
  const profile = typicalVolumeProfile();
  const vwap = vwapSchedule(100_000, profile);
  for (const slot of vwap) {
    const bar = "█".repeat(Math.round(slot.volumeFraction * 50));
    console.log(`    ${String(slot.slot).padStart(2)}: ${slot.shares.toFixed(0).padStart(8)} shares ${bar}`);
  }
}

if (process.argv[1]?.includes("transaction-cost-model")) {
  main().catch(console.error);
}
