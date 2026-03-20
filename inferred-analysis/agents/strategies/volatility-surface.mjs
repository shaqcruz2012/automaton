#!/usr/bin/env node
/**
 * Volatility Surface & Term Structure Analysis — Inferred Analysis
 *
 * Models implied volatility surface for options-based signals:
 * 1. Realized volatility estimators (close-close, Parkinson, Garman-Klass, Yang-Zhang)
 * 2. Volatility term structure (short vs long term vol ratio)
 * 3. Volatility regime classification
 * 4. Vol-of-vol for gamma trading signals
 * 5. Variance risk premium estimation
 *
 * Usage:
 *   node agents/strategies/volatility-surface.mjs
 *   import { VolatilityAnalyzer } from './volatility-surface.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Realized Volatility Estimators ─────────────────────

/**
 * Close-to-close volatility (standard).
 */
export function closeCloseVol(prices, window = 21) {
  const result = [];
  for (let i = window; i < prices.length; i++) {
    const returns = [];
    for (let j = i - window + 1; j <= i; j++) {
      returns.push(Math.log(prices[j].close / prices[j - 1].close));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    result.push({
      date: prices[i].date,
      vol: Math.sqrt(variance * 252),
    });
  }
  return result;
}

/**
 * Parkinson volatility (uses high-low range — more efficient estimator).
 */
export function parkinsonVol(prices, window = 21) {
  const result = [];
  for (let i = window; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const hl = Math.log(prices[j].high / prices[j].low);
      sum += hl * hl;
    }
    const variance = sum / (4 * window * Math.log(2));
    result.push({
      date: prices[i].date,
      vol: Math.sqrt(variance * 252),
    });
  }
  return result;
}

/**
 * Garman-Klass volatility (uses OHLC — most efficient for GBM).
 */
export function garmanKlassVol(prices, window = 21) {
  const result = [];
  for (let i = window; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const hl = Math.log(prices[j].high / prices[j].low);
      const co = Math.log(prices[j].close / prices[j].open);
      sum += 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
    }
    result.push({
      date: prices[i].date,
      vol: Math.sqrt((sum / window) * 252),
    });
  }
  return result;
}

/**
 * Yang-Zhang volatility (most efficient, handles overnight jumps).
 */
export function yangZhangVol(prices, window = 21) {
  const result = [];
  for (let i = window; i < prices.length; i++) {
    const overnightReturns = [];
    const openCloseReturns = [];
    const rsValues = [];

    for (let j = i - window + 1; j <= i; j++) {
      const overnight = Math.log(prices[j].open / prices[j - 1].close);
      const openClose = Math.log(prices[j].close / prices[j].open);
      overnightReturns.push(overnight);
      openCloseReturns.push(openClose);

      const hl = Math.log(prices[j].high / prices[j].low);
      const hc = Math.log(prices[j].high / prices[j].close);
      const lc = Math.log(prices[j].low / prices[j].close);
      rsValues.push(hc * (hc - openClose) + lc * (lc - openClose));
    }

    const n = overnightReturns.length;
    const oMean = overnightReturns.reduce((a, b) => a + b, 0) / n;
    const cMean = openCloseReturns.reduce((a, b) => a + b, 0) / n;

    const oVar = overnightReturns.reduce((s, r) => s + (r - oMean) ** 2, 0) / (n - 1);
    const cVar = openCloseReturns.reduce((s, r) => s + (r - cMean) ** 2, 0) / (n - 1);
    const rsVar = rsValues.reduce((a, b) => a + b, 0) / n;

    const k = 0.34 / (1.34 + (n + 1) / (n - 1));
    const yzVar = oVar + k * cVar + (1 - k) * rsVar;

    result.push({
      date: prices[i].date,
      vol: Math.sqrt(Math.max(0, yzVar) * 252),
    });
  }
  return result;
}

// ─── Volatility Term Structure ──────────────────────────

/**
 * Compute vol term structure: ratio of short-term to long-term vol.
 * Values > 1 indicate backwardation (fear), < 1 indicates contango (complacency).
 */
export function volTermStructure(prices, shortWindow = 5, longWindow = 63) {
  const shortVol = closeCloseVol(prices, shortWindow);
  const longVol = closeCloseVol(prices, longWindow);

  const result = [];
  const offset = longWindow - shortWindow;

  for (let i = 0; i < longVol.length; i++) {
    const sv = shortVol[i + offset];
    const lv = longVol[i];
    if (!sv || !lv || lv.vol === 0) continue;

    result.push({
      date: lv.date,
      shortVol: sv.vol,
      longVol: lv.vol,
      ratio: sv.vol / lv.vol,
      isBackwardation: sv.vol > lv.vol,
    });
  }

  return result;
}

// ─── Vol-of-Vol (Gamma Indicator) ───────────────────────

/**
 * Volatility of volatility — measures gamma/convexity exposure.
 * High vol-of-vol = unstable markets, good for gamma trading.
 */
export function volOfVol(prices, volWindow = 21, vovWindow = 21) {
  const vols = closeCloseVol(prices, volWindow);
  const result = [];

  for (let i = vovWindow; i < vols.length; i++) {
    const volSlice = vols.slice(i - vovWindow, i).map(v => v.vol);
    const mean = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
    const std = Math.sqrt(volSlice.reduce((s, v) => s + (v - mean) ** 2, 0) / (volSlice.length - 1));

    result.push({
      date: vols[i].date,
      vol: vols[i].vol,
      volOfVol: std,
      volOfVolRatio: mean > 0 ? std / mean : 0,
    });
  }

  return result;
}

// ─── Variance Risk Premium ──────────────────────────────

/**
 * Estimate variance risk premium: implied vol - realized vol.
 * Uses Parkinson as "implied" proxy and close-close as "realized".
 * In real usage, you'd use actual options IV.
 */
export function varianceRiskPremium(prices, window = 21) {
  const parkVol = parkinsonVol(prices, window);
  const ccVol = closeCloseVol(prices, window);
  const result = [];

  for (let i = 0; i < Math.min(parkVol.length, ccVol.length); i++) {
    result.push({
      date: parkVol[i].date,
      impliedProxy: parkVol[i].vol,
      realized: ccVol[i].vol,
      vrp: parkVol[i].vol - ccVol[i].vol,
      vrpPercent: ccVol[i].vol > 0 ? (parkVol[i].vol - ccVol[i].vol) / ccVol[i].vol : 0,
    });
  }

  return result;
}

// ─── Volatility-Based Trading Signals ───────────────────

/**
 * Generate signals from volatility analysis.
 */
export function volSignals(prices, options = {}) {
  const { shortWindow = 5, longWindow = 63, volWindow = 21 } = options;

  const termStructure = volTermStructure(prices, shortWindow, longWindow);
  const vov = volOfVol(prices, volWindow);
  const vrp = varianceRiskPremium(prices, volWindow);

  const signals = [];
  const minLen = Math.min(termStructure.length, vov.length, vrp.length);
  const offset = Math.max(0, termStructure.length - minLen);

  for (let i = 0; i < minLen; i++) {
    const ts = termStructure[i + offset];
    const v = vov[vov.length - minLen + i];
    const vr = vrp[vrp.length - minLen + i];

    let signal = 0;
    let reason = "";

    // Vol contango + low vol-of-vol = calm → risk-on (long)
    if (ts.ratio < 0.8 && v.volOfVolRatio < 0.15) {
      signal = 1;
      reason = "vol_contango_calm";
    }
    // Vol backwardation + high vol-of-vol = fear → risk-off or mean-reversion long
    else if (ts.ratio > 1.3 && v.volOfVolRatio > 0.25) {
      signal = 1; // contrarian: buy fear
      reason = "vol_backwardation_fear_reversal";
    }
    // Elevated VRP = sell vol / buy equities
    else if (vr.vrpPercent > 0.3) {
      signal = 1;
      reason = "high_vrp_sell_vol";
    }
    // Negative VRP = buy vol / reduce equities
    else if (vr.vrpPercent < -0.2) {
      signal = -1;
      reason = "negative_vrp_buy_vol";
    }

    signals.push({
      date: ts.date,
      signal,
      reason,
      termStructureRatio: ts.ratio,
      volOfVol: v.volOfVolRatio,
      vrp: vr.vrpPercent,
    });
  }

  return signals;
}

// ─── Full Analyzer Class ────────────────────────────────

export class VolatilityAnalyzer {
  constructor(prices) {
    this.prices = prices;
    this._cache = {};
  }

  getCloseCloseVol(window = 21) {
    const key = `cc_${window}`;
    if (!this._cache[key]) this._cache[key] = closeCloseVol(this.prices, window);
    return this._cache[key];
  }

  getParkinsonVol(window = 21) {
    const key = `pk_${window}`;
    if (!this._cache[key]) this._cache[key] = parkinsonVol(this.prices, window);
    return this._cache[key];
  }

  getGarmanKlassVol(window = 21) {
    const key = `gk_${window}`;
    if (!this._cache[key]) this._cache[key] = garmanKlassVol(this.prices, window);
    return this._cache[key];
  }

  getYangZhangVol(window = 21) {
    const key = `yz_${window}`;
    if (!this._cache[key]) this._cache[key] = yangZhangVol(this.prices, window);
    return this._cache[key];
  }

  getTermStructure(shortWindow = 5, longWindow = 63) {
    return volTermStructure(this.prices, shortWindow, longWindow);
  }

  getVolOfVol(volWindow = 21, vovWindow = 21) {
    return volOfVol(this.prices, volWindow, vovWindow);
  }

  getVRP(window = 21) {
    return varianceRiskPremium(this.prices, window);
  }

  getSignals(options = {}) {
    return volSignals(this.prices, options);
  }

  /**
   * Get current vol regime.
   */
  getCurrentRegime() {
    const cc = this.getCloseCloseVol(21);
    const ts = this.getTermStructure();
    const vov = this.getVolOfVol();

    if (cc.length === 0) return "unknown";

    const currentVol = cc[cc.length - 1].vol;
    const currentTS = ts.length > 0 ? ts[ts.length - 1].ratio : 1;
    const currentVOV = vov.length > 0 ? vov[vov.length - 1].volOfVolRatio : 0.1;

    if (currentVol > 0.30 && currentTS > 1.2) return "crisis";
    if (currentVol > 0.20 && currentVOV > 0.20) return "high_vol";
    if (currentVol < 0.10) return "low_vol";
    if (currentTS < 0.8) return "complacent";
    return "normal";
  }

  /**
   * Compare all volatility estimators.
   */
  compareEstimators(window = 21) {
    const cc = this.getCloseCloseVol(window);
    const pk = this.getParkinsonVol(window);
    const gk = this.getGarmanKlassVol(window);
    const yz = this.getYangZhangVol(window);

    const n = Math.min(cc.length, pk.length, gk.length, yz.length);
    return {
      closeClose: cc[cc.length - 1]?.vol,
      parkinson: pk[pk.length - 1]?.vol,
      garmanKlass: gk[gk.length - 1]?.vol,
      yangZhang: yz[yz.length - 1]?.vol,
      samples: n,
    };
  }
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Volatility Surface Analysis ═══\n");

  const prices = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  const analyzer = new VolatilityAnalyzer(prices);

  // Compare estimators
  console.log("─── Volatility Estimator Comparison (21-day) ───");
  const comp = analyzer.compareEstimators(21);
  console.log(`  Close-Close:  ${(comp.closeClose * 100).toFixed(1)}%`);
  console.log(`  Parkinson:    ${(comp.parkinson * 100).toFixed(1)}%`);
  console.log(`  Garman-Klass: ${(comp.garmanKlass * 100).toFixed(1)}%`);
  console.log(`  Yang-Zhang:   ${(comp.yangZhang * 100).toFixed(1)}%`);

  // Current regime
  console.log(`\n  Current regime: ${analyzer.getCurrentRegime()}`);

  // Term structure
  console.log("\n─── Volatility Term Structure ───");
  const ts = analyzer.getTermStructure();
  const latest = ts.slice(-5);
  for (const t of latest) {
    const bar = t.isBackwardation ? "▲" : "▽";
    console.log(`  ${t.date}: short=${(t.shortVol * 100).toFixed(1)}% long=${(t.longVol * 100).toFixed(1)}% ratio=${t.ratio.toFixed(2)} ${bar}`);
  }

  // Vol-of-vol
  console.log("\n─── Vol-of-Vol (Gamma Indicator) ───");
  const vov = analyzer.getVolOfVol();
  const vovLatest = vov.slice(-5);
  for (const v of vovLatest) {
    console.log(`  ${v.date}: vol=${(v.vol * 100).toFixed(1)}% vov=${v.volOfVol.toFixed(4)} ratio=${v.volOfVolRatio.toFixed(3)}`);
  }

  // VRP
  console.log("\n─── Variance Risk Premium ───");
  const vrp = analyzer.getVRP();
  const vrpLatest = vrp.slice(-5);
  for (const v of vrpLatest) {
    const sign = v.vrp > 0 ? "+" : "";
    console.log(`  ${v.date}: impl=${(v.impliedProxy * 100).toFixed(1)}% real=${(v.realized * 100).toFixed(1)}% VRP=${sign}${(v.vrp * 100).toFixed(1)}%`);
  }

  // Trading signals
  console.log("\n─── Vol-Based Signals ───");
  const signals = analyzer.getSignals();
  const activeSignals = signals.filter(s => s.signal !== 0).slice(-10);
  for (const s of activeSignals) {
    const dir = s.signal > 0 ? "LONG" : "SHORT";
    console.log(`  ${s.date}: ${dir} (${s.reason}) ts=${s.termStructureRatio.toFixed(2)} vov=${s.volOfVol.toFixed(3)} vrp=${s.vrp.toFixed(3)}`);
  }
  console.log(`  Total signals: ${signals.filter(s => s.signal !== 0).length} / ${signals.length} days`);
}

if (process.argv[1]?.includes("volatility-surface")) {
  main().catch(console.error);
}
