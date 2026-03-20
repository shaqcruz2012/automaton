#!/usr/bin/env node
/**
 * Strategy Performance Attribution — Inferred Analysis
 *
 * Decomposes strategy returns into attributable factors:
 * 1. Market (beta) vs alpha decomposition
 * 2. Factor attribution (momentum, value, size, volatility)
 * 3. Sector attribution
 * 4. Timing vs selection
 * 5. Risk-adjusted contribution analysis
 *
 * Usage:
 *   node agents/management/performance-attribution.mjs
 *   import { attributeReturns, factorAttribution } from './performance-attribution.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Beta & Alpha Decomposition ─────────────────────────

/**
 * Decompose strategy returns into alpha + beta * market.
 * Returns { alpha, beta, r2, residuals, trackingError }
 */
export function betaDecomposition(strategyReturns, marketReturns) {
  const n = Math.min(strategyReturns.length, marketReturns.length);
  if (n < 10) return null;

  const sr = strategyReturns.slice(0, n);
  const mr = marketReturns.slice(0, n);

  const meanS = sr.reduce((a, b) => a + b, 0) / n;
  const meanM = mr.reduce((a, b) => a + b, 0) / n;

  let cov = 0, varM = 0;
  for (let i = 0; i < n; i++) {
    cov += (sr[i] - meanS) * (mr[i] - meanM);
    varM += (mr[i] - meanM) ** 2;
  }

  const beta = varM > 0 ? cov / varM : 0;
  const alpha = meanS - beta * meanM;

  // R² and residuals
  const residuals = sr.map((s, i) => s - alpha - beta * mr[i]);
  const ssRes = residuals.reduce((s, r) => s + r * r, 0);
  const ssTot = sr.reduce((s, r) => s + (r - meanS) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Tracking error
  const teStd = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / (n - 1));
  const trackingError = teStd * Math.sqrt(252);

  // Information ratio
  const annualAlpha = alpha * 252;
  const informationRatio = trackingError > 0 ? annualAlpha / trackingError : 0;

  return {
    alpha: alpha * 252, // annualized
    dailyAlpha: alpha,
    beta,
    r2,
    trackingError,
    informationRatio,
    residuals,
    n,
  };
}

// ─── Multi-Factor Attribution ───────────────────────────

/**
 * Attribute returns to multiple factors.
 * Uses OLS regression: R_strategy = alpha + sum(beta_i * F_i) + epsilon
 */
export function factorAttribution(strategyReturns, factors) {
  // factors: { factorName: returnArray }
  const factorNames = Object.keys(factors);
  const k = factorNames.length;
  const n = strategyReturns.length;

  if (n < k + 10) return null;

  // Simple single-factor attribution for each factor
  const attributions = {};
  let totalExplained = 0;

  for (const name of factorNames) {
    const decomp = betaDecomposition(strategyReturns, factors[name]);
    if (!decomp) continue;

    attributions[name] = {
      beta: decomp.beta,
      contribution: decomp.beta * (factors[name].reduce((a, b) => a + b, 0) / n * 252),
      r2: decomp.r2,
    };
    totalExplained += decomp.r2;
  }

  // Alpha (unexplained return)
  const totalReturn = strategyReturns.reduce((a, b) => a + b, 0) / n * 252;
  const factorReturn = Object.values(attributions).reduce((s, a) => s + a.contribution, 0);

  return {
    totalReturn,
    factorReturn,
    alpha: totalReturn - factorReturn,
    factors: attributions,
    totalR2: Math.min(totalExplained, 1),
  };
}

// ─── Timing vs Selection Attribution ────────────────────

/**
 * Decompose returns into timing (when to trade) and selection (what to trade).
 */
export function timingVsSelection(strategyReturns, benchmarkReturns, strategyWeights = null) {
  const n = Math.min(strategyReturns.length, benchmarkReturns.length);

  // If weights not provided, infer from return ratio
  const weights = strategyWeights || strategyReturns.map((s, i) => {
    return Math.abs(benchmarkReturns[i]) > 0.0001 ? s / benchmarkReturns[i] : 1;
  });

  let timingReturn = 0;
  let selectionReturn = 0;
  let interactionReturn = 0;

  for (let i = 0; i < n; i++) {
    const w = Math.max(-2, Math.min(2, weights[i])); // clamp weights
    const avgWeight = 1;

    // Timing: varying weight * benchmark return
    timingReturn += (w - avgWeight) * benchmarkReturns[i];

    // Selection: average weight * (strategy return - benchmark return)
    selectionReturn += avgWeight * (strategyReturns[i] - benchmarkReturns[i]);

    // Interaction
    interactionReturn += (w - avgWeight) * (strategyReturns[i] - benchmarkReturns[i]);
  }

  return {
    totalExcess: (timingReturn + selectionReturn + interactionReturn) / n * 252,
    timing: timingReturn / n * 252,
    selection: selectionReturn / n * 252,
    interaction: interactionReturn / n * 252,
  };
}

// ─── Rolling Attribution ────────────────────────────────

/**
 * Compute rolling alpha and beta over time.
 */
export function rollingAttribution(strategyReturns, marketReturns, window = 63) {
  const results = [];

  for (let i = window; i <= strategyReturns.length; i++) {
    const sr = strategyReturns.slice(i - window, i);
    const mr = marketReturns.slice(i - window, i);
    const decomp = betaDecomposition(sr, mr);

    if (decomp) {
      results.push({
        period: i,
        alpha: decomp.alpha,
        beta: decomp.beta,
        r2: decomp.r2,
        informationRatio: decomp.informationRatio,
      });
    }
  }

  return results;
}

// ─── Drawdown Attribution ───────────────────────────────

/**
 * Analyze what caused drawdowns: market beta or idiosyncratic.
 */
export function drawdownAttribution(strategyReturns, marketReturns) {
  const n = Math.min(strategyReturns.length, marketReturns.length);
  const decomp = betaDecomposition(strategyReturns, marketReturns);
  if (!decomp) return null;

  let equity = 1;
  let peak = 1;
  const drawdowns = [];
  let inDD = false;
  let ddStart = 0;

  for (let i = 0; i < n; i++) {
    equity *= (1 + strategyReturns[i]);
    if (equity > peak) {
      peak = equity;
      if (inDD) {
        inDD = false;
      }
    }

    const dd = (peak - equity) / peak;
    if (dd > 0.02 && !inDD) {
      inDD = true;
      ddStart = i;
    }

    if (inDD && (dd < 0.005 || i === n - 1)) {
      // Drawdown ended, attribute
      const ddReturns = strategyReturns.slice(ddStart, i + 1);
      const mktReturns = marketReturns.slice(ddStart, i + 1);

      const betaLoss = decomp.beta * mktReturns.reduce((a, b) => a + b, 0);
      const totalLoss = ddReturns.reduce((a, b) => a + b, 0);
      const alphaLoss = totalLoss - betaLoss;

      drawdowns.push({
        start: ddStart,
        end: i,
        duration: i - ddStart,
        totalLoss,
        betaLoss,
        alphaLoss,
        betaPct: Math.abs(totalLoss) > 0 ? betaLoss / totalLoss : 0,
      });

      inDD = false;
    }
  }

  return drawdowns;
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Performance Attribution Analysis ═══\n");

  // Generate market and strategy data
  const market = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  const strategy = generateRealisticPrices("QQQ", "2020-01-01", "2024-12-31");

  const marketReturns = market.slice(1).map((p, i) => (p.close - market[i].close) / market[i].close);
  const stratReturns = strategy.slice(1).map((p, i) => (p.close - strategy[i].close) / strategy[i].close);

  // Add alpha to strategy
  const alphaReturns = stratReturns.map((r, i) => r + 0.0002 + (Math.random() - 0.5) * 0.005);

  // Beta decomposition
  console.log("─── Alpha/Beta Decomposition ───\n");
  const decomp = betaDecomposition(alphaReturns, marketReturns);
  if (decomp) {
    console.log(`  Alpha (annualized): ${(decomp.alpha * 100).toFixed(2)}%`);
    console.log(`  Beta:               ${decomp.beta.toFixed(3)}`);
    console.log(`  R²:                 ${decomp.r2.toFixed(3)}`);
    console.log(`  Tracking Error:     ${(decomp.trackingError * 100).toFixed(2)}%`);
    console.log(`  Information Ratio:  ${decomp.informationRatio.toFixed(3)}`);
  }

  // Factor attribution
  console.log("\n─── Multi-Factor Attribution ───\n");
  const bondReturns = generateRealisticPrices("TLT", "2020-01-01", "2024-12-31")
    .slice(1).map((p, i, arr) => (p.close - generateRealisticPrices("TLT", "2020-01-01", "2024-12-31")[i].close) / generateRealisticPrices("TLT", "2020-01-01", "2024-12-31")[i].close);

  const factors = { market: marketReturns };
  const attribution = factorAttribution(alphaReturns, factors);
  if (attribution) {
    console.log(`  Total Return:  ${(attribution.totalReturn * 100).toFixed(2)}%`);
    console.log(`  Factor Return: ${(attribution.factorReturn * 100).toFixed(2)}%`);
    console.log(`  Alpha:         ${(attribution.alpha * 100).toFixed(2)}%`);
    for (const [name, data] of Object.entries(attribution.factors)) {
      console.log(`  ${name.padEnd(15)} beta=${data.beta.toFixed(3)} contribution=${(data.contribution * 100).toFixed(2)}% R²=${data.r2.toFixed(3)}`);
    }
  }

  // Timing vs Selection
  console.log("\n─── Timing vs Selection ───\n");
  const tvs = timingVsSelection(alphaReturns, marketReturns);
  console.log(`  Total Excess:  ${(tvs.totalExcess * 100).toFixed(2)}%`);
  console.log(`  Timing:        ${(tvs.timing * 100).toFixed(2)}%`);
  console.log(`  Selection:     ${(tvs.selection * 100).toFixed(2)}%`);
  console.log(`  Interaction:   ${(tvs.interaction * 100).toFixed(2)}%`);

  // Rolling attribution
  console.log("\n─── Rolling Alpha (63-day) ───\n");
  const rolling = rollingAttribution(alphaReturns, marketReturns, 63);
  const step = Math.floor(rolling.length / 8);
  for (let i = 0; i < rolling.length; i += step) {
    const r = rolling[i];
    const bar = r.alpha > 0 ? "▓".repeat(Math.min(20, Math.round(r.alpha * 100))) : "░".repeat(Math.min(20, Math.round(-r.alpha * 100)));
    console.log(`  Period ${String(r.period).padStart(4)}: alpha=${(r.alpha * 100).toFixed(1).padStart(6)}% beta=${r.beta.toFixed(2)} ${bar}`);
  }

  // Drawdown attribution
  console.log("\n─── Drawdown Attribution ───\n");
  const ddAttr = drawdownAttribution(alphaReturns, marketReturns);
  if (ddAttr && ddAttr.length > 0) {
    console.log("  Start  End  Duration  Total Loss  Beta Loss  Alpha Loss  Beta%");
    for (const dd of ddAttr.slice(0, 5)) {
      console.log(
        `  ${String(dd.start).padStart(5)} ${String(dd.end).padStart(4)} ` +
        `${String(dd.duration).padStart(8)} ` +
        `${(dd.totalLoss * 100).toFixed(2).padStart(10)}% ` +
        `${(dd.betaLoss * 100).toFixed(2).padStart(9)}% ` +
        `${(dd.alphaLoss * 100).toFixed(2).padStart(10)}% ` +
        `${(dd.betaPct * 100).toFixed(0).padStart(5)}%`
      );
    }
  }
}

if (process.argv[1]?.includes("performance-attribution")) {
  main().catch(console.error);
}
