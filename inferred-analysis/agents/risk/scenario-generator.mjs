#!/usr/bin/env node
/**
 * Monte Carlo Scenario Generator — Inferred Analysis
 *
 * Advanced scenario generation for stress testing and risk analysis:
 * 1. Correlated multi-asset return simulation (Cholesky)
 * 2. Historical bootstrap with block sampling
 * 3. Stressed scenarios (fat tails, crisis injection)
 * 4. Scenario-weighted portfolio analysis
 *
 * Usage:
 *   node agents/risk/scenario-generator.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Box-Muller transform for standard normal random variates.
 */
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Cholesky decomposition of a positive-definite matrix.
 */
export function cholesky(matrix) {
  const n = matrix.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];

      if (i === j) {
        const diag = matrix[i][i] - sum;
        L[i][j] = diag > 0 ? Math.sqrt(diag) : 1e-10;
      } else {
        L[i][j] = L[j][j] > 0 ? (matrix[i][j] - sum) / L[j][j] : 0;
      }
    }
  }
  return L;
}

/**
 * Generate correlated normal random vectors.
 */
export function correlatedNormals(covMatrix, nSamples) {
  const n = covMatrix.length;
  const L = cholesky(covMatrix);
  const samples = [];

  for (let s = 0; s < nSamples; s++) {
    const z = Array.from({ length: n }, () => randn());
    const correlated = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        correlated[i] += L[i][j] * z[j];
      }
    }
    samples.push(correlated);
  }
  return samples;
}

/**
 * Monte Carlo scenario generator.
 */
export class ScenarioGenerator {
  constructor(historicalReturns, symbols) {
    this.returns = historicalReturns; // { symbol: [returns] }
    this.symbols = symbols || Object.keys(historicalReturns);
    this.n = this.symbols.length;
    this._computeStats();
  }

  _computeStats() {
    const T = Math.min(...this.symbols.map(s => this.returns[s].length));
    this.T = T;

    // Means
    this.means = this.symbols.map(sym =>
      this.returns[sym].slice(0, T).reduce((a, b) => a + b, 0) / T
    );

    // Covariance matrix
    this.covMatrix = Array.from({ length: this.n }, () => new Array(this.n).fill(0));
    for (let i = 0; i < this.n; i++) {
      for (let j = i; j < this.n; j++) {
        let cov = 0;
        for (let t = 0; t < T; t++) {
          cov += (this.returns[this.symbols[i]][t] - this.means[i]) *
                 (this.returns[this.symbols[j]][t] - this.means[j]);
        }
        this.covMatrix[i][j] = cov / (T - 1);
        this.covMatrix[j][i] = this.covMatrix[i][j];
      }
    }
  }

  /**
   * Generate parametric Monte Carlo scenarios (correlated normals).
   */
  parametricScenarios(nScenarios = 1000, horizon = 21) {
    const scenarios = [];
    for (let s = 0; s < nScenarios; s++) {
      const dailyReturns = correlatedNormals(this.covMatrix, horizon);
      // Compound daily returns over horizon
      const cumReturns = this.symbols.map((_, i) => {
        let cum = 1;
        for (let d = 0; d < horizon; d++) {
          cum *= (1 + this.means[i] + dailyReturns[d][i]);
        }
        return cum - 1;
      });
      scenarios.push(cumReturns);
    }
    return scenarios;
  }

  /**
   * Historical bootstrap with block sampling.
   */
  historicalBootstrap(nScenarios = 1000, blockSize = 5, horizon = 21) {
    const scenarios = [];
    const T = this.T;

    for (let s = 0; s < nScenarios; s++) {
      const cumReturns = new Array(this.n).fill(1);
      let d = 0;
      while (d < horizon) {
        const start = Math.floor(Math.random() * (T - blockSize));
        const end = Math.min(start + blockSize, start + (horizon - d));
        for (let t = start; t < end && d < horizon; t++, d++) {
          for (let i = 0; i < this.n; i++) {
            cumReturns[i] *= (1 + this.returns[this.symbols[i]][t]);
          }
        }
      }
      scenarios.push(cumReturns.map(c => c - 1));
    }
    return scenarios;
  }

  /**
   * Stressed scenarios: inject fat tails and crisis events.
   */
  stressedScenarios(nScenarios = 1000, horizon = 21, stressMultiplier = 2.5) {
    const scenarios = [];
    const stressedCov = this.covMatrix.map(row =>
      row.map(v => v * stressMultiplier * stressMultiplier)
    );

    // Also increase correlations during stress
    for (let i = 0; i < this.n; i++) {
      for (let j = i + 1; j < this.n; j++) {
        const origCorr = this.covMatrix[i][j] /
          Math.sqrt(this.covMatrix[i][i] * this.covMatrix[j][j]);
        const stressCorr = Math.min(0.95, Math.abs(origCorr) + 0.3) * Math.sign(origCorr);
        stressedCov[i][j] = stressCorr * Math.sqrt(stressedCov[i][i] * stressedCov[j][j]);
        stressedCov[j][i] = stressedCov[i][j];
      }
    }

    for (let s = 0; s < nScenarios; s++) {
      const dailyReturns = correlatedNormals(stressedCov, horizon);
      const cumReturns = this.symbols.map((_, i) => {
        let cum = 1;
        for (let d = 0; d < horizon; d++) {
          cum *= (1 + dailyReturns[d][i]);
        }
        return cum - 1;
      });
      scenarios.push(cumReturns);
    }
    return scenarios;
  }

  /**
   * Analyze portfolio under scenarios.
   */
  analyzePortfolio(weights, scenarios) {
    const portReturns = scenarios.map(sc =>
      sc.reduce((sum, r, i) => sum + (weights[this.symbols[i]] || 0) * r, 0)
    );

    const sorted = [...portReturns].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = portReturns.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(portReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));

    const var95idx = Math.floor(n * 0.05);
    const var99idx = Math.floor(n * 0.01);

    return {
      mean,
      std,
      var95: -sorted[var95idx],
      var99: -sorted[var99idx],
      es95: -sorted.slice(0, var95idx + 1).reduce((a, b) => a + b, 0) / (var95idx + 1),
      es99: -sorted.slice(0, var99idx + 1).reduce((a, b) => a + b, 0) / (var99idx + 1),
      min: sorted[0],
      max: sorted[n - 1],
      median: sorted[Math.floor(n / 2)],
      probLoss: portReturns.filter(r => r < 0).length / n,
      probLoss5pct: portReturns.filter(r => r < -0.05).length / n,
      probLoss10pct: portReturns.filter(r => r < -0.10).length / n,
    };
  }

  /**
   * Compare scenario types.
   */
  compareScenarioTypes(weights, nScenarios = 5000, horizon = 21) {
    const parametric = this.analyzePortfolio(weights, this.parametricScenarios(nScenarios, horizon));
    const bootstrap = this.analyzePortfolio(weights, this.historicalBootstrap(nScenarios, 5, horizon));
    const stressed = this.analyzePortfolio(weights, this.stressedScenarios(nScenarios, horizon));

    return { parametric, bootstrap, stressed };
  }

  formatReport(weights, nScenarios = 5000) {
    const comparison = this.compareScenarioTypes(weights, nScenarios);
    let out = `\n${"═".repeat(55)}\n  MONTE CARLO SCENARIO ANALYSIS\n${"═".repeat(55)}\n`;

    for (const [type, stats] of Object.entries(comparison)) {
      out += `\n  ── ${type.toUpperCase()} ──\n`;
      out += `    Mean Return:   ${(stats.mean * 100).toFixed(2)}%\n`;
      out += `    Volatility:    ${(stats.std * 100).toFixed(2)}%\n`;
      out += `    VaR (95%):     ${(stats.var95 * 100).toFixed(2)}%\n`;
      out += `    VaR (99%):     ${(stats.var99 * 100).toFixed(2)}%\n`;
      out += `    ES (95%):      ${(stats.es95 * 100).toFixed(2)}%\n`;
      out += `    Worst Case:    ${(stats.min * 100).toFixed(2)}%\n`;
      out += `    P(loss):       ${(stats.probLoss * 100).toFixed(1)}%\n`;
      out += `    P(loss>5%):    ${(stats.probLoss5pct * 100).toFixed(1)}%\n`;
      out += `    P(loss>10%):   ${(stats.probLoss10pct * 100).toFixed(1)}%\n`;
    }
    out += `\n${"═".repeat(55)}\n`;
    return out;
  }
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Monte Carlo Scenario Generator ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  const n = Math.min(...symbols.map(s => priceArrays[s].length)) - 1;
  const returns = {};
  for (const sym of symbols) {
    returns[sym] = [];
    for (let i = 1; i <= n; i++) {
      returns[sym].push((priceArrays[sym][i].close - priceArrays[sym][i - 1].close) / priceArrays[sym][i - 1].close);
    }
  }

  const gen = new ScenarioGenerator(returns, symbols);
  const weights = { SPY: 0.4, QQQ: 0.3, TLT: 0.2, GLD: 0.1 };
  console.log(gen.formatReport(weights, 10000));
}

if (process.argv[1]?.includes("scenario-generator")) {
  main().catch(console.error);
}
