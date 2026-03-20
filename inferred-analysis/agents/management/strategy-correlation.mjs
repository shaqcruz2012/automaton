#!/usr/bin/env node
/**
 * Strategy Correlation Monitor — Inferred Analysis
 *
 * Monitors correlations between strategies to detect:
 * 1. Diversification breakdown (rising correlations)
 * 2. Strategy crowding (all strategies moving together)
 * 3. Regime-dependent correlation shifts
 * 4. Optimal strategy combination weights
 *
 * Usage:
 *   node agents/management/strategy-correlation.mjs
 *   import { StrategyCorrelationMonitor } from './strategy-correlation.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Correlation Computation ────────────────────────────

function rollingCorrelation(returnsA, returnsB, window = 63) {
  const result = [];
  for (let i = window; i <= returnsA.length; i++) {
    const a = returnsA.slice(i - window, i);
    const b = returnsB.slice(i - window, i);
    result.push(pearson(a, b));
  }
  return result;
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    sx += (x[i] - mx) ** 2;
    sy += (y[i] - my) ** 2;
  }
  const d = Math.sqrt(sx * sy);
  return d > 0 ? cov / d : 0;
}

// ─── Strategy Correlation Monitor ───────────────────────

export class StrategyCorrelationMonitor {
  constructor(strategyReturns, names = null) {
    this.returns = strategyReturns; // { name: [dailyReturns] }
    this.names = names || Object.keys(strategyReturns);
  }

  /**
   * Get current correlation matrix.
   */
  getCorrelationMatrix(window = null) {
    const n = this.names.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const a = window ? this.returns[this.names[i]].slice(-window) : this.returns[this.names[i]];
        const b = window ? this.returns[this.names[j]].slice(-window) : this.returns[this.names[j]];
        const corr = pearson(a, b);
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }

    return matrix;
  }

  /**
   * Detect diversification breakdown.
   * Returns alert if average pairwise correlation exceeds threshold.
   */
  checkDiversification(window = 63, threshold = 0.5) {
    const matrix = this.getCorrelationMatrix(window);
    const n = this.names.length;
    let totalCorr = 0, pairs = 0;
    let maxCorr = -1, maxPair = [];

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        totalCorr += Math.abs(matrix[i][j]);
        pairs++;
        if (Math.abs(matrix[i][j]) > maxCorr) {
          maxCorr = Math.abs(matrix[i][j]);
          maxPair = [this.names[i], this.names[j]];
        }
      }
    }

    const avgCorr = pairs > 0 ? totalCorr / pairs : 0;

    return {
      avgAbsCorrelation: avgCorr,
      maxCorrelation: maxCorr,
      maxPair,
      diversified: avgCorr < threshold,
      alert: avgCorr > threshold ? `WARNING: Avg correlation ${avgCorr.toFixed(2)} > ${threshold}` : null,
    };
  }

  /**
   * Track correlation trend over time.
   */
  getCorrelationTrend(window = 63) {
    const n = this.names.length;
    const minLen = Math.min(...this.names.map(name => this.returns[name].length));
    const trend = [];

    for (let t = window; t <= minLen; t++) {
      let totalCorr = 0, pairs = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = this.returns[this.names[i]].slice(t - window, t);
          const b = this.returns[this.names[j]].slice(t - window, t);
          totalCorr += Math.abs(pearson(a, b));
          pairs++;
        }
      }
      trend.push({ period: t, avgCorr: pairs > 0 ? totalCorr / pairs : 0 });
    }

    return trend;
  }

  /**
   * Detect regime-dependent correlations.
   */
  getRegimeCorrelations(marketReturns, window = 63) {
    // Split into high-vol and low-vol periods
    const vols = [];
    for (let i = window; i < marketReturns.length; i++) {
      const slice = marketReturns.slice(i - window, i);
      const mean = slice.reduce((a, b) => a + b, 0) / window;
      vols.push(Math.sqrt(slice.reduce((s, r) => s + (r - mean) ** 2, 0) / window));
    }

    const medianVol = [...vols].sort((a, b) => a - b)[Math.floor(vols.length / 2)];

    const highVolCorrs = {};
    const lowVolCorrs = {};

    for (let i = 0; i < this.names.length; i++) {
      for (let j = i + 1; j < this.names.length; j++) {
        const pair = `${this.names[i]}/${this.names[j]}`;
        const highVolA = [], highVolB = [], lowVolA = [], lowVolB = [];

        for (let t = 0; t < vols.length; t++) {
          const idx = t + window;
          if (idx >= this.returns[this.names[i]].length) break;
          if (vols[t] > medianVol) {
            highVolA.push(this.returns[this.names[i]][idx]);
            highVolB.push(this.returns[this.names[j]][idx]);
          } else {
            lowVolA.push(this.returns[this.names[i]][idx]);
            lowVolB.push(this.returns[this.names[j]][idx]);
          }
        }

        highVolCorrs[pair] = highVolA.length > 10 ? pearson(highVolA, highVolB) : 0;
        lowVolCorrs[pair] = lowVolA.length > 10 ? pearson(lowVolA, lowVolB) : 0;
      }
    }

    return { highVol: highVolCorrs, lowVol: lowVolCorrs };
  }

  /**
   * ASCII correlation heatmap.
   */
  formatHeatmap(window = null) {
    const matrix = this.getCorrelationMatrix(window);
    const n = this.names.length;
    const blocks = [" ", "░", "▒", "▓", "█"];

    let output = "    " + this.names.map(n => n.slice(0, 6).padStart(7)).join("") + "\n";
    for (let i = 0; i < n; i++) {
      output += this.names[i].slice(0, 4).padEnd(4);
      for (let j = 0; j < n; j++) {
        const v = matrix[i][j];
        const idx = Math.min(4, Math.floor(Math.abs(v) * 5));
        const sign = v < 0 ? "-" : "+";
        output += ` ${sign}${v.toFixed(2)} `;
      }
      output += "\n";
    }
    return output;
  }
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Strategy Correlation Monitor ═══\n");

  // Generate correlated strategy returns
  const spy = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  const qqq = generateRealisticPrices("QQQ", "2020-01-01", "2024-12-31");
  const tlt = generateRealisticPrices("TLT", "2020-01-01", "2024-12-31");
  const gld = generateRealisticPrices("GLD", "2020-01-01", "2024-12-31");

  const n = Math.min(spy.length, qqq.length, tlt.length, gld.length) - 1;
  const returns = {
    Momentum: spy.slice(1, n + 1).map((p, i) => (p.close - spy[i].close) / spy[i].close + 0.0002),
    TechMom: qqq.slice(1, n + 1).map((p, i) => (p.close - qqq[i].close) / qqq[i].close + 0.0001),
    BondArb: tlt.slice(1, n + 1).map((p, i) => (p.close - tlt[i].close) / tlt[i].close),
    GoldHedge: gld.slice(1, n + 1).map((p, i) => (p.close - gld[i].close) / gld[i].close - 0.0001),
  };

  const monitor = new StrategyCorrelationMonitor(returns);

  // Heatmap
  console.log("─── Correlation Matrix (Full Period) ───\n");
  console.log(monitor.formatHeatmap());

  // Diversification check
  console.log("─── Diversification Check ───\n");
  const divCheck = monitor.checkDiversification(63, 0.4);
  console.log(`  Avg |correlation|: ${divCheck.avgAbsCorrelation.toFixed(3)}`);
  console.log(`  Max correlation:   ${divCheck.maxCorrelation.toFixed(3)} (${divCheck.maxPair.join("/")})`);
  console.log(`  Diversified:       ${divCheck.diversified ? "YES" : "NO"}`);
  if (divCheck.alert) console.log(`  ${divCheck.alert}`);

  // Correlation trend
  console.log("\n─── Correlation Trend ───\n");
  const trend = monitor.getCorrelationTrend(63);
  const step = Math.floor(trend.length / 8);
  for (let i = 0; i < trend.length; i += step) {
    const t = trend[i];
    const bar = "█".repeat(Math.round(t.avgCorr * 30));
    console.log(`  Period ${String(t.period).padStart(4)}: ${t.avgCorr.toFixed(3)} ${bar}`);
  }

  // Regime correlations
  console.log("\n─── Regime-Dependent Correlations ───\n");
  const marketRet = spy.slice(1, n + 1).map((p, i) => (p.close - spy[i].close) / spy[i].close);
  const regimeCorrs = monitor.getRegimeCorrelations(marketRet);
  console.log("  Pair              High Vol  Low Vol   Shift");
  for (const pair of Object.keys(regimeCorrs.highVol)) {
    const hv = regimeCorrs.highVol[pair];
    const lv = regimeCorrs.lowVol[pair];
    console.log(`  ${pair.padEnd(18)} ${hv.toFixed(3).padStart(8)} ${lv.toFixed(3).padStart(8)} ${(hv - lv).toFixed(3).padStart(8)}`);
  }
}

if (process.argv[1]?.includes("strategy-correlation")) {
  main().catch(console.error);
}
