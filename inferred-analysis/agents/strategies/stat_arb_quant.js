#!/usr/bin/env node
/**
 * Backtest Template — Inferred Analysis
 *
 * This is the equivalent of train.py in Karpathy's autoresearch.
 * Agents modify THIS FILE (or copies of it) to test trading strategies.
 *
 * The framework provides:
 * - Price data loading (CSV or API)
 * - Signal generation interface
 * - Portfolio simulation with transaction costs
 * - Standard metrics (Sharpe, drawdown, Sortino, Calmar)
 * - Fixed evaluation output format
 *
 * Usage:
 *   node agents/backtests/template.js
 *   node agents/backtests/template.js --data path/to/prices.csv
 */

// ─── Configuration (AGENT MODIFIES THESE) ──────────────────

const CONFIG = {
  // Data parameters
  symbol: "SPY",            // ticker symbol (uses real data if cached, else synthetic)

  // Strategy parameters — agents change these
  lookback: 40,           // signal lookback period
  threshold: 0.0200,        // signal threshold for entry
  stopLoss: -0.05,        // stop loss as fraction
  takeProfit: 0.10,       // take profit as fraction
  positionSize: 0.10,     // fraction of portfolio per position

  // Backtest parameters
  initialCapital: 1_000_000,
  transactionCostBps: 10, // 10 bps round-trip
  slippageBps: 5,         // 5 bps per trade
  startDate: "2020-01-01",
  endDate: "2024-12-31",
};

// ─── Signal Generation (AGENT MODIFIES THIS) ─────────────

/**
 * Generate trading signals from price data.
 * Returns array of { date, signal } where signal is -1 (short), 0 (flat), or 1 (long).
 *
 * THIS IS THE FUNCTION AGENTS MODIFY TO TEST DIFFERENT STRATEGIES.
 */
function generateSignals(prices) {
  const signals = [];
  const fast = 8, slow = 40;
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
}

// ─── Backtest Engine (DO NOT MODIFY) ───────────────────────

function runBacktest(prices, signals) {
  let capital = CONFIG.initialCapital;
  let position = 0; // shares
  let positionCost = 0;
  let trades = 0;
  const equityCurve = [];
  let peakEquity = capital;
  let maxDrawdown = 0;
  const dailyReturns = [];
  let prevEquity = capital;

  for (const sig of signals) {
    const targetPosition = sig.signal;
    const currentPosition = position > 0 ? 1 : position < 0 ? -1 : 0;

    if (targetPosition !== currentPosition) {
      // Close existing position
      if (position !== 0) {
        const proceeds = position * sig.price;
        const costBps = (CONFIG.transactionCostBps + CONFIG.slippageBps) / 10000;
        const cost = Math.abs(proceeds) * costBps;
        capital += proceeds - cost;
        position = 0;
        trades++;
      }

      // Open new position
      if (targetPosition !== 0) {
        const tradeCapital = capital * CONFIG.positionSize;
        const costBps = (CONFIG.transactionCostBps + CONFIG.slippageBps) / 10000;
        const cost = tradeCapital * costBps;
        position = (targetPosition * (tradeCapital - cost)) / sig.price;
        positionCost = tradeCapital;
        capital -= tradeCapital;
        trades++;
      }
    }

    // Mark to market
    const equity = capital + position * sig.price;
    equityCurve.push({ date: sig.date, equity });

    // Track daily returns
    const dailyReturn = (equity - prevEquity) / prevEquity;
    dailyReturns.push(dailyReturn);
    prevEquity = equity;

    // Track drawdown
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

  return computeMetrics(capital, dailyReturns, maxDrawdown, trades, equityCurve);
}

function computeMetrics(finalCapital, dailyReturns, maxDrawdown, trades, equityCurve) {
  const n = dailyReturns.length;
  if (n === 0) return null;

  const totalReturn = (finalCapital - CONFIG.initialCapital) / CONFIG.initialCapital;
  const annualizedReturn = Math.pow(1 + totalReturn, 252 / n) - 1;

  // Sharpe ratio (annualized)
  const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const variance = dailyReturns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

  // Sortino ratio (downside deviation only)
  const downsideReturns = dailyReturns.filter(r => r < 0);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((sum, r) => sum + r ** 2, 0) / downsideReturns.length
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino = downsideDev > 0 ? (meanReturn / downsideDev) * Math.sqrt(252) : 0;

  // Calmar ratio
  const calmar = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

  // Win rate
  const wins = dailyReturns.filter(r => r > 0).length;
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

// ─── Sample Data Generator (for testing without real data) ──

function generateSamplePrices(startDate, endDate, initialPrice = 100) {
  const prices = [];
  let price = initialPrice;
  const start = new Date(startDate);
  const end = new Date(endDate);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue; // skip weekends

    // Random walk with slight upward drift (equity-like)
    const dailyReturn = (Math.random() - 0.48) * 0.02; // slight positive drift
    price *= (1 + dailyReturn);

    prices.push({
      date: d.toISOString().split("T")[0],
      open: price * (1 + (Math.random() - 0.5) * 0.005),
      high: price * (1 + Math.random() * 0.01),
      low: price * (1 - Math.random() * 0.01),
      close: price,
      volume: Math.floor(Math.random() * 1_000_000) + 100_000,
    });
  }

  return prices;
}

// ─── Data Loading ─────────────────────────────────────────

async function loadPrices() {
  const symbol = process.env.SYMBOL || CONFIG.symbol || "SPY";

  // Try loading cached real data first
  const { readFileSync, existsSync } = await import("fs");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const cachePath = join(__dirname, "..", "data", "cache", `${symbol}.json`);

  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    console.log(`# Data: ${symbol} (real) — ${cached.count} days`);
    return cached.prices;
  }

  // Try realistic synthetic data
  try {
    const { generateRealisticPrices } = await import("../data/fetch.mjs");
    const prices = generateRealisticPrices(symbol, CONFIG.startDate, CONFIG.endDate);
    console.log(`# Data: ${symbol} (synthetic-realistic) — ${prices.length} days`);
    return prices;
  } catch {
    // Fallback to basic random walk
    console.log(`# Data: random walk — basic synthetic`);
    return generateSamplePrices(CONFIG.startDate, CONFIG.endDate);
  }
}

// ─── Main ────────────────────────────────────────────────

const prices = await loadPrices();
const signals = generateSignals(prices);
const metrics = runBacktest(prices, signals);

if (!metrics) {
  console.log("FAIL: No trading signals generated");
  process.exit(1);
}

// Output in autoresearch format (grep-friendly)
console.log("---");
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
