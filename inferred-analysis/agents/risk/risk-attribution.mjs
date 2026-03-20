#!/usr/bin/env node
/**
 * Risk Attribution & Decomposition Engine
 *
 * Decomposes portfolio risk into position-level contributions:
 *   - Component VaR: each position's contribution to total portfolio VaR
 *   - Marginal VaR: sensitivity of portfolio VaR to small position changes
 *   - Incremental VaR: impact of adding/removing a full position
 *   - Risk budgeting: actual vs target risk allocation with tracking error
 *   - Concentration risk: Herfindahl-Hirschman Index of risk contributions
 *   - Diversification ratio: sum of standalone risks / portfolio risk
 *
 * No external dependencies. Pure ESM module.
 *
 * Usage:
 *   node agents/risk/risk-attribution.mjs                   # Demo with 5-asset portfolio
 *   node agents/risk/risk-attribution.mjs --confidence 0.99 # 99% VaR
 *   node agents/risk/risk-attribution.mjs --json            # JSON output
 *   node agents/risk/risk-attribution.mjs --help
 *
 * Can also be imported:
 *   import { RiskAttributor, componentVaR, marginalVaR, diversificationRatio, riskBudgetReport } from './risk-attribution.mjs'
 */

// ─── Math Helpers ─────────────────────────────────────────

/**
 * Approximate inverse normal CDF (quantile function) via rational approximation.
 * Abramowitz & Stegun formula 26.2.23. Accurate to ~4.5e-4.
 * @param {number} p - Probability (0 < p < 1)
 * @returns {number} z such that P(Z <= z) = p for standard normal Z
 */
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Use symmetry for p > 0.5
  const sign = p < 0.5 ? -1 : 1;
  const q = p < 0.5 ? p : 1 - p;

  const t = Math.sqrt(-2 * Math.log(q));
  // Rational approximation coefficients
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;

  const z = t - (c0 + c1 * t + c2 * t * t) /
                (1 + d1 * t + d2 * t * t + d3 * t * t * t);

  return sign * z;
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function round6(x) {
  return Math.round(x * 1000000) / 1000000;
}

// ─── Matrix Operations ───────────────────────────────────

/**
 * Compute covariance matrix from return series.
 * @param {number[][]} returnSeries - Array of return arrays, one per asset
 * @returns {number[][]} n x n covariance matrix
 */
function computeCovarianceMatrix(returnSeries) {
  const n = returnSeries.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(0));

  // Align lengths to shortest series
  const minLen = Math.min(...returnSeries.map(s => s.length));
  if (minLen < 2) return matrix;

  const trimmed = returnSeries.map(s => s.slice(-minLen));
  const means = trimmed.map(s => mean(s));

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let cov = 0;
      for (let k = 0; k < minLen; k++) {
        cov += (trimmed[i][k] - means[i]) * (trimmed[j][k] - means[j]);
      }
      cov /= (minLen - 1);
      matrix[i][j] = cov;
      matrix[j][i] = cov;
    }
  }

  return matrix;
}

/**
 * Multiply covariance matrix by weight vector: Sigma * w
 * @param {number[][]} cov - n x n covariance matrix
 * @param {number[]} w - n-length weight vector
 * @returns {number[]} n-length result vector
 */
function matVecMul(cov, w) {
  const n = w.length;
  const result = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      result[i] += cov[i][j] * w[j];
    }
  }
  return result;
}

/**
 * Portfolio variance: w' * Sigma * w
 * @param {number[]} w - Weight vector
 * @param {number[][]} cov - Covariance matrix
 * @returns {number} Portfolio variance
 */
function portfolioVariance(w, cov) {
  const sigmaW = matVecMul(cov, w);
  let variance = 0;
  for (let i = 0; i < w.length; i++) {
    variance += w[i] * sigmaW[i];
  }
  return variance;
}

/**
 * Portfolio volatility (standard deviation).
 */
function portfolioVol(w, cov) {
  return Math.sqrt(Math.max(portfolioVariance(w, cov), 0));
}

// ─── Core VaR Functions ──────────────────────────────────

/**
 * Parametric VaR for a portfolio (variance-covariance method).
 * VaR = -z * sigma_p * portfolioValue
 *
 * @param {number[]} weights - Portfolio weights
 * @param {number[][]} covMatrix - Covariance matrix of returns
 * @param {number} confidence - Confidence level (e.g. 0.95, 0.99)
 * @param {number} portfolioValue - Total portfolio value in dollars
 * @param {number} horizon - Time horizon in days (default 1)
 * @returns {number} VaR in dollars (positive number = potential loss)
 */
function parametricVaR(weights, covMatrix, confidence, portfolioValue, horizon = 1) {
  const z = Math.abs(normInv(1 - confidence));
  const sigma = portfolioVol(weights, covMatrix);
  return z * sigma * Math.sqrt(horizon) * portfolioValue;
}

// ─── Exported Functions ──────────────────────────────────

/**
 * Component VaR: each position's contribution to total portfolio VaR.
 *
 * Component VaR_i = w_i * (Sigma * w)_i / sigma_p * VaR_p
 *
 * The components sum exactly to total VaR.
 *
 * @param {number[]} weights - Portfolio weights
 * @param {number[][]} covMatrix - Covariance matrix
 * @param {number} confidence - Confidence level (0.95 or 0.99)
 * @param {number} portfolioValue - Portfolio value in $
 * @param {number} horizon - Horizon in days
 * @returns {{ total: number, components: number[], pctContributions: number[] }}
 */
export function componentVaR(weights, covMatrix, confidence = 0.95, portfolioValue = 1000000, horizon = 1) {
  const n = weights.length;
  const sigma_p = portfolioVol(weights, covMatrix);
  const totalVaR = parametricVaR(weights, covMatrix, confidence, portfolioValue, horizon);

  if (sigma_p === 0) {
    return {
      total: 0,
      components: Array(n).fill(0),
      pctContributions: Array(n).fill(0),
    };
  }

  const sigmaW = matVecMul(covMatrix, weights);
  const components = [];
  const pctContributions = [];

  for (let i = 0; i < n; i++) {
    // Component VaR_i = w_i * (Sigma*w)_i / sigma_p^2 * totalVaR
    const comp = (weights[i] * sigmaW[i] / (sigma_p * sigma_p)) * totalVaR;
    components.push(comp);
    pctContributions.push(totalVaR > 0 ? comp / totalVaR : 0);
  }

  return {
    total: round4(totalVaR),
    components: components.map(round4),
    pctContributions: pctContributions.map(round6),
  };
}

/**
 * Marginal VaR: sensitivity of portfolio VaR to a small increase in position weight.
 *
 * Marginal VaR_i = z * (Sigma * w)_i / sigma_p * sqrt(horizon)
 *
 * Expressed as $ VaR change per $1 of additional position.
 *
 * @param {number[]} weights - Portfolio weights
 * @param {number[][]} covMatrix - Covariance matrix
 * @param {number} confidence - Confidence level
 * @param {number} horizon - Horizon in days
 * @returns {number[]} Marginal VaR per unit of weight for each position
 */
export function marginalVaR(weights, covMatrix, confidence = 0.95, horizon = 1) {
  const n = weights.length;
  const sigma_p = portfolioVol(weights, covMatrix);
  const z = Math.abs(normInv(1 - confidence));

  if (sigma_p === 0) return Array(n).fill(0);

  const sigmaW = matVecMul(covMatrix, weights);
  return sigmaW.map(sw => round6(z * sw / sigma_p * Math.sqrt(horizon)));
}

/**
 * Incremental VaR: change in portfolio VaR from adding a full new position.
 *
 * Computed by comparing VaR with and without each position.
 *
 * @param {number[]} weights - Current portfolio weights
 * @param {number[][]} covMatrix - Covariance matrix
 * @param {number} confidence - Confidence level
 * @param {number} portfolioValue - Portfolio value in $
 * @param {number} horizon - Horizon in days
 * @returns {number[]} Incremental VaR for each position (positive = risk-adding)
 */
export function incrementalVaR(weights, covMatrix, confidence = 0.95, portfolioValue = 1000000, horizon = 1) {
  const n = weights.length;
  const fullVaR = parametricVaR(weights, covMatrix, confidence, portfolioValue, horizon);
  const results = [];

  for (let i = 0; i < n; i++) {
    // Remove position i: set weight to 0, renormalize remaining
    const reducedWeights = [...weights];
    reducedWeights[i] = 0;
    const sumRemaining = reducedWeights.reduce((s, w) => s + w, 0);

    // Scale remaining weights to maintain same total exposure
    const normalized = sumRemaining > 0
      ? reducedWeights.map(w => w * (1 / sumRemaining) * weights.reduce((s, v) => s + v, 0))
      : reducedWeights;

    const reducedVaR = parametricVaR(normalized, covMatrix, confidence, portfolioValue, horizon);
    results.push(round4(fullVaR - reducedVaR));
  }

  return results;
}

/**
 * Risk budget report: compare actual risk allocation against targets.
 *
 * @param {number[]} weights - Portfolio weights
 * @param {number[][]} covMatrix - Covariance matrix
 * @param {number[]} targetRiskPcts - Target risk budget % per position (should sum to 1)
 * @param {string[]} names - Asset names
 * @param {number} confidence - Confidence level
 * @param {number} portfolioValue - Portfolio value in $
 * @returns {{ positions: Array, totalActiveRisk: number, trackingError: number }}
 */
export function riskBudgetReport(weights, covMatrix, targetRiskPcts, names, confidence = 0.95, portfolioValue = 1000000) {
  const cvar = componentVaR(weights, covMatrix, confidence, portfolioValue);
  const n = weights.length;

  const positions = [];
  let sumSqDeviation = 0;

  for (let i = 0; i < n; i++) {
    const actualPct = cvar.pctContributions[i];
    const targetPct = targetRiskPcts[i] || (1 / n);
    const deviation = actualPct - targetPct;

    sumSqDeviation += deviation * deviation;

    positions.push({
      name: names[i] || `Asset_${i}`,
      weight: round4(weights[i]),
      actualRiskPct: round6(actualPct),
      targetRiskPct: round6(targetPct),
      deviation: round6(deviation),
      componentVaR: cvar.components[i],
      status: Math.abs(deviation) < 0.02 ? "ON_TARGET" :
              deviation > 0 ? "OVER_BUDGET" : "UNDER_BUDGET",
    });
  }

  const trackingError = Math.sqrt(sumSqDeviation);
  const totalActiveRisk = positions.reduce((s, p) => s + Math.abs(p.deviation), 0);

  return {
    positions,
    totalVaR: cvar.total,
    totalActiveRisk: round6(totalActiveRisk),
    trackingError: round6(trackingError),
  };
}

/**
 * Concentration risk via Herfindahl-Hirschman Index of risk contributions.
 *
 * HHI ranges from 1/n (perfectly diversified) to 1.0 (fully concentrated).
 * Normalized HHI maps this to [0, 1] where 0 = perfect diversification.
 *
 * @param {number[]} weights - Portfolio weights
 * @param {number[][]} covMatrix - Covariance matrix
 * @param {number} confidence - Confidence level
 * @returns {{ hhi: number, normalizedHHI: number, effectiveN: number, riskShares: number[] }}
 */
export function concentrationRisk(weights, covMatrix, confidence = 0.95) {
  const cvar = componentVaR(weights, covMatrix, confidence);
  const n = weights.length;

  // Risk shares = percentage contribution of each position to total VaR
  const riskShares = cvar.pctContributions.map(p => Math.max(p, 0));

  // HHI = sum of squared risk shares
  const hhi = riskShares.reduce((s, p) => s + p * p, 0);

  // Normalized HHI: (HHI - 1/n) / (1 - 1/n)
  const minHHI = n > 1 ? 1 / n : 1;
  const normalizedHHI = n > 1
    ? Math.max((hhi - minHHI) / (1 - minHHI), 0)
    : 0;

  // Effective number of positions (inverse HHI)
  const effectiveN = hhi > 0 ? 1 / hhi : n;

  return {
    hhi: round6(hhi),
    normalizedHHI: round6(normalizedHHI),
    effectiveN: round4(effectiveN),
    riskShares: riskShares.map(round6),
  };
}

/**
 * Diversification ratio: sum of individual standalone risks / portfolio risk.
 *
 * DR > 1 means diversification is providing benefit.
 * DR = 1 means perfectly correlated (no diversification).
 *
 * @param {number[]} weights - Portfolio weights
 * @param {number[][]} covMatrix - Covariance matrix
 * @returns {{ ratio: number, portfolioVol: number, weightedSumVol: number, diversificationBenefit: number }}
 */
export function diversificationRatio(weights, covMatrix) {
  const n = weights.length;

  // Individual volatilities from diagonal of covariance matrix
  const individualVols = [];
  for (let i = 0; i < n; i++) {
    individualVols.push(Math.sqrt(Math.max(covMatrix[i][i], 0)));
  }

  // Weighted sum of individual volatilities
  const weightedSumVol = weights.reduce((s, w, i) => s + Math.abs(w) * individualVols[i], 0);

  // Portfolio volatility (accounting for correlations)
  const portVol = portfolioVol(weights, covMatrix);

  // Diversification ratio
  const ratio = portVol > 0 ? weightedSumVol / portVol : 1;

  // Diversification benefit: 1 - 1/DR (how much risk is "removed" by diversification)
  const benefit = ratio > 0 ? 1 - (1 / ratio) : 0;

  return {
    ratio: round4(ratio),
    portfolioVol: round6(portVol),
    weightedSumVol: round6(weightedSumVol),
    diversificationBenefit: round4(benefit),
    individualVols: individualVols.map(round6),
  };
}

// ─── RiskAttributor Class ────────────────────────────────

/**
 * Unified risk attribution engine.
 *
 * Wraps all decomposition methods into a stateful class that holds
 * portfolio configuration and provides convenient access to all metrics.
 */
export class RiskAttributor {
  /**
   * @param {Object} config
   * @param {string[]} config.names - Asset/position names
   * @param {number[]} config.weights - Portfolio weights (should sum to ~1)
   * @param {number[][]} config.returns - Return series per asset (array of arrays)
   * @param {number} [config.confidence=0.95] - VaR confidence level
   * @param {number} [config.portfolioValue=1000000] - Portfolio value in $
   * @param {number} [config.horizon=1] - VaR horizon in days
   * @param {number[]} [config.targetRiskBudget] - Target risk budget per position (sums to 1)
   */
  constructor(config) {
    this.names = config.names || [];
    this.weights = config.weights || [];
    this.returns = config.returns || [];
    this.confidence = config.confidence || 0.95;
    this.portfolioValue = config.portfolioValue || 1000000;
    this.horizon = config.horizon || 1;
    this.targetRiskBudget = config.targetRiskBudget ||
      this.names.map(() => 1 / Math.max(this.names.length, 1));

    // Pre-compute covariance matrix
    this._covMatrix = computeCovarianceMatrix(this.returns);
  }

  /** @returns {number[][]} Covariance matrix */
  get covarianceMatrix() {
    return this._covMatrix;
  }

  /** Component VaR decomposition */
  componentVaR() {
    const result = componentVaR(
      this.weights, this._covMatrix, this.confidence,
      this.portfolioValue, this.horizon
    );
    // Attach names for convenience
    return {
      ...result,
      named: this.names.map((name, i) => ({
        name,
        componentVaR: result.components[i],
        pctContribution: result.pctContributions[i],
      })),
    };
  }

  /** Marginal VaR for each position */
  marginalVaR() {
    const mvar = marginalVaR(
      this.weights, this._covMatrix, this.confidence, this.horizon
    );
    return this.names.map((name, i) => ({
      name,
      marginalVaR: mvar[i],
    }));
  }

  /** Incremental VaR for each position */
  incrementalVaR() {
    const ivar = incrementalVaR(
      this.weights, this._covMatrix, this.confidence,
      this.portfolioValue, this.horizon
    );
    return this.names.map((name, i) => ({
      name,
      incrementalVaR: ivar[i],
    }));
  }

  /** Risk budget report with deviation tracking */
  riskBudgetReport() {
    return riskBudgetReport(
      this.weights, this._covMatrix, this.targetRiskBudget,
      this.names, this.confidence, this.portfolioValue
    );
  }

  /** Concentration risk (HHI) */
  concentrationRisk() {
    return concentrationRisk(this.weights, this._covMatrix, this.confidence);
  }

  /** Diversification ratio */
  diversificationRatio() {
    return diversificationRatio(this.weights, this._covMatrix);
  }

  /** Full attribution report — all metrics combined */
  fullReport() {
    return {
      timestamp: new Date().toISOString(),
      portfolio: {
        names: this.names,
        weights: this.weights,
        value: this.portfolioValue,
        confidence: this.confidence,
        horizon: this.horizon,
      },
      componentVaR: this.componentVaR(),
      marginalVaR: this.marginalVaR(),
      incrementalVaR: this.incrementalVaR(),
      riskBudget: this.riskBudgetReport(),
      concentration: this.concentrationRisk(),
      diversification: this.diversificationRatio(),
    };
  }
}

// ─── Demo Data Generator ─────────────────────────────────

/**
 * Generate synthetic return series for demo purposes.
 * Uses a simple mean + vol * noise model with optional correlation.
 */
function generateDemoReturns(nAssets, nPeriods, seed = 42) {
  // Seedable pseudo-random (mulberry32)
  let state = seed;
  function rand() {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Box-Muller for normal samples
  function randn() {
    const u1 = rand();
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  }

  // Asset characteristics
  const assetConfigs = [
    { name: "US_Equity",     mu: 0.0004, vol: 0.015, beta: 1.0  },
    { name: "Intl_Equity",   mu: 0.0003, vol: 0.018, beta: 0.8  },
    { name: "Corp_Bonds",    mu: 0.0001, vol: 0.005, beta: -0.2 },
    { name: "Gold",          mu: 0.0002, vol: 0.012, beta: -0.1 },
    { name: "Crypto",        mu: 0.0008, vol: 0.040, beta: 0.3  },
  ];

  const configs = assetConfigs.slice(0, nAssets);
  const returns = configs.map(() => []);

  for (let t = 0; t < nPeriods; t++) {
    // Common market factor
    const marketFactor = randn() * 0.01;

    for (let i = 0; i < nAssets; i++) {
      const c = configs[i];
      const idio = randn() * c.vol;
      const r = c.mu + c.beta * marketFactor + idio;
      returns[i].push(r);
    }
  }

  return { returns, names: configs.map(c => c.name) };
}

// ─── CLI Output ──────────────────────────────────────────

function formatReport(report) {
  const lines = [];
  const { portfolio, componentVaR: cvar, marginalVaR: mvar, incrementalVaR: ivar,
          riskBudget, concentration, diversification } = report;

  lines.push("=".repeat(74));
  lines.push("  RISK ATTRIBUTION & DECOMPOSITION ENGINE");
  lines.push("=".repeat(74));
  lines.push(`  Timestamp:       ${report.timestamp}`);
  lines.push(`  Portfolio Value:  $${portfolio.value.toLocaleString()}`);
  lines.push(`  Confidence:      ${(portfolio.confidence * 100).toFixed(1)}%`);
  lines.push(`  Horizon:         ${portfolio.horizon} day(s)`);
  lines.push(`  Assets:          ${portfolio.names.length}`);
  lines.push("=".repeat(74));

  // Weights
  lines.push("");
  lines.push("--- Portfolio Weights ---");
  lines.push("");
  for (let i = 0; i < portfolio.names.length; i++) {
    const bar = "#".repeat(Math.round(portfolio.weights[i] * 50));
    lines.push(`  ${portfolio.names[i].padEnd(16)} ${(portfolio.weights[i] * 100).toFixed(1).padStart(6)}%  ${bar}`);
  }

  // Component VaR
  lines.push("");
  lines.push("--- Component VaR (risk contribution per position) ---");
  lines.push("");
  lines.push(`  Total Portfolio VaR: $${cvar.total.toLocaleString()}`);
  lines.push("");
  lines.push(
    "  " + "Asset".padEnd(16) +
    "Comp VaR ($)".padStart(14) +
    "% of Total".padStart(12) +
    "  Bar"
  );
  lines.push("  " + "-".repeat(60));

  for (const c of cvar.named) {
    const bar = "|".repeat(Math.round(Math.abs(c.pctContribution) * 40));
    lines.push(
      "  " + c.name.padEnd(16) +
      ("$" + c.componentVaR.toFixed(2)).padStart(14) +
      ((c.pctContribution * 100).toFixed(2) + "%").padStart(12) +
      "  " + bar
    );
  }

  // Marginal VaR
  lines.push("");
  lines.push("--- Marginal VaR (sensitivity to small weight change) ---");
  lines.push("");
  lines.push(
    "  " + "Asset".padEnd(16) +
    "Marginal VaR".padStart(14) +
    "  Interpretation"
  );
  lines.push("  " + "-".repeat(60));

  for (const m of mvar) {
    const interp = m.marginalVaR > 0.01 ? "risk-adding" :
                   m.marginalVaR < -0.01 ? "risk-reducing" : "neutral";
    lines.push(
      "  " + m.name.padEnd(16) +
      m.marginalVaR.toFixed(6).padStart(14) +
      "  " + interp
    );
  }

  // Incremental VaR
  lines.push("");
  lines.push("--- Incremental VaR (impact of removing full position) ---");
  lines.push("");
  lines.push(
    "  " + "Asset".padEnd(16) +
    "Incr VaR ($)".padStart(14) +
    "  Effect"
  );
  lines.push("  " + "-".repeat(50));

  for (const iv of ivar) {
    const effect = iv.incrementalVaR > 0 ? "INCREASES risk" :
                   iv.incrementalVaR < 0 ? "DECREASES risk" : "no effect";
    lines.push(
      "  " + iv.name.padEnd(16) +
      ("$" + iv.incrementalVaR.toFixed(2)).padStart(14) +
      "  " + effect
    );
  }

  // Risk Budget
  lines.push("");
  lines.push("--- Risk Budget (actual vs target allocation) ---");
  lines.push("");
  lines.push(
    "  " + "Asset".padEnd(16) +
    "Actual %".padStart(10) +
    "Target %".padStart(10) +
    "Deviation".padStart(10) +
    "  Status"
  );
  lines.push("  " + "-".repeat(62));

  for (const p of riskBudget.positions) {
    lines.push(
      "  " + p.name.padEnd(16) +
      ((p.actualRiskPct * 100).toFixed(2) + "%").padStart(10) +
      ((p.targetRiskPct * 100).toFixed(2) + "%").padStart(10) +
      ((p.deviation * 100).toFixed(2) + "%").padStart(10) +
      "  " + p.status
    );
  }
  lines.push("");
  lines.push(`  Tracking Error:    ${(riskBudget.trackingError * 100).toFixed(4)}%`);
  lines.push(`  Total Active Risk: ${(riskBudget.totalActiveRisk * 100).toFixed(4)}%`);

  // Concentration
  lines.push("");
  lines.push("--- Concentration Risk (Herfindahl-Hirschman Index) ---");
  lines.push("");
  lines.push(`  HHI (raw):        ${concentration.hhi.toFixed(4)}  (min=${(1/portfolio.names.length).toFixed(4)} for ${portfolio.names.length} assets)`);
  lines.push(`  HHI (normalized): ${concentration.normalizedHHI.toFixed(4)}  (0=diversified, 1=concentrated)`);
  lines.push(`  Effective # pos:  ${concentration.effectiveN.toFixed(2)}  (of ${portfolio.names.length} actual)`);
  lines.push("");
  lines.push("  Risk shares:");
  for (let i = 0; i < portfolio.names.length; i++) {
    const bar = "=".repeat(Math.round(concentration.riskShares[i] * 40));
    lines.push(`    ${portfolio.names[i].padEnd(16)} ${(concentration.riskShares[i] * 100).toFixed(2).padStart(7)}%  ${bar}`);
  }

  // Diversification
  lines.push("");
  lines.push("--- Diversification Ratio ---");
  lines.push("");
  lines.push(`  Ratio:             ${diversification.ratio.toFixed(4)}  (>1 = diversification benefit)`);
  lines.push(`  Benefit:           ${(diversification.diversificationBenefit * 100).toFixed(2)}%  of risk eliminated by diversification`);
  lines.push(`  Portfolio Vol:     ${(diversification.portfolioVol * 100).toFixed(4)}%`);
  lines.push(`  Weighted Sum Vol:  ${(diversification.weightedSumVol * 100).toFixed(4)}%`);
  lines.push("");
  lines.push("  Individual vols:");
  for (let i = 0; i < portfolio.names.length; i++) {
    lines.push(`    ${portfolio.names[i].padEnd(16)} ${(diversification.individualVols[i] * 100).toFixed(4)}%`);
  }

  lines.push("");
  lines.push("=".repeat(74));

  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    confidence: 0.95,
    portfolioValue: 1000000,
    horizon: 1,
    periods: 252,
    json: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--confidence") opts.confidence = parseFloat(args[++i]);
    if (args[i] === "--value") opts.portfolioValue = parseFloat(args[++i]);
    if (args[i] === "--horizon") opts.horizon = parseInt(args[++i]);
    if (args[i] === "--periods") opts.periods = parseInt(args[++i]);
    if (args[i] === "--json") opts.json = true;
    if (args[i] === "--help" || args[i] === "-h") opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
Risk Attribution & Decomposition Engine

Decomposes portfolio risk into position-level contributions using
Component VaR, Marginal VaR, Incremental VaR, risk budgets, HHI,
and diversification ratio analysis.

Usage:
  node agents/risk/risk-attribution.mjs [options]

Options:
  --confidence <n>    VaR confidence level (default: 0.95)
  --value <n>         Portfolio value in $ (default: 1000000)
  --horizon <n>       VaR horizon in days (default: 1)
  --periods <n>       Simulated return periods (default: 252)
  --json              Output raw JSON
  --help              Show this help

Examples:
  node agents/risk/risk-attribution.mjs
  node agents/risk/risk-attribution.mjs --confidence 0.99 --value 500000
  node agents/risk/risk-attribution.mjs --json
`);
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Generate 5-asset demo portfolio
  const { returns, names } = generateDemoReturns(5, opts.periods);

  // Non-equal weights to show interesting attribution
  const weights = [0.35, 0.25, 0.20, 0.10, 0.10];

  // Target risk budget: equal risk
  const targetRiskBudget = [0.20, 0.20, 0.20, 0.20, 0.20];

  const attributor = new RiskAttributor({
    names,
    weights,
    returns,
    confidence: opts.confidence,
    portfolioValue: opts.portfolioValue,
    horizon: opts.horizon,
    targetRiskBudget,
  });

  const report = attributor.fullReport();

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
}

// Run if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("risk-attribution.mjs") ||
  process.argv[1].includes("risk-attribution")
);
if (isMain) {
  main().catch(err => {
    console.error("Risk attribution failed:", err.message);
    process.exit(1);
  });
}
