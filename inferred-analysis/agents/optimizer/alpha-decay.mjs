#!/usr/bin/env node
/**
 * Alpha Decay Tracking Module — Inferred Analysis
 *
 * Monitors how strategy alpha degrades over time and recommends retirement.
 *
 * Features:
 *   1. Rolling Sharpe ratio with confidence intervals
 *   2. Alpha half-life estimation (exponential decay fit)
 *   3. Strategy crowding detection (alpha compression)
 *   4. Capacity decay: alpha vs AUM relationship
 *   5. Signal novelty scoring
 *   6. Auto-retirement recommendation
 *
 * Usage:
 *   node agents/optimizer/alpha-decay.mjs
 *   node agents/optimizer/alpha-decay.mjs --days 500 --window 63
 *   node agents/optimizer/alpha-decay.mjs --initial-sharpe 2.5 --decay-rate 0.004
 */

// ─── CLI Args ─────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    days: 750,
    window: 63,             // rolling window size (trading days)
    initialSharpe: 2.0,     // starting annualized Sharpe
    decayRate: 0.003,       // daily alpha decay factor
    noiseStd: 0.15,         // noise in daily returns
    aumGrowthRate: 0.002,   // daily AUM growth factor
    initialAum: 10_000_000, // starting AUM
    confidenceLevel: 0.95,
    verbose: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days") opts.days = parseInt(args[++i]);
    if (args[i] === "--window") opts.window = parseInt(args[++i]);
    if (args[i] === "--initial-sharpe") opts.initialSharpe = parseFloat(args[++i]);
    if (args[i] === "--decay-rate") opts.decayRate = parseFloat(args[++i]);
    if (args[i] === "--noise") opts.noiseStd = parseFloat(args[++i]);
    if (args[i] === "--aum-growth") opts.aumGrowthRate = parseFloat(args[++i]);
    if (args[i] === "--initial-aum") opts.initialAum = parseFloat(args[++i]);
    if (args[i] === "--confidence") opts.confidenceLevel = parseFloat(args[++i]);
    if (args[i] === "--verbose" || args[i] === "-v") opts.verbose = true;
  }
  return opts;
}

// ─── Statistics Helpers ───────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function zScore(confidenceLevel) {
  // Common z-scores for two-tailed confidence intervals
  const table = {
    0.90: 1.645,
    0.95: 1.96,
    0.99: 2.576,
  };
  return table[confidenceLevel] ?? 1.96;
}

/** Box-Muller transform for normal random variates */
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Simple linear regression: y = a + b*x. Returns { slope, intercept, rSquared } */
function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, rSquared: 0 };

  const mx = mean(xs);
  const my = mean(ys);
  let ssXY = 0, ssXX = 0, ssTot = 0;

  for (let i = 0; i < n; i++) {
    ssXY += (xs[i] - mx) * (ys[i] - my);
    ssXX += (xs[i] - mx) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }

  const slope = ssXX > 0 ? ssXY / ssXX : 0;
  const intercept = my - slope * mx;
  const ssRes = ys.reduce((sum, y, i) => sum + (y - (intercept + slope * xs[i])) ** 2, 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, rSquared };
}

/** Cosine similarity between two equal-length vectors */
function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ─── AlphaDecayMonitor ────────────────────────────────────

export class AlphaDecayMonitor {
  /**
   * @param {object} config
   * @param {number} config.window         Rolling window size in periods
   * @param {number} config.confidenceLevel Confidence level for intervals (0-1)
   */
  constructor(config = {}) {
    this.window = config.window ?? 63;
    this.confidenceLevel = config.confidenceLevel ?? 0.95;
    this.returns = [];
    this.timestamps = [];
    this.aumSeries = [];
    this.signals = [];    // stored signal vectors for novelty scoring
  }

  /**
   * Ingest a new return observation.
   * @param {number} ret     Period return
   * @param {number} [ts]    Timestamp / day index
   * @param {number} [aum]   Current AUM at this point
   */
  addReturn(ret, ts = null, aum = null) {
    this.returns.push(ret);
    this.timestamps.push(ts ?? this.returns.length - 1);
    if (aum !== null) this.aumSeries.push(aum);
  }

  /**
   * Register a signal vector for novelty comparison.
   * @param {number[]} signalVector
   */
  addSignal(signalVector) {
    this.signals.push(signalVector);
  }

  // ── 1. Rolling Sharpe with confidence intervals ──────

  /**
   * Compute rolling Sharpe ratio with confidence intervals.
   * @returns {{ day: number, sharpe: number, lower: number, upper: number }[]}
   */
  rollingSharpe() {
    const results = [];
    const z = zScore(this.confidenceLevel);

    for (let i = this.window - 1; i < this.returns.length; i++) {
      const slice = this.returns.slice(i - this.window + 1, i + 1);
      const m = mean(slice);
      const s = stddev(slice);
      const sharpe = s > 0 ? (m / s) * Math.sqrt(252) : 0;

      // Sharpe ratio standard error: SE = sqrt((1 + 0.5 * sharpe^2) / n)
      const n = slice.length;
      const se = Math.sqrt((1 + 0.5 * sharpe * sharpe) / n);
      const lower = sharpe - z * se;
      const upper = sharpe + z * se;

      results.push({
        day: this.timestamps[i],
        sharpe,
        lower,
        upper,
      });
    }

    return results;
  }

  // ── 2. Alpha half-life estimation ────────────────────

  /**
   * Fit an exponential decay to the rolling Sharpe series.
   * Model: Sharpe(t) = A * exp(-lambda * t)
   * Half-life = ln(2) / lambda
   *
   * @returns {{ halfLife: number, lambda: number, initialAlpha: number, rSquared: number, fit: string }}
   */
  estimateHalfLife() {
    const rolling = this.rollingSharpe();
    if (rolling.length < 5) {
      return { halfLife: Infinity, lambda: 0, initialAlpha: 0, rSquared: 0, fit: "insufficient_data" };
    }

    // Take log of positive Sharpe values and fit linear regression
    // ln(Sharpe) = ln(A) - lambda * t
    const xs = [];
    const ys = [];
    for (const r of rolling) {
      if (r.sharpe > 0.01) {  // skip near-zero / negative
        xs.push(r.day);
        ys.push(Math.log(r.sharpe));
      }
    }

    if (xs.length < 3) {
      return { halfLife: Infinity, lambda: 0, initialAlpha: 0, rSquared: 0, fit: "no_positive_sharpe" };
    }

    const reg = linearRegression(xs, ys);
    const lambda = -reg.slope;  // decay rate (positive if decaying)
    const initialAlpha = Math.exp(reg.intercept);
    const halfLife = lambda > 0 ? Math.LN2 / lambda : Infinity;

    let fit;
    if (reg.rSquared > 0.7 && lambda > 0) fit = "strong_decay";
    else if (reg.rSquared > 0.4 && lambda > 0) fit = "moderate_decay";
    else if (lambda <= 0) fit = "no_decay";
    else fit = "weak_decay";

    return {
      halfLife: Math.round(halfLife),
      lambda,
      initialAlpha,
      rSquared: reg.rSquared,
      fit,
    };
  }

  // ── 3. Strategy crowding detection ───────────────────

  /**
   * Detect alpha compression over time: the rolling Sharpe's variance
   * shrinks toward zero as crowding increases.
   *
   * Measures:
   *   - Alpha compression ratio (recent vol / early vol of rolling Sharpe)
   *   - Trend in rolling Sharpe dispersion
   *   - Crowding score 0-1 (1 = fully crowded)
   *
   * @returns {{ crowdingScore: number, compressionRatio: number, verdict: string }}
   */
  crowdingScore() {
    const rolling = this.rollingSharpe();
    if (rolling.length < this.window * 2) {
      return { crowdingScore: 0, compressionRatio: 1, verdict: "insufficient_data" };
    }

    const halfIdx = Math.floor(rolling.length / 2);
    const earlyHalf = rolling.slice(0, halfIdx).map(r => r.sharpe);
    const lateHalf = rolling.slice(halfIdx).map(r => r.sharpe);

    const earlyVol = stddev(earlyHalf);
    const lateVol = stddev(lateHalf);
    const compressionRatio = earlyVol > 0 ? lateVol / earlyVol : 1;

    // Also check if mean Sharpe is declining
    const earlyMean = mean(earlyHalf);
    const lateMean = mean(lateHalf);
    const meanDecline = earlyMean > 0 ? Math.max(0, 1 - lateMean / earlyMean) : 0;

    // Crowding score: weighted combination of compression and mean decline
    const rawScore = 0.4 * Math.max(0, 1 - compressionRatio) + 0.6 * meanDecline;
    const crowdingScore = Math.max(0, Math.min(1, rawScore));

    let verdict;
    if (crowdingScore > 0.7) verdict = "high_crowding";
    else if (crowdingScore > 0.4) verdict = "moderate_crowding";
    else if (crowdingScore > 0.15) verdict = "low_crowding";
    else verdict = "no_crowding";

    return { crowdingScore, compressionRatio, verdict };
  }

  // ── 4. Capacity decay: alpha vs AUM ──────────────────

  /**
   * Estimate how alpha decays as AUM grows.
   * Regresses rolling Sharpe against log(AUM).
   *
   * @returns {{ slope: number, rSquared: number, capacityLimit: number|null, verdict: string }}
   */
  capacityDecay() {
    const rolling = this.rollingSharpe();
    if (this.aumSeries.length < this.window || rolling.length === 0) {
      return { slope: 0, rSquared: 0, capacityLimit: null, verdict: "insufficient_data" };
    }

    // Align AUM series with rolling Sharpe (rolling starts at window-1)
    const offset = this.window - 1;
    const n = Math.min(rolling.length, this.aumSeries.length - offset);
    if (n < 5) {
      return { slope: 0, rSquared: 0, capacityLimit: null, verdict: "insufficient_data" };
    }

    const xs = [];
    const ys = [];
    for (let i = 0; i < n; i++) {
      const aum = this.aumSeries[offset + i];
      if (aum > 0) {
        xs.push(Math.log(aum));
        ys.push(rolling[i].sharpe);
      }
    }

    if (xs.length < 5) {
      return { slope: 0, rSquared: 0, capacityLimit: null, verdict: "insufficient_data" };
    }

    const reg = linearRegression(xs, ys);

    // Estimate AUM where Sharpe hits zero: 0 = intercept + slope * ln(AUM)
    let capacityLimit = null;
    if (reg.slope < 0 && reg.intercept > 0) {
      capacityLimit = Math.exp(-reg.intercept / reg.slope);
    }

    let verdict;
    if (reg.slope < -0.3 && reg.rSquared > 0.3) verdict = "strong_capacity_constraint";
    else if (reg.slope < -0.1) verdict = "moderate_capacity_constraint";
    else if (reg.slope < 0) verdict = "mild_capacity_constraint";
    else verdict = "no_capacity_constraint";

    return {
      slope: reg.slope,
      rSquared: reg.rSquared,
      capacityLimit,
      verdict,
    };
  }

  // ── 5. Signal novelty scoring ────────────────────────

  /**
   * Score how different a new signal vector is from all existing signals.
   * Uses 1 - max(cosine_similarity) against stored signals.
   *
   * @param {number[]} newSignal
   * @returns {{ noveltyScore: number, maxSimilarity: number, mostSimilarIdx: number, verdict: string }}
   */
  signalNovelty(newSignal) {
    if (this.signals.length === 0) {
      return { noveltyScore: 1.0, maxSimilarity: 0, mostSimilarIdx: -1, verdict: "fully_novel" };
    }

    let maxSim = -Infinity;
    let mostSimilarIdx = 0;

    for (let i = 0; i < this.signals.length; i++) {
      const sim = cosineSimilarity(newSignal, this.signals[i]);
      if (sim > maxSim) {
        maxSim = sim;
        mostSimilarIdx = i;
      }
    }

    const noveltyScore = Math.max(0, 1 - maxSim);

    let verdict;
    if (noveltyScore > 0.7) verdict = "highly_novel";
    else if (noveltyScore > 0.4) verdict = "moderately_novel";
    else if (noveltyScore > 0.15) verdict = "low_novelty";
    else verdict = "redundant";

    return { noveltyScore, maxSimilarity: maxSim, mostSimilarIdx, verdict };
  }

  // ── 6. Auto-retirement recommendation ───────────────

  /**
   * Aggregate all decay signals into a retirement recommendation.
   *
   * @returns {{
   *   retire: boolean,
   *   urgency: string,
   *   score: number,
   *   reasons: string[],
   *   halfLife: object,
   *   crowding: object,
   *   capacity: object,
   *   latestSharpe: object|null,
   * }}
   */
  retirementRecommendation() {
    const rolling = this.rollingSharpe();
    const hl = this.estimateHalfLife();
    const crowd = this.crowdingScore();
    const cap = this.capacityDecay();

    const reasons = [];
    let score = 0;  // 0 = keep, 1 = definitely retire

    // Latest Sharpe analysis
    const latestSharpe = rolling.length > 0 ? rolling[rolling.length - 1] : null;
    if (latestSharpe) {
      if (latestSharpe.sharpe < 0) {
        score += 0.35;
        reasons.push(`Negative current Sharpe (${latestSharpe.sharpe.toFixed(3)})`);
      } else if (latestSharpe.sharpe < 0.5) {
        score += 0.2;
        reasons.push(`Low current Sharpe (${latestSharpe.sharpe.toFixed(3)})`);
      }
      if (latestSharpe.upper < 0.5) {
        score += 0.1;
        reasons.push("Upper confidence bound below 0.5");
      }
    }

    // Half-life signal
    if (hl.fit === "strong_decay" && hl.halfLife < 180) {
      score += 0.25;
      reasons.push(`Short half-life: ${hl.halfLife} days (strong fit R2=${hl.rSquared.toFixed(2)})`);
    } else if (hl.fit === "moderate_decay" && hl.halfLife < 120) {
      score += 0.15;
      reasons.push(`Moderate decay with ${hl.halfLife}-day half-life`);
    }

    // Crowding signal
    if (crowd.verdict === "high_crowding") {
      score += 0.2;
      reasons.push(`High crowding detected (score=${crowd.crowdingScore.toFixed(2)})`);
    } else if (crowd.verdict === "moderate_crowding") {
      score += 0.1;
      reasons.push(`Moderate crowding (score=${crowd.crowdingScore.toFixed(2)})`);
    }

    // Capacity signal
    if (cap.verdict === "strong_capacity_constraint") {
      score += 0.15;
      const limit = cap.capacityLimit ? `$${(cap.capacityLimit / 1e6).toFixed(1)}M` : "unknown";
      reasons.push(`Strong capacity constraint (limit ~${limit})`);
    }

    score = Math.min(1, score);

    let urgency;
    let retire;
    if (score >= 0.7) { urgency = "immediate"; retire = true; }
    else if (score >= 0.5) { urgency = "soon"; retire = true; }
    else if (score >= 0.3) { urgency = "monitor"; retire = false; }
    else { urgency = "none"; retire = false; }

    if (reasons.length === 0) {
      reasons.push("No significant decay signals detected");
    }

    return {
      retire,
      urgency,
      score,
      reasons,
      halfLife: hl,
      crowding: crowd,
      capacity: cap,
      latestSharpe,
    };
  }
}

// ─── Convenience Exports ──────────────────────────────────

/**
 * Track alpha for a returns series with optional AUM.
 * Returns the full rolling Sharpe series with confidence intervals.
 */
export function trackAlpha(returns, config = {}) {
  const monitor = new AlphaDecayMonitor(config);
  for (let i = 0; i < returns.length; i++) {
    monitor.addReturn(returns[i], i);
  }
  return monitor.rollingSharpe();
}

/**
 * Estimate half-life from a returns series.
 */
export function estimateHalfLife(returns, config = {}) {
  const monitor = new AlphaDecayMonitor(config);
  for (let i = 0; i < returns.length; i++) {
    monitor.addReturn(returns[i], i);
  }
  return monitor.estimateHalfLife();
}

/**
 * Compute crowding score from a returns series.
 */
export function crowdingScore(returns, config = {}) {
  const monitor = new AlphaDecayMonitor(config);
  for (let i = 0; i < returns.length; i++) {
    monitor.addReturn(returns[i], i);
  }
  return monitor.crowdingScore();
}

/**
 * Full retirement recommendation from returns + AUM series.
 */
export function retirementRecommendation(returns, aumSeries = null, config = {}) {
  const monitor = new AlphaDecayMonitor(config);
  for (let i = 0; i < returns.length; i++) {
    const aum = aumSeries ? aumSeries[i] : null;
    monitor.addReturn(returns[i], i, aum);
  }
  return monitor.retirementRecommendation();
}

// ─── Simulation ───────────────────────────────────────────

/**
 * Simulate a strategy that starts with strong alpha and decays over time.
 * Returns daily returns with realistic properties.
 */
function simulateDecayingStrategy(opts) {
  const { days, initialSharpe, decayRate, noiseStd, aumGrowthRate, initialAum } = opts;
  const returns = [];
  const aumSeries = [];

  // Daily target Sharpe decays: sharpe(t) = initialSharpe * exp(-decayRate * t)
  // Daily mean return = (annualized_sharpe / sqrt(252)) * daily_vol
  const dailyVol = noiseStd;

  for (let t = 0; t < days; t++) {
    const currentSharpe = initialSharpe * Math.exp(-decayRate * t);
    const dailyMeanReturn = (currentSharpe / Math.sqrt(252)) * dailyVol;

    // Add regime-change shock around day 400
    let shock = 0;
    if (t > 400 && t < 420) {
      shock = -0.005 * randn();  // negative regime shock
    }

    const ret = dailyMeanReturn + dailyVol * randn() + shock;
    returns.push(ret);

    // AUM grows over time (attracting capital)
    const aum = initialAum * Math.exp(aumGrowthRate * t);
    aumSeries.push(aum);
  }

  return { returns, aumSeries };
}

/**
 * Generate synthetic signal vectors for novelty demo.
 */
function generateSignalVectors(count, dims) {
  const signals = [];
  for (let i = 0; i < count; i++) {
    const vec = [];
    for (let d = 0; d < dims; d++) {
      vec.push(randn());
    }
    signals.push(vec);
  }
  return signals;
}

// ─── Display ──────────────────────────────────────────────

function printRollingSharpe(rolling, step = 50) {
  const line = "=".repeat(62);
  const thin = "-".repeat(62);

  console.log(`\n+${line}+`);
  console.log(`|  Rolling Sharpe Ratio (${rolling.length} observations)${" ".repeat(Math.max(0, 24 - String(rolling.length).length))}|`);
  console.log(`+${line}+`);
  console.log(`|  ${"Day".padEnd(8)} ${"Sharpe".padEnd(10)} ${"95% CI".padEnd(20)} ${"Sparkline".padEnd(20)}|`);
  console.log(`|  ${thin.slice(2)}|`);

  const maxSharpe = Math.max(...rolling.map(r => r.sharpe), 0.01);

  for (let i = 0; i < rolling.length; i += step) {
    const r = rolling[i];
    const ci = `[${r.lower.toFixed(2)}, ${r.upper.toFixed(2)}]`;
    const barLen = Math.max(0, Math.round((r.sharpe / maxSharpe) * 18));
    const bar = r.sharpe >= 0
      ? "#".repeat(Math.min(barLen, 18))
      : "-".repeat(Math.min(Math.abs(barLen), 18));
    console.log(`|  ${String(r.day).padEnd(8)} ${r.sharpe.toFixed(4).padEnd(10)} ${ci.padEnd(20)} ${bar.padEnd(20)}|`);
  }

  // Always show the last point
  if ((rolling.length - 1) % step !== 0 && rolling.length > 0) {
    const r = rolling[rolling.length - 1];
    const ci = `[${r.lower.toFixed(2)}, ${r.upper.toFixed(2)}]`;
    const barLen = Math.max(0, Math.round((r.sharpe / maxSharpe) * 18));
    const bar = r.sharpe >= 0
      ? "#".repeat(Math.min(barLen, 18))
      : "-".repeat(Math.min(Math.abs(barLen), 18));
    console.log(`|  ${String(r.day).padEnd(8)} ${r.sharpe.toFixed(4).padEnd(10)} ${ci.padEnd(20)} ${bar.padEnd(20)}|`);
  }

  console.log(`+${line}+`);
}

function printHalfLife(hl) {
  const line = "-".repeat(50);

  console.log(`\n+${line}+`);
  console.log(`|  Alpha Half-Life Estimation${" ".repeat(21)}|`);
  console.log(`+${line}+`);
  console.log(`|  Half-life:      ${String(hl.halfLife === Infinity ? "INF" : hl.halfLife + " days").padEnd(30)}|`);
  console.log(`|  Decay rate:     ${hl.lambda.toFixed(6).padEnd(30)}|`);
  console.log(`|  Initial alpha:  ${hl.initialAlpha.toFixed(4).padEnd(30)}|`);
  console.log(`|  R-squared:      ${hl.rSquared.toFixed(4).padEnd(30)}|`);
  console.log(`|  Fit quality:    ${hl.fit.padEnd(30)}|`);
  console.log(`+${line}+`);
}

function printCrowding(crowd) {
  const line = "-".repeat(50);
  const barLen = Math.round(crowd.crowdingScore * 30);
  const bar = "#".repeat(barLen).padEnd(30, ".");

  console.log(`\n+${line}+`);
  console.log(`|  Strategy Crowding Detection${" ".repeat(20)}|`);
  console.log(`+${line}+`);
  console.log(`|  Crowding score:    ${crowd.crowdingScore.toFixed(4).padEnd(28)}|`);
  console.log(`|  Compression ratio: ${crowd.compressionRatio.toFixed(4).padEnd(28)}|`);
  console.log(`|  Verdict:           ${crowd.verdict.padEnd(28)}|`);
  console.log(`|  [${bar}] ${(crowd.crowdingScore * 100).toFixed(1)}%${" ".repeat(Math.max(0, 11 - (crowd.crowdingScore * 100).toFixed(1).length))}|`);
  console.log(`+${line}+`);
}

function printCapacity(cap) {
  const line = "-".repeat(50);
  const limitStr = cap.capacityLimit
    ? `$${(cap.capacityLimit / 1e6).toFixed(1)}M`
    : "N/A";

  console.log(`\n+${line}+`);
  console.log(`|  Capacity Decay Analysis${" ".repeat(24)}|`);
  console.log(`+${line}+`);
  console.log(`|  Alpha/log(AUM) slope: ${cap.slope.toFixed(4).padEnd(25)}|`);
  console.log(`|  R-squared:            ${cap.rSquared.toFixed(4).padEnd(25)}|`);
  console.log(`|  Capacity limit:       ${limitStr.padEnd(25)}|`);
  console.log(`|  Verdict:              ${cap.verdict.padEnd(25)}|`);
  console.log(`+${line}+`);
}

function printNovelty(novelty, label) {
  console.log(`  Signal ${label}: novelty=${novelty.noveltyScore.toFixed(3)}, maxSim=${novelty.maxSimilarity.toFixed(3)}, verdict=${novelty.verdict}`);
}

function printRetirement(rec) {
  const line = "=".repeat(62);
  const thin = "-".repeat(62);

  const scoreBar = "#".repeat(Math.round(rec.score * 40)).padEnd(40, ".");

  console.log(`\n+${line}+`);
  console.log(`|  RETIREMENT RECOMMENDATION${" ".repeat(34)}|`);
  console.log(`+${line}+`);
  console.log(`|  Decision:  ${(rec.retire ? "*** RETIRE ***" : "KEEP RUNNING").padEnd(48)}|`);
  console.log(`|  Urgency:   ${rec.urgency.toUpperCase().padEnd(48)}|`);
  console.log(`|  Score:     ${rec.score.toFixed(3).padEnd(48)}|`);
  console.log(`|  [${scoreBar}] ${(rec.score * 100).toFixed(1)}%${" ".repeat(Math.max(0, 14 - (rec.score * 100).toFixed(1).length))}|`);
  console.log(`|  ${thin.slice(2)}|`);
  console.log(`|  Reasons:${" ".repeat(51)}|`);
  for (const reason of rec.reasons) {
    console.log(`|    - ${reason.padEnd(55)}|`);
  }
  console.log(`+${line}+`);
}

// ─── Main (CLI Demo) ─────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`\n+${"=".repeat(58)}+`);
  console.log(`|  Alpha Decay Tracking Module${" ".repeat(28)}|`);
  console.log(`|  Inferred Analysis Platform${" ".repeat(29)}|`);
  console.log(`+${"=".repeat(58)}+`);

  console.log(`\nSimulating strategy with decaying alpha...`);
  console.log(`  Days:           ${opts.days}`);
  console.log(`  Initial Sharpe: ${opts.initialSharpe}`);
  console.log(`  Decay rate:     ${opts.decayRate}/day`);
  console.log(`  Window:         ${opts.window} days`);
  console.log(`  AUM growth:     ${(opts.aumGrowthRate * 100).toFixed(2)}%/day`);

  // 1. Simulate decaying strategy
  const { returns, aumSeries } = simulateDecayingStrategy(opts);

  // 2. Build monitor and ingest data
  const monitor = new AlphaDecayMonitor({
    window: opts.window,
    confidenceLevel: opts.confidenceLevel,
  });

  for (let i = 0; i < returns.length; i++) {
    monitor.addReturn(returns[i], i, aumSeries[i]);
  }

  // 3. Rolling Sharpe
  const rolling = monitor.rollingSharpe();
  printRollingSharpe(rolling, Math.max(1, Math.floor(rolling.length / 12)));

  // 4. Half-life estimation
  const hl = monitor.estimateHalfLife();
  printHalfLife(hl);

  const truHalfLife = Math.round(Math.LN2 / opts.decayRate);
  console.log(`  (True half-life: ${truHalfLife} days | Estimation error: ${Math.abs(hl.halfLife - truHalfLife)} days)`);

  // 5. Crowding detection
  const crowd = monitor.crowdingScore();
  printCrowding(crowd);

  // 6. Capacity decay
  const cap = monitor.capacityDecay();
  printCapacity(cap);

  // 7. Signal novelty scoring
  console.log(`\n+${"-".repeat(50)}+`);
  console.log(`|  Signal Novelty Scoring${" ".repeat(25)}|`);
  console.log(`+${"-".repeat(50)}+`);

  const existingSignals = generateSignalVectors(5, 20);
  for (const sig of existingSignals) {
    monitor.addSignal(sig);
  }

  // Novel signal (random)
  const novelSignal = Array.from({ length: 20 }, () => randn());
  const novelResult = monitor.signalNovelty(novelSignal);
  printNovelty(novelResult, "A (random/novel)");

  // Redundant signal (copy of existing with slight noise)
  const redundantSignal = existingSignals[0].map(v => v + 0.05 * randn());
  const redundantResult = monitor.signalNovelty(redundantSignal);
  printNovelty(redundantResult, "B (near-copy)   ");

  // Partially similar signal
  const partialSignal = existingSignals[2].map((v, i) => i < 10 ? v : randn());
  const partialResult = monitor.signalNovelty(partialSignal);
  printNovelty(partialResult, "C (partial sim) ");

  // 8. Retirement recommendation
  const rec = monitor.retirementRecommendation();
  printRetirement(rec);

  // Machine-readable summary
  console.log("\n--- alpha-decay-summary ---");
  console.log(`days:              ${opts.days}`);
  console.log(`window:            ${opts.window}`);
  console.log(`latest_sharpe:     ${rec.latestSharpe ? rec.latestSharpe.sharpe.toFixed(4) : "N/A"}`);
  console.log(`half_life:         ${hl.halfLife === Infinity ? "INF" : hl.halfLife}`);
  console.log(`half_life_fit:     ${hl.fit}`);
  console.log(`crowding_score:    ${crowd.crowdingScore.toFixed(4)}`);
  console.log(`crowding_verdict:  ${crowd.verdict}`);
  console.log(`capacity_verdict:  ${cap.verdict}`);
  console.log(`retire:            ${rec.retire}`);
  console.log(`retire_urgency:    ${rec.urgency}`);
  console.log(`retire_score:      ${rec.score.toFixed(4)}`);
}

main().catch(err => {
  console.error("Alpha decay tracking failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
