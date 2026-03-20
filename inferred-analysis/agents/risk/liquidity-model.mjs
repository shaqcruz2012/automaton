#!/usr/bin/env node
/**
 * Liquidity Risk Model — Inferred Analysis
 *
 * Models liquidity risk for trading strategies:
 * 1. Amihud illiquidity ratio
 * 2. Bid-ask bounce detection
 * 3. Liquidation cost estimation
 * 4. Liquidity-adjusted VaR (LVaR)
 * 5. Capacity estimation (max capital before alpha decay)
 *
 * Usage:
 *   node agents/risk/liquidity-model.mjs
 *   import { LiquidityModel, amihudRatio } from './liquidity-model.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Amihud Illiquidity Ratio ───────────────────────────

/**
 * Amihud illiquidity = |return| / dollar_volume
 * Higher = less liquid.
 */
export function amihudRatio(prices, window = 21) {
  const values = [];

  for (let i = window; i < prices.length; i++) {
    let sumRatio = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const ret = Math.abs((prices[j].close - prices[j - 1].close) / prices[j - 1].close);
      const dollarVol = prices[j].close * prices[j].volume;
      sumRatio += dollarVol > 0 ? ret / dollarVol : 0;
    }

    values.push({
      date: prices[i].date,
      amihud: sumRatio / window,
      amihudLog: Math.log(1 + sumRatio / window),
    });
  }

  return values;
}

// ─── Roll Spread Estimator ──────────────────────────────

/**
 * Roll (1984) effective spread estimator from autocovariance of returns.
 * Spread = 2 * sqrt(-Cov(r_t, r_{t-1}))
 */
export function rollSpread(prices, window = 21) {
  const values = [];

  for (let i = window + 1; i < prices.length; i++) {
    const returns = [];
    for (let j = i - window; j <= i; j++) {
      returns.push((prices[j].close - prices[j - 1].close) / prices[j - 1].close);
    }

    // Autocovariance at lag 1
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    let autoCov = 0;
    for (let j = 1; j < returns.length; j++) {
      autoCov += (returns[j] - mean) * (returns[j - 1] - mean);
    }
    autoCov /= (returns.length - 1);

    // Roll spread (only defined when autocovariance is negative)
    const spread = autoCov < 0 ? 2 * Math.sqrt(-autoCov) : 0;

    values.push({
      date: prices[i].date,
      spread,
      spreadBps: spread * 10000,
      autoCovariance: autoCov,
    });
  }

  return values;
}

// ─── Liquidation Cost Estimation ────────────────────────

/**
 * Estimate the cost of liquidating a position.
 * Uses square-root market impact model.
 */
export function liquidationCost(positionValue, avgDailyVolume, dailyVol, daysToLiquidate = null) {
  const dollarVolume = avgDailyVolume; // assume price * volume ≈ dollar volume
  const participationRate = daysToLiquidate
    ? positionValue / (dollarVolume * daysToLiquidate)
    : 0.10; // default 10% participation

  const effectiveDays = daysToLiquidate || Math.max(1, positionValue / (dollarVolume * 0.10));

  // Square-root impact
  const impact = dailyVol * Math.sqrt(participationRate);

  // Spread cost
  const spreadCost = 0.0002; // 2 bps half-spread

  // Total cost per unit
  const totalCostPct = impact + spreadCost;
  const totalCostDollar = positionValue * totalCostPct;

  return {
    daysToLiquidate: effectiveDays,
    participationRate,
    impactCostPct: impact,
    spreadCostPct: spreadCost,
    totalCostPct,
    totalCostDollar,
    costBps: totalCostPct * 10000,
  };
}

// ─── Liquidity-Adjusted VaR ─────────────────────────────

/**
 * LVaR = VaR + Liquidation Cost
 * Accounts for the cost of unwinding positions during stress.
 */
export function liquidityAdjustedVaR(dailyReturns, positionValue, avgDailyVolume, dailyVol, confidence = 0.95) {
  const sorted = [...dailyReturns].sort((a, b) => a - b);
  const n = sorted.length;
  const idx = Math.floor(n * (1 - confidence));

  const var95 = -sorted[idx] * positionValue;

  // In stress, liquidity dries up — assume volume drops 50%
  const stressVolume = avgDailyVolume * 0.5;
  const stressVol = dailyVol * 1.5; // vol spikes in stress

  const liqCost = liquidationCost(positionValue, stressVolume, stressVol);

  return {
    standardVaR: var95,
    standardVaRPct: var95 / positionValue,
    liquidationCost: liqCost.totalCostDollar,
    liquidationCostPct: liqCost.totalCostPct,
    lvar: var95 + liqCost.totalCostDollar,
    lvarPct: (var95 + liqCost.totalCostDollar) / positionValue,
    liquidityPremium: liqCost.totalCostDollar / var95,
  };
}

// ─── Strategy Capacity Estimation ───────────────────────

/**
 * Estimate maximum capital a strategy can absorb before alpha erodes.
 * Uses the relationship: net_alpha = gross_alpha - impact_cost(capital)
 */
export function estimateCapacity(grossAlphaBps, avgDailyVolume, dailyVol, turnoverPerDay = 0.1) {
  const capacityPoints = [];
  let optimalCapital = 0;
  let maxNetAlpha = 0;

  for (let capital = 10_000; capital <= 100_000_000; capital *= 1.5) {
    const dailyTrades = capital * turnoverPerDay;
    const participationRate = dailyTrades / avgDailyVolume;
    const impactBps = dailyVol * Math.sqrt(participationRate) * 10000 * 2; // round-trip
    const netAlphaBps = grossAlphaBps - impactBps;

    capacityPoints.push({
      capital,
      grossAlphaBps,
      impactBps,
      netAlphaBps,
      participationRate,
    });

    if (netAlphaBps > maxNetAlpha) {
      maxNetAlpha = netAlphaBps;
      optimalCapital = capital;
    }

    if (netAlphaBps < 0) break; // alpha fully eroded
  }

  // Find where net alpha crosses zero (max capacity)
  const maxCapacity = capacityPoints.find(p => p.netAlphaBps < 0)?.capital || capacityPoints[capacityPoints.length - 1].capital;

  return {
    optimalCapital,
    maxCapacity,
    maxNetAlphaBps: maxNetAlpha,
    capacityCurve: capacityPoints,
  };
}

// ─── Liquidity Model Class ──────────────────────────────

export class LiquidityModel {
  constructor(prices) {
    this.prices = prices;
    this.returns = prices.slice(1).map((p, i) => (p.close - prices[i].close) / prices[i].close);
    this.avgVolume = prices.reduce((s, p) => s + p.volume, 0) / prices.length;
    this.avgPrice = prices.reduce((s, p) => s + p.close, 0) / prices.length;
    this.dailyVol = this._computeVol();
  }

  _computeVol() {
    const n = this.returns.length;
    const mean = this.returns.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(this.returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  }

  getAmihudRatio(window = 21) {
    return amihudRatio(this.prices, window);
  }

  getRollSpread(window = 21) {
    return rollSpread(this.prices, window);
  }

  getLiquidationCost(positionValue) {
    return liquidationCost(positionValue, this.avgVolume * this.avgPrice, this.dailyVol);
  }

  getLVaR(positionValue, confidence = 0.95) {
    return liquidityAdjustedVaR(this.returns, positionValue, this.avgVolume * this.avgPrice, this.dailyVol, confidence);
  }

  getCapacity(grossAlphaBps, turnover = 0.1) {
    return estimateCapacity(grossAlphaBps, this.avgVolume * this.avgPrice, this.dailyVol, turnover);
  }

  getSummary(positionValue = 1_000_000) {
    const amihud = this.getAmihudRatio();
    const roll = this.getRollSpread();
    const liqCost = this.getLiquidationCost(positionValue);
    const lvar = this.getLVaR(positionValue);

    return {
      avgDailyVolume: this.avgVolume,
      avgDollarVolume: this.avgVolume * this.avgPrice,
      dailyVol: this.dailyVol,
      annualVol: this.dailyVol * Math.sqrt(252),
      currentAmihud: amihud[amihud.length - 1]?.amihud,
      currentSpread: roll[roll.length - 1]?.spreadBps,
      liquidationCost: liqCost,
      lvar,
    };
  }
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Liquidity Risk Model ═══\n");

  const prices = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  const model = new LiquidityModel(prices);

  // Summary
  const summary = model.getSummary(1_000_000);
  console.log("─── Liquidity Summary (SPY) ───\n");
  console.log(`  Avg Daily Volume:  ${(summary.avgDailyVolume / 1e6).toFixed(1)}M shares`);
  console.log(`  Avg Dollar Volume: $${(summary.avgDollarVolume / 1e9).toFixed(2)}B`);
  console.log(`  Daily Vol:         ${(summary.dailyVol * 100).toFixed(2)}%`);
  console.log(`  Annual Vol:        ${(summary.annualVol * 100).toFixed(1)}%`);
  console.log(`  Amihud Ratio:      ${summary.currentAmihud?.toExponential(2)}`);
  console.log(`  Roll Spread:       ${summary.currentSpread?.toFixed(1)} bps`);

  // Liquidation cost
  console.log("\n─── Liquidation Cost Analysis ───\n");
  for (const size of [100_000, 500_000, 1_000_000, 5_000_000, 10_000_000]) {
    const lc = model.getLiquidationCost(size);
    console.log(
      `  $${(size / 1e6).toFixed(1).padStart(5)}M: ` +
      `${lc.costBps.toFixed(1).padStart(5)} bps ($${lc.totalCostDollar.toFixed(0).padStart(8)}) ` +
      `${lc.daysToLiquidate.toFixed(1)} days, ${(lc.participationRate * 100).toFixed(1)}% participation`
    );
  }

  // LVaR
  console.log("\n─── Liquidity-Adjusted VaR ($1M position) ───\n");
  const lvar = model.getLVaR(1_000_000);
  console.log(`  Standard VaR (95%):  $${lvar.standardVaR.toFixed(0)} (${(lvar.standardVaRPct * 100).toFixed(2)}%)`);
  console.log(`  Liquidation Cost:    $${lvar.liquidationCost.toFixed(0)} (${(lvar.liquidationCostPct * 100).toFixed(2)}%)`);
  console.log(`  LVaR:                $${lvar.lvar.toFixed(0)} (${(lvar.lvarPct * 100).toFixed(2)}%)`);
  console.log(`  Liquidity Premium:   ${(lvar.liquidityPremium * 100).toFixed(1)}%`);

  // Capacity estimation
  console.log("\n─── Strategy Capacity Estimation ───\n");
  for (const alpha of [2, 5, 10, 20]) {
    const cap = model.getCapacity(alpha, 0.1);
    console.log(
      `  Alpha=${String(alpha).padStart(2)}bps: ` +
      `optimal=$${(cap.optimalCapital / 1e6).toFixed(1)}M, ` +
      `max=$${(cap.maxCapacity / 1e6).toFixed(1)}M, ` +
      `net=${cap.maxNetAlphaBps.toFixed(1)}bps`
    );
  }

  // Amihud time series
  console.log("\n─── Amihud Illiquidity (Rolling 21d) ───\n");
  const amihud = model.getAmihudRatio(21);
  const step = Math.floor(amihud.length / 8);
  for (let i = 0; i < amihud.length; i += step) {
    const a = amihud[i];
    const bar = "█".repeat(Math.min(30, Math.round(a.amihudLog * 50)));
    console.log(`  ${a.date}: ${a.amihud.toExponential(2)} ${bar}`);
  }
}

if (process.argv[1]?.includes("liquidity-model")) {
  main().catch(console.error);
}
