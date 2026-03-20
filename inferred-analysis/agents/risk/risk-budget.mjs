#!/usr/bin/env node
/**
 * Risk Budget Allocator for Quant Fund
 *
 * Allocates risk budget across strategies using multiple frameworks:
 *   - Equal risk budget (equal VaR per strategy)
 *   - Sharpe-weighted (more budget to higher Sharpe)
 *   - Kelly criterion-based allocation
 *   - Risk parity (equal marginal risk contribution)
 *   - Constrained budgeting (min/max per strategy, max leverage)
 *   - Dynamic budgeting (adjust for recent performance / drawdowns)
 *
 * Usage:
 *   node agents/risk/risk-budget.mjs
 *   node agents/risk/risk-budget.mjs --total-risk 0.15 --method kelly
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Utility helpers ────────────────────────────────────────

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function pricesToReturns(prices) {
  const closes = prices.map((p) => p.close);
  const ret = [];
  for (let i = 1; i < closes.length; i++) {
    ret.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return ret;
}

function covarianceMatrix(returnSeries) {
  const n = returnSeries.length;
  const means = returnSeries.map(mean);
  const cov = Array.from({ length: n }, () => new Array(n).fill(0));
  const T = returnSeries[0].length;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) {
        s += (returnSeries[i][t] - means[i]) * (returnSeries[j][t] - means[j]);
      }
      cov[i][j] = s / (T - 1);
      cov[j][i] = cov[i][j];
    }
  }
  return cov;
}

function maxDrawdown(returns) {
  let peak = 1;
  let equity = 1;
  let maxDD = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ─── Risk contribution functions ────────────────────────────

export function computeRiskContribution(weights, covMatrix) {
  const n = weights.length;
  // Portfolio variance: w' * Cov * w
  let portVar = 0;
  const marginal = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      portVar += weights[i] * weights[j] * covMatrix[i][j];
      marginal[i] += covMatrix[i][j] * weights[j];
    }
  }
  const portVol = Math.sqrt(portVar);
  // Marginal risk contribution = w_i * (Cov * w)_i / sigma_p
  const contributions = weights.map((w, i) => (w * marginal[i]) / portVol);
  const pctContributions = contributions.map((c) => c / portVol);
  return {
    portfolioVol: portVol,
    marginalContributions: marginal.map((m) => m / portVol),
    riskContributions: contributions,
    pctContributions,
  };
}

export function riskDecomposition(weights, returns) {
  const cov = covarianceMatrix(returns);
  const rc = computeRiskContribution(weights, cov);
  const n = weights.length;
  // Decompose by: systematic (average pairwise) vs idiosyncratic
  const decomp = [];
  for (let i = 0; i < n; i++) {
    let systematic = 0;
    let idiosyncratic = weights[i] ** 2 * cov[i][i];
    for (let j = 0; j < n; j++) {
      if (j !== i) systematic += weights[i] * weights[j] * cov[i][j];
    }
    decomp.push({
      index: i,
      totalContribution: rc.riskContributions[i],
      systematicRisk: systematic / rc.portfolioVol,
      idiosyncraticRisk: idiosyncratic / rc.portfolioVol,
      pctOfTotal: rc.pctContributions[i],
    });
  }
  return { portfolioVol: rc.portfolioVol, decomposition: decomp };
}

export function breachDetector(allocations, limits) {
  const breaches = [];
  for (const alloc of allocations) {
    const limit = limits.find((l) => l.name === alloc.name);
    if (!limit) continue;
    if (limit.maxRiskBudget != null && alloc.riskBudget > limit.maxRiskBudget) {
      breaches.push({
        name: alloc.name,
        type: "MAX_RISK_BUDGET",
        value: alloc.riskBudget,
        limit: limit.maxRiskBudget,
        excess: alloc.riskBudget - limit.maxRiskBudget,
        severity: alloc.riskBudget / limit.maxRiskBudget > 1.2 ? "CRITICAL" : "WARNING",
      });
    }
    if (limit.minRiskBudget != null && alloc.riskBudget < limit.minRiskBudget) {
      breaches.push({
        name: alloc.name,
        type: "MIN_RISK_BUDGET",
        value: alloc.riskBudget,
        limit: limit.minRiskBudget,
        shortfall: limit.minRiskBudget - alloc.riskBudget,
        severity: "WARNING",
      });
    }
    if (limit.maxWeight != null && alloc.weight > limit.maxWeight) {
      breaches.push({
        name: alloc.name,
        type: "MAX_WEIGHT",
        value: alloc.weight,
        limit: limit.maxWeight,
        excess: alloc.weight - limit.maxWeight,
        severity: alloc.weight / limit.maxWeight > 1.5 ? "CRITICAL" : "WARNING",
      });
    }
    if (limit.maxDrawdown != null && alloc.currentDrawdown != null && alloc.currentDrawdown > limit.maxDrawdown) {
      breaches.push({
        name: alloc.name,
        type: "MAX_DRAWDOWN",
        value: alloc.currentDrawdown,
        limit: limit.maxDrawdown,
        excess: alloc.currentDrawdown - limit.maxDrawdown,
        severity: "CRITICAL",
      });
    }
  }
  const totalWeight = allocations.reduce((s, a) => s + a.weight, 0);
  const totalLevLimit = limits.find((l) => l.name === "__portfolio__");
  if (totalLevLimit && totalLevLimit.maxLeverage && totalWeight > totalLevLimit.maxLeverage) {
    breaches.push({
      name: "__portfolio__",
      type: "MAX_LEVERAGE",
      value: totalWeight,
      limit: totalLevLimit.maxLeverage,
      excess: totalWeight - totalLevLimit.maxLeverage,
      severity: "CRITICAL",
    });
  }
  return breaches;
}

// ─── RiskBudgetAllocator class ──────────────────────────────

export class RiskBudgetAllocator {
  /**
   * @param {Array<{name: string, sharpe: number, vol: number, correlation: number}>} strategies
   * @param {number} totalRiskBudget - total VaR or vol budget (e.g. 0.15 = 15%)
   */
  constructor(strategies, totalRiskBudget) {
    this.strategies = strategies;
    this.totalRiskBudget = totalRiskBudget;
    this.n = strategies.length;
    this._allocated = null;
  }

  /** Equal VaR allocation: each strategy gets totalRisk / n */
  equalRiskBudget() {
    const perStrategy = this.totalRiskBudget / this.n;
    this._allocated = this.strategies.map((s) => ({
      name: s.name,
      riskBudget: perStrategy,
      weight: perStrategy / s.vol,
    }));
    return this._allocated;
  }

  /** Sharpe-weighted: more risk to higher Sharpe ratio strategies */
  sharpeWeightedBudget() {
    const sharpes = this.strategies.map((s) => Math.max(s.sharpe, 0.01));
    const totalSharpe = sharpes.reduce((s, v) => s + v, 0);
    this._allocated = this.strategies.map((s, i) => {
      const riskBudget = (sharpes[i] / totalSharpe) * this.totalRiskBudget;
      return {
        name: s.name,
        riskBudget,
        weight: riskBudget / s.vol,
        sharpeRatio: s.sharpe,
      };
    });
    return this._allocated;
  }

  /** Kelly criterion: f* = sharpe / vol, scaled to fit total budget */
  kellyBudget() {
    const rawKelly = this.strategies.map((s) => {
      // Full Kelly: f* = mu / sigma^2 ≈ sharpe / sigma
      const fStar = Math.max(s.sharpe / s.vol, 0);
      return fStar;
    });
    // Use half-Kelly for safety
    const halfKelly = rawKelly.map((k) => k * 0.5);
    const totalKelly = halfKelly.reduce((s, v) => s + v, 0);
    // Scale so total risk budget is respected
    const scale = totalKelly > 0 ? this.totalRiskBudget / (totalKelly * mean(this.strategies.map((s) => s.vol))) : 1;
    this._allocated = this.strategies.map((s, i) => {
      const riskBudget = halfKelly[i] * s.vol * scale;
      return {
        name: s.name,
        riskBudget,
        weight: halfKelly[i] * scale,
        fullKelly: rawKelly[i],
        halfKelly: halfKelly[i],
      };
    });
    return this._allocated;
  }

  /** Risk parity: each strategy contributes equally to total portfolio risk */
  riskParityBudget() {
    // Approximate risk parity via inverse-vol weighting
    const invVols = this.strategies.map((s) => 1 / s.vol);
    const totalInvVol = invVols.reduce((s, v) => s + v, 0);
    // Raw weights
    let weights = invVols.map((iv) => iv / totalInvVol);
    // Scale to hit total risk budget
    const portVol = Math.sqrt(
      weights.reduce((s, wi, i) => {
        let row = 0;
        for (let j = 0; j < this.n; j++) {
          const corr = i === j ? 1 : this.strategies[i].correlation * this.strategies[j].correlation;
          row += weights[j] * this.strategies[i].vol * this.strategies[j].vol * Math.min(corr, 1);
        }
        return s + wi * row;
      }, 0)
    );
    const scaleFactor = this.totalRiskBudget / portVol;
    weights = weights.map((w) => w * scaleFactor);
    this._allocated = this.strategies.map((s, i) => ({
      name: s.name,
      riskBudget: weights[i] * s.vol,
      weight: weights[i],
    }));
    return this._allocated;
  }

  /** Constrained budget: apply min/max per strategy and max total leverage */
  constrainedBudget(constraints = {}) {
    const { minWeight = 0.02, maxWeight = 0.40, maxLeverage = 2.0 } = constraints;
    // Start with Sharpe-weighted as base
    let alloc = this.sharpeWeightedBudget();
    // Clamp weights
    alloc = alloc.map((a) => ({
      ...a,
      weight: Math.max(minWeight, Math.min(maxWeight, a.weight)),
    }));
    // Check total leverage
    let totalWeight = alloc.reduce((s, a) => s + a.weight, 0);
    if (totalWeight > maxLeverage) {
      const scale = maxLeverage / totalWeight;
      alloc = alloc.map((a) => ({
        ...a,
        weight: a.weight * scale,
        riskBudget: a.weight * scale * this.strategies.find((s) => s.name === a.name).vol,
      }));
      totalWeight = maxLeverage;
    }
    // Recalculate risk budgets
    alloc = alloc.map((a) => {
      const strat = this.strategies.find((s) => s.name === a.name);
      return { ...a, riskBudget: a.weight * strat.vol };
    });
    this._allocated = alloc;
    return this._allocated;
  }

  /**
   * Dynamic budget: adjust based on recent performance.
   * Reduce budget for strategies in drawdown, increase for outperformers.
   * @param {Object<string, number[]>} recentReturns - map of strategy name to recent daily returns
   * @param {number} lookback - days to consider (default 20)
   */
  dynamicBudget(recentReturns, lookback = 20) {
    // Start with Sharpe-weighted base
    let alloc = this.sharpeWeightedBudget();
    alloc = alloc.map((a) => {
      const returns = recentReturns[a.name];
      if (!returns || returns.length === 0) return a;
      const recent = returns.slice(-lookback);
      const dd = maxDrawdown(recent);
      const recentSharpe = mean(recent) / (std(recent) || 0.01) * Math.sqrt(252);
      const baseSharpe = this.strategies.find((s) => s.name === a.name).sharpe;
      // Drawdown penalty: reduce budget proportionally to drawdown severity
      const ddPenalty = Math.max(0.3, 1 - dd * 3);
      // Performance adjustment: scale by ratio of recent to expected Sharpe
      const perfAdj = baseSharpe > 0 ? Math.max(0.5, Math.min(1.5, recentSharpe / baseSharpe)) : 1;
      const adjustment = ddPenalty * perfAdj;
      return {
        ...a,
        weight: a.weight * adjustment,
        riskBudget: a.riskBudget * adjustment,
        adjustment,
        recentSharpe: +recentSharpe.toFixed(3),
        drawdown: +dd.toFixed(4),
      };
    });
    this._allocated = alloc;
    return this._allocated;
  }

  /** Current vs allocated risk utilization */
  getBudgetUtilization() {
    if (!this._allocated) this.equalRiskBudget();
    const totalAllocated = this._allocated.reduce((s, a) => s + a.riskBudget, 0);
    return {
      totalRiskBudget: this.totalRiskBudget,
      totalAllocated,
      utilizationPct: +((totalAllocated / this.totalRiskBudget) * 100).toFixed(1),
      remaining: +(this.totalRiskBudget - totalAllocated).toFixed(6),
      perStrategy: this._allocated.map((a) => ({
        name: a.name,
        allocated: +a.riskBudget.toFixed(6),
        pctOfTotal: +((a.riskBudget / this.totalRiskBudget) * 100).toFixed(1),
      })),
    };
  }

  /** ASCII table of risk allocations */
  formatBudget() {
    if (!this._allocated) this.equalRiskBudget();
    const header =
      "Strategy".padEnd(20) +
      "Weight".padStart(10) +
      "RiskBudget".padStart(12) +
      "% of Total".padStart(12);
    const sep = "─".repeat(header.length);
    const totalAlloc = this._allocated.reduce((s, a) => s + a.riskBudget, 0);
    const rows = this._allocated.map((a) => {
      const pct = ((a.riskBudget / this.totalRiskBudget) * 100).toFixed(1);
      return (
        a.name.padEnd(20) +
        a.weight.toFixed(4).padStart(10) +
        (a.riskBudget * 100).toFixed(2).padStart(11) + "%" +
        (pct + "%").padStart(11)
      );
    });
    const totalRow =
      "TOTAL".padEnd(20) +
      this._allocated
        .reduce((s, a) => s + a.weight, 0)
        .toFixed(4)
        .padStart(10) +
      (totalAlloc * 100).toFixed(2).padStart(11) + "%" +
      ((totalAlloc / this.totalRiskBudget) * 100).toFixed(1).padStart(10) + "%";
    return [sep, header, sep, ...rows, sep, totalRow, sep].join("\n");
  }
}

// ─── CLI Demo ───────────────────────────────────────────────

function demo() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  RISK BUDGET ALLOCATOR — Quant Fund Demo");
  console.log("═══════════════════════════════════════════════════════\n");

  // Generate price data for several strategies
  const symbols = ["SPY", "QQQ", "AAPL", "TSLA", "GLD", "TLT"];
  console.log("Generating price data...\n");
  const priceData = {};
  const returnData = {};
  for (const sym of symbols) {
    priceData[sym] = generateRealisticPrices(sym, "2023-01-01", "2025-01-01");
    returnData[sym] = pricesToReturns(priceData[sym]);
  }

  // Compute strategy stats
  const strategies = symbols.map((sym) => {
    const ret = returnData[sym];
    const mu = mean(ret) * 252;
    const sigma = std(ret) * Math.sqrt(252);
    const sharpe = sigma > 0 ? mu / sigma : 0;
    return { name: sym, sharpe: +sharpe.toFixed(3), vol: +sigma.toFixed(4), correlation: 0.5 };
  });

  console.log("\n── Strategy Profiles ──────────────────────────────────");
  console.log("Strategy".padEnd(10) + "AnnVol".padStart(10) + "Sharpe".padStart(10));
  for (const s of strategies) {
    console.log(s.name.padEnd(10) + (s.vol * 100).toFixed(2).padStart(9) + "%" + s.sharpe.toFixed(3).padStart(10));
  }

  const totalRisk = 0.15;
  const allocator = new RiskBudgetAllocator(strategies, totalRisk);

  // 1. Equal risk budget
  console.log("\n── Equal Risk Budget ──────────────────────────────────");
  allocator.equalRiskBudget();
  console.log(allocator.formatBudget());

  // 2. Sharpe-weighted
  console.log("\n── Sharpe-Weighted Budget ─────────────────────────────");
  allocator.sharpeWeightedBudget();
  console.log(allocator.formatBudget());

  // 3. Kelly
  console.log("\n── Kelly Criterion Budget ─────────────────────────────");
  const kellyAlloc = allocator.kellyBudget();
  console.log(allocator.formatBudget());
  console.log("\nKelly fractions:");
  for (const a of kellyAlloc) {
    console.log(`  ${a.name.padEnd(8)} full=${a.fullKelly.toFixed(3)}  half=${a.halfKelly.toFixed(3)}`);
  }

  // 4. Risk parity
  console.log("\n── Risk Parity Budget ────────────────────────────────");
  allocator.riskParityBudget();
  console.log(allocator.formatBudget());

  // 5. Constrained
  console.log("\n── Constrained Budget (min=5%, max=30%, lev≤1.5x) ───");
  allocator.constrainedBudget({ minWeight: 0.05, maxWeight: 0.30, maxLeverage: 1.5 });
  console.log(allocator.formatBudget());

  // 6. Dynamic budget
  console.log("\n── Dynamic Budget (recent performance adjusted) ──────");
  const dynamicAlloc = allocator.dynamicBudget(returnData, 30);
  console.log(allocator.formatBudget());
  console.log("\nAdjustments:");
  for (const a of dynamicAlloc) {
    const adj = a.adjustment != null ? a.adjustment.toFixed(3) : "n/a";
    const dd = a.drawdown != null ? (a.drawdown * 100).toFixed(2) + "%" : "n/a";
    const rs = a.recentSharpe != null ? a.recentSharpe : "n/a";
    console.log(`  ${a.name.padEnd(8)} adj=${adj}  dd=${dd}  recentSharpe=${rs}`);
  }

  // 7. Budget utilization
  console.log("\n── Budget Utilization ────────────────────────────────");
  const util = allocator.getBudgetUtilization();
  console.log(`  Total budget:    ${(util.totalRiskBudget * 100).toFixed(2)}%`);
  console.log(`  Allocated:       ${(util.totalAllocated * 100).toFixed(2)}%`);
  console.log(`  Utilization:     ${util.utilizationPct}%`);
  console.log(`  Remaining:       ${(util.remaining * 100).toFixed(2)}%`);

  // 8. Risk contribution & decomposition
  console.log("\n── Risk Contribution Analysis ────────────────────────");
  const allReturns = symbols.map((s) => returnData[s]);
  const minLen = Math.min(...allReturns.map((r) => r.length));
  const trimmed = allReturns.map((r) => r.slice(0, minLen));
  const cov = covarianceMatrix(trimmed);
  const weights = strategies.map((_, i) => (dynamicAlloc[i]?.weight || 1 / strategies.length));
  const rc = computeRiskContribution(weights, cov);
  console.log(`  Portfolio vol: ${(rc.portfolioVol * Math.sqrt(252) * 100).toFixed(2)}% annualized`);
  console.log("\n  " + "Strategy".padEnd(10) + "MRC".padStart(10) + "RC".padStart(10) + "% Contrib".padStart(12));
  for (let i = 0; i < strategies.length; i++) {
    console.log(
      "  " +
        strategies[i].name.padEnd(10) +
        rc.marginalContributions[i].toFixed(5).padStart(10) +
        rc.riskContributions[i].toFixed(5).padStart(10) +
        ((rc.pctContributions[i] * 100).toFixed(1) + "%").padStart(12)
    );
  }

  // 9. Risk decomposition
  console.log("\n── Risk Decomposition ───────────────────────────────");
  const decomp = riskDecomposition(weights, trimmed);
  console.log(`  Portfolio vol: ${(decomp.portfolioVol * Math.sqrt(252) * 100).toFixed(2)}% annualized`);
  for (const d of decomp.decomposition) {
    console.log(
      `  ${strategies[d.index].name.padEnd(8)}  systematic=${(d.systematicRisk * 100).toFixed(3)}%` +
        `  idiosyncratic=${(d.idiosyncraticRisk * 100).toFixed(3)}%` +
        `  total=${(d.pctOfTotal * 100).toFixed(1)}%`
    );
  }

  // 10. Breach detection
  console.log("\n── Breach Detection ─────────────────────────────────");
  const limits = [
    ...strategies.map((s) => ({
      name: s.name,
      maxRiskBudget: 0.04,
      maxWeight: 0.35,
      maxDrawdown: 0.15,
    })),
    { name: "__portfolio__", maxLeverage: 2.0 },
  ];
  const allocsForBreach = dynamicAlloc.map((a) => ({
    ...a,
    currentDrawdown: maxDrawdown(returnData[a.name].slice(-60)),
  }));
  const breaches = breachDetector(allocsForBreach, limits);
  if (breaches.length === 0) {
    console.log("  No breaches detected.");
  } else {
    for (const b of breaches) {
      console.log(
        `  [${b.severity}] ${b.name}: ${b.type} — value=${(b.value * 100).toFixed(2)}%` +
          ` limit=${(b.limit * 100).toFixed(2)}%`
      );
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Risk budget allocation complete.");
  console.log("═══════════════════════════════════════════════════════");
}

// ─── Entry ──────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) demo();
