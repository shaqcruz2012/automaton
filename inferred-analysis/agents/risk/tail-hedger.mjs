#!/usr/bin/env node
/**
 * Tail Risk Hedger — Tail Risk Measurement, Hedge Pricing & Recommendations
 *
 * Measures portfolio tail risk and recommends protective hedge positions:
 *   - VaR / CVaR (Expected Shortfall) at 95% and 99% confidence
 *   - Maximum loss estimation from historical drawdowns
 *   - Black-Scholes put pricing for hedge cost estimation
 *   - Dynamic hedge ratio adjustment based on current risk regime
 *   - Hedge efficiency tracking (cost vs protection)
 *   - Regime-conditional hedging (increase hedges in high-vol regimes)
 *
 * Usage:
 *   node agents/risk/tail-hedger.mjs
 *   node agents/risk/tail-hedger.mjs --symbol SPY --capital 100000
 *   node agents/risk/tail-hedger.mjs --confidence 0.99
 *
 * Module:
 *   import { TailHedger, computeTailRisk, estimateHedgeCost, getHedgeRecommendation } from './tail-hedger.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Math Utilities ─────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/** Standard normal CDF (Abramowitz & Stegun approximation). */
function normCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
}

/** Standard normal PDF. */
function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Compute daily log returns from a price array. */
function computeReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  return returns;
}

// ─── Tail Risk Metrics ──────────────────────────────────

/**
 * Compute Value-at-Risk (historical simulation, percentile method).
 * Returns a positive number representing loss magnitude.
 * @param {number[]} returns - Daily returns
 * @param {number} confidence - Confidence level (0.95 or 0.99)
 */
function valueAtRisk(returns, confidence = 0.95) {
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * (1 - confidence));
  return -sorted[idx];
}

/**
 * Compute Conditional Value-at-Risk / Expected Shortfall.
 * Average of losses beyond the VaR threshold.
 * @param {number[]} returns - Daily returns
 * @param {number} confidence - Confidence level (0.95 or 0.99)
 */
function cvar(returns, confidence = 0.95) {
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoffIdx = Math.floor(sorted.length * (1 - confidence));
  if (cutoffIdx === 0) return -sorted[0];
  const tail = sorted.slice(0, cutoffIdx);
  return -mean(tail);
}

/**
 * Estimate maximum single-day loss from historical data.
 * @param {number[]} returns - Daily returns
 */
function maxLoss(returns) {
  return -Math.min(...returns);
}

/**
 * Compute maximum drawdown from a price series.
 * @param {number[]} prices - Close prices
 */
function maxDrawdown(prices) {
  let peak = -Infinity;
  let mdd = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

/**
 * Compute all tail risk metrics for a return series.
 * @param {number[]} returns - Daily returns
 * @param {number[]} [prices] - Optional price series for drawdown calc
 * @returns {object} Tail risk metrics
 */
export function computeTailRisk(returns, prices = null) {
  const var95 = valueAtRisk(returns, 0.95);
  const var99 = valueAtRisk(returns, 0.99);
  const cvar95 = cvar(returns, 0.95);
  const cvar99 = cvar(returns, 0.99);
  const maxSingleDayLoss = maxLoss(returns);
  const annualVol = stddev(returns) * Math.sqrt(252);
  const dailyVol = stddev(returns);
  const skewness = computeSkewness(returns);
  const kurtosis = computeKurtosis(returns);
  const mdd = prices ? maxDrawdown(prices) : null;

  return {
    var95,
    var99,
    cvar95,
    cvar99,
    maxSingleDayLoss,
    annualVol,
    dailyVol,
    skewness,
    kurtosis,
    maxDrawdown: mdd,
    tailRatio: cvar99 / var99,  // >1 means fat tails
    nObservations: returns.length,
  };
}

function computeSkewness(arr) {
  const m = mean(arr);
  const s = stddev(arr);
  if (s === 0) return 0;
  const n = arr.length;
  const skew = arr.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0) / n;
  return skew;
}

function computeKurtosis(arr) {
  const m = mean(arr);
  const s = stddev(arr);
  if (s === 0) return 0;
  const n = arr.length;
  const kurt = arr.reduce((acc, v) => acc + ((v - m) / s) ** 4, 0) / n;
  return kurt - 3; // excess kurtosis
}

// ─── Black-Scholes Option Pricing ───────────────────────

/**
 * Black-Scholes put option price.
 * @param {number} S - Current underlying price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration in years
 * @param {number} r - Risk-free rate (annualized)
 * @param {number} sigma - Implied volatility (annualized)
 * @returns {number} Put option price
 */
function blackScholesPut(S, K, T, r, sigma) {
  if (T <= 0) return Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

/**
 * Compute put option Greeks (delta, gamma, vega, theta).
 */
function putGreeks(S, K, T, r, sigma) {
  if (T <= 0) return { delta: K > S ? -1 : 0, gamma: 0, vega: 0, theta: 0 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const delta = normCDF(d1) - 1; // put delta is negative
  const gamma = normPDF(d1) / (S * sigma * sqrtT);
  const vega = S * normPDF(d1) * sqrtT / 100; // per 1% vol move
  const theta = (-(S * normPDF(d1) * sigma) / (2 * sqrtT)
    - r * K * Math.exp(-r * T) * normCDF(-d2)) / 365; // per day

  return { delta, gamma, vega, theta };
}

/**
 * Estimate the cost of a protective put hedge.
 * @param {object} params
 * @param {number} params.spotPrice - Current price of the underlying
 * @param {number} params.portfolioValue - Total portfolio value to hedge
 * @param {number} params.hedgeRatio - Fraction of portfolio to hedge (0-1)
 * @param {number} params.otmPercent - How far out-of-the-money (e.g. 0.05 = 5% OTM)
 * @param {number} params.daysToExpiry - Days until option expiry
 * @param {number} params.impliedVol - Annualized implied volatility
 * @param {number} params.riskFreeRate - Annualized risk-free rate
 * @returns {object} Hedge cost details
 */
export function estimateHedgeCost({
  spotPrice,
  portfolioValue,
  hedgeRatio = 1.0,
  otmPercent = 0.05,
  daysToExpiry = 30,
  impliedVol = 0.20,
  riskFreeRate = 0.05,
} = {}) {
  const strike = spotPrice * (1 - otmPercent);
  const T = daysToExpiry / 365;
  const putPrice = blackScholesPut(spotPrice, strike, T, riskFreeRate, impliedVol);
  const greeks = putGreeks(spotPrice, strike, T, riskFreeRate, impliedVol);

  // Number of contracts needed (assuming 100 shares per contract)
  const notionalToHedge = portfolioValue * hedgeRatio;
  const sharesEquivalent = notionalToHedge / spotPrice;
  const contracts = Math.ceil(sharesEquivalent / 100);

  const totalCost = contracts * 100 * putPrice;
  const costAsPercentOfPortfolio = totalCost / portfolioValue;
  const maxProtection = notionalToHedge * otmPercent; // approximate protection value
  const hedgeEfficiency = maxProtection > 0 ? totalCost / maxProtection : Infinity;

  return {
    strike: +strike.toFixed(2),
    putPrice: +putPrice.toFixed(4),
    contracts,
    totalCost: +totalCost.toFixed(2),
    costAsPercentOfPortfolio: +(costAsPercentOfPortfolio * 100).toFixed(4),
    maxProtection: +maxProtection.toFixed(2),
    hedgeEfficiency: +hedgeEfficiency.toFixed(4),
    annualizedCost: +(costAsPercentOfPortfolio * (365 / daysToExpiry) * 100).toFixed(2),
    greeks,
    params: {
      spotPrice,
      portfolioValue,
      hedgeRatio,
      otmPercent,
      daysToExpiry,
      impliedVol,
      riskFreeRate,
    },
  };
}

// ─── Regime Detection ───────────────────────────────────

/**
 * Detect volatility regime from recent returns.
 * @param {number[]} returns - Daily returns
 * @param {number} lookback - Window for recent vol (default 21 trading days)
 * @returns {object} Regime info
 */
function detectVolRegime(returns, lookback = 21) {
  if (returns.length < lookback * 2) {
    return { regime: "unknown", recentVol: 0, longTermVol: 0, volRatio: 1 };
  }

  const recentReturns = returns.slice(-lookback);
  const recentVol = stddev(recentReturns) * Math.sqrt(252);
  const longTermVol = stddev(returns) * Math.sqrt(252);
  const volRatio = recentVol / longTermVol;

  let regime;
  if (volRatio > 1.5) regime = "crisis";
  else if (volRatio > 1.2) regime = "high";
  else if (volRatio > 0.8) regime = "normal";
  else regime = "low";

  // Check for vol clustering (autocorrelation of squared returns)
  const squaredRecent = recentReturns.map(r => r * r);
  let volClustering = 0;
  for (let i = 1; i < squaredRecent.length; i++) {
    volClustering += squaredRecent[i] * squaredRecent[i - 1];
  }
  volClustering /= (squaredRecent.length - 1);
  const avgSquared = mean(squaredRecent.map(r => r * r));
  const clusterRatio = avgSquared > 0 ? volClustering / avgSquared : 0;

  return {
    regime,
    recentVol: +recentVol.toFixed(4),
    longTermVol: +longTermVol.toFixed(4),
    volRatio: +volRatio.toFixed(4),
    volClustering: +clusterRatio.toFixed(4),
  };
}

// ─── Dynamic Hedge Ratio ────────────────────────────────

/**
 * Compute dynamic hedge ratio based on current risk level and regime.
 * @param {object} tailRisk - Output from computeTailRisk()
 * @param {object} regime - Output from detectVolRegime()
 * @param {object} [config] - Override thresholds
 * @returns {object} Hedge ratio recommendation
 */
function dynamicHedgeRatio(tailRisk, regime, config = {}) {
  const {
    baseHedge = 0.20,        // 20% base hedge in normal conditions
    maxHedge = 0.80,         // never hedge more than 80%
    minHedge = 0.05,         // always keep at least 5% hedge
    varThreshold95 = 0.02,   // VaR level that triggers concern
    cvarMultiple = 1.5,      // CVaR/VaR ratio that signals fat tails
  } = config;

  let ratio = baseHedge;
  const reasons = [];

  // Adjust for regime
  switch (regime.regime) {
    case "crisis":
      ratio *= 2.5;
      reasons.push(`Crisis regime (vol ratio ${regime.volRatio}): +150% hedge`);
      break;
    case "high":
      ratio *= 1.5;
      reasons.push(`High-vol regime (vol ratio ${regime.volRatio}): +50% hedge`);
      break;
    case "normal":
      reasons.push("Normal regime: base hedge");
      break;
    case "low":
      ratio *= 0.7;
      reasons.push(`Low-vol regime (vol ratio ${regime.volRatio}): -30% hedge`);
      break;
  }

  // Adjust for absolute tail risk
  if (tailRisk.var95 > varThreshold95) {
    const varAdj = tailRisk.var95 / varThreshold95;
    ratio *= varAdj;
    reasons.push(`VaR95 elevated (${(tailRisk.var95 * 100).toFixed(2)}%): +${((varAdj - 1) * 100).toFixed(0)}% hedge`);
  }

  // Adjust for fat tails
  if (tailRisk.tailRatio > cvarMultiple) {
    ratio *= 1.3;
    reasons.push(`Fat tails detected (CVaR/VaR ratio ${tailRisk.tailRatio.toFixed(2)}): +30% hedge`);
  }

  // Adjust for negative skew
  if (tailRisk.skewness < -0.5) {
    ratio *= 1.2;
    reasons.push(`Negative skew (${tailRisk.skewness.toFixed(2)}): +20% hedge`);
  }

  // Adjust for excess kurtosis
  if (tailRisk.kurtosis > 3) {
    ratio *= 1.15;
    reasons.push(`High kurtosis (${tailRisk.kurtosis.toFixed(2)}): +15% hedge`);
  }

  // Clamp to bounds
  ratio = Math.max(minHedge, Math.min(maxHedge, ratio));

  return {
    hedgeRatio: +ratio.toFixed(4),
    reasons,
    regime: regime.regime,
    riskLevel: ratio > 0.5 ? "high" : ratio > 0.3 ? "elevated" : ratio > 0.15 ? "moderate" : "low",
  };
}

// ─── Hedge Efficiency Tracking ──────────────────────────

/**
 * Evaluate the efficiency of a hedge position.
 * @param {object} params
 * @param {number} params.hedgeCost - Total cost paid for hedges
 * @param {number} params.portfolioValue - Total portfolio value
 * @param {number} params.protectionProvided - Dollar value of downside protection
 * @param {number} params.periodDays - Holding period in days
 * @returns {object} Efficiency metrics
 */
function evaluateHedgeEfficiency({ hedgeCost, portfolioValue, protectionProvided, periodDays }) {
  const costBps = (hedgeCost / portfolioValue) * 10000;
  const protectionBps = (protectionProvided / portfolioValue) * 10000;
  const ratio = hedgeCost > 0 ? protectionProvided / hedgeCost : 0;
  const annualizedCostBps = costBps * (365 / periodDays);

  let verdict;
  if (ratio >= 5) verdict = "excellent";
  else if (ratio >= 3) verdict = "good";
  else if (ratio >= 1.5) verdict = "acceptable";
  else if (ratio >= 1) verdict = "marginal";
  else verdict = "poor";

  return {
    costBps: +costBps.toFixed(1),
    protectionBps: +protectionBps.toFixed(1),
    protectionToCostRatio: +ratio.toFixed(2),
    annualizedCostBps: +annualizedCostBps.toFixed(1),
    verdict,
  };
}

// ─── Hedge Recommendation ───────────────────────────────

/**
 * Generate a full hedge recommendation given returns, prices, and portfolio details.
 * @param {object} params
 * @param {number[]} params.returns - Daily returns
 * @param {number[]} [params.prices] - Price series (for drawdown)
 * @param {number} params.spotPrice - Current underlying price
 * @param {number} params.portfolioValue - Total portfolio value
 * @param {number} [params.daysToExpiry=30] - Option expiry
 * @param {number} [params.riskFreeRate=0.05] - Risk-free rate
 * @returns {object} Full recommendation
 */
export function getHedgeRecommendation({
  returns,
  prices = null,
  spotPrice,
  portfolioValue,
  daysToExpiry = 30,
  riskFreeRate = 0.05,
} = {}) {
  // 1. Measure tail risk
  const tailRisk = computeTailRisk(returns, prices);

  // 2. Detect regime
  const regime = detectVolRegime(returns);

  // 3. Compute dynamic hedge ratio
  const hedgeRec = dynamicHedgeRatio(tailRisk, regime);

  // Use realized vol as proxy for implied vol, with a regime-dependent skew premium
  let impliedVol = tailRisk.annualVol;
  if (regime.regime === "crisis") impliedVol *= 1.3;
  else if (regime.regime === "high") impliedVol *= 1.15;
  impliedVol = Math.max(0.10, Math.min(1.0, impliedVol));

  // 4. Price hedges at multiple OTM levels
  const otmLevels = [0.03, 0.05, 0.10, 0.15];
  const hedgeOptions = otmLevels.map(otm => {
    const cost = estimateHedgeCost({
      spotPrice,
      portfolioValue,
      hedgeRatio: hedgeRec.hedgeRatio,
      otmPercent: otm,
      daysToExpiry,
      impliedVol,
      riskFreeRate,
    });
    return { otmPercent: otm, ...cost };
  });

  // 5. Select recommended hedge (balance cost and protection)
  // Prefer 5% OTM as default, but switch to tighter in crisis
  let recommendedIdx = 1; // 5% OTM default
  if (regime.regime === "crisis") recommendedIdx = 0; // 3% OTM in crisis
  else if (regime.regime === "low") recommendedIdx = 2; // 10% OTM in low vol
  const recommended = hedgeOptions[recommendedIdx];

  // 6. Evaluate efficiency of recommended hedge
  const efficiency = evaluateHedgeEfficiency({
    hedgeCost: recommended.totalCost,
    portfolioValue,
    protectionProvided: recommended.maxProtection,
    periodDays: daysToExpiry,
  });

  return {
    summary: {
      regime: regime.regime,
      riskLevel: hedgeRec.riskLevel,
      hedgeRatio: hedgeRec.hedgeRatio,
      recommendedOTM: recommended.otmPercent,
      estimatedCost: recommended.totalCost,
      costAsPercentOfPortfolio: recommended.costAsPercentOfPortfolio,
      annualizedCostPercent: recommended.annualizedCost,
      hedgeEfficiency: efficiency.verdict,
    },
    tailRisk,
    regime,
    hedgeRatio: hedgeRec,
    recommended,
    allOptions: hedgeOptions,
    efficiency,
  };
}

// ─── TailHedger Class ───────────────────────────────────

/**
 * Stateful tail hedger that tracks portfolio risk and recommends hedges.
 */
export class TailHedger {
  /**
   * @param {object} config
   * @param {number} config.portfolioValue - Total portfolio value
   * @param {number} config.spotPrice - Current price of the hedge instrument
   * @param {number} [config.riskFreeRate=0.05] - Risk-free rate
   * @param {number} [config.daysToExpiry=30] - Default option horizon
   * @param {object} [config.hedgeConfig] - Override dynamic hedge ratio thresholds
   */
  constructor({
    portfolioValue,
    spotPrice,
    riskFreeRate = 0.05,
    daysToExpiry = 30,
    hedgeConfig = {},
  } = {}) {
    this.portfolioValue = portfolioValue;
    this.spotPrice = spotPrice;
    this.riskFreeRate = riskFreeRate;
    this.daysToExpiry = daysToExpiry;
    this.hedgeConfig = hedgeConfig;
    this.returns = [];
    this.prices = [];
    this.hedgeHistory = [];
  }

  /**
   * Ingest daily returns (array of numbers).
   */
  addReturns(dailyReturns) {
    this.returns.push(...dailyReturns);
  }

  /**
   * Ingest daily close prices (array of numbers).
   */
  addPrices(closePrices) {
    this.prices.push(...closePrices);
    // Also derive returns from prices if returns are empty
    if (this.returns.length === 0 && closePrices.length > 1) {
      this.returns = computeReturns(closePrices);
    }
  }

  /** Update the current spot price. */
  updateSpot(price) {
    this.spotPrice = price;
  }

  /** Update portfolio value. */
  updatePortfolioValue(value) {
    this.portfolioValue = value;
  }

  /**
   * Get current tail risk metrics.
   */
  getTailRisk() {
    if (this.returns.length < 10) {
      throw new Error("Need at least 10 return observations for tail risk metrics");
    }
    return computeTailRisk(this.returns, this.prices.length > 0 ? this.prices : null);
  }

  /**
   * Get current volatility regime.
   */
  getRegime() {
    return detectVolRegime(this.returns);
  }

  /**
   * Get full hedge recommendation.
   */
  recommend() {
    if (this.returns.length < 10) {
      throw new Error("Need at least 10 return observations for hedge recommendation");
    }
    const rec = getHedgeRecommendation({
      returns: this.returns,
      prices: this.prices.length > 0 ? this.prices : null,
      spotPrice: this.spotPrice,
      portfolioValue: this.portfolioValue,
      daysToExpiry: this.daysToExpiry,
      riskFreeRate: this.riskFreeRate,
    });

    // Track recommendation history
    this.hedgeHistory.push({
      timestamp: new Date().toISOString(),
      regime: rec.summary.regime,
      hedgeRatio: rec.summary.hedgeRatio,
      estimatedCost: rec.summary.estimatedCost,
    });

    return rec;
  }

  /**
   * Price a specific put option.
   */
  priceOption({ strike = null, otmPercent = 0.05, daysToExpiry = null, impliedVol = null } = {}) {
    const K = strike || this.spotPrice * (1 - otmPercent);
    const T = (daysToExpiry || this.daysToExpiry) / 365;
    const sigma = impliedVol || (this.returns.length > 20 ? stddev(this.returns) * Math.sqrt(252) : 0.20);
    const price = blackScholesPut(this.spotPrice, K, T, this.riskFreeRate, sigma);
    const greeks = putGreeks(this.spotPrice, K, T, this.riskFreeRate, sigma);
    return { putPrice: +price.toFixed(4), strike: +K.toFixed(2), greeks, sigma: +sigma.toFixed(4) };
  }

  /**
   * Get hedge history for tracking purposes.
   */
  getHistory() {
    return this.hedgeHistory;
  }
}

// ─── CLI Demo ───────────────────────────────────────────

function formatPercent(v) {
  return (v * 100).toFixed(2) + "%";
}

function formatDollar(v) {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const args = process.argv.slice(2);
  const symbolArg = args.find((_, i) => args[i - 1] === "--symbol") || "SPY";
  const capitalArg = parseFloat(args.find((_, i) => args[i - 1] === "--capital") || "100000");
  const confidenceArg = parseFloat(args.find((_, i) => args[i - 1] === "--confidence") || "0.95");

  console.log("=".repeat(70));
  console.log("  TAIL RISK HEDGER — Risk Measurement & Hedge Recommendation");
  console.log("=".repeat(70));
  console.log();

  // Generate synthetic price data
  const priceData = generateRealisticPrices(symbolArg, "2022-01-01", "2025-12-31");
  const closePrices = priceData.map(d => d.close);
  const returns = computeReturns(closePrices);
  const spotPrice = closePrices[closePrices.length - 1];

  console.log(`  Symbol:          ${symbolArg}`);
  console.log(`  Portfolio Value:  ${formatDollar(capitalArg)}`);
  console.log(`  Data Points:     ${priceData.length} trading days`);
  console.log(`  Current Price:   ${formatDollar(spotPrice)}`);
  console.log();

  // ── Tail Risk Metrics ──
  console.log("-".repeat(70));
  console.log("  TAIL RISK METRICS");
  console.log("-".repeat(70));
  const risk = computeTailRisk(returns, closePrices);
  console.log(`  VaR (95%):           ${formatPercent(risk.var95)}   (1-day)`);
  console.log(`  VaR (99%):           ${formatPercent(risk.var99)}   (1-day)`);
  console.log(`  CVaR/ES (95%):       ${formatPercent(risk.cvar95)}   (1-day)`);
  console.log(`  CVaR/ES (99%):       ${formatPercent(risk.cvar99)}   (1-day)`);
  console.log(`  Max Single-Day Loss: ${formatPercent(risk.maxSingleDayLoss)}`);
  console.log(`  Max Drawdown:        ${formatPercent(risk.maxDrawdown)}`);
  console.log(`  Annualized Vol:      ${formatPercent(risk.annualVol)}`);
  console.log(`  Skewness:            ${risk.skewness.toFixed(4)}`);
  console.log(`  Excess Kurtosis:     ${risk.kurtosis.toFixed(4)}`);
  console.log(`  Tail Ratio (CVaR99/VaR99): ${risk.tailRatio.toFixed(4)}`);
  console.log();

  // ── Regime Detection ──
  console.log("-".repeat(70));
  console.log("  VOLATILITY REGIME");
  console.log("-".repeat(70));
  const regime = detectVolRegime(returns);
  console.log(`  Current Regime:  ${regime.regime.toUpperCase()}`);
  console.log(`  Recent Vol:      ${formatPercent(regime.recentVol)} (ann.)`);
  console.log(`  Long-Term Vol:   ${formatPercent(regime.longTermVol)} (ann.)`);
  console.log(`  Vol Ratio:       ${regime.volRatio.toFixed(4)}`);
  console.log();

  // ── Full Hedge Recommendation ──
  console.log("-".repeat(70));
  console.log("  HEDGE RECOMMENDATION");
  console.log("-".repeat(70));
  const rec = getHedgeRecommendation({
    returns,
    prices: closePrices,
    spotPrice,
    portfolioValue: capitalArg,
  });

  console.log(`  Risk Level:       ${rec.summary.riskLevel.toUpperCase()}`);
  console.log(`  Hedge Ratio:      ${formatPercent(rec.summary.hedgeRatio)}`);
  console.log(`  Recommended OTM:  ${formatPercent(rec.summary.recommendedOTM)}`);
  console.log(`  Put Strike:       ${formatDollar(rec.recommended.strike)}`);
  console.log(`  Put Price:        ${formatDollar(rec.recommended.putPrice)}`);
  console.log(`  Contracts:        ${rec.recommended.contracts}`);
  console.log(`  Total Cost:       ${formatDollar(rec.summary.estimatedCost)}`);
  console.log(`  Cost (% of port): ${rec.summary.costAsPercentOfPortfolio}%`);
  console.log(`  Annualized Cost:  ${rec.summary.annualizedCostPercent}%`);
  console.log(`  Hedge Efficiency: ${rec.efficiency.verdict.toUpperCase()}`);
  console.log();

  // ── Adjustment Rationale ──
  console.log("  Adjustment Rationale:");
  for (const reason of rec.hedgeRatio.reasons) {
    console.log(`    - ${reason}`);
  }
  console.log();

  // ── All OTM Options ──
  console.log("-".repeat(70));
  console.log("  PUT OPTIONS MENU (30-day expiry)");
  console.log("-".repeat(70));
  console.log(`  ${"OTM".padEnd(8)} ${"Strike".padEnd(12)} ${"Put $".padEnd(10)} ${"Contracts".padEnd(11)} ${"Total Cost".padEnd(14)} ${"Cost %".padEnd(10)} ${"Delta".padEnd(8)}`);
  for (const opt of rec.allOptions) {
    const mark = opt.otmPercent === rec.summary.recommendedOTM ? " <--" : "";
    console.log(
      `  ${formatPercent(opt.otmPercent).padEnd(8)} ` +
      `${formatDollar(opt.strike).padEnd(12)} ` +
      `${formatDollar(opt.putPrice).padEnd(10)} ` +
      `${String(opt.contracts).padEnd(11)} ` +
      `${formatDollar(opt.totalCost).padEnd(14)} ` +
      `${opt.costAsPercentOfPortfolio.toFixed(2).padEnd(10)} ` +
      `${opt.greeks.delta.toFixed(3).padEnd(8)}` +
      mark
    );
  }
  console.log();

  // ── TailHedger Class Demo ──
  console.log("-".repeat(70));
  console.log("  TAILHEDGER CLASS DEMO");
  console.log("-".repeat(70));
  const hedger = new TailHedger({
    portfolioValue: capitalArg,
    spotPrice,
  });
  hedger.addPrices(closePrices);

  const classRec = hedger.recommend();
  console.log(`  Class-based recommendation matches: ${classRec.summary.regime === rec.summary.regime ? "YES" : "NO"}`);

  const optionPrice = hedger.priceOption({ otmPercent: 0.05 });
  console.log(`  Custom option pricing: 5% OTM put = ${formatDollar(optionPrice.putPrice)} (delta: ${optionPrice.greeks.delta.toFixed(3)})`);
  console.log();

  console.log("=".repeat(70));
  console.log("  Done. Export TailHedger, computeTailRisk, estimateHedgeCost,");
  console.log("  getHedgeRecommendation for use in other modules.");
  console.log("=".repeat(70));
}

// Run CLI if called directly
const isMain = process.argv[1] && (
  process.argv[1].includes("tail-hedger.mjs") ||
  process.argv[1].includes("tail-hedger")
);

if (isMain) {
  main().catch(err => {
    console.error("Tail hedger failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
