#!/usr/bin/env node
/**
 * Walk-Forward Optimization Engine — Inferred Analysis
 *
 * Prevents overfitting by splitting data into sequential train/test windows,
 * optimizing on train, validating on out-of-sample test data, then advancing.
 *
 * Modes:
 *   rolling   — fixed-size train window slides forward
 *   anchored  — train window expands from a fixed start date
 *
 * Usage:
 *   node agents/optimizer/walk-forward.mjs --symbol SPY --windows 5
 *   node agents/optimizer/walk-forward.mjs --symbol QQQ --mode anchored
 *   node agents/optimizer/walk-forward.mjs --symbol SPY --train-days 252 --test-days 63
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// ─── CLI Args ─────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    symbol: "SPY",
    mode: "rolling",       // "rolling" or "anchored"
    trainDays: 252,        // ~1 year of trading days
    testDays: 63,          // ~3 months of trading days
    windows: null,         // auto-calculated if null
    startDate: "2018-01-01",
    endDate: "2025-03-01",
    robustnessThreshold: 0.5,
    verbose: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbol") opts.symbol = args[++i];
    if (args[i] === "--mode") opts.mode = args[++i];
    if (args[i] === "--train-days") opts.trainDays = parseInt(args[++i]);
    if (args[i] === "--test-days") opts.testDays = parseInt(args[++i]);
    if (args[i] === "--windows") opts.windows = parseInt(args[++i]);
    if (args[i] === "--start-date") opts.startDate = args[++i];
    if (args[i] === "--end-date") opts.endDate = args[++i];
    if (args[i] === "--threshold") opts.robustnessThreshold = parseFloat(args[++i]);
    if (args[i] === "--verbose" || args[i] === "-v") opts.verbose = true;
  }
  return opts;
}

// ─── Strategy Mutations (from agent-runner.mjs) ──────────

const MUTATIONS = [
  {
    name: "mean_reversion",
    description: "Mean reversion: buy dips below MA, sell rallies above",
    generate() {
      const lookback = 10 + Math.floor(Math.random() * 40);
      const threshold = 0.005 + Math.random() * 0.03;
      return {
        name: "mean_reversion",
        lookback,
        params: { lookback, threshold },
        run(prices) {
          const signals = [];
          for (let i = lookback; i < prices.length; i++) {
            let sum = 0;
            for (let j = i - lookback; j < i; j++) sum += prices[j].close;
            const ma = sum / lookback;
            const deviation = (prices[i].close - ma) / ma;
            let signal = 0;
            if (deviation < -threshold) signal = 1;
            if (deviation > threshold) signal = -1;
            signals.push({ date: prices[i].date, signal, price: prices[i].close });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "momentum_crossover",
    description: "Dual moving average crossover momentum",
    generate() {
      const fast = 5 + Math.floor(Math.random() * 15);
      const slow = fast + 10 + Math.floor(Math.random() * 30);
      return {
        name: "momentum_crossover",
        lookback: slow,
        params: { fast, slow },
        run(prices) {
          const signals = [];
          for (let i = slow; i < prices.length; i++) {
            let fastSum = 0, slowSum = 0;
            for (let j = i - fast; j < i; j++) fastSum += prices[j].close;
            for (let j = i - slow; j < i; j++) slowSum += prices[j].close;
            const fastMA = fastSum / fast;
            const slowMA = slowSum / slow;
            let signal = 0;
            if (fastMA > slowMA * 1.001) signal = 1;
            if (fastMA < slowMA * 0.999) signal = -1;
            signals.push({ date: prices[i].date, signal, price: prices[i].close });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "volatility_breakout",
    description: "Breakout on volatility expansion",
    generate() {
      const lookback = 10 + Math.floor(Math.random() * 20);
      const volMult = 1.0 + Math.random() * 2.0;
      return {
        name: "volatility_breakout",
        lookback,
        params: { lookback, volMult },
        run(prices) {
          const signals = [];
          for (let i = lookback; i < prices.length; i++) {
            let sum = 0, sqSum = 0;
            for (let j = i - lookback; j < i; j++) {
              const prev = j - 1 >= 0 ? j - 1 : 0;
              const ret = (prices[j].close - prices[prev].close) / prices[prev].close;
              sum += ret;
              sqSum += ret * ret;
            }
            const mean = sum / lookback;
            const vol = Math.sqrt(Math.max(0, sqSum / lookback - mean * mean));
            const todayRet = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;
            let signal = 0;
            if (todayRet > vol * volMult) signal = 1;
            if (todayRet < -vol * volMult) signal = -1;
            signals.push({ date: prices[i].date, signal, price: prices[i].close });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "rsi_contrarian",
    description: "RSI contrarian: buy oversold, sell overbought",
    generate() {
      const period = 7 + Math.floor(Math.random() * 21);
      const oversold = 20 + Math.floor(Math.random() * 15);
      const overbought = 100 - oversold;
      return {
        name: "rsi_contrarian",
        lookback: period + 1,
        params: { period, oversold, overbought },
        run(prices) {
          const signals = [];
          for (let i = period + 1; i < prices.length; i++) {
            let gains = 0, losses = 0;
            for (let j = i - period; j < i; j++) {
              const change = prices[j + 1].close - prices[j].close;
              if (change > 0) gains += change;
              else losses -= change;
            }
            const avgGain = gains / period;
            const avgLoss = losses / period;
            const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
            const rsi = 100 - 100 / (1 + rs);
            let signal = 0;
            if (rsi < oversold) signal = 1;
            if (rsi > overbought) signal = -1;
            signals.push({ date: prices[i].date, signal, price: prices[i].close });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "adaptive_momentum",
    description: "Momentum with volatility-adaptive threshold",
    generate() {
      const lookback = 15 + Math.floor(Math.random() * 25);
      const volWindow = 5 + Math.floor(Math.random() * 15);
      const sensitivity = 0.5 + Math.random() * 2.0;
      return {
        name: "adaptive_momentum",
        lookback: Math.max(lookback, volWindow + 1),
        params: { lookback, volWindow, sensitivity },
        run(prices) {
          const minIdx = Math.max(lookback, volWindow + 1);
          const signals = [];
          for (let i = minIdx; i < prices.length; i++) {
            const current = prices[i].close;
            const past = prices[i - lookback].close;
            const momentum = (current - past) / past;
            let volSum = 0;
            for (let j = i - volWindow; j < i; j++) {
              const ret = Math.abs((prices[j].close - prices[j - 1].close) / prices[j - 1].close);
              volSum += ret;
            }
            const avgVol = volSum / volWindow;
            const threshold = avgVol * sensitivity;
            let signal = 0;
            if (momentum > threshold) signal = 1;
            if (momentum < -threshold) signal = -1;
            signals.push({ date: prices[i].date, signal, price: prices[i].close });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "price_channel",
    description: "Donchian channel breakout: buy highs, sell lows",
    generate() {
      const lookback = 10 + Math.floor(Math.random() * 40);
      return {
        name: "price_channel",
        lookback,
        params: { lookback },
        run(prices) {
          const signals = [];
          for (let i = lookback; i < prices.length; i++) {
            let highest = -Infinity, lowest = Infinity;
            for (let j = i - lookback; j < i; j++) {
              if (prices[j].high > highest) highest = prices[j].high;
              if (prices[j].low < lowest) lowest = prices[j].low;
            }
            let signal = 0;
            if (prices[i].close > highest) signal = 1;
            if (prices[i].close < lowest) signal = -1;
            signals.push({ date: prices[i].date, signal, price: prices[i].close });
          }
          return signals;
        },
      };
    },
  },
];

// ─── Backtest Engine (mirrors template.js) ────────────────

const BACKTEST_CONFIG = {
  initialCapital: 1_000_000,
  transactionCostBps: 10,
  slippageBps: 5,
  positionSize: 0.10,
};

function runBacktest(prices, signals) {
  const cfg = BACKTEST_CONFIG;
  let capital = cfg.initialCapital;
  let position = 0;
  let trades = 0;
  let peakEquity = capital;
  let maxDrawdown = 0;
  const dailyReturns = [];
  let prevEquity = capital;

  for (const sig of signals) {
    const targetPosition = sig.signal;
    const currentPosition = position > 0 ? 1 : position < 0 ? -1 : 0;

    if (targetPosition !== currentPosition) {
      if (position !== 0) {
        const proceeds = position * sig.price;
        const costBps = (cfg.transactionCostBps + cfg.slippageBps) / 10000;
        const cost = Math.abs(proceeds) * costBps;
        capital += proceeds - cost;
        position = 0;
        trades++;
      }
      if (targetPosition !== 0) {
        const tradeCapital = capital * cfg.positionSize;
        const costBps = (cfg.transactionCostBps + cfg.slippageBps) / 10000;
        const cost = tradeCapital * costBps;
        position = (targetPosition * (tradeCapital - cost)) / sig.price;
        capital -= tradeCapital;
        trades++;
      }
    }

    const equity = capital + position * sig.price;
    const dailyReturn = (equity - prevEquity) / prevEquity;
    dailyReturns.push(dailyReturn);
    prevEquity = equity;

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

  return computeMetrics(capital, dailyReturns, maxDrawdown, trades);
}

function computeMetrics(finalCapital, dailyReturns, maxDrawdown, trades) {
  const n = dailyReturns.length;
  if (n < 2) return null;

  const cfg = BACKTEST_CONFIG;
  const totalReturn = (finalCapital - cfg.initialCapital) / cfg.initialCapital;
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

  return {
    total_return: totalReturn,
    annualized_return: annualizedReturn,
    sharpe,
    sortino,
    calmar,
    max_drawdown: maxDrawdown,
    trades,
    days: n,
    final_capital: finalCapital,
  };
}

// ─── Window Splitter ──────────────────────────────────────

/**
 * Split price data into walk-forward windows.
 *
 * Rolling mode:  fixed-size train window slides forward
 *   [===TRAIN===|==TEST==]
 *               [===TRAIN===|==TEST==]
 *                           [===TRAIN===|==TEST==]
 *
 * Anchored mode: train window expands from anchor point
 *   [===TRAIN===|==TEST==]
 *   [======TRAIN======|==TEST==]
 *   [=========TRAIN=========|==TEST==]
 */
function buildWindows(prices, opts) {
  const totalDays = prices.length;
  const { trainDays, testDays, mode } = opts;
  const stepSize = testDays; // advance by one test window each step

  const windows = [];

  if (mode === "anchored") {
    // Anchored: train always starts at index 0, grows each step
    let trainEnd = trainDays;
    while (trainEnd + testDays <= totalDays) {
      windows.push({
        trainStart: 0,
        trainEnd: trainEnd,
        testStart: trainEnd,
        testEnd: Math.min(trainEnd + testDays, totalDays),
      });
      trainEnd += stepSize;
    }
  } else {
    // Rolling: fixed-size train window
    let start = 0;
    while (start + trainDays + testDays <= totalDays) {
      windows.push({
        trainStart: start,
        trainEnd: start + trainDays,
        testStart: start + trainDays,
        testEnd: Math.min(start + trainDays + testDays, totalDays),
      });
      start += stepSize;
    }
  }

  // If user specified a window count, trim or warn
  if (opts.windows !== null && opts.windows < windows.length) {
    return windows.slice(0, opts.windows);
  }

  return windows;
}

// ─── Walk-Forward Core ────────────────────────────────────

/**
 * For a single window, run all 6 strategy mutations N times each,
 * pick the best on train data, then evaluate it on test data.
 * Returns { bestStrategy, trainMetrics, testMetrics }.
 */
function optimizeWindow(prices, window, trialsPerMutation = 3) {
  const trainPrices = prices.slice(window.trainStart, window.trainEnd);
  const testPrices = prices.slice(window.testStart, window.testEnd);

  let bestTrainSharpe = -Infinity;
  let bestStrategy = null;
  let bestTrainMetrics = null;

  // Run each mutation multiple times (they have random params)
  for (const mutation of MUTATIONS) {
    for (let t = 0; t < trialsPerMutation; t++) {
      const strategy = mutation.generate();

      // Need enough data for the strategy lookback
      if (trainPrices.length <= strategy.lookback + 5) continue;

      const trainSignals = strategy.run(trainPrices);
      if (trainSignals.length < 10) continue;

      const trainMetrics = runBacktest(trainPrices, trainSignals);
      if (!trainMetrics) continue;

      if (trainMetrics.sharpe > bestTrainSharpe) {
        bestTrainSharpe = trainMetrics.sharpe;
        bestStrategy = strategy;
        bestTrainMetrics = trainMetrics;
      }
    }
  }

  if (!bestStrategy || !bestTrainMetrics) {
    return null;
  }

  // Evaluate best-on-train strategy on out-of-sample test data
  if (testPrices.length <= bestStrategy.lookback + 5) {
    return null;
  }

  const testSignals = bestStrategy.run(testPrices);
  if (testSignals.length < 5) return null;

  const testMetrics = runBacktest(testPrices, testSignals);
  if (!testMetrics) return null;

  return {
    bestStrategy: {
      name: bestStrategy.name,
      params: bestStrategy.params,
    },
    trainMetrics: bestTrainMetrics,
    testMetrics,
  };
}

// ─── Aggregate Results ────────────────────────────────────

function aggregateResults(windowResults, robustnessThreshold) {
  const valid = windowResults.filter(r => r !== null);
  if (valid.length === 0) return null;

  const trainSharpes = valid.map(r => r.trainMetrics.sharpe);
  const testSharpes = valid.map(r => r.testMetrics.sharpe);
  const trainReturns = valid.map(r => r.trainMetrics.total_return);
  const testReturns = valid.map(r => r.testMetrics.total_return);
  const testDrawdowns = valid.map(r => r.testMetrics.max_drawdown);

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = arr => {
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(arr.length - 1, 1));
  };
  const median = arr => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const avgTrainSharpe = avg(trainSharpes);
  const avgTestSharpe = avg(testSharpes);
  const overfittingRatio = avgTrainSharpe > 0 ? avgTestSharpe / avgTrainSharpe : 0;
  // Robust only if: ratio exceeds threshold, OOS Sharpe is positive, and majority of windows are positive
  const isRobust = overfittingRatio > robustnessThreshold
    && avgTestSharpe > 0
    && positiveOOS > valid.length / 2;

  // Count how many windows had positive OOS Sharpe
  const positiveOOS = testSharpes.filter(s => s > 0).length;

  // Strategy consistency: how often was the same strategy picked
  const strategyCounts = {};
  for (const r of valid) {
    const name = r.bestStrategy.name;
    strategyCounts[name] = (strategyCounts[name] || 0) + 1;
  }
  const dominantStrategy = Object.entries(strategyCounts)
    .sort((a, b) => b[1] - a[1])[0];

  return {
    windowCount: valid.length,
    totalWindows: windowResults.length,

    inSample: {
      avgSharpe: avgTrainSharpe,
      medianSharpe: median(trainSharpes),
      stdSharpe: std(trainSharpes),
      avgReturn: avg(trainReturns),
      sharpes: trainSharpes,
    },

    outOfSample: {
      avgSharpe: avgTestSharpe,
      medianSharpe: median(testSharpes),
      stdSharpe: std(testSharpes),
      avgReturn: avg(testReturns),
      avgMaxDrawdown: avg(testDrawdowns),
      positiveWindows: positiveOOS,
      positiveRate: positiveOOS / valid.length,
      sharpes: testSharpes,
    },

    overfittingRatio,
    isRobust,
    robustnessThreshold,

    strategyBreakdown: strategyCounts,
    dominantStrategy: dominantStrategy ? { name: dominantStrategy[0], count: dominantStrategy[1] } : null,

    windowDetails: valid.map(r => ({
      strategy: r.bestStrategy.name,
      params: r.bestStrategy.params,
      trainSharpe: r.trainMetrics.sharpe,
      testSharpe: r.testMetrics.sharpe,
      trainReturn: r.trainMetrics.total_return,
      testReturn: r.testMetrics.total_return,
      testDrawdown: r.testMetrics.max_drawdown,
    })),
  };
}

// ─── Display ──────────────────────────────────────────────

function printResults(results, opts) {
  const line = "═".repeat(60);
  const thin = "─".repeat(60);

  console.log(`\n╔${line}╗`);
  console.log(`║  Walk-Forward Optimization Results${" ".repeat(25)}║`);
  console.log(`╠${line}╣`);
  console.log(`║  Symbol:    ${opts.symbol.padEnd(47)}║`);
  console.log(`║  Mode:      ${opts.mode.padEnd(47)}║`);
  console.log(`║  Train:     ${(opts.trainDays + " days").padEnd(47)}║`);
  console.log(`║  Test:      ${(opts.testDays + " days").padEnd(47)}║`);
  console.log(`║  Windows:   ${(results.windowCount + "/" + results.totalWindows + " valid").padEnd(47)}║`);
  console.log(`╚${line}╝\n`);

  // In-sample vs Out-of-sample comparison
  console.log(`┌${thin}┐`);
  console.log(`│  Sharpe Ratio Comparison${" ".repeat(35)}│`);
  console.log(`├${thin}┤`);
  console.log(`│  ${"Metric".padEnd(25)} ${"In-Sample".padEnd(15)} ${"Out-of-Sample".padEnd(16)}│`);
  console.log(`│  ${thin.slice(2)}│`);
  console.log(`│  ${"Avg Sharpe".padEnd(25)} ${results.inSample.avgSharpe.toFixed(4).padEnd(15)} ${results.outOfSample.avgSharpe.toFixed(4).padEnd(16)}│`);
  console.log(`│  ${"Median Sharpe".padEnd(25)} ${results.inSample.medianSharpe.toFixed(4).padEnd(15)} ${results.outOfSample.medianSharpe.toFixed(4).padEnd(16)}│`);
  console.log(`│  ${"Std Sharpe".padEnd(25)} ${results.inSample.stdSharpe.toFixed(4).padEnd(15)} ${results.outOfSample.stdSharpe.toFixed(4).padEnd(16)}│`);
  console.log(`│  ${"Avg Return".padEnd(25)} ${(results.inSample.avgReturn * 100).toFixed(2).padStart(7)}%       ${(results.outOfSample.avgReturn * 100).toFixed(2).padStart(7)}%        │`);
  console.log(`└${thin}┘\n`);

  // Overfitting diagnostic
  const ratio = results.overfittingRatio;
  const verdict = results.isRobust ? "ROBUST" : "OVERFIT";
  const bar = ratio > 0
    ? "#".repeat(Math.min(Math.round(ratio * 20), 20)).padEnd(20, ".")
    : ".".repeat(20);

  console.log(`┌${thin}┐`);
  console.log(`│  Overfitting Diagnostic${" ".repeat(36)}│`);
  console.log(`├${thin}┤`);
  console.log(`│  OOS/IS Sharpe Ratio:  ${ratio.toFixed(4).padEnd(36)}│`);
  console.log(`│  Threshold:            ${results.robustnessThreshold.toFixed(2).padEnd(36)}│`);
  console.log(`│  Verdict:              ${verdict.padEnd(36)}│`);
  console.log(`│  [${bar}] ${(ratio * 100).toFixed(1)}%${" ".repeat(Math.max(0, 31 - (ratio * 100).toFixed(1).length))}│`);
  console.log(`│  OOS Positive Windows: ${results.outOfSample.positiveWindows}/${results.windowCount} (${(results.outOfSample.positiveRate * 100).toFixed(0)}%)${" ".repeat(Math.max(0, 28 - `${results.outOfSample.positiveWindows}/${results.windowCount}`.length))}│`);
  console.log(`│  Avg OOS Max Drawdown: ${(results.outOfSample.avgMaxDrawdown * 100).toFixed(2)}%${" ".repeat(Math.max(0, 33 - (results.outOfSample.avgMaxDrawdown * 100).toFixed(2).length))}│`);
  console.log(`└${thin}┘\n`);

  // Per-window details
  console.log(`┌${thin}┐`);
  console.log(`│  Per-Window Breakdown${" ".repeat(38)}│`);
  console.log(`├${thin}┤`);
  console.log(`│  ${"Win".padEnd(5)} ${"Strategy".padEnd(22)} ${"Train Sh".padEnd(10)} ${"Test Sh".padEnd(10)} ${"Decay".padEnd(9)}│`);
  console.log(`│  ${thin.slice(2)}│`);

  for (let i = 0; i < results.windowDetails.length; i++) {
    const w = results.windowDetails[i];
    const decay = w.trainSharpe !== 0 ? ((1 - w.testSharpe / w.trainSharpe) * 100).toFixed(0) + "%" : "N/A";
    console.log(`│  ${String(i + 1).padEnd(5)} ${w.strategy.padEnd(22)} ${w.trainSharpe.toFixed(4).padEnd(10)} ${w.testSharpe.toFixed(4).padEnd(10)} ${decay.padEnd(9)}│`);
  }
  console.log(`└${thin}┘\n`);

  // Strategy frequency
  console.log(`┌${thin}┐`);
  console.log(`│  Strategy Selection Frequency${" ".repeat(30)}│`);
  console.log(`├${thin}┤`);
  for (const [name, count] of Object.entries(results.strategyBreakdown).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / results.windowCount) * 100).toFixed(0);
    const bar = "#".repeat(Math.round(count / results.windowCount * 30));
    console.log(`│  ${name.padEnd(22)} ${String(count).padEnd(4)} (${pct.padStart(3)}%) ${bar.padEnd(24)}│`);
  }
  if (results.dominantStrategy) {
    console.log(`│  ${thin.slice(2)}│`);
    console.log(`│  Dominant: ${results.dominantStrategy.name.padEnd(47)}│`);
  }
  console.log(`└${thin}┘\n`);

  // Machine-readable summary
  console.log("--- walk-forward-summary ---");
  console.log(`symbol:             ${opts.symbol}`);
  console.log(`mode:               ${opts.mode}`);
  console.log(`windows:            ${results.windowCount}`);
  console.log(`is_sharpe:          ${results.inSample.avgSharpe.toFixed(4)}`);
  console.log(`oos_sharpe:         ${results.outOfSample.avgSharpe.toFixed(4)}`);
  console.log(`overfitting_ratio:  ${results.overfittingRatio.toFixed(4)}`);
  console.log(`robust:             ${results.isRobust}`);
  console.log(`oos_positive_rate:  ${(results.outOfSample.positiveRate * 100).toFixed(1)}%`);
  console.log(`dominant_strategy:  ${results.dominantStrategy?.name ?? "none"}`);
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`\n╔${"═".repeat(55)}╗`);
  console.log(`║  Walk-Forward Optimization Engine${" ".repeat(20)}║`);
  console.log(`║  Inferred Analysis Platform${" ".repeat(26)}║`);
  console.log(`╚${"═".repeat(55)}╝\n`);

  // Load price data
  console.log(`Loading data for ${opts.symbol}...`);
  let prices;
  try {
    const { generateRealisticPrices } = await import("../data/fetch.mjs");
    prices = generateRealisticPrices(opts.symbol, opts.startDate, opts.endDate);
  } catch (err) {
    console.error(`Failed to load price data: ${err.message}`);
    process.exit(1);
  }

  console.log(`Loaded ${prices.length} trading days (${prices[0].date} to ${prices[prices.length - 1].date})\n`);

  // Build walk-forward windows
  const windows = buildWindows(prices, opts);
  if (windows.length === 0) {
    console.error("ERROR: Not enough data for even one train+test window.");
    console.error(`  Data: ${prices.length} days, need at least ${opts.trainDays + opts.testDays} days.`);
    process.exit(1);
  }

  console.log(`Mode: ${opts.mode} | Train: ${opts.trainDays}d | Test: ${opts.testDays}d | Windows: ${windows.length}\n`);

  // Run walk-forward optimization
  const windowResults = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const trainRange = `${prices[w.trainStart].date} to ${prices[w.trainEnd - 1].date}`;
    const testRange = `${prices[w.testStart].date} to ${prices[w.testEnd - 1].date}`;
    const trainSize = w.trainEnd - w.trainStart;
    const testSize = w.testEnd - w.testStart;

    console.log(`── Window ${i + 1}/${windows.length} ──`);
    console.log(`   Train: ${trainRange} (${trainSize}d)`);
    console.log(`   Test:  ${testRange} (${testSize}d)`);

    const result = optimizeWindow(prices, w);
    windowResults.push(result);

    if (result) {
      console.log(`   Best:  ${result.bestStrategy.name} | Train Sharpe: ${result.trainMetrics.sharpe.toFixed(4)} | Test Sharpe: ${result.testMetrics.sharpe.toFixed(4)}`);
    } else {
      console.log(`   SKIP:  Insufficient data for strategies in this window`);
    }
  }

  // Aggregate and display
  const results = aggregateResults(windowResults, opts.robustnessThreshold);
  if (!results) {
    console.error("\nERROR: No valid window results to aggregate.");
    process.exit(1);
  }

  printResults(results, opts);

  // Exit code based on robustness
  process.exit(results.isRobust ? 0 : 1);
}

main().catch(err => {
  console.error("Walk-forward optimization failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
