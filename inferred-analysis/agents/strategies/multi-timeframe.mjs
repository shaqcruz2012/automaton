#!/usr/bin/env node
/**
 * Multi-Timeframe Signal Alignment Strategy
 *
 * Aggregates daily bars into weekly and monthly timeframes,
 * runs independent signal generation on each, then aligns
 * signals across timeframes for higher-conviction entries.
 *
 * Monthly determines allowed direction, weekly filters trend,
 * daily provides entry timing.
 *
 * Usage:
 *   node agents/strategies/multi-timeframe.mjs --symbol SPY
 *   node agents/strategies/multi-timeframe.mjs --symbol QQQ --strategy momentum
 */

import { generateRealisticPrices } from "../data/fetch.mjs";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI Parsing ─────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    symbol: "SPY",
    strategy: "momentum",
    startDate: "2020-01-01",
    endDate: "2025-03-01",
    initialCapital: 1_000_000,
    transactionCostBps: 10,
    slippageBps: 5,
    positionSize: 0.10,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbol" && args[i + 1]) opts.symbol = args[++i].toUpperCase();
    if (args[i] === "--strategy" && args[i + 1]) opts.strategy = args[++i].toLowerCase();
    if (args[i] === "--start" && args[i + 1]) opts.startDate = args[++i];
    if (args[i] === "--end" && args[i + 1]) opts.endDate = args[++i];
  }
  return opts;
}

const OPTS = parseArgs();

// ─── Data Loading ────────────────────────────────────────

function loadPrices(symbol, startDate, endDate) {
  // Try cached real data first
  const cachePath = join(__dirname, "..", "data", "cache", `${symbol}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    console.log(`Data: ${symbol} (real) -- ${cached.count} days`);
    return cached.prices;
  }
  // Fall back to realistic synthetic
  const prices = generateRealisticPrices(symbol, startDate, endDate);
  console.log(`Data: ${symbol} (synthetic) -- ${prices.length} days`);
  return prices;
}

// ─── Timeframe Aggregation ───────────────────────────────

/**
 * Aggregate daily bars into larger timeframe bars.
 * @param {Array} dailyBars - Array of {date, open, high, low, close, volume}
 * @param {number} period   - Number of daily bars per aggregated bar
 * @returns {Array} Aggregated bars
 */
function aggregateBars(dailyBars, period) {
  const result = [];
  for (let i = 0; i <= dailyBars.length - period; i += period) {
    const chunk = dailyBars.slice(i, i + period);
    result.push({
      date: chunk[chunk.length - 1].date,
      dateStart: chunk[0].date,
      open: chunk[0].open,
      high: Math.max(...chunk.map(b => b.high)),
      low: Math.min(...chunk.map(b => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

function createTimeframes(dailyBars) {
  return {
    daily: dailyBars,
    weekly: aggregateBars(dailyBars, 5),
    monthly: aggregateBars(dailyBars, 21),
  };
}

// ─── Signal Generation per Timeframe ─────────────────────

/**
 * Momentum signal: go long when price is above its lookback high,
 * short when below its lookback low.
 */
function momentumSignal(bars, lookback) {
  const signals = [];
  for (let i = lookback; i < bars.length; i++) {
    const current = bars[i].close;
    const past = bars[i - lookback].close;
    const ret = (current - past) / past;

    let signal = 0;
    if (ret > 0.02) signal = 1;
    if (ret < -0.02) signal = -1;

    signals.push({ date: bars[i].date, signal, price: current });
  }
  return signals;
}

/**
 * Mean-reversion signal: buy oversold, sell overbought
 * using a simple z-score of returns.
 */
function meanReversionSignal(bars, lookback) {
  const signals = [];
  for (let i = lookback; i < bars.length; i++) {
    const window = bars.slice(i - lookback, i);
    const returns = window.map((b, j) =>
      j > 0 ? (b.close - window[j - 1].close) / window[j - 1].close : 0
    ).slice(1);

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);

    const currentRet = (bars[i].close - bars[i - 1].close) / bars[i - 1].close;
    const z = std > 0 ? (currentRet - mean) / std : 0;

    let signal = 0;
    if (z < -1.5) signal = 1;   // oversold -> buy
    if (z > 1.5) signal = -1;   // overbought -> sell

    signals.push({ date: bars[i].date, signal, price: bars[i].close });
  }
  return signals;
}

/**
 * Trend-following signal using dual moving average crossover.
 */
function trendSignal(bars, fastPeriod, slowPeriod) {
  const signals = [];
  for (let i = slowPeriod; i < bars.length; i++) {
    const fastMA = bars.slice(i - fastPeriod, i).reduce((s, b) => s + b.close, 0) / fastPeriod;
    const slowMA = bars.slice(i - slowPeriod, i).reduce((s, b) => s + b.close, 0) / slowPeriod;

    let signal = 0;
    if (fastMA > slowMA * 1.005) signal = 1;
    if (fastMA < slowMA * 0.995) signal = -1;

    signals.push({ date: bars[i].date, signal, price: bars[i].close });
  }
  return signals;
}

/**
 * Generate signals for a given timeframe using strategy-appropriate logic.
 */
function generateTimeframeSignals(bars, timeframe, strategy) {
  switch (timeframe) {
    case "daily":
      if (strategy === "mean-reversion") return meanReversionSignal(bars, 14);
      return momentumSignal(bars, 10);
    case "weekly":
      return trendSignal(bars, 4, 12);
    case "monthly":
      return trendSignal(bars, 3, 8);
    default:
      return momentumSignal(bars, 10);
  }
}

// ─── Signal Alignment ────────────────────────────────────

/**
 * Build a date-keyed lookup from a signal array.
 * For weekly/monthly signals, each signal covers a range of daily dates.
 */
function buildSignalMap(signals) {
  const map = new Map();
  for (const s of signals) {
    map.set(s.date, s.signal);
  }
  return map;
}

/**
 * Expand lower-frequency signals to daily dates.
 * Each aggregated bar's signal applies from its start date through its end date.
 */
function expandSignalsToDailyDates(aggregatedBars, signals, dailyDates) {
  const expanded = new Map();

  // Create a lookup from aggregated bar end-date -> signal
  const sigMap = buildSignalMap(signals);

  // For each aggregated bar, find its date range and apply its signal
  let sigIdx = 0;
  for (const bar of aggregatedBars) {
    const sig = sigMap.get(bar.date) || 0;
    // Apply this signal to all daily dates in [dateStart, date]
    for (const dd of dailyDates) {
      if (dd >= bar.dateStart && dd <= bar.date) {
        expanded.set(dd, sig);
      }
    }
  }

  return expanded;
}

/**
 * Align signals across all three timeframes.
 * Returns daily-granularity signals with confidence scores.
 */
function alignSignals(dailyBars, timeframes, strategy) {
  // Generate signals for each timeframe
  const dailySignals = generateTimeframeSignals(timeframes.daily, "daily", strategy);
  const weeklySignals = generateTimeframeSignals(timeframes.weekly, "weekly", strategy);
  const monthlySignals = generateTimeframeSignals(timeframes.monthly, "monthly", strategy);

  // Build daily-date list
  const dailyDates = dailyBars.map(b => b.date);

  // Expand weekly and monthly signals to daily dates
  const dailySigMap = buildSignalMap(dailySignals);
  const weeklySigMap = expandSignalsToDailyDates(timeframes.weekly, weeklySignals, dailyDates);
  const monthlySigMap = expandSignalsToDailyDates(timeframes.monthly, monthlySignals, dailyDates);

  // Align: iterate over daily dates that have all 3 signals
  const aligned = [];
  for (const bar of dailyBars) {
    const d = bar.date;
    const dSig = dailySigMap.get(d);
    const wSig = weeklySigMap.get(d);
    const mSig = monthlySigMap.get(d);

    if (dSig === undefined) continue; // no daily signal yet (warmup)

    const daily = dSig;
    const weekly = wSig || 0;
    const monthly = mSig || 0;

    // Cascade logic: monthly determines allowed direction
    let allowedDirection = 0; // 0 = both, 1 = long-only, -1 = short-only
    if (monthly === 1) allowedDirection = 1;
    if (monthly === -1) allowedDirection = -1;

    // Confidence scoring
    const votes = [daily, weekly, monthly];
    const nonZeroVotes = votes.filter(v => v !== 0);
    const allAgree = nonZeroVotes.length >= 2 &&
      nonZeroVotes.every(v => v === nonZeroVotes[0]);
    const twoAgree = nonZeroVotes.length >= 2;

    let confidence = 0;
    let rawSignal = 0;

    if (nonZeroVotes.length === 3 && allAgree) {
      // All 3 agree
      confidence = 1.0;
      rawSignal = nonZeroVotes[0];
    } else if (nonZeroVotes.length >= 2) {
      // Check if 2 agree
      const longVotes = votes.filter(v => v === 1).length;
      const shortVotes = votes.filter(v => v === -1).length;
      if (longVotes >= 2) {
        confidence = 0.6;
        rawSignal = 1;
      } else if (shortVotes >= 2) {
        confidence = 0.6;
        rawSignal = -1;
      } else {
        // Conflicting
        confidence = 0.0;
        rawSignal = 0;
      }
    } else if (nonZeroVotes.length === 1) {
      // Only one timeframe has a signal -- weak
      confidence = 0.3;
      rawSignal = nonZeroVotes[0];
    }

    // Apply cascade filter: monthly overrides
    let finalSignal = rawSignal;
    if (allowedDirection === 1 && rawSignal === -1) finalSignal = 0;
    if (allowedDirection === -1 && rawSignal === 1) finalSignal = 0;

    // Higher timeframe priority: if monthly is strong and daily disagrees, reduce
    if (monthly !== 0 && daily !== 0 && monthly !== daily) {
      confidence *= 0.5;
    }

    // Only trade when confidence >= 0.5
    if (confidence < 0.5) finalSignal = 0;

    aligned.push({
      date: d,
      signal: finalSignal,
      price: bar.close,
      confidence,
      daily,
      weekly,
      monthly,
    });
  }

  return aligned;
}

// ─── Backtest Engine ─────────────────────────────────────

function runBacktest(signals, config) {
  let capital = config.initialCapital;
  let position = 0;
  let trades = 0;
  const equityCurve = [];
  let peakEquity = capital;
  let maxDrawdown = 0;
  const dailyReturns = [];
  let prevEquity = capital;
  let wins = 0;
  let losses = 0;

  for (const sig of signals) {
    const targetPosition = sig.signal;
    const currentPosition = position > 0 ? 1 : position < 0 ? -1 : 0;

    if (targetPosition !== currentPosition) {
      // Close existing position
      if (position !== 0) {
        const proceeds = position * sig.price;
        const costBps = (config.transactionCostBps + config.slippageBps) / 10000;
        const cost = Math.abs(proceeds) * costBps;
        const pnl = proceeds - cost - Math.abs(position * (equityCurve.length > 0
          ? equityCurve[equityCurve.length - 1].entryPrice || sig.price
          : sig.price));
        capital += proceeds - cost;
        position = 0;
        trades++;
      }

      // Open new position
      if (targetPosition !== 0) {
        const sizeMultiplier = sig.confidence !== undefined ? sig.confidence : 1.0;
        const tradeCapital = capital * config.positionSize * sizeMultiplier;
        const costBps = (config.transactionCostBps + config.slippageBps) / 10000;
        const cost = tradeCapital * costBps;
        position = (targetPosition * (tradeCapital - cost)) / sig.price;
        capital -= tradeCapital;
        trades++;
      }
    }

    // Mark to market
    const equity = capital + position * sig.price;
    equityCurve.push({ date: sig.date, equity, entryPrice: sig.price });

    // Daily returns
    const dailyReturn = (equity - prevEquity) / prevEquity;
    dailyReturns.push(dailyReturn);
    if (dailyReturn > 0) wins++;
    if (dailyReturn < 0) losses++;
    prevEquity = equity;

    // Drawdown
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = (peakEquity - equity) / peakEquity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Close final position
  if (position !== 0 && signals.length > 0) {
    const lastPrice = signals[signals.length - 1].price;
    capital += position * lastPrice;
    position = 0;
  }

  return computeMetrics(capital, dailyReturns, maxDrawdown, trades, wins, losses, config);
}

function computeMetrics(finalCapital, dailyReturns, maxDrawdown, trades, wins, losses, config) {
  const n = dailyReturns.length;
  if (n === 0) return null;

  const totalReturn = (finalCapital - config.initialCapital) / config.initialCapital;
  const annualizedReturn = Math.pow(1 + totalReturn, 252 / n) - 1;

  const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const variance = dailyReturns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

  const downsideReturns = dailyReturns.filter(r => r < 0);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((sum, r) => sum + r ** 2, 0) / downsideReturns.length
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino = downsideDev > 0 ? (meanReturn / downsideDev) * Math.sqrt(252) : 0;

  const calmar = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;
  const winRate = n > 0 ? wins / n : 0;

  return {
    total_return: totalReturn,
    annualized_return: annualizedReturn,
    sharpe,
    sortino,
    calmar,
    max_drawdown: maxDrawdown,
    win_rate: winRate,
    trades,
    days: n,
    final_capital: finalCapital,
  };
}

// ─── Single-Timeframe Baseline ───────────────────────────

function runSingleTimeframeBacktest(dailyBars, strategy, config) {
  const signals = generateTimeframeSignals(dailyBars, "daily", strategy);
  return {
    metrics: runBacktest(signals, config),
    signalCount: signals.filter(s => s.signal !== 0).length,
  };
}

// ─── Multi-Timeframe ─────────────────────────────────────

function runMultiTimeframeBacktest(dailyBars, strategy, config) {
  const timeframes = createTimeframes(dailyBars);
  const alignedSignals = alignSignals(dailyBars, timeframes, strategy);
  return {
    metrics: runBacktest(alignedSignals, config),
    signalCount: alignedSignals.filter(s => s.signal !== 0).length,
    timeframes: {
      daily: timeframes.daily.length,
      weekly: timeframes.weekly.length,
      monthly: timeframes.monthly.length,
    },
  };
}

// ─── Comparison Table ────────────────────────────────────

function printComparison(singleResult, multiResult) {
  const s = singleResult.metrics;
  const m = multiResult.metrics;

  if (!s || !m) {
    console.log("ERROR: One or both backtests produced no results.");
    return;
  }

  const fmt = (v, pct = false) => {
    if (v === null || v === undefined) return "N/A";
    return pct ? (v * 100).toFixed(2) + "%" : v.toFixed(4);
  };

  const delta = (sv, mv) => {
    if (sv === 0) return "N/A";
    const d = ((mv - sv) / Math.abs(sv)) * 100;
    const sign = d >= 0 ? "+" : "";
    return sign + d.toFixed(1) + "%";
  };

  console.log("");
  console.log("=".repeat(72));
  console.log("  MULTI-TIMEFRAME BACKTEST COMPARISON");
  console.log("=".repeat(72));
  console.log("");

  const rows = [
    ["Metric",           "Single-TF",             "Multi-TF",              "Delta"],
    ["-".repeat(20),     "-".repeat(14),          "-".repeat(14),          "-".repeat(10)],
    ["Sharpe",           fmt(s.sharpe),            fmt(m.sharpe),           delta(s.sharpe, m.sharpe)],
    ["Sortino",          fmt(s.sortino),           fmt(m.sortino),          delta(s.sortino, m.sortino)],
    ["Calmar",           fmt(s.calmar),            fmt(m.calmar),           delta(s.calmar, m.calmar)],
    ["Total Return",     fmt(s.total_return, true),fmt(m.total_return, true),delta(s.total_return, m.total_return)],
    ["Annual Return",    fmt(s.annualized_return, true), fmt(m.annualized_return, true), delta(s.annualized_return, m.annualized_return)],
    ["Max Drawdown",     fmt(s.max_drawdown, true),fmt(m.max_drawdown, true),delta(s.max_drawdown, m.max_drawdown)],
    ["Win Rate",         fmt(s.win_rate, true),    fmt(m.win_rate, true),   delta(s.win_rate, m.win_rate)],
    ["Trades",           String(s.trades),         String(m.trades),        delta(s.trades, m.trades)],
    ["Final Capital",    "$" + s.final_capital.toFixed(0), "$" + m.final_capital.toFixed(0), delta(s.final_capital, m.final_capital)],
  ];

  for (const row of rows) {
    console.log(
      "  " +
      row[0].padEnd(20) +
      row[1].padStart(14) +
      row[2].padStart(14) +
      row[3].padStart(12)
    );
  }

  console.log("");
  console.log(`  Single-TF active signals: ${singleResult.signalCount}`);
  console.log(`  Multi-TF active signals:  ${multiResult.signalCount}`);

  if (multiResult.timeframes) {
    console.log("");
    console.log(`  Timeframe bars -- Daily: ${multiResult.timeframes.daily} | Weekly: ${multiResult.timeframes.weekly} | Monthly: ${multiResult.timeframes.monthly}`);
  }

  console.log("");
  console.log("=".repeat(72));

  // Summary verdict
  const sharpeImproved = m.sharpe > s.sharpe;
  const ddImproved = m.max_drawdown < s.max_drawdown;
  const wrImproved = m.win_rate > s.win_rate;

  const improvements = [sharpeImproved, ddImproved, wrImproved].filter(Boolean).length;

  if (improvements >= 2) {
    console.log("  VERDICT: Multi-timeframe alignment IMPROVES risk-adjusted returns.");
  } else if (improvements === 1) {
    console.log("  VERDICT: Mixed results -- multi-timeframe shows partial improvement.");
  } else {
    console.log("  VERDICT: Single-timeframe outperforms on key metrics.");
  }

  if (sharpeImproved) console.log("    + Sharpe improved by " + delta(s.sharpe, m.sharpe));
  if (ddImproved) console.log("    + Max drawdown reduced from " + fmt(s.max_drawdown, true) + " to " + fmt(m.max_drawdown, true));
  if (wrImproved) console.log("    + Win rate improved from " + fmt(s.win_rate, true) + " to " + fmt(m.win_rate, true));

  console.log("");
}

// ─── Grep-Friendly Output ────────────────────────────────

function printMetrics(label, metrics) {
  if (!metrics) {
    console.log(`${label}: NO RESULTS`);
    return;
  }
  console.log(`--- ${label} ---`);
  console.log(`sharpe:           ${metrics.sharpe.toFixed(4)}`);
  console.log(`sortino:          ${metrics.sortino.toFixed(4)}`);
  console.log(`calmar:           ${metrics.calmar.toFixed(4)}`);
  console.log(`total_return:     ${(metrics.total_return * 100).toFixed(2)}%`);
  console.log(`annual_return:    ${(metrics.annualized_return * 100).toFixed(2)}%`);
  console.log(`max_drawdown:     ${(metrics.max_drawdown * 100).toFixed(2)}%`);
  console.log(`win_rate:         ${(metrics.win_rate * 100).toFixed(1)}%`);
  console.log(`trades:           ${metrics.trades}`);
  console.log(`days:             ${metrics.days}`);
  console.log(`final_capital:    ${metrics.final_capital.toFixed(2)}`);
  console.log("");
}

// ─── Main ────────────────────────────────────────────────

function main() {
  console.log(`Multi-Timeframe Analysis: ${OPTS.symbol} | Strategy: ${OPTS.strategy}`);
  console.log(`Period: ${OPTS.startDate} to ${OPTS.endDate}`);
  console.log("");

  const dailyBars = loadPrices(OPTS.symbol, OPTS.startDate, OPTS.endDate);

  if (dailyBars.length < 100) {
    console.error("ERROR: Need at least 100 daily bars for multi-timeframe analysis.");
    process.exit(1);
  }

  const config = {
    initialCapital: OPTS.initialCapital,
    transactionCostBps: OPTS.transactionCostBps,
    slippageBps: OPTS.slippageBps,
    positionSize: OPTS.positionSize,
  };

  // Run single-timeframe baseline
  console.log("Running single-timeframe backtest...");
  const singleResult = runSingleTimeframeBacktest(dailyBars, OPTS.strategy, config);

  // Run multi-timeframe strategy
  console.log("Running multi-timeframe backtest...");
  const multiResult = runMultiTimeframeBacktest(dailyBars, OPTS.strategy, config);

  // Print individual metrics
  printMetrics("SINGLE-TIMEFRAME", singleResult.metrics);
  printMetrics("MULTI-TIMEFRAME", multiResult.metrics);

  // Print comparison table
  printComparison(singleResult, multiResult);
}

main();
