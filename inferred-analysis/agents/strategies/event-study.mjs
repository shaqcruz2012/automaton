#!/usr/bin/env node
/**
 * Event Study Analysis — Inferred Analysis
 *
 * Standard event study methodology for measuring strategy signal efficacy.
 * Identifies events (RSI extremes, MA crossovers, volume spikes, gaps),
 * computes abnormal returns around each event window, and tests statistical
 * significance of the cumulative abnormal return (CAR).
 *
 * Methodology:
 *   1. Estimate a market model over an estimation window
 *   2. Compute abnormal returns = actual - expected (market model)
 *   3. Accumulate AR into CAR over the event window [-W, +W]
 *   4. Average CARs across events to get CAAR
 *   5. t-test on cross-sectional CARs for significance
 *
 * Usage:
 *   node agents/strategies/event-study.mjs
 *   import { EventStudy, identifyEvents, computeCAR, eventStudyResults } from './event-study.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Technical Indicator Helpers ─────────────────────────

/**
 * Compute RSI (Relative Strength Index) for a price series.
 * Returns array of { date, close, rsi } starting after `period` bars.
 */
export function computeRSI(prices, period = 14) {
  const results = [];
  if (prices.length < period + 1) return results;

  let avgGain = 0;
  let avgLoss = 0;

  // Seed with simple average over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = prices[i].close - prices[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  results.push({
    date: prices[period].date,
    close: prices[period].close,
    rsi: 100 - 100 / (1 + rs0),
  });

  // Smoothed RSI for remaining bars
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i].close - prices[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    results.push({
      date: prices[i].date,
      close: prices[i].close,
      rsi: 100 - 100 / (1 + rs),
    });
  }

  return results;
}

/**
 * Simple Moving Average over `period` bars.
 * Returns array of { date, close, sma }.
 */
export function computeSMA(prices, period) {
  const results = [];
  for (let i = period - 1; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += prices[j].close;
    results.push({
      date: prices[i].date,
      close: prices[i].close,
      sma: sum / period,
    });
  }
  return results;
}

/**
 * Compute daily log returns.
 * Returns array of { date, ret } starting from index 1.
 */
export function dailyReturns(prices) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    rets.push({
      date: prices[i].date,
      ret: Math.log(prices[i].close / prices[i - 1].close),
    });
  }
  return rets;
}

// ─── Built-In Event Detectors ────────────────────────────

/**
 * Detect RSI crossing below a threshold (oversold) or above (overbought).
 * Returns dates where RSI crosses into the extreme zone.
 */
export function detectRSIExtremes(prices, { period = 14, oversold = 30, overbought = 70 } = {}) {
  const rsiData = computeRSI(prices, period);
  const events = [];

  for (let i = 1; i < rsiData.length; i++) {
    const prev = rsiData[i - 1].rsi;
    const curr = rsiData[i].rsi;

    if (prev >= oversold && curr < oversold) {
      events.push({ date: rsiData[i].date, type: "rsi_oversold", value: curr });
    }
    if (prev <= overbought && curr > overbought) {
      events.push({ date: rsiData[i].date, type: "rsi_overbought", value: curr });
    }
  }

  return events;
}

/**
 * Detect moving average crossovers (golden cross / death cross).
 * Golden cross: short MA crosses above long MA.
 * Death cross: short MA crosses below long MA.
 */
export function detectMACrossovers(prices, { shortPeriod = 50, longPeriod = 200 } = {}) {
  const shortMA = computeSMA(prices, shortPeriod);
  const longMA = computeSMA(prices, longPeriod);

  // Align by date
  const longDates = new Set(longMA.map(d => d.date));
  const alignedShort = shortMA.filter(d => longDates.has(d.date));
  const longMap = Object.fromEntries(longMA.map(d => [d.date, d.sma]));

  const events = [];
  for (let i = 1; i < alignedShort.length; i++) {
    const prevShort = alignedShort[i - 1].sma;
    const currShort = alignedShort[i].sma;
    const prevLong = longMap[alignedShort[i - 1].date];
    const currLong = longMap[alignedShort[i].date];

    if (prevShort <= prevLong && currShort > currLong) {
      events.push({ date: alignedShort[i].date, type: "golden_cross", value: currShort });
    }
    if (prevShort >= prevLong && currShort < currLong) {
      events.push({ date: alignedShort[i].date, type: "death_cross", value: currShort });
    }
  }

  return events;
}

/**
 * Detect volume spikes — days where volume > threshold * rolling average volume.
 */
export function detectVolumeSpikes(prices, { lookback = 20, threshold = 2.5 } = {}) {
  const events = [];

  for (let i = lookback; i < prices.length; i++) {
    let avgVol = 0;
    for (let j = i - lookback; j < i; j++) avgVol += prices[j].volume;
    avgVol /= lookback;

    const ratio = prices[i].volume / avgVol;
    if (ratio >= threshold) {
      events.push({ date: prices[i].date, type: "volume_spike", value: ratio });
    }
  }

  return events;
}

/**
 * Detect gap events — overnight gaps exceeding a threshold.
 * Gap up: open > prev close * (1 + threshold)
 * Gap down: open < prev close * (1 - threshold)
 */
export function detectGapEvents(prices, { threshold = 0.02 } = {}) {
  const events = [];

  for (let i = 1; i < prices.length; i++) {
    const gapPct = (prices[i].open - prices[i - 1].close) / prices[i - 1].close;

    if (gapPct >= threshold) {
      events.push({ date: prices[i].date, type: "gap_up", value: gapPct });
    } else if (gapPct <= -threshold) {
      events.push({ date: prices[i].date, type: "gap_down", value: gapPct });
    }
  }

  return events;
}

/**
 * Master event identifier — runs all detectors and merges results.
 * Filter by `types` array to select specific event types.
 */
export function identifyEvents(prices, options = {}) {
  const {
    types = null, // null = all types
    rsi = {},
    ma = {},
    volume = {},
    gap = {},
  } = options;

  let allEvents = [];

  const detectors = [
    { fn: detectRSIExtremes, opts: rsi, types: ["rsi_oversold", "rsi_overbought"] },
    { fn: detectMACrossovers, opts: ma, types: ["golden_cross", "death_cross"] },
    { fn: detectVolumeSpikes, opts: volume, types: ["volume_spike"] },
    { fn: detectGapEvents, opts: gap, types: ["gap_up", "gap_down"] },
  ];

  for (const { fn, opts, types: detectorTypes } of detectors) {
    // Skip detector if user filtered types and none of this detector's types are included
    if (types && !detectorTypes.some(t => types.includes(t))) continue;
    const detected = fn(prices, opts);
    allEvents.push(...detected);
  }

  // Filter by requested types
  if (types) {
    allEvents = allEvents.filter(e => types.includes(e.type));
  }

  // Sort by date
  allEvents.sort((a, b) => a.date.localeCompare(b.date));
  return allEvents;
}

// ─── Market Model & Abnormal Returns ─────────────────────

/**
 * OLS regression: y = alpha + beta * x
 */
function ols(y, x) {
  const n = y.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;

  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }

  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  return { alpha, beta };
}

/**
 * Estimate market model parameters over an estimation window.
 * Uses returns from [eventIdx - estEnd, eventIdx - estStart] relative to the event.
 *
 * @param {number[]} assetRets - daily log returns array for the asset
 * @param {number[]} marketRets - daily log returns array for the market
 * @param {number} eventIdx - index of the event day in the returns array
 * @param {number} estStart - start of estimation window (days before event, default 120)
 * @param {number} estEnd - end of estimation window (days before event, default 21)
 * @returns {{ alpha: number, beta: number, sigma: number }}
 */
function estimateMarketModel(assetRets, marketRets, eventIdx, estStart = 120, estEnd = 21) {
  const from = eventIdx - estStart;
  const to = eventIdx - estEnd;

  if (from < 0 || to <= from) {
    return { alpha: 0, beta: 1, sigma: 0.01 };
  }

  const y = assetRets.slice(from, to);
  const x = marketRets.slice(from, to);

  const { alpha, beta } = ols(y, x);

  // Residual standard deviation
  const residuals = y.map((yi, i) => yi - alpha - beta * x[i]);
  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const variance = residuals.reduce((a, r) => a + (r - mean) ** 2, 0) / (residuals.length - 2);
  const sigma = Math.sqrt(Math.max(variance, 1e-10));

  return { alpha, beta, sigma };
}

/**
 * Compute abnormal returns for a single event over the event window [-W, +W].
 * AR_t = R_asset_t - (alpha + beta * R_market_t)
 *
 * @returns {{ window: number[], ar: number[], car: number[], model: object } | null}
 */
export function computeCAR(assetRets, marketRets, eventIdx, halfWindow = 20, estConfig = {}) {
  const { estStart = 120, estEnd = 21 } = estConfig;

  // Check bounds
  if (eventIdx - halfWindow < 0 || eventIdx + halfWindow >= assetRets.length) {
    return null;
  }

  const model = estimateMarketModel(assetRets, marketRets, eventIdx, estStart, estEnd);

  const window = [];
  const ar = [];
  const car = [];
  let cumAR = 0;

  for (let t = -halfWindow; t <= halfWindow; t++) {
    const idx = eventIdx + t;
    const actual = assetRets[idx];
    const expected = model.alpha + model.beta * marketRets[idx];
    const abnormal = actual - expected;

    cumAR += abnormal;
    window.push(t);
    ar.push(abnormal);
    car.push(cumAR);
  }

  return { window, ar, car, model };
}

// ─── Statistical Testing ─────────────────────────────────

/**
 * Cross-sectional t-test on a set of CAR values.
 * H0: mean(CAR) = 0
 * Returns { mean, std, tStat, pValue, n, significant }
 */
function tTestCARs(carValues) {
  const n = carValues.length;
  if (n < 2) return { mean: 0, std: 0, tStat: 0, pValue: 1, n, significant: false };

  const mean = carValues.reduce((a, b) => a + b, 0) / n;
  const variance = carValues.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const se = std / Math.sqrt(n);
  const tStat = se > 0 ? mean / se : 0;

  // Approximate two-tailed p-value using normal distribution (valid for large n)
  const pValue = 2 * (1 - normalCDF(Math.abs(tStat)));

  return {
    mean,
    std,
    tStat,
    pValue,
    n,
    significant: pValue < 0.05,
  };
}

/**
 * Standard normal CDF approximation (Abramowitz & Stegun).
 */
function normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
}

// ─── Event Impact Decay Analysis ─────────────────────────

/**
 * Analyze how event impact decays over time.
 * Measures CAR at various horizons and fits exponential decay.
 *
 * @param {number[][]} carCurves - array of CAR curves from multiple events
 * @param {number} halfWindow - half window size
 * @returns {{ horizons: object[], halfLife: number, decayRate: number }}
 */
function analyzeDecay(carCurves, halfWindow) {
  const horizons = [1, 2, 3, 5, 10, 15, 20].filter(h => h <= halfWindow);
  const results = [];

  for (const h of horizons) {
    const idx = halfWindow + h; // index in the car array (event at halfWindow)
    const eventIdx = halfWindow; // CAR at event day

    const carsAtHorizon = carCurves.map(c => c[idx]);
    const carsAtEvent = carCurves.map(c => c[eventIdx]);

    const meanCAR = carsAtHorizon.reduce((a, b) => a + b, 0) / carsAtHorizon.length;
    const test = tTestCARs(carsAtHorizon);

    results.push({
      horizon: h,
      meanCAR,
      tStat: test.tStat,
      pValue: test.pValue,
      significant: test.significant,
    });
  }

  // Estimate half-life: find first horizon where |meanCAR| < peak/2
  const peakCAR = Math.max(...results.map(r => Math.abs(r.meanCAR)));
  let halfLife = halfWindow;
  for (const r of results) {
    if (Math.abs(r.meanCAR) < peakCAR / 2) {
      halfLife = r.horizon;
      break;
    }
  }

  // Simple decay rate: ln(2) / halfLife
  const decayRate = halfLife > 0 ? Math.log(2) / halfLife : 0;

  return { horizons: results, halfLife, decayRate };
}

// ─── EventStudy Class ────────────────────────────────────

/**
 * Main EventStudy class — encapsulates the full event study workflow.
 *
 * Usage:
 *   const es = new EventStudy(assetPrices, marketPrices);
 *   const events = es.detectEvents({ types: ['rsi_oversold'] });
 *   const results = es.run(events);
 *   es.printResults(results);
 *   es.plotCAR(results);
 */
export class EventStudy {
  /**
   * @param {Array<{date,open,high,low,close,volume}>} assetPrices
   * @param {Array<{date,open,high,low,close,volume}>} marketPrices - benchmark (e.g., SPY)
   * @param {object} config
   * @param {number} config.halfWindow - event window half-size (default 20)
   * @param {number} config.estStart - estimation window start before event (default 120)
   * @param {number} config.estEnd - estimation window end before event (default 21)
   */
  constructor(assetPrices, marketPrices, config = {}) {
    this.assetPrices = assetPrices;
    this.marketPrices = marketPrices;
    this.halfWindow = config.halfWindow ?? 20;
    this.estStart = config.estStart ?? 120;
    this.estEnd = config.estEnd ?? 21;

    // Build date index
    this.dateIndex = Object.fromEntries(assetPrices.map((p, i) => [p.date, i]));

    // Compute returns
    this.assetRets = dailyReturns(assetPrices).map(r => r.ret);
    this.marketRets = dailyReturns(marketPrices).map(r => r.ret);
    this.retDates = dailyReturns(assetPrices).map(r => r.date);
    this.retDateIndex = Object.fromEntries(this.retDates.map((d, i) => [d, i]));
  }

  /**
   * Detect events using built-in detectors.
   */
  detectEvents(options = {}) {
    return identifyEvents(this.assetPrices, options);
  }

  /**
   * Run the event study on a list of events.
   * Returns full results object including CAAR, significance, and decay analysis.
   */
  run(events) {
    const validEvents = [];
    const carCurves = [];
    const finalCARs = [];

    for (const event of events) {
      // Find the event date in the returns array
      const retIdx = this.retDateIndex[event.date];
      if (retIdx === undefined) continue;

      const result = computeCAR(
        this.assetRets,
        this.marketRets,
        retIdx,
        this.halfWindow,
        { estStart: this.estStart, estEnd: this.estEnd }
      );

      if (!result) continue;

      validEvents.push({ ...event, retIdx });
      carCurves.push(result.car);
      finalCARs.push(result.car[result.car.length - 1]);
    }

    if (validEvents.length === 0) {
      return {
        eventType: events[0]?.type ?? "unknown",
        eventCount: 0,
        validEvents: 0,
        caar: [],
        significance: { mean: 0, std: 0, tStat: 0, pValue: 1, n: 0, significant: false },
        decay: { horizons: [], halfLife: 0, decayRate: 0 },
        events: [],
        carCurves: [],
      };
    }

    // Compute CAAR (average CAR across events at each time offset)
    const windowLen = 2 * this.halfWindow + 1;
    const caar = new Array(windowLen).fill(0);
    for (const curve of carCurves) {
      for (let i = 0; i < windowLen; i++) {
        caar[i] += curve[i] / carCurves.length;
      }
    }

    // Significance test on final CARs
    const significance = tTestCARs(finalCARs);

    // Decay analysis
    const decay = analyzeDecay(carCurves, this.halfWindow);

    return {
      eventType: events[0]?.type ?? "mixed",
      eventCount: events.length,
      validEvents: validEvents.length,
      caar,
      significance,
      decay,
      events: validEvents,
      carCurves,
    };
  }

  /**
   * Print event study results summary.
   */
  printResults(results) {
    console.log("\n" + "=".repeat(70));
    console.log(`  EVENT STUDY RESULTS: ${results.eventType.toUpperCase()}`);
    console.log("=".repeat(70));
    console.log(`  Events detected:  ${results.eventCount}`);
    console.log(`  Valid events:     ${results.validEvents} (with sufficient data for estimation)`);
    console.log(`  Event window:     [-${this.halfWindow}, +${this.halfWindow}] days`);
    console.log(`  Estimation window: [-${this.estStart}, -${this.estEnd}] days`);
    console.log("");

    // CAAR summary
    const peakIdx = results.caar.reduce((mi, v, i, a) => Math.abs(v) > Math.abs(a[mi]) ? i : mi, 0);
    const peakDay = peakIdx - this.halfWindow;
    console.log("  ── CAAR Summary ──");
    console.log(`  CAAR at event (t=0):       ${(results.caar[this.halfWindow] * 100).toFixed(3)}%`);
    console.log(`  CAAR at t=+${this.halfWindow}:            ${(results.caar[results.caar.length - 1] * 100).toFixed(3)}%`);
    console.log(`  Peak CAAR:                 ${(results.caar[peakIdx] * 100).toFixed(3)}% at t=${peakDay >= 0 ? "+" : ""}${peakDay}`);
    console.log("");

    // Significance
    const sig = results.significance;
    console.log("  ── Statistical Significance (t-test on final CARs) ──");
    console.log(`  Mean CAR:    ${(sig.mean * 100).toFixed(3)}%`);
    console.log(`  Std Dev:     ${(sig.std * 100).toFixed(3)}%`);
    console.log(`  t-statistic: ${sig.tStat.toFixed(3)}`);
    console.log(`  p-value:     ${sig.pValue.toFixed(4)}`);
    console.log(`  Significant: ${sig.significant ? "YES (p < 0.05)" : "NO (p >= 0.05)"}`);
    console.log("");

    // Decay analysis
    console.log("  ── Event Impact Decay ──");
    console.log(`  Half-life:   ${results.decay.halfLife} days`);
    console.log(`  Decay rate:  ${results.decay.decayRate.toFixed(4)}/day`);
    console.log("");
    console.log("  Horizon   CAAR       t-stat   p-value  Sig");
    console.log("  " + "-".repeat(55));
    for (const h of results.decay.horizons) {
      const sig2 = h.significant ? " ***" : "    ";
      console.log(
        `  t+${String(h.horizon).padStart(2)}      ` +
        `${(h.meanCAR * 100).toFixed(3).padStart(8)}%  ` +
        `${h.tStat.toFixed(3).padStart(7)}  ` +
        `${h.pValue.toFixed(4).padStart(7)}  ${sig2}`
      );
    }
    console.log("");
  }

  /**
   * Generate ASCII art plot of CAAR curve.
   */
  plotCAR(results, width = 66, height = 18) {
    const caar = results.caar;
    if (caar.length === 0) {
      console.log("  No data to plot.");
      return;
    }

    console.log("  ── CAAR Plot [-" + this.halfWindow + ", +" + this.halfWindow + "] ──\n");

    const min = Math.min(...caar);
    const max = Math.max(...caar);
    const range = max - min || 0.001;

    // Build grid
    const grid = Array.from({ length: height }, () => Array(width).fill(" "));

    // Zero line
    const zeroRow = Math.round((max / range) * (height - 1));
    if (zeroRow >= 0 && zeroRow < height) {
      for (let c = 0; c < width; c++) grid[zeroRow][c] = "-";
    }

    // Event day marker (vertical)
    const eventCol = Math.round((this.halfWindow / (caar.length - 1)) * (width - 1));
    for (let r = 0; r < height; r++) {
      if (grid[r][eventCol] === "-") grid[r][eventCol] = "+";
      else grid[r][eventCol] = "|";
    }

    // Plot CAAR curve
    for (let i = 0; i < caar.length; i++) {
      const col = Math.round((i / (caar.length - 1)) * (width - 1));
      const row = Math.round(((max - caar[i]) / range) * (height - 1));
      const clampedRow = Math.max(0, Math.min(height - 1, row));
      grid[clampedRow][col] = "*";
    }

    // Y-axis labels
    const topLabel = (max * 100).toFixed(2) + "%";
    const botLabel = (min * 100).toFixed(2) + "%";
    const midLabel = ((max + min) / 2 * 100).toFixed(2) + "%";

    console.log(`  ${topLabel.padStart(9)} |${grid[0].join("")}|`);
    for (let r = 1; r < height - 1; r++) {
      if (r === Math.floor(height / 2)) {
        console.log(`  ${midLabel.padStart(9)} |${grid[r].join("")}|`);
      } else {
        console.log(`  ${"".padStart(9)} |${grid[r].join("")}|`);
      }
    }
    console.log(`  ${botLabel.padStart(9)} |${grid[height - 1].join("")}|`);
    console.log(`  ${"".padStart(9)}  ${"t=" + (-this.halfWindow)}${"".padStart(width - 12)}${"t=+" + this.halfWindow}`);
    console.log(`  ${"".padStart(9)}  ${"".padStart(Math.max(0, eventCol - 2))}t=0`);
    console.log("");
  }
}

// ─── Convenience Function ────────────────────────────────

/**
 * Run a complete event study and return structured results.
 *
 * @param {Array} assetPrices - OHLCV price data for the asset
 * @param {Array} marketPrices - OHLCV price data for the market benchmark
 * @param {Array} eventDates - array of date strings or event objects { date, type }
 * @param {object} config - { halfWindow, estStart, estEnd }
 * @returns {object} Event study results
 */
export function eventStudyResults(assetPrices, marketPrices, eventDates, config = {}) {
  const es = new EventStudy(assetPrices, marketPrices, config);

  // Normalize event dates to event objects
  const events = eventDates.map(e => {
    if (typeof e === "string") return { date: e, type: "custom" };
    return e;
  });

  return es.run(events);
}

// ─── CLI Demo ────────────────────────────────────────────

async function main() {
  console.log("=".repeat(70));
  console.log("  EVENT STUDY ANALYSIS — RSI Oversold on SPY");
  console.log("  Measuring post-event abnormal returns");
  console.log("=".repeat(70));
  console.log("");

  // Generate price data
  console.log("  Generating synthetic price data...");
  const spyPrices = generateRealisticPrices("SPY", "2020-01-01", "2025-06-01");
  const qqqPrices = generateRealisticPrices("QQQ", "2020-01-01", "2025-06-01");
  console.log(`  SPY: ${spyPrices.length} days`);
  console.log(`  QQQ: ${qqqPrices.length} days (market benchmark)`);
  console.log("");

  // Create event study instance (SPY as asset, QQQ as rough market proxy)
  const es = new EventStudy(spyPrices, qqqPrices);

  // Step 1: Detect RSI oversold events
  console.log("  Step 1: Detecting RSI oversold events (RSI < 30)...");
  const rsiEvents = es.detectEvents({ types: ["rsi_oversold"], rsi: { period: 14, oversold: 30 } });
  console.log(`  Found ${rsiEvents.length} RSI oversold events\n`);

  if (rsiEvents.length > 0) {
    console.log("  Events:");
    for (const e of rsiEvents.slice(0, 15)) {
      console.log(`    ${e.date}  RSI=${e.value.toFixed(1)}`);
    }
    if (rsiEvents.length > 15) console.log(`    ... and ${rsiEvents.length - 15} more`);
    console.log("");
  }

  // Step 2: Run event study
  console.log("  Step 2: Running event study [-20, +20] days...");
  const results = es.run(rsiEvents);

  // Step 3: Print results
  es.printResults(results);

  // Step 4: Plot CAAR
  es.plotCAR(results);

  // Also run for other event types
  console.log("\n" + "=".repeat(70));
  console.log("  ADDITIONAL EVENT TYPES");
  console.log("=".repeat(70));

  // Volume spikes
  console.log("\n  Detecting volume spikes (2.5x average)...");
  const volEvents = es.detectEvents({ types: ["volume_spike"], volume: { threshold: 2.5 } });
  console.log(`  Found ${volEvents.length} volume spike events`);
  if (volEvents.length > 0) {
    const volResults = es.run(volEvents);
    es.printResults(volResults);
    es.plotCAR(volResults);
  }

  // MA crossovers (golden cross)
  console.log("\n  Detecting golden crosses (50/200 SMA)...");
  const gcEvents = es.detectEvents({ types: ["golden_cross"], ma: { shortPeriod: 50, longPeriod: 200 } });
  console.log(`  Found ${gcEvents.length} golden cross events`);
  if (gcEvents.length > 0) {
    const gcResults = es.run(gcEvents);
    es.printResults(gcResults);
    es.plotCAR(gcResults);
  }

  // Gap events
  console.log("\n  Detecting gap events (>2% overnight gap)...");
  const gapEvents = es.detectEvents({ types: ["gap_down"], gap: { threshold: 0.02 } });
  console.log(`  Found ${gapEvents.length} gap-down events`);
  if (gapEvents.length > 0) {
    const gapResults = es.run(gapEvents);
    es.printResults(gapResults);
    es.plotCAR(gapResults);
  }

  // Summary
  console.log("=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));
  console.log("");
  console.log("  Signal              Events  CAAR(+20)   t-stat  p-value  Sig?");
  console.log("  " + "-".repeat(62));

  const allResults = [
    { name: "RSI Oversold", results },
  ];

  if (volEvents.length > 0) allResults.push({ name: "Volume Spike", results: es.run(volEvents) });
  if (gcEvents.length > 0) allResults.push({ name: "Golden Cross", results: es.run(gcEvents) });
  if (gapEvents.length > 0) allResults.push({ name: "Gap Down", results: es.run(gapEvents) });

  for (const { name, results: r } of allResults) {
    const finalCAAR = r.caar.length > 0 ? r.caar[r.caar.length - 1] : 0;
    const sig = r.significance;
    const sigStr = sig.significant ? " ***" : "    ";
    console.log(
      `  ${name.padEnd(20)} ${String(r.validEvents).padStart(4)}  ` +
      `${(finalCAAR * 100).toFixed(3).padStart(8)}%  ` +
      `${sig.tStat.toFixed(3).padStart(7)}  ` +
      `${sig.pValue.toFixed(4).padStart(7)}  ${sigStr}`
    );
  }

  console.log("");
  console.log("  *** = statistically significant at 5% level");
  console.log("=".repeat(70));
}

// Run CLI if called directly
if (process.argv[1]?.includes("event-study.mjs")) {
  main().catch(err => {
    console.error("Event study failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
