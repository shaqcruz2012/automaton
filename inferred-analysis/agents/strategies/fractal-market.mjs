#!/usr/bin/env node
/**
 * Fractal Market Analysis — Inferred Analysis
 *
 * Applies fractal geometry to financial time series:
 * 1. Hurst exponent via rescaled range (R/S) analysis
 * 2. Box-counting fractal dimension
 * 3. Detrended fluctuation analysis (DFA)
 * 4. Multifractal spectrum width
 *
 * Usage:
 *   node agents/strategies/fractal-market.mjs
 *   import { hurstExponent, FractalAnalyzer } from './fractal-market.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Utility Helpers ─────────────────────────────────────

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function cumsum(arr) {
  const out = new Array(arr.length);
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) out[i] = out[i - 1] + arr[i];
  return out;
}

function logReturns(prices) {
  const r = new Array(prices.length - 1);
  for (let i = 1; i < prices.length; i++) {
    r[i - 1] = Math.log(prices[i] / prices[i - 1]);
  }
  return r;
}

function linregSlope(xs, ys) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function linreg(xs, ys) {
  const slope = linregSlope(xs, ys);
  const intercept = mean(ys) - slope * mean(xs);
  const predicted = xs.map(x => intercept + slope * x);
  const ssRes = ys.reduce((s, y, i) => s + (y - predicted[i]) ** 2, 0);
  const ssTot = ys.reduce((s, y) => s + (y - mean(ys)) ** 2, 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

// ─── Hurst Exponent (Rescaled Range) ────────────────────

/**
 * Compute Hurst exponent via R/S analysis.
 *   H > 0.5 → persistent (trending)
 *   H ≈ 0.5 → random walk
 *   H < 0.5 → anti-persistent (mean-reverting)
 *
 * @param {number[]} prices - raw price series
 * @param {number}   maxLag - maximum sub-series length (default: floor(N/2))
 * @returns {{ H: number, r2: number, points: {logN: number, logRS: number}[] }}
 */
export function hurstExponent(prices, maxLag) {
  const returns = logReturns(prices);
  const N = returns.length;
  if (N < 20) throw new Error("Need at least 20 prices for Hurst estimation");

  maxLag = maxLag || Math.floor(N / 2);
  const minLag = 10;

  // Generate lag sizes: powers of 2 plus some intermediate points
  const lags = [];
  for (let n = minLag; n <= maxLag; n = Math.floor(n * 1.4)) {
    if (n <= N) lags.push(n);
  }
  if (lags.length < 3) {
    for (let n = minLag; n <= Math.min(maxLag, N); n += Math.max(1, Math.floor((maxLag - minLag) / 5))) {
      if (!lags.includes(n)) lags.push(n);
    }
    lags.sort((a, b) => a - b);
  }

  const points = [];

  for (const n of lags) {
    const numBlocks = Math.floor(N / n);
    if (numBlocks < 1) continue;

    let rsSum = 0;
    let validBlocks = 0;

    for (let b = 0; b < numBlocks; b++) {
      const block = returns.slice(b * n, (b + 1) * n);
      const m = mean(block);
      const sigma = std(block);
      if (sigma === 0) continue;

      // Mean-adjusted cumulative deviations
      const deviations = block.map(v => v - m);
      const Y = cumsum(deviations);
      const R = Math.max(...Y) - Math.min(...Y);
      rsSum += R / sigma;
      validBlocks++;
    }

    if (validBlocks > 0) {
      const avgRS = rsSum / validBlocks;
      points.push({ logN: Math.log(n), logRS: Math.log(avgRS) });
    }
  }

  if (points.length < 2) throw new Error("Insufficient data for Hurst estimation");

  const reg = linreg(points.map(p => p.logN), points.map(p => p.logRS));
  return { H: reg.slope, r2: reg.r2, points };
}

// ─── Box-Counting Fractal Dimension ─────────────────────

/**
 * Estimate fractal dimension of a price series via box-counting.
 * For a smooth curve D ≈ 1, for space-filling D → 2.
 * Financial series typically 1.3–1.7.
 *
 * @param {number[]} prices - raw price series
 * @param {number[]} boxSizes - optional array of box sizes to test
 * @returns {{ D: number, r2: number, points: {logEps: number, logN: number}[] }}
 */
export function fractalDimension(prices, boxSizes) {
  const N = prices.length;
  if (N < 20) throw new Error("Need at least 20 prices for fractal dimension");

  // Normalize prices to [0, 1]
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const range = pMax - pMin || 1;
  const norm = prices.map(p => (p - pMin) / range);

  // Time axis normalized to [0, 1]
  const tNorm = prices.map((_, i) => i / (N - 1));

  if (!boxSizes || boxSizes.length === 0) {
    boxSizes = [];
    for (let s = 0.01; s <= 0.5; s *= 1.5) boxSizes.push(s);
  }

  const points = [];

  for (const eps of boxSizes) {
    // Count how many boxes of size eps x eps are needed to cover the curve
    const boxes = new Set();
    for (let i = 0; i < N; i++) {
      const bx = Math.floor(tNorm[i] / eps);
      const by = Math.floor(norm[i] / eps);
      boxes.add(`${bx},${by}`);
    }

    // Also cover line segments between consecutive points
    for (let i = 0; i < N - 1; i++) {
      const steps = Math.max(1, Math.ceil(Math.abs(norm[i + 1] - norm[i]) / eps) + 1);
      for (let s = 0; s <= steps; s++) {
        const frac = s / steps;
        const tx = tNorm[i] + frac * (tNorm[i + 1] - tNorm[i]);
        const py = norm[i] + frac * (norm[i + 1] - norm[i]);
        boxes.add(`${Math.floor(tx / eps)},${Math.floor(py / eps)}`);
      }
    }

    points.push({ logEps: Math.log(1 / eps), logN: Math.log(boxes.size) });
  }

  const reg = linreg(points.map(p => p.logEps), points.map(p => p.logN));
  return { D: reg.slope, r2: reg.r2, points };
}

// ─── Detrended Fluctuation Analysis ─────────────────────

/**
 * DFA for detecting long-range correlations in non-stationary series.
 * Alpha > 0.5 → long-range positive correlations (trending)
 * Alpha ≈ 0.5 → uncorrelated (white noise)
 * Alpha < 0.5 → long-range anti-correlations (mean-reverting)
 *
 * @param {number[]} prices - raw price series
 * @param {number[]} scales - optional window sizes for DFA
 * @returns {{ alpha: number, r2: number, points: {logS: number, logF: number}[] }}
 */
export function detrendedFluctuationAnalysis(prices, scales) {
  const returns = logReturns(prices);
  const N = returns.length;
  if (N < 30) throw new Error("Need at least 30 prices for DFA");

  // Step 1: Integrate (cumulative sum of mean-subtracted returns)
  const m = mean(returns);
  const profile = cumsum(returns.map(r => r - m));

  // Step 2: Generate scales if not provided
  if (!scales || scales.length === 0) {
    scales = [];
    for (let s = 8; s <= Math.floor(N / 4); s = Math.floor(s * 1.4)) {
      scales.push(s);
    }
  }

  const points = [];

  for (const s of scales) {
    const numSegments = Math.floor(N / s);
    if (numSegments < 1) continue;

    let fluctuation = 0;
    let count = 0;

    for (let seg = 0; seg < numSegments; seg++) {
      const start = seg * s;
      const segment = profile.slice(start, start + s);

      // Local linear detrend
      const xs = segment.map((_, i) => i);
      const slope = linregSlope(xs, segment);
      const intercept = mean(segment) - slope * mean(xs);

      let variance = 0;
      for (let i = 0; i < s; i++) {
        const trend = intercept + slope * i;
        variance += (segment[i] - trend) ** 2;
      }
      fluctuation += variance / s;
      count++;
    }

    if (count > 0) {
      const F = Math.sqrt(fluctuation / count);
      if (F > 0) {
        points.push({ logS: Math.log(s), logF: Math.log(F) });
      }
    }
  }

  if (points.length < 2) throw new Error("Insufficient scales for DFA");

  const reg = linreg(points.map(p => p.logS), points.map(p => p.logF));
  return { alpha: reg.slope, r2: reg.r2, points };
}

// ─── Multifractal Spectrum ──────────────────────────────

/**
 * Estimate multifractal spectrum width via generalized Hurst exponents h(q).
 * Wide spectrum → complex multifractal dynamics.
 * Narrow spectrum → monofractal (simpler structure).
 *
 * @param {number[]} prices - raw price series
 * @returns {{ width: number, hq: {q: number, hurst: number}[], peak: number }}
 */
export function multifractalSpectrum(prices) {
  const returns = logReturns(prices);
  const N = returns.length;
  if (N < 50) throw new Error("Need at least 50 prices for multifractal analysis");

  // q-values from -5 to 5 (skip 0)
  const qValues = [];
  for (let q = -5; q <= 5; q += 0.5) {
    if (Math.abs(q) > 0.01) qValues.push(q);
  }

  // Scales for partition function
  const scales = [];
  for (let s = 8; s <= Math.floor(N / 4); s = Math.floor(s * 1.5)) {
    scales.push(s);
  }

  if (scales.length < 2) throw new Error("Series too short for multifractal analysis");

  const hq = [];

  for (const q of qValues) {
    const logScales = [];
    const logPartition = [];

    for (const s of scales) {
      const numBlocks = Math.floor(N / s);
      if (numBlocks < 1) continue;

      let partitionSum = 0;
      let validBlocks = 0;

      for (let b = 0; b < numBlocks; b++) {
        const block = returns.slice(b * s, (b + 1) * s);
        // Local variance
        const blockMean = mean(block);
        let variance = 0;
        for (let i = 0; i < block.length; i++) {
          variance += (block[i] - blockMean) ** 2;
        }
        variance /= block.length;

        if (variance > 0) {
          partitionSum += Math.pow(variance, q / 2);
          validBlocks++;
        }
      }

      if (validBlocks > 0) {
        logScales.push(Math.log(s));
        logPartition.push(Math.log(partitionSum / validBlocks));
      }
    }

    if (logScales.length >= 2) {
      const slope = linregSlope(logScales, logPartition);
      // Generalized Hurst: h(q) = slope / q + 0.5 (for variance-based)
      const h = slope / q;
      hq.push({ q, hurst: h });
    }
  }

  if (hq.length < 3) throw new Error("Could not compute multifractal spectrum");

  const hValues = hq.map(p => p.hurst);
  const width = Math.max(...hValues) - Math.min(...hValues);

  // Peak: h(q=2) corresponds to standard Hurst
  const h2 = hq.find(p => Math.abs(p.q - 2) < 0.01);
  const peak = h2 ? h2.hurst : mean(hValues);

  return { width, hq, peak };
}

// ─── FractalAnalyzer Class ──────────────────────────────

export class FractalAnalyzer {
  constructor() {
    this.results = null;
  }

  /**
   * Run all fractal analyses on a price series.
   * @param {number[]} prices - array of close prices
   * @returns {object} combined results from all analyses
   */
  analyze(prices) {
    this.results = {
      n: prices.length,
      hurst: hurstExponent(prices),
      dimension: fractalDimension(prices),
      dfa: detrendedFluctuationAnalysis(prices),
      multifractal: multifractalSpectrum(prices),
    };
    return this.results;
  }

  /**
   * Classify market character based on fractal properties.
   * @returns {{ regime: string, confidence: number, details: string }}
   */
  getMarketCharacter() {
    if (!this.results) throw new Error("Call analyze() first");

    const H = this.results.hurst.H;
    const alpha = this.results.dfa.alpha;
    const D = this.results.dimension.D;
    const mfWidth = this.results.multifractal.width;

    // Combine Hurst and DFA for robust classification
    const trendScore = (H + alpha) / 2;

    let regime, confidence, details;

    if (trendScore > 0.6) {
      regime = "TRENDING";
      confidence = Math.min(0.95, (trendScore - 0.5) * 4);
      details = `Strong persistence (H=${H.toFixed(3)}, DFA-alpha=${alpha.toFixed(3)}). `
        + `Price moves tend to continue. Momentum strategies favored.`;
    } else if (trendScore < 0.4) {
      regime = "MEAN-REVERTING";
      confidence = Math.min(0.95, (0.5 - trendScore) * 4);
      details = `Anti-persistent dynamics (H=${H.toFixed(3)}, DFA-alpha=${alpha.toFixed(3)}). `
        + `Price moves tend to reverse. Contrarian strategies favored.`;
    } else {
      regime = "RANDOM-WALK";
      confidence = 1 - Math.abs(trendScore - 0.5) * 4;
      details = `Near-efficient market (H=${H.toFixed(3)}, DFA-alpha=${alpha.toFixed(3)}). `
        + `No exploitable serial dependence detected.`;
    }

    // Multifractal complexity modifies confidence
    if (mfWidth > 0.5) {
      details += ` High multifractal complexity (width=${mfWidth.toFixed(3)}) `
        + `suggests regime-switching behavior.`;
      confidence *= 0.85; // reduce confidence in single-regime label
    }

    // Fractal dimension adds texture
    if (D > 1.6) {
      details += ` High fractal dimension (D=${D.toFixed(3)}) indicates rough, volatile path.`;
    } else if (D < 1.3) {
      details += ` Low fractal dimension (D=${D.toFixed(3)}) indicates smoother price trajectory.`;
    }

    return { regime, confidence: +confidence.toFixed(3), details };
  }

  /**
   * Suggest optimal strategy type given fractal properties.
   * @returns {{ strategy: string, params: object, rationale: string }}
   */
  getOptimalStrategy() {
    if (!this.results) throw new Error("Call analyze() first");

    const { regime, confidence } = this.getMarketCharacter();
    const H = this.results.hurst.H;
    const mfWidth = this.results.multifractal.width;

    if (regime === "TRENDING" && confidence > 0.3) {
      return {
        strategy: "TREND-FOLLOWING",
        params: {
          lookback: Math.round(20 + (H - 0.5) * 100),
          stopMultiple: 2.0 - (H - 0.5),
          positionSizing: "volatility-scaled",
        },
        rationale: `Hurst=${H.toFixed(3)} indicates persistent trends. `
          + `Use longer lookbacks to capture momentum. `
          + `Tighter stops as H approaches 0.5.`,
      };
    }

    if (regime === "MEAN-REVERTING" && confidence > 0.3) {
      return {
        strategy: "MEAN-REVERSION",
        params: {
          entryZScore: 1.5 + (0.5 - H) * 2,
          exitZScore: 0.3,
          lookback: Math.round(15 + (0.5 - H) * 50),
          positionSizing: "fixed-fractional",
        },
        rationale: `Hurst=${H.toFixed(3)} indicates anti-persistence. `
          + `Enter on extreme deviations, exit near mean. `
          + `Wider entry bands as mean-reversion strengthens.`,
      };
    }

    // Random walk or low confidence: use volatility strategies
    return {
      strategy: "VOLATILITY-HARVESTING",
      params: {
        type: mfWidth > 0.4 ? "straddle" : "iron-condor",
        impliedVolAdj: mfWidth > 0.4 ? 1.2 : 0.9,
        rebalanceDays: 5,
        positionSizing: "risk-parity",
      },
      rationale: `No clear directional edge (H=${H.toFixed(3)}). `
        + `${mfWidth > 0.4 ? "High multifractal width suggests vol-of-vol opportunity." : "Sell premium in range-bound conditions."}`,
    };
  }

  /**
   * Compute rolling Hurst exponent over a sliding window.
   * @param {number[]} prices - raw price series
   * @param {number}   window - lookback window (default: 100)
   * @param {number}   step   - step size between windows (default: 10)
   * @returns {{ index: number, H: number, r2: number }[]}
   */
  rollingHurst(prices, window = 100, step = 10) {
    const results = [];
    for (let i = 0; i + window <= prices.length; i += step) {
      const slice = prices.slice(i, i + window);
      try {
        const { H, r2 } = hurstExponent(slice);
        results.push({ index: i + window - 1, H, r2 });
      } catch {
        // skip windows with insufficient data
      }
    }
    return results;
  }

  /**
   * Generate a formatted ASCII report of fractal analysis.
   * @returns {string}
   */
  formatReport() {
    if (!this.results) throw new Error("Call analyze() first");

    const r = this.results;
    const char = this.getMarketCharacter();
    const strat = this.getOptimalStrategy();

    const bar = (val, min, max, width = 30) => {
      const pct = Math.max(0, Math.min(1, (val - min) / (max - min)));
      const filled = Math.round(pct * width);
      return "#".repeat(filled) + ".".repeat(width - filled);
    };

    const lines = [
      "",
      "=".repeat(64),
      "  FRACTAL MARKET ANALYSIS REPORT",
      "=".repeat(64),
      "",
      `  Sample size:    ${r.n} observations`,
      "",
      "--- Hurst Exponent (R/S Analysis) ---",
      `  H = ${r.hurst.H.toFixed(4)}  (R2 = ${r.hurst.r2.toFixed(3)})`,
      `  [MeanRev] 0.0 |${bar(r.hurst.H, 0, 1)}| 1.0 [Trend]`,
      `             ${r.hurst.H < 0.45 ? "<<<" : r.hurst.H > 0.55 ? "              >>>" : "         ==="}`,
      "",
      "--- Fractal Dimension (Box-Counting) ---",
      `  D = ${r.dimension.D.toFixed(4)}  (R2 = ${r.dimension.r2.toFixed(3)})`,
      `  [Smooth]  1.0 |${bar(r.dimension.D, 1, 2)}| 2.0 [Rough]`,
      "",
      "--- Detrended Fluctuation Analysis ---",
      `  alpha = ${r.dfa.alpha.toFixed(4)}  (R2 = ${r.dfa.r2.toFixed(3)})`,
      `  [AntiCorr] 0.0 |${bar(r.dfa.alpha, 0, 1.5)}| 1.5 [LongMem]`,
      "",
      "--- Multifractal Spectrum ---",
      `  Spectrum width = ${r.multifractal.width.toFixed(4)}`,
      `  Peak h(q=2)    = ${r.multifractal.peak.toFixed(4)}`,
      `  [Mono]    0.0 |${bar(r.multifractal.width, 0, 1)}| 1.0 [Multi]`,
      "",
      "--- Market Character ---",
      `  Regime:     ${char.regime}`,
      `  Confidence: ${(char.confidence * 100).toFixed(1)}%`,
      `  ${char.details}`,
      "",
      "--- Optimal Strategy ---",
      `  Type: ${strat.strategy}`,
      `  Params: ${JSON.stringify(strat.params, null, 2).split("\n").join("\n          ")}`,
      `  Rationale: ${strat.rationale}`,
      "",
      "=".repeat(64),
      "",
    ];

    return lines.join("\n");
  }
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("\n  Fractal Market Analysis — Inferred Analysis\n");

  const symbols = ["SPY", "AAPL", "TSLA", "GLD"];

  for (const symbol of symbols) {
    console.log(`\n  Analyzing ${symbol}...`);
    const data = generateRealisticPrices(symbol);
    const closes = data.map(d => d.close);

    const analyzer = new FractalAnalyzer();
    analyzer.analyze(closes);
    console.log(analyzer.formatReport());

    // Rolling Hurst
    const rolling = analyzer.rollingHurst(closes, 120, 20);
    if (rolling.length > 0) {
      console.log("  Rolling Hurst (window=120, step=20):");
      const step = Math.max(1, Math.floor(rolling.length / 8));
      for (let i = 0; i < rolling.length; i += step) {
        const r = rolling[i];
        const barLen = Math.round(r.H * 30);
        console.log(`    day ${String(r.index).padStart(5)}: H=${r.H.toFixed(3)} |${"#".repeat(barLen)}${".".repeat(30 - barLen)}|`);
      }
      console.log("");
    }
  }

  console.log("  Done.\n");
}

if (process.argv[1]?.includes("fractal-market")) {
  main().catch(err => {
    console.error("Fractal analysis failed:", err.message);
    process.exit(1);
  });
}
