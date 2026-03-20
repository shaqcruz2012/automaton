#!/usr/bin/env node
/**
 * DCC-GARCH Covariance Forecasting — Inferred Analysis
 *
 * Dynamic Conditional Correlation covariance forecasting for multi-asset
 * portfolio risk management. Implements:
 *
 *   1. Univariate GARCH(1,1) variance forecasting
 *   2. EWMA (RiskMetrics) covariance estimation
 *   3. Full DCC-GARCH model with multi-step forecasts
 *   4. Model comparison framework (sample, EWMA, GARCH, DCC)
 *
 * Usage:
 *   node agents/optimizer/covariance-forecast.mjs
 *   import { dccForecast, CovarianceForecaster } from './covariance-forecast.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Linear Algebra Helpers ─────────────────────────────

/** Convert covariance matrix to correlation matrix */
export function covarianceToCorrelation(covMatrix) {
  const n = covMatrix.length;
  const corr = Array.from({ length: n }, () => new Array(n).fill(0));
  const stdDevs = covMatrix.map((row, i) => Math.sqrt(Math.max(row[i], 1e-16)));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      corr[i][j] = covMatrix[i][j] / (stdDevs[i] * stdDevs[j]);
      // Clamp to [-1, 1] for numerical safety
      corr[i][j] = Math.max(-1, Math.min(1, corr[i][j]));
    }
  }
  return corr;
}

/** Cholesky decomposition: returns lower triangular L such that A = L * L' */
export function choleskyDecompose(matrix) {
  const n = matrix.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }
      if (i === j) {
        const diag = matrix[i][i] - sum;
        if (diag < 0) {
          throw new Error(`Matrix not positive definite at index ${i} (value: ${diag.toExponential(4)})`);
        }
        L[i][j] = Math.sqrt(diag);
      } else {
        L[i][j] = L[j][j] > 1e-16 ? (matrix[i][j] - sum) / L[j][j] : 0;
      }
    }
  }
  return L;
}

function matMul(A, B) {
  const rows = A.length, cols = B[0].length, inner = B.length;
  const C = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++)
      for (let k = 0; k < inner; k++)
        C[i][j] += A[i][k] * B[k][j];
  return C;
}

function matTranspose(A) {
  const rows = A.length, cols = A[0].length;
  return Array.from({ length: cols }, (_, j) =>
    Array.from({ length: rows }, (_, i) => A[i][j])
  );
}

function diagMatrix(vec) {
  const n = vec.length;
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) D[i][i] = vec[i];
  return D;
}

function identityMatrix(n) {
  return Array.from({ length: n }, (_, i) => {
    const row = new Array(n).fill(0);
    row[i] = 1;
    return row;
  });
}

// ─── GARCH(1,1) ─────────────────────────────────────────

/**
 * One-step GARCH(1,1) variance forecast.
 *   sigma2(t) = omega + alpha * r(t-1)^2 + beta * sigma2(t-1)
 *
 * Returns array of conditional variances for the full return series,
 * plus the one-step-ahead forecast as the final element.
 */
export function garch11(returns, omega, alpha, beta) {
  const T = returns.length;
  const sigma2 = new Array(T + 1);

  // Initialize with unconditional variance
  const uncondVar = omega / (1 - alpha - beta);
  sigma2[0] = uncondVar > 0 ? uncondVar : variance(returns);

  for (let t = 0; t < T; t++) {
    sigma2[t + 1] = omega + alpha * returns[t] * returns[t] + beta * sigma2[t];
    sigma2[t + 1] = Math.max(sigma2[t + 1], 1e-10); // floor
  }

  return sigma2;
}

/**
 * Fit GARCH(1,1) parameters via variance targeting + grid search.
 *
 * Variance targeting fixes omega = uncondVar * (1 - alpha - beta),
 * reducing the search space to 2 dimensions.
 */
export function fitGarch(returns) {
  const T = returns.length;
  const uncondVar = variance(returns);

  let bestAlpha = 0.05, bestBeta = 0.90, bestLL = -Infinity;

  // Grid search over (alpha, beta) with constraint alpha + beta < 1
  for (let a = 0.01; a <= 0.25; a += 0.01) {
    for (let b = 0.60; b <= 0.98 - a; b += 0.01) {
      const omega = uncondVar * (1 - a - b);
      if (omega <= 0) continue;

      const sigma2 = garch11(returns, omega, a, b);
      let ll = 0;
      for (let t = 0; t < T; t++) {
        const s2 = sigma2[t];
        // Gaussian log-likelihood (drop constant)
        ll += -0.5 * (Math.log(s2) + (returns[t] * returns[t]) / s2);
      }

      if (ll > bestLL) {
        bestLL = ll;
        bestAlpha = a;
        bestBeta = b;
      }
    }
  }

  const bestOmega = uncondVar * (1 - bestAlpha - bestBeta);
  const sigma2 = garch11(returns, bestOmega, bestAlpha, bestBeta);

  return {
    omega: bestOmega,
    alpha: bestAlpha,
    beta: bestBeta,
    persistence: bestAlpha + bestBeta,
    uncondVar,
    logLikelihood: bestLL,
    sigma2,
    forecastVar: sigma2[sigma2.length - 1],
  };
}

// ─── EWMA Covariance ────────────────────────────────────

/**
 * EWMA (RiskMetrics) covariance matrix estimator.
 * @param {number[][]} returnMatrix - T x N matrix of returns (rows = time, cols = assets)
 * @param {number} lambda - decay factor, default 0.94 (RiskMetrics daily)
 * @returns {number[][]} N x N covariance matrix
 */
export function ewmaCovariance(returnMatrix, lambda = 0.94) {
  const T = returnMatrix.length;
  const N = returnMatrix[0].length;

  // Initialize with sample covariance of first 20 observations (or all if fewer)
  const initPeriod = Math.min(20, T);
  let cov = sampleCovariance(returnMatrix.slice(0, initPeriod));

  // Recursive EWMA update
  for (let t = initPeriod; t < T; t++) {
    const r = returnMatrix[t];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        cov[i][j] = lambda * cov[i][j] + (1 - lambda) * r[i] * r[j];
      }
    }
  }

  return cov;
}

// ─── DCC-GARCH Forecast ─────────────────────────────────

/**
 * Full DCC-GARCH covariance forecast.
 *
 * Steps:
 *   1. Fit univariate GARCH(1,1) to each asset
 *   2. Standardize residuals: z_t = r_t / sigma_t
 *   3. Estimate DCC parameters (a, b) via targeting
 *   4. Compute dynamic conditional correlations
 *   5. Forecast multi-step covariance: H_t = D_t * R_t * D_t
 *
 * @param {number[][]} returnMatrix - T x N matrix of returns
 * @param {object} options
 * @param {number} options.horizon - forecast horizon (default 1)
 * @param {number} options.dccA - DCC alpha (default: estimated)
 * @param {number} options.dccB - DCC beta (default: estimated)
 * @returns {object} { covMatrix, corrMatrix, garchFits, dccParams }
 */
export function dccForecast(returnMatrix, options = {}) {
  const { horizon = 1 } = options;
  const T = returnMatrix.length;
  const N = returnMatrix[0].length;

  // ── Step 1: Fit univariate GARCH to each asset ──
  const garchFits = [];
  const sigma2Matrix = []; // T x N conditional variances

  for (let j = 0; j < N; j++) {
    const assetReturns = returnMatrix.map(row => row[j]);
    const fit = fitGarch(assetReturns);
    garchFits.push(fit);
    sigma2Matrix.push(fit.sigma2);
  }

  // ── Step 2: Standardize residuals ──
  const zMatrix = Array.from({ length: T }, (_, t) => {
    return Array.from({ length: N }, (_, j) => {
      const sigma = Math.sqrt(Math.max(sigma2Matrix[j][t], 1e-16));
      return returnMatrix[t][j] / sigma;
    });
  });

  // ── Step 3: Estimate DCC parameters ──
  // Unconditional correlation of standardized residuals
  const Qbar = sampleCovariance(zMatrix);

  // Estimate DCC params (a, b) via grid search on pseudo-likelihood
  let dccA = options.dccA ?? null;
  let dccB = options.dccB ?? null;

  if (dccA === null || dccB === null) {
    const dccParams = fitDccParams(zMatrix, Qbar);
    dccA = dccParams.a;
    dccB = dccParams.b;
  }

  // ── Step 4: DCC recursion ──
  // Q_t = (1 - a - b) * Qbar + a * z_{t-1} * z_{t-1}' + b * Q_{t-1}
  let Qt = Qbar.map(row => [...row]);
  let Rt = covarianceToCorrelation(Qt);

  for (let t = 1; t < T; t++) {
    const z = zMatrix[t - 1];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        Qt[i][j] = (1 - dccA - dccB) * Qbar[i][j]
          + dccA * z[i] * z[j]
          + dccB * Qt[i][j];
      }
    }
    Rt = covarianceToCorrelation(Qt);
  }

  // ── Step 5: Multi-step forecast ──
  // For h-step ahead, GARCH variance converges toward unconditional
  const forecastVars = garchFits.map(fit => {
    let h_var = fit.forecastVar;
    for (let h = 1; h < horizon; h++) {
      h_var = fit.omega + (fit.alpha + fit.beta) * h_var;
    }
    return h_var;
  });

  // DCC correlation forecast: mean-reverts toward Qbar
  let QtForecast = Qt.map(row => [...row]);
  for (let h = 0; h < horizon; h++) {
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        QtForecast[i][j] = (1 - dccA - dccB) * Qbar[i][j]
          + (dccA + dccB) * QtForecast[i][j];
      }
    }
  }
  const RtForecast = covarianceToCorrelation(QtForecast);

  // Reconstruct covariance: H = D * R * D
  const Ddiag = forecastVars.map(v => Math.sqrt(Math.max(v, 1e-16)));
  const D = diagMatrix(Ddiag);
  const covMatrix = matMul(matMul(D, RtForecast), D);

  return {
    covMatrix,
    corrMatrix: RtForecast,
    garchFits,
    dccParams: { a: dccA, b: dccB },
    forecastVars,
    horizon,
  };
}

/** Estimate DCC (a, b) by grid search over pseudo-likelihood */
function fitDccParams(zMatrix, Qbar) {
  const T = zMatrix.length;
  const N = zMatrix[0].length;

  let bestA = 0.01, bestB = 0.95, bestLL = -Infinity;

  for (let a = 0.005; a <= 0.10; a += 0.005) {
    for (let b = 0.80; b <= 0.995 - a; b += 0.005) {
      let Qt = Qbar.map(row => [...row]);
      let ll = 0;

      for (let t = 1; t < T; t++) {
        const z = zMatrix[t - 1];
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            Qt[i][j] = (1 - a - b) * Qbar[i][j] + a * z[i] * z[j] + b * Qt[i][j];
          }
        }

        const Rt = covarianceToCorrelation(Qt);

        // Pseudo log-likelihood: -0.5 * (log|R_t| + z_t' R_t^{-1} z_t - z_t' z_t)
        // Simplified: just use log-determinant penalty
        let logDet = 0;
        try {
          const L = choleskyDecompose(Rt);
          for (let i = 0; i < N; i++) logDet += 2 * Math.log(Math.max(L[i][i], 1e-16));
        } catch {
          logDet = Infinity;
        }

        if (!isFinite(logDet)) { ll = -Infinity; break; }

        // Quadratic form z' R^{-1} z (approximate with z' z / det for speed)
        let zz = 0;
        for (let i = 0; i < N; i++) zz += zMatrix[t][i] * zMatrix[t][i];
        ll += -0.5 * (logDet + zz);
      }

      if (ll > bestLL) {
        bestLL = ll;
        bestA = a;
        bestB = b;
      }
    }
  }

  return { a: bestA, b: bestB, logLikelihood: bestLL };
}

// ─── CovarianceForecaster Class ─────────────────────────

export class CovarianceForecaster {
  /**
   * @param {string[]} assetNames - labels for each asset column
   * @param {object} options
   * @param {number} options.ewmaLambda - EWMA decay (default 0.94)
   * @param {number} options.minObs - minimum observations before forecasting (default 60)
   */
  constructor(assetNames, options = {}) {
    this.assetNames = assetNames;
    this.N = assetNames.length;
    this.ewmaLambda = options.ewmaLambda ?? 0.94;
    this.minObs = options.minObs ?? 60;
    this.dates = [];
    this.returns = []; // T x N
  }

  /** Add a new return observation */
  addReturns(date, returns) {
    if (returns.length !== this.N) {
      throw new Error(`Expected ${this.N} returns, got ${returns.length}`);
    }
    this.dates.push(date);
    this.returns.push([...returns]);
  }

  /** Forecast covariance matrix h steps ahead using DCC-GARCH */
  forecast(horizon = 1) {
    this._checkMinObs();
    return dccForecast(this.returns, { horizon });
  }

  /** Forecast correlation matrix */
  getCorrelationForecast(horizon = 1) {
    const result = this.forecast(horizon);
    return {
      corrMatrix: result.corrMatrix,
      assetNames: this.assetNames,
      horizon,
    };
  }

  /** Compare EWMA vs GARCH vs DCC vs sample covariance */
  compareModels() {
    this._checkMinObs();

    const T = this.returns.length;
    const splitIdx = Math.floor(T * 0.7);
    const trainReturns = this.returns.slice(0, splitIdx);
    const testReturns = this.returns.slice(splitIdx);

    // 1. Sample covariance (in-sample)
    const sampleCov = sampleCovariance(trainReturns);

    // 2. EWMA
    const ewmaCov = ewmaCovariance(trainReturns, this.ewmaLambda);

    // 3. GARCH diagonal (no correlation dynamics)
    const garchDiagResult = dccForecast(trainReturns, { horizon: 1, dccA: 0, dccB: 0 });

    // 4. Full DCC
    const dccResult = dccForecast(trainReturns, { horizon: 1 });

    // Evaluate each on out-of-sample data using Frobenius error
    const realizedCov = sampleCovariance(testReturns);
    const models = [
      { name: "Sample", cov: sampleCov },
      { name: "EWMA", cov: ewmaCov },
      { name: "GARCH-diag", cov: garchDiagResult.covMatrix },
      { name: "DCC-GARCH", cov: dccResult.covMatrix },
    ];

    const results = models.map(m => {
      const frob = frobeniusNorm(m.cov, realizedCov);
      const logDet = safeLogDet(m.cov);
      return { name: m.name, frobeniusError: frob, logDet, cov: m.cov };
    });

    results.sort((a, b) => a.frobeniusError - b.frobeniusError);
    return {
      results,
      trainSize: splitIdx,
      testSize: testReturns.length,
      bestModel: results[0].name,
    };
  }

  /** Generate ASCII report */
  formatReport(horizon = 5) {
    const lines = [];
    const sep = "=".repeat(72);
    const sep2 = "-".repeat(72);

    lines.push(sep);
    lines.push("  COVARIANCE FORECAST REPORT");
    lines.push(`  Assets: ${this.assetNames.join(", ")}`);
    lines.push(`  Observations: ${this.returns.length}  |  Horizon: ${horizon} days`);
    lines.push(sep);

    // GARCH parameters
    const result = this.forecast(horizon);
    lines.push("");
    lines.push("  GARCH(1,1) Parameter Estimates");
    lines.push(sep2);
    lines.push("  Asset       omega      alpha     beta    persist   uncondVol");
    lines.push(sep2);

    for (let j = 0; j < this.N; j++) {
      const fit = result.garchFits[j];
      const name = this.assetNames[j].padEnd(10);
      const omega = fit.omega.toExponential(2).padStart(10);
      const alpha = fit.alpha.toFixed(3).padStart(9);
      const beta = fit.beta.toFixed(3).padStart(9);
      const pers = fit.persistence.toFixed(3).padStart(9);
      const uvol = (Math.sqrt(fit.uncondVar) * Math.sqrt(252) * 100).toFixed(1).padStart(10);
      lines.push(`  ${name}${omega}${alpha}${beta}${pers}${uvol}%`);
    }

    // DCC params
    lines.push("");
    lines.push(`  DCC Parameters:  a = ${result.dccParams.a.toFixed(4)}   b = ${result.dccParams.b.toFixed(4)}`);
    lines.push(`  Persistence: ${(result.dccParams.a + result.dccParams.b).toFixed(4)}`);

    // Forecast correlation matrix
    lines.push("");
    lines.push(`  Forecast Correlation Matrix (${horizon}-day horizon)`);
    lines.push(sep2);

    // Header
    const hdr = "           " + this.assetNames.map(n => n.padStart(8)).join("");
    lines.push(hdr);
    lines.push(sep2);

    for (let i = 0; i < this.N; i++) {
      let row = `  ${this.assetNames[i].padEnd(9)}`;
      for (let j = 0; j < this.N; j++) {
        row += result.corrMatrix[i][j].toFixed(4).padStart(8);
      }
      lines.push(row);
    }

    // Forecast annualized volatilities
    lines.push("");
    lines.push("  Forecast Annualized Volatility");
    lines.push(sep2);
    for (let j = 0; j < this.N; j++) {
      const annVol = Math.sqrt(result.forecastVars[j]) * Math.sqrt(252) * 100;
      const bar = "#".repeat(Math.round(annVol));
      lines.push(`  ${this.assetNames[j].padEnd(10)} ${annVol.toFixed(1).padStart(6)}%  ${bar}`);
    }

    // Model comparison
    try {
      const comparison = this.compareModels();
      lines.push("");
      lines.push("  Model Comparison (out-of-sample Frobenius error)");
      lines.push(sep2);
      lines.push("  Rank  Model          Frobenius    logDet");
      lines.push(sep2);

      comparison.results.forEach((r, idx) => {
        const rank = `${idx + 1}.`.padStart(5);
        const name = r.name.padEnd(15);
        const frob = r.frobeniusError.toExponential(3).padStart(12);
        const ld = r.logDet.toFixed(2).padStart(10);
        const marker = idx === 0 ? " <-- best" : "";
        lines.push(`  ${rank} ${name}${frob}${ld}${marker}`);
      });

      lines.push(`  Train: ${comparison.trainSize} obs  |  Test: ${comparison.testSize} obs`);
    } catch (e) {
      lines.push(`  [Model comparison skipped: ${e.message}]`);
    }

    // Cholesky check
    lines.push("");
    try {
      choleskyDecompose(result.covMatrix);
      lines.push("  Positive definite: YES");
    } catch {
      lines.push("  Positive definite: NO (warning: covariance matrix may be ill-conditioned)");
    }

    lines.push(sep);
    return lines.join("\n");
  }

  _checkMinObs() {
    if (this.returns.length < this.minObs) {
      throw new Error(`Need at least ${this.minObs} observations, have ${this.returns.length}`);
    }
  }
}

// ─── Statistical Utilities ──────────────────────────────

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function variance(arr) {
  const mu = mean(arr);
  return arr.reduce((s, v) => s + (v - mu) * (v - mu), 0) / (arr.length - 1);
}

/** Sample covariance matrix from T x N return matrix */
function sampleCovariance(returnMatrix) {
  const T = returnMatrix.length;
  const N = returnMatrix[0].length;
  const means = Array.from({ length: N }, (_, j) => mean(returnMatrix.map(r => r[j])));

  const cov = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        const v = (returnMatrix[t][i] - means[i]) * (returnMatrix[t][j] - means[j]);
        cov[i][j] += v;
        if (i !== j) cov[j][i] += v;
      }
    }
  }

  const denom = T - 1;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      cov[i][j] /= denom;

  return cov;
}

/** Frobenius norm of difference between two matrices */
function frobeniusNorm(A, B) {
  let sum = 0;
  for (let i = 0; i < A.length; i++)
    for (let j = 0; j < A[0].length; j++)
      sum += (A[i][j] - B[i][j]) ** 2;
  return Math.sqrt(sum);
}

/** Safe log-determinant via Cholesky */
function safeLogDet(matrix) {
  try {
    const L = choleskyDecompose(matrix);
    let ld = 0;
    for (let i = 0; i < L.length; i++) ld += 2 * Math.log(Math.max(L[i][i], 1e-16));
    return ld;
  } catch {
    return -Infinity;
  }
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("DCC-GARCH Covariance Forecaster\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD", "XLE"];
  console.log(`Generating synthetic prices for: ${symbols.join(", ")}\n`);

  // Generate price data
  const priceData = {};
  for (const sym of symbols) {
    priceData[sym] = generateRealisticPrices(sym, "2021-01-01", "2025-12-31");
  }

  // Align dates: use only dates present in all assets
  const dateSets = symbols.map(s => new Set(priceData[s].map(p => p.date)));
  const commonDates = [...dateSets[0]].filter(d => dateSets.every(ds => ds.has(d))).sort();

  console.log(`Common trading days: ${commonDates.length}\n`);

  // Build price lookup and compute log returns
  const priceLookup = {};
  for (const sym of symbols) {
    priceLookup[sym] = {};
    for (const p of priceData[sym]) {
      priceLookup[sym][p.date] = p.close;
    }
  }

  const forecaster = new CovarianceForecaster(symbols);

  for (let t = 1; t < commonDates.length; t++) {
    const date = commonDates[t];
    const prevDate = commonDates[t - 1];
    const returns = symbols.map(sym => {
      const p0 = priceLookup[sym][prevDate];
      const p1 = priceLookup[sym][date];
      return Math.log(p1 / p0);
    });
    forecaster.addReturns(date, returns);
  }

  console.log(forecaster.formatReport(5));

  // Additional standalone function demos
  console.log("\n\n--- Standalone Function Demos ---\n");

  // EWMA covariance
  const ewmaCov = ewmaCovariance(forecaster.returns, 0.94);
  console.log("EWMA Covariance (diagonal, annualized vol %):");
  for (let i = 0; i < symbols.length; i++) {
    const vol = Math.sqrt(ewmaCov[i][i]) * Math.sqrt(252) * 100;
    console.log(`  ${symbols[i].padEnd(6)} ${vol.toFixed(1)}%`);
  }

  // Cholesky decomposition
  console.log("\nCholesky decomposition of forecast covariance:");
  const result = forecaster.forecast(1);
  try {
    const L = choleskyDecompose(result.covMatrix);
    console.log("  Lower triangular L (first 3x3 block):");
    for (let i = 0; i < Math.min(3, L.length); i++) {
      const row = L[i].slice(0, 3).map(v => v.toExponential(3).padStart(12)).join("");
      console.log(`    ${row}`);
    }
    console.log("  (Use for correlated random draws: x = L * z, where z ~ N(0,I))");
  } catch (e) {
    console.log(`  Failed: ${e.message}`);
  }

  // Correlation forecast
  console.log("\nCorrelation forecast (1-day):");
  const corrResult = forecaster.getCorrelationForecast(1);
  const hdr = "         " + symbols.map(s => s.padStart(7)).join("");
  console.log(hdr);
  for (let i = 0; i < symbols.length; i++) {
    let row = `  ${symbols[i].padEnd(6)} `;
    for (let j = 0; j < symbols.length; j++) {
      row += corrResult.corrMatrix[i][j].toFixed(3).padStart(7);
    }
    console.log(row);
  }

  console.log("\nDone.");
}

if (process.argv[1]?.includes("covariance-forecast.mjs")) {
  main().catch(err => {
    console.error("Error:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
