#!/usr/bin/env node
/**
 * Correlation Regime Detector — Structural Break & Regime Clustering
 *
 * Detects regime switches in asset correlations for the quant fund platform.
 * Uses rolling pairwise correlations, CUSUM-style structural break detection,
 * and k-means clustering on vectorized upper-triangle correlation matrices
 * to identify distinct correlation regimes and estimate transition dynamics.
 *
 * Usage:
 *   node agents/risk/correlation-regime.mjs
 *   node agents/risk/correlation-regime.mjs --window 60 --regimes 3
 *   node agents/risk/correlation-regime.mjs --symbols SPY,QQQ,TLT,GLD
 *
 * Can also be imported as a module:
 *   import { rollingCorrelation, correlationBreakpoint, CorrelationRegimeDetector }
 *     from './correlation-regime.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Math Helpers ────────────────────────────────────────

/**
 * Arithmetic mean of a numeric array.
 * @param {number[]} arr
 * @returns {number}
 */
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * Population standard deviation.
 * @param {number[]} arr
 * @returns {number}
 */
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/**
 * Compute log returns from a price series.
 * @param {Array<{close: number}>} prices - Array of price objects with `close` field.
 * @returns {number[]} Array of log returns (length = prices.length - 1).
 */
function logReturns(prices) {
  const ret = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1].close;
    const curr = prices[i].close;
    ret.push(prev > 0 && curr > 0 ? Math.log(curr / prev) : 0);
  }
  return ret;
}

/**
 * Pearson correlation between two equal-length arrays.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Correlation in [-1, 1].
 */
function pearson(a, b) {
  const n = a.length;
  if (n === 0) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] - ma;
    const bi = b[i] - mb;
    num += ai * bi;
    da += ai * ai;
    db += bi * bi;
  }
  const denom = Math.sqrt(da * db);
  return denom > 1e-15 ? num / denom : 0;
}

/**
 * Euclidean distance between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

// ─── Rolling Correlation ─────────────────────────────────

/**
 * Compute rolling pairwise Pearson correlation between two return series.
 * @param {number[]} returnsA - Daily returns for asset A.
 * @param {number[]} returnsB - Daily returns for asset B.
 * @param {number} window - Lookback window in days.
 * @returns {number[]} Array of rolling correlations (length = returnsA.length - window + 1).
 */
export function rollingCorrelation(returnsA, returnsB, window) {
  const len = Math.min(returnsA.length, returnsB.length);
  if (len < window) return [];
  const result = [];
  for (let i = 0; i <= len - window; i++) {
    const sliceA = returnsA.slice(i, i + window);
    const sliceB = returnsB.slice(i, i + window);
    result.push(pearson(sliceA, sliceB));
  }
  return result;
}

// ─── Structural Breakpoint Detection ─────────────────────

/**
 * Detect structural breaks in a correlation time series using a CUSUM-style test.
 * Identifies points where the running cumulative sum of deviations from the
 * overall mean exceeds a threshold, signaling a regime change.
 *
 * @param {number[]} correlations - Time series of correlation values.
 * @param {number} [minSegment=20] - Minimum segment length between breakpoints.
 * @returns {{breakpoints: number[], segments: Array<{start: number, end: number, mean: number}>}}
 */
export function correlationBreakpoint(correlations, minSegment = 20) {
  const n = correlations.length;
  if (n < minSegment * 2) {
    return {
      breakpoints: [],
      segments: [{ start: 0, end: n - 1, mean: mean(correlations) }],
    };
  }

  const globalMean = mean(correlations);
  const globalStd = stddev(correlations);
  const threshold = globalStd * Math.sqrt(n) * 0.75;

  // Compute CUSUM
  const cusum = new Array(n);
  cusum[0] = correlations[0] - globalMean;
  for (let i = 1; i < n; i++) {
    cusum[i] = cusum[i - 1] + (correlations[i] - globalMean);
  }

  // Find candidate breakpoints: local extrema of CUSUM that exceed threshold
  const candidates = [];
  for (let i = minSegment; i < n - minSegment; i++) {
    const val = Math.abs(cusum[i]);
    if (val < threshold) continue;
    const isLocalMax =
      Math.abs(cusum[i]) >= Math.abs(cusum[i - 1]) &&
      Math.abs(cusum[i]) >= Math.abs(cusum[i + 1]);
    if (isLocalMax) {
      candidates.push({ index: i, score: val });
    }
  }

  // Sort by score descending and greedily pick non-overlapping breakpoints
  candidates.sort((a, b) => b.score - a.score);
  const breakpoints = [];
  for (const c of candidates) {
    const tooClose = breakpoints.some(bp => Math.abs(bp - c.index) < minSegment);
    if (!tooClose) {
      breakpoints.push(c.index);
    }
  }
  breakpoints.sort((a, b) => a - b);

  // Build segments
  const boundaries = [0, ...breakpoints, n];
  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1] - 1;
    const segSlice = correlations.slice(start, end + 1);
    segments.push({ start, end, mean: mean(segSlice) });
  }

  return { breakpoints, segments };
}

// ─── K-Means Clustering ──────────────────────────────────

/**
 * K-means clustering on a set of vectors.
 * @param {number[][]} vectors - Data points to cluster.
 * @param {number} k - Number of clusters.
 * @param {number} [maxIter=100] - Maximum iterations.
 * @returns {{labels: number[], centroids: number[][]}}
 */
function kMeans(vectors, k, maxIter = 100) {
  const n = vectors.length;
  const dim = vectors[0].length;
  if (n <= k) {
    return {
      labels: vectors.map((_, i) => i % k),
      centroids: vectors.slice(0, k),
    };
  }

  // Initialize centroids using k-means++ seeding
  const centroids = [vectors[0].slice()];
  for (let c = 1; c < k; c++) {
    const dists = vectors.map(v => {
      let minD = Infinity;
      for (const cen of centroids) minD = Math.min(minD, euclidean(v, cen));
      return minD * minD;
    });
    const totalDist = dists.reduce((a, b) => a + b, 0);
    let r = Math.random() * totalDist;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      r -= dists[i];
      if (r <= 0) { chosen = i; break; }
    }
    centroids.push(vectors[chosen].slice());
  }

  let labels = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each point to nearest centroid
    const newLabels = vectors.map(v => {
      let bestDist = Infinity, bestK = 0;
      for (let c = 0; c < k; c++) {
        const d = euclidean(v, centroids[c]);
        if (d < bestDist) { bestDist = d; bestK = c; }
      }
      return bestK;
    });

    // Check convergence
    const changed = newLabels.some((l, i) => l !== labels[i]);
    labels = newLabels;
    if (!changed) break;

    // Recompute centroids
    for (let c = 0; c < k; c++) {
      const members = vectors.filter((_, i) => labels[i] === c);
      if (members.length === 0) continue;
      for (let d = 0; d < dim; d++) {
        centroids[c][d] = mean(members.map(m => m[d]));
      }
    }
  }

  return { labels, centroids };
}

// ─── Correlation Regime Detector Class ───────────────────

/**
 * Detects and analyzes correlation regimes across a basket of assets.
 * Clusters rolling correlation matrices into discrete regimes using k-means
 * on the vectorized upper triangle, then estimates transition dynamics.
 */
export class CorrelationRegimeDetector {
  /**
   * @param {Object<string, Array<{date: string, close: number}>>} priceArrays
   *   Map of symbol name to price series. Each series must contain {date, close}.
   */
  constructor(priceArrays) {
    this.symbols = Object.keys(priceArrays);
    this.prices = priceArrays;

    // Compute log returns for each symbol
    this.returns = {};
    for (const sym of this.symbols) {
      this.returns[sym] = logReturns(priceArrays[sym]);
    }

    // Align all return series to the same length
    this.alignedLength = Math.min(...this.symbols.map(s => this.returns[s].length));
    for (const sym of this.symbols) {
      const r = this.returns[sym];
      this.returns[sym] = r.slice(r.length - this.alignedLength);
    }

    this.dates = priceArrays[this.symbols[0]]
      .slice(-this.alignedLength)
      .map(p => p.date);

    this._regimeResult = null;
  }

  /**
   * Extract the upper triangle of an NxN correlation matrix as a flat vector.
   * @param {number[][]} matrix
   * @returns {number[]}
   */
  _upperTriangle(matrix) {
    const vec = [];
    const n = matrix.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        vec.push(matrix[i][j]);
      }
    }
    return vec;
  }

  /**
   * Compute correlation matrix for a window of returns ending at index `end`.
   * @param {number} start
   * @param {number} end
   * @returns {number[][]}
   */
  _correlationMatrix(start, end) {
    const n = this.symbols.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1.0;
      const ri = this.returns[this.symbols[i]].slice(start, end);
      for (let j = i + 1; j < n; j++) {
        const rj = this.returns[this.symbols[j]].slice(start, end);
        const corr = pearson(ri, rj);
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }
    return matrix;
  }

  /**
   * Detect correlation regimes by clustering rolling correlation matrices.
   *
   * Computes a correlation matrix at each rolling window step, vectorizes the
   * upper triangle, and clusters all vectors into `numRegimes` groups via k-means.
   *
   * @param {number} [window=60] - Rolling window size in trading days.
   * @param {number} [numRegimes=3] - Number of regimes to detect.
   * @returns {{labels: number[], centroids: number[][], dates: string[], matrices: number[][][]}}
   */
  detectRegimes(window = 60, numRegimes = 3) {
    const totalSteps = this.alignedLength - window;
    if (totalSteps < numRegimes) {
      throw new Error(`Not enough data: ${totalSteps} steps for ${numRegimes} regimes.`);
    }

    // Build rolling correlation matrix vectors
    const vectors = [];
    const matrices = [];
    const stepDates = [];

    for (let t = 0; t < totalSteps; t++) {
      const mat = this._correlationMatrix(t, t + window);
      matrices.push(mat);
      vectors.push(this._upperTriangle(mat));
      stepDates.push(this.dates[t + window - 1]);
    }

    // Cluster via k-means
    const { labels, centroids } = kMeans(vectors, numRegimes);

    this._regimeResult = { labels, centroids, dates: stepDates, matrices, window };
    return this._regimeResult;
  }

  /**
   * Identify which regime the most recent observation belongs to.
   * Must call `detectRegimes()` first.
   *
   * @returns {{regime: number, date: string, centroidDistance: number}}
   */
  getCurrentRegime() {
    if (!this._regimeResult) {
      throw new Error("Call detectRegimes() before getCurrentRegime().");
    }
    const { labels, centroids, dates } = this._regimeResult;
    const lastIdx = labels.length - 1;
    const regime = labels[lastIdx];
    const lastVec = this._upperTriangle(this._regimeResult.matrices[lastIdx]);
    const dist = euclidean(lastVec, centroids[regime]);

    return { regime, date: dates[lastIdx], centroidDistance: +dist.toFixed(4) };
  }

  /**
   * Estimate the regime transition probability matrix.
   * Entry [i][j] = P(next regime = j | current regime = i).
   *
   * @returns {number[][]} Transition matrix of shape [numRegimes x numRegimes].
   */
  getTransitionMatrix() {
    if (!this._regimeResult) {
      throw new Error("Call detectRegimes() before getTransitionMatrix().");
    }
    const { labels, centroids } = this._regimeResult;
    const k = centroids.length;
    const counts = Array.from({ length: k }, () => new Array(k).fill(0));
    const rowTotals = new Array(k).fill(0);

    for (let t = 0; t < labels.length - 1; t++) {
      const from = labels[t];
      const to = labels[t + 1];
      counts[from][to]++;
      rowTotals[from]++;
    }

    // Normalize to probabilities
    const matrix = counts.map((row, i) =>
      row.map(c => (rowTotals[i] > 0 ? +(c / rowTotals[i]).toFixed(4) : 0))
    );

    return matrix;
  }

  /**
   * Compute summary statistics per regime.
   * Returns average correlation, average daily volatility, and average daily
   * return within each regime.
   *
   * @returns {Array<{regime: number, days: number, avgCorrelation: number, avgVolatility: number, avgReturn: number}>}
   */
  getRegimeStats() {
    if (!this._regimeResult) {
      throw new Error("Call detectRegimes() before getRegimeStats().");
    }
    const { labels, centroids, matrices } = this._regimeResult;
    const k = centroids.length;
    const stats = [];

    for (let r = 0; r < k; r++) {
      const indices = labels.map((l, i) => (l === r ? i : -1)).filter(i => i >= 0);
      if (indices.length === 0) {
        stats.push({ regime: r, days: 0, avgCorrelation: 0, avgVolatility: 0, avgReturn: 0 });
        continue;
      }

      // Average upper-triangle correlation across regime days
      const corrMeans = indices.map(i => mean(this._upperTriangle(matrices[i])));
      const avgCorrelation = mean(corrMeans);

      // Average volatility and return: use the return at window end index
      const window = this._regimeResult.window;
      const dailyVols = [];
      const dailyRets = [];
      for (const idx of indices) {
        const t = idx + window - 1;
        const symReturns = this.symbols.map(s => this.returns[s][t] || 0);
        dailyRets.push(mean(symReturns));
        dailyVols.push(stddev(symReturns));
      }

      stats.push({
        regime: r,
        days: indices.length,
        avgCorrelation: +avgCorrelation.toFixed(4),
        avgVolatility: +mean(dailyVols).toFixed(6),
        avgReturn: +mean(dailyRets).toFixed(6),
      });
    }

    return stats;
  }

  /**
   * Correlation stress test: compare correlation structure during drawdown
   * periods vs. normal periods.
   *
   * A drawdown period is defined as any day where the equal-weight portfolio
   * return falls below the 10th percentile. Reports average pairwise
   * correlations during stress vs. calm markets.
   *
   * @param {number} [drawdownPercentile=10] - Percentile threshold for drawdowns.
   * @returns {{stress: {avgCorrelation: number, count: number}, normal: {avgCorrelation: number, count: number}, correlationSpike: number}}
   */
  correlationStressTest(drawdownPercentile = 10) {
    // Compute equal-weight portfolio return each day
    const portfolioReturns = [];
    for (let t = 0; t < this.alignedLength; t++) {
      const dayRet = mean(this.symbols.map(s => this.returns[s][t]));
      portfolioReturns.push(dayRet);
    }

    // Find percentile threshold
    const sorted = [...portfolioReturns].sort((a, b) => a - b);
    const cutoffIdx = Math.floor(sorted.length * drawdownPercentile / 100);
    const cutoff = sorted[cutoffIdx];

    // Classify days and compute windowed correlations
    const stressWindow = 20;
    const stressCorrs = [];
    const normalCorrs = [];

    for (let t = stressWindow; t < this.alignedLength; t++) {
      const isStress = portfolioReturns[t] <= cutoff;
      const n = this.symbols.length;
      const corrValues = [];

      for (let i = 0; i < n; i++) {
        const ri = this.returns[this.symbols[i]].slice(t - stressWindow, t);
        for (let j = i + 1; j < n; j++) {
          const rj = this.returns[this.symbols[j]].slice(t - stressWindow, t);
          corrValues.push(pearson(ri, rj));
        }
      }

      const avgCorr = mean(corrValues);
      if (isStress) {
        stressCorrs.push(avgCorr);
      } else {
        normalCorrs.push(avgCorr);
      }
    }

    const stressAvg = mean(stressCorrs);
    const normalAvg = mean(normalCorrs);

    return {
      stress: { avgCorrelation: +stressAvg.toFixed(4), count: stressCorrs.length },
      normal: { avgCorrelation: +normalAvg.toFixed(4), count: normalCorrs.length },
      correlationSpike: +(stressAvg - normalAvg).toFixed(4),
    };
  }
}

// ─── CLI Demo ────────────────────────────────────────────

/**
 * CLI entry point: runs a full regime detection demo using synthetic data.
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse CLI flags
  let window = 60;
  let numRegimes = 3;
  let symbols = ["SPY", "QQQ", "TLT", "GLD", "XLE", "XLF"];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--window" && args[i + 1]) window = parseInt(args[++i], 10);
    if (args[i] === "--regimes" && args[i + 1]) numRegimes = parseInt(args[++i], 10);
    if (args[i] === "--symbols" && args[i + 1]) symbols = args[++i].split(",");
  }

  console.log("=== Correlation Regime Detector ===\n");
  console.log(`Symbols: ${symbols.join(", ")}`);
  console.log(`Window:  ${window} days`);
  console.log(`Regimes: ${numRegimes}\n`);

  // Generate synthetic price data
  console.log("--- Generating price data ---");
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2018-01-01", "2025-12-31");
  }

  // Demonstrate rolling correlation
  console.log("\n--- Rolling Correlation (SPY vs TLT) ---");
  const retSPY = logReturns(priceArrays.SPY);
  const retTLT = logReturns(priceArrays.TLT);
  const rollCorr = rollingCorrelation(retSPY, retTLT, window);
  console.log(`  Series length: ${rollCorr.length}`);
  console.log(`  Current:       ${rollCorr[rollCorr.length - 1]?.toFixed(4)}`);
  console.log(`  Mean:          ${mean(rollCorr).toFixed(4)}`);
  console.log(`  Std:           ${stddev(rollCorr).toFixed(4)}`);

  // Demonstrate breakpoint detection
  console.log("\n--- Structural Breakpoints (SPY-TLT correlation) ---");
  const bp = correlationBreakpoint(rollCorr, 40);
  console.log(`  Breakpoints found: ${bp.breakpoints.length}`);
  for (const seg of bp.segments) {
    console.log(`    Segment [${seg.start}–${seg.end}]: mean corr = ${seg.mean.toFixed(4)}`);
  }

  // Full regime detection
  console.log("\n--- Regime Detection ---");
  const detector = new CorrelationRegimeDetector(priceArrays);
  const result = detector.detectRegimes(window, numRegimes);
  console.log(`  Total observations: ${result.labels.length}`);

  // Regime distribution
  const regimeCounts = {};
  for (const l of result.labels) regimeCounts[l] = (regimeCounts[l] || 0) + 1;
  for (const [r, count] of Object.entries(regimeCounts)) {
    console.log(`  Regime ${r}: ${count} days (${(100 * count / result.labels.length).toFixed(1)}%)`);
  }

  // Current regime
  const current = detector.getCurrentRegime();
  console.log(`\n--- Current Regime ---`);
  console.log(`  Regime:   ${current.regime}`);
  console.log(`  Date:     ${current.date}`);
  console.log(`  Distance: ${current.centroidDistance}`);

  // Transition matrix
  const transMatrix = detector.getTransitionMatrix();
  console.log(`\n--- Transition Matrix ---`);
  const header = "       " + Array.from({ length: numRegimes }, (_, i) => `  R${i}  `).join("");
  console.log(header);
  for (let i = 0; i < numRegimes; i++) {
    const row = transMatrix[i].map(p => p.toFixed(3).padStart(6)).join(" ");
    console.log(`  R${i}  ${row}`);
  }

  // Regime stats
  const stats = detector.getRegimeStats();
  console.log(`\n--- Regime Statistics ---`);
  console.log("  Regime  Days   AvgCorr   AvgVol     AvgRet");
  for (const s of stats) {
    console.log(
      `  R${s.regime}     ` +
      `${String(s.days).padStart(5)}  ` +
      `${s.avgCorrelation.toFixed(4).padStart(8)}  ` +
      `${s.avgVolatility.toFixed(6).padStart(9)}  ` +
      `${s.avgReturn.toFixed(6).padStart(9)}`
    );
  }

  // Stress test
  const stress = detector.correlationStressTest();
  console.log(`\n--- Correlation Stress Test ---`);
  console.log(`  Normal periods: avg corr = ${stress.normal.avgCorrelation} (${stress.normal.count} days)`);
  console.log(`  Stress periods: avg corr = ${stress.stress.avgCorrelation} (${stress.stress.count} days)`);
  console.log(`  Correlation spike during stress: ${stress.correlationSpike > 0 ? "+" : ""}${stress.correlationSpike}`);

  console.log("\nDone.");
}

// Run CLI if called directly
if (process.argv[1]?.includes("correlation-regime.mjs")) {
  main().catch(err => {
    console.error("Correlation regime detection failed:", err.message);
    process.exit(1);
  });
}
