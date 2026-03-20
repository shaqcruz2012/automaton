#!/usr/bin/env node
/**
 * Options Pricing & Greeks Engine — Inferred Analysis
 *
 * Complete Black-Scholes options pricing with:
 * 1. Black-Scholes pricing (calls and puts)
 * 2. Greeks: delta, gamma, theta, vega, rho
 * 3. Implied volatility solver (Newton-Raphson)
 * 4. Volatility smile/skew construction
 * 5. Put-call parity verification
 * 6. Simple options strategies: covered call, protective put, straddle, strangle
 * 7. Options P&L simulation
 *
 * Usage:
 *   node agents/strategies/options-pricing.mjs
 *   import { blackScholes, computeGreeks, impliedVol, optionsPnL, strategyPayoff } from './options-pricing.mjs'
 *
 * Zero external dependencies. Pure ESM.
 */

// ─── Mathematical Helpers ──────────────────────────────────

/** Standard normal PDF */
function phi(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF (Abramowitz & Stegun rational approximation) */
function cdf(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1.0 + sign * y);
}

// ─── Black-Scholes Core ────────────────────────────────────

/**
 * Compute d1 and d2 for Black-Scholes.
 * @param {number} S - Spot price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration (years)
 * @param {number} r - Risk-free rate (annualized, e.g. 0.05)
 * @param {number} sigma - Volatility (annualized, e.g. 0.20)
 * @param {number} [q=0] - Continuous dividend yield
 */
function d1d2(S, K, T, r, sigma, q = 0) {
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return { d1, d2 };
}

/**
 * Black-Scholes option pricing.
 * @param {object} params
 * @param {number} params.S - Spot price
 * @param {number} params.K - Strike price
 * @param {number} params.T - Time to expiration (years)
 * @param {number} params.r - Risk-free rate
 * @param {number} params.sigma - Volatility
 * @param {string} [params.type='call'] - 'call' or 'put'
 * @param {number} [params.q=0] - Dividend yield
 * @returns {{ price: number, d1: number, d2: number }}
 */
export function blackScholes({ S, K, T, r, sigma, type = 'call', q = 0 }) {
  if (T <= 0) {
    // At expiration
    const intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, d1: NaN, d2: NaN };
  }
  const { d1, d2 } = d1d2(S, K, T, r, sigma, q);
  let price;
  if (type === 'call') {
    price = S * Math.exp(-q * T) * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
  } else {
    price = K * Math.exp(-r * T) * cdf(-d2) - S * Math.exp(-q * T) * cdf(-d1);
  }
  return { price: Math.max(price, 0), d1, d2 };
}

// ─── Greeks ────────────────────────────────────────────────

/**
 * Compute all Greeks for an option.
 * @param {object} params - Same as blackScholes params
 * @returns {{ delta, gamma, theta, vega, rho, price }}
 */
export function computeGreeks({ S, K, T, r, sigma, type = 'call', q = 0 }) {
  if (T <= 0) {
    const price = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
    const delta = type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
    return { delta, gamma: 0, theta: 0, vega: 0, rho: 0, price };
  }

  const { d1, d2 } = d1d2(S, K, T, r, sigma, q);
  const sqrtT = Math.sqrt(T);
  const expQT = Math.exp(-q * T);
  const expRT = Math.exp(-r * T);
  const phiD1 = phi(d1);

  const { price } = blackScholes({ S, K, T, r, sigma, type, q });

  let delta, theta, rho;

  if (type === 'call') {
    delta = expQT * cdf(d1);
    theta = (-S * expQT * phiD1 * sigma / (2 * sqrtT))
          - (r * K * expRT * cdf(d2))
          + (q * S * expQT * cdf(d1));
    rho = K * T * expRT * cdf(d2) / 100;
  } else {
    delta = expQT * (cdf(d1) - 1);
    theta = (-S * expQT * phiD1 * sigma / (2 * sqrtT))
          + (r * K * expRT * cdf(-d2))
          - (q * S * expQT * cdf(-d1));
    rho = -K * T * expRT * cdf(-d2) / 100;
  }

  // Gamma and vega are the same for calls and puts
  const gamma = expQT * phiD1 / (S * sigma * sqrtT);
  const vega = S * expQT * phiD1 * sqrtT / 100; // per 1% vol move

  // Theta per calendar day
  const thetaPerDay = theta / 365;

  return {
    delta,
    gamma,
    theta: thetaPerDay,
    vega,
    rho,
    price,
  };
}

// ─── Implied Volatility (Newton-Raphson) ───────────────────

/**
 * Solve for implied volatility using Newton-Raphson.
 * @param {object} params
 * @param {number} params.marketPrice - Observed option price
 * @param {number} params.S - Spot price
 * @param {number} params.K - Strike price
 * @param {number} params.T - Time to expiration (years)
 * @param {number} params.r - Risk-free rate
 * @param {string} [params.type='call'] - 'call' or 'put'
 * @param {number} [params.q=0] - Dividend yield
 * @param {number} [params.tol=1e-8] - Convergence tolerance
 * @param {number} [params.maxIter=100] - Max iterations
 * @returns {{ iv: number, converged: boolean, iterations: number }}
 */
export function impliedVol({ marketPrice, S, K, T, r, type = 'call', q = 0, tol = 1e-8, maxIter = 100 }) {
  if (T <= 0) return { iv: NaN, converged: false, iterations: 0 };

  // Intrinsic value check
  const intrinsic = type === 'call'
    ? Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0)
    : Math.max(K * Math.exp(-r * T) - S * Math.exp(-q * T), 0);

  if (marketPrice < intrinsic - tol) {
    return { iv: NaN, converged: false, iterations: 0 };
  }

  // Initial guess: Brenner-Subrahmanyam approximation
  let sigma = Math.sqrt(2 * Math.PI / T) * (marketPrice / S);
  if (sigma <= 0 || !isFinite(sigma)) sigma = 0.25;
  sigma = Math.max(0.01, Math.min(sigma, 5.0));

  for (let i = 0; i < maxIter; i++) {
    const bs = blackScholes({ S, K, T, r, sigma, type, q });
    const diff = bs.price - marketPrice;

    if (Math.abs(diff) < tol) {
      return { iv: sigma, converged: true, iterations: i + 1 };
    }

    // Vega (not divided by 100 here, raw vega)
    const { d1 } = d1d2(S, K, T, r, sigma, q);
    const rawVega = S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T);

    if (rawVega < 1e-12) {
      // Vega too small, switch to bisection fallback
      return impliedVolBisection({ marketPrice, S, K, T, r, type, q, tol, maxIter: maxIter - i });
    }

    sigma -= diff / rawVega;
    sigma = Math.max(0.001, Math.min(sigma, 10.0));
  }

  return { iv: sigma, converged: false, iterations: maxIter };
}

/** Bisection fallback for implied volatility */
function impliedVolBisection({ marketPrice, S, K, T, r, type, q, tol, maxIter }) {
  let lo = 0.001, hi = 10.0;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const bs = blackScholes({ S, K, T, r, sigma: mid, type, q });
    const diff = bs.price - marketPrice;
    if (Math.abs(diff) < tol) {
      return { iv: mid, converged: true, iterations: i + 1 };
    }
    if (diff > 0) hi = mid; else lo = mid;
  }
  return { iv: (lo + hi) / 2, converged: false, iterations: maxIter };
}

// ─── Volatility Smile / Skew Construction ──────────────────

/**
 * Build a volatility smile from a set of option market prices.
 * @param {object} params
 * @param {number} params.S - Spot price
 * @param {number} params.T - Time to expiration
 * @param {number} params.r - Risk-free rate
 * @param {Array<{strike: number, price: number, type: string}>} params.chain - Option chain data
 * @param {number} [params.q=0] - Dividend yield
 * @returns {Array<{strike: number, moneyness: number, iv: number, type: string}>}
 */
export function buildVolSmile({ S, T, r, chain, q = 0 }) {
  const smile = [];
  for (const opt of chain) {
    const result = impliedVol({
      marketPrice: opt.price,
      S, K: opt.strike, T, r,
      type: opt.type || 'call',
      q,
    });
    if (result.converged) {
      smile.push({
        strike: opt.strike,
        moneyness: opt.strike / S,
        iv: result.iv,
        type: opt.type || 'call',
      });
    }
  }
  return smile.sort((a, b) => a.strike - b.strike);
}

/**
 * Compute skew metrics from a volatility smile.
 * @param {Array<{strike: number, moneyness: number, iv: number}>} smile
 * @returns {{ skew25d: number, butterfly25d: number, atmVol: number }}
 */
export function skewMetrics(smile) {
  if (smile.length < 3) return { skew25d: NaN, butterfly25d: NaN, atmVol: NaN };

  // Find ATM (moneyness closest to 1.0)
  let atm = smile.reduce((best, s) =>
    Math.abs(s.moneyness - 1.0) < Math.abs(best.moneyness - 1.0) ? s : best
  );

  // Find 25-delta put (~0.90 moneyness) and 25-delta call (~1.10 moneyness)
  const otmPut = smile.reduce((best, s) =>
    Math.abs(s.moneyness - 0.90) < Math.abs(best.moneyness - 0.90) ? s : best
  );
  const otmCall = smile.reduce((best, s) =>
    Math.abs(s.moneyness - 1.10) < Math.abs(best.moneyness - 1.10) ? s : best
  );

  return {
    skew25d: otmPut.iv - otmCall.iv,
    butterfly25d: (otmPut.iv + otmCall.iv) / 2 - atm.iv,
    atmVol: atm.iv,
  };
}

// ─── Put-Call Parity Verification ──────────────────────────

/**
 * Verify put-call parity: C - P = S*exp(-qT) - K*exp(-rT)
 * @param {object} params
 * @param {number} params.callPrice
 * @param {number} params.putPrice
 * @param {number} params.S
 * @param {number} params.K
 * @param {number} params.T
 * @param {number} params.r
 * @param {number} [params.q=0]
 * @returns {{ parityDiff: number, theoreticalDiff: number, violation: boolean, violationPct: number }}
 */
export function putCallParity({ callPrice, putPrice, S, K, T, r, q = 0 }) {
  const observedDiff = callPrice - putPrice;
  const theoreticalDiff = S * Math.exp(-q * T) - K * Math.exp(-r * T);
  const parityDiff = observedDiff - theoreticalDiff;
  const violationPct = Math.abs(parityDiff) / S * 100;

  return {
    parityDiff,
    theoreticalDiff,
    observedDiff,
    violation: violationPct > 0.5, // >0.5% of spot is a meaningful violation
    violationPct,
  };
}

// ─── Options Strategies ────────────────────────────────────

/**
 * Compute payoff/P&L for common options strategies at a range of expiration prices.
 * @param {object} params
 * @param {string} params.strategy - 'covered-call' | 'protective-put' | 'straddle' | 'strangle'
 * @param {number} params.S - Entry spot price
 * @param {number} params.K - Strike price (or ATM strike for straddle)
 * @param {number} [params.K2] - Second strike (for strangle: put strike=K, call strike=K2)
 * @param {number} params.T - Time to expiration
 * @param {number} params.r - Risk-free rate
 * @param {number} params.sigma - Volatility
 * @param {number} [params.q=0] - Dividend yield
 * @param {number} [params.nPoints=50] - Number of expiration prices to evaluate
 * @returns {{ points: Array<{spotAtExpiry: number, payoff: number, pnl: number}>, maxLoss: number, maxGain: number, breakeven: number[] }}
 */
export function strategyPayoff({ strategy, S, K, K2, T, r, sigma, q = 0, nPoints = 50 }) {
  const callPrice = (strike) => blackScholes({ S, K: strike, T, r, sigma, type: 'call', q }).price;
  const putPrice = (strike) => blackScholes({ S, K: strike, T, r, sigma, type: 'put', q }).price;

  // Generate range of expiration prices: +/- 30% around spot
  const low = S * 0.70;
  const high = S * 1.30;
  const step = (high - low) / nPoints;
  const expiryPrices = Array.from({ length: nPoints + 1 }, (_, i) => low + i * step);

  let costBasis, payoffFn;

  switch (strategy) {
    case 'covered-call': {
      // Long stock + short call
      const premium = callPrice(K);
      costBasis = S - premium; // net debit
      payoffFn = (sT) => {
        const stockPnL = sT - S;
        const callPnL = premium - Math.max(sT - K, 0); // short call
        return stockPnL + callPnL;
      };
      break;
    }
    case 'protective-put': {
      // Long stock + long put
      const premium = putPrice(K);
      costBasis = S + premium;
      payoffFn = (sT) => {
        const stockPnL = sT - S;
        const putPnL = Math.max(K - sT, 0) - premium;
        return stockPnL + putPnL;
      };
      break;
    }
    case 'straddle': {
      // Long call + long put at same strike
      const cPrem = callPrice(K);
      const pPrem = putPrice(K);
      costBasis = cPrem + pPrem;
      payoffFn = (sT) => {
        const callPayoff = Math.max(sT - K, 0);
        const putPayoff = Math.max(K - sT, 0);
        return callPayoff + putPayoff - costBasis;
      };
      break;
    }
    case 'strangle': {
      // Long OTM put (strike K) + long OTM call (strike K2)
      const putStrike = K;
      const callStrike = K2 || K * 1.05;
      const pPrem = putPrice(putStrike);
      const cPrem = callPrice(callStrike);
      costBasis = pPrem + cPrem;
      payoffFn = (sT) => {
        const putPayoff = Math.max(putStrike - sT, 0);
        const callPayoff = Math.max(sT - callStrike, 0);
        return putPayoff + callPayoff - costBasis;
      };
      break;
    }
    default:
      throw new Error(`Unknown strategy: ${strategy}`);
  }

  const points = expiryPrices.map((sT) => {
    const pnl = payoffFn(sT);
    return { spotAtExpiry: round(sT, 2), payoff: round(pnl + costBasis, 4), pnl: round(pnl, 4) };
  });

  const pnls = points.map((p) => p.pnl);
  const maxLoss = Math.min(...pnls);
  const maxGain = Math.max(...pnls);

  // Find breakeven points (where PnL crosses zero)
  const breakeven = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1].pnl * points[i].pnl < 0) {
      // Linear interpolation
      const x0 = points[i - 1].spotAtExpiry, y0 = points[i - 1].pnl;
      const x1 = points[i].spotAtExpiry, y1 = points[i].pnl;
      breakeven.push(round(x0 - y0 * (x1 - x0) / (y1 - y0), 2));
    }
  }

  return { points, maxLoss: round(maxLoss, 4), maxGain: round(maxGain, 4), breakeven, costBasis: round(costBasis, 4) };
}

// ─── Options P&L Simulation ────────────────────────────────

/**
 * Simulate P&L of an options position over time and spot price changes.
 * @param {object} params
 * @param {string} params.type - 'call' or 'put'
 * @param {string} params.side - 'long' or 'short'
 * @param {number} params.S - Entry spot price
 * @param {number} params.K - Strike
 * @param {number} params.T - Time to expiration at entry (years)
 * @param {number} params.r - Risk-free rate
 * @param {number} params.sigma - Volatility
 * @param {number} [params.q=0] - Dividend yield
 * @param {number} [params.contracts=1] - Number of contracts (each = 100 shares)
 * @param {number} [params.spotSteps=20] - Grid points across spot dimension
 * @param {number} [params.timeSteps=10] - Grid points across time dimension
 * @returns {{ grid: Array, entryPrice: number, summary: object }}
 */
export function optionsPnL({ type, side = 'long', S, K, T, r, sigma, q = 0, contracts = 1, spotSteps = 20, timeSteps = 10 }) {
  const multiplier = 100 * contracts;
  const direction = side === 'long' ? 1 : -1;
  const entryPrice = blackScholes({ S, K, T, r, sigma, type, q }).price;
  const totalCost = entryPrice * multiplier * direction;

  const spotLow = S * 0.80;
  const spotHigh = S * 1.20;
  const spotStep = (spotHigh - spotLow) / spotSteps;
  const timeStep = T / timeSteps;

  const grid = [];

  for (let ti = 0; ti <= timeSteps; ti++) {
    const timeRemaining = Math.max(T - ti * timeStep, 0.0001);
    const dte = Math.round(timeRemaining * 365);
    const row = [];

    for (let si = 0; si <= spotSteps; si++) {
      const spot = spotLow + si * spotStep;
      const current = blackScholes({ S: spot, K, T: timeRemaining, r, sigma, type, q }).price;
      const greeks = computeGreeks({ S: spot, K, T: timeRemaining, r, sigma, type, q });
      const positionValue = current * multiplier * direction;
      const pnl = positionValue - totalCost;

      row.push({
        spot: round(spot, 2),
        dte,
        price: round(current, 4),
        pnl: round(pnl, 2),
        delta: round(greeks.delta * direction, 4),
        gamma: round(greeks.gamma, 6),
        theta: round(greeks.theta * direction, 4),
      });
    }
    grid.push(row);
  }

  // Summary at current spot across time
  const atSpot = grid.map((row) => {
    const cell = row.find((c) => Math.abs(c.spot - S) < spotStep * 0.6);
    return cell || row[Math.floor(spotSteps / 2)];
  });

  return {
    grid,
    entryPrice: round(entryPrice, 4),
    totalCost: round(totalCost, 2),
    summary: {
      atEntrySpot: atSpot,
      maxPnL: round(Math.max(...grid.flat().map((c) => c.pnl)), 2),
      minPnL: round(Math.min(...grid.flat().map((c) => c.pnl)), 2),
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────

function round(x, d) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function pad(s, w, align = 'right') {
  const str = String(s);
  if (align === 'right') return str.padStart(w);
  return str.padEnd(w);
}

function colorPnL(val) {
  if (val > 0) return `\x1b[32m${val}\x1b[0m`;
  if (val < 0) return `\x1b[31m${val}\x1b[0m`;
  return String(val);
}

// ─── CLI Demo ──────────────────────────────────────────────

function demo() {
  const S = 585.00;     // SPY spot
  const r = 0.045;      // risk-free rate
  const q = 0.013;      // SPY dividend yield ~1.3%
  const T = 30 / 365;   // 30 DTE
  const sigma = 0.18;   // 18% implied vol

  console.log('='.repeat(80));
  console.log('  OPTIONS PRICING & GREEKS ENGINE — SPY Demo');
  console.log('='.repeat(80));
  console.log(`  Spot: $${S}  |  Rate: ${(r * 100).toFixed(1)}%  |  DTE: 30  |  IV: ${(sigma * 100).toFixed(0)}%  |  Div Yield: ${(q * 100).toFixed(1)}%`);
  console.log('='.repeat(80));

  // ── 1. Pricing & Greeks across strikes ──
  console.log('\n[1] BLACK-SCHOLES PRICING & GREEKS SURFACE\n');

  const strikes = [];
  for (let k = S - 20; k <= S + 20; k += 2.5) {
    strikes.push(round(k, 2));
  }

  const header = `${pad('Strike', 8)} | ${pad('Call$', 8)} | ${pad('Put$', 8)} | ${pad('Delta', 8)} | ${pad('Gamma', 8)} | ${pad('Theta', 8)} | ${pad('Vega', 8)} | ${pad('Rho', 8)}`;
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const K of strikes) {
    const cg = computeGreeks({ S, K, T, r, sigma, type: 'call', q });
    const pg = computeGreeks({ S, K, T, r, sigma, type: 'put', q });
    const moneyness = K === S ? ' ATM' : K < S ? ' ITM' : ' OTM';
    console.log(
      `${pad(K.toFixed(1), 8)} | ${pad(cg.price.toFixed(3), 8)} | ${pad(pg.price.toFixed(3), 8)} | ${pad(cg.delta.toFixed(4), 8)} | ${pad(cg.gamma.toFixed(5), 8)} | ${pad(cg.theta.toFixed(4), 8)} | ${pad(cg.vega.toFixed(4), 8)} | ${pad(cg.rho.toFixed(4), 8)}${moneyness}`
    );
  }

  // ── 2. Implied Volatility Recovery ──
  console.log('\n[2] IMPLIED VOLATILITY ROUND-TRIP VERIFICATION\n');

  const testStrikes = [565, 570, 575, 580, 585, 590, 595, 600, 605];
  // Simulate a skew: OTM puts have higher vol, OTM calls lower
  const skewVols = testStrikes.map((k) => {
    const m = k / S;
    return sigma + 0.08 * (1 - m) + 0.02 * (1 - m) ** 2; // realistic equity skew
  });

  console.log(`${pad('Strike', 8)} | ${pad('InputVol', 10)} | ${pad('MktPrice', 10)} | ${pad('SolvedIV', 10)} | ${pad('Error', 10)} | ${pad('Iters', 6)}`);
  console.log('-'.repeat(60));

  const chainForSmile = [];

  for (let i = 0; i < testStrikes.length; i++) {
    const K = testStrikes[i];
    const vol = skewVols[i];
    const optType = K <= S ? 'put' : 'call';
    const mktPrice = blackScholes({ S, K, T, r, sigma: vol, type: optType, q }).price;
    const result = impliedVol({ marketPrice: mktPrice, S, K, T, r, type: optType, q });

    chainForSmile.push({ strike: K, price: mktPrice, type: optType });

    console.log(
      `${pad(K, 8)} | ${pad((vol * 100).toFixed(2) + '%', 10)} | ${pad(mktPrice.toFixed(4), 10)} | ${pad(result.converged ? (result.iv * 100).toFixed(2) + '%' : 'FAIL', 10)} | ${pad(result.converged ? ((result.iv - vol) * 10000).toFixed(2) + 'bp' : 'N/A', 10)} | ${pad(result.iterations, 6)}`
    );
  }

  // ── 3. Volatility Smile ──
  console.log('\n[3] VOLATILITY SMILE / SKEW\n');

  const smile = buildVolSmile({ S, T, r, chain: chainForSmile, q });
  const metrics = skewMetrics(smile);

  console.log(`  ATM Vol:        ${(metrics.atmVol * 100).toFixed(2)}%`);
  console.log(`  25d Skew:       ${(metrics.skew25d * 100).toFixed(2)}% (put vol - call vol)`);
  console.log(`  25d Butterfly:  ${(metrics.butterfly25d * 100).toFixed(2)}% (wing avg - ATM)`);
  console.log();

  // ASCII smile chart
  const maxIV = Math.max(...smile.map((s) => s.iv));
  const minIV = Math.min(...smile.map((s) => s.iv));
  const barWidth = 40;

  for (const pt of smile) {
    const barLen = Math.round(((pt.iv - minIV) / (maxIV - minIV + 0.001)) * barWidth);
    const bar = '#'.repeat(barLen + 1);
    console.log(`  K=${pad(pt.strike, 5)} | ${(pt.iv * 100).toFixed(1)}% | ${bar}`);
  }

  // ── 4. Put-Call Parity ──
  console.log('\n[4] PUT-CALL PARITY VERIFICATION\n');

  for (const K of [575, 580, 585, 590, 595]) {
    const call = blackScholes({ S, K, T, r, sigma, type: 'call', q }).price;
    const put = blackScholes({ S, K, T, r, sigma, type: 'put', q }).price;
    const parity = putCallParity({ callPrice: call, putPrice: put, S, K, T, r, q });
    const status = parity.violation ? '\x1b[31mVIOLATION\x1b[0m' : '\x1b[32mOK\x1b[0m';
    console.log(
      `  K=${K} | C=${call.toFixed(3)} P=${put.toFixed(3)} | C-P=${parity.observedDiff.toFixed(4)} | Theo=${parity.theoreticalDiff.toFixed(4)} | Err=${parity.parityDiff.toFixed(6)} | ${status}`
    );
  }

  // ── 5. Options Strategies ──
  console.log('\n[5] OPTIONS STRATEGIES\n');

  const strategies = [
    { name: 'Covered Call',    strategy: 'covered-call',    K: 590 },
    { name: 'Protective Put',  strategy: 'protective-put',  K: 580 },
    { name: 'Straddle',        strategy: 'straddle',        K: 585 },
    { name: 'Strangle',        strategy: 'strangle',        K: 575, K2: 595 },
  ];

  for (const strat of strategies) {
    const result = strategyPayoff({
      strategy: strat.strategy,
      S, K: strat.K, K2: strat.K2, T, r, sigma, q, nPoints: 40,
    });
    console.log(`  --- ${strat.name} (K=${strat.K}${strat.K2 ? '/'+strat.K2 : ''}) ---`);
    console.log(`    Cost Basis: $${result.costBasis.toFixed(2)}`);
    console.log(`    Max Gain:   $${colorPnL(result.maxGain.toFixed(2))}`);
    console.log(`    Max Loss:   $${colorPnL(result.maxLoss.toFixed(2))}`);
    console.log(`    Breakeven:  ${result.breakeven.map((b) => '$' + b.toFixed(2)).join(', ') || 'N/A'}`);

    // Mini ASCII payoff chart
    const subset = result.points.filter((_, i) => i % 4 === 0);
    const maxP = Math.max(...subset.map((p) => p.pnl));
    const minP = Math.min(...subset.map((p) => p.pnl));
    const range = maxP - minP || 1;
    for (const pt of subset) {
      const barLen = Math.round(((pt.pnl - minP) / range) * 30);
      const color = pt.pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
      console.log(`    S=${pad(pt.spotAtExpiry.toFixed(0), 4)} | ${color}${pad(pt.pnl.toFixed(2), 8)}\x1b[0m | ${'='.repeat(barLen)}`);
    }
    console.log();
  }

  // ── 6. P&L Simulation Heatmap ──
  console.log('[6] P&L HEATMAP — Long 585 Call\n');

  const pnlSim = optionsPnL({
    type: 'call', side: 'long', S, K: 585, T, r, sigma, q,
    contracts: 1, spotSteps: 12, timeSteps: 5,
  });

  console.log(`  Entry Price: $${pnlSim.entryPrice}  |  Total Cost: $${pnlSim.totalCost}`);
  console.log(`  Max P&L: $${colorPnL(pnlSim.summary.maxPnL)}  |  Min P&L: $${colorPnL(pnlSim.summary.minPnL)}`);
  console.log();

  // Header row: spot prices
  const firstRow = pnlSim.grid[0];
  const spotLabels = firstRow.filter((_, i) => i % 2 === 0).map((c) => pad(c.spot.toFixed(0), 8));
  console.log(`  ${pad('DTE', 5)} |${spotLabels.join('|')}`);
  console.log('  ' + '-'.repeat(5 + spotLabels.length * 9));

  for (const row of pnlSim.grid) {
    const dte = row[0].dte;
    const cells = row.filter((_, i) => i % 2 === 0).map((c) => {
      const val = c.pnl.toFixed(0);
      return pad(colorPnL(val), c.pnl >= 0 ? 17 : 17); // accounting for ANSI codes
    });
    console.log(`  ${pad(dte, 5)} |${cells.join('|')}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('  Engine ready. Import: blackScholes, computeGreeks, impliedVol, optionsPnL, strategyPayoff');
  console.log('='.repeat(80));
}

// ─── Entry Point ───────────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith('options-pricing.mjs') ||
  process.argv[1].includes('options-pricing')
);

if (isMain) {
  demo();
}
