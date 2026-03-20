#!/usr/bin/env node
/**
 * Crypto Momentum & Mean-Reversion Strategies — Inferred Analysis
 *
 * Crypto-specific quant strategies adapted for 24/7 markets,
 * higher volatility, and wider spreads.
 *
 * Strategies:
 * 1. Cross-sectional momentum (long winners, short losers)
 * 2. RSI / Z-score mean reversion
 * 3. ATR-based breakout adapted for crypto vol
 * 4. EMA crossover trend following with vol filter
 * 5. Crypto-specific risk metrics
 * 6. Backtester with realistic crypto costs
 * 7. CryptoPortfolio combining strategies with risk overlay
 *
 * Usage:
 *   node agents/strategies/crypto-momentum.mjs
 *   import { cryptoMomentum, cryptoMeanReversion } from './crypto-momentum.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Helpers ─────────────────────────────────────────────

function closes(prices) {
  return prices.map(p => p.close);
}

function returns(prices) {
  const c = closes(prices);
  return c.slice(1).map((v, i) => (v - c[i]) / c[i]);
}

function sma(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1) { out.push(NaN); continue; }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += arr[j];
    out.push(s / n);
  }
  return out;
}

function ema(arr, n) {
  const k = 2 / (n + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    out.push(arr[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function stddev(arr, n) {
  const mu = sma(arr, n);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1 || isNaN(mu[i])) { out.push(NaN); continue; }
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (arr[j] - mu[i]) ** 2;
    out.push(Math.sqrt(ss / n));
  }
  return out;
}

function atr(prices, n = 14) {
  const out = [];
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) { out.push(prices[i].high - prices[i].low); continue; }
    const tr = Math.max(
      prices[i].high - prices[i].low,
      Math.abs(prices[i].high - prices[i - 1].close),
      Math.abs(prices[i].low - prices[i - 1].close)
    );
    out.push(tr);
  }
  return ema(out, n);
}

function rsi(prices, n = 14) {
  const c = closes(prices);
  const gains = [], losses = [];
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const avgGain = ema(gains, n);
  const avgLoss = ema(losses, n);
  const out = [NaN]; // first element has no return
  for (let i = 0; i < avgGain.length; i++) {
    if (avgLoss[i] === 0) { out.push(100); continue; }
    const rs = avgGain[i] / avgLoss[i];
    out.push(100 - 100 / (1 + rs));
  }
  return out;
}

// ─── 1. Cross-Sectional Crypto Momentum ──────────────────

/**
 * Cross-sectional momentum across crypto assets.
 * Long top performers, short bottom (or go to cash if no shorting).
 */
export function cryptoMomentum(priceArrays, options = {}) {
  const {
    lookback = 30,
    holdPeriod = 7,
    topN = 2,
    bottomN = 1,
    volTarget = 0.60,
  } = options;

  const symbols = Object.keys(priceArrays);
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));
  const signals = [];

  for (let i = lookback; i < minLen; i += holdPeriod) {
    // Rank by lookback return
    const ranked = symbols.map(sym => {
      const p = priceArrays[sym];
      const ret = (p[i].close - p[i - lookback].close) / p[i - lookback].close;
      // Annualized vol for position sizing
      const rets = [];
      for (let j = i - lookback + 1; j <= i; j++) {
        rets.push((p[j].close - p[j - 1].close) / p[j - 1].close);
      }
      const vol = Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length) * Math.sqrt(365);
      return { symbol: sym, ret, vol, date: p[i].date, price: p[i].close };
    }).sort((a, b) => b.ret - a.ret);

    const longs = ranked.slice(0, topN);
    const shorts = ranked.slice(-bottomN);

    // Vol-target position sizing
    const positions = {};
    for (const a of longs) {
      const rawWt = 1 / topN;
      positions[a.symbol] = { weight: rawWt * Math.min(1, volTarget / (a.vol || 0.5)), side: "long" };
    }
    for (const a of shorts) {
      const rawWt = 1 / bottomN;
      positions[a.symbol] = { weight: -rawWt * Math.min(1, volTarget / (a.vol || 0.5)), side: "short" };
    }

    signals.push({
      date: ranked[0].date,
      barIndex: i,
      rankings: ranked.map(r => ({ symbol: r.symbol, ret: +r.ret.toFixed(4) })),
      positions,
    });
  }
  return signals;
}

// ─── 2. Mean Reversion (RSI + Z-Score) ───────────────────

/**
 * Mean reversion on crypto using RSI and Z-score of price vs MA.
 * Contrarian: buy oversold, sell overbought.
 */
export function cryptoMeanReversion(priceArrays, options = {}) {
  const {
    rsiPeriod = 14,
    rsiOverbought = 75,
    rsiOversold = 25,
    zPeriod = 20,
    zThreshold = 2.0,
  } = options;

  const results = {};

  for (const [symbol, prices] of Object.entries(priceArrays)) {
    const c = closes(prices);
    const rsiVals = rsi(prices, rsiPeriod);
    const mu = sma(c, zPeriod);
    const sd = stddev(c, zPeriod);
    const signals = [];

    for (let i = zPeriod; i < prices.length; i++) {
      const z = isNaN(sd[i]) || sd[i] === 0 ? 0 : (c[i] - mu[i]) / sd[i];
      const r = rsiVals[i] ?? 50;

      let signal = 0;
      let reason = "neutral";

      if (r < rsiOversold && z < -zThreshold) {
        signal = 1;
        reason = "oversold (RSI + Z-score)";
      } else if (r < rsiOversold) {
        signal = 0.5;
        reason = "RSI oversold";
      } else if (r > rsiOverbought && z > zThreshold) {
        signal = -1;
        reason = "overbought (RSI + Z-score)";
      } else if (r > rsiOverbought) {
        signal = -0.5;
        reason = "RSI overbought";
      }

      if (signal !== 0) {
        signals.push({
          date: prices[i].date,
          barIndex: i,
          signal,
          rsi: +r.toFixed(1),
          zScore: +z.toFixed(2),
          reason,
        });
      }
    }
    results[symbol] = signals;
  }
  return results;
}

// ─── 3. Breakout Strategy (ATR Channels) ─────────────────

/**
 * Range breakout using ATR-scaled channels for crypto volatility.
 * 24/7 trading means ATR is computed on calendar days.
 */
export function cryptoBreakout(prices, options = {}) {
  const {
    atrPeriod = 14,
    channelMultiplier = 2.5,
    lookback = 20,
  } = options;

  const c = closes(prices);
  const atrVals = atr(prices, atrPeriod);
  const upperBand = [], lowerBand = [];

  for (let i = 0; i < prices.length; i++) {
    if (i < lookback) { upperBand.push(NaN); lowerBand.push(NaN); continue; }
    let highest = -Infinity, lowest = Infinity;
    for (let j = i - lookback; j < i; j++) {
      highest = Math.max(highest, prices[j].high);
      lowest = Math.min(lowest, prices[j].low);
    }
    const mid = (highest + lowest) / 2;
    const band = atrVals[i] * channelMultiplier;
    upperBand.push(mid + band);
    lowerBand.push(mid - band);
  }

  const signals = [];
  let position = 0; // 0 = flat, 1 = long, -1 = short

  for (let i = lookback; i < prices.length; i++) {
    const prev = position;
    if (c[i] > upperBand[i] && position <= 0) {
      position = 1;
    } else if (c[i] < lowerBand[i] && position >= 0) {
      position = -1;
    }
    if (position !== prev) {
      signals.push({
        date: prices[i].date,
        barIndex: i,
        signal: position,
        price: c[i],
        upper: +upperBand[i].toFixed(2),
        lower: +lowerBand[i].toFixed(2),
        atr: +atrVals[i].toFixed(2),
        type: position === 1 ? "breakout_long" : "breakout_short",
      });
    }
  }
  return signals;
}

// ─── 4. Trend Following (EMA Crossover + Vol Filter) ─────

/**
 * EMA crossover trend following with a volatility filter.
 * Higher vol threshold than equities — crypto needs room to breathe.
 */
export function cryptoTrendFollowing(prices, options = {}) {
  const {
    fastPeriod = 12,
    slowPeriod = 26,
    volWindow = 20,
    maxAnnualVol = 1.20,  // 120% annualized — higher than equities
    minAnnualVol = 0.15,
  } = options;

  const c = closes(prices);
  const fast = ema(c, fastPeriod);
  const slow = ema(c, slowPeriod);
  const rets = c.slice(1).map((v, i) => (v - c[i]) / c[i]);
  const rollingVol = stddev(rets, volWindow);

  const signals = [];
  let position = 0;

  for (let i = slowPeriod + 1; i < prices.length; i++) {
    const annVol = (rollingVol[i - 1] ?? 0) * Math.sqrt(365);
    const volOk = annVol >= minAnnualVol && annVol <= maxAnnualVol;

    const prev = position;
    if (fast[i] > slow[i] && volOk && position <= 0) {
      position = 1;
    } else if (fast[i] < slow[i] && position > 0) {
      position = 0;
    }
    // Force flat if vol explodes
    if (!volOk && position !== 0) {
      position = 0;
    }

    if (position !== prev) {
      signals.push({
        date: prices[i].date,
        barIndex: i,
        signal: position,
        price: c[i],
        fastEma: +fast[i].toFixed(2),
        slowEma: +slow[i].toFixed(2),
        annualizedVol: +annVol.toFixed(3),
        volFiltered: !volOk,
      });
    }
  }
  return signals;
}

// ─── 5. Crypto-Specific Risk Metrics ─────────────────────

/**
 * Compute crypto-specific risk metrics from a returns series.
 */
export function cryptoRiskMetrics(returnSeries, dates = []) {
  const n = returnSeries.length;
  if (n < 10) return { error: "Insufficient data" };

  // Basic stats
  const mean = returnSeries.reduce((s, r) => s + r, 0) / n;
  const variance = returnSeries.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const vol = Math.sqrt(variance);
  const annualizedVol = vol * Math.sqrt(365);
  const annualizedReturn = mean * 365;
  const sharpe = annualizedVol > 0 ? annualizedReturn / annualizedVol : 0;

  // Weekend vs weekday vol
  let weekdayRets = [], weekendRets = [];
  for (let i = 0; i < returnSeries.length; i++) {
    if (dates[i]) {
      const dow = new Date(dates[i]).getDay();
      if (dow === 0 || dow === 6) weekendRets.push(returnSeries[i]);
      else weekdayRets.push(returnSeries[i]);
    }
  }
  const weekdayVol = weekdayRets.length > 2
    ? Math.sqrt(weekdayRets.reduce((s, r) => s + r * r, 0) / weekdayRets.length) * Math.sqrt(365)
    : NaN;
  const weekendVol = weekendRets.length > 2
    ? Math.sqrt(weekendRets.reduce((s, r) => s + r * r, 0) / weekendRets.length) * Math.sqrt(365)
    : NaN;

  // Flash crash frequency (daily drop > 10%)
  const flashCrashes = returnSeries.filter(r => r < -0.10).length;
  const flashCrashFreq = flashCrashes / (n / 365);

  // Maximum drawdown
  let peak = 1, maxDD = 0, equity = 1;
  const ddSeries = [];
  for (const r of returnSeries) {
    equity *= (1 + r);
    peak = Math.max(peak, equity);
    const dd = (peak - equity) / peak;
    maxDD = Math.max(maxDD, dd);
    ddSeries.push(dd);
  }

  // Max hourly drawdown proxy — use worst single-day drop as stand-in
  const worstDay = Math.min(...returnSeries);
  const maxHourlyDDProxy = worstDay; // approximate: single bar worst loss

  // Tail risk: ratio of 5th percentile loss to mean loss
  const sorted = [...returnSeries].sort((a, b) => a - b);
  const p5 = sorted[Math.floor(n * 0.05)];
  const p1 = sorted[Math.floor(n * 0.01)];
  const avgLoss = returnSeries.filter(r => r < 0);
  const meanLoss = avgLoss.length > 0 ? avgLoss.reduce((s, r) => s + r, 0) / avgLoss.length : 0;
  const tailRatio = meanLoss !== 0 ? p5 / meanLoss : 0;

  // Sortino ratio
  const downside = returnSeries.filter(r => r < 0);
  const downsideVol = downside.length > 0
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / n) * Math.sqrt(365)
    : 0;
  const sortino = downsideVol > 0 ? annualizedReturn / downsideVol : 0;

  return {
    annualizedReturn: +annualizedReturn.toFixed(4),
    annualizedVol: +annualizedVol.toFixed(4),
    sharpe: +sharpe.toFixed(3),
    sortino: +sortino.toFixed(3),
    maxDrawdown: +maxDD.toFixed(4),
    weekdayVol: isNaN(weekdayVol) ? null : +weekdayVol.toFixed(4),
    weekendVol: isNaN(weekendVol) ? null : +weekendVol.toFixed(4),
    weekendVolPremium: !isNaN(weekdayVol) && weekdayVol > 0
      ? +((weekendVol / weekdayVol - 1) * 100).toFixed(1) + "%"
      : null,
    flashCrashes,
    flashCrashesPerYear: +flashCrashFreq.toFixed(2),
    maxHourlyDrawdownProxy: +(maxHourlyDDProxy * 100).toFixed(2) + "%",
    tailRisk: {
      var95: +(p5 * 100).toFixed(2) + "%",
      var99: +(p1 * 100).toFixed(2) + "%",
      tailRatio: +tailRatio.toFixed(2),
    },
    totalDays: n,
  };
}

// ─── 6. Backtest with Crypto-Appropriate Costs ───────────

/**
 * Backtest signals with higher spreads and fees typical of crypto.
 */
export function backtestCrypto(priceArrays, signals, options = {}) {
  const {
    spreadBps = 15,        // 15 bps spread (vs ~1-2 for equities)
    feePerTradeBps = 10,   // 10 bps taker fee
    slippage = 5,          // 5 bps slippage
    initialCapital = 100000,
  } = options;

  const costBps = spreadBps + feePerTradeBps + slippage;
  let capital = initialCapital;
  const equityCurve = [{ date: "start", equity: capital }];
  const trades = [];
  let prevPositions = {};

  for (const sig of signals) {
    const positions = sig.positions || {};
    const date = sig.date;
    const barIndex = sig.barIndex;

    // Calculate turnover and costs
    const allSymbols = new Set([...Object.keys(prevPositions), ...Object.keys(positions)]);
    let turnover = 0;

    for (const sym of allSymbols) {
      const prevWt = prevPositions[sym]?.weight || 0;
      const newWt = positions[sym]?.weight || 0;
      turnover += Math.abs(newWt - prevWt);
    }

    const tradeCost = capital * turnover * (costBps / 10000);

    // P&L from held positions since last signal
    let periodReturn = 0;
    for (const [sym, pos] of Object.entries(prevPositions)) {
      const pa = priceArrays[sym];
      if (!pa || !pa[barIndex] || !pa[sig.barIndex]) continue;
      const prevBar = trades.length > 0 ? trades[trades.length - 1].barIndex : barIndex;
      if (prevBar >= barIndex) continue;
      const pRet = (pa[barIndex].close - pa[prevBar].close) / pa[prevBar].close;
      periodReturn += pos.weight * pRet;
    }

    capital *= (1 + periodReturn);
    capital -= tradeCost;

    equityCurve.push({ date, equity: +capital.toFixed(2) });
    trades.push({
      date,
      barIndex,
      positions: { ...positions },
      turnover: +turnover.toFixed(4),
      costBps: +(turnover * costBps).toFixed(1),
      equity: +capital.toFixed(2),
    });

    prevPositions = positions;
  }

  // Summary stats
  const totalReturn = (capital - initialCapital) / initialCapital;
  const numPeriods = equityCurve.length - 1;
  const rets = equityCurve.slice(1).map((e, i) =>
    (e.equity - equityCurve[i].equity) / equityCurve[i].equity
  );
  const avgRet = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const retVol = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - avgRet) ** 2, 0) / rets.length)
    : 0;

  let peak = initialCapital, maxDD = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e.equity);
    maxDD = Math.max(maxDD, (peak - e.equity) / peak);
  }

  const totalCosts = trades.reduce((s, t) => s + t.costBps, 0);

  return {
    initialCapital,
    finalEquity: +capital.toFixed(2),
    totalReturn: +(totalReturn * 100).toFixed(2) + "%",
    maxDrawdown: +(maxDD * 100).toFixed(2) + "%",
    numTrades: trades.length,
    totalCostBps: +totalCosts.toFixed(1),
    avgTurnover: trades.length > 0
      ? +(trades.reduce((s, t) => s + t.turnover, 0) / trades.length).toFixed(4)
      : 0,
    equityCurve,
    trades,
  };
}

// ─── 7. CryptoPortfolio Class ────────────────────────────

/**
 * Combines multiple crypto strategies with a risk overlay.
 */
export class CryptoPortfolio {
  constructor(priceArrays, options = {}) {
    this.priceArrays = priceArrays;
    this.symbols = Object.keys(priceArrays);
    this.maxPositionSize = options.maxPositionSize || 0.35;
    this.maxPortfolioVol = options.maxPortfolioVol || 0.80;
    this.strategyWeights = options.strategyWeights || {
      momentum: 0.30,
      meanReversion: 0.25,
      breakout: 0.25,
      trendFollowing: 0.20,
    };
    this.signals = {};
    this.combinedSignals = [];
  }

  /** Run all strategies and merge signals. */
  run() {
    // Generate signals from each strategy
    this.signals.momentum = cryptoMomentum(this.priceArrays, { topN: 2, bottomN: 1, holdPeriod: 7 });
    this.signals.meanReversion = cryptoMeanReversion(this.priceArrays);
    this.signals.breakout = {};
    this.signals.trendFollowing = {};

    for (const sym of this.symbols) {
      this.signals.breakout[sym] = cryptoBreakout(this.priceArrays[sym]);
      this.signals.trendFollowing[sym] = cryptoTrendFollowing(this.priceArrays[sym]);
    }

    // Build date-indexed composite signal per symbol
    const dateSignals = {};

    // Momentum signals (already have positions)
    for (const sig of this.signals.momentum) {
      const d = sig.date;
      if (!dateSignals[d]) dateSignals[d] = {};
      for (const [sym, pos] of Object.entries(sig.positions)) {
        if (!dateSignals[d][sym]) dateSignals[d][sym] = {};
        dateSignals[d][sym].momentum = pos.weight;
      }
    }

    // Mean reversion signals
    for (const [sym, sigs] of Object.entries(this.signals.meanReversion)) {
      for (const sig of sigs) {
        const d = sig.date;
        if (!dateSignals[d]) dateSignals[d] = {};
        if (!dateSignals[d][sym]) dateSignals[d][sym] = {};
        dateSignals[d][sym].meanReversion = sig.signal;
      }
    }

    // Breakout signals
    for (const [sym, sigs] of Object.entries(this.signals.breakout)) {
      for (const sig of sigs) {
        const d = sig.date;
        if (!dateSignals[d]) dateSignals[d] = {};
        if (!dateSignals[d][sym]) dateSignals[d][sym] = {};
        dateSignals[d][sym].breakout = sig.signal;
      }
    }

    // Trend following signals
    for (const [sym, sigs] of Object.entries(this.signals.trendFollowing)) {
      for (const sig of sigs) {
        const d = sig.date;
        if (!dateSignals[d]) dateSignals[d] = {};
        if (!dateSignals[d][sym]) dateSignals[d][sym] = {};
        dateSignals[d][sym].trendFollowing = sig.signal;
      }
    }

    // Combine into weighted positions with risk limits
    const wts = this.strategyWeights;
    const dates = Object.keys(dateSignals).sort();

    for (const d of dates) {
      const positions = {};
      for (const sym of this.symbols) {
        const s = dateSignals[d]?.[sym] || {};
        let raw = (s.momentum || 0) * wts.momentum
          + (s.meanReversion || 0) * wts.meanReversion
          + (s.breakout || 0) * wts.breakout
          + (s.trendFollowing || 0) * wts.trendFollowing;

        // Clamp position size
        raw = Math.max(-this.maxPositionSize, Math.min(this.maxPositionSize, raw));
        if (Math.abs(raw) > 0.02) {
          positions[sym] = { weight: +raw.toFixed(4), side: raw > 0 ? "long" : "short" };
        }
      }

      if (Object.keys(positions).length > 0) {
        // Gross exposure check — scale down if needed
        const gross = Object.values(positions).reduce((s, p) => s + Math.abs(p.weight), 0);
        if (gross > 1.5) {
          const scale = 1.5 / gross;
          for (const p of Object.values(positions)) p.weight = +(p.weight * scale).toFixed(4);
        }
        this.combinedSignals.push({ date: d, positions });
      }
    }

    return this;
  }

  /** Backtest the combined portfolio. */
  backtest(options = {}) {
    // Map combined signals to the format backtestCrypto expects
    const sigs = this.combinedSignals.map(s => {
      // Find bar index from date
      const refSym = this.symbols[0];
      const idx = this.priceArrays[refSym].findIndex(p => p.date >= s.date);
      return { ...s, barIndex: idx >= 0 ? idx : 0 };
    }).filter(s => s.barIndex > 0);

    return backtestCrypto(this.priceArrays, sigs, options);
  }

  /** Risk metrics for each asset. */
  riskReport() {
    const report = {};
    for (const sym of this.symbols) {
      const p = this.priceArrays[sym];
      const rets = returns(p);
      const dates = p.slice(1).map(x => x.date);
      report[sym] = cryptoRiskMetrics(rets, dates);
    }
    return report;
  }

  /** Summary. */
  summary() {
    return {
      symbols: this.symbols,
      strategyWeights: this.strategyWeights,
      totalSignals: this.combinedSignals.length,
      signalsByStrategy: {
        momentum: this.signals.momentum?.length || 0,
        meanReversion: Object.values(this.signals.meanReversion || {})
          .reduce((s, a) => s + a.length, 0),
        breakout: Object.values(this.signals.breakout || {})
          .reduce((s, a) => s + a.length, 0),
        trendFollowing: Object.values(this.signals.trendFollowing || {})
          .reduce((s, a) => s + a.length, 0),
      },
    };
  }
}

// ─── CLI Demo ────────────────────────────────────────────

function demo() {
  console.log("=== Crypto Momentum & Mean-Reversion Strategy Suite ===\n");

  // Generate simulated crypto prices
  const cryptos = ["BTC", "ETH", "SOL", "AVAX"];
  const priceArrays = {};
  for (const sym of cryptos) {
    priceArrays[sym] = generateRealisticPrices(sym, "2021-01-01", "2025-12-31");
  }

  console.log("\n--- 1. Cross-Sectional Momentum ---");
  const momSignals = cryptoMomentum(priceArrays, { lookback: 30, holdPeriod: 7, topN: 2, bottomN: 1 });
  console.log(`  Generated ${momSignals.length} rebalance signals`);
  if (momSignals.length > 0) {
    const last = momSignals[momSignals.length - 1];
    console.log(`  Latest (${last.date}):`);
    console.log(`    Rankings: ${last.rankings.map(r => `${r.symbol}=${(r.ret * 100).toFixed(1)}%`).join(", ")}`);
    const pos = Object.entries(last.positions)
      .map(([s, p]) => `${s}:${(p.weight * 100).toFixed(0)}%`).join(", ");
    console.log(`    Positions: ${pos}`);
  }

  console.log("\n--- 2. Mean Reversion (RSI + Z-Score) ---");
  const mrSignals = cryptoMeanReversion(priceArrays);
  for (const [sym, sigs] of Object.entries(mrSignals)) {
    const buys = sigs.filter(s => s.signal > 0).length;
    const sells = sigs.filter(s => s.signal < 0).length;
    console.log(`  ${sym}: ${buys} buy signals, ${sells} sell signals (${sigs.length} total)`);
  }

  console.log("\n--- 3. ATR Breakout ---");
  for (const sym of cryptos) {
    const bk = cryptoBreakout(priceArrays[sym]);
    const longs = bk.filter(s => s.signal === 1).length;
    const shorts = bk.filter(s => s.signal === -1).length;
    console.log(`  ${sym}: ${longs} breakout longs, ${shorts} breakout shorts`);
  }

  console.log("\n--- 4. Trend Following (EMA + Vol Filter) ---");
  for (const sym of cryptos) {
    const tf = cryptoTrendFollowing(priceArrays[sym]);
    const entries = tf.filter(s => s.signal === 1).length;
    const exits = tf.filter(s => s.signal === 0).length;
    const filtered = tf.filter(s => s.volFiltered).length;
    console.log(`  ${sym}: ${entries} entries, ${exits} exits, ${filtered} vol-filtered`);
  }

  console.log("\n--- 5. Crypto Risk Metrics ---");
  for (const sym of cryptos) {
    const rets = returns(priceArrays[sym]);
    const dates = priceArrays[sym].slice(1).map(p => p.date);
    const risk = cryptoRiskMetrics(rets, dates);
    console.log(`  ${sym}:`);
    console.log(`    Ann. Return: ${(risk.annualizedReturn * 100).toFixed(1)}%  Vol: ${(risk.annualizedVol * 100).toFixed(1)}%`);
    console.log(`    Sharpe: ${risk.sharpe}  Sortino: ${risk.sortino}  MaxDD: ${(risk.maxDrawdown * 100).toFixed(1)}%`);
    console.log(`    Flash crashes/yr: ${risk.flashCrashesPerYear}  VaR95: ${risk.tailRisk.var95}`);
  }

  console.log("\n--- 6. Backtest (Momentum Strategy) ---");
  const bt = backtestCrypto(priceArrays, momSignals);
  console.log(`  Initial: $${bt.initialCapital.toLocaleString()}`);
  console.log(`  Final:   $${bt.finalEquity.toLocaleString()}`);
  console.log(`  Return:  ${bt.totalReturn}  MaxDD: ${bt.maxDrawdown}`);
  console.log(`  Trades:  ${bt.numTrades}  Total Cost: ${bt.totalCostBps} bps`);

  console.log("\n--- 7. Combined Portfolio ---");
  const portfolio = new CryptoPortfolio(priceArrays, {
    maxPositionSize: 0.35,
    maxPortfolioVol: 0.80,
  });
  portfolio.run();
  const summary = portfolio.summary();
  console.log(`  Symbols: ${summary.symbols.join(", ")}`);
  console.log(`  Strategy weights: ${JSON.stringify(summary.strategyWeights)}`);
  console.log(`  Signals by strategy:`);
  for (const [strat, count] of Object.entries(summary.signalsByStrategy)) {
    console.log(`    ${strat}: ${count}`);
  }
  console.log(`  Combined signals: ${summary.totalSignals}`);

  const pbt = portfolio.backtest();
  console.log(`  Portfolio backtest:`);
  console.log(`    Return: ${pbt.totalReturn}  MaxDD: ${pbt.maxDrawdown}`);
  console.log(`    Final equity: $${pbt.finalEquity.toLocaleString()}`);

  console.log("\n  Risk report:");
  const risk = portfolio.riskReport();
  for (const [sym, r] of Object.entries(risk)) {
    console.log(`    ${sym}: Sharpe=${r.sharpe} Sortino=${r.sortino} MaxDD=${(r.maxDrawdown * 100).toFixed(1)}%`);
  }

  console.log("\nDone.");
}

if (process.argv[1]?.includes("crypto-momentum")) {
  demo();
}
