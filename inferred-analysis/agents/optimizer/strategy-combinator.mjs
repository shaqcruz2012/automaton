#!/usr/bin/env node
/**
 * Strategy Combinatorics Engine — Inferred Analysis
 *
 * Exhaustive and smart parameter search for trading strategies:
 * 1. Grid search: exhaustive parameter combinations
 * 2. Random search: sample from parameter distributions
 * 3. Latin Hypercube sampling: space-filling parameter exploration
 * 4. Successive halving (Hyperband): fast parameter elimination
 * 5. Parameter sensitivity analysis: which params matter most
 * 6. Interaction effects: detect parameter combinations that work together
 *
 * Usage:
 *   node agents/optimizer/strategy-combinator.mjs
 *   import { StrategyCombinator, gridSearch, randomSearch, hyperband, sensitivityAnalysis } from './strategy-combinator.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Top-K Result Tracker ────────────────────────────────

/**
 * Maintains a deduplicated leaderboard of the best K results.
 * Deduplication uses a configurable key function (defaults to parameter hash).
 */
class TopKTracker {
  constructor(k = 10, keyFn = null) {
    this.k = k;
    this.results = [];
    this.seen = new Set();
    this.keyFn = keyFn || TopKTracker.defaultKey;
  }

  static defaultKey(params) {
    return Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${typeof v === "number" ? v.toFixed(6) : v}`)
      .join("|");
  }

  add(params, fitness, meta = {}) {
    const key = this.keyFn(params);
    if (this.seen.has(key)) return false;
    this.seen.add(key);

    this.results.push({ params: { ...params }, fitness, meta, key });
    this.results.sort((a, b) => b.fitness - a.fitness);

    if (this.results.length > this.k) {
      const removed = this.results.pop();
      this.seen.delete(removed.key);
    }
    return true;
  }

  best() {
    return this.results[0] || null;
  }

  top(n) {
    return this.results.slice(0, n);
  }

  get length() {
    return this.results.length;
  }
}

// ─── Backtest Fitness (from template.js pattern) ────────

/**
 * Default momentum-based backtest fitness function.
 * Accepts a parameter object and price array, returns Sharpe ratio.
 */
function defaultFitness(params, prices) {
  const lookback = Math.round(params.lookback || 20);
  const threshold = params.threshold || 0.02;
  const positionSize = params.positionSize || 0.10;
  const transactionCostBps = 15; // 10 cost + 5 slippage

  // Generate signals
  const signals = [];
  for (let i = lookback; i < prices.length; i++) {
    const current = prices[i].close;
    const past = prices[i - lookback].close;
    const ret = (current - past) / past;
    let signal = 0;
    if (ret > threshold) signal = 1;
    if (ret < -threshold) signal = -1;
    signals.push({ price: current, signal });
  }

  // Run backtest
  let capital = 1_000_000;
  let position = 0;
  let prevSignal = 0;
  let trades = 0;
  const dailyReturns = [];
  let prevEquity = capital;
  let peakEquity = capital;
  let maxDrawdown = 0;

  for (const sig of signals) {
    if (sig.signal !== prevSignal) {
      if (position !== 0) {
        const proceeds = position * sig.price;
        const cost = Math.abs(proceeds) * (transactionCostBps / 10000);
        capital += proceeds - cost;
        position = 0;
        trades++;
      }
      if (sig.signal !== 0) {
        const tradeSize = capital * positionSize;
        const cost = tradeSize * (transactionCostBps / 10000);
        position = (sig.signal * (tradeSize - cost)) / sig.price;
        capital -= tradeSize;
        trades++;
      }
      prevSignal = sig.signal;
    }

    const equity = capital + position * sig.price;
    const dailyReturn = (equity - prevEquity) / prevEquity;
    dailyReturns.push(dailyReturn);
    prevEquity = equity;

    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  if (position !== 0 && signals.length > 0) {
    capital += position * signals[signals.length - 1].price;
  }

  const n = dailyReturns.length;
  if (n < 20) return -10;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(
    dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)
  );
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // Penalize excessive trading
  const tradePenalty = trades > 500 ? (trades - 500) * 0.001 : 0;

  return sharpe - tradePenalty;
}

// ─── Cartesian Product Helper ───────────────────────────

function cartesianProduct(arrays) {
  if (arrays.length === 0) return [[]];
  return arrays.reduce(
    (acc, arr) => acc.flatMap((combo) => arr.map((val) => [...combo, val])),
    [[]]
  );
}

// ─── 1. Grid Search ─────────────────────────────────────

/**
 * Exhaustive grid search over all parameter combinations.
 *
 * @param {Object} paramRanges - { paramName: { min, max, steps, integer? } }
 * @param {Function} fitnessFn - (params, prices) => number
 * @param {Array} prices - OHLCV price data
 * @param {Object} opts - { topK, onEval, parallel }
 * @returns {{ results: TopKTracker, totalEvaluations: number, elapsed: number }}
 */
export function gridSearch(paramRanges, fitnessFn, prices, opts = {}) {
  const topK = opts.topK || 20;
  const onEval = opts.onEval || null;
  const tracker = new TopKTracker(topK);

  // Build value grids per parameter
  const paramNames = Object.keys(paramRanges);
  const grids = paramNames.map((name) => {
    const spec = paramRanges[name];
    const steps = spec.steps || 5;
    const values = [];
    for (let i = 0; i < steps; i++) {
      let val = spec.min + (i / (steps - 1)) * (spec.max - spec.min);
      if (spec.integer) val = Math.round(val);
      values.push(val);
    }
    // Deduplicate (integer rounding can create duplicates)
    return [...new Set(values)];
  });

  const totalCombos = grids.reduce((p, g) => p * g.length, 1);
  const combos = cartesianProduct(grids);

  const start = Date.now();
  let evaluated = 0;

  for (const combo of combos) {
    const params = {};
    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]] = combo[i];
    }

    const fitness = fitnessFn(params, prices);
    tracker.add(params, fitness, { method: "grid" });
    evaluated++;

    if (onEval) onEval(evaluated, totalCombos, params, fitness);
  }

  return {
    results: tracker,
    totalEvaluations: evaluated,
    elapsed: Date.now() - start,
  };
}

// ─── 2. Random Search ───────────────────────────────────

/**
 * Random search: sample from parameter distributions.
 * Supports uniform and log-uniform sampling.
 *
 * @param {Object} paramRanges - { paramName: { min, max, integer?, logScale? } }
 * @param {Function} fitnessFn - (params, prices) => number
 * @param {Array} prices - OHLCV price data
 * @param {Object} opts - { nSamples, topK, onEval }
 * @returns {{ results: TopKTracker, totalEvaluations: number, elapsed: number }}
 */
export function randomSearch(paramRanges, fitnessFn, prices, opts = {}) {
  const nSamples = opts.nSamples || 200;
  const topK = opts.topK || 20;
  const onEval = opts.onEval || null;
  const tracker = new TopKTracker(topK);

  const paramNames = Object.keys(paramRanges);
  const start = Date.now();

  for (let s = 0; s < nSamples; s++) {
    const params = {};
    for (const name of paramNames) {
      const spec = paramRanges[name];
      let val;
      if (spec.logScale && spec.min > 0) {
        // Log-uniform sampling
        const logMin = Math.log(spec.min);
        const logMax = Math.log(spec.max);
        val = Math.exp(logMin + Math.random() * (logMax - logMin));
      } else {
        val = spec.min + Math.random() * (spec.max - spec.min);
      }
      if (spec.integer) val = Math.round(val);
      params[name] = val;
    }

    const fitness = fitnessFn(params, prices);
    tracker.add(params, fitness, { method: "random", sample: s });

    if (onEval) onEval(s + 1, nSamples, params, fitness);
  }

  return {
    results: tracker,
    totalEvaluations: nSamples,
    elapsed: Date.now() - start,
  };
}

// ─── 3. Latin Hypercube Sampling ────────────────────────

/**
 * Latin Hypercube Sampling (LHS): space-filling parameter exploration.
 * Guarantees each parameter dimension is evenly covered.
 *
 * @param {Object} paramRanges - { paramName: { min, max, integer?, logScale? } }
 * @param {Function} fitnessFn - (params, prices) => number
 * @param {Array} prices - OHLCV price data
 * @param {Object} opts - { nSamples, topK, onEval }
 * @returns {{ results: TopKTracker, totalEvaluations: number, elapsed: number }}
 */
export function latinHypercube(paramRanges, fitnessFn, prices, opts = {}) {
  const nSamples = opts.nSamples || 100;
  const topK = opts.topK || 20;
  const onEval = opts.onEval || null;
  const tracker = new TopKTracker(topK);

  const paramNames = Object.keys(paramRanges);
  const nParams = paramNames.length;

  // Generate LHS design: for each parameter, create n equally-spaced intervals
  // then shuffle the assignment
  const intervals = [];
  for (let p = 0; p < nParams; p++) {
    const perm = fisherYatesShuffle(
      Array.from({ length: nSamples }, (_, i) => i)
    );
    intervals.push(perm);
  }

  const start = Date.now();

  for (let s = 0; s < nSamples; s++) {
    const params = {};
    for (let p = 0; p < nParams; p++) {
      const name = paramNames[p];
      const spec = paramRanges[name];
      // Sample within the assigned interval with random jitter
      const bin = intervals[p][s];
      const u = (bin + Math.random()) / nSamples;

      let val;
      if (spec.logScale && spec.min > 0) {
        const logMin = Math.log(spec.min);
        const logMax = Math.log(spec.max);
        val = Math.exp(logMin + u * (logMax - logMin));
      } else {
        val = spec.min + u * (spec.max - spec.min);
      }
      if (spec.integer) val = Math.round(val);
      params[name] = val;
    }

    const fitness = fitnessFn(params, prices);
    tracker.add(params, fitness, { method: "lhs", sample: s });

    if (onEval) onEval(s + 1, nSamples, params, fitness);
  }

  return {
    results: tracker,
    totalEvaluations: nSamples,
    elapsed: Date.now() - start,
  };
}

function fisherYatesShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── 4. Successive Halving (Hyperband) ──────────────────

/**
 * Hyperband: successive halving for fast parameter elimination.
 * Evaluates many configs cheaply (short data), keeps the best, reruns with more data.
 *
 * @param {Object} paramRanges - { paramName: { min, max, integer?, logScale? } }
 * @param {Function} fitnessFn - (params, prices) => number
 * @param {Array} prices - OHLCV price data
 * @param {Object} opts - { maxConfigs, halvingRounds, eta, topK, onEval }
 * @returns {{ results: TopKTracker, rounds: Array, totalEvaluations: number, elapsed: number }}
 */
export function hyperband(paramRanges, fitnessFn, prices, opts = {}) {
  const maxConfigs = opts.maxConfigs || 81;
  const eta = opts.eta || 3; // reduction factor per round
  const topK = opts.topK || 20;
  const onEval = opts.onEval || null;
  const tracker = new TopKTracker(topK);

  const paramNames = Object.keys(paramRanges);

  // Determine number of halving rounds
  const sMax = Math.floor(Math.log(maxConfigs) / Math.log(eta));
  const rounds = [];
  const start = Date.now();
  let totalEvals = 0;

  // Generate initial random configurations
  let configs = [];
  for (let i = 0; i < maxConfigs; i++) {
    const params = {};
    for (const name of paramNames) {
      const spec = paramRanges[name];
      let val;
      if (spec.logScale && spec.min > 0) {
        const logMin = Math.log(spec.min);
        const logMax = Math.log(spec.max);
        val = Math.exp(logMin + Math.random() * (logMax - logMin));
      } else {
        val = spec.min + Math.random() * (spec.max - spec.min);
      }
      if (spec.integer) val = Math.round(val);
      params[name] = val;
    }
    configs.push(params);
  }

  for (let round = 0; round <= sMax; round++) {
    const nConfigs = configs.length;
    // Use progressively more data in each round
    const dataFraction = Math.min(1.0, (round + 1) / (sMax + 1));
    const dataEnd = Math.max(
      50,
      Math.floor(prices.length * dataFraction)
    );
    const roundPrices = prices.slice(0, dataEnd);

    // Evaluate all surviving configs
    const scored = [];
    for (const params of configs) {
      const fitness = fitnessFn(params, roundPrices);
      scored.push({ params, fitness });
      tracker.add(params, fitness, {
        method: "hyperband",
        round,
        dataFraction: dataFraction.toFixed(2),
      });
      totalEvals++;

      if (onEval) onEval(totalEvals, -1, params, fitness);
    }

    // Sort by fitness descending
    scored.sort((a, b) => b.fitness - a.fitness);

    rounds.push({
      round,
      nConfigs,
      dataPoints: roundPrices.length,
      dataFraction,
      bestFitness: scored[0]?.fitness ?? -Infinity,
      medianFitness: scored[Math.floor(scored.length / 2)]?.fitness ?? -Infinity,
    });

    // Halve: keep top 1/eta configs for next round
    const keepCount = Math.max(1, Math.floor(nConfigs / eta));
    configs = scored.slice(0, keepCount).map((s) => s.params);

    if (configs.length <= 1) break;
  }

  // Final full evaluation of surviving configs
  for (const params of configs) {
    const fitness = fitnessFn(params, prices);
    tracker.add(params, fitness, { method: "hyperband", round: "final" });
    totalEvals++;
  }

  return {
    results: tracker,
    rounds,
    totalEvaluations: totalEvals,
    elapsed: Date.now() - start,
  };
}

// ─── 5. Sensitivity Analysis ────────────────────────────

/**
 * One-at-a-time (OAT) sensitivity analysis.
 * Varies each parameter independently while holding others at baseline,
 * measures how much fitness changes.
 *
 * @param {Object} paramRanges - { paramName: { min, max, integer?, steps? } }
 * @param {Function} fitnessFn - (params, prices) => number
 * @param {Array} prices - OHLCV price data
 * @param {Object} opts - { baselineParams, stepsPerParam }
 * @returns {{ sensitivities: Object, rankings: Array, sweeps: Object }}
 */
export function sensitivityAnalysis(paramRanges, fitnessFn, prices, opts = {}) {
  const stepsPerParam = opts.stepsPerParam || 15;
  const paramNames = Object.keys(paramRanges);

  // Baseline: midpoint of each parameter range
  const baseline = opts.baselineParams || {};
  for (const name of paramNames) {
    if (baseline[name] === undefined) {
      const spec = paramRanges[name];
      let mid = (spec.min + spec.max) / 2;
      if (spec.integer) mid = Math.round(mid);
      baseline[name] = mid;
    }
  }

  const baselineFitness = fitnessFn(baseline, prices);

  const sensitivities = {};
  const sweeps = {};

  for (const name of paramNames) {
    const spec = paramRanges[name];
    const values = [];
    const fitnesses = [];

    for (let i = 0; i < stepsPerParam; i++) {
      let val = spec.min + (i / (stepsPerParam - 1)) * (spec.max - spec.min);
      if (spec.integer) val = Math.round(val);
      values.push(val);

      const testParams = { ...baseline, [name]: val };
      fitnesses.push(fitnessFn(testParams, prices));
    }

    // Sensitivity metrics
    const fitnessRange = Math.max(...fitnesses) - Math.min(...fitnesses);
    const bestVal = values[fitnesses.indexOf(Math.max(...fitnesses))];
    const worstVal = values[fitnesses.indexOf(Math.min(...fitnesses))];

    // Variance-based sensitivity (normalized)
    const mean = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;
    const variance =
      fitnesses.reduce((s, f) => s + (f - mean) ** 2, 0) / fitnesses.length;

    // Gradient approximation (average absolute change per step)
    let gradSum = 0;
    for (let i = 1; i < fitnesses.length; i++) {
      gradSum += Math.abs(fitnesses[i] - fitnesses[i - 1]);
    }
    const avgGradient = gradSum / (fitnesses.length - 1);

    sensitivities[name] = {
      range: fitnessRange,
      variance,
      avgGradient,
      bestValue: bestVal,
      worstValue: worstVal,
      bestFitness: Math.max(...fitnesses),
      worstFitness: Math.min(...fitnesses),
      baselineFitness,
    };

    sweeps[name] = { values, fitnesses };
  }

  // Rank parameters by sensitivity (fitness range)
  const rankings = paramNames
    .map((name) => ({
      param: name,
      range: sensitivities[name].range,
      variance: sensitivities[name].variance,
      avgGradient: sensitivities[name].avgGradient,
    }))
    .sort((a, b) => b.range - a.range);

  return { sensitivities, rankings, sweeps, baseline, baselineFitness };
}

// ─── 6. Interaction Effects ─────────────────────────────

/**
 * Detect parameter interaction effects.
 * Tests pairwise combinations to find parameters whose joint effect
 * differs from the sum of their individual effects (synergy or interference).
 *
 * @param {Object} paramRanges - { paramName: { min, max, integer?, steps? } }
 * @param {Function} fitnessFn - (params, prices) => number
 * @param {Array} prices - OHLCV price data
 * @param {Object} opts - { stepsPerParam, baselineParams }
 * @returns {{ interactions: Array, matrix: Object }}
 */
export function interactionEffects(paramRanges, fitnessFn, prices, opts = {}) {
  const stepsPerParam = opts.stepsPerParam || 5;
  const paramNames = Object.keys(paramRanges);

  // Baseline
  const baseline = opts.baselineParams || {};
  for (const name of paramNames) {
    if (baseline[name] === undefined) {
      const spec = paramRanges[name];
      let mid = (spec.min + spec.max) / 2;
      if (spec.integer) mid = Math.round(mid);
      baseline[name] = mid;
    }
  }

  const baselineFitness = fitnessFn(baseline, prices);

  // Build test values for each param (low, mid, high at minimum)
  const testValues = {};
  for (const name of paramNames) {
    const spec = paramRanges[name];
    const vals = [];
    for (let i = 0; i < stepsPerParam; i++) {
      let val = spec.min + (i / (stepsPerParam - 1)) * (spec.max - spec.min);
      if (spec.integer) val = Math.round(val);
      vals.push(val);
    }
    testValues[name] = [...new Set(vals)];
  }

  // Individual main effects (average fitness change when varying one param)
  const mainEffects = {};
  for (const name of paramNames) {
    let totalEffect = 0;
    for (const val of testValues[name]) {
      const params = { ...baseline, [name]: val };
      const f = fitnessFn(params, prices);
      totalEffect += f - baselineFitness;
    }
    mainEffects[name] = totalEffect / testValues[name].length;
  }

  // Pairwise interaction effects
  const interactions = [];
  const matrix = {};

  for (let i = 0; i < paramNames.length; i++) {
    for (let j = i + 1; j < paramNames.length; j++) {
      const p1 = paramNames[i];
      const p2 = paramNames[j];

      // Grid over both parameters
      let interactionSum = 0;
      let count = 0;

      for (const v1 of testValues[p1]) {
        for (const v2 of testValues[p2]) {
          const params = { ...baseline, [p1]: v1, [p2]: v2 };
          const jointFitness = fitnessFn(params, prices);

          // Individual effects
          const effect1 =
            fitnessFn({ ...baseline, [p1]: v1 }, prices) - baselineFitness;
          const effect2 =
            fitnessFn({ ...baseline, [p2]: v2 }, prices) - baselineFitness;

          // Interaction = joint effect - sum of individual effects
          const expectedAdditive = baselineFitness + effect1 + effect2;
          const interaction = jointFitness - expectedAdditive;

          interactionSum += Math.abs(interaction);
          count++;
        }
      }

      const avgInteraction = interactionSum / count;

      interactions.push({
        param1: p1,
        param2: p2,
        interactionStrength: avgInteraction,
        mainEffect1: mainEffects[p1],
        mainEffect2: mainEffects[p2],
      });

      if (!matrix[p1]) matrix[p1] = {};
      if (!matrix[p2]) matrix[p2] = {};
      matrix[p1][p2] = avgInteraction;
      matrix[p2][p1] = avgInteraction;
    }
  }

  // Sort by interaction strength
  interactions.sort((a, b) => b.interactionStrength - a.interactionStrength);

  return { interactions, matrix, mainEffects, baseline, baselineFitness };
}

// ─── Strategy Combinator Class ──────────────────────────

/**
 * Unified strategy combinatorics engine.
 * Wraps all search methods with common configuration.
 */
export class StrategyCombinator {
  /**
   * @param {Object} options
   * @param {Object} options.paramRanges - { name: { min, max, steps?, integer?, logScale? } }
   * @param {Function} options.fitnessFn - (params, prices) => number
   * @param {number} [options.topK=20] - number of top results to retain
   */
  constructor(options = {}) {
    this.paramRanges =
      options.paramRanges || {
        lookback: { min: 5, max: 100, steps: 10, integer: true },
        threshold: { min: 0.005, max: 0.10, steps: 10, logScale: true },
        positionSize: { min: 0.02, max: 0.30, steps: 8 },
      };
    this.fitnessFn = options.fitnessFn || defaultFitness;
    this.topK = options.topK || 20;
    this.log = options.silent ? () => {} : console.log.bind(console);
    this.allResults = new TopKTracker(this.topK);
  }

  /**
   * Run grid search with configured parameters.
   */
  gridSearch(prices, opts = {}) {
    this.log("--- Grid Search ---");
    const result = gridSearch(this.paramRanges, this.fitnessFn, prices, {
      topK: this.topK,
      ...opts,
    });
    this._mergeResults(result.results);
    this.log(
      `  Evaluated ${result.totalEvaluations} combos in ${result.elapsed}ms`
    );
    this._logBest(result.results);
    return result;
  }

  /**
   * Run random search with configured parameters.
   */
  randomSearch(prices, opts = {}) {
    this.log("--- Random Search ---");
    const result = randomSearch(this.paramRanges, this.fitnessFn, prices, {
      topK: this.topK,
      ...opts,
    });
    this._mergeResults(result.results);
    this.log(
      `  Evaluated ${result.totalEvaluations} samples in ${result.elapsed}ms`
    );
    this._logBest(result.results);
    return result;
  }

  /**
   * Run Latin Hypercube sampling with configured parameters.
   */
  latinHypercube(prices, opts = {}) {
    this.log("--- Latin Hypercube Sampling ---");
    const result = latinHypercube(this.paramRanges, this.fitnessFn, prices, {
      topK: this.topK,
      ...opts,
    });
    this._mergeResults(result.results);
    this.log(
      `  Evaluated ${result.totalEvaluations} samples in ${result.elapsed}ms`
    );
    this._logBest(result.results);
    return result;
  }

  /**
   * Run Hyperband successive halving with configured parameters.
   */
  hyperband(prices, opts = {}) {
    this.log("--- Hyperband (Successive Halving) ---");
    const result = hyperband(this.paramRanges, this.fitnessFn, prices, {
      topK: this.topK,
      ...opts,
    });
    this._mergeResults(result.results);
    this.log(
      `  Evaluated ${result.totalEvaluations} configs across ${result.rounds.length} rounds in ${result.elapsed}ms`
    );
    for (const r of result.rounds) {
      this.log(
        `    Round ${r.round}: ${r.nConfigs} configs, ${r.dataPoints} data points, best=${r.bestFitness.toFixed(3)}`
      );
    }
    this._logBest(result.results);
    return result;
  }

  /**
   * Run parameter sensitivity analysis.
   */
  sensitivityAnalysis(prices, opts = {}) {
    this.log("--- Sensitivity Analysis ---");
    const result = sensitivityAnalysis(
      this.paramRanges,
      this.fitnessFn,
      prices,
      opts
    );
    this.log(`  Baseline fitness: ${result.baselineFitness.toFixed(4)}`);
    this.log("  Parameter rankings (most to least sensitive):");
    for (const r of result.rankings) {
      const bar = "#".repeat(
        Math.max(0, Math.round(r.range * 20))
      );
      this.log(
        `    ${r.param.padEnd(14)} range=${r.range.toFixed(4)} var=${r.variance.toFixed(6)} ${bar}`
      );
    }
    return result;
  }

  /**
   * Run interaction effect analysis.
   */
  interactionEffects(prices, opts = {}) {
    this.log("--- Interaction Effects ---");
    const result = interactionEffects(
      this.paramRanges,
      this.fitnessFn,
      prices,
      opts
    );
    this.log("  Pairwise interactions (strongest first):");
    for (const ix of result.interactions.slice(0, 10)) {
      this.log(
        `    ${ix.param1} x ${ix.param2}: strength=${ix.interactionStrength.toFixed(4)}`
      );
    }
    return result;
  }

  /**
   * Run all methods and compare.
   * Returns combined top-K results across all methods.
   */
  runAll(prices, opts = {}) {
    this.log("=== Strategy Combinatorics — Full Suite ===\n");

    const gridResult = this.gridSearch(prices, opts.grid);
    this.log("");

    const randomResult = this.randomSearch(prices, {
      nSamples: 200,
      ...opts.random,
    });
    this.log("");

    const lhsResult = this.latinHypercube(prices, {
      nSamples: 100,
      ...opts.lhs,
    });
    this.log("");

    const hbResult = this.hyperband(prices, opts.hyperband);
    this.log("");

    const sensResult = this.sensitivityAnalysis(prices, opts.sensitivity);
    this.log("");

    const ixResult = this.interactionEffects(prices, {
      stepsPerParam: 4,
      ...opts.interaction,
    });
    this.log("");

    this.log("=== Combined Top-K Results ===");
    this._logTopK(this.allResults, 10);

    return {
      grid: gridResult,
      random: randomResult,
      lhs: lhsResult,
      hyperband: hbResult,
      sensitivity: sensResult,
      interactions: ixResult,
      combined: this.allResults,
    };
  }

  /**
   * Parallel evaluation support.
   * Evaluates an array of parameter sets and returns scored results.
   * (Synchronous batch — true parallelism via worker_threads can be layered on.)
   */
  evaluateBatch(paramSets, prices) {
    return paramSets.map((params) => ({
      params,
      fitness: this.fitnessFn(params, prices),
    }));
  }

  // ─── Internal Helpers ───────────────────────────────────

  _mergeResults(tracker) {
    for (const r of tracker.results) {
      this.allResults.add(r.params, r.fitness, r.meta);
    }
  }

  _logBest(tracker) {
    const best = tracker.best();
    if (best) {
      this.log(`  Best fitness: ${best.fitness.toFixed(4)}`);
      const paramStr = Object.entries(best.params)
        .map(
          ([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(4) : v}`
        )
        .join(" ");
      this.log(`  Params: ${paramStr}`);
    }
  }

  _logTopK(tracker, n = 10) {
    const top = tracker.top(n);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const paramStr = Object.entries(r.params)
        .map(
          ([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(4) : v}`
        )
        .join(" ");
      this.log(
        `  #${String(i + 1).padStart(2)}: fitness=${r.fitness.toFixed(4)} | ${paramStr} [${r.meta?.method || "?"}]`
      );
    }
  }
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("=== Strategy Combinator — Momentum Parameter Search ===\n");

  const prices = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  console.log(`Data: ${prices.length} days\n`);

  const paramRanges = {
    lookback: { min: 5, max: 80, steps: 8, integer: true },
    threshold: { min: 0.005, max: 0.08, steps: 6, logScale: true },
    positionSize: { min: 0.03, max: 0.25, steps: 5 },
  };

  const combinator = new StrategyCombinator({
    paramRanges,
    fitnessFn: defaultFitness,
    topK: 15,
  });

  // 1. Grid search
  console.log("[ 1/6 ] Grid Search");
  combinator.gridSearch(prices);
  console.log("");

  // 2. Random search
  console.log("[ 2/6 ] Random Search");
  combinator.randomSearch(prices, { nSamples: 150 });
  console.log("");

  // 3. Latin Hypercube
  console.log("[ 3/6 ] Latin Hypercube Sampling");
  combinator.latinHypercube(prices, { nSamples: 100 });
  console.log("");

  // 4. Hyperband
  console.log("[ 4/6 ] Hyperband (Successive Halving)");
  combinator.hyperband(prices, { maxConfigs: 54, eta: 3 });
  console.log("");

  // 5. Sensitivity analysis
  console.log("[ 5/6 ] Sensitivity Analysis");
  const sens = combinator.sensitivityAnalysis(prices, { stepsPerParam: 12 });
  console.log("");

  // 6. Interaction effects
  console.log("[ 6/6 ] Interaction Effects");
  const ix = combinator.interactionEffects(prices, { stepsPerParam: 4 });
  console.log("");

  // Final combined leaderboard
  console.log("=== Final Combined Leaderboard ===");
  combinator._logTopK(combinator.allResults, 15);

  // Summary
  const best = combinator.allResults.best();
  if (best) {
    console.log("\n--- Best Strategy Found ---");
    console.log(`  Sharpe: ${best.fitness.toFixed(4)}`);
    console.log(`  Method: ${best.meta?.method || "unknown"}`);
    console.log("  Parameters:");
    for (const [k, v] of Object.entries(best.params)) {
      console.log(
        `    ${k.padEnd(14)} = ${typeof v === "number" ? v.toFixed(4) : v}`
      );
    }
  }

  // Most sensitive parameter
  if (sens.rankings.length > 0) {
    console.log(
      `\n  Most sensitive param: ${sens.rankings[0].param} (range=${sens.rankings[0].range.toFixed(4)})`
    );
    console.log(
      `  Least sensitive param: ${sens.rankings[sens.rankings.length - 1].param} (range=${sens.rankings[sens.rankings.length - 1].range.toFixed(4)})`
    );
  }

  // Strongest interaction
  if (ix.interactions.length > 0) {
    const top = ix.interactions[0];
    console.log(
      `  Strongest interaction: ${top.param1} x ${top.param2} (strength=${top.interactionStrength.toFixed(4)})`
    );
  }
}

if (process.argv[1]?.includes("strategy-combinator")) {
  main().catch(console.error);
}
