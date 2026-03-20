#!/usr/bin/env node
/**
 * FX Carry Strategy — Inferred Analysis
 *
 * Multi-currency/FX support and carry-based strategies for foreign exchange:
 * 1. FXRateManager  — currency conversion, cross rates, triangular arbitrage
 * 2. FX Carry       — borrow low-yield, invest high-yield currencies
 * 3. FX Momentum    — trend following on currency pairs
 * 4. FX Value       — mean reversion toward PPP fair value
 * 5. Combined FX    — carry + momentum + value ensemble
 * 6. FX Risk        — overnight gaps, weekend risk, carry-to-risk ratio
 * 7. FX Backtest    — P&L with proper pip-based accounting
 *
 * Usage:
 *   node agents/strategies/fx-carry.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── FX Rate Manager ────────────────────────────────────

/**
 * Manages FX spot rates, cross-rate computation, and triangular arbitrage detection.
 */
export class FXRateManager {
  /**
   * @param {string} baseCurrency — home currency for quoting (default "USD")
   */
  constructor(baseCurrency = "USD") {
    /** @type {string} */
    this.baseCurrency = baseCurrency;
    /** @type {Map<string, {rate: number, date: string}[]>} pair -> history */
    this.rates = new Map();
    /** @type {Set<string>} all known currencies */
    this.currencies = new Set([baseCurrency]);
  }

  /**
   * Add a spot rate observation.
   * @param {string} pair  — e.g. "EUR/USD"
   * @param {number} rate  — spot price
   * @param {string} date  — ISO date
   */
  addRate(pair, rate, date) {
    const [base, quote] = pair.split("/");
    this.currencies.add(base);
    this.currencies.add(quote);
    if (!this.rates.has(pair)) this.rates.set(pair, []);
    this.rates.get(pair).push({ rate, date });
  }

  /**
   * Look up the latest rate for a direct pair, optionally on a specific date.
   * @param {string} pair
   * @param {string} [date]
   * @returns {number|null}
   */
  _directRate(pair, date) {
    const history = this.rates.get(pair);
    if (!history || history.length === 0) return null;
    if (date) {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].date <= date) return history[i].rate;
      }
      return null;
    }
    return history[history.length - 1].rate;
  }

  /**
   * Convert an amount between two currencies, using cross rates when necessary.
   * @param {number} amount
   * @param {string} from  — source currency code
   * @param {string} to    — target currency code
   * @param {string} [date]
   * @returns {number}
   */
  convert(amount, from, to, date) {
    if (from === to) return amount;

    // Try direct pair
    const direct = this._directRate(`${from}/${to}`, date);
    if (direct !== null) return amount * direct;

    // Try inverse
    const inverse = this._directRate(`${to}/${from}`, date);
    if (inverse !== null) return amount / inverse;

    // Try cross through each known currency
    for (const mid of this.currencies) {
      if (mid === from || mid === to) continue;
      const leg1 = this._directRate(`${from}/${mid}`, date) ?? (1 / (this._directRate(`${mid}/${from}`, date) ?? NaN));
      const leg2 = this._directRate(`${mid}/${to}`, date) ?? (1 / (this._directRate(`${to}/${mid}`, date) ?? NaN));
      if (isFinite(leg1) && isFinite(leg2)) {
        return amount * leg1 * leg2;
      }
    }
    throw new Error(`No rate path found for ${from}->${to}`);
  }

  /**
   * Compute the cross rate between two pairs sharing a common currency.
   * @param {string} pair1 — e.g. "EUR/USD"
   * @param {string} pair2 — e.g. "GBP/USD"
   * @returns {{pair: string, rate: number}}
   */
  getCrossRate(pair1, pair2) {
    const [b1, q1] = pair1.split("/");
    const [b2, q2] = pair2.split("/");
    const r1 = this._directRate(pair1);
    const r2 = this._directRate(pair2);
    if (r1 === null || r2 === null) throw new Error("Missing rate data");

    if (q1 === q2) {
      // EUR/USD & GBP/USD -> EUR/GBP = r1 / r2
      return { pair: `${b1}/${b2}`, rate: r1 / r2 };
    }
    if (b1 === b2) {
      // USD/EUR & USD/GBP -> EUR/GBP = r2 / r1
      return { pair: `${q1}/${q2}`, rate: r2 / r1 };
    }
    if (q1 === b2) {
      // EUR/GBP & GBP/USD -> EUR/USD = r1 * r2
      return { pair: `${b1}/${q2}`, rate: r1 * r2 };
    }
    if (b1 === q2) {
      // GBP/USD & EUR/GBP -> EUR/USD = r2 * r1
      return { pair: `${b2}/${q1}`, rate: r2 * r1 };
    }
    throw new Error(`No common currency between ${pair1} and ${pair2}`);
  }

  /**
   * Detect triangular arbitrage opportunities across all known currency triplets.
   * @param {number} [threshold=0.001] — minimum profit ratio to flag
   * @returns {{path: string[], impliedRate: number, profit: number}[]}
   */
  getTriangularArbitrage(threshold = 0.001) {
    const ccys = [...this.currencies];
    const opps = [];

    for (let i = 0; i < ccys.length; i++) {
      for (let j = i + 1; j < ccys.length; j++) {
        for (let k = j + 1; k < ccys.length; k++) {
          const [a, b, c] = [ccys[i], ccys[j], ccys[k]];
          try {
            const ab = this.convert(1, a, b);
            const bc = this.convert(1, b, c);
            const ca = this.convert(1, c, a);
            const product = ab * bc * ca;
            const profit = product - 1;
            if (Math.abs(profit) > threshold) {
              opps.push({
                path: profit > 0 ? [a, b, c, a] : [a, c, b, a],
                impliedRate: product,
                profit: Math.abs(profit),
              });
            }
          } catch { /* no path, skip */ }
        }
      }
    }

    return opps.sort((a, b) => b.profit - a.profit);
  }
}

// ─── Strategy Helpers ───────────────────────────────────

/**
 * Compute simple returns from a price array.
 * @param {{close: number}[]} prices
 * @returns {number[]}
 */
function computeReturns(prices) {
  const ret = [];
  for (let i = 1; i < prices.length; i++) {
    ret.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
  }
  return ret;
}

/**
 * Rolling mean of an array.
 * @param {number[]} arr
 * @param {number} window
 * @returns {number[]}
 */
function rollingMean(arr, window) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= window) sum -= arr[i - window];
    if (i >= window - 1) out.push(sum / window);
  }
  return out;
}

/**
 * Standard deviation of an array.
 * @param {number[]} arr
 * @returns {number}
 */
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// ─── FX Carry Strategy ─────────────────────────────────

/**
 * FX carry strategy: borrow low-yield currencies, invest in high-yield.
 *
 * @param {Object<string, {close: number, date: string}[]>} rateHistories — pair -> price array
 * @param {Object<string, number>} yieldDifferentials — pair -> annualised yield spread (e.g. 0.04 = 4%)
 * @param {{topN?: number, rebalanceDays?: number, maxPosition?: number}} options
 * @returns {{date: string, allocation: Object<string, number>, carryRank: string[]}[]}
 */
export function fxCarryStrategy(rateHistories, yieldDifferentials, options = {}) {
  const { topN = 3, rebalanceDays = 21, maxPosition = 0.35 } = options;
  const pairs = Object.keys(rateHistories);
  const minLen = Math.min(...pairs.map(p => rateHistories[p].length));
  const signals = [];

  for (let i = 1; i < minLen; i++) {
    if (i % rebalanceDays !== 0 && signals.length > 0) {
      signals.push({ ...signals[signals.length - 1], date: rateHistories[pairs[0]][i].date });
      continue;
    }

    // Rank by yield differential adjusted for recent volatility
    const ranked = pairs.map(pair => {
      const prices = rateHistories[pair];
      const ret = [];
      const window = Math.min(63, i);
      for (let j = Math.max(1, i - window); j <= i; j++) {
        ret.push((prices[j].close - prices[j - 1].close) / prices[j - 1].close);
      }
      const vol = stddev(ret) * Math.sqrt(252) || 0.01;
      const yieldSpread = yieldDifferentials[pair] || 0;
      const carryToRisk = yieldSpread / vol;
      return { pair, yieldSpread, vol, carryToRisk };
    }).sort((a, b) => b.carryToRisk - a.carryToRisk);

    const allocation = {};
    pairs.forEach(p => { allocation[p] = 0; });

    // Long the topN highest carry-to-risk pairs
    const selected = ranked.slice(0, topN);
    const totalScore = selected.reduce((s, r) => s + Math.max(0, r.carryToRisk), 0) || 1;
    for (const r of selected) {
      const weight = Math.max(0, r.carryToRisk) / totalScore;
      allocation[r.pair] = Math.min(weight, maxPosition);
    }

    // Short the lowest carry-to-risk pair
    const worst = ranked[ranked.length - 1];
    allocation[worst.pair] = -Math.min(1 / topN, maxPosition);

    signals.push({
      date: rateHistories[pairs[0]][i].date,
      allocation,
      carryRank: ranked.map(r => `${r.pair} c2r=${r.carryToRisk.toFixed(2)}`),
    });
  }

  return signals;
}

// ─── FX Momentum Strategy ───────────────────────────────

/**
 * Trend-following on FX pairs using dual moving-average crossover + momentum.
 *
 * @param {Object<string, {close: number, date: string}[]>} rateHistories
 * @param {number} lookback — momentum lookback in days (default 63)
 * @returns {{date: string, allocation: Object<string, number>, momentum: Object<string, number>}[]}
 */
export function fxMomentumStrategy(rateHistories, lookback = 63) {
  const pairs = Object.keys(rateHistories);
  const minLen = Math.min(...pairs.map(p => rateHistories[p].length));
  const signals = [];

  for (let i = lookback; i < minLen; i++) {
    const scores = pairs.map(pair => {
      const prices = rateHistories[pair];
      const momReturn = (prices[i].close - prices[i - lookback].close) / prices[i - lookback].close;

      // Short MA vs long MA crossover signal
      let shortMA = 0, longMA = 0;
      for (let j = i - 9; j <= i; j++) shortMA += prices[j].close;
      shortMA /= 10;
      for (let j = i - lookback; j <= i; j++) longMA += prices[j].close;
      longMA /= (lookback + 1);

      const trend = shortMA > longMA ? 1 : -1;
      const strength = Math.abs(momReturn);
      return { pair, momReturn, trend, strength, score: trend * strength };
    }).sort((a, b) => b.score - a.score);

    const allocation = {};
    const half = Math.ceil(scores.length / 2);
    for (let j = 0; j < scores.length; j++) {
      const s = scores[j];
      allocation[s.pair] = j < half ? (1 / half) * s.trend : 0;
    }

    const momentum = {};
    scores.forEach(s => { momentum[s.pair] = s.momReturn; });

    signals.push({
      date: rateHistories[pairs[0]][i].date,
      allocation,
      momentum,
    });
  }

  return signals;
}

// ─── FX Value Strategy ──────────────────────────────────

/**
 * Mean-reversion toward purchasing-power-parity (PPP) fair value.
 *
 * @param {Object<string, {close: number, date: string}[]>} rateHistories
 * @param {Object<string, number>} pppRates — pair -> PPP-implied fair value
 * @returns {{date: string, allocation: Object<string, number>, misvaluation: Object<string, number>}[]}
 */
export function fxValueStrategy(rateHistories, pppRates) {
  const pairs = Object.keys(rateHistories);
  const minLen = Math.min(...pairs.map(p => rateHistories[p].length));
  const signals = [];

  for (let i = 0; i < minLen; i++) {
    const valuations = pairs.map(pair => {
      const spot = rateHistories[pair][i].close;
      const fairValue = pppRates[pair] || spot;
      const misval = (fairValue - spot) / spot; // positive = undervalued, expect appreciation
      return { pair, spot, fairValue, misval };
    }).sort((a, b) => b.misval - a.misval);

    const allocation = {};
    // Go long the most undervalued, short the most overvalued
    for (let j = 0; j < valuations.length; j++) {
      const v = valuations[j];
      if (j < Math.ceil(valuations.length / 3)) {
        allocation[v.pair] = 1 / Math.ceil(valuations.length / 3);
      } else if (j >= valuations.length - Math.floor(valuations.length / 3)) {
        allocation[v.pair] = -1 / Math.max(1, Math.floor(valuations.length / 3));
      } else {
        allocation[v.pair] = 0;
      }
    }

    const misvaluation = {};
    valuations.forEach(v => { misvaluation[v.pair] = v.misval; });

    signals.push({
      date: rateHistories[pairs[0]][i].date,
      allocation,
      misvaluation,
    });
  }

  return signals;
}

// ─── Combined FX Strategy ───────────────────────────────

/**
 * Ensemble of carry + momentum + value with configurable weights.
 *
 * @param {Object<string, {close: number, date: string}[]>} rateHistories
 * @param {Object<string, number>} yields — pair -> yield differential
 * @param {Object<string, number>} pppRates — pair -> PPP fair value
 * @param {{carryW?: number, momW?: number, valW?: number, lookback?: number}} options
 * @returns {{date: string, allocation: Object<string, number>, components: Object}[]}
 */
export function combinedFXStrategy(rateHistories, yields, pppRates, options = {}) {
  const { carryW = 0.4, momW = 0.35, valW = 0.25, lookback = 63 } = options;
  const pairs = Object.keys(rateHistories);
  const minLen = Math.min(...pairs.map(p => rateHistories[p].length));
  const signals = [];

  for (let i = lookback; i < minLen; i++) {
    const scores = pairs.map(pair => {
      const prices = rateHistories[pair];

      // Carry component
      const vol = (() => {
        const ret = [];
        for (let j = Math.max(1, i - 63); j <= i; j++) {
          ret.push((prices[j].close - prices[j - 1].close) / prices[j - 1].close);
        }
        return stddev(ret) * Math.sqrt(252) || 0.01;
      })();
      const yieldSpread = yields[pair] || 0;
      const carryScore = yieldSpread / vol;

      // Momentum component
      const momReturn = (prices[i].close - prices[i - lookback].close) / prices[i - lookback].close;

      // Value component
      const fairValue = pppRates[pair] || prices[i].close;
      const valueScore = (fairValue - prices[i].close) / prices[i].close;

      const combined = carryW * carryScore + momW * momReturn + valW * valueScore;

      return { pair, carryScore, momReturn, valueScore, combined };
    }).sort((a, b) => b.combined - a.combined);

    const allocation = {};
    const topN = Math.ceil(pairs.length / 2);
    for (let j = 0; j < scores.length; j++) {
      allocation[scores[j].pair] = j < topN ? 1 / topN : (j >= scores.length - 1 ? -0.2 : 0);
    }

    signals.push({
      date: rateHistories[pairs[0]][i].date,
      allocation,
      components: {
        carry: Object.fromEntries(scores.map(s => [s.pair, s.carryScore])),
        momentum: Object.fromEntries(scores.map(s => [s.pair, s.momReturn])),
        value: Object.fromEntries(scores.map(s => [s.pair, s.valueScore])),
      },
    });
  }

  return signals;
}

// ─── FX Risk Metrics ────────────────────────────────────

/**
 * Compute FX-specific risk metrics from daily return series.
 *
 * @param {Object<string, number[]>} returns — pair -> daily return array
 * @returns {Object<string, {annualVol: number, maxOvernightGap: number, weekendGapRisk: number, carryToRisk: number, maxDD: number, skew: number, kurtosis: number}>}
 */
export function fxRiskMetrics(returns) {
  const results = {};

  for (const [pair, ret] of Object.entries(returns)) {
    const n = ret.length;
    if (n < 10) { results[pair] = null; continue; }

    const mean = ret.reduce((a, b) => a + b, 0) / n;
    const vol = stddev(ret);
    const annualVol = vol * Math.sqrt(252);

    // Max overnight gap (absolute)
    let maxGap = 0;
    for (const r of ret) {
      if (Math.abs(r) > maxGap) maxGap = Math.abs(r);
    }

    // Weekend gap risk — every 5th day as proxy for Monday opens
    const weekendGaps = [];
    for (let i = 4; i < n; i += 5) {
      weekendGaps.push(Math.abs(ret[i]));
    }
    const weekendGapRisk = weekendGaps.length > 0
      ? weekendGaps.reduce((a, b) => a + b, 0) / weekendGaps.length
      : 0;

    // Carry-to-risk (annualised mean return / vol)
    const annualReturn = mean * 252;
    const carryToRisk = annualVol > 0 ? annualReturn / annualVol : 0;

    // Max drawdown
    let equity = 1, peak = 1, maxDD = 0;
    for (const r of ret) {
      equity *= (1 + r);
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    // Skewness
    const m3 = ret.reduce((s, r) => s + ((r - mean) / vol) ** 3, 0) / n;

    // Excess kurtosis
    const m4 = ret.reduce((s, r) => s + ((r - mean) / vol) ** 4, 0) / n - 3;

    results[pair] = {
      annualVol: +annualVol.toFixed(4),
      maxOvernightGap: +maxGap.toFixed(6),
      weekendGapRisk: +weekendGapRisk.toFixed(6),
      carryToRisk: +carryToRisk.toFixed(3),
      maxDD: +maxDD.toFixed(4),
      skew: +m3.toFixed(3),
      kurtosis: +m4.toFixed(3),
    };
  }

  return results;
}

// ─── FX Backtest ────────────────────────────────────────

/**
 * Backtest FX strategy signals with proper P&L accounting.
 *
 * @param {Object<string, {close: number, date: string}[]>} rateHistories
 * @param {{date: string, allocation: Object<string, number>}[]} signals
 * @param {{startEquity?: number, slippageBps?: number}} options
 * @returns {{totalReturn: number, sharpe: number, maxDD: number, calmar: number, trades: number, equityCurve: {date: string, equity: number}[]}}
 */
export function backtestFX(rateHistories, signals, options = {}) {
  const { startEquity = 1_000_000, slippageBps = 2 } = options;
  const pairs = Object.keys(rateHistories);
  let equity = startEquity;
  let peak = equity;
  let maxDD = 0;
  const dailyReturns = [];
  const equityCurve = [];
  let trades = 0;
  let prevAllocation = {};

  for (const sig of signals) {
    let dayReturn = 0;

    for (const pair of pairs) {
      const idx = rateHistories[pair].findIndex(p => p.date === sig.date);
      if (idx < 1) continue;

      const pxReturn = (rateHistories[pair][idx].close - rateHistories[pair][idx - 1].close)
        / rateHistories[pair][idx - 1].close;
      const weight = sig.allocation[pair] || 0;
      dayReturn += weight * pxReturn;

      // Count rebalance trades
      const prevW = prevAllocation[pair] || 0;
      if (Math.abs(weight - prevW) > 0.01) trades++;

      // Slippage on weight changes
      dayReturn -= Math.abs(weight - prevW) * (slippageBps / 10000);
    }

    equity *= (1 + dayReturn);
    dailyReturns.push(dayReturn);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;

    equityCurve.push({ date: sig.date, equity: +equity.toFixed(2) });
    prevAllocation = { ...sig.allocation };
  }

  const n = dailyReturns.length;
  const mean = n > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / n : 0;
  const vol = stddev(dailyReturns);
  const annReturn = mean * 252;
  const sharpe = vol > 0 ? (mean / vol) * Math.sqrt(252) : 0;
  const calmar = maxDD > 0 ? annReturn / maxDD : 0;

  return {
    totalReturn: +((equity - startEquity) / startEquity).toFixed(4),
    annReturn: +(annReturn * 100).toFixed(2),
    sharpe: +sharpe.toFixed(3),
    maxDD: +maxDD.toFixed(4),
    calmar: +calmar.toFixed(3),
    trades,
    equityCurve,
  };
}

// ─── CLI Demo ───────────────────────────────────────────

/**
 * Demonstrate FX strategies with simulated major-pair rate data.
 */
async function main() {
  console.log("═══ FX Carry & Multi-Currency Strategies ═══\n");

  // Major FX pairs — use generateRealisticPrices with pair tickers as proxy
  const pairMap = {
    "EUR/USD": "EURUSD",
    "GBP/USD": "GBPUSD",
    "USD/JPY": "USDJPY",
    "AUD/USD": "AUDUSD",
    "USD/CHF": "USDCHF",
    "NZD/USD": "NZDUSD",
  };

  const rateHistories = {};
  for (const [pair, ticker] of Object.entries(pairMap)) {
    const raw = generateRealisticPrices(ticker, "2020-01-01", "2025-06-01");
    // Normalise to realistic FX levels
    const scale = pair.includes("JPY") ? 110 / raw[0].close : 1.1 / raw[0].close;
    rateHistories[pair] = raw.map(p => ({
      date: p.date,
      open: p.open * scale,
      high: p.high * scale,
      low: p.low * scale,
      close: p.close * scale,
      volume: p.volume,
    }));
  }

  const pairs = Object.keys(rateHistories);

  // ── FXRateManager demo ──
  console.log("─── FX Rate Manager ───");
  const mgr = new FXRateManager("USD");
  for (const pair of pairs) {
    const latest = rateHistories[pair][rateHistories[pair].length - 1];
    mgr.addRate(pair, latest.close, latest.date);
  }
  console.log(`  Currencies: ${[...mgr.currencies].join(", ")}`);
  console.log(`  EUR->GBP: ${mgr.convert(1, "EUR", "GBP").toFixed(4)}`);
  console.log(`  AUD->JPY: ${mgr.convert(1, "AUD", "JPY").toFixed(2)}`);

  const arbOpps = mgr.getTriangularArbitrage(0.0005);
  console.log(`  Triangular arb opportunities: ${arbOpps.length}`);
  for (const opp of arbOpps.slice(0, 3)) {
    console.log(`    ${opp.path.join("->")}  profit=${(opp.profit * 100).toFixed(3)}%`);
  }

  // ── Yield differentials (annualised, synthetic) ──
  const yields = {
    "EUR/USD": -0.015,
    "GBP/USD": 0.01,
    "USD/JPY": 0.045,
    "AUD/USD": 0.025,
    "USD/CHF": -0.02,
    "NZD/USD": 0.03,
  };

  // ── PPP fair values ──
  const pppRates = {
    "EUR/USD": 1.25,
    "GBP/USD": 1.50,
    "USD/JPY": 95.0,
    "AUD/USD": 0.72,
    "USD/CHF": 0.95,
    "NZD/USD": 0.68,
  };

  // ── FX Carry Strategy ──
  console.log("\n─── FX Carry Strategy ───");
  const carrySignals = fxCarryStrategy(rateHistories, yields, { topN: 3, rebalanceDays: 21 });
  const carryBT = backtestFX(rateHistories, carrySignals);
  console.log(`  Return: ${(carryBT.totalReturn * 100).toFixed(2)}%  Ann: ${carryBT.annReturn}%  Sharpe: ${carryBT.sharpe}  MaxDD: ${(carryBT.maxDD * 100).toFixed(1)}%  Calmar: ${carryBT.calmar}`);
  if (carrySignals.length > 0) {
    console.log(`  Latest carry rank: ${carrySignals[carrySignals.length - 1].carryRank.join(" | ")}`);
  }

  // ── FX Momentum Strategy ──
  console.log("\n─── FX Momentum Strategy ───");
  const momSignals = fxMomentumStrategy(rateHistories, 63);
  const momBT = backtestFX(rateHistories, momSignals);
  console.log(`  Return: ${(momBT.totalReturn * 100).toFixed(2)}%  Ann: ${momBT.annReturn}%  Sharpe: ${momBT.sharpe}  MaxDD: ${(momBT.maxDD * 100).toFixed(1)}%  Calmar: ${momBT.calmar}`);

  // ── FX Value Strategy ──
  console.log("\n─── FX Value Strategy ───");
  const valSignals = fxValueStrategy(rateHistories, pppRates);
  const valBT = backtestFX(rateHistories, valSignals);
  console.log(`  Return: ${(valBT.totalReturn * 100).toFixed(2)}%  Ann: ${valBT.annReturn}%  Sharpe: ${valBT.sharpe}  MaxDD: ${(valBT.maxDD * 100).toFixed(1)}%  Calmar: ${valBT.calmar}`);

  // ── Combined FX Strategy ──
  console.log("\n─── Combined FX (Carry+Mom+Value) ───");
  const comboSignals = combinedFXStrategy(rateHistories, yields, pppRates, {
    carryW: 0.4, momW: 0.35, valW: 0.25,
  });
  const comboBT = backtestFX(rateHistories, comboSignals);
  console.log(`  Return: ${(comboBT.totalReturn * 100).toFixed(2)}%  Ann: ${comboBT.annReturn}%  Sharpe: ${comboBT.sharpe}  MaxDD: ${(comboBT.maxDD * 100).toFixed(1)}%  Calmar: ${comboBT.calmar}`);

  // ── FX Risk Metrics ──
  console.log("\n─── FX Risk Metrics ───");
  const returnsByPair = {};
  for (const pair of pairs) {
    returnsByPair[pair] = computeReturns(rateHistories[pair]);
  }
  const riskMetrics = fxRiskMetrics(returnsByPair);
  console.log(`  ${"Pair".padEnd(10)} ${"AnnVol".padStart(8)} ${"MaxGap".padStart(8)} ${"WkndRisk".padStart(9)} ${"C2R".padStart(6)} ${"MaxDD".padStart(7)} ${"Skew".padStart(6)} ${"Kurt".padStart(6)}`);
  for (const [pair, m] of Object.entries(riskMetrics)) {
    if (!m) continue;
    console.log(`  ${pair.padEnd(10)} ${(m.annualVol * 100).toFixed(1).padStart(7)}% ${(m.maxOvernightGap * 100).toFixed(2).padStart(7)}% ${(m.weekendGapRisk * 100).toFixed(3).padStart(8)}% ${m.carryToRisk.toFixed(2).padStart(6)} ${(m.maxDD * 100).toFixed(1).padStart(6)}% ${m.skew.toFixed(2).padStart(6)} ${m.kurtosis.toFixed(1).padStart(6)}`);
  }

  // ── Strategy comparison ──
  console.log("\n─── Strategy Comparison ───");
  const strategies = [
    { name: "Carry", bt: carryBT },
    { name: "Momentum", bt: momBT },
    { name: "Value", bt: valBT },
    { name: "Combined", bt: comboBT },
  ];
  console.log(`  ${"Strategy".padEnd(12)} ${"Return".padStart(8)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(8)} ${"Calmar".padStart(8)} ${"Trades".padStart(8)}`);
  for (const s of strategies) {
    console.log(`  ${s.name.padEnd(12)} ${(s.bt.totalReturn * 100).toFixed(1).padStart(7)}% ${s.bt.sharpe.toFixed(3).padStart(8)} ${(s.bt.maxDD * 100).toFixed(1).padStart(7)}% ${s.bt.calmar.toFixed(2).padStart(8)} ${String(s.bt.trades).padStart(8)}`);
  }

  console.log("\nDone.");
}

if (process.argv[1]?.includes("fx-carry")) {
  main().catch(console.error);
}
