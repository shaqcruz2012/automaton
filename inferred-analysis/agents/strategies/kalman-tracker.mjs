#!/usr/bin/env node
/**
 * Kalman Filter Market Tracker — Inferred Analysis
 *
 * Kalman filter for tracking market state and generating signals:
 * 1. KalmanFilter — generic linear Kalman filter engine
 * 2. KalmanTrendTracker — price trend (level + slope) estimation
 * 3. KalmanPairTracker — pairs trading with time-varying hedge ratio
 * 4. KalmanRegimeFilter — regime detection via innovation analysis
 *
 * Usage:
 *   node agents/strategies/kalman-tracker.mjs
 *   import { KalmanFilter, KalmanTrendTracker } from './kalman-tracker.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Matrix Helpers ──────────────────────────────────────

function zeros(rows, cols) {
  return Array.from({ length: rows }, () => new Float64Array(cols));
}

function eye(n) {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

function matMul(A, B) {
  const rows = A.length, inner = B.length, cols = B[0].length;
  const C = zeros(rows, cols);
  for (let i = 0; i < rows; i++)
    for (let k = 0; k < inner; k++)
      for (let j = 0; j < cols; j++)
        C[i][j] += A[i][k] * B[k][j];
  return C;
}

function matAdd(A, B) {
  return A.map((row, i) => row.map((v, j) => v + B[i][j]));
}

function matSub(A, B) {
  return A.map((row, i) => row.map((v, j) => v - B[i][j]));
}

function transpose(A) {
  const rows = A.length, cols = A[0].length;
  const T = zeros(cols, rows);
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++)
      T[j][i] = A[i][j];
  return T;
}

function matVecMul(A, v) {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
}

/** Invert a small matrix (up to ~4x4) via Gauss-Jordan */
function matInv(M) {
  const n = M.length;
  const aug = M.map((row, i) => {
    const r = new Float64Array(2 * n);
    for (let j = 0; j < n; j++) r[j] = row[j];
    r[n + i] = 1;
    return r;
  });
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(aug[r][col]) > Math.abs(aug[maxRow][col])) maxRow = r;
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col] || 1e-12;
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      for (let j = 0; j < 2 * n; j++) aug[r][j] -= factor * aug[col][j];
    }
  }
  return aug.map(row => {
    const r = new Float64Array(n);
    for (let j = 0; j < n; j++) r[j] = row[n + j];
    return r;
  });
}

function scalarMat(n, s) {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = s;
  return m;
}

// ─── KalmanFilter ────────────────────────────────────────

/**
 * Generic linear Kalman filter.
 * State: x(k+1) = F*x(k) + w,  w ~ N(0, Q)
 * Obs:   z(k)   = H*x(k) + v,  v ~ N(0, R)
 */
export class KalmanFilter {
  constructor(stateSize, obsSize) {
    this.n = stateSize;
    this.m = obsSize;
    this.x = new Float64Array(stateSize);       // state estimate
    this.P = scalarMat(stateSize, 1);            // state covariance
    this.F = eye(stateSize);                     // transition matrix
    this.H = zeros(obsSize, stateSize);          // observation matrix
    this.Q = scalarMat(stateSize, 0.001);        // process noise
    this.R = scalarMat(obsSize, 1);              // measurement noise
  }

  /** Prediction step: propagate state and covariance forward */
  predict() {
    // x = F * x
    this.x = matVecMul(this.F, this.x);
    // P = F * P * F' + Q
    this.P = matAdd(matMul(matMul(this.F, this.P), transpose(this.F)), this.Q);
    return this.x.slice();
  }

  /** Measurement update step */
  update(observation) {
    const z = observation instanceof Float64Array ? observation : Float64Array.from(observation);
    const H = this.H;
    const Ht = transpose(H);

    // Innovation: y = z - H*x
    const predicted = matVecMul(H, this.x);
    const y = z.map((zi, i) => zi - predicted[i]);

    // Innovation covariance: S = H*P*H' + R
    const S = matAdd(matMul(matMul(H, this.P), Ht), this.R);

    // Kalman gain: K = P*H' * S^-1
    const Sinv = matInv(S);
    const K = matMul(matMul(this.P, Ht), Sinv);

    // State update: x = x + K*y
    const Ky = matVecMul(K, y);
    this.x = this.x.map((xi, i) => xi + Ky[i]);

    // Covariance update: P = (I - K*H)*P
    const KH = matMul(K, H);
    const IminusKH = matSub(eye(this.n), KH);
    this.P = matMul(IminusKH, this.P);

    return { innovation: y, innovationCov: S, gain: K };
  }

  /** Current state estimate vector */
  getState() {
    return Array.from(this.x);
  }

  /** Current state covariance matrix */
  getCovariance() {
    return this.P.map(row => Array.from(row));
  }
}

// ─── KalmanTrendTracker ──────────────────────────────────

/**
 * Track price trend using a local linear trend model.
 * State: [level, slope]
 * Observation: price
 *
 * level(t) = level(t-1) + slope(t-1) + w1
 * slope(t) = slope(t-1) + w2
 * price(t) = level(t) + v
 */
export class KalmanTrendTracker {
  constructor(opts = {}) {
    const { processNoise = 0.01, measurementNoise = 1.0, slopeNoise = 0.001 } = opts;
    this.kf = new KalmanFilter(2, 1);

    // Transition: [level, slope] -> [level + slope, slope]
    this.kf.F[0][0] = 1; this.kf.F[0][1] = 1;
    this.kf.F[1][0] = 0; this.kf.F[1][1] = 1;

    // Observation: observe level
    this.kf.H[0][0] = 1; this.kf.H[0][1] = 0;

    // Noise
    this.kf.Q[0][0] = processNoise;
    this.kf.Q[1][1] = slopeNoise;
    this.kf.R[0][0] = measurementNoise;

    this.initialized = false;
    this.prices = [];
    this.innovations = [];
  }

  /** Process a new price observation */
  addPrice(price) {
    if (!this.initialized) {
      this.kf.x[0] = price;
      this.kf.x[1] = 0;
      this.kf.P = scalarMat(2, 10);
      this.initialized = true;
      this.prices.push(price);
      return;
    }

    this.kf.predict();
    const { innovation } = this.kf.update([price]);
    this.prices.push(price);
    this.innovations.push(innovation[0]);
  }

  /** Get estimated trend direction and strength */
  getTrend() {
    const state = this.kf.getState();
    const cov = this.kf.getCovariance();
    const level = state[0];
    const slope = state[1];
    const slopeStd = Math.sqrt(Math.max(0, cov[1][1]));

    // Trend strength: slope normalized by its uncertainty
    const tStat = slopeStd > 0 ? slope / slopeStd : 0;

    let direction = "flat";
    if (tStat > 1.5) direction = "up";
    else if (tStat < -1.5) direction = "down";

    return {
      level: +level.toFixed(4),
      slope: +slope.toFixed(6),
      slopeStd: +slopeStd.toFixed(6),
      tStat: +tStat.toFixed(3),
      direction,
      strength: Math.min(1, Math.abs(tStat) / 3),
    };
  }

  /** Generate trading signal from trend estimate */
  getSignal() {
    const trend = this.getTrend();
    const { tStat, direction, strength } = trend;

    let signal = "hold";
    let confidence = 0;

    if (tStat > 2.0) {
      signal = "buy";
      confidence = Math.min(1, (tStat - 1.5) / 3);
    } else if (tStat < -2.0) {
      signal = "sell";
      confidence = Math.min(1, (-tStat - 1.5) / 3);
    }

    return { signal, confidence: +confidence.toFixed(3), direction, strength: +strength.toFixed(3) };
  }
}

// ─── KalmanPairTracker ───────────────────────────────────

/**
 * Track spread between two assets with time-varying hedge ratio.
 * State: [alpha, beta]  (intercept and hedge ratio)
 * Observation: priceA = alpha + beta * priceB + noise
 *
 * Uses Kalman filter to adaptively estimate the hedge ratio,
 * then computes spread z-score for pairs trading.
 */
export class KalmanPairTracker {
  constructor(opts = {}) {
    const { delta = 0.0001, obsNoise = 1.0, windowSize = 50 } = opts;
    this.kf = new KalmanFilter(2, 1);

    // Random walk transition for [alpha, beta]
    this.kf.F = eye(2);
    this.kf.Q = scalarMat(2, delta);
    this.kf.R[0][0] = obsNoise;

    this.initialized = false;
    this.spreads = [];
    this.windowSize = windowSize;
    this.pricesA = [];
    this.pricesB = [];
  }

  /** Process a new pair of prices */
  addPrices(priceA, priceB) {
    this.pricesA.push(priceA);
    this.pricesB.push(priceB);

    // Set observation matrix: priceA = [1, priceB] * [alpha, beta]'
    this.kf.H[0][0] = 1;
    this.kf.H[0][1] = priceB;

    if (!this.initialized) {
      // Initialize with simple ratio
      this.kf.x[0] = 0;
      this.kf.x[1] = priceA / (priceB || 1);
      this.kf.P = scalarMat(2, 1);
      this.initialized = true;
    }

    this.kf.predict();
    this.kf.update([priceA]);

    // Compute spread
    const state = this.kf.getState();
    const spread = priceA - state[0] - state[1] * priceB;
    this.spreads.push(spread);
  }

  /** Get current optimal hedge ratio */
  getHedgeRatio() {
    const state = this.kf.getState();
    const cov = this.kf.getCovariance();
    return {
      alpha: +state[0].toFixed(4),
      beta: +state[1].toFixed(6),
      betaStd: +Math.sqrt(Math.max(0, cov[1][1])).toFixed(6),
    };
  }

  /** Get z-score of current spread */
  getSpreadZScore() {
    if (this.spreads.length < 10) return { zScore: 0, mean: 0, std: 0, spread: 0 };

    const window = this.spreads.slice(-this.windowSize);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance) || 1e-8;
    const current = this.spreads[this.spreads.length - 1];

    return {
      zScore: +((current - mean) / std).toFixed(4),
      mean: +mean.toFixed(4),
      std: +std.toFixed(4),
      spread: +current.toFixed(4),
    };
  }

  /** Generate pairs trading signal */
  getSignal() {
    const { zScore } = this.getSpreadZScore();
    const hedge = this.getHedgeRatio();

    let signal = "hold";
    let confidence = 0;

    if (zScore > 2.0) {
      signal = "short_spread"; // sell A, buy beta*B
      confidence = Math.min(1, (Math.abs(zScore) - 1.5) / 2);
    } else if (zScore < -2.0) {
      signal = "long_spread";  // buy A, sell beta*B
      confidence = Math.min(1, (Math.abs(zScore) - 1.5) / 2);
    } else if (Math.abs(zScore) < 0.5 && this.spreads.length > 20) {
      signal = "close"; // spread has reverted
      confidence = 1 - Math.abs(zScore);
    }

    return {
      signal,
      confidence: +confidence.toFixed(3),
      zScore,
      hedgeRatio: hedge.beta,
    };
  }
}

// ─── KalmanRegimeFilter ──────────────────────────────────

/**
 * Detect market regime changes using Kalman filter innovation analysis.
 * Tracks expected return and volatility; regime changes detected when
 * innovations deviate significantly from expected.
 *
 * State: [expectedReturn, expectedVolatility]
 */
export class KalmanRegimeFilter {
  constructor(opts = {}) {
    const { processNoise = 0.0001, obsNoise = 0.001, innovWindow = 30 } = opts;
    this.kf = new KalmanFilter(2, 1);

    this.kf.F = eye(2);
    this.kf.Q = scalarMat(2, processNoise);
    this.kf.R[0][0] = obsNoise;
    this.kf.H[0][0] = 1;
    this.kf.H[0][1] = 0;

    this.initialized = false;
    this.innovations = [];
    this.innovSquared = [];
    this.innovWindow = innovWindow;
    this.returns = [];
  }

  /** Process a new return observation */
  addReturn(ret) {
    this.returns.push(ret);

    if (!this.initialized) {
      this.kf.x[0] = ret;
      this.kf.x[1] = Math.abs(ret);
      this.kf.P = scalarMat(2, 0.01);
      this.initialized = true;
      return;
    }

    this.kf.predict();
    const { innovation, innovationCov } = this.kf.update([ret]);
    const innov = innovation[0];
    const innovVar = innovationCov[0][0] || 1e-8;

    this.innovations.push(innov);
    this.innovSquared.push((innov * innov) / innovVar); // normalized squared innovation

    // Update volatility state with realized abs return
    this.kf.x[1] = 0.95 * this.kf.x[1] + 0.05 * Math.abs(ret);
  }

  /** Get current regime estimate */
  getRegime() {
    if (this.innovations.length < 10) {
      return { regime: "unknown", confidence: 0, volLevel: 0, innovRatio: 0 };
    }

    const state = this.kf.getState();
    const expectedReturn = state[0];
    const expectedVol = Math.abs(state[1]);

    // Compute innovation ratio: recent vs. expected
    const recent = this.innovSquared.slice(-this.innovWindow);
    const avgInnovSq = recent.reduce((a, b) => a + b, 0) / recent.length;

    // Under correct model, normalized innovations ~ chi-squared(1), mean = 1
    // High ratio => model mismatch => regime change
    const innovRatio = avgInnovSq;

    // Recent realized volatility
    const recentReturns = this.returns.slice(-this.innovWindow);
    const realizedVol = Math.sqrt(
      recentReturns.reduce((s, r) => s + r * r, 0) / recentReturns.length
    );

    // Regime classification
    let regime = "normal";
    let confidence = 0;

    if (innovRatio > 3.0) {
      regime = "crisis";
      confidence = Math.min(1, (innovRatio - 2) / 5);
    } else if (innovRatio > 1.8) {
      regime = "transition";
      confidence = Math.min(1, (innovRatio - 1.2) / 2);
    } else if (realizedVol < expectedVol * 0.5) {
      regime = "low_vol";
      confidence = Math.min(1, 1 - realizedVol / (expectedVol || 0.01));
    } else {
      regime = "normal";
      confidence = Math.min(1, 1 - Math.abs(innovRatio - 1));
    }

    return {
      regime,
      confidence: +confidence.toFixed(3),
      expectedReturn: +expectedReturn.toFixed(6),
      realizedVol: +realizedVol.toFixed(6),
      expectedVol: +expectedVol.toFixed(6),
      innovRatio: +innovRatio.toFixed(3),
    };
  }
}

// ─── CLI Demo ────────────────────────────────────────────

function formatBar(value, maxWidth = 20) {
  const width = Math.round(Math.abs(value) * maxWidth);
  const bar = value >= 0 ? "+".repeat(width) : "-".repeat(width);
  return bar.padEnd(maxWidth);
}

async function main() {
  console.log("=== Kalman Filter Market Tracker ===\n");

  // --- Trend Tracking Demo ---
  console.log("--- Trend Tracking (SPY) ---\n");
  const spyPrices = generateRealisticPrices("SPY", "2023-01-01", "2024-06-01");
  const trendTracker = new KalmanTrendTracker({
    processNoise: 0.5,
    measurementNoise: 2.0,
    slopeNoise: 0.01,
  });

  const trendSnapshots = [];
  for (let i = 0; i < spyPrices.length; i++) {
    trendTracker.addPrice(spyPrices[i].close);
    if (i >= 20 && i % 20 === 0) {
      const trend = trendTracker.getTrend();
      const sig = trendTracker.getSignal();
      trendSnapshots.push({ i, date: spyPrices[i].date, price: spyPrices[i].close, ...trend, ...sig });
    }
  }

  console.log("Date        Price    Level    Slope      t-Stat  Dir    Signal  Conf");
  console.log("-".repeat(80));
  for (const s of trendSnapshots) {
    console.log(
      `${s.date}  ${String(s.price).padStart(7)}  ` +
      `${String(s.level).padStart(7)}  ${s.slope >= 0 ? "+" : ""}${s.slope.toFixed(4).padStart(7)}  ` +
      `${s.tStat >= 0 ? "+" : ""}${String(s.tStat).padStart(6)}  ${s.direction.padEnd(5)}  ` +
      `${s.signal.padEnd(6)}  ${s.confidence}`
    );
  }

  const finalTrend = trendTracker.getTrend();
  const finalSignal = trendTracker.getSignal();
  console.log(`\nFinal trend: ${finalTrend.direction} (slope=${finalTrend.slope}, t=${finalTrend.tStat})`);
  console.log(`Final signal: ${finalSignal.signal} (confidence=${finalSignal.confidence})\n`);

  // --- Pairs Trading Demo ---
  console.log("--- Pairs Trading (AAPL vs MSFT) ---\n");
  const aaplPrices = generateRealisticPrices("AAPL", "2023-01-01", "2024-06-01");
  const msftPrices = generateRealisticPrices("MSFT", "2023-01-01", "2024-06-01");
  const pairLen = Math.min(aaplPrices.length, msftPrices.length);

  const pairTracker = new KalmanPairTracker({
    delta: 0.0001,
    obsNoise: 5.0,
    windowSize: 40,
  });

  const pairSnapshots = [];
  for (let i = 0; i < pairLen; i++) {
    pairTracker.addPrices(aaplPrices[i].close, msftPrices[i].close);
    if (i >= 30 && i % 15 === 0) {
      const hedge = pairTracker.getHedgeRatio();
      const spread = pairTracker.getSpreadZScore();
      const sig = pairTracker.getSignal();
      pairSnapshots.push({ i, date: aaplPrices[i].date, ...hedge, ...spread, signal: sig.signal, conf: sig.confidence });
    }
  }

  console.log("Date        HedgeR    Spread   Z-Score  Signal          Conf");
  console.log("-".repeat(70));
  for (const s of pairSnapshots) {
    console.log(
      `${s.date}  ${s.beta.toFixed(4).padStart(7)}  ` +
      `${s.spread.toFixed(2).padStart(8)}  ${(s.zScore >= 0 ? "+" : "") + s.zScore.toFixed(2).padStart(6)}  ` +
      `${s.signal.padEnd(15)} ${s.conf}`
    );
  }

  const finalHedge = pairTracker.getHedgeRatio();
  const finalSpread = pairTracker.getSpreadZScore();
  const finalPairSignal = pairTracker.getSignal();
  console.log(`\nFinal hedge ratio: ${finalHedge.beta} (std=${finalHedge.betaStd})`);
  console.log(`Final spread z-score: ${finalSpread.zScore}`);
  console.log(`Final signal: ${finalPairSignal.signal} (confidence=${finalPairSignal.confidence})\n`);

  // --- Regime Detection Demo ---
  console.log("--- Regime Detection (QQQ) ---\n");
  const qqqPrices = generateRealisticPrices("QQQ", "2022-01-01", "2024-06-01");
  const regimeFilter = new KalmanRegimeFilter({
    processNoise: 0.00005,
    obsNoise: 0.0005,
    innovWindow: 25,
  });

  const regimeSnapshots = [];
  for (let i = 1; i < qqqPrices.length; i++) {
    const ret = Math.log(qqqPrices[i].close / qqqPrices[i - 1].close);
    regimeFilter.addReturn(ret);
    if (i >= 30 && i % 25 === 0) {
      const regime = regimeFilter.getRegime();
      regimeSnapshots.push({ i, date: qqqPrices[i].date, price: qqqPrices[i].close, ...regime });
    }
  }

  console.log("Date        Price    Regime       Conf   RealVol  ExpVol   InnovR");
  console.log("-".repeat(75));
  for (const s of regimeSnapshots) {
    console.log(
      `${s.date}  ${String(s.price).padStart(7)}  ${s.regime.padEnd(11)}  ` +
      `${s.confidence.toFixed(2).padStart(4)}   ${(s.realizedVol * 100).toFixed(2).padStart(5)}%  ` +
      `${(s.expectedVol * 100).toFixed(2).padStart(5)}%   ${s.innovRatio.toFixed(2)}`
    );
  }

  const finalRegime = regimeFilter.getRegime();
  console.log(`\nFinal regime: ${finalRegime.regime} (confidence=${finalRegime.confidence})`);
  console.log(`Innovation ratio: ${finalRegime.innovRatio} (>3 = crisis, <1 = stable)`);

  // --- Summary ---
  console.log("\n=== Summary ===");
  console.log(`Trend (SPY):   ${finalSignal.signal} (${finalTrend.direction}, conf=${finalSignal.confidence})`);
  console.log(`Pairs (AAPL/MSFT): ${finalPairSignal.signal} (z=${finalSpread.zScore}, hedge=${finalHedge.beta})`);
  console.log(`Regime (QQQ):  ${finalRegime.regime} (innov_ratio=${finalRegime.innovRatio})`);
}

// Run CLI if called directly
const isMain = process.argv[1] && (
  process.argv[1].includes("kalman-tracker") ||
  process.argv[1].endsWith("kalman-tracker.mjs")
);
if (isMain) {
  main().catch(err => {
    console.error("Kalman tracker failed:", err.message);
    process.exit(1);
  });
}
