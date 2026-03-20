#!/usr/bin/env node
/**
 * Market Making Strategy — Inferred Analysis
 *
 * Simulates market making with inventory management:
 * 1. Avellaneda-Stoikov optimal quotes
 * 2. Inventory risk management
 * 3. Adverse selection detection
 * 4. Spread optimization based on volatility
 *
 * Usage:
 *   node agents/strategies/market-making.mjs
 *   import { MarketMaker, avellanedaStoikov } from './market-making.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Avellaneda-Stoikov Model ───────────────────────────

/**
 * Compute optimal bid/ask quotes using Avellaneda-Stoikov.
 * r(s,t) = s - q * gamma * sigma^2 * (T - t)
 * delta = gamma * sigma^2 * (T - t) + (2/gamma) * ln(1 + gamma/k)
 */
export function avellanedaStoikov(midPrice, inventory, volatility, timeRemaining, riskAversion = 0.1, orderArrivalRate = 1) {
  const gamma = riskAversion;
  const sigma = volatility;
  const T = timeRemaining;
  const k = orderArrivalRate;

  // Reservation price (adjusted mid based on inventory)
  const reservationPrice = midPrice - inventory * gamma * sigma * sigma * T;

  // Optimal spread
  const spread = gamma * sigma * sigma * T + (2 / gamma) * Math.log(1 + gamma / k);

  const bidPrice = reservationPrice - spread / 2;
  const askPrice = reservationPrice + spread / 2;

  return {
    bidPrice,
    askPrice,
    reservationPrice,
    spread,
    spreadBps: (spread / midPrice) * 10000,
    inventoryAdjustment: midPrice - reservationPrice,
  };
}

// ─── Market Maker Class ─────────────────────────────────

export class MarketMaker {
  constructor(options = {}) {
    this.inventory = 0;
    this.cash = options.initialCash || 1_000_000;
    this.maxInventory = options.maxInventory || 1000;
    this.riskAversion = options.riskAversion || 0.1;
    this.minSpread = options.minSpread || 0.0005; // 5 bps minimum
    this.trades = [];
    this.pnl = [];
    this.spreadsQuoted = [];
  }

  /**
   * Compute and return quotes for current state.
   */
  quote(midPrice, volatility, timeRemaining = 1) {
    const quotes = avellanedaStoikov(
      midPrice, this.inventory, volatility, timeRemaining,
      this.riskAversion, 1
    );

    // Enforce minimum spread
    if (quotes.spread < this.minSpread * midPrice) {
      const halfMin = this.minSpread * midPrice / 2;
      quotes.bidPrice = quotes.reservationPrice - halfMin;
      quotes.askPrice = quotes.reservationPrice + halfMin;
      quotes.spread = this.minSpread * midPrice;
    }

    // Skew quotes based on inventory
    const inventoryRatio = this.inventory / this.maxInventory;
    if (Math.abs(inventoryRatio) > 0.5) {
      const skew = inventoryRatio * 0.001 * midPrice;
      quotes.bidPrice -= skew;
      quotes.askPrice -= skew;
    }

    // Widen spread when inventory is extreme
    if (Math.abs(this.inventory) > this.maxInventory * 0.8) {
      quotes.spread *= 1.5;
      quotes.bidPrice = quotes.reservationPrice - quotes.spread / 2;
      quotes.askPrice = quotes.reservationPrice + quotes.spread / 2;
    }

    this.spreadsQuoted.push(quotes.spreadBps);
    return quotes;
  }

  /**
   * Process a trade fill.
   */
  fill(side, price, quantity) {
    if (side === "buy") {
      this.inventory += quantity;
      this.cash -= price * quantity;
    } else {
      this.inventory -= quantity;
      this.cash += price * quantity;
    }

    this.trades.push({ side, price, quantity, inventory: this.inventory, cash: this.cash });
  }

  /**
   * Get current P&L (mark-to-market).
   */
  getPnL(currentPrice) {
    return this.cash + this.inventory * currentPrice;
  }

  /**
   * Get performance summary.
   */
  getSummary(finalPrice) {
    const finalPnL = this.getPnL(finalPrice);
    const initialCapital = 1_000_000;
    const totalReturn = (finalPnL - initialCapital) / initialCapital;

    const avgSpread = this.spreadsQuoted.length > 0
      ? this.spreadsQuoted.reduce((a, b) => a + b, 0) / this.spreadsQuoted.length
      : 0;

    return {
      finalPnL,
      totalReturn,
      totalTrades: this.trades.length,
      avgSpreadBps: avgSpread,
      finalInventory: this.inventory,
      maxInventory: Math.max(...this.trades.map(t => Math.abs(t.inventory)), 0),
    };
  }
}

// ─── Simulation ─────────────────────────────────────────

/**
 * Run a market making simulation.
 */
export function simulateMarketMaking(prices, options = {}) {
  const { fillProbability = 0.3, avgTradeSize = 50 } = options;
  const mm = new MarketMaker(options);
  const equityCurve = [];

  for (let i = 1; i < prices.length; i++) {
    const mid = prices[i].close;
    const vol = i > 20
      ? Math.sqrt(prices.slice(Math.max(0, i - 20), i).reduce((s, p, idx) => {
          if (idx === 0) return 0;
          const r = (p.close - prices[Math.max(0, i - 20) + idx - 1].close) / prices[Math.max(0, i - 20) + idx - 1].close;
          return s + r * r;
        }, 0) / 20)
      : 0.015;

    const quotes = mm.quote(mid, vol);

    // Simulate random fills
    if (Math.random() < fillProbability && Math.abs(mm.inventory) < mm.maxInventory) {
      const size = Math.floor(avgTradeSize * (0.5 + Math.random()));
      if (Math.random() < 0.5) {
        // Someone sells to us (we buy at bid)
        mm.fill("buy", quotes.bidPrice, size);
      } else {
        // Someone buys from us (we sell at ask)
        mm.fill("sell", quotes.askPrice, size);
      }
    }

    equityCurve.push({ date: prices[i].date, equity: mm.getPnL(mid), inventory: mm.inventory });
  }

  return { mm, equityCurve };
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Market Making Strategy ═══\n");

  const prices = generateRealisticPrices("SPY", "2023-01-01", "2024-12-31");
  const { mm, equityCurve } = simulateMarketMaking(prices, {
    fillProbability: 0.4,
    avgTradeSize: 100,
    maxInventory: 500,
    riskAversion: 0.05,
  });

  const summary = mm.getSummary(prices[prices.length - 1].close);
  console.log("─── Market Making Results ───\n");
  console.log(`  Final P&L:       $${summary.finalPnL.toFixed(0)} (${(summary.totalReturn * 100).toFixed(2)}%)`);
  console.log(`  Total Trades:    ${summary.totalTrades}`);
  console.log(`  Avg Spread:      ${summary.avgSpreadBps.toFixed(1)} bps`);
  console.log(`  Final Inventory: ${summary.finalInventory}`);
  console.log(`  Max Inventory:   ${summary.maxInventory}`);

  // Equity curve samples
  console.log("\n─── Equity Curve ───\n");
  const step = Math.floor(equityCurve.length / 10);
  for (let i = 0; i < equityCurve.length; i += step) {
    const e = equityCurve[i];
    const pnl = e.equity - 1_000_000;
    const bar = pnl > 0 ? "▓".repeat(Math.min(20, Math.round(pnl / 500))) : "░".repeat(Math.min(20, Math.round(-pnl / 500)));
    console.log(`  ${e.date}: $${e.equity.toFixed(0).padStart(10)} inv=${String(e.inventory).padStart(4)} ${bar}`);
  }

  // A-S quote example
  console.log("\n─── Avellaneda-Stoikov Quotes (current) ───\n");
  const mid = prices[prices.length - 1].close;
  for (const inv of [-200, -100, 0, 100, 200]) {
    const q = avellanedaStoikov(mid, inv, 0.015, 1, 0.1);
    console.log(`  Inv=${String(inv).padStart(4)}: bid=$${q.bidPrice.toFixed(2)} ask=$${q.askPrice.toFixed(2)} spread=${q.spreadBps.toFixed(1)}bps adj=${q.inventoryAdjustment.toFixed(3)}`);
  }
}

if (process.argv[1]?.includes("market-making")) {
  main().catch(console.error);
}
