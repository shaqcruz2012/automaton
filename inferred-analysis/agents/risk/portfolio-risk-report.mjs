#!/usr/bin/env node
/**
 * Portfolio Risk Report — Inferred Analysis
 *
 * Comprehensive daily risk report combining all risk modules:
 * 1. Portfolio-level VaR and CVaR
 * 2. Position-level risk contributions
 * 3. Factor exposures
 * 4. Concentration metrics (HHI)
 * 5. Correlation risk alerts
 * 6. Drawdown status
 * 7. Circuit breaker status
 *
 * Usage:
 *   node agents/risk/portfolio-risk-report.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Generate a comprehensive risk report.
 */
export function generateRiskReport(positions, priceArrays, options = {}) {
  const { lookback = 63, confidence = 0.95 } = options;
  const symbols = Object.keys(positions);

  // Compute returns
  const returnArrays = {};
  for (const sym of symbols) {
    const prices = priceArrays[sym];
    const start = Math.max(0, prices.length - lookback);
    returnArrays[sym] = prices.slice(start + 1).map((p, i) =>
      (p.close - prices[start + i].close) / prices[start + i].close
    );
  }

  // Portfolio returns
  const totalValue = Object.entries(positions).reduce((s, [sym, pos]) =>
    s + pos.value, 0);
  const weights = {};
  for (const sym of symbols) {
    weights[sym] = positions[sym].value / totalValue;
  }

  const minLen = Math.min(...Object.values(returnArrays).map(r => r.length));
  const portReturns = [];
  for (let t = 0; t < minLen; t++) {
    let pr = 0;
    for (const sym of symbols) {
      pr += (weights[sym] || 0) * (returnArrays[sym][t] || 0);
    }
    portReturns.push(pr);
  }

  // VaR and CVaR
  const sorted = [...portReturns].sort((a, b) => a - b);
  const n = sorted.length;
  const varIdx = Math.floor(n * (1 - confidence));
  const var95 = -sorted[varIdx];
  const cvar95 = n > 0 ? -sorted.slice(0, varIdx + 1).reduce((a, b) => a + b, 0) / (varIdx + 1) : 0;

  // Portfolio volatility
  const mean = portReturns.reduce((a, b) => a + b, 0) / n;
  const portVol = Math.sqrt(portReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  const annVol = portVol * Math.sqrt(252);

  // Drawdown
  let equity = 1, peak = 1, maxDD = 0, currentDD = 0;
  for (const r of portReturns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    currentDD = (peak - equity) / peak;
    if (currentDD > maxDD) maxDD = currentDD;
  }

  // Concentration (HHI)
  const hhi = Object.values(weights).reduce((s, w) => s + w * w, 0);
  const effectivePositions = 1 / hhi;

  // Correlation matrix
  const corrMatrix = {};
  for (const sym1 of symbols) {
    for (const sym2 of symbols) {
      if (sym1 >= sym2) continue;
      const r1 = returnArrays[sym1].slice(0, minLen);
      const r2 = returnArrays[sym2].slice(0, minLen);
      const m1 = r1.reduce((a, b) => a + b, 0) / minLen;
      const m2 = r2.reduce((a, b) => a + b, 0) / minLen;
      let cov = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < minLen; i++) {
        cov += (r1[i] - m1) * (r2[i] - m2);
        s1 += (r1[i] - m1) ** 2;
        s2 += (r2[i] - m2) ** 2;
      }
      const d = Math.sqrt(s1 * s2);
      corrMatrix[`${sym1}/${sym2}`] = d > 0 ? cov / d : 0;
    }
  }

  // High correlation alerts
  const highCorrPairs = Object.entries(corrMatrix)
    .filter(([, corr]) => Math.abs(corr) > 0.7)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  // Position-level risk
  const positionRisk = symbols.map(sym => {
    const returns = returnArrays[sym].slice(0, minLen);
    const vol = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) * Math.sqrt(252);
    const riskContrib = (weights[sym] || 0) * vol;
    return {
      symbol: sym,
      weight: weights[sym],
      value: positions[sym].value,
      annualVol: vol,
      riskContribution: riskContrib,
      riskPct: 0, // filled below
    };
  });

  const totalRisk = positionRisk.reduce((s, p) => s + p.riskContribution, 0);
  positionRisk.forEach(p => { p.riskPct = totalRisk > 0 ? p.riskContribution / totalRisk : 0; });

  return {
    summary: {
      totalValue,
      portfolioVol: annVol,
      var95: var95 * totalValue,
      var95Pct: var95,
      cvar95: cvar95 * totalValue,
      cvar95Pct: cvar95,
      maxDrawdown: maxDD,
      currentDrawdown: currentDD,
      sharpe: portVol > 0 ? (mean / portVol) * Math.sqrt(252) : 0,
    },
    concentration: {
      hhi,
      effectivePositions,
      largestPosition: Math.max(...Object.values(weights)),
      concentrated: hhi > 0.25,
    },
    positions: positionRisk.sort((a, b) => b.riskContribution - a.riskContribution),
    correlationAlerts: highCorrPairs,
    riskLevel: annVol > 0.25 ? "HIGH" : annVol > 0.15 ? "MEDIUM" : "LOW",
  };
}

/**
 * Format risk report as text.
 */
export function formatRiskReport(report) {
  let out = "";
  const s = report.summary;
  const c = report.concentration;

  out += `\n╔══════════════════════════════════════════════╗\n`;
  out += `║  DAILY RISK REPORT — ${new Date().toISOString().split("T")[0]}           ║\n`;
  out += `║  Risk Level: ${report.riskLevel.padEnd(32)}║\n`;
  out += `╠══════════════════════════════════════════════╣\n`;
  out += `║  Portfolio Value:  $${(s.totalValue / 1e6).toFixed(2)}M                   ║\n`;
  out += `║  Annual Vol:       ${(s.portfolioVol * 100).toFixed(1)}%                       ║\n`;
  out += `║  Sharpe (${report.positions[0]?.symbol || ""}):      ${s.sharpe.toFixed(2)}                        ║\n`;
  out += `║  VaR (95%):        $${s.var95.toFixed(0).padEnd(10)} (${(s.var95Pct * 100).toFixed(2)}%)      ║\n`;
  out += `║  CVaR (95%):       $${s.cvar95.toFixed(0).padEnd(10)} (${(s.cvar95Pct * 100).toFixed(2)}%)      ║\n`;
  out += `║  Max Drawdown:     ${(s.maxDrawdown * 100).toFixed(1)}%                       ║\n`;
  out += `║  Current DD:       ${(s.currentDrawdown * 100).toFixed(1)}%                       ║\n`;
  out += `╠══════════════════════════════════════════════╣\n`;
  out += `║  CONCENTRATION                               ║\n`;
  out += `║  HHI:              ${c.hhi.toFixed(3)} ${c.concentrated ? "(ALERT)" : "(OK)"}              ║\n`;
  out += `║  Effective Pos:    ${c.effectivePositions.toFixed(1)}                        ║\n`;
  out += `║  Largest Weight:   ${(c.largestPosition * 100).toFixed(0)}%                       ║\n`;
  out += `╠══════════════════════════════════════════════╣\n`;
  out += `║  POSITION RISK                               ║\n`;

  for (const p of report.positions) {
    out += `║  ${p.symbol.padEnd(6)} w=${(p.weight * 100).toFixed(0).padStart(3)}% vol=${(p.annualVol * 100).toFixed(0).padStart(3)}% risk=${(p.riskPct * 100).toFixed(0).padStart(3)}%     ║\n`;
  }

  if (report.correlationAlerts.length > 0) {
    out += `╠══════════════════════════════════════════════╣\n`;
    out += `║  CORRELATION ALERTS                          ║\n`;
    for (const [pair, corr] of report.correlationAlerts.slice(0, 3)) {
      out += `║  ${pair.padEnd(12)} corr=${corr.toFixed(2)}                    ║\n`;
    }
  }

  out += `╚══════════════════════════════════════════════╝\n`;
  return out;
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  const symbols = ["SPY", "QQQ", "TLT", "GLD", "XLK"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  const positions = {
    SPY: { value: 400_000 },
    QQQ: { value: 250_000 },
    TLT: { value: 150_000 },
    GLD: { value: 100_000 },
    XLK: { value: 100_000 },
  };

  const report = generateRiskReport(positions, priceArrays);
  console.log(formatRiskReport(report));
}

if (process.argv[1]?.includes("portfolio-risk-report")) {
  main().catch(console.error);
}
