#!/usr/bin/env node
/**
 * Smart Order Router — Optimal execution across multiple venues
 *
 * Determines best venue(s) for order execution, splits large orders,
 * and selects execution algorithms (TWAP, VWAP, IS, Iceberg, Sniper).
 *
 * Usage:
 *   node agents/trading/smart-order-router.mjs                  # Run demo
 *   node agents/trading/smart-order-router.mjs --symbol AAPL    # Specific symbol
 *   node agents/trading/smart-order-router.mjs --qty 50000      # Large order split
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Execution Algorithms ────────────────────────────────

/**
 * Time-Weighted Average Price schedule.
 * Splits quantity evenly across intervals over duration.
 */
export function twapSchedule(totalQty, duration, intervals) {
  const sliceQty = Math.floor(totalQty / intervals);
  const remainder = totalQty - sliceQty * intervals;
  const intervalMs = duration / intervals;
  const slices = [];

  for (let i = 0; i < intervals; i++) {
    slices.push({
      index: i,
      qty: sliceQty + (i < remainder ? 1 : 0),
      timeOffset: Math.round(i * intervalMs),
      pctComplete: +((i + 1) / intervals * 100).toFixed(1),
    });
  }
  return slices;
}

/**
 * Volume-Weighted Average Price schedule.
 * Distributes quantity proportional to expected volume profile.
 */
export function vwapSchedule(totalQty, volumeProfile) {
  const totalVol = volumeProfile.reduce((s, v) => s + v, 0);
  const slices = [];
  let filled = 0;

  for (let i = 0; i < volumeProfile.length; i++) {
    const weight = volumeProfile[i] / totalVol;
    const qty = i === volumeProfile.length - 1
      ? totalQty - filled
      : Math.round(totalQty * weight);
    filled += qty;

    slices.push({
      index: i,
      qty,
      volumeWeight: +weight.toFixed(4),
      pctComplete: +(filled / totalQty * 100).toFixed(1),
    });
  }
  return slices;
}

/**
 * Iceberg order — only display a portion of total quantity.
 */
export function icebergOrder(totalQty, displayQty) {
  const layers = [];
  let remaining = totalQty;
  let layer = 0;

  while (remaining > 0) {
    const show = Math.min(displayQty, remaining);
    layers.push({
      layer: layer++,
      displayQty: show,
      hiddenQty: remaining - show,
      totalRemaining: remaining,
    });
    remaining -= show;
  }
  return layers;
}

/**
 * Implementation Shortfall (Almgren-Chriss inspired).
 * Balances urgency against market impact cost.
 * Returns a front-loaded or back-loaded schedule depending on urgency.
 */
export function implementationShortfall(totalQty, urgency, volatility) {
  // urgency 0..1: 0 = patient (minimize impact), 1 = aggressive (minimize risk)
  const kappa = urgency * 2 + 0.1; // trade-off parameter
  const intervals = 10;
  const slices = [];
  let filled = 0;

  for (let i = 0; i < intervals; i++) {
    const t = (i + 1) / intervals;
    // Exponential front-loading based on urgency
    const cumFrac = 1 - Math.exp(-kappa * t) / Math.exp(-kappa);
    const cumNorm = cumFrac / (1 - Math.exp(-kappa * (1 + 1 / intervals)) / Math.exp(-kappa));
    const targetFilled = Math.min(Math.round(totalQty * Math.min(cumNorm, 1)), totalQty);
    const qty = targetFilled - filled;

    slices.push({
      index: i,
      qty: Math.max(qty, 0),
      expectedImpact: +(volatility * Math.sqrt(qty / totalQty) * 100).toFixed(3),
      riskCost: +(volatility * (totalQty - filled) / totalQty * urgency * 100).toFixed(3),
      pctComplete: +(targetFilled / totalQty * 100).toFixed(1),
    });
    filled = targetFilled;
  }

  // Ensure all qty allocated
  const totalAllocated = slices.reduce((s, sl) => s + sl.qty, 0);
  if (totalAllocated < totalQty) {
    slices[slices.length - 1].qty += totalQty - totalAllocated;
  }

  return slices;
}

// ─── Order Simulator ─────────────────────────────────────

export class OrderSimulator {
  constructor(prices, seed = 42) {
    this.prices = prices;
    this.rngState = seed;
  }

  _rng() {
    this.rngState = (this.rngState * 1664525 + 1013904223) & 0x7fffffff;
    return this.rngState / 0x7fffffff;
  }

  _randn() {
    const u1 = this._rng() * 0.9998 + 0.0001;
    const u2 = this._rng() * 0.9998 + 0.0001;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Simulate filling an order slice at a given price index.
   * Returns { fillPrice, slippage, filled, latencyMs }
   */
  simulateFill(qty, priceIndex, venue) {
    const bar = this.prices[Math.min(priceIndex, this.prices.length - 1)];
    const mid = (bar.high + bar.low) / 2;
    const spread = (bar.high - bar.low) * 0.1;

    // Slippage = spread cost + random noise + market impact
    const impactBps = Math.sqrt(qty / (bar.volume || 1_000_000)) * 50;
    const noiseBps = this._randn() * 2;
    const totalSlippage = spread / 2 + mid * (impactBps + noiseBps) / 10000;

    const fillRate = venue?.fillRate ?? (0.85 + this._rng() * 0.15);
    const filled = this._rng() < fillRate;
    const latencyMs = (venue?.latency ?? 5) + this._rng() * 3;

    return {
      fillPrice: +(mid + totalSlippage).toFixed(4),
      midPrice: +mid.toFixed(4),
      slippageBps: +((totalSlippage / mid) * 10000).toFixed(2),
      filled,
      qty,
      latencyMs: +latencyMs.toFixed(2),
    };
  }

  /**
   * Simulate execution of a full schedule across price bars.
   */
  simulateSchedule(schedule, venue) {
    const fills = [];
    let totalCost = 0;
    let totalQty = 0;

    for (let i = 0; i < schedule.length; i++) {
      const slice = schedule[i];
      if (slice.qty <= 0) continue;

      const startIdx = Math.floor((i / schedule.length) * this.prices.length * 0.5);
      const result = this.simulateFill(slice.qty, startIdx, venue);

      if (result.filled) {
        totalCost += result.fillPrice * result.qty;
        totalQty += result.qty;
      }
      fills.push({ ...result, sliceIndex: i });
    }

    const avgPrice = totalQty > 0 ? totalCost / totalQty : 0;
    const arrivalPrice = this.prices[0] ? (this.prices[0].high + this.prices[0].low) / 2 : 0;

    return {
      fills,
      totalFilled: totalQty,
      avgFillPrice: +avgPrice.toFixed(4),
      arrivalPrice: +arrivalPrice.toFixed(4),
      implementationShortfallBps: arrivalPrice > 0
        ? +(((avgPrice - arrivalPrice) / arrivalPrice) * 10000).toFixed(2)
        : 0,
      fillRate: +(fills.filter(f => f.filled).length / fills.length * 100).toFixed(1),
    };
  }
}

// ─── Smart Order Router ──────────────────────────────────

export class SmartOrderRouter {
  constructor(venues) {
    this.venues = venues;
    this.history = []; // track past executions
  }

  /**
   * Estimate total execution cost for an order at a venue (in bps).
   * Cost = fees - rebates + estimated spread + market impact.
   */
  estimateCost(order, venue) {
    const notional = order.qty * order.price;
    const feeCost = venue.fee * notional;
    const rebateSaving = venue.rebate * notional;
    const spreadCost = notional * 0.0002; // assume 2bps half-spread
    const impactCost = notional * Math.sqrt(order.qty / 1_000_000) * 0.001;
    const latencyPenalty = venue.latency * notional * 0.00001;

    const totalCost = feeCost - rebateSaving + spreadCost + impactCost + latencyPenalty;
    return {
      venue: venue.name,
      feeCost: +feeCost.toFixed(2),
      rebateSaving: +rebateSaving.toFixed(2),
      spreadCost: +spreadCost.toFixed(2),
      impactCost: +impactCost.toFixed(2),
      latencyPenalty: +latencyPenalty.toFixed(2),
      totalCost: +totalCost.toFixed(2),
      costBps: +((totalCost / notional) * 10000).toFixed(2),
    };
  }

  /**
   * Route an order to the optimal venue based on total cost.
   */
  routeOrder(order) {
    const costs = this.venues.map(v => this.estimateCost(order, v));
    costs.sort((a, b) => a.totalCost - b.totalCost);

    const best = costs[0];
    const venue = this.venues.find(v => v.name === best.venue);

    return {
      recommendation: best.venue,
      venue,
      costs,
      savings: costs.length > 1
        ? +(costs[costs.length - 1].totalCost - best.totalCost).toFixed(2)
        : 0,
    };
  }

  /**
   * Split a large order across venues and time to limit participation rate.
   */
  splitOrder(order, maxParticipation = 0.05) {
    const avgDailyVolume = order.adv || 5_000_000;
    const maxPerInterval = Math.floor(avgDailyVolume * maxParticipation);
    const intervals = Math.max(1, Math.ceil(order.qty / maxPerInterval));

    // Rank venues by cost
    const ranked = this.venues
      .map(v => ({ venue: v, cost: this.estimateCost(order, v) }))
      .sort((a, b) => a.cost.totalCost - b.cost.totalCost);

    // Distribute across top venues (up to 3)
    const topVenues = ranked.slice(0, Math.min(3, ranked.length));
    const venueWeights = topVenues.map((v, i) => 1 / (i + 1));
    const totalWeight = venueWeights.reduce((s, w) => s + w, 0);

    const splits = topVenues.map((v, i) => {
      const pct = venueWeights[i] / totalWeight;
      return {
        venue: v.venue.name,
        qty: Math.round(order.qty * pct),
        pct: +(pct * 100).toFixed(1),
        estimatedCostBps: v.cost.costBps,
        intervals: Math.ceil(Math.round(order.qty * pct) / maxPerInterval),
      };
    });

    // Fix rounding
    const totalAllocated = splits.reduce((s, sp) => s + sp.qty, 0);
    if (totalAllocated !== order.qty) {
      splits[0].qty += order.qty - totalAllocated;
    }

    return {
      order,
      maxParticipation,
      maxPerInterval,
      totalIntervals: intervals,
      splits,
    };
  }

  /**
   * Select the best execution algorithm based on order characteristics.
   */
  selectAlgorithm(order) {
    const qtyPctADV = order.qty / (order.adv || 5_000_000);
    const urgency = order.urgency ?? 0.5;
    const volatility = order.volatility ?? 0.02;

    // Decision tree
    if (urgency > 0.8 && qtyPctADV < 0.01) {
      return {
        algorithm: "Sniper",
        reason: "High urgency, small size — aggressive immediate execution",
        params: { aggression: "high", maxSpreadBps: 5 },
      };
    }
    if (qtyPctADV > 0.1) {
      return {
        algorithm: "Iceberg",
        reason: `Large order (${(qtyPctADV * 100).toFixed(1)}% ADV) — hide size to minimize impact`,
        params: { displayPct: 0.1, refillDelay: 500 },
      };
    }
    if (urgency < 0.3 && volatility < 0.02) {
      return {
        algorithm: "TWAP",
        reason: "Low urgency, low volatility — spread evenly over time",
        params: { duration: 3600_000, intervals: 20 },
      };
    }
    if (urgency > 0.5) {
      return {
        algorithm: "IS",
        reason: "Moderate-to-high urgency — minimize implementation shortfall",
        params: { urgency, volatility },
      };
    }
    return {
      algorithm: "VWAP",
      reason: "Default — match volume profile to minimize market impact",
      params: { lookbackDays: 5 },
    };
  }

  /**
   * Get historical venue statistics.
   */
  getVenueStats() {
    const stats = {};
    for (const v of this.venues) {
      stats[v.name] = {
        avgFillRate: v.fillRate,
        avgLatencyMs: v.latency,
        feeBps: +(v.fee * 10000).toFixed(2),
        rebateBps: +(v.rebate * 10000).toFixed(2),
        netCostBps: +((v.fee - v.rebate) * 10000).toFixed(2),
        historicalFills: this.history.filter(h => h.venue === v.name).length,
      };
    }
    return stats;
  }

  /**
   * Optimize execution balancing speed vs cost based on urgency (0..1).
   */
  optimizeExecution(order, urgency) {
    const algo = this.selectAlgorithm({ ...order, urgency });
    const routing = this.routeOrder(order);
    const volatility = order.volatility ?? 0.02;

    // Duration inversely proportional to urgency
    const baseDuration = 3600_000; // 1 hour in ms
    const duration = Math.round(baseDuration * (1 - urgency * 0.8));
    const intervals = Math.max(1, Math.round(20 * (1 - urgency * 0.7)));

    let schedule;
    switch (algo.algorithm) {
      case "TWAP":
        schedule = twapSchedule(order.qty, duration, intervals);
        break;
      case "VWAP":
        schedule = vwapSchedule(order.qty, generateVolumeProfile(intervals));
        break;
      case "IS":
        schedule = implementationShortfall(order.qty, urgency, volatility);
        break;
      case "Iceberg":
        schedule = icebergOrder(order.qty, Math.ceil(order.qty * 0.1));
        break;
      case "Sniper":
        schedule = [{ index: 0, qty: order.qty, pctComplete: 100 }];
        break;
      default:
        schedule = twapSchedule(order.qty, duration, intervals);
    }

    return {
      algorithm: algo,
      routing,
      duration,
      intervals,
      schedule,
      expectedCostBps: routing.costs[0]?.costBps ?? 0,
      urgencyLevel: urgency < 0.3 ? "Patient" : urgency < 0.7 ? "Normal" : "Aggressive",
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────

function generateVolumeProfile(buckets) {
  // U-shaped intraday volume (high at open/close, low midday)
  const profile = [];
  for (let i = 0; i < buckets; i++) {
    const t = i / (buckets - 1); // 0 to 1
    const openWeight = Math.exp(-10 * t);
    const closeWeight = Math.exp(-10 * (1 - t));
    const midWeight = 0.3;
    profile.push(openWeight + closeWeight + midWeight);
  }
  return profile;
}

function fmt(n) {
  return typeof n === "number" ? n.toLocaleString() : String(n);
}

// ─── CLI Demo ────────────────────────────────────────────

function runDemo() {
  const args = process.argv.slice(2);
  const symbol = args.find((a, i) => args[i - 1] === "--symbol") || "SPY";
  const qtyArg = args.find((a, i) => args[i - 1] === "--qty");
  const qty = qtyArg ? parseInt(qtyArg) : 10_000;

  console.log("=== Smart Order Router Demo ===\n");

  // Define venues
  const venues = [
    { name: "NYSE",     fee: 0.0003, rebate: 0.0002, latency: 2,  fillRate: 0.95 },
    { name: "NASDAQ",   fee: 0.0003, rebate: 0.00025,latency: 1.5,fillRate: 0.93 },
    { name: "BATS",     fee: 0.0002, rebate: 0.00015,latency: 1,  fillRate: 0.88 },
    { name: "IEX",      fee: 0.0001, rebate: 0.0,    latency: 3,  fillRate: 0.80 },
    { name: "DarkPool1",fee: 0.0001, rebate: 0.0001, latency: 5,  fillRate: 0.60 },
  ];

  const router = new SmartOrderRouter(venues);

  // Generate prices for simulation
  const prices = generateRealisticPrices(symbol);
  const currentPrice = prices[prices.length - 1].close;

  const order = {
    symbol,
    side: "BUY",
    qty,
    price: currentPrice,
    adv: 20_000_000,
    urgency: 0.5,
    volatility: 0.018,
  };

  // 1. Route order
  console.log(`Order: ${order.side} ${fmt(order.qty)} ${order.symbol} @ $${currentPrice.toFixed(2)}`);
  console.log(`Notional: $${fmt(Math.round(order.qty * currentPrice))}\n`);

  const routing = router.routeOrder(order);
  console.log("--- Venue Cost Analysis ---");
  for (const c of routing.costs) {
    console.log(`  ${c.venue.padEnd(10)} total: $${c.totalCost.toFixed(2).padStart(8)}  (${c.costBps} bps)  fees: $${c.feeCost.toFixed(2)}  rebate: -$${c.rebateSaving.toFixed(2)}`);
  }
  console.log(`\n  Best venue: ${routing.recommendation} (saves $${routing.savings} vs worst)\n`);

  // 2. Algorithm selection
  const algo = router.selectAlgorithm(order);
  console.log("--- Algorithm Selection ---");
  console.log(`  Algorithm: ${algo.algorithm}`);
  console.log(`  Reason: ${algo.reason}`);
  console.log(`  Params: ${JSON.stringify(algo.params)}\n`);

  // 3. Order splitting (large order)
  if (qty >= 10000) {
    const split = router.splitOrder(order, 0.05);
    console.log("--- Order Split Plan ---");
    console.log(`  Max participation: ${(split.maxParticipation * 100).toFixed(0)}% of ADV`);
    console.log(`  Max per interval: ${fmt(split.maxPerInterval)} shares`);
    for (const s of split.splits) {
      console.log(`  ${s.venue.padEnd(10)} ${fmt(s.qty).padStart(8)} shares (${s.pct}%)  est cost: ${s.estimatedCostBps} bps  intervals: ${s.intervals}`);
    }
    console.log();
  }

  // 4. Execution optimization at different urgency levels
  console.log("--- Urgency Comparison ---");
  for (const urgency of [0.1, 0.5, 0.9]) {
    const opt = router.optimizeExecution(order, urgency);
    console.log(`  Urgency ${urgency} (${opt.urgencyLevel}):`);
    console.log(`    Algo: ${opt.algorithm.algorithm}  Duration: ${(opt.duration / 1000).toFixed(0)}s  Slices: ${opt.schedule.length}  Est cost: ${opt.expectedCostBps} bps`);
  }
  console.log();

  // 5. Simulate execution
  console.log("--- Execution Simulation ---");
  const sim = new OrderSimulator(prices);

  const algoTests = [
    { name: "TWAP", schedule: twapSchedule(qty, 3600_000, 15) },
    { name: "VWAP", schedule: vwapSchedule(qty, generateVolumeProfile(15)) },
    { name: "IS(urgent)", schedule: implementationShortfall(qty, 0.8, 0.018) },
    { name: "IS(patient)", schedule: implementationShortfall(qty, 0.2, 0.018) },
  ];

  for (const test of algoTests) {
    const result = sim.simulateSchedule(test.schedule, venues[0]);
    console.log(`  ${test.name.padEnd(12)} Filled: ${fmt(result.totalFilled).padStart(7)}  Avg: $${result.avgFillPrice.toFixed(2)}  IS: ${result.implementationShortfallBps} bps  Fill%: ${result.fillRate}%`);
  }
  console.log();

  // 6. Iceberg demo
  console.log("--- Iceberg Order ---");
  const iceberg = icebergOrder(qty, Math.ceil(qty * 0.1));
  console.log(`  Total: ${fmt(qty)}  Display: ${fmt(Math.ceil(qty * 0.1))}  Layers: ${iceberg.length}`);
  for (const layer of iceberg.slice(0, 5)) {
    console.log(`    Layer ${layer.layer}: show ${fmt(layer.displayQty)}, hidden ${fmt(layer.hiddenQty)}`);
  }
  if (iceberg.length > 5) console.log(`    ... ${iceberg.length - 5} more layers`);
  console.log();

  // 7. Venue stats
  console.log("--- Venue Statistics ---");
  const stats = router.getVenueStats();
  for (const [name, s] of Object.entries(stats)) {
    console.log(`  ${name.padEnd(10)} fill: ${(s.avgFillRate * 100).toFixed(0)}%  latency: ${s.avgLatencyMs}ms  net cost: ${s.netCostBps} bps`);
  }

  console.log("\n=== Done ===");
}

// Run CLI if called directly
const isMain = process.argv[1]?.endsWith("smart-order-router.mjs");
if (isMain) {
  runDemo();
}
