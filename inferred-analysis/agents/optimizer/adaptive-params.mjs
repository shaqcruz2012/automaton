#!/usr/bin/env node
/**
 * Adaptive Parameter Scheduler — Inferred Analysis
 *
 * Dynamically adjusts strategy parameters based on recent performance.
 * Implements multiple adaptation methods:
 * - Exponential decay toward defaults during drawdowns
 * - Performance-based parameter expansion during winning streaks
 * - Regime-conditional parameter sets
 * - Bayesian online parameter updates
 *
 * Usage:
 *   node agents/optimizer/adaptive-params.mjs
 *   import { AdaptiveScheduler, bayesianUpdate } from './adaptive-params.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Adaptive Scheduler ─────────────────────────────────

export class AdaptiveScheduler {
  constructor(baseParams, options = {}) {
    this.baseParams = { ...baseParams };
    this.currentParams = { ...baseParams };
    this.history = []; // { date, params, return, sharpe }
    this.windowSize = options.windowSize || 21;
    this.adaptRate = options.adaptRate || 0.05;
    this.minScale = options.minScale || 0.3;
    this.maxScale = options.maxScale || 3.0;
    this.drawdownThreshold = options.drawdownThreshold || 0.05;
    this.streakThreshold = options.streakThreshold || 5;
  }

  /**
   * Update parameters based on recent performance.
   * Returns new parameter set.
   */
  update(dailyReturn, equity, peakEquity) {
    const drawdown = (peakEquity - equity) / peakEquity;
    const recentReturns = this.history.slice(-this.windowSize).map(h => h.ret);

    // Method 1: Drawdown decay — pull params toward conservative defaults
    if (drawdown > this.drawdownThreshold) {
      const severity = Math.min(drawdown / 0.20, 1); // normalize to 0-1
      this._decayToDefaults(severity);
    }

    // Method 2: Winning streak expansion
    const streak = this._currentStreak(recentReturns);
    if (streak >= this.streakThreshold) {
      const expansion = 1 + (streak - this.streakThreshold) * 0.02;
      this._expandParams(Math.min(expansion, 1.3));
    }

    // Method 3: Volatility-adaptive sizing
    if (recentReturns.length >= 5) {
      const recentVol = this._std(recentReturns) * Math.sqrt(252);
      const baseVol = 0.15; // assumed baseline annual vol
      const volRatio = baseVol / Math.max(recentVol, 0.01);
      this.currentParams.positionSize = this.baseParams.positionSize * Math.max(this.minScale, Math.min(this.maxScale, volRatio));
    }

    this.history.push({
      date: new Date().toISOString().split("T")[0],
      params: { ...this.currentParams },
      ret: dailyReturn,
      equity,
      drawdown,
    });

    return { ...this.currentParams };
  }

  /**
   * Get regime-conditional parameters.
   */
  getRegimeParams(regime) {
    const regimeAdjustments = {
      high_vol: {
        positionSize: this.baseParams.positionSize * 0.5,
        stopLoss: this.baseParams.stopLoss * 0.7,
        threshold: this.baseParams.threshold * 1.5,
      },
      low_vol: {
        positionSize: this.baseParams.positionSize * 1.3,
        stopLoss: this.baseParams.stopLoss * 1.2,
        threshold: this.baseParams.threshold * 0.7,
      },
      trending: {
        positionSize: this.baseParams.positionSize * 1.2,
        lookback: Math.round(this.baseParams.lookback * 1.5),
        threshold: this.baseParams.threshold * 0.8,
      },
      mean_reverting: {
        positionSize: this.baseParams.positionSize * 0.8,
        lookback: Math.round(this.baseParams.lookback * 0.6),
        threshold: this.baseParams.threshold * 1.3,
      },
    };

    const adj = regimeAdjustments[regime];
    if (!adj) return { ...this.currentParams };
    return { ...this.currentParams, ...adj };
  }

  /**
   * Get parameter sensitivity report.
   */
  getSensitivity() {
    if (this.history.length < 20) return null;

    const report = {};
    for (const param of Object.keys(this.baseParams)) {
      if (typeof this.baseParams[param] !== "number") continue;

      const paramValues = this.history.map(h => h.params[param]);
      const returns = this.history.map(h => h.ret);

      report[param] = {
        current: this.currentParams[param],
        base: this.baseParams[param],
        ratio: this.currentParams[param] / this.baseParams[param],
        correlation: this._correlation(paramValues, returns),
      };
    }
    return report;
  }

  _decayToDefaults(severity) {
    const rate = this.adaptRate * severity;
    for (const key of Object.keys(this.baseParams)) {
      if (typeof this.baseParams[key] !== "number") continue;
      this.currentParams[key] = this.currentParams[key] * (1 - rate) + this.baseParams[key] * rate;
    }
  }

  _expandParams(factor) {
    const riskParams = ["positionSize", "takeProfit"];
    for (const key of riskParams) {
      if (this.currentParams[key] !== undefined) {
        const expanded = this.currentParams[key] * factor;
        const maxVal = this.baseParams[key] * this.maxScale;
        this.currentParams[key] = Math.min(expanded, maxVal);
      }
    }
  }

  _currentStreak(returns) {
    let streak = 0;
    for (let i = returns.length - 1; i >= 0; i--) {
      if (returns[i] > 0) streak++;
      else break;
    }
    return streak;
  }

  _std(arr) {
    const n = arr.length;
    if (n < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  }

  _correlation(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 3) return 0;
    const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
    let cov = 0, sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      cov += (x[i] - mx) * (y[i] - my);
      sx += (x[i] - mx) ** 2;
      sy += (y[i] - my) ** 2;
    }
    const denom = Math.sqrt(sx * sy);
    return denom > 0 ? cov / denom : 0;
  }
}

// ─── Bayesian Online Parameter Update ───────────────────

/**
 * Simple Bayesian update for a parameter with Gaussian prior.
 * Returns updated mean and variance.
 */
export function bayesianUpdate(priorMean, priorVar, observation, obsVar) {
  const k = priorVar / (priorVar + obsVar); // Kalman gain
  const posteriorMean = priorMean + k * (observation - priorMean);
  const posteriorVar = (1 - k) * priorVar;
  return { mean: posteriorMean, variance: posteriorVar };
}

/**
 * Multi-parameter Bayesian optimizer.
 * Maintains beliefs about optimal parameter values.
 */
export class BayesianParamOptimizer {
  constructor(paramSpecs) {
    // paramSpecs: { paramName: { mean, variance, minVal, maxVal } }
    this.beliefs = {};
    for (const [name, spec] of Object.entries(paramSpecs)) {
      this.beliefs[name] = {
        mean: spec.mean,
        variance: spec.variance || (spec.mean * 0.3) ** 2,
        min: spec.minVal ?? -Infinity,
        max: spec.maxVal ?? Infinity,
      };
    }
    this.observations = [];
  }

  /**
   * Update beliefs based on observed performance with given params.
   */
  observe(params, performance) {
    this.observations.push({ params: { ...params }, performance });

    for (const [name, belief] of Object.entries(this.beliefs)) {
      if (params[name] === undefined) continue;

      // Performance-weighted update: if performance is good, move belief toward used value
      const obsVar = belief.variance * (1 + Math.exp(-performance * 10));
      const updated = bayesianUpdate(belief.mean, belief.variance, params[name], obsVar);
      belief.mean = Math.max(belief.min, Math.min(belief.max, updated.mean));
      belief.variance = Math.max(updated.variance, (belief.mean * 0.01) ** 2); // floor variance
    }
  }

  /**
   * Sample a parameter set from current beliefs (for exploration).
   */
  sample() {
    const params = {};
    for (const [name, belief] of Object.entries(this.beliefs)) {
      // Sample from Gaussian, clamp to bounds
      const std = Math.sqrt(belief.variance);
      const u1 = Math.random() * 0.9998 + 0.0001;
      const u2 = Math.random() * 0.9998 + 0.0001;
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const value = belief.mean + z * std;
      params[name] = Math.max(belief.min, Math.min(belief.max, value));
    }
    return params;
  }

  /**
   * Get MAP (maximum a posteriori) parameter estimates.
   */
  getMAP() {
    const params = {};
    for (const [name, belief] of Object.entries(this.beliefs)) {
      params[name] = belief.mean;
    }
    return params;
  }

  /**
   * Get confidence intervals for each parameter.
   */
  getConfidence(level = 0.95) {
    const z = level === 0.99 ? 2.576 : level === 0.95 ? 1.96 : 1.645;
    const result = {};
    for (const [name, belief] of Object.entries(this.beliefs)) {
      const std = Math.sqrt(belief.variance);
      result[name] = {
        mean: belief.mean,
        lower: belief.mean - z * std,
        upper: belief.mean + z * std,
        std,
      };
    }
    return result;
  }
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Adaptive Parameter Scheduler Demo ═══\n");

  const baseParams = {
    lookback: 20,
    threshold: 0.02,
    stopLoss: -0.05,
    takeProfit: 0.10,
    positionSize: 0.10,
  };

  const scheduler = new AdaptiveScheduler(baseParams, {
    windowSize: 21,
    adaptRate: 0.08,
    drawdownThreshold: 0.03,
  });

  // Simulate trading with adaptive params
  const prices = generateRealisticPrices("SPY", "2023-01-01", "2024-01-01");
  let equity = 1_000_000;
  let peak = equity;

  console.log("Simulating 1 year with adaptive parameters...\n");

  for (let i = 1; i < prices.length; i++) {
    const ret = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;
    equity *= (1 + ret * baseParams.positionSize);
    if (equity > peak) peak = equity;

    const newParams = scheduler.update(ret, equity, peak);

    // Log every 50 days
    if (i % 50 === 0) {
      const dd = ((peak - equity) / peak * 100).toFixed(1);
      console.log(`Day ${i}: equity=$${equity.toFixed(0)}, drawdown=${dd}%, posSize=${newParams.positionSize.toFixed(4)}, threshold=${newParams.threshold.toFixed(4)}`);
    }
  }

  // Sensitivity report
  const sensitivity = scheduler.getSensitivity();
  if (sensitivity) {
    console.log("\n─── Parameter Sensitivity ───");
    for (const [param, data] of Object.entries(sensitivity)) {
      console.log(`  ${param.padEnd(14)} base=${data.base.toFixed(4)} current=${data.current.toFixed(4)} ratio=${data.ratio.toFixed(2)} corr=${data.correlation.toFixed(3)}`);
    }
  }

  // Regime parameters
  console.log("\n─── Regime-Conditional Parameters ───");
  for (const regime of ["high_vol", "low_vol", "trending", "mean_reverting"]) {
    const rp = scheduler.getRegimeParams(regime);
    console.log(`  ${regime.padEnd(16)} posSize=${rp.positionSize.toFixed(4)} threshold=${rp.threshold.toFixed(4)} lookback=${rp.lookback || baseParams.lookback}`);
  }

  // Bayesian optimizer demo
  console.log("\n═══ Bayesian Parameter Optimizer Demo ═══\n");

  const optimizer = new BayesianParamOptimizer({
    lookback: { mean: 20, minVal: 5, maxVal: 100 },
    threshold: { mean: 0.02, minVal: 0.001, maxVal: 0.10, variance: 0.005 ** 2 },
    positionSize: { mean: 0.10, minVal: 0.01, maxVal: 0.50, variance: 0.03 ** 2 },
  });

  // Simulate 20 experiments
  for (let i = 0; i < 20; i++) {
    const params = optimizer.sample();
    // Fake performance: better when lookback is ~15, threshold ~0.015, posSize ~0.08
    const perf = -Math.abs(params.lookback - 15) / 50
      - Math.abs(params.threshold - 0.015) * 20
      - Math.abs(params.positionSize - 0.08) * 5
      + (Math.random() - 0.5) * 0.1;
    optimizer.observe(params, perf);
  }

  const mapParams = optimizer.getMAP();
  console.log("MAP estimates after 20 experiments:");
  for (const [k, v] of Object.entries(mapParams)) {
    console.log(`  ${k.padEnd(14)} = ${v.toFixed(4)}`);
  }

  const ci = optimizer.getConfidence(0.95);
  console.log("\n95% Confidence Intervals:");
  for (const [k, v] of Object.entries(ci)) {
    console.log(`  ${k.padEnd(14)} ${v.lower.toFixed(4)} — ${v.mean.toFixed(4)} — ${v.upper.toFixed(4)}`);
  }
}

if (process.argv[1]?.includes("adaptive-params")) {
  main().catch(console.error);
}
