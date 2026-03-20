#!/usr/bin/env node
/**
 * Signal Blender — Inferred Analysis Ensemble System
 *
 * Combines alpha signals using quant fund blending techniques:
 *   - Equal weight, IC-weighted, decay-weighted, rank-weighted, z-score combined
 *   - Cross-signal IC matrix and marginal IC analysis
 *   - Gram-Schmidt orthogonalization for redundancy removal
 *   - Greedy forward selection by marginal information coefficient
 *
 * Usage:
 *   import { SignalBlender, zScoreNormalize, rankNormalize, informationCoefficient } from './signal-blender.mjs';
 *   const blender = new SignalBlender();
 *   blender.addSignal('momentum', values, { halfLife: 20 });
 *   const combined = blender.blend('ic_weighted');
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Utility Functions ──────────────────────────────────────

/** Spearman rank array — assigns average rank for ties. */
function spearmanRanks(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank;
    i = j;
  }
  return ranks;
}

/** Pearson correlation of two arrays. */
function pearson(a, b) {
  const n = a.length;
  if (n < 3) return 0;
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i]; sumB += b[i];
    sumAB += a[i] * b[i];
    sumA2 += a[i] * a[i]; sumB2 += b[i] * b[i];
  }
  const num = n * sumAB - sumA * sumB;
  const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
  return den === 0 ? 0 : num / den;
}

/** Mean of numeric array. */
function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Standard deviation of numeric array. */
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// ─── Exported Standalone Functions ──────────────────────────

/**
 * Rolling z-score normalization.
 * For each point, z = (x - mean_lookback) / std_lookback.
 */
export function zScoreNormalize(values, lookback = 60) {
  const result = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - lookback + 1);
    const window = values.slice(start, i + 1);
    const m = mean(window);
    const s = std(window);
    result[i] = s === 0 ? 0 : (values[i] - m) / s;
  }
  return result;
}

/**
 * Cross-sectional rank normalization.
 * Maps values to [-1, 1] range based on rank position.
 */
export function rankNormalize(values) {
  const ranks = spearmanRanks(values);
  const n = values.length;
  return ranks.map(r => 2 * (r - 1) / (n - 1) - 1);
}

/**
 * Information Coefficient — Spearman rank correlation between
 * signal values and subsequent forward returns.
 */
export function informationCoefficient(signal, forwardReturns) {
  const n = Math.min(signal.length, forwardReturns.length);
  if (n < 5) return 0;
  const sig = signal.slice(0, n);
  const ret = forwardReturns.slice(0, n);
  const rSig = spearmanRanks(sig);
  const rRet = spearmanRanks(ret);
  return pearson(rSig, rRet);
}

/**
 * IC Information Ratio — mean(IC) / std(IC).
 * Measures consistency of a signal's predictive power.
 */
export function icInformationRatio(icSeries) {
  if (icSeries.length < 3) return 0;
  const m = mean(icSeries);
  const s = std(icSeries);
  return s === 0 ? 0 : m / s;
}

// ─── SignalBlender Class ────────────────────────────────────

export class SignalBlender {
  constructor() {
    this.signals = new Map();        // name → { values, metadata }
    this.forwardReturns = null;      // set externally for IC calculations
  }

  /** Register a signal series with optional metadata. */
  addSignal(name, values, metadata = {}) {
    this.signals.set(name, { values: [...values], metadata });
  }

  /** Set forward returns for IC-based operations. */
  setForwardReturns(returns) {
    this.forwardReturns = returns;
  }

  /** Blend signals using the specified method. */
  blend(method = "equal") {
    const names = [...this.signals.keys()];
    if (names.length === 0) return [];
    const len = Math.min(...names.map(n => this.signals.get(n).values.length));

    switch (method) {
      case "equal":          return this._blendEqual(names, len);
      case "ic_weighted":    return this._blendICWeighted(names, len);
      case "decay_weighted": return this._blendDecayWeighted(names, len);
      case "rank_weighted":  return this._blendRankWeighted(names, len);
      case "zscore_combined": return this._blendZScore(names, len);
      default: throw new Error(`Unknown blend method: ${method}`);
    }
  }

  _blendEqual(names, len) {
    const result = new Array(len).fill(0);
    for (const name of names) {
      const vals = this.signals.get(name).values;
      for (let i = 0; i < len; i++) result[i] += vals[i] / names.length;
    }
    return result;
  }

  _blendICWeighted(names, len) {
    if (!this.forwardReturns) throw new Error("Set forwardReturns for IC weighting");
    const weights = {};
    let totalW = 0;
    for (const name of names) {
      const ic = Math.max(0, informationCoefficient(this.signals.get(name).values, this.forwardReturns));
      weights[name] = ic;
      totalW += ic;
    }
    if (totalW === 0) return this._blendEqual(names, len);
    const result = new Array(len).fill(0);
    for (const name of names) {
      const vals = this.signals.get(name).values;
      const w = weights[name] / totalW;
      for (let i = 0; i < len; i++) result[i] += vals[i] * w;
    }
    return result;
  }

  _blendDecayWeighted(names, len) {
    const result = new Array(len).fill(0);
    for (const name of names) {
      const halfLife = this.signals.get(name).metadata.halfLife || 20;
      const lambda = Math.log(2) / halfLife;
      const vals = this.signals.get(name).values;
      for (let i = 0; i < len; i++) {
        const age = len - 1 - i;
        result[i] += vals[i] * Math.exp(-lambda * age) / names.length;
      }
    }
    return result;
  }

  _blendRankWeighted(names, len) {
    const result = new Array(len).fill(0);
    for (const name of names) {
      const ranked = rankNormalize(this.signals.get(name).values.slice(0, len));
      for (let i = 0; i < len; i++) result[i] += ranked[i] / names.length;
    }
    return result;
  }

  _blendZScore(names, len) {
    const result = new Array(len).fill(0);
    for (const name of names) {
      const zs = zScoreNormalize(this.signals.get(name).values.slice(0, len), 60);
      for (let i = 0; i < len; i++) result[i] += zs[i] / names.length;
    }
    return result;
  }

  /** Cross-signal information coefficient matrix. */
  getICMatrix() {
    const names = [...this.signals.keys()];
    const matrix = {};
    for (const a of names) {
      matrix[a] = {};
      const valsA = this.signals.get(a).values;
      for (const b of names) {
        const valsB = this.signals.get(b).values;
        const n = Math.min(valsA.length, valsB.length);
        matrix[a][b] = +pearson(
          spearmanRanks(valsA.slice(0, n)),
          spearmanRanks(valsB.slice(0, n))
        ).toFixed(4);
      }
    }
    return matrix;
  }

  /** Autocorrelation / decay profile of a signal up to maxLag. */
  getSignalDecay(name, maxLag = 20) {
    const vals = this.signals.get(name)?.values;
    if (!vals) throw new Error(`Signal "${name}" not found`);
    const decay = [];
    for (let lag = 1; lag <= maxLag; lag++) {
      const a = vals.slice(0, vals.length - lag);
      const b = vals.slice(lag);
      decay.push({ lag, autocorrelation: +pearson(a, b).toFixed(4) });
    }
    return decay;
  }

  /** Gram-Schmidt orthogonalization — remove redundancy between signals. */
  orthogonalize() {
    const names = [...this.signals.keys()];
    if (names.length < 2) return;

    const ortho = new Map();
    for (let i = 0; i < names.length; i++) {
      let vec = [...this.signals.get(names[i]).values];
      // Subtract projections of all previously orthogonalized signals
      for (let j = 0; j < i; j++) {
        const basis = ortho.get(names[j]);
        const n = Math.min(vec.length, basis.length);
        let dot = 0, basisNorm = 0;
        for (let k = 0; k < n; k++) {
          dot += vec[k] * basis[k];
          basisNorm += basis[k] * basis[k];
        }
        if (basisNorm > 0) {
          const proj = dot / basisNorm;
          for (let k = 0; k < n; k++) vec[k] -= proj * basis[k];
        }
      }
      ortho.set(names[i], vec);
    }

    // Update signals in place
    for (const [name, values] of ortho) {
      this.signals.get(name).values = values;
    }
  }

  /** Marginal IC contribution of adding a signal to the existing blend. */
  getMarginialIC(name) {
    if (!this.forwardReturns) throw new Error("Set forwardReturns for marginal IC");
    const target = this.signals.get(name);
    if (!target) throw new Error(`Signal "${name}" not found`);

    const others = [...this.signals.keys()].filter(n => n !== name);
    if (others.length === 0) {
      return informationCoefficient(target.values, this.forwardReturns);
    }

    // IC of blend without this signal
    const len = Math.min(...others.map(n => this.signals.get(n).values.length), this.forwardReturns.length);
    const blendWithout = new Array(len).fill(0);
    for (const n of others) {
      const v = this.signals.get(n).values;
      for (let i = 0; i < len; i++) blendWithout[i] += v[i] / others.length;
    }
    const icWithout = informationCoefficient(blendWithout, this.forwardReturns);

    // IC of blend with this signal
    const allNames = [...others, name];
    const blendWith = new Array(len).fill(0);
    for (const n of allNames) {
      const v = this.signals.get(n).values;
      for (let i = 0; i < len; i++) blendWith[i] += v[i] / allNames.length;
    }
    const icWith = informationCoefficient(blendWith, this.forwardReturns);

    return +(icWith - icWithout).toFixed(6);
  }

  /** Greedy forward selection — pick up to maxSignals by marginal IC. */
  selectSignals(maxSignals = 5) {
    if (!this.forwardReturns) throw new Error("Set forwardReturns for signal selection");
    const candidates = [...this.signals.keys()];
    const selected = [];
    const available = new Set(candidates);

    while (selected.length < maxSignals && available.size > 0) {
      let bestName = null, bestIC = -Infinity;
      for (const name of available) {
        // Build temporary blend of selected + candidate
        const trial = [...selected, name];
        const len = Math.min(...trial.map(n => this.signals.get(n).values.length), this.forwardReturns.length);
        const blend = new Array(len).fill(0);
        for (const n of trial) {
          const v = this.signals.get(n).values;
          for (let i = 0; i < len; i++) blend[i] += v[i] / trial.length;
        }
        const ic = informationCoefficient(blend, this.forwardReturns);
        if (ic > bestIC) { bestIC = ic; bestName = name; }
      }
      if (bestIC <= 0 && selected.length > 0) break;
      selected.push(bestName);
      available.delete(bestName);
    }

    return selected.map((name, rank) => {
      const ic = informationCoefficient(this.signals.get(name).values, this.forwardReturns);
      return { rank: rank + 1, name, ic: +ic.toFixed(4) };
    });
  }

  /** ASCII blend quality report. */
  getBlendReport() {
    const names = [...this.signals.keys()];
    const lines = [];
    lines.push("╔══════════════════════════════════════════════════════╗");
    lines.push("║            SIGNAL BLEND QUALITY REPORT              ║");
    lines.push("╠══════════════════════════════════════════════════════╣");

    // Individual signal stats
    lines.push("║  Signal               │   IC   │ IC IR │ Decay(5) ║");
    lines.push("║───────────────────────┼────────┼───────┼──────────║");
    for (const name of names) {
      const vals = this.signals.get(name).values;
      let ic = "  N/A ";
      let ir = " N/A ";
      if (this.forwardReturns) {
        const icVal = informationCoefficient(vals, this.forwardReturns);
        ic = (icVal >= 0 ? " " : "") + icVal.toFixed(3);
        // Rolling IC series (60-day windows)
        const icSeries = [];
        const windowSize = 60;
        for (let i = 0; i + windowSize < Math.min(vals.length, this.forwardReturns.length); i += 20) {
          const s = vals.slice(i, i + windowSize);
          const r = this.forwardReturns.slice(i, i + windowSize);
          icSeries.push(informationCoefficient(s, r));
        }
        ir = icSeries.length > 2 ? icInformationRatio(icSeries).toFixed(2) : " N/A ";
      }
      const decay5 = this.getSignalDecay(name, 5);
      const d5 = decay5[4]?.autocorrelation.toFixed(2) || "N/A ";
      const padded = name.padEnd(21).slice(0, 21);
      lines.push(`║  ${padded} │ ${ic} │ ${ir.toString().padStart(5)} │   ${d5.toString().padStart(5)}  ║`);
    }

    // IC correlation matrix
    lines.push("╠══════════════════════════════════════════════════════╣");
    lines.push("║  IC Cross-Correlation Matrix                        ║");
    lines.push("║───────────────────────────────────────────────────── ║");
    const matrix = this.getICMatrix();
    const short = names.map(n => n.slice(0, 8).padEnd(8));
    lines.push("║         " + short.join(" ") + " ║");
    for (let i = 0; i < names.length; i++) {
      let row = "║  " + short[i];
      for (let j = 0; j < names.length; j++) {
        const v = matrix[names[i]][names[j]];
        row += (v >= 0 ? " " : "") + v.toFixed(2) + "  ";
      }
      lines.push(row + "║");
    }

    // Blend comparison
    if (this.forwardReturns) {
      lines.push("╠══════════════════════════════════════════════════════╣");
      lines.push("║  Blend Method Comparison                            ║");
      lines.push("║───────────────────────────────────────────────────── ║");
      for (const method of ["equal", "ic_weighted", "decay_weighted", "rank_weighted", "zscore_combined"]) {
        try {
          const blended = this.blend(method);
          const ic = informationCoefficient(blended, this.forwardReturns);
          const bar = "█".repeat(Math.max(0, Math.round((ic + 0.1) * 40)));
          const label = method.padEnd(17);
          lines.push(`║  ${label} IC=${(ic >= 0 ? " " : "") + ic.toFixed(3)}  ${bar.slice(0, 18)} ║`);
        } catch { /* skip if method fails */ }
      }
    }

    lines.push("╚══════════════════════════════════════════════════════╝");
    return lines.join("\n");
  }
}

// ─── CLI Demo ───────────────────────────────────────────────

function generateSignalFromPrices(prices, type) {
  const closes = prices.map(p => p.close);
  const n = closes.length;

  if (type === "momentum") {
    // 20-day momentum (rate of change)
    return closes.map((c, i) => i < 20 ? 0 : (c - closes[i - 20]) / closes[i - 20]);
  }
  if (type === "mean_reversion") {
    // Distance from 50-day SMA, inverted
    const sma = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += closes[i];
      if (i >= 50) sum -= closes[i - 50];
      sma.push(i >= 49 ? sum / 50 : closes[i]);
    }
    return closes.map((c, i) => -(c - sma[i]) / sma[i]);
  }
  if (type === "volatility") {
    // Inverse realized vol (low vol = bullish signal)
    const ret = closes.map((c, i) => i === 0 ? 0 : Math.log(c / closes[i - 1]));
    return ret.map((_, i) => {
      if (i < 20) return 0;
      const window = ret.slice(i - 20, i);
      const s = std(window);
      return s > 0 ? -s : 0;
    });
  }
  if (type === "volume_trend") {
    // Volume-weighted price trend
    const vols = prices.map(p => p.volume);
    return closes.map((c, i) => {
      if (i < 30) return 0;
      let vwap = 0, volSum = 0;
      for (let j = i - 30; j < i; j++) {
        vwap += closes[j] * vols[j];
        volSum += vols[j];
      }
      vwap /= volSum;
      return (c - vwap) / vwap;
    });
  }
  if (type === "breakout") {
    // Distance from 60-day high, normalized
    return closes.map((c, i) => {
      if (i < 60) return 0;
      const high = Math.max(...closes.slice(i - 60, i));
      return (c - high) / high;
    });
  }
  return closes.map(() => 0);
}

async function main() {
  console.log("Signal Blender — CLI Demo\n");
  console.log("Generating simulated price data...");

  const prices = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  const closes = prices.map(p => p.close);

  // Forward returns (1-day)
  const fwdReturns = closes.map((c, i) =>
    i < closes.length - 1 ? (closes[i + 1] - c) / c : 0
  );

  // Generate diverse signals
  const signalTypes = ["momentum", "mean_reversion", "volatility", "volume_trend", "breakout"];

  const blender = new SignalBlender();
  blender.setForwardReturns(fwdReturns);

  console.log("\nGenerating alpha signals:");
  for (const type of signalTypes) {
    const raw = generateSignalFromPrices(prices, type);
    const normalized = zScoreNormalize(raw, 60);
    blender.addSignal(type, normalized, { halfLife: type === "momentum" ? 10 : 30 });
    const ic = informationCoefficient(normalized, fwdReturns);
    console.log(`  ${type.padEnd(18)} IC = ${ic.toFixed(4)}  (${normalized.length} obs)`);
  }

  // IC matrix
  console.log("\n─── Cross-Signal IC Matrix ───");
  const matrix = blender.getICMatrix();
  const names = Object.keys(matrix);
  const hdr = "              " + names.map(n => n.slice(0, 8).padEnd(9)).join("");
  console.log(hdr);
  for (const a of names) {
    let row = a.slice(0, 13).padEnd(14);
    for (const b of names) {
      const v = matrix[a][b];
      row += ((v >= 0 ? " " : "") + v.toFixed(3)).padEnd(9);
    }
    console.log(row);
  }

  // Signal decay
  console.log("\n─── Signal Decay (Autocorrelation) ───");
  for (const name of ["momentum", "mean_reversion"]) {
    const decay = blender.getSignalDecay(name, 10);
    const profile = decay.map(d => `${d.lag}:${d.autocorrelation.toFixed(2)}`).join("  ");
    console.log(`  ${name.padEnd(18)} ${profile}`);
  }

  // Blend comparison
  console.log("\n─── Blend Method Comparison ───");
  for (const method of ["equal", "ic_weighted", "decay_weighted", "rank_weighted", "zscore_combined"]) {
    const blended = blender.blend(method);
    const ic = informationCoefficient(blended, fwdReturns);
    const icSeries = [];
    for (let i = 0; i + 60 < Math.min(blended.length, fwdReturns.length); i += 20) {
      icSeries.push(informationCoefficient(blended.slice(i, i + 60), fwdReturns.slice(i, i + 60)));
    }
    const ir = icSeries.length > 2 ? icInformationRatio(icSeries) : 0;
    console.log(`  ${method.padEnd(17)} IC = ${ic.toFixed(4)}  ICIR = ${ir.toFixed(2)}`);
  }

  // Orthogonalization
  console.log("\n─── Orthogonalization ───");
  const blenderOrtho = new SignalBlender();
  blenderOrtho.setForwardReturns(fwdReturns);
  for (const type of signalTypes) {
    const raw = generateSignalFromPrices(prices, type);
    blenderOrtho.addSignal(type, zScoreNormalize(raw, 60), { halfLife: 20 });
  }
  console.log("  Before orthogonalization:");
  const matBefore = blenderOrtho.getICMatrix();
  console.log(`    momentum vs mean_rev corr: ${matBefore["momentum"]["mean_reversion"]}`);
  blenderOrtho.orthogonalize();
  console.log("  After orthogonalization:");
  const matAfter = blenderOrtho.getICMatrix();
  console.log(`    momentum vs mean_rev corr: ${matAfter["momentum"]["mean_reversion"]}`);

  // Signal selection
  console.log("\n─── Signal Selection (greedy forward) ───");
  const selected = blender.selectSignals(5);
  for (const s of selected) {
    console.log(`  #${s.rank}  ${s.name.padEnd(18)} standalone IC = ${s.ic.toFixed(4)}`);
  }

  // Marginal IC
  console.log("\n─── Marginal IC Contribution ───");
  for (const name of signalTypes) {
    const mic = blender.getMarginialIC(name);
    const bar = mic > 0 ? "+".repeat(Math.min(20, Math.round(mic * 500))) : "-".repeat(Math.min(20, Math.round(-mic * 500)));
    console.log(`  ${name.padEnd(18)} marginal IC = ${(mic >= 0 ? "+" : "") + mic.toFixed(4)}  ${bar}`);
  }

  // Full report
  console.log("\n" + blender.getBlendReport());
}

if (process.argv[1]?.includes("signal-blender")) {
  main().catch(err => {
    console.error("Signal blender failed:", err.message);
    process.exit(1);
  });
}
