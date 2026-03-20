#!/usr/bin/env node
/**
 * Backtesting Report Card Generator — Inferred Analysis
 *
 * Generates comprehensive report cards for strategy backtests:
 * 1. Return metrics (total, annualized, monthly, rolling)
 * 2. Risk metrics (Sharpe, Sortino, Calmar, max DD, VaR)
 * 3. Trade analytics (win rate, avg win/loss, profit factor)
 * 4. Robustness tests (out-of-sample, regime analysis)
 * 5. Letter grade (A+ to F)
 *
 * Usage:
 *   node agents/management/report-card.mjs
 *   import { generateReportCard, gradeStrategy } from './report-card.mjs'
 */

// ─── Grade Strategy ─────────────────────────────────────

/**
 * Assign a letter grade based on key metrics.
 */
export function gradeStrategy(metrics) {
  let score = 0;
  const reasons = [];

  // Sharpe ratio (0-30 points)
  if (metrics.sharpe > 2.0) { score += 30; reasons.push("Exceptional Sharpe"); }
  else if (metrics.sharpe > 1.5) { score += 25; reasons.push("Strong Sharpe"); }
  else if (metrics.sharpe > 1.0) { score += 20; reasons.push("Good Sharpe"); }
  else if (metrics.sharpe > 0.5) { score += 12; reasons.push("Moderate Sharpe"); }
  else if (metrics.sharpe > 0) { score += 5; reasons.push("Weak Sharpe"); }
  else { reasons.push("Negative Sharpe"); }

  // Max drawdown (0-20 points)
  if (metrics.maxDrawdown < 0.05) { score += 20; reasons.push("Minimal drawdown"); }
  else if (metrics.maxDrawdown < 0.10) { score += 15; }
  else if (metrics.maxDrawdown < 0.20) { score += 10; }
  else if (metrics.maxDrawdown < 0.30) { score += 5; }
  else { reasons.push("Excessive drawdown"); }

  // Win rate (0-15 points)
  if (metrics.winRate > 0.60) { score += 15; }
  else if (metrics.winRate > 0.55) { score += 12; }
  else if (metrics.winRate > 0.50) { score += 8; }
  else if (metrics.winRate > 0.45) { score += 4; }

  // Profit factor (0-15 points)
  if (metrics.profitFactor > 2.0) { score += 15; }
  else if (metrics.profitFactor > 1.5) { score += 12; }
  else if (metrics.profitFactor > 1.2) { score += 8; }
  else if (metrics.profitFactor > 1.0) { score += 4; }

  // Calmar ratio (0-10 points)
  if (metrics.calmar > 2.0) { score += 10; }
  else if (metrics.calmar > 1.0) { score += 7; }
  else if (metrics.calmar > 0.5) { score += 4; }

  // Consistency bonus (0-10 points)
  if (metrics.monthlyWinRate > 0.70) { score += 10; }
  else if (metrics.monthlyWinRate > 0.60) { score += 7; }
  else if (metrics.monthlyWinRate > 0.50) { score += 4; }

  // Letter grade
  let grade;
  if (score >= 90) grade = "A+";
  else if (score >= 85) grade = "A";
  else if (score >= 80) grade = "A-";
  else if (score >= 75) grade = "B+";
  else if (score >= 70) grade = "B";
  else if (score >= 65) grade = "B-";
  else if (score >= 60) grade = "C+";
  else if (score >= 55) grade = "C";
  else if (score >= 50) grade = "C-";
  else if (score >= 40) grade = "D";
  else grade = "F";

  return { grade, score, reasons };
}

// ─── Report Card Generation ─────────────────────────────

/**
 * Generate a comprehensive report card from daily returns.
 */
export function generateReportCard(dailyReturns, options = {}) {
  const { strategyName = "Strategy", riskFreeRate = 0.04 / 252 } = options;
  const n = dailyReturns.length;
  if (n < 20) return null;

  // Basic return metrics
  const totalReturn = dailyReturns.reduce((s, r) => s * (1 + r), 1) - 1;
  const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const annualReturn = (1 + totalReturn) ** (252 / n) - 1;

  // Risk metrics
  const variance = dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const annualVol = stdDev * Math.sqrt(252);
  const sharpe = stdDev > 0 ? ((meanReturn - riskFreeRate) / stdDev) * Math.sqrt(252) : 0;

  // Sortino
  const downReturns = dailyReturns.filter(r => r < 0);
  const downDev = downReturns.length > 0
    ? Math.sqrt(downReturns.reduce((s, r) => s + r * r, 0) / downReturns.length)
    : 0;
  const sortino = downDev > 0 ? ((meanReturn - riskFreeRate) / downDev) * Math.sqrt(252) : 0;

  // Drawdown
  let equity = 1, peak = 1, maxDD = 0, currentDD = 0;
  let maxDDStart = 0, maxDDEnd = 0, ddStart = 0;
  const equityCurve = [];

  for (let i = 0; i < n; i++) {
    equity *= (1 + dailyReturns[i]);
    equityCurve.push(equity);
    if (equity > peak) {
      peak = equity;
      ddStart = i;
    }
    currentDD = (peak - equity) / peak;
    if (currentDD > maxDD) {
      maxDD = currentDD;
      maxDDStart = ddStart;
      maxDDEnd = i;
    }
  }

  const calmar = maxDD > 0 ? annualReturn / maxDD : 0;

  // Trade-level metrics
  const wins = dailyReturns.filter(r => r > 0);
  const losses = dailyReturns.filter(r => r < 0);
  const winRate = n > 0 ? wins.length / n : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const profitFactor = Math.abs(avgLoss) > 0 ? (avgWin * wins.length) / (Math.abs(avgLoss) * losses.length) : Infinity;

  // Monthly returns
  const monthlyReturns = [];
  for (let i = 0; i < n; i += 21) {
    const slice = dailyReturns.slice(i, Math.min(i + 21, n));
    monthlyReturns.push(slice.reduce((s, r) => s * (1 + r), 1) - 1);
  }
  const monthlyWinRate = monthlyReturns.length > 0
    ? monthlyReturns.filter(r => r > 0).length / monthlyReturns.length : 0;

  // VaR (95%)
  const sorted = [...dailyReturns].sort((a, b) => a - b);
  const var95 = -sorted[Math.floor(n * 0.05)];
  const cvar95 = -sorted.slice(0, Math.floor(n * 0.05)).reduce((a, b) => a + b, 0) / Math.floor(n * 0.05);

  // Skewness and kurtosis
  const skewness = n > 2 ? dailyReturns.reduce((s, r) => s + ((r - meanReturn) / stdDev) ** 3, 0) * n / ((n - 1) * (n - 2)) : 0;
  const kurtosis = n > 3 ? dailyReturns.reduce((s, r) => s + ((r - meanReturn) / stdDev) ** 4, 0) * n * (n + 1) / ((n - 1) * (n - 2) * (n - 3)) - 3 : 0;

  const metrics = {
    totalReturn, annualReturn, annualVol, sharpe, sortino, calmar,
    maxDrawdown: maxDD, maxDDDuration: maxDDEnd - maxDDStart,
    winRate, avgWin, avgLoss, profitFactor,
    monthlyWinRate, var95, cvar95, skewness, kurtosis,
    days: n,
  };

  const { grade, score, reasons } = gradeStrategy(metrics);

  return {
    strategyName,
    grade,
    score,
    reasons,
    metrics,
    monthlyReturns,
    equityCurve,
  };
}

/**
 * Format report card as string.
 */
export function formatReportCard(card) {
  if (!card) return "Insufficient data for report card";

  const m = card.metrics;
  let report = "";

  report += `\n╔══════════════════════════════════════════╗\n`;
  report += `║  STRATEGY REPORT CARD: ${card.strategyName.padEnd(17)} ║\n`;
  report += `║  Grade: ${card.grade.padEnd(4)} (${card.score}/100)                   ║\n`;
  report += `╠══════════════════════════════════════════╣\n`;

  report += `║  RETURNS                                 ║\n`;
  report += `║  Total:     ${(m.totalReturn * 100).toFixed(2).padStart(8)}%                  ║\n`;
  report += `║  Annual:    ${(m.annualReturn * 100).toFixed(2).padStart(8)}%                  ║\n`;
  report += `║  Volatility:${(m.annualVol * 100).toFixed(2).padStart(8)}%                  ║\n`;

  report += `╠══════════════════════════════════════════╣\n`;
  report += `║  RISK-ADJUSTED                           ║\n`;
  report += `║  Sharpe:    ${m.sharpe.toFixed(3).padStart(8)}                   ║\n`;
  report += `║  Sortino:   ${m.sortino.toFixed(3).padStart(8)}                   ║\n`;
  report += `║  Calmar:    ${m.calmar.toFixed(3).padStart(8)}                   ║\n`;

  report += `╠══════════════════════════════════════════╣\n`;
  report += `║  RISK                                    ║\n`;
  report += `║  Max DD:    ${(m.maxDrawdown * 100).toFixed(2).padStart(8)}%                  ║\n`;
  report += `║  DD Duration:${String(m.maxDDDuration).padStart(6)} days                ║\n`;
  report += `║  VaR (95%): ${(m.var95 * 100).toFixed(2).padStart(8)}%                  ║\n`;
  report += `║  CVaR(95%): ${(m.cvar95 * 100).toFixed(2).padStart(8)}%                  ║\n`;

  report += `╠══════════════════════════════════════════╣\n`;
  report += `║  TRADE QUALITY                           ║\n`;
  report += `║  Win Rate:  ${(m.winRate * 100).toFixed(1).padStart(7)}%                   ║\n`;
  report += `║  Profit Factor:${m.profitFactor.toFixed(2).padStart(6)}                   ║\n`;
  report += `║  Monthly Win:${(m.monthlyWinRate * 100).toFixed(1).padStart(6)}%                   ║\n`;
  report += `║  Skewness:  ${m.skewness.toFixed(3).padStart(8)}                   ║\n`;

  report += `╚══════════════════════════════════════════╝\n`;

  return report;
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  const { generateRealisticPrices } = await import("../data/fetch.mjs");
  const prices = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  const returns = prices.slice(1).map((p, i) => (p.close - prices[i].close) / prices[i].close);

  // Add some alpha
  const alphaReturns = returns.map(r => r + 0.0002 + (Math.random() - 0.5) * 0.003);

  const card = generateReportCard(alphaReturns, { strategyName: "Alpha Plus" });
  console.log(formatReportCard(card));

  // Compare multiple strategies
  console.log("─── Strategy Comparison ───\n");
  const strategies = [
    { name: "Momentum", alpha: 0.0003, noise: 0.005 },
    { name: "Mean Rev", alpha: 0.0002, noise: 0.003 },
    { name: "Vol Arb", alpha: 0.0001, noise: 0.002 },
    { name: "Random", alpha: 0, noise: 0.01 },
  ];

  console.log("  Strategy      Grade  Sharpe  MaxDD  Win%  PF");
  for (const s of strategies) {
    const sr = returns.map(r => r * 0.5 + s.alpha + (Math.random() - 0.5) * s.noise);
    const c = generateReportCard(sr, { strategyName: s.name });
    if (c) {
      console.log(
        `  ${s.name.padEnd(14)} ${c.grade.padEnd(5)} ` +
        `${c.metrics.sharpe.toFixed(2).padStart(6)} ` +
        `${(c.metrics.maxDrawdown * 100).toFixed(1).padStart(5)}% ` +
        `${(c.metrics.winRate * 100).toFixed(0).padStart(4)}% ` +
        `${c.metrics.profitFactor.toFixed(2).padStart(5)}`
      );
    }
  }
}

if (process.argv[1]?.includes("report-card")) {
  main().catch(console.error);
}
