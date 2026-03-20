#!/usr/bin/env node
/**
 * Strategy Universe Scanner — Inferred Analysis
 *
 * Scans across multiple assets and strategies to find opportunities:
 * 1. Cross-asset momentum scanner
 * 2. Breakout scanner (new highs/lows)
 * 3. Mean reversion scanner (oversold/overbought)
 * 4. Volatility regime scanner
 * 5. Relative value scanner
 * 6. Composite opportunity score
 *
 * Usage:
 *   node agents/strategies/universe-scanner.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Scan for momentum across assets.
 */
export function momentumScan(priceArrays, lookbacks = [21, 63, 126, 252]) {
  const results = [];

  for (const [sym, prices] of Object.entries(priceArrays)) {
    const n = prices.length;
    if (n < Math.max(...lookbacks) + 1) continue;

    const momentum = {};
    let compositeScore = 0;
    for (const lb of lookbacks) {
      const ret = (prices[n - 1].close - prices[n - 1 - lb].close) / prices[n - 1 - lb].close;
      momentum[`mom_${lb}d`] = ret;
      compositeScore += ret > 0 ? 1 : -1;
    }

    results.push({
      symbol: sym,
      price: prices[n - 1].close,
      ...momentum,
      compositeScore: compositeScore / lookbacks.length,
      trend: compositeScore > 0 ? "BULLISH" : compositeScore < 0 ? "BEARISH" : "NEUTRAL",
    });
  }

  return results.sort((a, b) => b.compositeScore - a.compositeScore);
}

/**
 * Scan for breakouts (new N-day highs/lows).
 */
export function breakoutScan(priceArrays, lookback = 20) {
  const results = [];

  for (const [sym, prices] of Object.entries(priceArrays)) {
    const n = prices.length;
    if (n < lookback + 1) continue;

    let highest = -Infinity, lowest = Infinity;
    for (let i = n - 1 - lookback; i < n - 1; i++) {
      if (prices[i].close > highest) highest = prices[i].close;
      if (prices[i].close < lowest) lowest = prices[i].close;
    }

    const current = prices[n - 1].close;
    const range = highest - lowest;
    const position = range > 0 ? (current - lowest) / range : 0.5;

    let signal = "INSIDE";
    if (current >= highest) signal = "BREAKOUT_HIGH";
    else if (current <= lowest) signal = "BREAKOUT_LOW";
    else if (position > 0.8) signal = "NEAR_HIGH";
    else if (position < 0.2) signal = "NEAR_LOW";

    results.push({
      symbol: sym,
      price: current,
      high: highest,
      low: lowest,
      position,
      signal,
      range: range / current,
    });
  }

  return results;
}

/**
 * Scan for mean reversion opportunities.
 */
export function meanReversionScan(priceArrays, options = {}) {
  const { rsiPeriod = 14, bbPeriod = 20, bbStdDev = 2 } = options;
  const results = [];

  for (const [sym, prices] of Object.entries(priceArrays)) {
    const n = prices.length;
    if (n < Math.max(rsiPeriod, bbPeriod) + 10) continue;

    // RSI
    let gains = 0, losses = 0;
    for (let i = n - rsiPeriod; i < n; i++) {
      const change = prices[i].close - prices[i - 1].close;
      if (change > 0) gains += change; else losses -= change;
    }
    const rs = losses > 0 ? gains / losses : 100;
    const rsi = 100 - 100 / (1 + rs);

    // Bollinger Band %B
    let smaSum = 0;
    for (let i = n - bbPeriod; i < n; i++) smaSum += prices[i].close;
    const sma = smaSum / bbPeriod;
    const stdDev = Math.sqrt(
      prices.slice(n - bbPeriod).reduce((s, p) => s + (p.close - sma) ** 2, 0) / bbPeriod
    );
    const upperBand = sma + bbStdDev * stdDev;
    const lowerBand = sma - bbStdDev * stdDev;
    const pctB = upperBand !== lowerBand ? (prices[n - 1].close - lowerBand) / (upperBand - lowerBand) : 0.5;

    // Z-score
    const zScore = stdDev > 0 ? (prices[n - 1].close - sma) / stdDev : 0;

    let signal = "NEUTRAL";
    if (rsi < 30 && pctB < 0.1) signal = "OVERSOLD";
    else if (rsi > 70 && pctB > 0.9) signal = "OVERBOUGHT";
    else if (rsi < 40 && zScore < -1) signal = "MILD_OVERSOLD";
    else if (rsi > 60 && zScore > 1) signal = "MILD_OVERBOUGHT";

    results.push({
      symbol: sym,
      price: prices[n - 1].close,
      rsi,
      pctB,
      zScore,
      signal,
      reversionScore: (50 - rsi) / 50, // positive = oversold, negative = overbought
    });
  }

  return results.sort((a, b) => Math.abs(b.reversionScore) - Math.abs(a.reversionScore));
}

/**
 * Scan for volatility regime.
 */
export function volRegimeScan(priceArrays, shortWindow = 21, longWindow = 63) {
  const results = [];

  for (const [sym, prices] of Object.entries(priceArrays)) {
    const n = prices.length;
    if (n < longWindow + 2) continue;

    // Short-term vol
    const shortReturns = [];
    for (let i = n - shortWindow; i < n; i++) {
      shortReturns.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
    }
    const shortMean = shortReturns.reduce((a, b) => a + b, 0) / shortWindow;
    const shortVol = Math.sqrt(shortReturns.reduce((s, r) => s + (r - shortMean) ** 2, 0) / (shortWindow - 1)) * Math.sqrt(252);

    // Long-term vol
    const longReturns = [];
    for (let i = n - longWindow; i < n; i++) {
      longReturns.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
    }
    const longMean = longReturns.reduce((a, b) => a + b, 0) / longWindow;
    const longVol = Math.sqrt(longReturns.reduce((s, r) => s + (r - longMean) ** 2, 0) / (longWindow - 1)) * Math.sqrt(252);

    const volRatio = longVol > 0 ? shortVol / longVol : 1;
    let regime = "NORMAL";
    if (volRatio > 1.5) regime = "ELEVATED";
    else if (volRatio > 2.0) regime = "CRISIS";
    else if (volRatio < 0.7) regime = "COMPRESSED";

    results.push({
      symbol: sym,
      shortVol,
      longVol,
      volRatio,
      regime,
      volTrend: volRatio > 1 ? "EXPANDING" : "CONTRACTING",
    });
  }

  return results.sort((a, b) => b.volRatio - a.volRatio);
}

/**
 * Composite opportunity score combining all scans.
 */
export function compositeScore(priceArrays) {
  const momentum = momentumScan(priceArrays);
  const breakouts = breakoutScan(priceArrays);
  const meanRev = meanReversionScan(priceArrays);
  const volRegime = volRegimeScan(priceArrays);

  const scores = {};
  const symbols = Object.keys(priceArrays);

  for (const sym of symbols) {
    const mom = momentum.find(m => m.symbol === sym);
    const brk = breakouts.find(b => b.symbol === sym);
    const mr = meanRev.find(m => m.symbol === sym);
    const vol = volRegime.find(v => v.symbol === sym);

    scores[sym] = {
      symbol: sym,
      momentumScore: mom?.compositeScore || 0,
      breakoutScore: brk?.signal?.includes("HIGH") ? 1 : brk?.signal?.includes("LOW") ? -1 : 0,
      reversionScore: mr?.reversionScore || 0,
      volRegime: vol?.regime || "UNKNOWN",
      composite: (
        (mom?.compositeScore || 0) * 0.4 +
        (brk?.position || 0.5 - 0.5) * 0.2 +
        (mr?.reversionScore || 0) * 0.3 +
        (vol?.volRatio || 1 < 1 ? 0.1 : -0.1)
      ),
      opportunities: [],
    };

    // Tag opportunities
    if (mom?.compositeScore > 0.5) scores[sym].opportunities.push("Strong momentum");
    if (brk?.signal === "BREAKOUT_HIGH") scores[sym].opportunities.push("Breakout high");
    if (mr?.signal === "OVERSOLD") scores[sym].opportunities.push("Oversold bounce");
    if (mr?.signal === "OVERBOUGHT") scores[sym].opportunities.push("Overbought fade");
    if (vol?.regime === "COMPRESSED") scores[sym].opportunities.push("Vol expansion expected");
  }

  return Object.values(scores).sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite));
}

/**
 * Format scanner report.
 */
export function formatScanReport(priceArrays) {
  const scores = compositeScore(priceArrays);

  let out = `\n${"═".repeat(60)}\n  UNIVERSE SCANNER REPORT\n${"═".repeat(60)}\n\n`;
  out += `  Symbol  Momentum  Breakout  Reversion  VolRegime  Score\n`;
  out += `  ${"─".repeat(55)}\n`;

  for (const s of scores) {
    out += `  ${s.symbol.padEnd(6)} ${(s.momentumScore >= 0 ? "+" : "") + s.momentumScore.toFixed(2).padStart(7)}  `;
    out += `${String(s.breakoutScore).padStart(8)}  `;
    out += `${(s.reversionScore >= 0 ? "+" : "") + s.reversionScore.toFixed(2).padStart(9)}  `;
    out += `${s.volRegime.padEnd(10)} ${(s.composite >= 0 ? "+" : "") + s.composite.toFixed(3)}\n`;

    if (s.opportunities.length > 0) {
      out += `  ${"".padEnd(6)} → ${s.opportunities.join(", ")}\n`;
    }
  }

  out += `\n${"═".repeat(60)}\n`;
  return out;
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Strategy Universe Scanner ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD", "XLE", "XLF", "XLK", "IWM"];
  const priceArrays = {};
  for (const sym of symbols) {
    priceArrays[sym] = generateRealisticPrices(sym, "2020-01-01", "2024-12-31");
  }

  console.log(formatScanReport(priceArrays));
}

if (process.argv[1]?.includes("universe-scanner")) {
  main().catch(console.error);
}
