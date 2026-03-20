#!/usr/bin/env node
/**
 * Order Book Simulator — Inferred Analysis
 *
 * Simulates Level 2 order book for microstructure research:
 * 1. Bid/ask queues at each price level
 * 2. Market order execution with impact
 * 3. VPIN (Volume-Synchronized Probability of Informed Trading)
 * 4. Order flow imbalance signals
 * 5. Kyle's lambda (permanent price impact)
 *
 * Usage:
 *   node agents/strategies/orderbook-simulator.mjs
 *   import { OrderBook, simulateOrderFlow } from './orderbook-simulator.mjs'
 */

// ─── Order Book ─────────────────────────────────────────

export class OrderBook {
  constructor(tickSize = 0.01) {
    this.bids = new Map(); // price → { quantity, orders: [] }
    this.asks = new Map();
    this.tickSize = tickSize;
    this.trades = [];
    this.midPrice = 100;
    this.lastTradePrice = 100;
    this.buyVolume = 0;
    this.sellVolume = 0;
  }

  /**
   * Add a limit order to the book.
   */
  addLimit(side, price, quantity) {
    price = this._roundPrice(price);
    const book = side === "buy" ? this.bids : this.asks;

    if (!book.has(price)) {
      book.set(price, { quantity: 0, orders: [] });
    }
    const level = book.get(price);
    level.quantity += quantity;
    level.orders.push({ quantity, timestamp: Date.now() });
  }

  /**
   * Execute a market order against the book.
   * Returns { fillPrice, fillQuantity, impact }
   */
  marketOrder(side, quantity) {
    const book = side === "buy" ? this.asks : this.bids;
    const sortedPrices = [...book.keys()].sort((a, b) =>
      side === "buy" ? a - b : b - a
    );

    let remaining = quantity;
    let totalCost = 0;
    let fills = 0;

    for (const price of sortedPrices) {
      if (remaining <= 0) break;

      const level = book.get(price);
      const fillQty = Math.min(remaining, level.quantity);
      totalCost += fillQty * price;
      level.quantity -= fillQty;
      remaining -= fillQty;
      fills++;

      if (level.quantity <= 0) book.delete(price);
    }

    const filled = quantity - remaining;
    const avgPrice = filled > 0 ? totalCost / filled : 0;
    const prevMid = this.midPrice;

    this._updateMidPrice();

    if (filled > 0) {
      this.lastTradePrice = avgPrice;
      this.trades.push({
        side,
        quantity: filled,
        price: avgPrice,
        timestamp: Date.now(),
      });

      if (side === "buy") this.buyVolume += filled;
      else this.sellVolume += filled;
    }

    return {
      fillPrice: avgPrice,
      fillQuantity: filled,
      unfilled: remaining,
      impact: this.midPrice - prevMid,
      levelsConsumed: fills,
    };
  }

  /**
   * Cancel orders at a price level.
   */
  cancel(side, price, quantity) {
    price = this._roundPrice(price);
    const book = side === "buy" ? this.bids : this.asks;
    if (!book.has(price)) return;

    const level = book.get(price);
    level.quantity = Math.max(0, level.quantity - quantity);
    if (level.quantity <= 0) book.delete(price);
  }

  /**
   * Get bid-ask spread.
   */
  getSpread() {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    if (bestBid === null || bestAsk === null) return null;
    return {
      bid: bestBid,
      ask: bestAsk,
      spread: bestAsk - bestBid,
      spreadBps: ((bestAsk - bestBid) / this.midPrice) * 10000,
      mid: (bestBid + bestAsk) / 2,
    };
  }

  getBestBid() {
    if (this.bids.size === 0) return null;
    return Math.max(...this.bids.keys());
  }

  getBestAsk() {
    if (this.asks.size === 0) return null;
    return Math.min(...this.asks.keys());
  }

  /**
   * Get order book depth.
   */
  getDepth(levels = 5) {
    const bidPrices = [...this.bids.keys()].sort((a, b) => b - a).slice(0, levels);
    const askPrices = [...this.asks.keys()].sort((a, b) => a - b).slice(0, levels);

    return {
      bids: bidPrices.map(p => ({ price: p, quantity: this.bids.get(p).quantity })),
      asks: askPrices.map(p => ({ price: p, quantity: this.asks.get(p).quantity })),
    };
  }

  /**
   * Get order flow imbalance.
   */
  getImbalance() {
    let bidQty = 0, askQty = 0;
    for (const [, level] of this.bids) bidQty += level.quantity;
    for (const [, level] of this.asks) askQty += level.quantity;
    const total = bidQty + askQty;
    return {
      bidQuantity: bidQty,
      askQuantity: askQty,
      imbalance: total > 0 ? (bidQty - askQty) / total : 0,
      ratio: askQty > 0 ? bidQty / askQty : Infinity,
    };
  }

  _roundPrice(price) {
    return Math.round(price / this.tickSize) * this.tickSize;
  }

  _updateMidPrice() {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (bid !== null && ask !== null) {
      this.midPrice = (bid + ask) / 2;
    }
  }
}

// ─── Order Flow Simulation ──────────────────────────────

/**
 * Generate realistic order flow (Poisson arrivals, power-law sizes).
 */
export function simulateOrderFlow(steps = 1000, options = {}) {
  const {
    initialPrice = 100,
    tickSize = 0.01,
    avgSpread = 0.02,
    orderRate = 5,      // orders per step
    marketOrderPct = 0.3,
    cancelRate = 0.1,
  } = options;

  const book = new OrderBook(tickSize);
  const history = [];

  // Initialize book with some depth
  for (let i = 1; i <= 10; i++) {
    const qty = Math.floor(100 + Math.random() * 500);
    book.addLimit("buy", initialPrice - avgSpread / 2 - i * tickSize, qty);
    book.addLimit("sell", initialPrice + avgSpread / 2 + i * tickSize, qty);
  }

  for (let step = 0; step < steps; step++) {
    // Number of events this step (Poisson)
    const numEvents = poissonSample(orderRate);

    for (let e = 0; e < numEvents; e++) {
      const side = Math.random() < 0.5 ? "buy" : "sell";

      // Power-law order size
      const size = Math.floor(Math.pow(Math.random(), -0.5) * 50);

      if (Math.random() < marketOrderPct) {
        // Market order
        book.marketOrder(side, size);
      } else if (Math.random() < cancelRate) {
        // Cancel
        const price = side === "buy" ? book.getBestBid() : book.getBestAsk();
        if (price !== null) book.cancel(side, price, Math.floor(size * 0.5));
      } else {
        // Limit order
        const offset = Math.floor(Math.random() * 5 + 1) * tickSize;
        const price = side === "buy"
          ? book.midPrice - avgSpread / 2 - offset
          : book.midPrice + avgSpread / 2 + offset;
        book.addLimit(side, price, size);
      }
    }

    const spread = book.getSpread();
    const imbalance = book.getImbalance();

    history.push({
      step,
      midPrice: book.midPrice,
      spread: spread?.spread || 0,
      spreadBps: spread?.spreadBps || 0,
      imbalance: imbalance.imbalance,
      bidQty: imbalance.bidQuantity,
      askQty: imbalance.askQuantity,
      trades: book.trades.length,
      buyVolume: book.buyVolume,
      sellVolume: book.sellVolume,
    });
  }

  return { book, history };
}

function poissonSample(lambda) {
  let L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

// ─── VPIN (Volume-Synchronized Probability of Informed Trading) ───

/**
 * Compute VPIN from trade data.
 * Higher VPIN indicates more toxic (informed) order flow.
 */
export function computeVPIN(trades, bucketSize = 1000, numBuckets = 50) {
  if (trades.length === 0) return [];

  // Classify trades as buy or sell using tick rule
  const classified = trades.map((t, i) => ({
    ...t,
    buyInitiated: i === 0 ? t.side === "buy" : t.price > trades[i - 1].price,
  }));

  // Create volume buckets
  const buckets = [];
  let currentBucket = { buyVolume: 0, sellVolume: 0, totalVolume: 0 };

  for (const trade of classified) {
    const qty = trade.quantity || 1;
    if (trade.buyInitiated) currentBucket.buyVolume += qty;
    else currentBucket.sellVolume += qty;
    currentBucket.totalVolume += qty;

    if (currentBucket.totalVolume >= bucketSize) {
      buckets.push({ ...currentBucket });
      currentBucket = { buyVolume: 0, sellVolume: 0, totalVolume: 0 };
    }
  }

  // Compute VPIN over rolling window of buckets
  const vpinValues = [];
  for (let i = numBuckets; i <= buckets.length; i++) {
    const window = buckets.slice(i - numBuckets, i);
    const totalVol = window.reduce((s, b) => s + b.totalVolume, 0);
    const orderImbalance = window.reduce((s, b) => s + Math.abs(b.buyVolume - b.sellVolume), 0);
    const vpin = totalVol > 0 ? orderImbalance / totalVol : 0;
    vpinValues.push({ bucket: i, vpin });
  }

  return vpinValues;
}

// ─── Kyle's Lambda ──────────────────────────────────────

/**
 * Estimate Kyle's lambda (permanent price impact coefficient).
 * lambda = Cov(deltaP, signedVolume) / Var(signedVolume)
 */
export function estimateKyleLambda(trades) {
  if (trades.length < 10) return 0;

  const priceChanges = [];
  const signedVolumes = [];

  for (let i = 1; i < trades.length; i++) {
    const dp = trades[i].price - trades[i - 1].price;
    const sv = (trades[i].side === "buy" ? 1 : -1) * (trades[i].quantity || 1);
    priceChanges.push(dp);
    signedVolumes.push(sv);
  }

  const n = priceChanges.length;
  const meanDP = priceChanges.reduce((a, b) => a + b, 0) / n;
  const meanSV = signedVolumes.reduce((a, b) => a + b, 0) / n;

  let cov = 0, varSV = 0;
  for (let i = 0; i < n; i++) {
    cov += (priceChanges[i] - meanDP) * (signedVolumes[i] - meanSV);
    varSV += (signedVolumes[i] - meanSV) ** 2;
  }

  return varSV > 0 ? cov / varSV : 0;
}

// ─── Order Flow Signals ─────────────────────────────────

/**
 * Generate trading signals from order flow metrics.
 */
export function getOrderFlowSignals(history, options = {}) {
  const { imbalanceThreshold = 0.3, vpinThreshold = 0.7 } = options;

  return history.map(h => {
    let signal = 0;

    // Strong bid imbalance → bullish
    if (h.imbalance > imbalanceThreshold) signal = 1;
    // Strong ask imbalance → bearish
    if (h.imbalance < -imbalanceThreshold) signal = -1;

    return {
      step: h.step,
      signal,
      midPrice: h.midPrice,
      imbalance: h.imbalance,
      spreadBps: h.spreadBps,
    };
  });
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Order Book Simulator ═══\n");

  const { book, history } = simulateOrderFlow(500, {
    initialPrice: 100,
    orderRate: 8,
    marketOrderPct: 0.25,
  });

  // Book snapshot
  console.log("─── Order Book Snapshot ───\n");
  const depth = book.getDepth(5);
  console.log("  ASK (sell):");
  for (const level of [...depth.asks].reverse()) {
    const bar = "░".repeat(Math.min(40, Math.floor(level.quantity / 20)));
    console.log(`    $${level.price.toFixed(2).padStart(8)} | ${String(level.quantity).padStart(6)} ${bar}`);
  }
  const spread = book.getSpread();
  console.log(`    --- SPREAD: $${spread?.spread?.toFixed(3) || "?"} (${spread?.spreadBps?.toFixed(1) || "?"}bps) ---`);
  console.log("  BID (buy):");
  for (const level of depth.bids) {
    const bar = "▓".repeat(Math.min(40, Math.floor(level.quantity / 20)));
    console.log(`    $${level.price.toFixed(2).padStart(8)} | ${String(level.quantity).padStart(6)} ${bar}`);
  }

  // Microstructure metrics
  console.log("\n─── Microstructure Metrics ───\n");
  const imbalance = book.getImbalance();
  console.log(`  Order flow imbalance: ${imbalance.imbalance.toFixed(3)} (bid/ask ratio: ${imbalance.ratio.toFixed(2)})`);
  console.log(`  Total trades: ${book.trades.length}`);
  console.log(`  Buy volume: ${book.buyVolume.toFixed(0)}`);
  console.log(`  Sell volume: ${book.sellVolume.toFixed(0)}`);

  // VPIN
  const vpin = computeVPIN(book.trades, 100, 10);
  if (vpin.length > 0) {
    const latestVPIN = vpin[vpin.length - 1].vpin;
    console.log(`  VPIN: ${latestVPIN.toFixed(3)} (${latestVPIN > 0.5 ? "HIGH toxicity" : "normal"})`);
  }

  // Kyle's lambda
  const lambda = estimateKyleLambda(book.trades);
  console.log(`  Kyle's lambda: ${lambda.toFixed(6)} (price impact per unit flow)`);

  // Price history
  console.log("\n─── Price Evolution ───\n");
  const step = Math.floor(history.length / 10);
  for (let i = 0; i < history.length; i += step) {
    const h = history[i];
    const priceBar = "█".repeat(Math.max(0, Math.round((h.midPrice - 99) * 20)));
    console.log(`  Step ${String(h.step).padStart(4)}: $${h.midPrice.toFixed(3)} ${priceBar} imb=${h.imbalance.toFixed(2)}`);
  }

  // Signals
  const signals = getOrderFlowSignals(history, { imbalanceThreshold: 0.25 });
  const longSignals = signals.filter(s => s.signal === 1).length;
  const shortSignals = signals.filter(s => s.signal === -1).length;
  console.log(`\n  Signals: Long=${longSignals} Short=${shortSignals} Flat=${signals.length - longSignals - shortSignals}`);
}

if (process.argv[1]?.includes("orderbook-simulator")) {
  main().catch(console.error);
}
