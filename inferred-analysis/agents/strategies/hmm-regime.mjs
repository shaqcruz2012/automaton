#!/usr/bin/env node
/**
 * Hidden Markov Model for Market Regime Detection — Inferred Analysis
 *
 * Implements a Gaussian-emission HMM for identifying market regimes
 * (bull, bear, neutral) from price return data.
 *
 * Algorithms:
 * 1. Forward algorithm — online state probability estimation
 * 2. Viterbi algorithm — most likely state sequence
 * 3. Baum-Welch (EM) — parameter estimation from observations
 * 4. Regime-conditional statistics and trading signals
 *
 * Usage:
 *   node agents/strategies/hmm-regime.mjs
 *   import { HiddenMarkovModel, fitHMM, getRegimeProbabilities, getRegimeSignals } from './hmm-regime.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Math Helpers ────────────────────────────────────────

/**
 * Gaussian PDF: N(x | mu, sigma)
 */
function gaussianPdf(x, mu, sigma) {
  const s2 = sigma * sigma;
  if (s2 < 1e-12) return Math.abs(x - mu) < 1e-9 ? 1e6 : 1e-30;
  const coeff = 1 / Math.sqrt(2 * Math.PI * s2);
  const exponent = -((x - mu) ** 2) / (2 * s2);
  return coeff * Math.exp(exponent);
}

/**
 * Log-sum-exp for numerical stability: log(sum(exp(arr)))
 */
function logSumExp(arr) {
  const max = Math.max(...arr);
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (const v of arr) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

/**
 * Compute log-returns from price array.
 */
export function computeLogReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1].close;
    const curr = prices[i].close;
    if (prev > 0) {
      returns.push({
        date: prices[i].date,
        ret: Math.log(curr / prev),
      });
    }
  }
  return returns;
}

// ─── Hidden Markov Model ─────────────────────────────────

/**
 * HMM with Gaussian emission distributions.
 *
 * Parameters:
 *   N        — number of hidden states
 *   pi[i]    — initial state distribution
 *   A[i][j]  — transition probability from state i to state j
 *   mu[i]    — emission mean for state i
 *   sigma[i] — emission std deviation for state i
 */
export class HiddenMarkovModel {
  constructor({ N = 3, labels = null, pi = null, A = null, mu = null, sigma = null } = {}) {
    this.N = N;
    this.labels = labels || this._defaultLabels(N);

    // Initialize parameters with reasonable defaults
    this.pi = pi || this._uniformArray(N);
    this.A = A || this._defaultTransition(N);
    this.mu = mu || this._defaultMeans(N);
    this.sigma = sigma || this._defaultSigmas(N);
    this.fitted = false;
    this.logLikelihood = -Infinity;
  }

  _defaultLabels(N) {
    if (N === 2) return ["bear", "bull"];
    if (N === 3) return ["bear", "neutral", "bull"];
    return Array.from({ length: N }, (_, i) => `state_${i}`);
  }

  _uniformArray(N) {
    return new Array(N).fill(1 / N);
  }

  _defaultTransition(N) {
    // High self-transition probability (regime persistence)
    const selfProb = 0.95;
    const otherProb = (1 - selfProb) / (N - 1);
    return Array.from({ length: N }, (_, i) =>
      Array.from({ length: N }, (_, j) => (i === j ? selfProb : otherProb))
    );
  }

  _defaultMeans(N) {
    // Spread means across return space
    if (N === 2) return [-0.001, 0.001];
    if (N === 3) return [-0.002, 0.0002, 0.002];
    const step = 0.004 / (N - 1);
    return Array.from({ length: N }, (_, i) => -0.002 + i * step);
  }

  _defaultSigmas(N) {
    if (N === 2) return [0.02, 0.008];
    if (N === 3) return [0.02, 0.008, 0.012];
    return Array.from({ length: N }, () => 0.012);
  }

  /**
   * Emission probability: P(obs | state i) using Gaussian PDF
   */
  emissionProb(obs, stateIdx) {
    return gaussianPdf(obs, this.mu[stateIdx], this.sigma[stateIdx]);
  }

  // ─── Forward Algorithm ───────────────────────────────

  /**
   * Forward algorithm (scaled version for numerical stability).
   * Returns { alpha, scalingFactors, logLikelihood }
   *
   * alpha[t][i] = scaled forward variable at time t, state i
   */
  forward(observations) {
    const T = observations.length;
    const N = this.N;
    const alpha = Array.from({ length: T }, () => new Array(N).fill(0));
    const c = new Array(T).fill(0); // scaling factors

    // Initialization: alpha_0(i) = pi(i) * b_i(O_0)
    for (let i = 0; i < N; i++) {
      alpha[0][i] = this.pi[i] * this.emissionProb(observations[0], i);
    }
    c[0] = alpha[0].reduce((s, v) => s + v, 0);
    if (c[0] > 0) for (let i = 0; i < N; i++) alpha[0][i] /= c[0];

    // Induction
    for (let t = 1; t < T; t++) {
      for (let j = 0; j < N; j++) {
        let sum = 0;
        for (let i = 0; i < N; i++) {
          sum += alpha[t - 1][i] * this.A[i][j];
        }
        alpha[t][j] = sum * this.emissionProb(observations[t], j);
      }
      c[t] = alpha[t].reduce((s, v) => s + v, 0);
      if (c[t] > 0) for (let j = 0; j < N; j++) alpha[t][j] /= c[t];
    }

    // Log-likelihood = sum of log(c[t])
    let logLik = 0;
    for (let t = 0; t < T; t++) {
      logLik += c[t] > 0 ? Math.log(c[t]) : -300;
    }

    return { alpha, scalingFactors: c, logLikelihood: logLik };
  }

  // ─── Backward Algorithm ──────────────────────────────

  /**
   * Backward algorithm (scaled).
   * Uses same scaling factors from forward pass.
   */
  backward(observations, scalingFactors) {
    const T = observations.length;
    const N = this.N;
    const beta = Array.from({ length: T }, () => new Array(N).fill(0));

    // Initialization
    for (let i = 0; i < N; i++) beta[T - 1][i] = 1;

    // Induction
    for (let t = T - 2; t >= 0; t--) {
      for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let j = 0; j < N; j++) {
          sum += this.A[i][j] * this.emissionProb(observations[t + 1], j) * beta[t + 1][j];
        }
        beta[t][i] = sum;
      }
      const ct1 = scalingFactors[t + 1];
      if (ct1 > 0) for (let i = 0; i < N; i++) beta[t][i] /= ct1;
    }

    return beta;
  }

  // ─── Viterbi Algorithm ───────────────────────────────

  /**
   * Viterbi algorithm — finds the most likely state sequence.
   * Returns { states, logProb }
   *
   * states[t] is the index of the most likely state at time t.
   */
  viterbi(observations) {
    const T = observations.length;
    const N = this.N;

    // Work in log space for numerical stability
    const logDelta = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
    const psi = Array.from({ length: T }, () => new Array(N).fill(0));

    // Initialization
    for (let i = 0; i < N; i++) {
      const lpi = this.pi[i] > 0 ? Math.log(this.pi[i]) : -300;
      const lemit = this.emissionProb(observations[0], i);
      logDelta[0][i] = lpi + (lemit > 0 ? Math.log(lemit) : -300);
    }

    // Recursion
    for (let t = 1; t < T; t++) {
      for (let j = 0; j < N; j++) {
        let bestVal = -Infinity;
        let bestIdx = 0;
        for (let i = 0; i < N; i++) {
          const la = this.A[i][j] > 0 ? Math.log(this.A[i][j]) : -300;
          const val = logDelta[t - 1][i] + la;
          if (val > bestVal) {
            bestVal = val;
            bestIdx = i;
          }
        }
        const lemit = this.emissionProb(observations[t], j);
        logDelta[t][j] = bestVal + (lemit > 0 ? Math.log(lemit) : -300);
        psi[t][j] = bestIdx;
      }
    }

    // Termination — backtrace
    const states = new Array(T);
    let bestFinal = -Infinity;
    states[T - 1] = 0;
    for (let i = 0; i < N; i++) {
      if (logDelta[T - 1][i] > bestFinal) {
        bestFinal = logDelta[T - 1][i];
        states[T - 1] = i;
      }
    }
    for (let t = T - 2; t >= 0; t--) {
      states[t] = psi[t + 1][states[t + 1]];
    }

    return { states, logProb: bestFinal };
  }

  // ─── Baum-Welch (EM) Algorithm ───────────────────────

  /**
   * Fit model parameters using Baum-Welch expectation-maximization.
   *
   * @param {number[]} observations — array of return values
   * @param {object} options
   * @param {number} options.maxIter — max EM iterations (default 100)
   * @param {number} options.tol — convergence tolerance on log-likelihood (default 1e-4)
   * @param {boolean} options.verbose — print iteration progress
   * @returns {HiddenMarkovModel} this
   */
  fit(observations, { maxIter = 100, tol = 1e-4, verbose = false } = {}) {
    const T = observations.length;
    const N = this.N;

    if (T < 2) throw new Error("Need at least 2 observations to fit HMM");

    // Initialize means via k-means-style quantile split
    this._initializeFromData(observations);

    let prevLogLik = -Infinity;

    for (let iter = 0; iter < maxIter; iter++) {
      // E-step: forward-backward
      const { alpha, scalingFactors, logLikelihood } = this.forward(observations);
      const beta = this.backward(observations, scalingFactors);

      if (verbose && iter % 10 === 0) {
        console.log(`    EM iter ${iter}: log-likelihood = ${logLikelihood.toFixed(4)}`);
      }

      // Check convergence
      if (Math.abs(logLikelihood - prevLogLik) < tol) {
        if (verbose) console.log(`    Converged at iteration ${iter}`);
        break;
      }
      prevLogLik = logLikelihood;
      this.logLikelihood = logLikelihood;

      // Compute gamma[t][i] = P(state_t = i | observations)
      const gamma = Array.from({ length: T }, () => new Array(N).fill(0));
      for (let t = 0; t < T; t++) {
        let denom = 0;
        for (let i = 0; i < N; i++) {
          gamma[t][i] = alpha[t][i] * beta[t][i];
          denom += gamma[t][i];
        }
        if (denom > 0) for (let i = 0; i < N; i++) gamma[t][i] /= denom;
      }

      // Compute xi[t][i][j] = P(state_t = i, state_{t+1} = j | observations)
      const xi = Array.from({ length: T - 1 }, () =>
        Array.from({ length: N }, () => new Array(N).fill(0))
      );
      for (let t = 0; t < T - 1; t++) {
        let denom = 0;
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            xi[t][i][j] =
              alpha[t][i] *
              this.A[i][j] *
              this.emissionProb(observations[t + 1], j) *
              beta[t + 1][j];
            denom += xi[t][i][j];
          }
        }
        if (denom > 0) {
          for (let i = 0; i < N; i++)
            for (let j = 0; j < N; j++) xi[t][i][j] /= denom;
        }
      }

      // M-step: re-estimate parameters

      // Initial distribution
      for (let i = 0; i < N; i++) {
        this.pi[i] = Math.max(gamma[0][i], 1e-10);
      }
      const piSum = this.pi.reduce((s, v) => s + v, 0);
      for (let i = 0; i < N; i++) this.pi[i] /= piSum;

      // Transition matrix
      for (let i = 0; i < N; i++) {
        let gammaSum = 0;
        for (let t = 0; t < T - 1; t++) gammaSum += gamma[t][i];
        for (let j = 0; j < N; j++) {
          let xiSum = 0;
          for (let t = 0; t < T - 1; t++) xiSum += xi[t][i][j];
          this.A[i][j] = gammaSum > 0 ? Math.max(xiSum / gammaSum, 1e-10) : 1 / N;
        }
        // Normalize row
        const rowSum = this.A[i].reduce((s, v) => s + v, 0);
        for (let j = 0; j < N; j++) this.A[i][j] /= rowSum;
      }

      // Emission means and variances
      for (let i = 0; i < N; i++) {
        let gammaSum = 0;
        let weightedSum = 0;
        let weightedVarSum = 0;
        for (let t = 0; t < T; t++) {
          gammaSum += gamma[t][i];
          weightedSum += gamma[t][i] * observations[t];
        }
        const newMu = gammaSum > 0 ? weightedSum / gammaSum : this.mu[i];
        for (let t = 0; t < T; t++) {
          weightedVarSum += gamma[t][i] * (observations[t] - newMu) ** 2;
        }
        this.mu[i] = newMu;
        this.sigma[i] = gammaSum > 0 ? Math.sqrt(Math.max(weightedVarSum / gammaSum, 1e-10)) : this.sigma[i];
      }
    }

    // Sort states by mean return (bear < neutral < bull)
    this._sortStatesByMean();
    this.fitted = true;
    return this;
  }

  /**
   * Initialize emission parameters from data quantiles.
   */
  _initializeFromData(observations) {
    const sorted = [...observations].sort((a, b) => a - b);
    const T = sorted.length;
    const N = this.N;

    for (let i = 0; i < N; i++) {
      const lo = Math.floor((i / N) * T);
      const hi = Math.floor(((i + 1) / N) * T);
      const slice = sorted.slice(lo, hi);
      const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
      this.mu[i] = mean;
      this.sigma[i] = Math.sqrt(Math.max(variance, 1e-10));
    }
  }

  /**
   * Sort states so index 0 = lowest mean (bear), last = highest (bull).
   */
  _sortStatesByMean() {
    const N = this.N;
    const indices = Array.from({ length: N }, (_, i) => i);
    indices.sort((a, b) => this.mu[a] - this.mu[b]);

    const newMu = indices.map(i => this.mu[i]);
    const newSigma = indices.map(i => this.sigma[i]);
    const newPi = indices.map(i => this.pi[i]);
    const newA = indices.map(i => indices.map(j => this.A[i][j]));
    const newLabels = this._defaultLabels(N);

    this.mu = newMu;
    this.sigma = newSigma;
    this.pi = newPi;
    this.A = newA;
    this.labels = newLabels;
  }

  // ─── Online State Estimation ─────────────────────────

  /**
   * Get current regime probabilities for the latest observation(s).
   * Returns array of { label, probability } sorted by probability desc.
   */
  currentRegimeProbabilities(observations) {
    const { alpha } = this.forward(observations);
    const last = alpha[alpha.length - 1];
    const sum = last.reduce((s, v) => s + v, 0);
    const probs = last.map((v, i) => ({
      state: i,
      label: this.labels[i],
      probability: sum > 0 ? v / sum : 1 / this.N,
    }));
    probs.sort((a, b) => b.probability - a.probability);
    return probs;
  }

  // ─── Regime Statistics ───────────────────────────────

  /**
   * Compute per-regime statistics from Viterbi state assignments.
   */
  regimeStatistics(observations, states) {
    const N = this.N;
    const stats = Array.from({ length: N }, (_, i) => ({
      state: i,
      label: this.labels[i],
      count: 0,
      totalDays: observations.length,
      meanReturn: 0,
      volatility: 0,
      sharpe: 0,
      emissionMu: this.mu[i],
      emissionSigma: this.sigma[i],
      _returns: [],
    }));

    for (let t = 0; t < observations.length; t++) {
      const s = states[t];
      stats[s].count++;
      stats[s]._returns.push(observations[t]);
    }

    for (const s of stats) {
      if (s.count > 0) {
        s.meanReturn = s._returns.reduce((a, b) => a + b, 0) / s.count;
        const variance = s._returns.reduce((a, r) => a + (r - s.meanReturn) ** 2, 0) / s.count;
        s.volatility = Math.sqrt(variance);
        s.sharpe = s.volatility > 0 ? (s.meanReturn / s.volatility) * Math.sqrt(252) : 0;
        s.pctTime = ((s.count / s.totalDays) * 100).toFixed(1) + "%";
        s.annualizedReturn = ((1 + s.meanReturn) ** 252 - 1) * 100;
      }
      delete s._returns;
    }

    return stats;
  }

  /**
   * Serialize model to plain object.
   */
  toJSON() {
    return {
      N: this.N,
      labels: this.labels,
      pi: this.pi,
      A: this.A,
      mu: this.mu,
      sigma: this.sigma,
      logLikelihood: this.logLikelihood,
      fitted: this.fitted,
    };
  }

  /**
   * Restore model from serialized object.
   */
  static fromJSON(obj) {
    const hmm = new HiddenMarkovModel({
      N: obj.N,
      labels: obj.labels,
      pi: obj.pi,
      A: obj.A,
      mu: obj.mu,
      sigma: obj.sigma,
    });
    hmm.logLikelihood = obj.logLikelihood;
    hmm.fitted = obj.fitted;
    return hmm;
  }
}

// ─── High-Level API ──────────────────────────────────────

/**
 * Fit an HMM to price data.
 *
 * @param {Array} prices — array of { date, close, ... }
 * @param {object} options
 * @param {number} options.nStates — number of regimes (default 3)
 * @param {number} options.maxIter — Baum-Welch max iterations
 * @param {boolean} options.verbose — print progress
 * @returns {{ model, observations, dates, states, stats }}
 */
export function fitHMM(prices, { nStates = 3, maxIter = 100, tol = 1e-4, verbose = false } = {}) {
  const logReturns = computeLogReturns(prices);
  const obs = logReturns.map(r => r.ret);
  const dates = logReturns.map(r => r.date);

  const model = new HiddenMarkovModel({ N: nStates });
  model.fit(obs, { maxIter, tol, verbose });

  const { states } = model.viterbi(obs);
  const stats = model.regimeStatistics(obs, states);

  return { model, observations: obs, dates, states, stats };
}

/**
 * Get current regime probabilities for a price series.
 *
 * @param {HiddenMarkovModel} model — fitted HMM
 * @param {Array} prices — price data
 * @returns {Array<{label, probability}>}
 */
export function getRegimeProbabilities(model, prices) {
  const logReturns = computeLogReturns(prices);
  const obs = logReturns.map(r => r.ret);
  return model.currentRegimeProbabilities(obs);
}

/**
 * Generate trading signals from regime transitions.
 *
 * Signal logic:
 *   - Transition into bull regime  -> BUY
 *   - Transition into bear regime  -> SELL
 *   - Staying in same regime       -> HOLD
 *   - Transition to/from neutral   -> REDUCE (lighten position)
 *
 * @param {HiddenMarkovModel} model
 * @param {Array} prices
 * @returns {Array<{date, regime, prevRegime, signal, confidence}>}
 */
export function getRegimeSignals(model, prices) {
  const logReturns = computeLogReturns(prices);
  const obs = logReturns.map(r => r.ret);
  const dates = logReturns.map(r => r.date);

  const { states } = model.viterbi(obs);
  const { alpha } = model.forward(obs);

  const N = model.N;
  const bullIdx = N - 1;
  const bearIdx = 0;

  const signals = [];

  for (let t = 0; t < states.length; t++) {
    const regime = states[t];
    const prevRegime = t > 0 ? states[t - 1] : regime;

    // Confidence = probability of assigned state
    const stateProbs = alpha[t];
    const probSum = stateProbs.reduce((s, v) => s + v, 0);
    const confidence = probSum > 0 ? stateProbs[regime] / probSum : 1 / N;

    let signal = "HOLD";
    if (t > 0 && regime !== prevRegime) {
      if (regime === bullIdx) {
        signal = "BUY";
      } else if (regime === bearIdx) {
        signal = "SELL";
      } else if (prevRegime === bullIdx) {
        signal = "REDUCE"; // leaving bull
      } else if (prevRegime === bearIdx) {
        signal = "COVER";  // leaving bear
      } else {
        signal = "HOLD";
      }
    }

    signals.push({
      date: dates[t],
      regime: model.labels[regime],
      prevRegime: model.labels[prevRegime],
      signal,
      confidence: +confidence.toFixed(4),
    });
  }

  return signals;
}

// ─── Backtesting ─────────────────────────────────────────

/**
 * Simple backtest: long in bull, short in bear, flat in neutral.
 */
function backtestRegimeStrategy(observations, dates, states, labels) {
  const N = Math.max(...states) + 1;
  const bullIdx = N - 1;
  const bearIdx = 0;

  let equity = 1.0;
  let position = 0; // 1 = long, -1 = short, 0 = flat
  let trades = 0;
  const equityCurve = [];

  for (let t = 0; t < observations.length; t++) {
    const regime = states[t];
    let newPos = 0;
    if (regime === bullIdx) newPos = 1;
    else if (regime === bearIdx) newPos = -1;

    if (newPos !== position) trades++;
    position = newPos;

    // P&L from return
    const ret = observations[t];
    equity *= 1 + position * ret;

    equityCurve.push({
      date: dates[t],
      equity: +equity.toFixed(4),
      regime: labels[regime],
      position,
    });
  }

  const totalReturn = (equity - 1) * 100;
  const buyHold = (Math.exp(observations.reduce((s, r) => s + r, 0)) - 1) * 100;
  const dailyRets = equityCurve.map((e, i) =>
    i === 0 ? 0 : e.equity / equityCurve[i - 1].equity - 1
  );
  const avgDaily = dailyRets.reduce((s, r) => s + r, 0) / dailyRets.length;
  const stdDaily = Math.sqrt(
    dailyRets.reduce((s, r) => s + (r - avgDaily) ** 2, 0) / dailyRets.length
  );
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  return {
    totalReturn: +totalReturn.toFixed(2),
    buyHoldReturn: +buyHold.toFixed(2),
    sharpe: +sharpe.toFixed(3),
    trades,
    finalEquity: +equity.toFixed(4),
    equityCurve,
  };
}

// ─── CLI Demo ────────────────────────────────────────────

function printRegimeTimeline(dates, states, labels, windowSize = 60) {
  const N = Math.max(...states) + 1;
  const chars = { bear: "\u2593", neutral: "\u2591", bull: "\u2588" };
  const fallback = "\u00B7";

  console.log("\n  Regime Timeline (last 252 trading days):");
  console.log("  Legend: " +
    labels.map(l => `${chars[l] || fallback} = ${l}`).join("  "));
  console.log();

  const start = Math.max(0, states.length - 252);
  const slice = states.slice(start);
  const dateSlice = dates.slice(start);

  // Print in rows of windowSize
  for (let row = 0; row < slice.length; row += windowSize) {
    const chunk = slice.slice(row, row + windowSize);
    const startDate = dateSlice[row];
    const bar = chunk.map(s => chars[labels[s]] || fallback).join("");
    console.log(`  ${startDate} |${bar}|`);
  }
}

async function main() {
  console.log("=".repeat(72));
  console.log("  Hidden Markov Model — Market Regime Detection");
  console.log("=".repeat(72));

  // Generate synthetic SPY data
  console.log("\n1. Generating SPY price data...");
  const prices = generateRealisticPrices("SPY", "2020-01-01", "2025-12-31");
  console.log(`   ${prices.length} trading days loaded.`);

  // Fit HMM
  console.log("\n2. Fitting 3-state HMM via Baum-Welch...");
  const { model, observations, dates, states, stats } = fitHMM(prices, {
    nStates: 3,
    maxIter: 200,
    verbose: true,
  });

  // Show model parameters
  console.log("\n3. Estimated Parameters:");
  console.log("   Initial distribution (pi):", model.pi.map(p => p.toFixed(4)));
  console.log("\n   Transition matrix A:");
  for (let i = 0; i < model.N; i++) {
    const row = model.A[i].map(a => a.toFixed(4)).join("  ");
    console.log(`     ${model.labels[i].padEnd(8)} -> [${row}]`);
  }

  console.log("\n   Emission distributions:");
  for (let i = 0; i < model.N; i++) {
    console.log(
      `     ${model.labels[i].padEnd(8)}: mu = ${(model.mu[i] * 100).toFixed(4)}%  ` +
      `sigma = ${(model.sigma[i] * 100).toFixed(4)}%`
    );
  }

  // Regime statistics
  console.log("\n4. Regime Statistics:");
  console.log("   " + "-".repeat(68));
  console.log(
    "   " +
    "Regime".padEnd(10) +
    "Days".padStart(6) +
    "% Time".padStart(8) +
    "Mean Ret".padStart(10) +
    "Volatility".padStart(12) +
    "Ann. Ret".padStart(10) +
    "Sharpe".padStart(8)
  );
  console.log("   " + "-".repeat(68));
  for (const s of stats) {
    console.log(
      "   " +
      s.label.padEnd(10) +
      String(s.count).padStart(6) +
      (s.pctTime || "0%").padStart(8) +
      ((s.meanReturn * 100).toFixed(4) + "%").padStart(10) +
      ((s.volatility * 100).toFixed(4) + "%").padStart(12) +
      ((s.annualizedReturn || 0).toFixed(1) + "%").padStart(10) +
      (s.sharpe || 0).toFixed(2).padStart(8)
    );
  }

  // Timeline
  printRegimeTimeline(dates, states, model.labels);

  // Current regime
  console.log("\n5. Current Regime Probabilities:");
  const probs = getRegimeProbabilities(model, prices);
  for (const p of probs) {
    const bar = "\u2588".repeat(Math.round(p.probability * 40));
    console.log(`   ${p.label.padEnd(10)} ${(p.probability * 100).toFixed(1)}%  ${bar}`);
  }

  // Trading signals
  console.log("\n6. Recent Trading Signals (last 20 transitions):");
  const signals = getRegimeSignals(model, prices);
  const transitions = signals.filter(s => s.signal !== "HOLD");
  const recentTransitions = transitions.slice(-20);
  for (const t of recentTransitions) {
    const arrow = t.signal === "BUY" ? ">>>" : t.signal === "SELL" ? "<<<" : " ~ ";
    console.log(
      `   ${t.date}  ${arrow} ${t.signal.padEnd(6)}  ` +
      `${t.prevRegime} -> ${t.regime}  (conf: ${(t.confidence * 100).toFixed(1)}%)`
    );
  }

  // Backtest
  console.log("\n7. Regime Strategy Backtest:");
  const bt = backtestRegimeStrategy(observations, dates, states, model.labels);
  console.log(`   Strategy return:  ${bt.totalReturn.toFixed(1)}%`);
  console.log(`   Buy & hold:       ${bt.buyHoldReturn.toFixed(1)}%`);
  console.log(`   Sharpe ratio:     ${bt.sharpe.toFixed(3)}`);
  console.log(`   Total trades:     ${bt.trades}`);

  // Model persistence hint
  console.log("\n8. Model Serialization:");
  const serialized = JSON.stringify(model.toJSON());
  console.log(`   Model size: ${serialized.length} bytes`);
  console.log(`   Restore with: HiddenMarkovModel.fromJSON(JSON.parse(data))`);

  console.log("\n" + "=".repeat(72));
  console.log("  Regime detection complete. Use fitHMM() and getRegimeSignals() in your strategy.");
  console.log("=".repeat(72));
}

// Run CLI if called directly
const isMain =
  process.argv[1] &&
  (process.argv[1].includes("hmm-regime") || process.argv[1].endsWith("hmm-regime.mjs"));

if (isMain) {
  main().catch(err => {
    console.error("HMM regime detection failed:", err);
    process.exit(1);
  });
}
