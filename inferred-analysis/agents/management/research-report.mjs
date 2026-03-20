#!/usr/bin/env node
/**
 * Automated Research Report Generator — Inferred Analysis
 *
 * Generates structured research reports from experiment results:
 * - Strategy performance summaries
 * - Statistical significance tests
 * - Risk analysis
 * - Recommendations
 *
 * Usage:
 *   node agents/management/research-report.mjs
 *   node agents/management/research-report.mjs --format markdown
 *   node agents/management/research-report.mjs --output reports/latest.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─── Data Collection ────────────────────────────────────

function loadExperimentResults() {
  const resultsPath = join(ROOT, "agents", "results.tsv");
  if (!existsSync(resultsPath)) return [];

  const lines = readFileSync(resultsPath, "utf-8").trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t");
  return lines.slice(1).map(line => {
    const values = line.split("\t");
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ""; });
    // Parse numeric fields
    for (const key of ["sharpe", "sortino", "calmar", "total_return", "max_drawdown", "win_rate", "trades"]) {
      if (row[key]) row[key] = parseFloat(row[key]);
    }
    return row;
  }).filter(r => r.agent);
}

function loadStrategyFiles() {
  const strategiesDir = join(ROOT, "agents", "strategies");
  const strategies = [];
  try {
    const { readdirSync } = await import("fs");
    const files = readdirSync(strategiesDir);
    for (const f of files) {
      if (f.endsWith(".js") || f.endsWith(".mjs")) {
        strategies.push(f);
      }
    }
  } catch { /* no strategies dir */ }
  return strategies;
}

// ─── Statistical Analysis ───────────────────────────────

function computeStats(values) {
  const n = values.length;
  if (n === 0) return { mean: 0, median: 0, std: 0, min: 0, max: 0, n: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const std = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;

  return {
    mean, median, std,
    min: sorted[0],
    max: sorted[n - 1],
    n,
    q25: sorted[Math.floor(n * 0.25)],
    q75: sorted[Math.floor(n * 0.75)],
    skew: n > 2 && std > 0 ? values.reduce((s, v) => s + ((v - mean) / std) ** 3, 0) * n / ((n - 1) * (n - 2)) : 0,
  };
}

/**
 * T-test: is the mean Sharpe significantly different from 0?
 */
function tTest(values) {
  const stats = computeStats(values);
  if (stats.n < 3 || stats.std === 0) return { tStat: 0, pValue: 1, significant: false };

  const tStat = stats.mean / (stats.std / Math.sqrt(stats.n));
  // Approximate p-value using normal distribution for large n
  const pValue = 2 * (1 - normalCDF(Math.abs(tStat)));

  return {
    tStat,
    pValue,
    significant: pValue < 0.05,
    n: stats.n,
    degreesOfFreedom: stats.n - 1,
  };
}

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

// ─── Report Generation ──────────────────────────────────

function generateReport(results, format = "markdown") {
  const timestamp = new Date().toISOString();
  const kept = results.filter(r => r.verdict === "keep");
  const discarded = results.filter(r => r.verdict === "discard");
  const crashed = results.filter(r => r.verdict === "crash");

  // Group by agent
  const byAgent = {};
  for (const r of results) {
    if (!byAgent[r.agent]) byAgent[r.agent] = [];
    byAgent[r.agent].push(r);
  }

  // Overall stats
  const allSharpes = results.filter(r => !isNaN(r.sharpe)).map(r => r.sharpe);
  const keptSharpes = kept.filter(r => !isNaN(r.sharpe)).map(r => r.sharpe);
  const overallStats = computeStats(allSharpes);
  const keptStats = computeStats(keptSharpes);
  const sharpeTest = tTest(allSharpes);

  let report = "";

  if (format === "markdown") {
    report += `# Inferred Analysis — Research Report\n\n`;
    report += `**Generated**: ${timestamp}\n\n`;
    report += `---\n\n`;

    // Executive Summary
    report += `## Executive Summary\n\n`;
    report += `- **Total experiments**: ${results.length}\n`;
    report += `- **Kept**: ${kept.length} (${(kept.length / Math.max(results.length, 1) * 100).toFixed(0)}%)\n`;
    report += `- **Discarded**: ${discarded.length}\n`;
    report += `- **Crashed**: ${crashed.length}\n`;
    report += `- **Active agents**: ${Object.keys(byAgent).length}\n\n`;

    // Performance Summary
    report += `## Performance Summary\n\n`;
    report += `| Metric | All Experiments | Kept Only |\n`;
    report += `|--------|----------------|----------|\n`;
    report += `| Mean Sharpe | ${overallStats.mean.toFixed(3)} | ${keptStats.mean.toFixed(3)} |\n`;
    report += `| Median Sharpe | ${overallStats.median.toFixed(3)} | ${keptStats.median.toFixed(3)} |\n`;
    report += `| Best Sharpe | ${overallStats.max.toFixed(3)} | ${keptStats.max.toFixed(3)} |\n`;
    report += `| Worst Sharpe | ${overallStats.min.toFixed(3)} | — |\n`;
    report += `| Std Dev | ${overallStats.std.toFixed(3)} | ${keptStats.std.toFixed(3)} |\n`;
    report += `| Skewness | ${overallStats.skew.toFixed(3)} | ${keptStats.skew.toFixed(3)} |\n\n`;

    // Statistical Significance
    report += `## Statistical Significance\n\n`;
    report += `- **T-statistic**: ${sharpeTest.tStat.toFixed(3)}\n`;
    report += `- **P-value**: ${sharpeTest.pValue.toFixed(4)}\n`;
    report += `- **Significant at 5%**: ${sharpeTest.significant ? "YES" : "NO"}\n`;
    report += `- **Degrees of freedom**: ${sharpeTest.degreesOfFreedom}\n\n`;

    if (!sharpeTest.significant) {
      report += `> **Warning**: Mean Sharpe is not statistically significant. Need more experiments or better strategies.\n\n`;
    }

    // Agent Leaderboard
    report += `## Agent Leaderboard\n\n`;
    report += `| Agent | Experiments | Kept | Best Sharpe | Avg Sharpe | Win Rate |\n`;
    report += `|-------|-------------|------|-------------|------------|----------|\n`;

    const agentSummaries = Object.entries(byAgent)
      .map(([agent, exps]) => {
        const sharpes = exps.filter(e => !isNaN(e.sharpe)).map(e => e.sharpe);
        const agentKept = exps.filter(e => e.verdict === "keep").length;
        return {
          agent,
          total: exps.length,
          kept: agentKept,
          bestSharpe: sharpes.length > 0 ? Math.max(...sharpes) : 0,
          avgSharpe: sharpes.length > 0 ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : 0,
          winRate: exps.length > 0 ? agentKept / exps.length : 0,
        };
      })
      .sort((a, b) => b.bestSharpe - a.bestSharpe);

    for (const a of agentSummaries) {
      report += `| ${a.agent} | ${a.total} | ${a.kept} | ${a.bestSharpe.toFixed(3)} | ${a.avgSharpe.toFixed(3)} | ${(a.winRate * 100).toFixed(0)}% |\n`;
    }
    report += `\n`;

    // Top Strategies
    if (kept.length > 0) {
      report += `## Top Strategies\n\n`;
      const topN = kept
        .filter(r => !isNaN(r.sharpe))
        .sort((a, b) => b.sharpe - a.sharpe)
        .slice(0, 5);

      for (let i = 0; i < topN.length; i++) {
        const s = topN[i];
        report += `### ${i + 1}. ${s.mutation || "unknown"} (${s.agent})\n\n`;
        report += `- Sharpe: **${s.sharpe.toFixed(4)}**\n`;
        if (s.total_return) report += `- Return: ${(s.total_return * 100).toFixed(2)}%\n`;
        if (s.max_drawdown) report += `- Max Drawdown: ${(s.max_drawdown * 100).toFixed(2)}%\n`;
        if (s.win_rate) report += `- Win Rate: ${(s.win_rate * 100).toFixed(1)}%\n`;
        if (s.trades) report += `- Trades: ${s.trades}\n`;
        report += `\n`;
      }
    }

    // Risk Analysis
    report += `## Risk Analysis\n\n`;
    const maxDDs = results.filter(r => !isNaN(r.max_drawdown)).map(r => r.max_drawdown);
    if (maxDDs.length > 0) {
      const ddStats = computeStats(maxDDs);
      report += `- **Mean Max Drawdown**: ${(ddStats.mean * 100).toFixed(1)}%\n`;
      report += `- **Worst Drawdown**: ${(ddStats.max * 100).toFixed(1)}%\n`;
      report += `- **Drawdown Std Dev**: ${(ddStats.std * 100).toFixed(1)}%\n\n`;
    }

    // Recommendations
    report += `## Recommendations\n\n`;
    if (keptStats.mean > 1.0) {
      report += `1. **Strong alpha detected** — Consider scaling capital to kept strategies\n`;
    } else if (keptStats.mean > 0.5) {
      report += `1. **Moderate alpha** — Continue experimentation, increase sample size\n`;
    } else {
      report += `1. **Weak alpha** — Refocus research on new signal sources\n`;
    }

    if (crashed.length > results.length * 0.2) {
      report += `2. **High crash rate** (${(crashed.length / results.length * 100).toFixed(0)}%) — Debug agent stability\n`;
    }

    if (!sharpeTest.significant) {
      report += `3. **Increase experiment count** — Need ${Math.ceil(4 / Math.max(overallStats.mean / overallStats.std, 0.1) ** 2)} experiments for significance\n`;
    }

    const bestAgent = agentSummaries[0];
    if (bestAgent) {
      report += `4. **Top performer**: ${bestAgent.agent} — Allocate more compute cycles\n`;
    }

    report += `\n---\n*Report generated by Inferred Analysis autoresearch system*\n`;
  } else {
    // Plain text format
    report += `INFERRED ANALYSIS RESEARCH REPORT\n`;
    report += `Generated: ${timestamp}\n`;
    report += `${"=".repeat(50)}\n\n`;
    report += `Experiments: ${results.length} (kept: ${kept.length}, discarded: ${discarded.length}, crashed: ${crashed.length})\n`;
    report += `Mean Sharpe: ${overallStats.mean.toFixed(3)} (kept: ${keptStats.mean.toFixed(3)})\n`;
    report += `Best Sharpe: ${overallStats.max.toFixed(3)}\n`;
    report += `Significant: ${sharpeTest.significant ? "YES" : "NO"} (p=${sharpeTest.pValue.toFixed(4)})\n`;
  }

  return report;
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "markdown";
  const outputIdx = args.indexOf("--output");

  const results = loadExperimentResults();
  console.log(`Loaded ${results.length} experiment results\n`);

  const report = generateReport(results, format);

  if (outputIdx >= 0 && args[outputIdx + 1]) {
    const outPath = join(ROOT, args[outputIdx + 1]);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, report);
    console.log(`Report written to: ${outPath}`);
  } else {
    console.log(report);
  }
}

main().catch(console.error);
