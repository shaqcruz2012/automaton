#!/usr/bin/env node
/**
 * Volatility Targeting Overlay
 *
 * Scales portfolio exposure so that realized volatility tracks a fixed target.
 * Standard institutional risk overlay used by most systematic macro funds.
 *
 * Usage:
 *   node agents/optimizer/vol-targeting.mjs                # demo with SPY
 *   node agents/optimizer/vol-targeting.mjs --symbol QQQ   # different asset
 *   node agents/optimizer/vol-targeting.mjs --target 0.15   # 15% vol target
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Rolling Volatility Estimators ──────────────────────

/**
 * Compute rolling volatility using one of several estimators.
 * @param {number[]} returns - array of log returns
 * @param {number}   window  - lookback in periods
 * @param {'close_close'|'ewma'|'parkinson'|'yang_zhang'} method
 * @returns {number[]} rolling vol series (NaN-padded for warmup)
 */
export function rollingVol(returns, window = 21, method = "close_close") {
  const n = returns.length;
  const vol = new Array(n).fill(NaN);

  if (method === "close_close") {
    for (let i = window - 1; i < n; i++) {
      const slice = returns.slice(i - window + 1, i + 1);
      const mean = slice.reduce((s, v) => s + v, 0) / window;
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / (window - 1);
      vol[i] = Math.sqrt(variance) * Math.sqrt(252);
    }
  } else if (method === "ewma") {
    const lambda = 1 - 2 / (window + 1);
    let ewmaVar = 0;
    const mean = returns.slice(0, Math.min(window, n)).reduce((s, v) => s + v, 0) / Math.min(window, n);
    for (let i = 0; i < Math.min(window, n); i++) {
      ewmaVar += (returns[i] - mean) ** 2;
    }
    ewmaVar /= Math.min(window, n);
    for (let i = 0; i < n; i++) {
      ewmaVar = lambda * ewmaVar + (1 - lambda) * returns[i] ** 2;
      vol[i] = i >= window - 1 ? Math.sqrt(ewmaVar) * Math.sqrt(252) : NaN;
    }
  } else if (method === "parkinson") {
    // Parkinson uses high-low range; we approximate from returns
    const scale = 1 / (4 * Math.log(2));
    for (let i = window - 1; i < n; i++) {
      const slice = returns.slice(i - window + 1, i + 1);
      const variance = slice.reduce((s, r) => s + scale * (r * 2.5) ** 2, 0) / window;
      vol[i] = Math.sqrt(variance) * Math.sqrt(252);
    }
  } else if (method === "yang_zhang") {
    // Yang-Zhang combines overnight, open-close and Rogers-Satchell
    // Simplified: blend of close-close and scaled range
    const k = 0.34 / (1.34 + (window + 1) / (window - 1));
    for (let i = window - 1; i < n; i++) {
      const slice = returns.slice(i - window + 1, i + 1);
      const mean = slice.reduce((s, v) => s + v, 0) / window;
      const ccVar = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / (window - 1);
      const rsVar = slice.reduce((s, r) => s + r ** 2, 0) / window;
      const combined = k * ccVar + (1 - k) * rsVar;
      vol[i] = Math.sqrt(combined) * Math.sqrt(252);
    }
  } else {
    throw new Error(`Unknown vol method: ${method}`);
  }

  return vol;
}

// ─── Vol Regime Detection ───────────────────────────────

/**
 * Classify the current volatility regime.
 * @param {number[]} returns  - log returns
 * @param {number}   lookback - window for vol computation
 * @returns {{ regime: string, vol: number, percentile: number }}
 */
export function volRegimeDetector(returns, lookback = 63) {
  const vols = rollingVol(returns, lookback, "ewma");
  const validVols = vols.filter(v => !isNaN(v));
  if (validVols.length === 0) return { regime: "NORMAL", vol: NaN, percentile: 50 };

  const currentVol = validVols[validVols.length - 1];
  const sorted = [...validVols].sort((a, b) => a - b);
  const rank = sorted.findIndex(v => v >= currentVol);
  const percentile = (rank / sorted.length) * 100;

  let regime;
  if (percentile < 20) regime = "LOW";
  else if (percentile < 65) regime = "NORMAL";
  else if (percentile < 90) regime = "HIGH";
  else regime = "CRISIS";

  return { regime, vol: currentVol, percentile: Math.round(percentile) };
}

// ─── Adaptive Vol Target ────────────────────────────────

/**
 * Adjust the vol target based on detected regime.
 * @param {number[]} returns     - log returns
 * @param {number}   baseTarget  - e.g. 0.10 for 10%
 * @param {object}   regimeScales - multipliers per regime
 * @returns {{ adjustedTarget: number, regime: string, vol: number }}
 */
export function adaptiveVolTarget(returns, baseTarget = 0.10, regimeScales = null) {
  const scales = regimeScales || {
    LOW: 1.2,
    NORMAL: 1.0,
    HIGH: 0.6,
    CRISIS: 0.3,
  };

  const { regime, vol, percentile } = volRegimeDetector(returns);
  const multiplier = scales[regime] ?? 1.0;
  const adjustedTarget = baseTarget * multiplier;

  return { adjustedTarget, regime, vol, percentile, multiplier };
}

// ─── Leverage Analytics ─────────────────────────────────

/**
 * Compute analytics on a time series of exposure/leverage values.
 * @param {number[]} exposureHistory - leverage scalars over time
 * @returns {object} analytics summary
 */
export function leverageAnalytics(exposureHistory) {
  const valid = exposureHistory.filter(v => !isNaN(v) && isFinite(v));
  if (valid.length === 0) return { avgLeverage: 0, maxLeverage: 0, minLeverage: 0, regimeBreakdown: {} };

  const avg = valid.reduce((s, v) => s + v, 0) / valid.length;
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  const sorted = [...valid].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Classify leverage into buckets
  const buckets = { deleveraged: 0, normal: 0, leveraged: 0, maxLev: 0 };
  for (const v of valid) {
    if (v < 0.5) buckets.deleveraged++;
    else if (v <= 1.0) buckets.normal++;
    else if (v <= 1.5) buckets.leveraged++;
    else buckets.maxLev++;
  }
  const total = valid.length;
  const regimeBreakdown = {
    deleveraged: `${((buckets.deleveraged / total) * 100).toFixed(1)}%`,
    normal: `${((buckets.normal / total) * 100).toFixed(1)}%`,
    leveraged: `${((buckets.leveraged / total) * 100).toFixed(1)}%`,
    maxLev: `${((buckets.maxLev / total) * 100).toFixed(1)}%`,
  };

  // Turnover: average absolute change in leverage
  let turnover = 0;
  for (let i = 1; i < valid.length; i++) turnover += Math.abs(valid[i] - valid[i - 1]);
  turnover /= valid.length - 1 || 1;

  return { avgLeverage: +avg.toFixed(3), maxLeverage: +max.toFixed(3), minLeverage: +min.toFixed(3), median: +median.toFixed(3), dailyTurnover: +turnover.toFixed(4), regimeBreakdown };
}

// ─── Volatility Targeter Class ──────────────────────────

export class VolatilityTargeter {
  /**
   * @param {number} targetVol   - annualized vol target, e.g. 0.10
   * @param {number} lookback    - lookback window in days
   * @param {number} maxLeverage - hard cap on leverage scalar
   */
  constructor(targetVol = 0.10, lookback = 21, maxLeverage = 2.0) {
    this.targetVol = targetVol;
    this.lookback = lookback;
    this.maxLeverage = maxLeverage;
    this._exposureHistory = [];
  }

  /**
   * Compute the vol scalar: targetVol / realizedVol, clamped to [0, maxLeverage].
   * @param {number[]} returns - recent log returns (at least `lookback` entries)
   * @returns {number} scalar to multiply positions by
   */
  computeScalar(returns) {
    if (returns.length < this.lookback) return 1.0;
    const recent = returns.slice(-this.lookback);
    const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
    const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / (recent.length - 1);
    const realizedVol = Math.sqrt(variance) * Math.sqrt(252);

    if (realizedVol < 1e-8) return this.maxLeverage;
    const scalar = this.targetVol / realizedVol;
    return Math.min(Math.max(scalar, 0), this.maxLeverage);
  }

  /**
   * Apply vol-targeting overlay to base signals.
   * Scales every signal by the current vol scalar.
   * @param {number[]} baseSignals - raw position sizes / signals
   * @param {number[]} returns     - log returns aligned with signals
   * @returns {number[]} scaled signals
   */
  applyOverlay(baseSignals, returns) {
    const scaled = [];
    this._exposureHistory = [];

    for (let i = 0; i < baseSignals.length; i++) {
      const lookbackReturns = returns.slice(0, i + 1);
      const scalar = this.computeScalar(lookbackReturns);
      this._exposureHistory.push(scalar);
      scaled.push(baseSignals[i] * scalar);
    }

    return scaled;
  }

  /**
   * Return the exposure/leverage time series from the last applyOverlay call.
   * @returns {number[]}
   */
  getExposureHistory() {
    return [...this._exposureHistory];
  }

  /**
   * Compare raw returns vs vol-targeted returns.
   * @param {number[]} baseReturns - raw daily returns
   * @returns {object} comparison stats
   */
  compareWithWithout(baseReturns) {
    const signals = baseReturns.map(() => 1.0); // fully invested
    const scaledSignals = this.applyOverlay(signals, baseReturns);
    const targetedReturns = baseReturns.map((r, i) => r * scaledSignals[i]);

    const stats = (rets, label) => {
      const total = rets.reduce((s, r) => s + r, 0);
      const cum = rets.reduce((s, r) => s * (1 + r), 1) - 1;
      const mean = total / rets.length;
      const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
      const annVol = Math.sqrt(variance) * Math.sqrt(252);
      const annReturn = mean * 252;
      const sharpe = annVol > 0 ? annReturn / annVol : 0;
      let maxDD = 0, peak = 1;
      let eq = 1;
      for (const r of rets) {
        eq *= (1 + r);
        if (eq > peak) peak = eq;
        const dd = (peak - eq) / peak;
        if (dd > maxDD) maxDD = dd;
      }
      return { label, cumReturn: +(cum * 100).toFixed(2), annReturn: +(annReturn * 100).toFixed(2), annVol: +(annVol * 100).toFixed(2), sharpe: +sharpe.toFixed(3), maxDrawdown: +(maxDD * 100).toFixed(2) };
    };

    return {
      raw: stats(baseReturns, "Raw"),
      targeted: stats(targetedReturns, "Vol-Targeted"),
      exposureStats: leverageAnalytics(this.getExposureHistory()),
    };
  }
}

// ─── Full Backtest ──────────────────────────────────────

/**
 * Run a complete vol-targeting backtest.
 * @param {number[]} baseReturns - daily log returns
 * @param {number}   targetVol   - annualized vol target
 * @param {object}   opts        - { lookback, maxLeverage, adaptive }
 * @returns {object} full backtest results
 */
export function volTargetBacktest(baseReturns, targetVol = 0.10, opts = {}) {
  const { lookback = 21, maxLeverage = 2.0, adaptive = false } = opts;

  // Optionally use adaptive target
  let effectiveTarget = targetVol;
  let regimeInfo = null;
  if (adaptive) {
    const adapted = adaptiveVolTarget(baseReturns, targetVol);
    effectiveTarget = adapted.adjustedTarget;
    regimeInfo = adapted;
  }

  const targeter = new VolatilityTargeter(effectiveTarget, lookback, maxLeverage);
  const comparison = targeter.compareWithWithout(baseReturns);

  // Compute rolling vol of both raw and targeted
  const targetedReturns = baseReturns.map((r, i) => {
    const hist = baseReturns.slice(0, i + 1);
    return r * targeter.computeScalar(hist);
  });

  const rawVol = rollingVol(baseReturns, lookback, "close_close");
  const tarVol = rollingVol(targetedReturns, lookback, "close_close");

  // Vol of vol (stability measure)
  const validRawVol = rawVol.filter(v => !isNaN(v));
  const validTarVol = tarVol.filter(v => !isNaN(v));
  const volOfVol = (arr) => {
    if (arr.length < 2) return NaN;
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
  };

  return {
    config: { targetVol, effectiveTarget, lookback, maxLeverage, adaptive },
    comparison,
    regimeInfo,
    volStability: {
      rawVolOfVol: +(volOfVol(validRawVol) * 100).toFixed(2),
      targetedVolOfVol: +(volOfVol(validTarVol) * 100).toFixed(2),
      improvement: +((1 - volOfVol(validTarVol) / volOfVol(validRawVol)) * 100).toFixed(1),
    },
  };
}

// ─── Helpers ────────────────────────────────────────────

function pricesToReturns(prices) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    rets.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  return rets;
}

function fmtPct(v) { return (v >= 0 ? "+" : "") + v.toFixed(2) + "%"; }
function fmtNum(v, d = 3) { return v.toFixed(d); }

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const symbolIdx = args.indexOf("--symbol");
  const symbol = symbolIdx >= 0 ? args[symbolIdx + 1] : "SPY";
  const targetIdx = args.indexOf("--target");
  const targetVol = targetIdx >= 0 ? parseFloat(args[targetIdx + 1]) : 0.10;

  console.log("=".repeat(64));
  console.log("  VOLATILITY TARGETING OVERLAY");
  console.log("=".repeat(64));
  console.log(`  Symbol: ${symbol}  |  Target Vol: ${(targetVol * 100).toFixed(0)}%  |  Lookback: 21d\n`);

  // Generate data
  const prices = generateRealisticPrices(symbol);
  const returns = pricesToReturns(prices);
  console.log(`  ${returns.length} daily returns loaded\n`);

  // 1. Rolling vol comparison across methods
  console.log("-".repeat(64));
  console.log("  ROLLING VOL ESTIMATORS (current)");
  console.log("-".repeat(64));
  const methods = ["close_close", "ewma", "parkinson", "yang_zhang"];
  for (const m of methods) {
    const v = rollingVol(returns, 21, m);
    const last = v.filter(x => !isNaN(x)).slice(-1)[0];
    console.log(`  ${m.padEnd(14)} ${fmtPct(last * 100).padStart(10)}`);
  }

  // 2. Regime detection
  console.log("\n" + "-".repeat(64));
  console.log("  VOL REGIME DETECTION");
  console.log("-".repeat(64));
  const regime = volRegimeDetector(returns);
  console.log(`  Current regime:  ${regime.regime}`);
  console.log(`  Current vol:     ${fmtPct(regime.vol * 100)}`);
  console.log(`  Percentile:      ${regime.percentile}th`);

  // 3. Adaptive target
  console.log("\n" + "-".repeat(64));
  console.log("  ADAPTIVE VOL TARGET");
  console.log("-".repeat(64));
  const adapted = adaptiveVolTarget(returns, targetVol);
  console.log(`  Base target:     ${fmtPct(targetVol * 100)}`);
  console.log(`  Regime:          ${adapted.regime} (x${adapted.multiplier})`);
  console.log(`  Adjusted target: ${fmtPct(adapted.adjustedTarget * 100)}`);

  // 4. Full backtest — static target
  console.log("\n" + "-".repeat(64));
  console.log("  BACKTEST: STATIC VOL TARGET");
  console.log("-".repeat(64));
  const bt = volTargetBacktest(returns, targetVol);
  const { raw, targeted } = bt.comparison;
  console.log(`  ${"".padEnd(18)} ${"Raw".padStart(12)} ${"Targeted".padStart(12)}`);
  console.log(`  ${"Cum Return".padEnd(18)} ${fmtPct(raw.cumReturn).padStart(12)} ${fmtPct(targeted.cumReturn).padStart(12)}`);
  console.log(`  ${"Ann Return".padEnd(18)} ${fmtPct(raw.annReturn).padStart(12)} ${fmtPct(targeted.annReturn).padStart(12)}`);
  console.log(`  ${"Ann Vol".padEnd(18)} ${fmtPct(raw.annVol).padStart(12)} ${fmtPct(targeted.annVol).padStart(12)}`);
  console.log(`  ${"Sharpe".padEnd(18)} ${fmtNum(raw.sharpe).padStart(12)} ${fmtNum(targeted.sharpe).padStart(12)}`);
  console.log(`  ${"Max Drawdown".padEnd(18)} ${fmtPct(-raw.maxDrawdown).padStart(12)} ${fmtPct(-targeted.maxDrawdown).padStart(12)}`);

  // 5. Full backtest — adaptive target
  console.log("\n" + "-".repeat(64));
  console.log("  BACKTEST: ADAPTIVE VOL TARGET");
  console.log("-".repeat(64));
  const btA = volTargetBacktest(returns, targetVol, { adaptive: true });
  const { raw: rawA, targeted: tarA } = btA.comparison;
  console.log(`  ${"".padEnd(18)} ${"Raw".padStart(12)} ${"Adaptive".padStart(12)}`);
  console.log(`  ${"Cum Return".padEnd(18)} ${fmtPct(rawA.cumReturn).padStart(12)} ${fmtPct(tarA.cumReturn).padStart(12)}`);
  console.log(`  ${"Ann Return".padEnd(18)} ${fmtPct(rawA.annReturn).padStart(12)} ${fmtPct(tarA.annReturn).padStart(12)}`);
  console.log(`  ${"Ann Vol".padEnd(18)} ${fmtPct(rawA.annVol).padStart(12)} ${fmtPct(tarA.annVol).padStart(12)}`);
  console.log(`  ${"Sharpe".padEnd(18)} ${fmtNum(rawA.sharpe).padStart(12)} ${fmtNum(tarA.sharpe).padStart(12)}`);
  console.log(`  ${"Max Drawdown".padEnd(18)} ${fmtPct(-rawA.maxDrawdown).padStart(12)} ${fmtPct(-tarA.maxDrawdown).padStart(12)}`);

  // 6. Leverage analytics
  console.log("\n" + "-".repeat(64));
  console.log("  LEVERAGE ANALYTICS (static target)");
  console.log("-".repeat(64));
  const lev = bt.comparison.exposureStats;
  console.log(`  Avg leverage:    ${fmtNum(lev.avgLeverage)}x`);
  console.log(`  Max leverage:    ${fmtNum(lev.maxLeverage)}x`);
  console.log(`  Min leverage:    ${fmtNum(lev.minLeverage)}x`);
  console.log(`  Median:          ${fmtNum(lev.median)}x`);
  console.log(`  Daily turnover:  ${fmtNum(lev.dailyTurnover, 4)}`);
  console.log(`  Regime breakdown:`);
  for (const [k, v] of Object.entries(lev.regimeBreakdown)) {
    console.log(`    ${k.padEnd(14)} ${v}`);
  }

  // 7. Vol stability
  console.log("\n" + "-".repeat(64));
  console.log("  VOL STABILITY (vol-of-vol)");
  console.log("-".repeat(64));
  console.log(`  Raw vol-of-vol:       ${bt.volStability.rawVolOfVol}%`);
  console.log(`  Targeted vol-of-vol:  ${bt.volStability.targetedVolOfVol}%`);
  console.log(`  Improvement:          ${bt.volStability.improvement}%`);

  console.log("\n" + "=".repeat(64));
  console.log("  Vol targeting stabilizes realized vol around the target,");
  console.log("  improving risk-adjusted returns and reducing drawdowns.");
  console.log("=".repeat(64));
}

if (process.argv[1]?.includes("vol-targeting")) {
  main().catch(err => { console.error("Error:", err.message); process.exit(1); });
}
