#!/usr/bin/env node
/**
 * Dispersion Trading Strategy — Inferred Analysis
 *
 * Trades the spread between index vol and constituent vol:
 * 1. Implied correlation from index vs constituent vols
 * 2. Dispersion signal: when correlation is "too high" or "too low"
 * 3. Cross-sectional vol analysis
 * 4. Sector dispersion tracking
 *
 * Usage:
 *   node agents/strategies/dispersion-trade.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Compute realized dispersion: cross-sectional standard deviation of returns.
 */
export function realizedDispersion(priceArrays, window = 21) {
  const symbols = Object.keys(priceArrays);
  const minLen = Math.min(...symbols.map(s => priceArrays[s].length));
  const result = [];

  for (let i = window; i < minLen; i++) {
    // Compute returns for each asset in window
    const returns = symbols.map(sym => {
      let cumRet = 0;
      for (let j = i - window + 1; j <= i; j++) {
        cumRet += (priceArrays[sym][j].close - priceArrays[sym][j - 1].close) / priceArrays[sym][j - 1].close;
      }
      return cumRet / window;
    });

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const dispersion = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);

    // Implied correlation: rho = 1 - (dispersion/indexVol)^2 (simplified)
    const indexReturns = [];
    for (let j = i - window + 1; j <= i; j++) {
      let indexRet = 0;
      for (const sym of symbols) {
        indexRet += (priceArrays[sym][j].close - priceArrays[sym][j - 1].close) / priceArrays[sym][j - 1].close;
      }
      indexReturns.push(indexRet / symbols.length);
    }
    const indexMean = indexReturns.reduce((a, b) => a + b, 0) / indexReturns.length;
    const indexVol = Math.sqrt(indexReturns.reduce((s, r) => s + (r - indexMean) ** 2, 0) / indexReturns.length);
    const avgConstitVol = dispersion; // cross-sectional vol

    const impliedCorr = indexVol > 0 && avgConstitVol > 0
      ? Math.max(-1, Math.min(1, 1 - (avgConstitVol / (indexVol * symbols.length)) ** 2))
      : 0;

    result.push({
      date: priceArrays[symbols[0]][i].date,
      dispersion: dispersion * Math.sqrt(252),
      indexVol: indexVol * Math.sqrt(252),
      impliedCorrelation: impliedCorr,
      numAssets: symbols.length,
    });
  }

  return result;
}

/**
 * Generate dispersion trading signals.
 * High correlation → sell correlation (buy dispersion)
 * Low correlation → buy correlation (sell dispersion)
 */
export function dispersionSignals(priceArrays, options = {}) {
  const { window = 21, highCorrThreshold = 0.7, lowCorrThreshold = 0.3 } = options;
  const dispData = realizedDispersion(priceArrays, window);
  const symbols = Object.keys(priceArrays);

  return dispData.map(d => {
    let signal = 0;
    let strategy = "flat";

    if (d.impliedCorrelation > highCorrThreshold) {
      // High correlation: expect dispersion to increase
      // Long constituents, short index → trade dispersion
      signal = 1;
      strategy = "long_dispersion";
    } else if (d.impliedCorrelation < lowCorrThreshold) {
      // Low correlation: expect convergence
      signal = -1;
      strategy = "short_dispersion";
    }

    return {
      date: d.date,
      signal,
      strategy,
      dispersion: d.dispersion,
      impliedCorrelation: d.impliedCorrelation,
      indexVol: d.indexVol,
    };
  });
}

/**
 * Sector-level dispersion analysis.
 */
export function sectorDispersion(priceArrays, sectorMap, window = 21) {
  // Group by sector
  const sectors = {};
  for (const [sym, sector] of Object.entries(sectorMap)) {
    if (!sectors[sector]) sectors[sector] = [];
    if (priceArrays[sym]) sectors[sector].push(sym);
  }

  const result = {};
  for (const [sector, syms] of Object.entries(sectors)) {
    if (syms.length < 2) continue;
    const sectorPrices = {};
    syms.forEach(s => { sectorPrices[s] = priceArrays[s]; });
    result[sector] = realizedDispersion(sectorPrices, window);
  }

  return result;
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Dispersion Trading Strategy ═══\n");

  const symbols = ["SPY", "QQQ", "XLK", "XLF", "XLE", "GLD"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  // Dispersion analysis
  const disp = realizedDispersion(priceArrays, 21);
  console.log("─── Dispersion Timeline ───\n");
  const step = Math.floor(disp.length / 10);
  for (let i = 0; i < disp.length; i += step) {
    const d = disp[i];
    const corrBar = "█".repeat(Math.round(Math.abs(d.impliedCorrelation) * 20));
    console.log(`  ${d.date}: disp=${(d.dispersion * 100).toFixed(1)}% corr=${d.impliedCorrelation.toFixed(2)} ${corrBar}`);
  }

  // Signals
  const signals = dispersionSignals(priceArrays);
  const longDisp = signals.filter(s => s.signal === 1).length;
  const shortDisp = signals.filter(s => s.signal === -1).length;
  console.log(`\n  Signals: Long dispersion=${longDisp}, Short dispersion=${shortDisp}, Flat=${signals.length - longDisp - shortDisp}`);

  // Sector dispersion
  console.log("\n─── Sector Dispersion ───\n");
  const sectorMap = { SPY: "Broad", QQQ: "Tech", XLK: "Tech", XLF: "Finance", XLE: "Energy", GLD: "Commodity" };
  const sectorDisp = sectorDispersion(priceArrays, sectorMap, 21);
  for (const [sector, data] of Object.entries(sectorDisp)) {
    if (data.length > 0) {
      const latest = data[data.length - 1];
      console.log(`  ${sector.padEnd(12)}: dispersion=${(latest.dispersion * 100).toFixed(1)}% corr=${latest.impliedCorrelation.toFixed(2)}`);
    }
  }
}

if (process.argv[1]?.includes("dispersion-trade")) {
  main().catch(console.error);
}
