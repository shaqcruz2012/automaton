#!/usr/bin/env node
/**
 * Regime-Aware Asset Allocator — Inferred Analysis
 *
 * Detects market regimes (RISK_ON, RISK_OFF, CRISIS, RECOVERY) using
 * volatility, trend, and correlation signals, then maps each regime
 * to a target allocation. Supports dynamic blending by regime probability
 * and full backtest with regime switching.
 *
 * Usage:
 *   node agents/optimizer/regime-allocator.mjs
 *   import { RegimeAllocator } from './regime-allocator.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Helpers ──────────────────────────────────────────────

function returns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++)
    r.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  return r;
}

function rollingStd(arr, window) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < window - 1) { out.push(NaN); continue; }
    const slice = arr.slice(i - window + 1, i + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
    out.push(Math.sqrt(variance));
  }
  return out;
}

function sma(arr, window) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < window - 1) { out.push(NaN); continue; }
    const slice = arr.slice(i - window + 1, i + 1);
    out.push(slice.reduce((s, v) => s + v, 0) / slice.length);
  }
  return out;
}

function correlation(a, b, window) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (i < window - 1) { out.push(NaN); continue; }
    const sa = a.slice(i - window + 1, i + 1);
    const sb = b.slice(i - window + 1, i + 1);
    const ma = sa.reduce((s, v) => s + v, 0) / sa.length;
    const mb = sb.reduce((s, v) => s + v, 0) / sb.length;
    let cov = 0, va = 0, vb = 0;
    for (let j = 0; j < sa.length; j++) {
      const da = sa[j] - ma, db = sb[j] - mb;
      cov += da * db; va += da * da; vb += db * db;
    }
    const denom = Math.sqrt(va * vb);
    out.push(denom > 0 ? cov / denom : 0);
  }
  return out;
}

function annualizedVol(dailyVol) {
  return dailyVol * Math.sqrt(252);
}

// ─── Default Regime Definitions ───────────────────────────

const DEFAULT_REGIMES = {
  RISK_ON: {
    label: "Risk-On",
    weights: { equity: 0.70, bonds: 0.10, gold: 0.05, cash: 0.05, smallcap: 0.10 },
    description: "Heavy equity, minimal defensives",
  },
  RISK_OFF: {
    label: "Risk-Off",
    weights: { equity: 0.30, bonds: 0.35, gold: 0.20, cash: 0.10, smallcap: 0.05 },
    description: "Reduce equity, increase bonds & gold",
  },
  CRISIS: {
    label: "Crisis",
    weights: { equity: 0.10, bonds: 0.25, gold: 0.25, cash: 0.35, smallcap: 0.05 },
    description: "Max defensive, heavy cash",
  },
  RECOVERY: {
    label: "Recovery",
    weights: { equity: 0.45, bonds: 0.15, gold: 0.10, cash: 0.05, smallcap: 0.25 },
    description: "Tilt to value / small-cap",
  },
};

// ─── RegimeAllocator ──────────────────────────────────────

export class RegimeAllocator {
  /**
   * @param {Object} regimeDefinitions - keys are regime names, values have { label, weights, description }
   */
  constructor(regimeDefinitions = DEFAULT_REGIMES) {
    this.regimes = { ...regimeDefinitions };
    this.regimeHistory = [];
  }

  /**
   * Detect current regime from multi-asset price arrays.
   * Uses volatility level, trend direction, and equity-bond correlation.
   *
   * @param {Object} priceArrays - { equity: [...closes], bonds: [...closes], gold: [...closes] }
   * @param {number} lookback - rolling window (default 60 trading days)
   * @returns {{ regime: string, probabilities: Object, signals: Object }}
   */
  detectRegime(priceArrays, lookback = 60) {
    const eqPrices = priceArrays.equity;
    const bdPrices = priceArrays.bonds;
    const n = eqPrices.length;

    if (n < lookback + 1) return { regime: "RISK_ON", probabilities: { RISK_ON: 1 }, signals: {} };

    const eqRet = returns(eqPrices);
    const bdRet = returns(bdPrices);

    // Signals
    const vol = rollingStd(eqRet, lookback);
    const currentVol = annualizedVol(vol[vol.length - 1]);

    const trendSma = sma(eqPrices, lookback);
    const currentPrice = eqPrices[n - 1];
    const currentSma = trendSma[trendSma.length - 1];
    const trendSignal = (currentPrice - currentSma) / currentSma; // >0 uptrend

    const corr = correlation(eqRet, bdRet, lookback);
    const currentCorr = corr[corr.length - 1];

    // Drawdown from recent peak
    let peak = -Infinity;
    for (let i = Math.max(0, n - lookback); i < n; i++) peak = Math.max(peak, eqPrices[i]);
    const drawdown = (currentPrice - peak) / peak;

    // Regime scoring — each regime gets a score, then softmax to probabilities
    const scores = { RISK_ON: 0, RISK_OFF: 0, CRISIS: 0, RECOVERY: 0 };

    // Volatility component
    if (currentVol < 0.12)      { scores.RISK_ON += 2; scores.RECOVERY += 1; }
    else if (currentVol < 0.20) { scores.RISK_OFF += 2; scores.RECOVERY += 1; }
    else if (currentVol < 0.30) { scores.RISK_OFF += 1; scores.CRISIS += 2; }
    else                        { scores.CRISIS += 3; }

    // Trend component
    if (trendSignal > 0.05)       { scores.RISK_ON += 2; }
    else if (trendSignal > 0)     { scores.RISK_ON += 1; scores.RECOVERY += 1; }
    else if (trendSignal > -0.05) { scores.RISK_OFF += 2; }
    else                          { scores.CRISIS += 2; scores.RISK_OFF += 1; }

    // Correlation component (negative eq-bond correlation is flight-to-safety)
    if (currentCorr < -0.3)      { scores.CRISIS += 1; scores.RISK_OFF += 1; }
    else if (currentCorr < 0)    { scores.RISK_OFF += 1; }
    else                         { scores.RISK_ON += 1; }

    // Drawdown component
    if (drawdown < -0.20)        { scores.CRISIS += 2; }
    else if (drawdown < -0.10)   { scores.RISK_OFF += 1; scores.CRISIS += 1; }
    else if (drawdown > -0.03 && trendSignal > 0 && currentVol > 0.15) {
      scores.RECOVERY += 2; // bouncing back from elevated vol
    }

    // Softmax
    const maxScore = Math.max(...Object.values(scores));
    const expScores = {};
    let sumExp = 0;
    for (const [k, v] of Object.entries(scores)) {
      expScores[k] = Math.exp(v - maxScore);
      sumExp += expScores[k];
    }
    const probabilities = {};
    for (const [k, v] of Object.entries(expScores)) probabilities[k] = v / sumExp;

    // Winner
    let regime = "RISK_ON";
    let best = -1;
    for (const [k, p] of Object.entries(probabilities)) {
      if (p > best) { best = p; regime = k; }
    }

    const signals = {
      annualizedVol: currentVol,
      trend: trendSignal,
      eqBondCorr: currentCorr,
      drawdown,
    };

    return { regime, probabilities, signals };
  }

  /**
   * Return target weights for a named regime.
   */
  getAllocation(regime) {
    const def = this.regimes[regime];
    if (!def) throw new Error(`Unknown regime: ${regime}`);
    return { ...def.weights };
  }

  /**
   * Blend allocations using regime probabilities for smooth transitions.
   */
  dynamicAllocation(priceArrays, lookback = 60) {
    const { probabilities } = this.detectRegime(priceArrays, lookback);
    const blended = {};

    for (const [regime, prob] of Object.entries(probabilities)) {
      const w = this.regimes[regime]?.weights;
      if (!w) continue;
      for (const [asset, weight] of Object.entries(w)) {
        blended[asset] = (blended[asset] || 0) + prob * weight;
      }
    }

    // Normalize to sum to 1
    const total = Object.values(blended).reduce((s, v) => s + v, 0);
    if (total > 0) for (const k of Object.keys(blended)) blended[k] /= total;

    return { weights: blended, probabilities };
  }

  /**
   * Full backtest with regime switching.
   * Returns equity curve, regime transitions, and stats.
   */
  backtestRegimeAllocator(priceArrays, lookback = 60, rebalanceFreq = 20) {
    const assets = Object.keys(priceArrays);
    const length = Math.min(...assets.map((a) => priceArrays[a].length));
    const assetReturns = {};
    for (const a of assets) assetReturns[a] = returns(priceArrays[a].slice(0, length));

    const n = assetReturns[assets[0]].length;
    let portfolio = 10000;
    const equity = [portfolio];
    this.regimeHistory = [];
    let currentWeights = null;
    let currentRegime = "RISK_ON";

    for (let i = 0; i < n; i++) {
      // Rebalance at intervals or on first bar after warmup
      if (i >= lookback && (i === lookback || (i - lookback) % rebalanceFreq === 0)) {
        const windowPrices = {};
        for (const a of assets) windowPrices[a] = priceArrays[a].slice(0, i + 2); // +2 because returns is 1 shorter
        const detection = this.detectRegime(windowPrices, lookback);
        currentRegime = detection.regime;
        currentWeights = this.getAllocation(currentRegime);
      }

      this.regimeHistory.push({ index: i, regime: currentRegime });

      if (!currentWeights) {
        // Before warmup, equal weight
        currentWeights = {};
        for (const a of assets) currentWeights[a] = 1 / assets.length;
      }

      // Daily portfolio return
      let dayReturn = 0;
      for (const a of assets) {
        const w = currentWeights[a] || 0;
        dayReturn += w * (assetReturns[a][i] || 0);
      }
      portfolio *= 1 + dayReturn;
      equity.push(portfolio);
    }

    // Stats
    const totalReturn = (portfolio / 10000 - 1) * 100;
    const dailyRets = returns(equity);
    const avgDaily = dailyRets.reduce((s, v) => s + v, 0) / dailyRets.length;
    const stdDaily = Math.sqrt(
      dailyRets.reduce((s, v) => s + (v - avgDaily) ** 2, 0) / dailyRets.length
    );
    const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;
    let peak = -Infinity, maxDD = 0;
    for (const v of equity) { peak = Math.max(peak, v); maxDD = Math.min(maxDD, (v - peak) / peak); }

    // Regime counts
    const regimeCounts = {};
    for (const { regime } of this.regimeHistory) regimeCounts[regime] = (regimeCounts[regime] || 0) + 1;

    return {
      equity,
      totalReturn: totalReturn.toFixed(2),
      sharpe: sharpe.toFixed(3),
      maxDrawdown: (maxDD * 100).toFixed(2),
      regimeCounts,
      regimeTransitions: this._countTransitions(),
    };
  }

  _countTransitions() {
    let transitions = 0;
    for (let i = 1; i < this.regimeHistory.length; i++) {
      if (this.regimeHistory[i].regime !== this.regimeHistory[i - 1].regime) transitions++;
    }
    return transitions;
  }

  /**
   * Return full time series of detected regimes.
   */
  getRegimeHistory() {
    return [...this.regimeHistory];
  }

  /**
   * ASCII report with regime timeline and stats.
   */
  formatReport(backtestResult) {
    const { equity, totalReturn, sharpe, maxDrawdown, regimeCounts, regimeTransitions } =
      backtestResult;

    const lines = [];
    lines.push("╔══════════════════════════════════════════════════════════════╗");
    lines.push("║            REGIME-AWARE ASSET ALLOCATOR REPORT             ║");
    lines.push("╠══════════════════════════════════════════════════════════════╣");

    // Performance
    lines.push("║  PERFORMANCE                                               ║");
    lines.push(`║  Total Return:      ${totalReturn.padStart(8)}%                            ║`);
    lines.push(`║  Sharpe Ratio:      ${sharpe.padStart(8)}                             ║`);
    lines.push(`║  Max Drawdown:      ${maxDrawdown.padStart(8)}%                            ║`);
    lines.push(`║  Regime Switches:   ${String(regimeTransitions).padStart(8)}                             ║`);

    // Regime distribution
    lines.push("╠══════════════════════════════════════════════════════════════╣");
    lines.push("║  REGIME DISTRIBUTION                                       ║");
    const totalDays = Object.values(regimeCounts).reduce((s, v) => s + v, 0);
    for (const [regime, count] of Object.entries(regimeCounts)) {
      const pct = ((count / totalDays) * 100).toFixed(1);
      const bar = "█".repeat(Math.round((count / totalDays) * 30));
      const label = (regime + ":").padEnd(12);
      lines.push(`║  ${label} ${pct.padStart(5)}% ${bar.padEnd(30)} ║`);
    }

    // Regime timeline (sampled)
    lines.push("╠══════════════════════════════════════════════════════════════╣");
    lines.push("║  REGIME TIMELINE                                           ║");
    const history = this.regimeHistory;
    const symbols = { RISK_ON: "▲", RISK_OFF: "▽", CRISIS: "✕", RECOVERY: "◆" };
    const timelineLen = 56;
    let timeline = "";
    for (let i = 0; i < timelineLen; i++) {
      const idx = Math.floor((i / timelineLen) * history.length);
      const r = history[idx]?.regime || "RISK_ON";
      timeline += symbols[r] || "?";
    }
    lines.push(`║  ${timeline.padEnd(58)}║`);
    lines.push("║  ▲=RiskOn ▽=RiskOff ✕=Crisis ◆=Recovery                    ║");

    // Default allocations
    lines.push("╠══════════════════════════════════════════════════════════════╣");
    lines.push("║  REGIME ALLOCATIONS                                        ║");
    for (const [regime, def] of Object.entries(this.regimes)) {
      const wStr = Object.entries(def.weights)
        .map(([a, w]) => `${a}:${(w * 100).toFixed(0)}%`)
        .join(" ");
      lines.push(`║  ${regime.padEnd(12)} ${wStr.padEnd(45)}║`);
    }

    // Equity curve (mini sparkline)
    lines.push("╠══════════════════════════════════════════════════════════════╣");
    lines.push("║  EQUITY CURVE                                              ║");
    const sparkLen = 56;
    const minE = Math.min(...equity);
    const maxE = Math.max(...equity);
    const range = maxE - minE || 1;
    const sparkChars = " ▁▂▃▄▅▆▇█";
    let spark = "";
    for (let i = 0; i < sparkLen; i++) {
      const idx = Math.floor((i / sparkLen) * equity.length);
      const norm = (equity[idx] - minE) / range;
      spark += sparkChars[Math.floor(norm * (sparkChars.length - 1))];
    }
    lines.push(`║  ${spark.padEnd(58)}║`);
    lines.push(
      `║  $${(equity[0]).toFixed(0).padEnd(8)} → $${(equity[equity.length - 1]).toFixed(0).padEnd(38)}║`
    );

    lines.push("╚══════════════════════════════════════════════════════════════╝");
    return lines.join("\n");
  }
}

// ─── CLI Demo ─────────────────────────────────────────────

async function main() {
  console.log("Regime-Aware Asset Allocator\n");

  // Generate multi-asset price data
  const equityData = generateRealisticPrices("SPY", "2018-01-01", "2025-03-01");
  const bondData = generateRealisticPrices("TLT", "2018-01-01", "2025-03-01");
  const goldData = generateRealisticPrices("GLD", "2018-01-01", "2025-03-01");
  const smallcapData = generateRealisticPrices("IWM", "2018-01-01", "2025-03-01");

  const minLen = Math.min(equityData.length, bondData.length, goldData.length, smallcapData.length);

  const priceArrays = {
    equity: equityData.slice(0, minLen).map((d) => d.close),
    bonds: bondData.slice(0, minLen).map((d) => d.close),
    gold: goldData.slice(0, minLen).map((d) => d.close),
    smallcap: smallcapData.slice(0, minLen).map((d) => d.close),
  };

  console.log(`Loaded ${minLen} trading days across 4 asset classes\n`);

  // Initialize allocator
  const allocator = new RegimeAllocator();

  // Detect current regime
  const current = allocator.detectRegime(priceArrays, 60);
  console.log("── Current Regime Detection ──");
  console.log(`  Regime:   ${current.regime}`);
  console.log(`  Signals:`);
  console.log(`    Vol:       ${(current.signals.annualizedVol * 100).toFixed(1)}%`);
  console.log(`    Trend:     ${(current.signals.trend * 100).toFixed(2)}%`);
  console.log(`    EQ-BD ρ:   ${current.signals.eqBondCorr.toFixed(3)}`);
  console.log(`    Drawdown:  ${(current.signals.drawdown * 100).toFixed(2)}%`);
  console.log(`  Probabilities:`);
  for (const [r, p] of Object.entries(current.probabilities)) {
    console.log(`    ${r.padEnd(12)} ${(p * 100).toFixed(1)}%`);
  }

  // Static allocation for detected regime
  console.log(`\n── Static Allocation (${current.regime}) ──`);
  const staticW = allocator.getAllocation(current.regime);
  for (const [a, w] of Object.entries(staticW)) {
    console.log(`  ${a.padEnd(10)} ${(w * 100).toFixed(0)}%`);
  }

  // Dynamic blended allocation
  console.log("\n── Dynamic Blended Allocation ──");
  const dynamic = allocator.dynamicAllocation(priceArrays);
  for (const [a, w] of Object.entries(dynamic.weights)) {
    console.log(`  ${a.padEnd(10)} ${(w * 100).toFixed(1)}%`);
  }

  // Full backtest
  console.log("\n── Running Backtest ──");
  const result = allocator.backtestRegimeAllocator(priceArrays, 60, 20);

  // Report
  console.log("\n" + allocator.formatReport(result));

  // Regime history summary
  const history = allocator.getRegimeHistory();
  const transitions = [];
  for (let i = 1; i < history.length; i++) {
    if (history[i].regime !== history[i - 1].regime) {
      transitions.push({ day: history[i].index, from: history[i - 1].regime, to: history[i].regime });
    }
  }
  console.log(`\n── Regime Transitions (${transitions.length} total) ──`);
  const shown = transitions.slice(0, 15);
  for (const t of shown) {
    console.log(`  Day ${String(t.day).padStart(5)}: ${t.from.padEnd(10)} → ${t.to}`);
  }
  if (transitions.length > 15) console.log(`  ... and ${transitions.length - 15} more`);
}

main().catch(console.error);
