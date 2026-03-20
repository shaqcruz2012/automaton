#!/usr/bin/env node
/**
 * Benchmark Comparison Engine — Inferred Analysis
 *
 * Compare portfolio/strategy performance against benchmarks:
 * 1. Multiple benchmark support (SPY, 60/40, risk-free)
 * 2. Alpha/beta decomposition
 * 3. Active return attribution
 * 4. Tracking error analysis
 * 5. Information ratio
 * 6. Up/down capture ratios
 * 7. Batting average (% periods outperforming)
 *
 * Usage:
 *   node agents/management/benchmark-comparison.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Compute benchmark comparison metrics.
 */
export function compareToBenchmark(portfolioReturns, benchmarkReturns, riskFreeRate = 0.04 / 252) {
  const n = Math.min(portfolioReturns.length, benchmarkReturns.length);
  const pr = portfolioReturns.slice(0, n);
  const br = benchmarkReturns.slice(0, n);

  // Means
  const pMean = pr.reduce((a, b) => a + b, 0) / n;
  const bMean = br.reduce((a, b) => a + b, 0) / n;

  // Beta
  let cov = 0, bVar = 0;
  for (let i = 0; i < n; i++) {
    cov += (pr[i] - pMean) * (br[i] - bMean);
    bVar += (br[i] - bMean) ** 2;
  }
  const beta = bVar > 0 ? cov / bVar : 1;
  const alpha = (pMean - riskFreeRate) - beta * (bMean - riskFreeRate);

  // Active returns
  const activeReturns = pr.map((r, i) => r - br[i]);
  const activeMean = activeReturns.reduce((a, b) => a + b, 0) / n;
  const activeStd = Math.sqrt(activeReturns.reduce((s, r) => s + (r - activeMean) ** 2, 0) / (n - 1));
  const trackingError = activeStd * Math.sqrt(252);
  const informationRatio = activeStd > 0 ? (activeMean / activeStd) * Math.sqrt(252) : 0;

  // Portfolio vol and Sharpe
  const pStd = Math.sqrt(pr.reduce((s, r) => s + (r - pMean) ** 2, 0) / (n - 1));
  const pSharpe = pStd > 0 ? ((pMean - riskFreeRate) / pStd) * Math.sqrt(252) : 0;
  const bStd = Math.sqrt(br.reduce((s, r) => s + (r - bMean) ** 2, 0) / (n - 1));
  const bSharpe = bStd > 0 ? ((bMean - riskFreeRate) / bStd) * Math.sqrt(252) : 0;

  // Up/Down capture
  let upPortSum = 0, upBenchSum = 0, upCount = 0;
  let downPortSum = 0, downBenchSum = 0, downCount = 0;
  for (let i = 0; i < n; i++) {
    if (br[i] > 0) { upPortSum += pr[i]; upBenchSum += br[i]; upCount++; }
    else if (br[i] < 0) { downPortSum += pr[i]; downBenchSum += br[i]; downCount++; }
  }
  const upCapture = upBenchSum !== 0 ? (upPortSum / upCount) / (upBenchSum / upCount) : 1;
  const downCapture = downBenchSum !== 0 ? (downPortSum / downCount) / (downBenchSum / downCount) : 1;

  // Batting average
  const periodsOutperforming = activeReturns.filter(r => r > 0).length;
  const battingAverage = periodsOutperforming / n;

  // R-squared
  const rSquared = bVar > 0 ? (cov / Math.sqrt(bVar * pr.reduce((s, r) => s + (r - pMean) ** 2, 0))) ** 2 : 0;

  // Drawdowns
  let pEquity = 1, pPeak = 1, pMaxDD = 0;
  let bEquity = 1, bPeak = 1, bMaxDD = 0;
  for (let i = 0; i < n; i++) {
    pEquity *= (1 + pr[i]); if (pEquity > pPeak) pPeak = pEquity;
    const pDD = (pPeak - pEquity) / pPeak; if (pDD > pMaxDD) pMaxDD = pDD;
    bEquity *= (1 + br[i]); if (bEquity > bPeak) bPeak = bEquity;
    const bDD = (bPeak - bEquity) / bPeak; if (bDD > bMaxDD) bMaxDD = bDD;
  }

  return {
    portfolio: {
      totalReturn: pEquity - 1,
      annualReturn: pMean * 252,
      annualVol: pStd * Math.sqrt(252),
      sharpe: pSharpe,
      maxDD: pMaxDD,
    },
    benchmark: {
      totalReturn: bEquity - 1,
      annualReturn: bMean * 252,
      annualVol: bStd * Math.sqrt(252),
      sharpe: bSharpe,
      maxDD: bMaxDD,
    },
    relative: {
      alpha: alpha * 252,
      beta,
      rSquared,
      trackingError,
      informationRatio,
      upCapture,
      downCapture,
      captureRatio: downCapture !== 0 ? upCapture / downCapture : Infinity,
      battingAverage,
      excessReturn: (pEquity - 1) - (bEquity - 1),
    },
  };
}

/**
 * Compare against multiple benchmarks.
 */
export function multiBenchmarkComparison(portfolioReturns, benchmarks) {
  const results = {};
  for (const [name, benchReturns] of Object.entries(benchmarks)) {
    results[name] = compareToBenchmark(portfolioReturns, benchReturns);
  }
  return results;
}

/**
 * Rolling performance comparison.
 */
export function rollingComparison(portfolioReturns, benchmarkReturns, window = 252) {
  const n = Math.min(portfolioReturns.length, benchmarkReturns.length);
  const series = [];

  for (let i = window; i <= n; i++) {
    const pr = portfolioReturns.slice(i - window, i);
    const br = benchmarkReturns.slice(i - window, i);

    const pMean = pr.reduce((a, b) => a + b, 0) / window;
    const bMean = br.reduce((a, b) => a + b, 0) / window;
    const active = pr.map((r, j) => r - br[j]);
    const activeMean = active.reduce((a, b) => a + b, 0) / window;
    const activeStd = Math.sqrt(active.reduce((s, r) => s + (r - activeMean) ** 2, 0) / (window - 1));

    series.push({
      period: i,
      rollingAlpha: pMean * 252 - bMean * 252,
      rollingIR: activeStd > 0 ? (activeMean / activeStd) * Math.sqrt(252) : 0,
      rollingBatting: active.filter(r => r > 0).length / window,
    });
  }

  return series;
}

/**
 * Format comparison report.
 */
export function formatComparisonReport(portfolioReturns, benchmarks) {
  const results = multiBenchmarkComparison(portfolioReturns, benchmarks);
  const w = 65;

  let out = `\n${"═".repeat(w)}\n  BENCHMARK COMPARISON REPORT\n${"═".repeat(w)}\n\n`;

  // Header
  out += `  ${"Metric".padEnd(22)}${"Portfolio".padStart(12)}`;
  for (const name of Object.keys(results)) {
    out += `${name.padStart(12)}`;
  }
  out += `\n  ${"─".repeat(w - 4)}\n`;

  // Absolute metrics
  const port = Object.values(results)[0]?.portfolio;
  if (!port) return "No data";

  const metrics = [
    ["Total Return", (v) => `${(v * 100).toFixed(1)}%`, "totalReturn"],
    ["Annual Return", (v) => `${(v * 100).toFixed(1)}%`, "annualReturn"],
    ["Annual Vol", (v) => `${(v * 100).toFixed(1)}%`, "annualVol"],
    ["Sharpe Ratio", (v) => v.toFixed(3), "sharpe"],
    ["Max Drawdown", (v) => `${(v * 100).toFixed(1)}%`, "maxDD"],
  ];

  for (const [label, fmt, key] of metrics) {
    out += `  ${label.padEnd(22)}${fmt(port[key]).padStart(12)}`;
    for (const r of Object.values(results)) {
      out += `${fmt(r.benchmark[key]).padStart(12)}`;
    }
    out += `\n`;
  }

  // Relative metrics
  out += `\n  ${"─── Relative ───".padEnd(w - 4)}\n`;
  for (const [name, r] of Object.entries(results)) {
    const rel = r.relative;
    out += `\n  vs ${name}:\n`;
    out += `    Alpha:            ${(rel.alpha * 100).toFixed(2)}%\n`;
    out += `    Beta:             ${rel.beta.toFixed(3)}\n`;
    out += `    R-squared:        ${rel.rSquared.toFixed(3)}\n`;
    out += `    Tracking Error:   ${(rel.trackingError * 100).toFixed(2)}%\n`;
    out += `    Information Ratio: ${rel.informationRatio.toFixed(3)}\n`;
    out += `    Up Capture:       ${(rel.upCapture * 100).toFixed(0)}%\n`;
    out += `    Down Capture:     ${(rel.downCapture * 100).toFixed(0)}%\n`;
    out += `    Batting Avg:      ${(rel.battingAverage * 100).toFixed(1)}%\n`;
  }

  out += `\n${"═".repeat(w)}\n`;
  return out;
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Benchmark Comparison Engine ═══\n");

  const spy = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  const qqq = generateRealisticPrices("QQQ", "2020-01-01", "2024-12-31");
  const tlt = generateRealisticPrices("TLT", "2020-01-01", "2024-12-31");
  const gld = generateRealisticPrices("GLD", "2020-01-01", "2024-12-31");

  const n = Math.min(spy.length, qqq.length, tlt.length, gld.length) - 1;

  // Portfolio: 40% SPY, 30% QQQ, 20% TLT, 10% GLD
  const portReturns = [];
  const spyReturns = [];
  const sixtyFortyReturns = [];

  for (let i = 1; i <= n; i++) {
    const sr = (spy[i].close - spy[i - 1].close) / spy[i - 1].close;
    const qr = (qqq[i].close - qqq[i - 1].close) / qqq[i - 1].close;
    const tr = (tlt[i].close - tlt[i - 1].close) / tlt[i - 1].close;
    const gr = (gld[i].close - gld[i - 1].close) / gld[i - 1].close;

    portReturns.push(0.4 * sr + 0.3 * qr + 0.2 * tr + 0.1 * gr);
    spyReturns.push(sr);
    sixtyFortyReturns.push(0.6 * sr + 0.4 * tr);
  }

  const benchmarks = {
    "SPY": spyReturns,
    "60/40": sixtyFortyReturns,
  };

  console.log(formatComparisonReport(portReturns, benchmarks));
}

if (process.argv[1]?.includes("benchmark-comparison")) {
  main().catch(console.error);
}
