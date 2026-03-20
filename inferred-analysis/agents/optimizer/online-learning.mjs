#!/usr/bin/env node
/**
 * Online Learning Module — Inferred Analysis
 *
 * Adaptive strategy optimization using online learning algorithms.
 * Processes streaming (signal, outcome) pairs and updates weights/parameters
 * without batch retraining.
 *
 * Algorithms:
 * - Exponentially Weighted Moving Average (EWMA) for parameter tracking
 * - Online Gradient Descent (OGD) for strategy weight updates
 * - Multiplicative Weights / Hedge algorithm for expert aggregation
 * - Follow the Regularized Leader (FTRL) for sparse signal selection
 * - AdaGrad-style adaptive learning rates
 * - Cumulative regret tracking vs best fixed strategy in hindsight
 *
 * Usage:
 *   node agents/optimizer/online-learning.mjs                # CLI demo
 *   import { OnlineLearner, hedgeAlgorithm, ftrl, trackRegret } from './online-learning.mjs'
 */

// ─── Utilities ──────────────────────────────────────────

function softmax(arr) {
  const maxVal = Math.max(...arr);
  const exps = arr.map(v => Math.exp(v - maxVal));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(v => v / sum);
}

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function clamp(val, lo, hi) {
  return Math.max(lo, Math.min(hi, val));
}

// ─── EWMA Tracker ──────────────────────────────────────

/**
 * Exponentially Weighted Moving Average tracker.
 * Tracks a parameter's smoothed value and variance online.
 */
class EWMATracker {
  constructor(span = 20) {
    this.alpha = 2 / (span + 1);
    this.mean = null;
    this.variance = null;
    this.count = 0;
  }

  update(value) {
    this.count++;
    if (this.mean === null) {
      this.mean = value;
      this.variance = 0;
      return this.mean;
    }
    const delta = value - this.mean;
    this.mean = this.alpha * value + (1 - this.alpha) * this.mean;
    this.variance = (1 - this.alpha) * (this.variance + this.alpha * delta * delta);
    return this.mean;
  }

  get std() {
    return this.variance !== null ? Math.sqrt(this.variance) : 0;
  }

  get value() {
    return this.mean;
  }
}

// ─── Online Gradient Descent ────────────────────────────

/**
 * Online Gradient Descent with simplex projection.
 * Updates weights using gradient of loss, projects back onto probability simplex.
 */
class OnlineGradientDescent {
  constructor(nWeights, options = {}) {
    this.n = nWeights;
    this.weights = new Array(nWeights).fill(1 / nWeights);
    this.baseLR = options.learningRate || 0.1;
    this.t = 0;
    this.useSimplex = options.simplex !== false;
  }

  /**
   * Update weights given a loss gradient vector.
   * gradient[i] = partial loss / partial w_i
   */
  step(gradient) {
    this.t++;
    const lr = this.baseLR / Math.sqrt(this.t);

    for (let i = 0; i < this.n; i++) {
      this.weights[i] -= lr * gradient[i];
    }

    if (this.useSimplex) {
      this._projectSimplex();
    }

    return [...this.weights];
  }

  /**
   * Project weights onto the probability simplex.
   * Ensures weights are non-negative and sum to 1.
   * Uses the O(n log n) sorting-based algorithm.
   */
  _projectSimplex() {
    const sorted = [...this.weights].sort((a, b) => b - a);
    let cumSum = 0;
    let rho = 0;
    for (let j = 0; j < this.n; j++) {
      cumSum += sorted[j];
      if (sorted[j] - (cumSum - 1) / (j + 1) > 0) {
        rho = j + 1;
      }
    }
    const theta = (sorted.slice(0, rho).reduce((a, b) => a + b, 0) - 1) / rho;
    for (let i = 0; i < this.n; i++) {
      this.weights[i] = Math.max(0, this.weights[i] - theta);
    }
  }
}

// ─── Hedge Algorithm (Multiplicative Weights) ───────────

/**
 * Hedge algorithm for expert aggregation.
 * Maintains a probability distribution over experts (strategies).
 * Weights are updated multiplicatively based on observed losses.
 *
 * @param {number} nExperts - Number of expert strategies
 * @param {Object} options - { eta: learning rate, initialWeights }
 * @returns {Object} Hedge instance with update(), predict(), getWeights()
 */
export function hedgeAlgorithm(nExperts, options = {}) {
  const eta = options.eta || Math.sqrt(Math.log(nExperts) / 100);
  let weights = options.initialWeights
    ? [...options.initialWeights]
    : new Array(nExperts).fill(1 / nExperts);
  let cumulativeLoss = new Array(nExperts).fill(0);
  let round = 0;
  const history = [];

  function _normalize() {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    }
  }

  return {
    /**
     * Get current weight distribution over experts.
     */
    getWeights() {
      return [...weights];
    },

    /**
     * Get weighted prediction from expert predictions.
     * @param {number[]} expertPredictions - Each expert's prediction
     * @returns {number} Weighted combination
     */
    predict(expertPredictions) {
      return dotProduct(weights, expertPredictions);
    },

    /**
     * Update weights after observing losses for each expert.
     * @param {number[]} losses - Loss for each expert this round (lower is better)
     * @returns {number[]} Updated weights
     */
    update(losses) {
      round++;

      for (let i = 0; i < weights.length; i++) {
        cumulativeLoss[i] += losses[i];
        weights[i] *= Math.exp(-eta * losses[i]);
      }
      _normalize();

      history.push({
        round,
        weights: [...weights],
        losses: [...losses],
        cumulativeLoss: [...cumulativeLoss],
      });

      return [...weights];
    },

    /**
     * Get the algorithm's cumulative loss vs the best expert in hindsight.
     */
    getRegret() {
      if (history.length === 0) return { algorithmLoss: 0, bestExpertLoss: 0, regret: 0 };

      // Algorithm's cumulative loss = sum of weighted losses each round
      let algoLoss = 0;
      for (const h of history) {
        // Loss of the algorithm is the weighted loss using weights BEFORE update
        const prevWeights = history.indexOf(h) === 0
          ? new Array(weights.length).fill(1 / weights.length)
          : history[history.indexOf(h) - 1].weights;
        algoLoss += dotProduct(prevWeights, h.losses);
      }

      const bestExpertLoss = Math.min(...cumulativeLoss);
      return {
        algorithmLoss: algoLoss,
        bestExpertLoss,
        regret: algoLoss - bestExpertLoss,
        rounds: round,
      };
    },

    getHistory() {
      return history;
    },
  };
}

// ─── Follow the Regularized Leader (FTRL) ───────────────

/**
 * FTRL-Proximal for sparse online learning.
 * Produces sparse weight vectors by using L1 regularization.
 * Commonly used for high-dimensional signal selection.
 *
 * @param {number} nFeatures - Number of features/signals
 * @param {Object} options - { alpha, beta, lambda1, lambda2 }
 * @returns {Object} FTRL instance with update(), predict(), getWeights()
 */
export function ftrl(nFeatures, options = {}) {
  const alpha = options.alpha || 1.0;           // learning rate scaling
  const beta = options.beta || 1.0;             // smoothing parameter
  const lambda1 = options.lambda1 || 0.1;       // L1 regularization (sparsity)
  const lambda2 = options.lambda2 || 0.01;      // L2 regularization (stability)

  // Per-coordinate accumulators
  const z = new Array(nFeatures).fill(0);       // sum of gradients - learning_rate * weight
  const n = new Array(nFeatures).fill(0);       // sum of squared gradients
  let weights = new Array(nFeatures).fill(0);
  let round = 0;
  const history = [];

  function _computeWeights() {
    for (let i = 0; i < nFeatures; i++) {
      if (Math.abs(z[i]) <= lambda1) {
        // L1 threshold: zero out small weights (sparsity)
        weights[i] = 0;
      } else {
        const sign = z[i] >= 0 ? 1 : -1;
        const lr = 1 / ((beta + Math.sqrt(n[i])) / alpha + lambda2);
        weights[i] = -lr * (z[i] - sign * lambda1);
      }
    }
  }

  return {
    /**
     * Get current weight vector (may be sparse).
     */
    getWeights() {
      return [...weights];
    },

    /**
     * Get number of non-zero weights (sparsity measure).
     */
    getSparsity() {
      const nnz = weights.filter(w => w !== 0).length;
      return { nonZero: nnz, total: nFeatures, sparsityRatio: 1 - nnz / nFeatures };
    },

    /**
     * Predict: dot product of weights and features.
     * @param {number[]} features - Feature vector
     * @returns {number} Prediction
     */
    predict(features) {
      _computeWeights();
      return dotProduct(weights, features);
    },

    /**
     * Update after observing gradient.
     * For squared loss on prediction p vs label y:
     *   gradient[i] = (p - y) * feature[i]
     *
     * @param {number[]} features - Feature vector used in prediction
     * @param {number} gradient - Scalar gradient (prediction - label) for linear model
     * @returns {number[]} Updated weights
     */
    update(features, gradient) {
      round++;

      for (let i = 0; i < nFeatures; i++) {
        const gi = gradient * features[i];
        const sigma = (Math.sqrt(n[i] + gi * gi) - Math.sqrt(n[i])) / alpha;
        z[i] += gi - sigma * weights[i];
        n[i] += gi * gi;
      }

      _computeWeights();

      history.push({
        round,
        weights: [...weights],
        sparsity: this.getSparsity(),
      });

      return [...weights];
    },

    getHistory() {
      return history;
    },
  };
}

// ─── Regret Tracker ─────────────────────────────────────

/**
 * Track cumulative regret of an online algorithm vs best fixed strategy in hindsight.
 *
 * @param {number} nStrategies - Number of competing strategies
 * @returns {Object} Regret tracker with record(), getRegret(), getSummary()
 */
export function trackRegret(nStrategies) {
  const strategyRewards = new Array(nStrategies).fill(0);
  let algorithmReward = 0;
  let round = 0;
  const regretHistory = [];

  return {
    /**
     * Record a round: algorithm picked a weighted combination, each strategy got a reward.
     * @param {number} algoReward - Reward achieved by the algorithm this round
     * @param {number[]} rewards - Reward for each strategy this round
     */
    record(algoReward, rewards) {
      round++;
      algorithmReward += algoReward;

      for (let i = 0; i < nStrategies; i++) {
        strategyRewards[i] += rewards[i];
      }

      const bestSoFar = Math.max(...strategyRewards);
      const cumulativeRegret = bestSoFar - algorithmReward;
      const avgRegret = cumulativeRegret / round;

      regretHistory.push({
        round,
        algorithmReward: algoReward,
        cumulativeAlgoReward: algorithmReward,
        bestFixedReward: bestSoFar,
        cumulativeRegret,
        avgRegret,
      });
    },

    /**
     * Get current regret summary.
     */
    getSummary() {
      const bestTotal = Math.max(...strategyRewards);
      const bestIdx = strategyRewards.indexOf(bestTotal);
      const cumulativeRegret = bestTotal - algorithmReward;

      return {
        rounds: round,
        algorithmTotal: algorithmReward,
        bestStrategyTotal: bestTotal,
        bestStrategyIndex: bestIdx,
        cumulativeRegret,
        avgRegret: round > 0 ? cumulativeRegret / round : 0,
        perStrategyTotal: [...strategyRewards],
        // Theoretical bound for Hedge: regret <= sqrt(T * ln(N))
        theoreticalBound: Math.sqrt(round * Math.log(nStrategies)),
        withinBound: cumulativeRegret <= Math.sqrt(round * Math.log(nStrategies)),
      };
    },

    getHistory() {
      return regretHistory;
    },
  };
}

// ─── OnlineLearner (Unified Interface) ──────────────────

/**
 * Unified online learning system that combines EWMA tracking,
 * Hedge expert aggregation, FTRL signal selection, and regret monitoring.
 *
 * Accepts a stream of (signal, outcome) pairs and adapts continuously.
 */
export class OnlineLearner {
  constructor(options = {}) {
    this.nExperts = options.nExperts || 3;
    this.nFeatures = options.nFeatures || this.nExperts;

    // EWMA trackers for each parameter/expert
    this.ewmaTrackers = [];
    for (let i = 0; i < this.nExperts; i++) {
      this.ewmaTrackers.push(new EWMATracker(options.ewmaSpan || 20));
    }

    // Hedge for expert aggregation
    this.hedge = hedgeAlgorithm(this.nExperts, {
      eta: options.hedgeEta || Math.sqrt(Math.log(this.nExperts) / 200),
    });

    // OGD for direct weight optimization
    this.ogd = new OnlineGradientDescent(this.nExperts, {
      learningRate: options.ogdLR || 0.1,
    });

    // FTRL for sparse signal selection
    this.ftrl = ftrl(this.nFeatures, {
      alpha: options.ftrlAlpha || 1.0,
      lambda1: options.ftrlLambda1 || 0.1,
      lambda2: options.ftrlLambda2 || 0.01,
    });

    // Regret tracker
    this.regret = trackRegret(this.nExperts);

    // AdaGrad accumulators for adaptive learning rates
    this.adagradAccum = new Array(this.nExperts).fill(0);
    this.adagradEpsilon = options.adagradEpsilon || 1e-8;
    this.adagradBaseLR = options.adagradLR || 0.5;

    // State
    this.round = 0;
    this.history = [];
  }

  /**
   * Process one (signals, outcome) observation.
   *
   * @param {number[]} expertPredictions - Each expert's prediction for this round
   * @param {number} outcome - Realized outcome (e.g., actual return)
   * @returns {Object} { prediction, hedgeWeights, ogdWeights, ftrlWeights, regretSummary }
   */
  observe(expertPredictions, outcome) {
    this.round++;

    // 1. EWMA tracking of each expert's predictions
    for (let i = 0; i < this.nExperts; i++) {
      this.ewmaTrackers[i].update(expertPredictions[i]);
    }

    // 2. Hedge prediction (weighted combination)
    const hedgeWeights = this.hedge.getWeights();
    const hedgePrediction = dotProduct(hedgeWeights, expertPredictions);

    // 3. Compute losses for each expert: squared error
    const expertLosses = expertPredictions.map(p => (p - outcome) ** 2);
    const expertRewards = expertPredictions.map(p => -((p - outcome) ** 2));
    const hedgeLoss = (hedgePrediction - outcome) ** 2;

    // 4. Update Hedge weights
    this.hedge.update(expertLosses);

    // 5. OGD update: gradient of squared loss w.r.t. weights
    //    loss = (sum(w_i * pred_i) - outcome)^2
    //    d(loss)/d(w_i) = 2 * (prediction - outcome) * pred_i
    const ogdPrediction = dotProduct(this.ogd.weights, expertPredictions);
    const ogdGradient = expertPredictions.map(p => 2 * (ogdPrediction - outcome) * p);
    this.ogd.step(ogdGradient);

    // 6. AdaGrad-style adaptive learning rate update
    const adagradWeights = new Array(this.nExperts);
    for (let i = 0; i < this.nExperts; i++) {
      const grad = 2 * (hedgePrediction - outcome) * expertPredictions[i];
      this.adagradAccum[i] += grad * grad;
      const adaptiveLR = this.adagradBaseLR / (Math.sqrt(this.adagradAccum[i]) + this.adagradEpsilon);
      adagradWeights[i] = adaptiveLR;
    }

    // 7. FTRL update for signal selection
    const ftrlPrediction = this.ftrl.predict(expertPredictions);
    const ftrlGradient = ftrlPrediction - outcome;
    this.ftrl.update(expertPredictions, ftrlGradient);

    // 8. Regret tracking
    const algoReward = -(hedgeLoss); // negative loss as reward
    this.regret.record(algoReward, expertRewards);

    const snapshot = {
      round: this.round,
      outcome,
      expertPredictions: [...expertPredictions],
      hedgePrediction,
      ogdPrediction,
      ftrlPrediction,
      hedgeWeights: this.hedge.getWeights(),
      ogdWeights: [...this.ogd.weights],
      ftrlWeights: this.ftrl.getWeights(),
      ftrlSparsity: this.ftrl.getSparsity(),
      expertLosses,
      hedgeLoss,
      adagradLRs: [...adagradWeights],
      ewmaMeans: this.ewmaTrackers.map(t => t.value),
      ewmaStds: this.ewmaTrackers.map(t => t.std),
    };

    this.history.push(snapshot);
    return snapshot;
  }

  /**
   * Get convergence diagnostics.
   */
  getConvergence() {
    if (this.history.length < 10) return null;

    const recent = this.history.slice(-20);
    const hedgeWeightDiffs = [];
    for (let i = 1; i < recent.length; i++) {
      let maxDiff = 0;
      for (let j = 0; j < this.nExperts; j++) {
        maxDiff = Math.max(maxDiff, Math.abs(recent[i].hedgeWeights[j] - recent[i - 1].hedgeWeights[j]));
      }
      hedgeWeightDiffs.push(maxDiff);
    }

    const avgDiff = hedgeWeightDiffs.reduce((a, b) => a + b, 0) / hedgeWeightDiffs.length;
    const recentLosses = recent.map(h => h.hedgeLoss);
    const avgLoss = recentLosses.reduce((a, b) => a + b, 0) / recentLosses.length;

    return {
      rounds: this.round,
      avgWeightChange: avgDiff,
      converged: avgDiff < 0.005,
      recentAvgLoss: avgLoss,
      regret: this.regret.getSummary(),
    };
  }

  /**
   * Get full state summary.
   */
  getSummary() {
    return {
      rounds: this.round,
      hedgeWeights: this.hedge.getWeights(),
      ogdWeights: [...this.ogd.weights],
      ftrlWeights: this.ftrl.getWeights(),
      ftrlSparsity: this.ftrl.getSparsity(),
      ewma: this.ewmaTrackers.map((t, i) => ({
        expert: i,
        mean: t.value,
        std: t.std,
        observations: t.count,
      })),
      regret: this.regret.getSummary(),
      convergence: this.getConvergence(),
    };
  }
}

// ─── CLI Demo ───────────────────────────────────────────

function pad(s, w = 10) { return String(s).padStart(w); }
function fmt(v, d = 4) { return isNaN(v) ? "N/A" : v.toFixed(d); }

/**
 * Simulate 3 expert strategies with different characteristics:
 *   Expert 0: "Trend Follower" — good in trending markets
 *   Expert 1: "Mean Reverter" — good in ranging markets
 *   Expert 2: "Momentum" — good when volatility is moderate
 *
 * The market regime switches, so the best expert changes over time.
 */
function simulateExperts(round, totalRounds) {
  // Regime shifts: trending -> ranging -> momentum-friendly -> mixed
  const phase = (round / totalRounds) * 4;
  let regime;
  if (phase < 1) regime = "trending";
  else if (phase < 2) regime = "ranging";
  else if (phase < 3) regime = "momentum";
  else regime = "mixed";

  // Simulated true outcome (market return)
  const noise = (Math.random() - 0.5) * 0.04;
  let trend = 0;
  if (regime === "trending") trend = 0.01;
  else if (regime === "ranging") trend = Math.sin(round * 0.3) * 0.005;
  else if (regime === "momentum") trend = 0.005 * Math.sign(Math.sin(round * 0.1));
  else trend = (Math.random() - 0.5) * 0.01;

  const outcome = trend + noise;

  // Expert predictions — intentionally spread apart so weight shifts are visible
  // Expert 0 (Trend Follower): biased toward positive trend, strong in trending regime
  const pred0 = outcome + (Math.random() - 0.5) * 0.03
    + (regime === "trending" ? 0.0 : (Math.random() - 0.5) * 0.04);

  // Expert 1 (Mean Reverter): good in ranging, bad elsewhere
  const pred1 = outcome + (Math.random() - 0.5) * 0.03
    + (regime === "ranging" ? 0.0 : (Math.random() - 0.5) * 0.04);

  // Expert 2 (Momentum): good in momentum regime, bad elsewhere
  const pred2 = outcome + (Math.random() - 0.5) * 0.03
    + (regime === "momentum" ? 0.0 : (Math.random() - 0.5) * 0.04);

  return {
    expertPredictions: [pred0, pred1, pred2],
    outcome,
    regime,
  };
}

async function main() {
  const totalRounds = 500;

  console.log("Online Learning Module -- Inferred Analysis");
  console.log("=".repeat(66));
  console.log(`Simulating ${totalRounds} rounds with 3 expert strategies\n`);
  console.log("Experts:");
  console.log("  [0] Trend Follower — excels in trending markets");
  console.log("  [1] Mean Reverter  — excels in ranging markets");
  console.log("  [2] Momentum       — excels in moderate-volatility markets");
  console.log();

  const learner = new OnlineLearner({
    nExperts: 3,
    hedgeEta: 5.0,
    ogdLR: 0.05,
    ftrlAlpha: 0.5,
    ftrlLambda1: 0.05,
    ftrlLambda2: 0.01,
    adagradLR: 0.3,
    ewmaSpan: 30,
  });

  // Print header
  console.log(
    pad("Round", 6) + "  " +
    pad("Regime", 10) + "  " +
    pad("Outcome", 8) + "  " +
    "  Hedge Weights         " +
    pad("H-Loss", 8) + "  " +
    pad("Regret", 8)
  );
  console.log("-".repeat(90));

  const printInterval = 50;
  let lastRegime = "";

  for (let r = 1; r <= totalRounds; r++) {
    const { expertPredictions, outcome, regime } = simulateExperts(r, totalRounds);
    const result = learner.observe(expertPredictions, outcome);

    // Print at intervals or regime changes
    const regimeChanged = regime !== lastRegime;
    lastRegime = regime;

    if (r % printInterval === 0 || r === 1 || regimeChanged) {
      const hw = result.hedgeWeights;
      const regretInfo = learner.regret.getSummary();
      console.log(
        pad(r, 6) + "  " +
        pad(regime, 10) + "  " +
        pad(fmt(outcome, 4), 8) + "  " +
        `  [${hw.map(w => fmt(w, 3)).join(", ")}]` +
        pad(fmt(result.hedgeLoss, 6), 10) + "  " +
        pad(fmt(regretInfo.cumulativeRegret, 3), 8)
      );
    }
  }

  // Final summary
  const summary = learner.getSummary();
  const regretInfo = summary.regret;
  const convergence = summary.convergence;

  console.log("\n" + "=".repeat(66));
  console.log("  FINAL RESULTS");
  console.log("=".repeat(66));

  console.log("\n  Hedge Weights (expert aggregation):");
  const expertNames = ["Trend Follower", "Mean Reverter", "Momentum"];
  for (let i = 0; i < 3; i++) {
    const barLen = Math.round(summary.hedgeWeights[i] * 40);
    const bar = "#".repeat(barLen);
    console.log(`    [${i}] ${expertNames[i].padEnd(16)} ${fmt(summary.hedgeWeights[i], 4)}  ${bar}`);
  }

  console.log("\n  OGD Weights:");
  for (let i = 0; i < 3; i++) {
    console.log(`    [${i}] ${expertNames[i].padEnd(16)} ${fmt(summary.ogdWeights[i], 4)}`);
  }

  console.log("\n  FTRL Weights (sparse signal selection):");
  for (let i = 0; i < 3; i++) {
    const label = summary.ftrlWeights[i] === 0 ? " (zeroed)" : "";
    console.log(`    [${i}] ${expertNames[i].padEnd(16)} ${fmt(summary.ftrlWeights[i], 4)}${label}`);
  }
  const sp = summary.ftrlSparsity;
  console.log(`    Sparsity: ${sp.nonZero}/${sp.total} active (${(sp.sparsityRatio * 100).toFixed(0)}% sparse)`);

  console.log("\n  EWMA Parameter Tracking:");
  for (let i = 0; i < 3; i++) {
    const e = summary.ewma[i];
    console.log(`    [${i}] ${expertNames[i].padEnd(16)} mean=${fmt(e.mean, 5)}  std=${fmt(e.std, 5)}`);
  }

  console.log("\n  Regret Analysis:");
  console.log(`    Rounds:              ${regretInfo.rounds}`);
  console.log(`    Algorithm Total:     ${fmt(regretInfo.algorithmTotal, 4)}`);
  console.log(`    Best Expert Total:   ${fmt(regretInfo.bestStrategyTotal, 4)} (Expert ${regretInfo.bestStrategyIndex}: ${expertNames[regretInfo.bestStrategyIndex]})`);
  console.log(`    Cumulative Regret:   ${fmt(regretInfo.cumulativeRegret, 4)}`);
  console.log(`    Average Regret:      ${fmt(regretInfo.avgRegret, 6)}`);
  console.log(`    Theoretical Bound:   ${fmt(regretInfo.theoreticalBound, 4)} (sqrt(T*ln(N)))`);
  console.log(`    Within Bound:        ${regretInfo.withinBound ? "YES" : "NO"}`);

  if (convergence) {
    console.log("\n  Convergence:");
    console.log(`    Avg Weight Change:   ${fmt(convergence.avgWeightChange, 6)}`);
    console.log(`    Converged:           ${convergence.converged ? "YES" : "NO"}`);
    console.log(`    Recent Avg Loss:     ${fmt(convergence.recentAvgLoss, 6)}`);
  }

  // Regret curve visualization (sampled)
  const regretHist = learner.regret.getHistory();
  console.log("\n  Cumulative Regret Curve:");
  const maxRegret = Math.max(...regretHist.map(h => Math.abs(h.cumulativeRegret)), 0.001);
  const samplePoints = [1, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500]
    .filter(r => r <= totalRounds);

  for (const r of samplePoints) {
    const h = regretHist[r - 1];
    if (!h) continue;
    const barLen = Math.round(Math.abs(h.cumulativeRegret) / maxRegret * 35);
    const bar = h.cumulativeRegret >= 0 ? "+" .repeat(barLen) : "-".repeat(barLen);
    console.log(`    R${String(r).padStart(4)}: ${bar} ${fmt(h.cumulativeRegret, 3)}`);
  }

  console.log("\n" + "=".repeat(66));
  console.log("  Online learning adapts to regime changes without retraining.");
  console.log("  Regret sublinear in T => algorithm converges to best expert.");
  console.log("=".repeat(66));
}

// Run CLI if called directly
if (process.argv[1]?.includes("online-learning")) {
  main().catch(err => {
    console.error("Online learning demo failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
