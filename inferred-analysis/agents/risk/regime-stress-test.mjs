#!/usr/bin/env node
/**
 * Regime-Aware Stress Testing — Inferred Analysis
 *
 * Stress tests portfolios under different market regimes:
 * 1. Historical crisis replay (2008, 2020, taper tantrum, etc.)
 * 2. Hypothetical scenarios (rate shock, vol spike, correlation breakdown)
 * 3. Reverse stress test (find scenarios that break the portfolio)
 * 4. Conditional stress (regime-dependent worst cases)
 *
 * Usage:
 *   node agents/risk/regime-stress-test.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Historical crisis scenarios (daily shocks).
 */
export const CRISIS_SCENARIOS = {
  "GFC_2008": { SPY: -0.089, QQQ: -0.092, TLT: 0.035, GLD: 0.05, XLE: -0.12 },
  "COVID_Mar2020": { SPY: -0.12, QQQ: -0.10, TLT: 0.05, GLD: -0.03, XLE: -0.25 },
  "Flash_Crash_2010": { SPY: -0.086, QQQ: -0.079, TLT: 0.02, GLD: 0.008, XLE: -0.06 },
  "Taper_Tantrum_2013": { SPY: -0.015, QQQ: -0.02, TLT: -0.035, GLD: -0.06, XLE: -0.025 },
  "China_Deval_2015": { SPY: -0.04, QQQ: -0.045, TLT: 0.015, GLD: 0.02, XLE: -0.055 },
  "Vol_Spike_Feb2018": { SPY: -0.042, QQQ: -0.039, TLT: -0.005, GLD: -0.01, XLE: -0.035 },
  "Rate_Shock_2022": { SPY: -0.03, QQQ: -0.045, TLT: -0.04, GLD: -0.015, XLE: 0.02 },
};

/**
 * Hypothetical stress scenarios.
 */
export const HYPOTHETICAL_SCENARIOS = {
  "Rate_Up_200bps": { SPY: -0.05, QQQ: -0.07, TLT: -0.08, GLD: -0.02, XLE: 0.01 },
  "Vol_Spike_3x": { SPY: -0.08, QQQ: -0.10, TLT: 0.03, GLD: 0.04, XLE: -0.09 },
  "Correlation_1": { SPY: -0.06, QQQ: -0.06, TLT: -0.06, GLD: -0.06, XLE: -0.06 },
  "USD_Crash_10pct": { SPY: -0.02, QQQ: -0.03, TLT: -0.04, GLD: 0.10, XLE: 0.03 },
  "Oil_Spike_50pct": { SPY: -0.03, QQQ: -0.02, TLT: 0.01, GLD: 0.03, XLE: 0.15 },
  "Stagflation": { SPY: -0.04, QQQ: -0.05, TLT: -0.03, GLD: 0.06, XLE: 0.04 },
  "Deflation_Shock": { SPY: -0.06, QQQ: -0.05, TLT: 0.08, GLD: 0.02, XLE: -0.10 },
};

/**
 * Apply a stress scenario to portfolio weights.
 */
export function applyStress(weights, scenario, portfolioValue = 1_000_000) {
  let portfolioReturn = 0;
  const positionImpact = {};

  for (const [sym, weight] of Object.entries(weights)) {
    const shock = scenario[sym] || 0;
    const impact = weight * shock * portfolioValue;
    positionImpact[sym] = {
      weight,
      shock,
      dollarImpact: impact,
      pctContribution: weight * shock,
    };
    portfolioReturn += weight * shock;
  }

  return {
    portfolioReturn,
    portfolioLoss: -portfolioReturn * portfolioValue,
    positions: positionImpact,
  };
}

/**
 * Run all stress scenarios on a portfolio.
 */
export function stressTestSuite(weights, portfolioValue = 1_000_000) {
  const results = {};

  for (const [name, scenario] of Object.entries({ ...CRISIS_SCENARIOS, ...HYPOTHETICAL_SCENARIOS })) {
    results[name] = applyStress(weights, scenario, portfolioValue);
  }

  return results;
}

/**
 * Reverse stress test: find the scenario that causes a target loss.
 */
export function reverseStressTest(weights, targetLoss, priceArrays, nTrials = 10000) {
  const symbols = Object.keys(weights);
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));

  // Compute return distributions
  const returns = {};
  for (const sym of symbols) {
    returns[sym] = [];
    for (let i = 1; i < minLen; i++) {
      returns[sym].push((priceArrays[sym][i].close - priceArrays[sym][i - 1].close) / priceArrays[sym][i - 1].close);
    }
  }

  // Find historical scenarios that produce losses close to target
  const T = returns[symbols[0]].length;
  const matchingScenarios = [];

  for (let t = 0; t < T; t++) {
    let portRet = 0;
    const scenario = {};
    for (const sym of symbols) {
      scenario[sym] = returns[sym][t];
      portRet += weights[sym] * returns[sym][t];
    }
    if (portRet <= -targetLoss) {
      matchingScenarios.push({ date: priceArrays[symbols[0]][t + 1]?.date || `t=${t}`, portReturn: portRet, scenario });
    }
  }

  // Also generate random stressed scenarios
  const syntheticMatches = [];
  for (let trial = 0; trial < nTrials; trial++) {
    const scenario = {};
    let portRet = 0;
    for (const sym of symbols) {
      const r = returns[sym];
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      const std = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / r.length);
      // Draw from fat-tailed distribution
      const u = Math.random();
      const z = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
      scenario[sym] = mean + std * z * 2.5; // stressed
      portRet += weights[sym] * scenario[sym];
    }
    if (Math.abs(portRet + targetLoss) < targetLoss * 0.1) {
      syntheticMatches.push({ portReturn: portRet, scenario });
    }
  }

  return {
    historicalMatches: matchingScenarios.sort((a, b) => a.portReturn - b.portReturn),
    syntheticMatches: syntheticMatches.sort((a, b) => a.portReturn - b.portReturn).slice(0, 5),
    targetLoss,
  };
}

/**
 * Conditional stress: worst case given a specific regime.
 */
export function conditionalStress(weights, priceArrays, conditionFn) {
  const symbols = Object.keys(weights);
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));

  const condReturns = [];
  for (let t = 1; t < minLen; t++) {
    const dayData = {};
    for (const sym of symbols) {
      dayData[sym] = (priceArrays[sym][t].close - priceArrays[sym][t - 1].close) / priceArrays[sym][t - 1].close;
    }
    if (conditionFn(dayData, t)) {
      let portRet = 0;
      for (const sym of symbols) portRet += weights[sym] * dayData[sym];
      condReturns.push({ t, portReturn: portRet, returns: dayData });
    }
  }

  if (condReturns.length === 0) return null;

  const sorted = [...condReturns].sort((a, b) => a.portReturn - b.portReturn);
  const mean = condReturns.reduce((s, c) => s + c.portReturn, 0) / condReturns.length;
  const worst5pct = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.05)));

  return {
    nObservations: condReturns.length,
    meanReturn: mean,
    worstReturn: sorted[0].portReturn,
    var95: -sorted[Math.floor(sorted.length * 0.05)]?.portReturn || 0,
    worst5pctAvg: worst5pct.reduce((s, c) => s + c.portReturn, 0) / worst5pct.length,
    worstScenario: sorted[0].returns,
  };
}

/**
 * Format stress test report.
 */
export function formatStressReport(weights, portfolioValue = 1_000_000) {
  const results = stressTestSuite(weights, portfolioValue);
  const sorted = Object.entries(results).sort((a, b) => a[1].portfolioReturn - b[1].portfolioReturn);

  let out = `\n${"═".repeat(55)}\n  STRESS TEST REPORT\n  Portfolio: $${(portfolioValue / 1e6).toFixed(1)}M\n${"═".repeat(55)}\n\n`;
  out += `  Weights: ${Object.entries(weights).map(([s, w]) => `${s}=${(w * 100).toFixed(0)}%`).join(" ")}\n\n`;
  out += `  Scenario                   P&L ($)      Return\n`;
  out += `  ${"─".repeat(50)}\n`;

  for (const [name, result] of sorted) {
    const pnl = result.portfolioReturn * portfolioValue;
    const sign = pnl >= 0 ? "+" : "";
    out += `  ${name.padEnd(25)} ${sign}$${Math.abs(pnl).toFixed(0).padStart(8)}  ${sign}${(result.portfolioReturn * 100).toFixed(2)}%\n`;
  }

  // Summary
  const worstCase = sorted[0];
  const bestCase = sorted[sorted.length - 1];
  out += `\n  Worst case: ${worstCase[0]} (${(worstCase[1].portfolioReturn * 100).toFixed(2)}%)\n`;
  out += `  Best case:  ${bestCase[0]} (${(bestCase[1].portfolioReturn * 100).toFixed(2)}%)\n`;
  out += `\n${"═".repeat(55)}\n`;

  return out;
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Regime-Aware Stress Testing ═══\n");

  const weights = { SPY: 0.35, QQQ: 0.25, TLT: 0.20, GLD: 0.10, XLE: 0.10 };
  console.log(formatStressReport(weights));

  // Reverse stress test
  const symbols = Object.keys(weights);
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  console.log("─── Reverse Stress Test (5% loss) ───\n");
  const reverse = reverseStressTest(weights, 0.05, priceArrays);
  console.log(`  Historical scenarios causing 5%+ loss: ${reverse.historicalMatches.length}`);
  for (const match of reverse.historicalMatches.slice(0, 3)) {
    console.log(`    ${match.date}: ${(match.portReturn * 100).toFixed(2)}%`);
  }

  // Conditional stress: what happens on high-vol days?
  console.log("\n─── Conditional Stress: High Vol Days ───\n");
  const condResult = conditionalStress(weights, priceArrays, (dayData) => {
    const spyRet = dayData.SPY || 0;
    return Math.abs(spyRet) > 0.02;
  });
  if (condResult) {
    console.log(`  N observations: ${condResult.nObservations}`);
    console.log(`  Mean return:    ${(condResult.meanReturn * 100).toFixed(3)}%`);
    console.log(`  Worst return:   ${(condResult.worstReturn * 100).toFixed(3)}%`);
    console.log(`  VaR (95%):      ${(condResult.var95 * 100).toFixed(3)}%`);
  }
}

if (process.argv[1]?.includes("regime-stress-test")) {
  main().catch(console.error);
}
