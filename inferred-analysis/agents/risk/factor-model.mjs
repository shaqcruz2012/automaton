#!/usr/bin/env node
/**
 * Multi-Factor Risk Model (Fama-French Style)
 *
 * Implements a six-factor model for portfolio risk decomposition:
 *   1. Market (MKT)  — beta exposure to the broad market
 *   2. Size (SMB)    — small minus big market-cap proxy
 *   3. Value (HML)   — high minus low book-to-market proxy
 *   4. Momentum (WML) — winners minus losers (12-1 month momentum)
 *   5. Volatility (VMR) — low-vol minus high-vol
 *   6. Quality (QMJ)  — high quality minus low quality
 *
 * Features:
 *   - Factor return computation from price data
 *   - Factor exposure (loading) estimation via OLS regression
 *   - Factor-neutral portfolio construction
 *   - Residual (idiosyncratic) risk computation
 *   - Factor covariance matrix estimation
 *
 * Usage:
 *   node agents/risk/factor-model.mjs
 *   node agents/risk/factor-model.mjs --assets SPY,QQQ,AAPL,MSFT,TSLA,XLF,XLE,GLD
 *
 * Module API:
 *   import { FactorModel, computeFactorReturns, getFactorExposures, factorNeutralWeights } from './factor-model.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Utilities ───────────────────────────────────────────

/** Compute simple returns from a price series (close-to-close). */
function priceReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
  }
  return returns;
}

/** Mean of an array. */
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Standard deviation (population). */
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/** Annualize daily volatility. */
function annualizeVol(dailyVol) {
  return dailyVol * Math.sqrt(252);
}

/** Dot product of two arrays. */
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Ordinary Least Squares regression: y = X * beta + epsilon.
 *  X is a 2D array [nObs][nFactors], y is [nObs].
 *  Returns { betas: number[], residuals: number[], rSquared: number }.
 */
function olsRegression(X, y) {
  const n = y.length;
  const k = X[0].length;

  // X'X
  const XtX = Array.from({ length: k }, () => new Float64Array(k));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += X[t][i] * X[t][j];
      XtX[i][j] = s;
      XtX[j][i] = s;
    }
  }

  // X'y
  const Xty = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    let s = 0;
    for (let t = 0; t < n; t++) s += X[t][i] * y[t];
    Xty[i] = s;
  }

  // Solve via Cholesky decomposition
  const betas = choleskySolve(XtX, Xty, k);

  // Compute residuals
  const residuals = new Float64Array(n);
  let ssRes = 0;
  for (let t = 0; t < n; t++) {
    let predicted = 0;
    for (let j = 0; j < k; j++) predicted += X[t][j] * betas[j];
    residuals[t] = y[t] - predicted;
    ssRes += residuals[t] ** 2;
  }

  const yMean = mean(Array.from(y));
  let ssTot = 0;
  for (let t = 0; t < n; t++) ssTot += (y[t] - yMean) ** 2;

  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { betas: Array.from(betas), residuals: Array.from(residuals), rSquared };
}

/** Cholesky decomposition solver for Ax = b (A must be positive-definite). */
function choleskySolve(A, b, n) {
  // L * L' = A
  const L = Array.from({ length: n }, () => new Float64Array(n));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < j; k++) s += L[i][k] * L[j][k];

      if (i === j) {
        const diag = A[i][i] - s;
        L[i][j] = Math.sqrt(Math.max(diag, 1e-12)); // Regularize
      } else {
        L[i][j] = (A[i][j] - s) / L[j][j];
      }
    }
  }

  // Forward substitution: L * z = b
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < i; j++) s += L[i][j] * z[j];
    z[i] = (b[i] - s) / L[i][i];
  }

  // Back substitution: L' * x = z
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = 0;
    for (let j = i + 1; j < n; j++) s += L[j][i] * x[j];
    x[i] = (z[i] - s) / L[i][i];
  }

  return x;
}

// ─── Factor Return Computation ───────────────────────────

/**
 * Compute factor returns from a universe of asset price data.
 *
 * Constructs long/short factor portfolios by sorting assets on
 * characteristics and computing spread returns each period.
 *
 * @param {Object<string, Array>} assetPrices - Map of symbol -> price array [{date, close, volume, ...}]
 * @param {Object} opts
 * @param {number} opts.lookbackMomentum - Momentum lookback in days (default 252)
 * @param {number} opts.lookbackVol - Volatility lookback in days (default 60)
 * @param {number} opts.skipMomentum - Momentum skip period in days (default 21)
 * @returns {{ dates: string[], factors: Object<string, number[]>, assetReturns: Object<string, number[]> }}
 */
export function computeFactorReturns(assetPrices, opts = {}) {
  const lookbackMom = opts.lookbackMomentum || 252;
  const lookbackVol = opts.lookbackVol || 60;
  const skipMom = opts.skipMomentum || 21;
  const warmup = Math.max(lookbackMom + skipMom, lookbackVol) + 1;

  const symbols = Object.keys(assetPrices);
  if (symbols.length < 4) {
    throw new Error(`Need at least 4 assets for factor construction, got ${symbols.length}`);
  }

  // Align dates: find common trading dates
  const dateSets = symbols.map(s => new Set(assetPrices[s].map(p => p.date)));
  const allDates = assetPrices[symbols[0]].map(p => p.date)
    .filter(d => dateSets.every(ds => ds.has(d)));

  if (allDates.length < warmup + 10) {
    throw new Error(`Insufficient common dates: got ${allDates.length}, need ${warmup + 10}`);
  }

  // Build aligned close-price matrix and return matrix
  const priceMatrix = {};  // symbol -> aligned close prices
  const volumeMatrix = {}; // symbol -> aligned volumes
  for (const sym of symbols) {
    const dateMap = new Map(assetPrices[sym].map(p => [p.date, p]));
    priceMatrix[sym] = allDates.map(d => dateMap.get(d).close);
    volumeMatrix[sym] = allDates.map(d => dateMap.get(d).volume);
  }

  // Compute daily returns per asset
  const assetReturns = {};
  for (const sym of symbols) {
    assetReturns[sym] = [];
    for (let i = 1; i < allDates.length; i++) {
      assetReturns[sym].push((priceMatrix[sym][i] - priceMatrix[sym][i - 1]) / priceMatrix[sym][i - 1]);
    }
  }

  // Factor return arrays
  const factorNames = ["MKT", "SMB", "HML", "WML", "VMR", "QMJ"];
  const factors = {};
  for (const f of factorNames) factors[f] = [];
  const outputDates = [];

  // Compute factor returns for each day after warmup
  for (let t = warmup; t < allDates.length; t++) {
    const retIdx = t - 1; // index into asset returns
    if (retIdx < 0) continue;

    // Market factor: equal-weight average return of all assets
    let mktReturn = 0;
    for (const sym of symbols) mktReturn += assetReturns[sym][retIdx];
    mktReturn /= symbols.length;

    // Characteristics for sorting
    const chars = symbols.map(sym => {
      // Size proxy: average dollar volume over lookback (higher = larger)
      let avgDollarVol = 0;
      for (let d = t - lookbackVol; d < t; d++) {
        avgDollarVol += priceMatrix[sym][d] * volumeMatrix[sym][d];
      }
      avgDollarVol /= lookbackVol;

      // Value proxy: price-to-moving-average ratio (lower = cheaper = value)
      let maSum = 0;
      for (let d = t - lookbackMom; d < t; d++) maSum += priceMatrix[sym][d];
      const ma = maSum / lookbackMom;
      const priceToMA = priceMatrix[sym][t] / ma;

      // Momentum: return over lookback, skipping most recent month
      const momStart = t - lookbackMom;
      const momEnd = t - skipMom;
      const momentum = momEnd > momStart
        ? (priceMatrix[sym][momEnd] - priceMatrix[sym][momStart]) / priceMatrix[sym][momStart]
        : 0;

      // Volatility: realized vol over lookback
      const retSlice = assetReturns[sym].slice(Math.max(0, retIdx - lookbackVol), retIdx);
      const vol = stdev(retSlice);

      // Quality proxy: Sharpe-like ratio (mean return / vol over lookback)
      const meanRet = mean(retSlice);
      const quality = vol > 0 ? meanRet / vol : 0;

      return { sym, avgDollarVol, priceToMA, momentum, vol, quality };
    });

    // Sort and split into terciles for each factor
    const n = chars.length;
    const topN = Math.max(1, Math.floor(n / 3));
    const botN = Math.max(1, Math.floor(n / 3));

    // SMB: short big, long small (by dollar volume)
    const bySize = [...chars].sort((a, b) => a.avgDollarVol - b.avgDollarVol);
    const smallGroup = bySize.slice(0, topN).map(c => c.sym);
    const bigGroup = bySize.slice(-botN).map(c => c.sym);
    const smb = groupReturn(smallGroup, assetReturns, retIdx) - groupReturn(bigGroup, assetReturns, retIdx);

    // HML: long value (low price-to-MA), short growth (high price-to-MA)
    const byValue = [...chars].sort((a, b) => a.priceToMA - b.priceToMA);
    const valueGroup = byValue.slice(0, topN).map(c => c.sym);
    const growthGroup = byValue.slice(-botN).map(c => c.sym);
    const hml = groupReturn(valueGroup, assetReturns, retIdx) - groupReturn(growthGroup, assetReturns, retIdx);

    // WML: long winners, short losers (by momentum)
    const byMom = [...chars].sort((a, b) => b.momentum - a.momentum);
    const winnerGroup = byMom.slice(0, topN).map(c => c.sym);
    const loserGroup = byMom.slice(-botN).map(c => c.sym);
    const wml = groupReturn(winnerGroup, assetReturns, retIdx) - groupReturn(loserGroup, assetReturns, retIdx);

    // VMR: long low-vol, short high-vol
    const byVol = [...chars].sort((a, b) => a.vol - b.vol);
    const lowVolGroup = byVol.slice(0, topN).map(c => c.sym);
    const highVolGroup = byVol.slice(-botN).map(c => c.sym);
    const vmr = groupReturn(lowVolGroup, assetReturns, retIdx) - groupReturn(highVolGroup, assetReturns, retIdx);

    // QMJ: long high quality, short low quality
    const byQuality = [...chars].sort((a, b) => b.quality - a.quality);
    const hiQGroup = byQuality.slice(0, topN).map(c => c.sym);
    const loQGroup = byQuality.slice(-botN).map(c => c.sym);
    const qmj = groupReturn(hiQGroup, assetReturns, retIdx) - groupReturn(loQGroup, assetReturns, retIdx);

    factors.MKT.push(mktReturn);
    factors.SMB.push(smb);
    factors.HML.push(hml);
    factors.WML.push(wml);
    factors.VMR.push(vmr);
    factors.QMJ.push(qmj);
    outputDates.push(allDates[t]);
  }

  // Trim asset returns to match factor dates
  const trimmedReturns = {};
  const startIdx = warmup - 1; // return index corresponding to first factor date
  for (const sym of symbols) {
    trimmedReturns[sym] = assetReturns[sym].slice(startIdx, startIdx + outputDates.length);
  }

  return { dates: outputDates, factors, assetReturns: trimmedReturns };
}

/** Equal-weight average return of a group of assets at time t. */
function groupReturn(syms, assetReturns, t) {
  if (syms.length === 0) return 0;
  let s = 0;
  for (const sym of syms) s += assetReturns[sym][t];
  return s / syms.length;
}

// ─── Factor Exposure Estimation ──────────────────────────

/**
 * Estimate factor exposures (loadings) for each asset via OLS regression.
 *
 * Regresses each asset's return series on the factor return series:
 *   r_i(t) = alpha_i + beta_MKT * MKT(t) + beta_SMB * SMB(t) + ... + epsilon_i(t)
 *
 * @param {Object} factorData - Output of computeFactorReturns()
 * @returns {Object<string, { alpha: number, betas: Object<string, number>, rSquared: number, residualVol: number }>}
 */
export function getFactorExposures(factorData) {
  const { factors, assetReturns } = factorData;
  const factorNames = Object.keys(factors);
  const nObs = factors[factorNames[0]].length;
  const nFactors = factorNames.length;

  // Build design matrix X = [1, MKT, SMB, HML, WML, VMR, QMJ]
  const X = [];
  for (let t = 0; t < nObs; t++) {
    const row = [1]; // intercept
    for (const f of factorNames) row.push(factors[f][t]);
    X.push(row);
  }

  const exposures = {};
  const symbols = Object.keys(assetReturns);

  for (const sym of symbols) {
    const y = assetReturns[sym];
    if (y.length !== nObs) continue;

    const { betas, residuals, rSquared } = olsRegression(X, y);

    const betaMap = {};
    for (let i = 0; i < factorNames.length; i++) {
      betaMap[factorNames[i]] = betas[i + 1]; // skip intercept
    }

    const residualVol = annualizeVol(stdev(residuals));

    exposures[sym] = {
      alpha: betas[0] * 252, // annualized alpha
      betas: betaMap,
      rSquared,
      residualVol,
    };
  }

  return exposures;
}

// ─── Factor Covariance Matrix ────────────────────────────

/**
 * Compute the factor covariance matrix (annualized).
 *
 * @param {Object<string, number[]>} factors - Factor return series
 * @returns {{ names: string[], matrix: number[][] }}
 */
export function factorCovarianceMatrix(factors) {
  const names = Object.keys(factors);
  const k = names.length;
  const n = factors[names[0]].length;
  const annualizationFactor = 252;

  // Compute means
  const means = names.map(f => mean(factors[f]));

  // Covariance matrix
  const matrix = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let cov = 0;
      for (let t = 0; t < n; t++) {
        cov += (factors[names[i]][t] - means[i]) * (factors[names[j]][t] - means[j]);
      }
      cov = (cov / n) * annualizationFactor;
      matrix[i][j] = cov;
      matrix[j][i] = cov;
    }
  }

  return { names, matrix };
}

// ─── Factor-Neutral Portfolio Construction ───────────────

/**
 * Compute factor-neutral portfolio weights.
 *
 * Adjusts an initial weight vector so that the portfolio has zero exposure
 * to all factors, while staying as close to the original weights as possible.
 *
 * Method: project out factor exposures from the weight vector.
 *   w_neutral = w - B * (B'B)^{-1} * B' * w
 * where B is the N x K matrix of factor loadings.
 *
 * The weights are then re-normalized to sum to 1 (long-only) or
 * to maintain the original gross exposure (long-short).
 *
 * @param {Object<string, { betas: Object<string, number> }>} exposures - Factor exposures per asset
 * @param {Object<string, number>} [initialWeights] - Starting weights (default: equal-weight)
 * @param {Object} [opts]
 * @param {boolean} opts.longOnly - Force long-only (default false)
 * @returns {Object<string, number>} Factor-neutral weights
 */
export function factorNeutralWeights(exposures, initialWeights = null, opts = {}) {
  const symbols = Object.keys(exposures);
  const n = symbols.length;
  const factorNames = Object.keys(exposures[symbols[0]].betas);
  const k = factorNames.length;

  // Initial weights: equal-weight if not specified
  let w = symbols.map(s => initialWeights ? (initialWeights[s] || 0) : 1 / n);

  // Build exposure matrix B (n x k)
  const B = symbols.map(s => factorNames.map(f => exposures[s].betas[f]));

  // B'w = factor exposure of current portfolio
  const Bw = new Array(k).fill(0);
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < n; i++) Bw[j] += B[i][j] * w[i];
  }

  // B'B (k x k)
  const BtB = Array.from({ length: k }, () => new Float64Array(k));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0;
      for (let a = 0; a < n; a++) s += B[a][i] * B[a][j];
      BtB[i][j] = s;
      BtB[j][i] = s;
    }
  }

  // Solve (B'B) * x = B'w
  const adjustment = choleskySolve(BtB, Float64Array.from(Bw), k);

  // w_neutral = w - B * adjustment
  const wNeutral = new Array(n);
  for (let i = 0; i < n; i++) {
    let adj = 0;
    for (let j = 0; j < k; j++) adj += B[i][j] * adjustment[j];
    wNeutral[i] = w[i] - adj;
  }

  // Long-only constraint: clamp negatives and re-normalize
  if (opts.longOnly) {
    for (let i = 0; i < n; i++) wNeutral[i] = Math.max(0, wNeutral[i]);
  }

  // Normalize to sum to 1
  const wSum = wNeutral.reduce((s, v) => s + v, 0);
  if (Math.abs(wSum) > 1e-10) {
    for (let i = 0; i < n; i++) wNeutral[i] /= wSum;
  }

  const result = {};
  for (let i = 0; i < n; i++) result[symbols[i]] = wNeutral[i];
  return result;
}

// ─── FactorModel Class ──────────────────────────────────

/**
 * Complete multi-factor risk model.
 *
 * Wraps factor computation, exposure estimation, covariance, and
 * portfolio construction into a single stateful object.
 */
export class FactorModel {
  /**
   * @param {Object<string, Array>} assetPrices - Map of symbol -> OHLCV array
   * @param {Object} opts - Options for factor computation
   */
  constructor(assetPrices, opts = {}) {
    this.symbols = Object.keys(assetPrices);
    this.opts = opts;
    this._assetPrices = assetPrices;
    this.factorData = null;
    this.exposures = null;
    this.covMatrix = null;
  }

  /** Compute all factor returns from the price data. */
  fit() {
    this.factorData = computeFactorReturns(this._assetPrices, this.opts);
    this.exposures = getFactorExposures(this.factorData);
    this.covMatrix = factorCovarianceMatrix(this.factorData.factors);
    return this;
  }

  /** Factor names. */
  get factorNames() {
    return this.factorData ? Object.keys(this.factorData.factors) : [];
  }

  /** Get factor exposures for a single asset. */
  getExposure(symbol) {
    if (!this.exposures) throw new Error("Call fit() first");
    return this.exposures[symbol] || null;
  }

  /** Get factor-neutral weights. */
  getNeutralWeights(initialWeights = null, opts = {}) {
    if (!this.exposures) throw new Error("Call fit() first");
    return factorNeutralWeights(this.exposures, initialWeights, opts);
  }

  /** Compute portfolio risk decomposition.
   *  Returns { totalVol, factorVol, specificVol, factorContributions }
   */
  portfolioRisk(weights) {
    if (!this.exposures || !this.covMatrix) throw new Error("Call fit() first");

    const syms = Object.keys(weights);
    const factorNames = this.covMatrix.names;
    const k = factorNames.length;

    // Portfolio factor exposures: weighted sum of asset betas
    const portBetas = new Array(k).fill(0);
    for (const sym of syms) {
      const w = weights[sym];
      const exp = this.exposures[sym];
      if (!exp) continue;
      for (let j = 0; j < k; j++) {
        portBetas[j] += w * exp.betas[factorNames[j]];
      }
    }

    // Factor variance: beta' * Cov * beta
    let factorVar = 0;
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        factorVar += portBetas[i] * this.covMatrix.matrix[i][j] * portBetas[j];
      }
    }

    // Specific (idiosyncratic) variance: sum of w_i^2 * sigma_eps_i^2
    let specificVar = 0;
    for (const sym of syms) {
      const w = weights[sym];
      const exp = this.exposures[sym];
      if (!exp) continue;
      specificVar += w ** 2 * exp.residualVol ** 2;
    }

    const totalVar = factorVar + specificVar;

    // Factor contributions to variance
    const factorContributions = {};
    for (let i = 0; i < k; i++) {
      let contrib = 0;
      for (let j = 0; j < k; j++) {
        contrib += portBetas[i] * this.covMatrix.matrix[i][j] * portBetas[j];
      }
      factorContributions[factorNames[i]] = contrib;
    }

    return {
      totalVol: Math.sqrt(totalVar),
      factorVol: Math.sqrt(Math.max(0, factorVar)),
      specificVol: Math.sqrt(Math.max(0, specificVar)),
      factorContributions,
      portBetas: Object.fromEntries(factorNames.map((f, i) => [f, portBetas[i]])),
    };
  }

  /** Summary statistics for all factors. */
  factorStats() {
    if (!this.factorData) throw new Error("Call fit() first");
    const stats = {};
    for (const [name, returns] of Object.entries(this.factorData.factors)) {
      const m = mean(returns);
      const v = stdev(returns);
      stats[name] = {
        annualizedReturn: m * 252,
        annualizedVol: v * Math.sqrt(252),
        sharpe: v > 0 ? (m * 252) / (v * Math.sqrt(252)) : 0,
        observations: returns.length,
      };
    }
    return stats;
  }
}

// ─── CLI Demo ────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let assetList = ["SPY", "QQQ", "AAPL", "MSFT", "TSLA", "XLF", "XLE", "GLD", "IWM", "XLK"];

  const assetArg = args.find(a => a.startsWith("--assets"));
  if (assetArg) {
    const idx = args.indexOf(assetArg);
    const val = assetArg.includes("=") ? assetArg.split("=")[1] : args[idx + 1];
    if (val) assetList = val.split(",").map(s => s.trim().toUpperCase());
  }

  console.log("=== Multi-Factor Risk Model ===\n");
  console.log(`Universe: ${assetList.join(", ")}\n`);

  // Generate synthetic price data
  console.log("--- Generating price data ---");
  const assetPrices = {};
  for (const sym of assetList) {
    assetPrices[sym] = generateRealisticPrices(sym, "2020-01-01", "2025-03-01");
  }

  // Build and fit model
  console.log("\n--- Fitting factor model ---");
  const model = new FactorModel(assetPrices);
  model.fit();

  // Factor statistics
  console.log("\n--- Factor Statistics (Annualized) ---");
  const fStats = model.factorStats();
  console.log(
    "Factor".padEnd(8) +
    "Return".padStart(10) +
    "Vol".padStart(10) +
    "Sharpe".padStart(10) +
    "Obs".padStart(8)
  );
  console.log("-".repeat(46));
  for (const [name, s] of Object.entries(fStats)) {
    console.log(
      name.padEnd(8) +
      (s.annualizedReturn * 100).toFixed(2).padStart(9) + "%" +
      (s.annualizedVol * 100).toFixed(2).padStart(9) + "%" +
      s.sharpe.toFixed(2).padStart(10) +
      String(s.observations).padStart(8)
    );
  }

  // Factor covariance matrix
  console.log("\n--- Factor Correlation Matrix ---");
  const { names: fNames, matrix: covMat } = model.covMatrix;
  // Convert covariance to correlation
  const vols = fNames.map((_, i) => Math.sqrt(covMat[i][i]));
  console.log("       " + fNames.map(f => f.padStart(8)).join(""));
  for (let i = 0; i < fNames.length; i++) {
    let row = fNames[i].padEnd(7);
    for (let j = 0; j < fNames.length; j++) {
      const corr = vols[i] > 0 && vols[j] > 0
        ? covMat[i][j] / (vols[i] * vols[j])
        : 0;
      row += corr.toFixed(3).padStart(8);
    }
    console.log(row);
  }

  // Asset factor exposures
  console.log("\n--- Asset Factor Exposures (Betas) ---");
  const expHeader = "Asset".padEnd(8) + "Alpha%".padStart(9) +
    fNames.map(f => f.padStart(8)).join("") +
    "R2".padStart(8) + "ResVol%".padStart(9);
  console.log(expHeader);
  console.log("-".repeat(expHeader.length));

  for (const sym of assetList) {
    const exp = model.getExposure(sym);
    if (!exp) continue;
    let row = sym.padEnd(8);
    row += (exp.alpha * 100).toFixed(2).padStart(9);
    for (const f of fNames) {
      row += exp.betas[f].toFixed(3).padStart(8);
    }
    row += exp.rSquared.toFixed(3).padStart(8);
    row += (exp.residualVol * 100).toFixed(1).padStart(9);
    console.log(row);
  }

  // Equal-weight portfolio risk
  console.log("\n--- Equal-Weight Portfolio Risk ---");
  const eqWeights = {};
  for (const sym of assetList) eqWeights[sym] = 1 / assetList.length;
  const eqRisk = model.portfolioRisk(eqWeights);

  console.log(`  Total Vol:    ${(eqRisk.totalVol * 100).toFixed(2)}%`);
  console.log(`  Factor Vol:   ${(eqRisk.factorVol * 100).toFixed(2)}%`);
  console.log(`  Specific Vol: ${(eqRisk.specificVol * 100).toFixed(2)}%`);
  console.log(`  Portfolio Betas:`);
  for (const [f, b] of Object.entries(eqRisk.portBetas)) {
    console.log(`    ${f.padEnd(6)} ${b.toFixed(4)}`);
  }

  // Factor-neutral portfolio
  console.log("\n--- Factor-Neutral Portfolio Weights ---");
  const neutralW = model.getNeutralWeights();
  console.log("  Asset".padEnd(10) + "EqWt%".padStart(10) + "NeutWt%".padStart(10) + "Diff%".padStart(10));
  console.log("  " + "-".repeat(38));
  for (const sym of assetList) {
    const eq = (eqWeights[sym] * 100).toFixed(2);
    const nw = (neutralW[sym] * 100).toFixed(2);
    const diff = ((neutralW[sym] - eqWeights[sym]) * 100).toFixed(2);
    console.log(`  ${sym.padEnd(8)} ${eq.padStart(10)} ${nw.padStart(10)} ${diff.padStart(10)}`);
  }

  // Neutral portfolio risk
  const neutralRisk = model.portfolioRisk(neutralW);
  console.log(`\n  Neutral Portfolio Risk:`);
  console.log(`    Total Vol:    ${(neutralRisk.totalVol * 100).toFixed(2)}%`);
  console.log(`    Factor Vol:   ${(neutralRisk.factorVol * 100).toFixed(2)}%`);
  console.log(`    Specific Vol: ${(neutralRisk.specificVol * 100).toFixed(2)}%`);
  console.log(`    Factor Betas (should be ~0):`);
  for (const [f, b] of Object.entries(neutralRisk.portBetas)) {
    console.log(`      ${f.padEnd(6)} ${b.toFixed(6)}`);
  }

  console.log("\nDone.");
}

if (process.argv[1]?.includes("factor-model.mjs")) {
  main().catch(err => {
    console.error("Factor model failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
