#!/usr/bin/env node
/**
 * Drawdown Analyzer — Comprehensive Drawdown Decomposition & Risk Metrics
 *
 * Provides deep analysis of strategy drawdowns:
 *   - Drawdown identification: start, trough, recovery for each episode
 *   - Underwater equity curve
 *   - Drawdown duration analysis (time to trough + time to recovery)
 *   - Maximum drawdown statistics at various confidence levels
 *   - Conditional drawdown analysis: drawdowns during specific regimes
 *   - Recovery rate analysis: how fast does the strategy recover
 *   - Pain index: average drawdown over entire period
 *   - Ulcer index: RMS of drawdowns (penalizes depth and duration)
 *
 * No external dependencies. Pure ESM module.
 *
 * Usage:
 *   node agents/risk/drawdown-analyzer.mjs                 # Demo with synthetic returns
 *   node agents/risk/drawdown-analyzer.mjs --json          # JSON output
 *   node agents/risk/drawdown-analyzer.mjs --help
 *
 * Can also be imported:
 *   import { DrawdownAnalyzer, identifyDrawdowns, underwaterCurve, painIndex, ulcerIndex } from './drawdown-analyzer.mjs'
 */

// ─── Math Helpers ─────────────────────────────────────────

function cumProd(returns) {
  const eq = new Array(returns.length + 1);
  eq[0] = 1;
  for (let i = 0; i < returns.length; i++) {
    eq[i + 1] = eq[i] * (1 + returns[i]);
  }
  return eq;
}

function runningMax(arr) {
  const rm = new Array(arr.length);
  rm[0] = arr[0];
  for (let i = 1; i < arr.length; i++) {
    rm[i] = Math.max(rm[i - 1], arr[i]);
  }
  return rm;
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// ─── Core Drawdown Functions ──────────────────────────────

/**
 * Compute the underwater (drawdown) curve from a series of returns.
 * Each value is the fractional drawdown from the running peak (always <= 0).
 *
 * @param {number[]} returns - Array of periodic returns (e.g. daily)
 * @returns {{ drawdowns: number[], equity: number[], peaks: number[] }}
 */
export function underwaterCurve(returns) {
  const equity = cumProd(returns);
  const peaks = runningMax(equity);
  const drawdowns = equity.map((e, i) => (e - peaks[i]) / peaks[i]);
  return { drawdowns, equity, peaks };
}

/**
 * Identify discrete drawdown episodes from a return series.
 * Each episode records start, trough, and recovery indices plus magnitudes.
 *
 * @param {number[]} returns - Array of periodic returns
 * @param {object} [opts]
 * @param {number} [opts.threshold=0] - Minimum drawdown depth to report (e.g. 0.01 = 1%)
 * @returns {DrawdownEpisode[]}
 *
 * @typedef {object} DrawdownEpisode
 * @property {number} startIdx      - Index where equity first fell from peak
 * @property {number} troughIdx     - Index of maximum drawdown within episode
 * @property {number} recoveryIdx   - Index where equity recovered (null if unrecovered)
 * @property {number} depth         - Maximum drawdown depth (positive number, e.g. 0.10 = 10%)
 * @property {number} duration      - Total bars from start to recovery (or to end if unrecovered)
 * @property {number} timeToTrough  - Bars from start to trough
 * @property {number} timeToRecover - Bars from trough to recovery (null if unrecovered)
 * @property {number} peakEquity    - Equity level at episode start
 * @property {number} troughEquity  - Equity level at trough
 */
export function identifyDrawdowns(returns, opts = {}) {
  const threshold = opts.threshold || 0;
  const { drawdowns, equity, peaks } = underwaterCurve(returns);

  const episodes = [];
  let inDrawdown = false;
  let current = null;

  for (let i = 1; i < drawdowns.length; i++) {
    const dd = drawdowns[i]; // <= 0

    if (!inDrawdown && dd < 0) {
      // Start of a new drawdown episode
      inDrawdown = true;
      current = {
        startIdx: i - 1,
        troughIdx: i,
        recoveryIdx: null,
        depth: -dd,
        peakEquity: peaks[i],
        troughEquity: equity[i],
      };
    } else if (inDrawdown && dd < 0) {
      // Still in drawdown; check if deeper
      if (-dd > current.depth) {
        current.depth = -dd;
        current.troughIdx = i;
        current.troughEquity = equity[i];
      }
    } else if (inDrawdown && dd >= 0) {
      // Recovery
      current.recoveryIdx = i;
      current.duration = i - current.startIdx;
      current.timeToTrough = current.troughIdx - current.startIdx;
      current.timeToRecover = i - current.troughIdx;

      if (current.depth >= threshold) {
        episodes.push(current);
      }
      inDrawdown = false;
      current = null;
    }
  }

  // Handle unrecovered drawdown at end of series
  if (inDrawdown && current) {
    current.recoveryIdx = null;
    current.duration = drawdowns.length - 1 - current.startIdx;
    current.timeToTrough = current.troughIdx - current.startIdx;
    current.timeToRecover = null;
    if (current.depth >= threshold) {
      episodes.push(current);
    }
  }

  return episodes;
}

/**
 * Pain Index: the average drawdown over the entire observation period.
 * Measures the average "pain" an investor endures.
 *
 * @param {number[]} returns - Array of periodic returns
 * @returns {number} Pain index (positive number)
 */
export function painIndex(returns) {
  const { drawdowns } = underwaterCurve(returns);
  // Skip index 0 (always 0 by construction)
  if (drawdowns.length <= 1) return 0;
  const absDD = drawdowns.slice(1).map(d => Math.abs(d));
  return mean(absDD);
}

/**
 * Ulcer Index: root mean square of drawdowns.
 * Penalizes both depth and duration more heavily than Pain Index.
 * Developed by Peter Martin.
 *
 * @param {number[]} returns - Array of periodic returns
 * @returns {number} Ulcer index (positive number)
 */
export function ulcerIndex(returns) {
  const { drawdowns } = underwaterCurve(returns);
  if (drawdowns.length <= 1) return 0;
  // Drawdowns expressed as percentages (positive)
  const pctDD = drawdowns.slice(1).map(d => d * 100); // in % terms
  const sumSq = pctDD.reduce((s, v) => s + v * v, 0);
  return Math.sqrt(sumSq / pctDD.length) / 100; // back to fractional
}

// ─── DrawdownAnalyzer Class ───────────────────────────────

export class DrawdownAnalyzer {
  /**
   * @param {number[]} returns - Array of periodic returns
   * @param {object} [opts]
   * @param {string[]} [opts.dates]        - Optional date labels per return
   * @param {number[]} [opts.regimeLabels] - Optional regime index per return (e.g. 0=bull, 1=bear)
   * @param {string[]} [opts.regimeNames]  - Names for regime indices
   */
  constructor(returns, opts = {}) {
    this.returns = returns;
    this.dates = opts.dates || returns.map((_, i) => `t${i}`);
    this.regimeLabels = opts.regimeLabels || null;
    this.regimeNames = opts.regimeNames || null;

    const { drawdowns, equity, peaks } = underwaterCurve(returns);
    this.drawdowns = drawdowns;
    this.equity = equity;
    this.peaks = peaks;
  }

  // --- Drawdown Identification ---

  /**
   * Return all drawdown episodes.
   * @param {number} [threshold=0] - Minimum depth to include
   */
  getEpisodes(threshold = 0) {
    return identifyDrawdowns(this.returns, { threshold });
  }

  // --- Underwater Curve ---

  getUnderwaterCurve() {
    return {
      drawdowns: this.drawdowns,
      equity: this.equity,
      peaks: this.peaks,
    };
  }

  // --- Duration Analysis ---

  /**
   * Compute duration statistics across all drawdown episodes.
   * @param {number} [threshold=0]
   */
  durationAnalysis(threshold = 0) {
    const episodes = this.getEpisodes(threshold);
    if (episodes.length === 0) {
      return { count: 0, avgDuration: 0, maxDuration: 0, avgTimeToTrough: 0, avgTimeToRecover: 0 };
    }

    const durations = episodes.map(e => e.duration);
    const timesToTrough = episodes.map(e => e.timeToTrough);
    const timesToRecover = episodes.filter(e => e.timeToRecover !== null).map(e => e.timeToRecover);

    return {
      count: episodes.length,
      avgDuration: mean(durations),
      medianDuration: median(durations),
      maxDuration: Math.max(...durations),
      minDuration: Math.min(...durations),
      avgTimeToTrough: mean(timesToTrough),
      medianTimeToTrough: median(timesToTrough),
      avgTimeToRecover: timesToRecover.length > 0 ? mean(timesToRecover) : null,
      medianTimeToRecover: timesToRecover.length > 0 ? median(timesToRecover) : null,
      unrecoveredCount: episodes.filter(e => e.recoveryIdx === null).length,
    };
  }

  // --- Maximum Drawdown at Confidence Levels ---

  /**
   * Compute max drawdown statistics at various confidence levels.
   * Uses bootstrap resampling of drawdown depths from episodes.
   * Also computes conditional drawdown-at-risk (CDaR).
   *
   * @param {number[]} [confidenceLevels=[0.90, 0.95, 0.99]]
   */
  maxDrawdownStats(confidenceLevels = [0.90, 0.95, 0.99]) {
    const episodes = this.getEpisodes();
    const depths = episodes.map(e => e.depth).sort((a, b) => a - b);
    const maxDD = depths.length > 0 ? Math.max(...depths) : 0;
    const avgDD = mean(depths);

    // Drawdown-at-Risk (DaR) at confidence levels — percentile of drawdown depths
    const dar = {};
    for (const cl of confidenceLevels) {
      const pct = cl * 100;
      dar[cl] = depths.length > 0 ? percentile(depths, pct) : 0;
    }

    // Conditional DaR (CDaR) — average of drawdowns beyond DaR threshold
    const cdar = {};
    for (const cl of confidenceLevels) {
      const threshold = dar[cl];
      const tail = depths.filter(d => d >= threshold);
      cdar[cl] = tail.length > 0 ? mean(tail) : 0;
    }

    // Also compute from the continuous underwater curve for finer granularity
    const absDDs = this.drawdowns.slice(1).map(d => Math.abs(d)).sort((a, b) => a - b);
    const curveDaR = {};
    for (const cl of confidenceLevels) {
      curveDaR[cl] = absDDs.length > 0 ? percentile(absDDs, cl * 100) : 0;
    }

    return {
      maxDrawdown: maxDD,
      avgDrawdown: avgDD,
      episodeCount: depths.length,
      drawdownAtRisk: dar,
      conditionalDaR: cdar,
      curveBasedDaR: curveDaR,
    };
  }

  // --- Conditional Drawdown Analysis by Regime ---

  /**
   * Analyze drawdowns segmented by regime.
   * Requires regimeLabels to be set in constructor.
   */
  conditionalDrawdownAnalysis() {
    if (!this.regimeLabels) {
      return { error: "No regime labels provided" };
    }

    const uniqueRegimes = [...new Set(this.regimeLabels)];
    const results = {};

    for (const regime of uniqueRegimes) {
      const regimeName = this.regimeNames
        ? (this.regimeNames[regime] || `Regime ${regime}`)
        : `Regime ${regime}`;

      // Extract returns for this regime
      const regimeReturns = [];
      const regimeIndices = [];
      for (let i = 0; i < this.returns.length; i++) {
        if (this.regimeLabels[i] === regime) {
          regimeReturns.push(this.returns[i]);
          regimeIndices.push(i);
        }
      }

      // Compute drawdown stats within regime periods
      const { drawdowns: regimeDDs } = underwaterCurve(regimeReturns);
      const absDD = regimeDDs.slice(1).map(d => Math.abs(d));
      const maxDD = absDD.length > 0 ? Math.max(...absDD) : 0;
      const avgDD = mean(absDD);

      // Count how many full episodes overlap with this regime
      const allEpisodes = this.getEpisodes();
      let overlappingEpisodes = 0;
      for (const ep of allEpisodes) {
        const epRange = new Set();
        for (let j = ep.startIdx; j <= (ep.recoveryIdx ?? this.returns.length - 1); j++) {
          epRange.add(j);
        }
        const overlap = regimeIndices.some(idx => epRange.has(idx));
        if (overlap) overlappingEpisodes++;
      }

      results[regimeName] = {
        regime,
        periodCount: regimeReturns.length,
        maxDrawdown: maxDD,
        avgDrawdown: avgDD,
        painIndex: regimeReturns.length > 0 ? painIndex(regimeReturns) : 0,
        ulcerIndex: regimeReturns.length > 0 ? ulcerIndex(regimeReturns) : 0,
        overlappingEpisodes,
      };
    }

    return results;
  }

  // --- Recovery Rate Analysis ---

  /**
   * Analyze how quickly the strategy recovers from drawdowns.
   * Computes recovery rate (depth recovered per period) and recovery factor.
   */
  recoveryAnalysis(threshold = 0) {
    const episodes = this.getEpisodes(threshold);
    if (episodes.length === 0) {
      return { episodes: 0, recoveredCount: 0, avgRecoveryRate: 0, recoveryFactor: 0 };
    }

    const recovered = episodes.filter(e => e.recoveryIdx !== null);
    const recoveryRates = recovered.map(e => e.depth / e.timeToRecover); // depth per bar
    const totalReturn = this.equity[this.equity.length - 1] / this.equity[0] - 1;
    const maxDD = Math.max(...episodes.map(e => e.depth));

    // Recovery factor = total return / max drawdown
    const recoveryFactor = maxDD > 0 ? Math.abs(totalReturn) / maxDD : Infinity;

    // Speed classification
    const speedBuckets = { fast: 0, moderate: 0, slow: 0 };
    for (const ep of recovered) {
      const ratio = ep.timeToRecover / ep.timeToTrough;
      if (ratio <= 1) speedBuckets.fast++;
      else if (ratio <= 3) speedBuckets.moderate++;
      else speedBuckets.slow++;
    }

    return {
      totalEpisodes: episodes.length,
      recoveredCount: recovered.length,
      unrecoveredCount: episodes.length - recovered.length,
      avgRecoveryRate: recoveryRates.length > 0 ? mean(recoveryRates) : 0,
      medianRecoveryRate: recoveryRates.length > 0 ? median(recoveryRates) : 0,
      recoveryFactor,
      speedDistribution: speedBuckets,
      avgRecoveryToTroughRatio: recovered.length > 0
        ? mean(recovered.map(e => e.timeToRecover / Math.max(e.timeToTrough, 1)))
        : null,
    };
  }

  // --- Pain & Ulcer Indices ---

  getPainIndex() {
    return painIndex(this.returns);
  }

  getUlcerIndex() {
    return ulcerIndex(this.returns);
  }

  /**
   * Martin Ratio (Ulcer Performance Index): excess return / ulcer index.
   * @param {number} [riskFreeRate=0] - Annualized risk-free rate
   * @param {number} [periodsPerYear=252] - Trading periods per year
   */
  martinRatio(riskFreeRate = 0, periodsPerYear = 252) {
    const ui = this.getUlcerIndex();
    if (ui === 0) return Infinity;
    const annualReturn = mean(this.returns) * periodsPerYear;
    return (annualReturn - riskFreeRate) / ui;
  }

  /**
   * Pain Ratio: excess return / pain index.
   * @param {number} [riskFreeRate=0]
   * @param {number} [periodsPerYear=252]
   */
  painRatio(riskFreeRate = 0, periodsPerYear = 252) {
    const pi = this.getPainIndex();
    if (pi === 0) return Infinity;
    const annualReturn = mean(this.returns) * periodsPerYear;
    return (annualReturn - riskFreeRate) / pi;
  }

  // --- Full Report ---

  /**
   * Generate a comprehensive drawdown report.
   */
  fullReport() {
    const episodes = this.getEpisodes();
    const top5 = [...episodes].sort((a, b) => b.depth - a.depth).slice(0, 5);
    const durations = this.durationAnalysis();
    const maxDDStats = this.maxDrawdownStats();
    const recovery = this.recoveryAnalysis();
    const conditional = this.conditionalDrawdownAnalysis();

    return {
      summary: {
        totalReturns: this.returns.length,
        finalEquity: this.equity[this.equity.length - 1],
        totalReturn: this.equity[this.equity.length - 1] / this.equity[0] - 1,
        maxDrawdown: maxDDStats.maxDrawdown,
        painIndex: this.getPainIndex(),
        ulcerIndex: this.getUlcerIndex(),
        martinRatio: this.martinRatio(),
        painRatio: this.painRatio(),
      },
      episodes: {
        total: episodes.length,
        top5ByDepth: top5.map(e => ({
          startIdx: e.startIdx,
          startDate: this.dates[e.startIdx] || `t${e.startIdx}`,
          troughIdx: e.troughIdx,
          troughDate: this.dates[e.troughIdx] || `t${e.troughIdx}`,
          recoveryIdx: e.recoveryIdx,
          recoveryDate: e.recoveryIdx !== null ? (this.dates[e.recoveryIdx] || `t${e.recoveryIdx}`) : "N/A",
          depth: e.depth,
          duration: e.duration,
          timeToTrough: e.timeToTrough,
          timeToRecover: e.timeToRecover,
        })),
      },
      durations,
      maxDrawdownStats: maxDDStats,
      recovery,
      conditional,
    };
  }
}

// ─── CLI Demo ─────────────────────────────────────────────

function generateDemoReturns(n = 500, seed = 42) {
  // Simple seeded PRNG (mulberry32)
  let s = seed | 0;
  function rand() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }

  // Box-Muller for normal distribution
  function randn() {
    const u1 = rand();
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  const returns = [];
  const regimeLabels = [];
  let regime = 0; // 0 = bull, 1 = bear, 2 = sideways

  for (let i = 0; i < n; i++) {
    // Regime transitions
    if (rand() < 0.02) regime = Math.floor(rand() * 3);

    let mu, sigma;
    if (regime === 0) {       // Bull
      mu = 0.0005; sigma = 0.012;
    } else if (regime === 1) { // Bear
      mu = -0.001; sigma = 0.022;
    } else {                   // Sideways
      mu = 0.0001; sigma = 0.008;
    }

    returns.push(mu + sigma * randn());
    regimeLabels.push(regime);
  }

  return { returns, regimeLabels };
}

function formatPct(v, decimals = 2) {
  if (v === null || v === undefined) return "N/A";
  return (v * 100).toFixed(decimals) + "%";
}

function formatNum(v, decimals = 2) {
  if (v === null || v === undefined) return "N/A";
  return v.toFixed(decimals);
}

function padRight(s, len) {
  s = String(s);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padLeft(s, len) {
  s = String(s);
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function printTable(headers, rows, colWidths) {
  const sep = colWidths.map(w => "─".repeat(w)).join("─┼─");
  const headerLine = headers.map((h, i) => padRight(h, colWidths[i])).join(" │ ");

  console.log("  " + headerLine);
  console.log("  " + sep);

  for (const row of rows) {
    const line = row.map((cell, i) => {
      const s = String(cell);
      // Right-align numeric-looking cells
      return /^[\d\-.]/.test(s) || s === "N/A"
        ? padLeft(s, colWidths[i])
        : padRight(s, colWidths[i]);
    }).join(" │ ");
    console.log("  " + line);
  }
}

function runCLI() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Drawdown Analyzer — Comprehensive Drawdown Decomposition & Risk Metrics

Usage:
  node drawdown-analyzer.mjs               Run demo with synthetic strategy returns
  node drawdown-analyzer.mjs --json        Output full report as JSON
  node drawdown-analyzer.mjs --help        Show this help

Exported API:
  DrawdownAnalyzer    Class for full drawdown analysis
  identifyDrawdowns() Identify discrete drawdown episodes
  underwaterCurve()   Compute underwater equity curve
  painIndex()         Average drawdown over entire period
  ulcerIndex()        RMS of drawdowns (depth + duration penalty)
`);
    return;
  }

  const jsonMode = args.includes("--json");

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║          DRAWDOWN ANALYZER — Strategy Risk Report          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Generate demo data
  const { returns, regimeLabels } = generateDemoReturns(500);
  const regimeNames = { 0: "Bull", 1: "Bear", 2: "Sideways" };

  const analyzer = new DrawdownAnalyzer(returns, {
    regimeLabels,
    regimeNames,
  });

  const report = analyzer.fullReport();

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // --- Summary ---
  console.log("┌─ SUMMARY ────────────────────────────────────────────────────");
  console.log(`│  Periods analyzed:   ${report.summary.totalReturns}`);
  console.log(`│  Final equity:       ${formatNum(report.summary.finalEquity, 4)}`);
  console.log(`│  Total return:       ${formatPct(report.summary.totalReturn)}`);
  console.log(`│  Max drawdown:       ${formatPct(report.summary.maxDrawdown)}`);
  console.log(`│  Pain index:         ${formatPct(report.summary.painIndex)}`);
  console.log(`│  Ulcer index:        ${formatPct(report.summary.ulcerIndex)}`);
  console.log(`│  Martin ratio:       ${formatNum(report.summary.martinRatio)}`);
  console.log(`│  Pain ratio:         ${formatNum(report.summary.painRatio)}`);
  console.log("└──────────────────────────────────────────────────────────────\n");

  // --- Top 5 Drawdowns ---
  console.log("┌─ TOP 5 DRAWDOWN EPISODES ────────────────────────────────────");
  if (report.episodes.top5ByDepth.length > 0) {
    const headers = ["#", "Start", "Trough", "Recovery", "Depth", "Duration", "To Trough", "To Recover"];
    const widths = [3, 8, 8, 10, 8, 8, 9, 10];
    const rows = report.episodes.top5ByDepth.map((ep, i) => [
      i + 1,
      ep.startDate,
      ep.troughDate,
      ep.recoveryDate,
      formatPct(ep.depth),
      ep.duration,
      ep.timeToTrough,
      ep.timeToRecover !== null ? ep.timeToRecover : "N/A",
    ]);
    printTable(headers, rows, widths);
  } else {
    console.log("  No drawdown episodes detected.");
  }
  console.log("└──────────────────────────────────────────────────────────────\n");

  // --- Duration Analysis ---
  const dur = report.durations;
  console.log("┌─ DURATION ANALYSIS ──────────────────────────────────────────");
  console.log(`│  Total episodes:        ${dur.count}`);
  console.log(`│  Avg duration:          ${formatNum(dur.avgDuration)} bars`);
  console.log(`│  Median duration:       ${formatNum(dur.medianDuration)} bars`);
  console.log(`│  Max duration:          ${dur.maxDuration} bars`);
  console.log(`│  Min duration:          ${dur.minDuration} bars`);
  console.log(`│  Avg time to trough:    ${formatNum(dur.avgTimeToTrough)} bars`);
  console.log(`│  Median time to trough: ${formatNum(dur.medianTimeToTrough)} bars`);
  console.log(`│  Avg time to recover:   ${dur.avgTimeToRecover !== null ? formatNum(dur.avgTimeToRecover) + " bars" : "N/A"}`);
  console.log(`│  Unrecovered episodes:  ${dur.unrecoveredCount}`);
  console.log("└──────────────────────────────────────────────────────────────\n");

  // --- Max Drawdown at Confidence Levels ---
  const mds = report.maxDrawdownStats;
  console.log("┌─ DRAWDOWN RISK METRICS ──────────────────────────────────────");
  console.log(`│  Max drawdown:          ${formatPct(mds.maxDrawdown)}`);
  console.log(`│  Avg episode drawdown:  ${formatPct(mds.avgDrawdown)}`);
  console.log(`│  Episode count:         ${mds.episodeCount}`);
  console.log("│");
  console.log("│  Drawdown-at-Risk (DaR) by confidence level:");
  for (const [cl, val] of Object.entries(mds.drawdownAtRisk)) {
    console.log(`│    ${(parseFloat(cl) * 100).toFixed(0)}% DaR:  ${formatPct(val)}`);
  }
  console.log("│");
  console.log("│  Conditional DaR (CDaR) by confidence level:");
  for (const [cl, val] of Object.entries(mds.conditionalDaR)) {
    console.log(`│    ${(parseFloat(cl) * 100).toFixed(0)}% CDaR: ${formatPct(val)}`);
  }
  console.log("│");
  console.log("│  Curve-based DaR (continuous underwater curve):");
  for (const [cl, val] of Object.entries(mds.curveBasedDaR)) {
    console.log(`│    ${(parseFloat(cl) * 100).toFixed(0)}% DaR:  ${formatPct(val)}`);
  }
  console.log("└──────────────────────────────────────────────────────────────\n");

  // --- Recovery Analysis ---
  const rec = report.recovery;
  console.log("┌─ RECOVERY ANALYSIS ──────────────────────────────────────────");
  console.log(`│  Total episodes:        ${rec.totalEpisodes}`);
  console.log(`│  Recovered:             ${rec.recoveredCount}`);
  console.log(`│  Unrecovered:           ${rec.unrecoveredCount}`);
  console.log(`│  Recovery factor:       ${formatNum(rec.recoveryFactor)}`);
  console.log(`│  Avg recovery rate:     ${formatPct(rec.avgRecoveryRate)}/bar`);
  console.log(`│  Median recovery rate:  ${formatPct(rec.medianRecoveryRate)}/bar`);
  console.log(`│  Avg recovery/trough ratio: ${rec.avgRecoveryToTroughRatio !== null ? formatNum(rec.avgRecoveryToTroughRatio) : "N/A"}`);
  console.log("│");
  console.log("│  Recovery speed distribution:");
  console.log(`│    Fast (≤1x trough time):     ${rec.speedDistribution.fast}`);
  console.log(`│    Moderate (1-3x trough time): ${rec.speedDistribution.moderate}`);
  console.log(`│    Slow (>3x trough time):      ${rec.speedDistribution.slow}`);
  console.log("└──────────────────────────────────────────────────────────────\n");

  // --- Conditional Drawdown by Regime ---
  if (report.conditional && !report.conditional.error) {
    console.log("┌─ CONDITIONAL DRAWDOWN BY REGIME ─────────────────────────────");
    const headers = ["Regime", "Periods", "Max DD", "Avg DD", "Pain Idx", "Ulcer Idx", "Overlap Eps"];
    const widths = [10, 7, 8, 8, 9, 9, 11];
    const rows = Object.entries(report.conditional).map(([name, data]) => [
      name,
      data.periodCount,
      formatPct(data.maxDrawdown),
      formatPct(data.avgDrawdown),
      formatPct(data.painIndex),
      formatPct(data.ulcerIndex),
      data.overlappingEpisodes,
    ]);
    printTable(headers, rows, widths);
    console.log("└──────────────────────────────────────────────────────────────\n");
  }

  // --- Underwater Curve Sparkline ---
  console.log("┌─ UNDERWATER CURVE (ASCII) ────────────────────────────────────");
  const { drawdowns } = analyzer.getUnderwaterCurve();
  const ddSlice = drawdowns.slice(1); // skip initial 0
  const minDD = Math.min(...ddSlice);
  const maxDD = 0;
  const chartWidth = 60;
  const chartHeight = 10;
  const step = Math.max(1, Math.floor(ddSlice.length / chartWidth));

  // Sample drawdown curve
  const sampled = [];
  for (let i = 0; i < ddSlice.length; i += step) {
    sampled.push(ddSlice[i]);
  }

  // Render rows top to bottom
  for (let row = 0; row < chartHeight; row++) {
    const threshold = minDD + (maxDD - minDD) * (1 - row / (chartHeight - 1));
    let line = "│  ";
    const label = formatPct(threshold, 1);
    line += padLeft(label, 7) + " │";

    for (let col = 0; col < sampled.length && col < chartWidth; col++) {
      if (sampled[col] <= threshold) {
        line += "█";
      } else {
        line += " ";
      }
    }
    console.log(line);
  }
  console.log("│  " + padLeft("", 7) + " └" + "─".repeat(Math.min(sampled.length, chartWidth)));
  console.log("└──────────────────────────────────────────────────────────────\n");

  console.log(`  ✓ Analysis complete. ${report.episodes.total} drawdown episodes identified.\n`);
}

// ─── Entry Point ──────────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith("drawdown-analyzer.mjs") ||
  process.argv[1].endsWith("drawdown-analyzer")
);

if (isMain) {
  runCLI();
}
