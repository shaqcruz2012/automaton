#!/usr/bin/env node
/**
 * Extreme Value Theory & Tail Risk — Inferred Analysis
 *
 * Models the tails of return distributions for rare event risk:
 * 1. Generalized Pareto Distribution (GPD) fitting
 * 2. Block maxima / GEV estimation
 * 3. Expected Shortfall beyond VaR
 * 4. Return period estimation
 * 5. Tail index (Hill estimator)
 *
 * Usage:
 *   node agents/risk/extreme-value.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Hill estimator for tail index (shape parameter).
 * @param {number[]} losses - sorted descending array of losses
 * @param {number} k - number of order statistics to use
 * @returns {{ xi: number, se: number }}
 */
export function hillEstimator(losses, k = null) {
  const sorted = [...losses].sort((a, b) => b - a).filter(x => x > 0);
  if (!k) k = Math.floor(Math.sqrt(sorted.length));
  k = Math.min(k, sorted.length - 1);
  if (k < 2) return { xi: 0, se: Infinity };

  const threshold = sorted[k];
  if (threshold <= 0) return { xi: 0, se: Infinity };

  let sum = 0;
  for (let i = 0; i < k; i++) {
    sum += Math.log(sorted[i] / threshold);
  }

  const xi = sum / k;
  const se = xi / Math.sqrt(k);
  return { xi, se };
}

/**
 * Fit Generalized Pareto Distribution to exceedances over threshold.
 * Uses method of moments (PWM) for parameter estimation.
 * @param {number[]} data - array of returns (or losses)
 * @param {number} threshold - threshold for POT
 * @returns {{ xi: number, beta: number, threshold: number, nExceed: number }}
 */
export function fitGPD(data, threshold = null) {
  const losses = data.map(r => -r).sort((a, b) => b - a);

  // Default threshold: 90th percentile of losses
  if (threshold === null) {
    threshold = losses[Math.floor(losses.length * 0.1)];
  }

  const exceedances = losses.filter(l => l > threshold).map(l => l - threshold);
  const n = exceedances.length;
  if (n < 10) return { xi: 0, beta: 1, threshold, nExceed: n };

  // Method of moments
  const mean = exceedances.reduce((a, b) => a + b, 0) / n;
  const variance = exceedances.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);

  // PWM estimators
  const xi = 0.5 * (mean * mean / variance - 1);
  const beta = mean * (1 - xi);

  return {
    xi: Math.max(-0.5, Math.min(2, xi)),
    beta: Math.max(0.0001, beta),
    threshold,
    nExceed: n,
  };
}

/**
 * GPD survival function: P(X > x | X > u)
 */
function gpdSurvival(x, xi, beta) {
  if (Math.abs(xi) < 1e-10) return Math.exp(-x / beta);
  const z = 1 + xi * x / beta;
  if (z <= 0) return 0;
  return Math.pow(z, -1 / xi);
}

/**
 * GPD quantile function: VaR at probability p (tail probability)
 */
function gpdQuantile(p, xi, beta) {
  if (Math.abs(xi) < 1e-10) return -beta * Math.log(p);
  return (beta / xi) * (Math.pow(p, -xi) - 1);
}

/**
 * Compute EVT-based VaR and Expected Shortfall.
 * @param {number[]} returns - daily returns
 * @param {number} confidence - e.g., 0.99
 * @returns {{ var: number, es: number, gpdParams: object }}
 */
export function evtVaR(returns, confidence = 0.99) {
  const gpd = fitGPD(returns);
  const n = returns.length;
  const nu = gpd.nExceed;
  const p = 1 - confidence;

  // EVT VaR
  const tailProb = (n / nu) * p;
  const exceedanceQuantile = gpdQuantile(tailProb, gpd.xi, gpd.beta);
  const var_ = gpd.threshold + exceedanceQuantile;

  // Expected shortfall
  let es;
  if (gpd.xi < 1) {
    es = var_ / (1 - gpd.xi) + (gpd.beta - gpd.xi * gpd.threshold) / (1 - gpd.xi);
  } else {
    es = var_ * 1.5; // fallback for heavy tails
  }

  return { var: var_, es, gpdParams: gpd };
}

/**
 * Return period: expected number of observations between events of size >= x.
 */
export function returnPeriod(x, returns) {
  const gpd = fitGPD(returns);
  const n = returns.length;
  const nu = gpd.nExceed;

  if (x <= gpd.threshold) {
    // Below threshold: use empirical
    const exceedCount = returns.filter(r => -r >= x).length;
    return exceedCount > 0 ? n / exceedCount : Infinity;
  }

  const survProb = gpdSurvival(x - gpd.threshold, gpd.xi, gpd.beta);
  const unconditionalProb = (nu / n) * survProb;
  return unconditionalProb > 0 ? 1 / unconditionalProb : Infinity;
}

/**
 * Tail dependence analysis: do multiple assets crash together?
 */
export function tailDependence(returnsA, returnsB, quantile = 0.05) {
  const n = Math.min(returnsA.length, returnsB.length);
  const threshA = [...returnsA].sort((a, b) => a - b)[Math.floor(n * quantile)];
  const threshB = [...returnsB].sort((a, b) => a - b)[Math.floor(n * quantile)];

  let jointTail = 0;
  let tailA = 0;
  let tailB = 0;

  for (let i = 0; i < n; i++) {
    const inTailA = returnsA[i] <= threshA;
    const inTailB = returnsB[i] <= threshB;
    if (inTailA) tailA++;
    if (inTailB) tailB++;
    if (inTailA && inTailB) jointTail++;
  }

  const lowerTailDep = tailA > 0 ? jointTail / tailA : 0;
  const upperThreshA = [...returnsA].sort((a, b) => a - b)[Math.floor(n * (1 - quantile))];
  const upperThreshB = [...returnsB].sort((a, b) => a - b)[Math.floor(n * (1 - quantile))];

  let jointUpper = 0;
  let upperA = 0;
  for (let i = 0; i < n; i++) {
    if (returnsA[i] >= upperThreshA) upperA++;
    if (returnsA[i] >= upperThreshA && returnsB[i] >= upperThreshB) jointUpper++;
  }

  const upperTailDep = upperA > 0 ? jointUpper / upperA : 0;

  return { lowerTailDependence: lowerTailDep, upperTailDependence: upperTailDep, jointExtremes: jointTail, totalExtremes: tailA };
}

/**
 * Full tail risk report.
 */
export class TailRiskAnalyzer {
  constructor(returns, label = "Portfolio") {
    this.returns = returns;
    this.label = label;
    this.n = returns.length;
  }

  getDistributionStats() {
    const r = this.returns;
    const n = r.length;
    const mean = r.reduce((a, b) => a + b, 0) / n;
    const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
    const std = Math.sqrt(variance);

    const m3 = r.reduce((s, x) => s + ((x - mean) / std) ** 3, 0) / n;
    const m4 = r.reduce((s, x) => s + ((x - mean) / std) ** 4, 0) / n;

    return { mean: mean * 252, std: std * Math.sqrt(252), skewness: m3, kurtosis: m4, excessKurtosis: m4 - 3 };
  }

  getVaRLadder() {
    const confidences = [0.90, 0.95, 0.99, 0.995, 0.999];
    const sorted = [...this.returns].sort((a, b) => a - b);

    return confidences.map(c => {
      const empiricalIdx = Math.floor(this.n * (1 - c));
      const empiricalVaR = -sorted[empiricalIdx];
      const evt = evtVaR(this.returns, c);
      return {
        confidence: c,
        empiricalVaR,
        evtVaR: evt.var,
        evtES: evt.es,
      };
    });
  }

  getHillPlot(maxK = null) {
    if (!maxK) maxK = Math.floor(this.n * 0.2);
    const losses = this.returns.map(r => -r).sort((a, b) => b - a).filter(x => x > 0);
    const points = [];

    for (let k = 10; k <= Math.min(maxK, losses.length - 1); k += 5) {
      const { xi, se } = hillEstimator(losses, k);
      points.push({ k, xi, se, lower: xi - 1.96 * se, upper: xi + 1.96 * se });
    }

    return points;
  }

  getReturnPeriods() {
    const events = [0.02, 0.05, 0.10, 0.15, 0.20];
    return events.map(loss => ({
      loss: `${(loss * 100).toFixed(0)}%`,
      returnPeriod: returnPeriod(loss, this.returns),
      expectedPerYear: 252 / returnPeriod(loss, this.returns),
    }));
  }

  formatReport() {
    const stats = this.getDistributionStats();
    const ladder = this.getVaRLadder();
    const periods = this.getReturnPeriods();
    const hill = hillEstimator(this.returns.map(r => -r));

    let out = `\n${"═".repeat(50)}\n`;
    out += `  TAIL RISK REPORT — ${this.label}\n`;
    out += `${"═".repeat(50)}\n\n`;

    out += `  Distribution:\n`;
    out += `    Ann. Return:     ${(stats.mean * 100).toFixed(2)}%\n`;
    out += `    Ann. Vol:        ${(stats.std * 100).toFixed(2)}%\n`;
    out += `    Skewness:        ${stats.skewness.toFixed(3)}\n`;
    out += `    Excess Kurtosis: ${stats.excessKurtosis.toFixed(3)}\n`;
    out += `    Tail Index (xi): ${hill.xi.toFixed(3)} ± ${hill.se.toFixed(3)}\n`;
    out += `    Fat tails:       ${stats.excessKurtosis > 1 ? "YES" : "NO"}\n\n`;

    out += `  VaR Ladder:\n`;
    out += `    Conf.   Empirical  EVT-VaR    EVT-ES\n`;
    for (const v of ladder) {
      out += `    ${(v.confidence * 100).toFixed(1)}%   ${(v.empiricalVaR * 100).toFixed(2).padStart(7)}%  ${(v.evtVaR * 100).toFixed(2).padStart(7)}%  ${(v.evtES * 100).toFixed(2).padStart(7)}%\n`;
    }

    out += `\n  Return Periods:\n`;
    out += `    Loss     Every N days   Per Year\n`;
    for (const p of periods) {
      const rp = p.returnPeriod === Infinity ? "never" : `${p.returnPeriod.toFixed(0)} days`;
      const py = p.returnPeriod === Infinity ? "0.00" : p.expectedPerYear.toFixed(2);
      out += `    ${p.loss.padEnd(8)} ${rp.padStart(12)}   ${py.padStart(8)}\n`;
    }

    out += `\n${"═".repeat(50)}\n`;
    return out;
  }
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Extreme Value Theory & Tail Risk ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  // Portfolio returns
  const n = Math.min(...symbols.map(s => priceArrays[s].length)) - 1;
  const weights = { SPY: 0.4, QQQ: 0.3, TLT: 0.2, GLD: 0.1 };
  const portReturns = [];
  for (let i = 1; i <= n; i++) {
    let r = 0;
    for (const sym of symbols) {
      r += weights[sym] * (priceArrays[sym][i].close - priceArrays[sym][i - 1].close) / priceArrays[sym][i - 1].close;
    }
    portReturns.push(r);
  }

  const analyzer = new TailRiskAnalyzer(portReturns, "60/40 Portfolio");
  console.log(analyzer.formatReport());

  // Tail dependence
  console.log("─── Tail Dependence ───\n");
  const spyRet = priceArrays.SPY.slice(1).map((p, i) => (p.close - priceArrays.SPY[i].close) / priceArrays.SPY[i].close);
  const tltRet = priceArrays.TLT.slice(1).map((p, i) => (p.close - priceArrays.TLT[i].close) / priceArrays.TLT[i].close);
  const td = tailDependence(spyRet, tltRet);
  console.log(`  SPY/TLT Lower tail dep: ${td.lowerTailDependence.toFixed(3)}`);
  console.log(`  SPY/TLT Upper tail dep: ${td.upperTailDependence.toFixed(3)}`);
  console.log(`  Joint extreme events:   ${td.jointExtremes}/${td.totalExtremes}`);
}

if (process.argv[1]?.includes("extreme-value")) {
  main().catch(console.error);
}
