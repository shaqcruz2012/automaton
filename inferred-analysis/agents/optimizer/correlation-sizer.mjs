#!/usr/bin/env node
/**
 * Correlation-Adjusted Position Sizer — Inferred Analysis
 *
 * Adjusts position sizes based on portfolio correlation structure:
 * 1. Correlation penalty: reduce size when correlated with existing positions
 * 2. Diversification benefit: increase size when uncorrelated
 * 3. Dynamic correlation tracking with regime awareness
 * 4. Marginal risk contribution targeting
 *
 * Usage:
 *   node agents/optimizer/correlation-sizer.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Compute rolling correlation between two return series.
 */
function rollingCorrelation(returnsA, returnsB, window = 63) {
  const n = Math.min(returnsA.length, returnsB.length);
  if (n < window) return [];

  const result = [];
  for (let i = window; i <= n; i++) {
    const a = returnsA.slice(i - window, i);
    const b = returnsB.slice(i - window, i);
    const ma = a.reduce((s, x) => s + x, 0) / window;
    const mb = b.reduce((s, x) => s + x, 0) / window;
    let cov = 0, sa = 0, sb = 0;
    for (let j = 0; j < window; j++) {
      cov += (a[j] - ma) * (b[j] - mb);
      sa += (a[j] - ma) ** 2;
      sb += (b[j] - mb) ** 2;
    }
    const d = Math.sqrt(sa * sb);
    result.push(d > 0 ? cov / d : 0);
  }
  return result;
}

/**
 * Compute correlation matrix from return arrays.
 */
function correlationMatrix(returnArrays, symbols) {
  const n = symbols.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const corrs = rollingCorrelation(returnArrays[symbols[i]], returnArrays[symbols[j]], 63);
      const corr = corrs.length > 0 ? corrs[corrs.length - 1] : 0;
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }
  return matrix;
}

/**
 * Correlation-adjusted position sizer.
 */
export class CorrelationSizer {
  constructor(options = {}) {
    this.maxPositionSize = options.maxPositionSize || 0.25;
    this.correlationPenalty = options.correlationPenalty || 0.5;
    this.diversificationBonus = options.diversificationBonus || 0.3;
    this.lookback = options.lookback || 63;
    this.targetRisk = options.targetRisk || 0.01; // daily risk target
  }

  /**
   * Size a new position considering existing portfolio.
   */
  sizePosition(newSymbol, existingPositions, returnArrays, baseSize = 0.1) {
    const symbols = Object.keys(existingPositions);
    if (symbols.length === 0) return Math.min(baseSize, this.maxPositionSize);

    // Compute correlations with existing positions
    const correlations = symbols.map(sym => {
      const corrs = rollingCorrelation(
        returnArrays[newSymbol] || [],
        returnArrays[sym] || [],
        this.lookback
      );
      return { symbol: sym, correlation: corrs.length > 0 ? corrs[corrs.length - 1] : 0, weight: existingPositions[sym] };
    });

    // Weighted average correlation with portfolio
    const totalWeight = correlations.reduce((s, c) => s + Math.abs(c.weight), 0);
    const avgCorrelation = totalWeight > 0
      ? correlations.reduce((s, c) => s + Math.abs(c.weight) * c.correlation, 0) / totalWeight
      : 0;

    // Correlation adjustment
    let adjustmentFactor = 1;
    if (avgCorrelation > 0.5) {
      // High correlation: reduce size
      adjustmentFactor = 1 - this.correlationPenalty * (avgCorrelation - 0.5) / 0.5;
    } else if (avgCorrelation < 0.2) {
      // Low correlation: diversification bonus
      adjustmentFactor = 1 + this.diversificationBonus * (0.2 - avgCorrelation) / 0.2;
    }

    // Volatility scaling
    const returns = returnArrays[newSymbol] || [];
    const recentReturns = returns.slice(-this.lookback);
    let vol = 0;
    if (recentReturns.length > 1) {
      const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
      vol = Math.sqrt(recentReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (recentReturns.length - 1));
    }
    const volScalar = vol > 0 ? this.targetRisk / vol : 1;

    const rawSize = baseSize * adjustmentFactor * Math.min(2, volScalar);
    const finalSize = Math.max(0, Math.min(this.maxPositionSize, rawSize));

    return {
      size: finalSize,
      baseSize,
      adjustmentFactor,
      avgCorrelation,
      vol: vol * Math.sqrt(252),
      volScalar,
      correlations: correlations.map(c => ({ symbol: c.symbol, correlation: c.correlation.toFixed(3) })),
    };
  }

  /**
   * Optimally size an entire portfolio.
   */
  sizePortfolio(symbols, returnArrays, baseWeights = null) {
    const n = symbols.length;
    if (!baseWeights) baseWeights = Object.fromEntries(symbols.map(s => [s, 1 / n]));

    const corrMatrix = correlationMatrix(returnArrays, symbols);
    const vols = symbols.map(sym => {
      const r = (returnArrays[sym] || []).slice(-this.lookback);
      if (r.length < 2) return 0.15 / Math.sqrt(252);
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      return Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1));
    });

    // Iterative adjustment
    const weights = symbols.map(s => baseWeights[s] || 1 / n);
    for (let iter = 0; iter < 10; iter++) {
      for (let i = 0; i < n; i++) {
        // Marginal risk contribution
        let margRisk = 0;
        for (let j = 0; j < n; j++) {
          margRisk += weights[j] * corrMatrix[i][j] * vols[i] * vols[j];
        }

        // Target: equal risk contribution
        const totalRisk = weights.reduce((s, w, k) => {
          let r = 0;
          for (let j = 0; j < n; j++) r += weights[j] * corrMatrix[k][j] * vols[k] * vols[j];
          return s + w * r;
        }, 0);

        const targetContrib = totalRisk / n;
        const currentContrib = weights[i] * margRisk;

        if (currentContrib > 0) {
          weights[i] *= Math.sqrt(targetContrib / currentContrib);
        }
      }

      // Normalize
      const sumW = weights.reduce((a, b) => a + Math.abs(b), 0);
      if (sumW > 0) weights.forEach((_, i) => { weights[i] /= sumW; });
    }

    // Clamp
    weights.forEach((w, i) => { weights[i] = Math.max(0, Math.min(this.maxPositionSize, w)); });
    const sumFinal = weights.reduce((a, b) => a + b, 0);
    if (sumFinal > 0) weights.forEach((_, i) => { weights[i] /= sumFinal; });

    return Object.fromEntries(symbols.map((s, i) => [s, weights[i]]));
  }

  /**
   * Compute diversification ratio.
   */
  diversificationRatio(weights, returnArrays, symbols) {
    const n = symbols.length;
    const vols = symbols.map(sym => {
      const r = (returnArrays[sym] || []).slice(-this.lookback);
      if (r.length < 2) return 0;
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      return Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1));
    });

    const weightedVolSum = symbols.reduce((s, sym, i) => s + (weights[sym] || 0) * vols[i], 0);

    // Portfolio vol
    const corrMatrix = correlationMatrix(returnArrays, symbols);
    let portVar = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        portVar += (weights[symbols[i]] || 0) * (weights[symbols[j]] || 0) * vols[i] * vols[j] * corrMatrix[i][j];
      }
    }
    const portVol = Math.sqrt(Math.max(0, portVar));

    return portVol > 0 ? weightedVolSum / portVol : 1;
  }

  formatReport(symbols, returnArrays) {
    const optimized = this.sizePortfolio(symbols, returnArrays);
    const equalWeight = Object.fromEntries(symbols.map(s => [s, 1 / symbols.length]));
    const drOptimized = this.diversificationRatio(optimized, returnArrays, symbols);
    const drEqual = this.diversificationRatio(equalWeight, returnArrays, symbols);

    let out = `\n${"═".repeat(50)}\n  CORRELATION-ADJUSTED POSITION SIZING\n${"═".repeat(50)}\n\n`;
    out += `  Symbol    Equal    Optimized   Change\n  ${"─".repeat(45)}\n`;
    for (const sym of symbols) {
      const eq = (1 / symbols.length * 100).toFixed(1);
      const opt = (optimized[sym] * 100).toFixed(1);
      const change = ((optimized[sym] - 1 / symbols.length) * 100).toFixed(1);
      out += `  ${sym.padEnd(8)} ${eq.padStart(6)}%  ${opt.padStart(8)}%  ${(change >= 0 ? "+" : "") + change}%\n`;
    }
    out += `\n  Diversification Ratio:\n`;
    out += `    Equal weight: ${drEqual.toFixed(3)}\n`;
    out += `    Optimized:    ${drOptimized.toFixed(3)}\n`;
    out += `\n${"═".repeat(50)}\n`;
    return out;
  }
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Correlation-Adjusted Position Sizer ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD", "XLE", "XLF"];
  const priceArrays = {};
  const returnArrays = {};

  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
    returnArrays[sym] = [];
    for (let i = 1; i < priceArrays[sym].length; i++) {
      returnArrays[sym].push((priceArrays[sym][i].close - priceArrays[sym][i - 1].close) / priceArrays[sym][i - 1].close);
    }
  }

  const sizer = new CorrelationSizer({ maxPositionSize: 0.30, targetRisk: 0.01 });
  console.log(sizer.formatReport(symbols, returnArrays));

  // Size individual position
  console.log("─── Sizing GLD vs existing portfolio ───\n");
  const existing = { SPY: 0.3, QQQ: 0.25, TLT: 0.2 };
  const result = sizer.sizePosition("GLD", existing, returnArrays, 0.15);
  console.log(`  Base size:        ${(result.baseSize * 100).toFixed(1)}%`);
  console.log(`  Adj. factor:      ${result.adjustmentFactor.toFixed(3)}`);
  console.log(`  Avg correlation:  ${result.avgCorrelation.toFixed(3)}`);
  console.log(`  Final size:       ${(result.size * 100).toFixed(1)}%`);
}

if (process.argv[1]?.includes("correlation-sizer")) {
  main().catch(console.error);
}
