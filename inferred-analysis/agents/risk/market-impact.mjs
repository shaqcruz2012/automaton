#!/usr/bin/env node
/**
 * Market Impact Estimator — Inferred Analysis
 *
 * Estimates market impact from historical data using multiple models:
 * 1. Almgren square-root impact model (temporary + permanent)
 * 2. Power-law impact model
 * 3. Kyle's lambda linear impact model
 * 4. Almgren-Chriss optimal execution trajectory
 * 5. Capacity estimation and impact decay curves
 *
 * Usage:
 *   node agents/risk/market-impact.mjs
 *   import { MarketImpactEstimator, squareRootModel } from './market-impact.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Square-Root Impact Model ───────────────────────────

/**
 * Almgren square-root market impact model.
 * Decomposes impact into temporary (decays) and permanent (persists) components.
 *
 * @param {number} volume - Order volume in shares
 * @param {number} avgVolume - Average daily volume
 * @param {number} volatility - Daily volatility (decimal)
 * @param {number} participation - Participation rate (fraction of volume)
 * @returns {{ temporaryImpact: number, permanentImpact: number, totalImpact: number, metadata: object }}
 */
export function squareRootModel(volume, avgVolume, volatility, participation) {
  const normalizedSize = Math.abs(volume) / avgVolume;
  const sign = volume >= 0 ? 1 : -1;

  // Temporary impact: decays after execution completes
  // eta * sigma * (Q / (V * T))^0.5
  const tempCoeff = 0.5;
  const temporaryImpact = tempCoeff * volatility * Math.sqrt(normalizedSize / participation);

  // Permanent impact: persists indefinitely
  // gamma * sigma * (Q / V)^0.5
  const permCoeff = 0.1;
  const permanentImpact = permCoeff * volatility * Math.sqrt(normalizedSize);

  const totalImpact = (temporaryImpact + permanentImpact) * sign;

  return {
    temporaryImpact: temporaryImpact * sign,
    permanentImpact: permanentImpact * sign,
    totalImpact,
    metadata: {
      normalizedSize,
      participation,
      volatility,
      tempCoeff,
      permCoeff,
    },
  };
}

// ─── Power-Law Impact Model ─────────────────────────────

/**
 * Power-law market impact model.
 * Impact = coefficient * (Q / V)^exponent * sigma
 *
 * @param {number} orderSize - Order size in shares
 * @param {number} avgVolume - Average daily volume
 * @param {number} exponent - Power-law exponent (typically 0.5–0.7)
 * @param {number} coefficient - Scaling coefficient
 * @returns {{ impact: number, normalizedSize: number, exponent: number }}
 */
export function powerLawImpact(orderSize, avgVolume, exponent = 0.6, coefficient = 0.5) {
  const normalizedSize = Math.abs(orderSize) / avgVolume;
  const sign = orderSize >= 0 ? 1 : -1;

  const impact = coefficient * Math.pow(normalizedSize, exponent) * sign;

  return {
    impact,
    normalizedSize,
    exponent,
    coefficient,
  };
}

// ─── Kyle's Lambda Linear Model ─────────────────────────

/**
 * Kyle's lambda linear market impact model.
 * Impact = lambda * orderSize, where lambda = dailyVol / avgVolume
 *
 * @param {number} orderSize - Order size in shares
 * @param {number} avgVolume - Average daily volume
 * @param {number} dailyVol - Daily volatility (decimal)
 * @returns {{ impact: number, lambda: number, orderSize: number }}
 */
export function linearImpact(orderSize, avgVolume, dailyVol) {
  const lambda = dailyVol / avgVolume;
  const impact = lambda * orderSize;

  return {
    impact,
    lambda,
    orderSize,
    costBps: Math.abs(impact) * 10000,
  };
}

// ─── Market Impact Estimator Class ──────────────────────

/**
 * Calibrates and estimates market impact from historical price/volume data.
 * Supports multiple impact models and optimal execution scheduling.
 */
export class MarketImpactEstimator {
  /**
   * @param {Array<{ close: number, volume: number, high: number, low: number }>} data - Historical OHLCV data
   */
  constructor(data) {
    this.data = data;
    this.params = null;
    this._computeBaseStats();
  }

  /** Compute baseline statistics from historical data. */
  _computeBaseStats() {
    const closes = this.data.map((d) => d.close);
    const volumes = this.data.map((d) => d.volume);

    // Daily returns
    this.returns = [];
    for (let i = 1; i < closes.length; i++) {
      this.returns.push(closes[i] / closes[i - 1] - 1);
    }

    // Average volume
    this.avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

    // Daily volatility from returns
    const meanRet = this.returns.reduce((a, b) => a + b, 0) / this.returns.length;
    const variance =
      this.returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (this.returns.length - 1);
    this.dailyVol = Math.sqrt(variance);

    // Latest price
    this.lastPrice = closes[closes.length - 1];

    // Volume volatility
    const meanVol = this.avgVolume;
    this.volumeStd = Math.sqrt(
      volumes.reduce((s, v) => s + (v - meanVol) ** 2, 0) / (volumes.length - 1)
    );
  }

  /**
   * Calibrate impact model parameters from historical data.
   * Estimates parameters from price reversals and volume patterns.
   *
   * @returns {{ tempCoeff: number, permCoeff: number, exponent: number, lambda: number, decayHalfLife: number }}
   */
  calibrate() {
    const closes = this.data.map((d) => d.close);
    const volumes = this.data.map((d) => d.volume);

    // --- Estimate temporary impact from price reversals ---
    // High volume days followed by partial reversal indicate temporary impact
    let reversalSum = 0;
    let reversalCount = 0;

    for (let i = 2; i < this.returns.length; i++) {
      const volRatio = volumes[i] / this.avgVolume;
      const prevRet = this.returns[i - 1];
      const currRet = this.returns[i];

      // Look for high-volume days with subsequent reversal
      if (volRatio > 1.5 && Math.sign(prevRet) !== Math.sign(currRet)) {
        const reversalFrac = Math.abs(currRet) / Math.max(Math.abs(prevRet), 1e-8);
        reversalSum += Math.min(reversalFrac, 1.0);
        reversalCount++;
      }
    }

    const avgReversal = reversalCount > 0 ? reversalSum / reversalCount : 0.4;
    const tempCoeff = 0.3 + avgReversal * 0.4; // Scale to reasonable range

    // --- Estimate permanent impact from volume-return correlation ---
    let sumXY = 0;
    let sumX2 = 0;

    for (let i = 1; i < this.returns.length; i++) {
      const normVol = Math.sqrt(volumes[i] / this.avgVolume);
      const absRet = Math.abs(this.returns[i]);
      sumXY += normVol * absRet;
      sumX2 += normVol * normVol;
    }

    const permCoeff = sumX2 > 0 ? (sumXY / sumX2) / this.dailyVol : 0.1;
    const clampedPermCoeff = Math.max(0.01, Math.min(0.5, permCoeff));

    // --- Estimate power-law exponent via log-log regression ---
    // Bin volume/return pairs and fit log-linear
    const bins = [];
    for (let i = 1; i < this.returns.length; i++) {
      const normVol = volumes[i] / this.avgVolume;
      if (normVol > 0.1) {
        bins.push({ logVol: Math.log(normVol), logImpact: Math.log(Math.abs(this.returns[i]) + 1e-8) });
      }
    }

    let sX = 0, sY = 0, sXX = 0, sXY = 0;
    const n = bins.length;
    for (const b of bins) {
      sX += b.logVol;
      sY += b.logImpact;
      sXX += b.logVol * b.logVol;
      sXY += b.logVol * b.logImpact;
    }
    const exponent = n > 2 ? Math.max(0.3, Math.min(0.9, (n * sXY - sX * sY) / (n * sXX - sX * sX))) : 0.5;

    // --- Kyle's lambda ---
    const lambda = this.dailyVol / this.avgVolume;

    // --- Decay half-life from autocorrelation of high-volume returns ---
    let acSum = 0;
    let acCount = 0;
    for (let lag = 1; lag <= 5; lag++) {
      for (let i = lag; i < this.returns.length; i++) {
        acSum += this.returns[i] * this.returns[i - lag];
        acCount++;
      }
    }
    const avgAC = acCount > 0 ? acSum / acCount : 0;
    const decayHalfLife = Math.max(1, Math.min(10, -1 / Math.log(Math.abs(avgAC) + 0.01)));

    this.params = {
      tempCoeff: Math.max(0.1, Math.min(1.0, tempCoeff)),
      permCoeff: clampedPermCoeff,
      exponent,
      lambda,
      decayHalfLife,
    };

    return this.params;
  }

  /**
   * Estimate market impact for a given order.
   *
   * @param {number} orderSize - Number of shares
   * @param {'buy' | 'sell'} side - Order side
   * @param {number} urgency - Urgency factor 0–1 (higher = more aggressive)
   * @returns {{ bps: number, dollars: number, temporary: number, permanent: number, participation: number }}
   */
  estimateImpact(orderSize, side = "buy", urgency = 0.5) {
    if (!this.params) this.calibrate();
    const sign = side === "buy" ? 1 : -1;
    const shares = Math.abs(orderSize);

    // Participation rate driven by urgency
    const participation = 0.01 + urgency * 0.29; // 1% to 30%

    const sqrtResult = squareRootModel(
      shares * sign,
      this.avgVolume,
      this.dailyVol,
      participation
    );

    // Urgency amplifies temporary impact
    const urgencyMultiplier = 1 + urgency * 1.5;
    const tempImpact = Math.abs(sqrtResult.temporaryImpact) * urgencyMultiplier;
    const permImpact = Math.abs(sqrtResult.permanentImpact);
    const totalBps = (tempImpact + permImpact) * 10000;
    const totalDollars = (tempImpact + permImpact) * this.lastPrice * shares;

    return {
      bps: totalBps,
      dollars: totalDollars,
      temporary: tempImpact * 10000,
      permanent: permImpact * 10000,
      participation,
      shares,
      side,
    };
  }

  /**
   * Almgren-Chriss optimal execution trajectory.
   * Minimizes E[cost] + riskAversion * Var[cost].
   *
   * @param {number} totalShares - Total shares to execute
   * @param {number} timeHorizon - Number of time slots
   * @param {number} riskAversion - Risk aversion parameter (lambda)
   * @returns {{ trajectory: Array, expectedCost: number, costVariance: number, totalBps: number }}
   */
  optimalSchedule(totalShares, timeHorizon = 20, riskAversion = 1e-6) {
    if (!this.params) this.calibrate();

    const eta = this.params.tempCoeff * this.dailyVol * 0.01; // temporary impact coeff
    const gamma = this.params.permCoeff * this.dailyVol * 0.001; // permanent impact coeff
    const sigma = this.dailyVol / Math.sqrt(timeHorizon);
    const tau = 1 / timeHorizon;

    // Almgren-Chriss kappa
    const kappaSq = (riskAversion * sigma * sigma) / (eta * (1 / tau));
    const kappa = Math.sqrt(Math.max(kappaSq, 1e-12));

    const trajectory = [];
    let remaining = totalShares;
    let expectedCost = 0;
    let costVariance = 0;

    for (let k = 0; k < timeHorizon; k++) {
      const t = k / timeHorizon;
      const denominator = 1 - Math.exp(-kappa * (1 - t));
      const fraction = denominator > 1e-12 ? (1 - Math.exp(-kappa * tau)) / denominator : 1 / (timeHorizon - k);
      const tradeSize = Math.min(remaining, remaining * fraction);

      // Per-slot costs
      const tempCost = eta * (tradeSize / tau) ** 2 * tau;
      const permCost = gamma * tradeSize;
      const slotVariance = sigma * sigma * remaining * remaining * tau;

      expectedCost += tempCost + permCost;
      costVariance += slotVariance;
      remaining -= tradeSize;

      trajectory.push({
        slot: k,
        tradeShares: Math.round(tradeSize),
        remaining: Math.round(remaining),
        pctComplete: ((totalShares - remaining) / totalShares) * 100,
        slotCost: tempCost + permCost,
      });
    }

    const totalBps = (expectedCost / (this.lastPrice * totalShares)) * 10000;

    return {
      trajectory,
      expectedCost,
      costVariance,
      costStdDev: Math.sqrt(costVariance),
      totalBps,
      kappa,
    };
  }

  /**
   * Suggested participation rate for an order.
   *
   * @param {number} totalShares - Total order size
   * @param {number} timeHorizon - Execution window in days
   * @returns {{ rate: number, barsNeeded: number, percentADV: number }}
   */
  participationRate(totalShares, timeHorizon = 1) {
    const percentADV = totalShares / this.avgVolume;
    const barsNeeded = Math.ceil(percentADV / 0.10); // target 10% max participation
    const rate = Math.min(0.25, totalShares / (this.avgVolume * timeHorizon));

    return {
      rate,
      barsNeeded,
      percentADV,
      suggestion:
        rate < 0.05 ? "Low impact — single TWAP pass" :
        rate < 0.15 ? "Moderate — split across sessions" :
        "High — multi-day execution recommended",
    };
  }

  /**
   * Estimate maximum strategy capacity before alpha erodes.
   *
   * @param {number} alpha - Expected alpha in bps per trade
   * @param {number} decayRate - Alpha decay rate per unit of impact
   * @returns {{ maxShares: number, maxDollars: number, impactAtCapacity: number, alphaRemaining: number }}
   */
  capacityEstimate(alpha, decayRate = 1.0) {
    if (!this.params) this.calibrate();

    // Impact equals alpha when capacity is reached
    // alpha = tempCoeff * sigma * sqrt(Q / V) * decayRate
    // Solving for Q: Q = V * (alpha / (tempCoeff * sigma * decayRate))^2
    const alphaDec = alpha / 10000; // convert bps to decimal
    const coeff = this.params.tempCoeff * this.dailyVol * decayRate;
    const maxNormalized = coeff > 0 ? (alphaDec / coeff) ** 2 : 0;
    const maxShares = maxNormalized * this.avgVolume;
    const maxDollars = maxShares * this.lastPrice;

    // Impact at capacity
    const impactAtCap = squareRootModel(maxShares, this.avgVolume, this.dailyVol, 0.10);
    const alphaRemaining = alpha - Math.abs(impactAtCap.totalImpact) * 10000;

    return {
      maxShares: Math.round(maxShares),
      maxDollars: Math.round(maxDollars),
      impactAtCapacity: Math.abs(impactAtCap.totalImpact) * 10000,
      alphaRemaining: Math.max(0, alphaRemaining),
      percentADV: (maxShares / this.avgVolume) * 100,
    };
  }

  /**
   * Temporary impact decay curve over time after execution.
   *
   * @param {number} orderSize - Order size in shares
   * @returns {Array<{ slot: number, remainingImpact: number, decayPct: number }>}
   */
  getDecayCurve(orderSize) {
    if (!this.params) this.calibrate();

    const impact = squareRootModel(orderSize, this.avgVolume, this.dailyVol, 0.10);
    const tempImpactBps = Math.abs(impact.temporaryImpact) * 10000;
    const halfLife = this.params.decayHalfLife;
    const decayRate = Math.log(2) / halfLife;

    const curve = [];
    for (let t = 0; t <= 20; t++) {
      const remaining = tempImpactBps * Math.exp(-decayRate * t);
      curve.push({
        slot: t,
        remainingImpact: remaining,
        decayPct: (1 - remaining / tempImpactBps) * 100,
      });
    }

    return curve;
  }

  /**
   * Generate ASCII formatted impact analysis report.
   *
   * @param {number} orderSize - Order size in shares
   * @returns {string} Formatted report
   */
  formatReport(orderSize) {
    if (!this.params) this.calibrate();

    const impact = this.estimateImpact(orderSize, "buy", 0.5);
    const schedule = this.optimalSchedule(orderSize);
    const capacity = this.capacityEstimate(50);
    const pRate = this.participationRate(orderSize);
    const decay = this.getDecayCurve(orderSize);

    const lines = [];
    lines.push("╔══════════════════════════════════════════════════════════╗");
    lines.push("║            MARKET IMPACT ANALYSIS REPORT                ║");
    lines.push("╠══════════════════════════════════════════════════════════╣");
    lines.push(`║  Order Size:     ${orderSize.toLocaleString().padStart(12)} shares              ║`);
    lines.push(`║  Avg Volume:     ${Math.round(this.avgVolume).toLocaleString().padStart(12)} shares              ║`);
    lines.push(`║  Daily Vol:      ${(this.dailyVol * 100).toFixed(2).padStart(12)}%                    ║`);
    lines.push(`║  Last Price:    $${this.lastPrice.toFixed(2).padStart(11)}                     ║`);
    lines.push("╠══════════════════════════════════════════════════════════╣");
    lines.push("║  IMPACT ESTIMATES                                       ║");
    lines.push(`║  Temporary:      ${impact.temporary.toFixed(2).padStart(12)} bps                 ║`);
    lines.push(`║  Permanent:      ${impact.permanent.toFixed(2).padStart(12)} bps                 ║`);
    lines.push(`║  Total Impact:   ${impact.bps.toFixed(2).padStart(12)} bps                 ║`);
    lines.push(`║  Cost ($):      $${impact.dollars.toFixed(0).padStart(11)}                     ║`);
    lines.push(`║  Participation:  ${(impact.participation * 100).toFixed(1).padStart(12)}%                    ║`);
    lines.push("╠══════════════════════════════════════════════════════════╣");
    lines.push("║  OPTIMAL SCHEDULE (Almgren-Chriss)                      ║");
    lines.push(`║  Expected Cost:  ${schedule.totalBps.toFixed(2).padStart(12)} bps                 ║`);
    lines.push(`║  Cost Std Dev:  $${schedule.costStdDev.toFixed(0).padStart(11)}                     ║`);
    lines.push(`║  Kappa:          ${schedule.kappa.toFixed(6).padStart(12)}                     ║`);
    lines.push("║  Trajectory (first 5 slots):                            ║");

    const showSlots = schedule.trajectory.slice(0, 5);
    for (const s of showSlots) {
      const bar = "█".repeat(Math.min(20, Math.round(s.pctComplete / 5)));
      lines.push(`║    Slot ${String(s.slot).padStart(2)}: ${String(s.tradeShares).padStart(8)} shs  ${bar.padEnd(20)} ${s.pctComplete.toFixed(1).padStart(5)}% ║`);
    }

    lines.push("╠══════════════════════════════════════════════════════════╣");
    lines.push("║  PARTICIPATION & CAPACITY                               ║");
    lines.push(`║  Suggested Rate: ${(pRate.rate * 100).toFixed(1).padStart(12)}%                    ║`);
    lines.push(`║  % of ADV:       ${(pRate.percentADV * 100).toFixed(2).padStart(12)}%                    ║`);
    lines.push(`║  Advice:         ${pRate.suggestion.padEnd(38)} ║`);
    lines.push(`║  Capacity (50bps alpha):                                ║`);
    lines.push(`║    Max Shares:   ${capacity.maxShares.toLocaleString().padStart(12)}                     ║`);
    lines.push(`║    Max Dollars: $${capacity.maxDollars.toLocaleString().padStart(11)}                     ║`);
    lines.push(`║    Alpha Left:   ${capacity.alphaRemaining.toFixed(1).padStart(12)} bps                 ║`);
    lines.push("╠══════════════════════════════════════════════════════════╣");
    lines.push("║  IMPACT DECAY CURVE                                     ║");

    const decaySlots = [0, 1, 2, 5, 10, 20];
    for (const t of decaySlots) {
      const d = decay.find((x) => x.slot === t);
      if (d) {
        const bar = "▓".repeat(Math.max(0, Math.round((1 - d.decayPct / 100) * 20)));
        lines.push(`║    t=${String(t).padStart(2)}: ${d.remainingImpact.toFixed(2).padStart(7)} bps  ${bar.padEnd(20)} ${d.decayPct.toFixed(0).padStart(3)}% decayed ║`);
      }
    }

    lines.push("╚══════════════════════════════════════════════════════════╝");
    return lines.join("\n");
  }
}

// ─── Compare Models ─────────────────────────────────────

/**
 * Compare all impact models side by side for a given order.
 *
 * @param {number} orderSize - Order size in shares
 * @param {{ avgVolume: number, dailyVol: number, lastPrice: number }} marketData
 * @returns {{ squareRoot: object, powerLaw: object, linear: object, comparison: string }}
 */
export function compareModels(orderSize, marketData) {
  const { avgVolume, dailyVol, lastPrice } = marketData;

  const sqrt = squareRootModel(orderSize, avgVolume, dailyVol, 0.10);
  const power = powerLawImpact(orderSize, avgVolume, 0.6, dailyVol);
  const lin = linearImpact(orderSize, avgVolume, dailyVol);

  const sqrtBps = Math.abs(sqrt.totalImpact) * 10000;
  const powerBps = Math.abs(power.impact) * 10000;
  const linearBps = Math.abs(lin.impact) * 10000;

  const lines = [];
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│         MODEL COMPARISON                        │");
  lines.push("├─────────────────────────────────────────────────┤");
  lines.push(`│  Order Size:  ${orderSize.toLocaleString().padStart(12)} shares             │`);
  lines.push(`│  Avg Volume:  ${Math.round(avgVolume).toLocaleString().padStart(12)} shares             │`);
  lines.push(`│  Daily Vol:   ${(dailyVol * 100).toFixed(2).padStart(12)}%                   │`);
  lines.push("├─────────────────────────────────────────────────┤");
  lines.push(`│  Square-Root: ${sqrtBps.toFixed(2).padStart(10)} bps  ($${(sqrtBps / 10000 * lastPrice * orderSize).toFixed(0).padStart(8)}) │`);
  lines.push(`│  Power-Law:   ${powerBps.toFixed(2).padStart(10)} bps  ($${(powerBps / 10000 * lastPrice * orderSize).toFixed(0).padStart(8)}) │`);
  lines.push(`│  Linear:      ${linearBps.toFixed(2).padStart(10)} bps  ($${(linearBps / 10000 * lastPrice * orderSize).toFixed(0).padStart(8)}) │`);
  lines.push("├─────────────────────────────────────────────────┤");

  const models = [
    { name: "Square-Root", bps: sqrtBps },
    { name: "Power-Law", bps: powerBps },
    { name: "Linear", bps: linearBps },
  ].sort((a, b) => a.bps - b.bps);

  lines.push(`│  Most Conservative: ${models[2].name.padEnd(26)} │`);
  lines.push(`│  Least Conservative: ${models[0].name.padEnd(25)} │`);
  lines.push(`│  Spread: ${(models[2].bps - models[0].bps).toFixed(2).padStart(10)} bps                      │`);
  lines.push("└─────────────────────────────────────────────────┘");

  return {
    squareRoot: { ...sqrt, bps: sqrtBps },
    powerLaw: { ...power, bps: powerBps },
    linear: { ...lin, bps: linearBps },
    comparison: lines.join("\n"),
  };
}

// ─── CLI Demo ───────────────────────────────────────────

/**
 * CLI demonstration of market impact estimation.
 */
async function main() {
  console.log("=== Market Impact Estimator Demo ===\n");

  // Generate historical data
  const raw = generateRealisticPrices("SPY");
  const data = raw.map((d) => ({
    close: d.close,
    high: d.high,
    low: d.low,
    volume: d.volume,
  }));

  console.log(`Loaded ${data.length} bars of SPY data\n`);

  // Create estimator and calibrate
  const estimator = new MarketImpactEstimator(data);
  const params = estimator.calibrate();

  console.log("Calibrated Parameters:");
  console.log(`  Temp Coeff:     ${params.tempCoeff.toFixed(4)}`);
  console.log(`  Perm Coeff:     ${params.permCoeff.toFixed(4)}`);
  console.log(`  Exponent:       ${params.exponent.toFixed(4)}`);
  console.log(`  Lambda:         ${params.lambda.toExponential(4)}`);
  console.log(`  Decay Half-Life: ${params.decayHalfLife.toFixed(2)} slots`);
  console.log();

  // Impact estimates at various sizes
  const sizes = [1000, 10000, 50000, 100000, 500000];
  console.log("Impact by Order Size:");
  console.log("─".repeat(65));
  console.log(
    "  Shares".padEnd(14) +
    "Temp (bps)".padEnd(14) +
    "Perm (bps)".padEnd(14) +
    "Total (bps)".padEnd(14) +
    "Cost ($)"
  );
  console.log("─".repeat(65));

  for (const size of sizes) {
    const est = estimator.estimateImpact(size, "buy", 0.5);
    console.log(
      `  ${size.toLocaleString().padEnd(12)}` +
      `${est.temporary.toFixed(2).padStart(10)}    ` +
      `${est.permanent.toFixed(2).padStart(10)}    ` +
      `${est.bps.toFixed(2).padStart(10)}    ` +
      `$${est.dollars.toFixed(0).padStart(8)}`
    );
  }
  console.log();

  // Optimal schedule for a medium order
  const schedule = estimator.optimalSchedule(50000, 10, 1e-6);
  console.log("Optimal Execution Schedule (50,000 shares, 10 slots):");
  console.log("─".repeat(55));
  for (const s of schedule.trajectory) {
    const bar = "█".repeat(Math.round(s.pctComplete / 5));
    console.log(
      `  Slot ${String(s.slot).padStart(2)}: ` +
      `${String(s.tradeShares).padStart(8)} shares  ` +
      `${bar.padEnd(20)} ` +
      `${s.pctComplete.toFixed(1).padStart(5)}%`
    );
  }
  console.log(`  Expected Cost: ${schedule.totalBps.toFixed(2)} bps`);
  console.log();

  // Model comparison
  const comparison = compareModels(50000, {
    avgVolume: estimator.avgVolume,
    dailyVol: estimator.dailyVol,
    lastPrice: estimator.lastPrice,
  });
  console.log(comparison.comparison);
  console.log();

  // Full report
  console.log(estimator.formatReport(50000));
}

main().catch(console.error);
