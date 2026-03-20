#!/usr/bin/env node
/**
 * Dynamic Hedger — Optimal Hedge Computation & Order Generation
 *
 * Given current positions and market data, computes optimal hedges using:
 *   - Beta hedging (hedge systematic risk with SPY)
 *   - Pair hedging (offset correlated positions)
 *   - Tail hedging (identify and hedge left-tail risk via vol regime)
 *
 * Outputs hedge orders compatible with paper-trader.mjs.
 *
 * Usage:
 *   node agents/risk/dynamic-hedger.mjs --positions '{"SPY":1,"QQQ":-1}' --capital 100000
 *   node agents/risk/dynamic-hedger.mjs --positions '{"AAPL":100,"MSFT":50,"TSLA":-30}' --capital 500000
 *   node agents/risk/dynamic-hedger.mjs --help
 *
 * Can also be imported as a module:
 *   import { computeBetaHedge, computePairHedges, computeTailHedge } from './dynamic-hedger.mjs'
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generateRealisticPrices } from "../data/fetch.mjs";
import {
  computeReturns,
  computeCorrelationMatrix,
  pearsonCorrelation,
  olsHedgeRatio,
  diversificationRatio,
} from "./correlation-monitor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Math Utilities ─────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Compute annualized volatility from daily returns.
 */
function annualizedVol(returns) {
  return stddev(returns) * Math.sqrt(252);
}

/**
 * Compute Value-at-Risk (percentile-based).
 * @param {number[]} returns - Daily returns
 * @param {number} confidence - Confidence level (e.g. 0.95)
 * @returns {number} VaR as a positive number (loss magnitude)
 */
function valueAtRisk(returns, confidence = 0.95) {
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * (1 - confidence));
  return -sorted[idx] || 0;
}

/**
 * Compute Conditional VaR (Expected Shortfall).
 * Average of returns below the VaR threshold.
 */
function conditionalVaR(returns, confidence = 0.95) {
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * (1 - confidence));
  if (idx <= 0) return -sorted[0] || 0;
  const tailReturns = sorted.slice(0, idx);
  return -mean(tailReturns);
}

// ─── Beta Hedging ───────────────────────────────────────

/**
 * Compute beta hedge: hedge systematic (market) risk using SPY.
 *
 * For each position, regress its returns on SPY returns to get beta.
 * Portfolio beta = sum of (weight * beta_i).
 * Hedge = short (portfolioBeta * portfolioValue) worth of SPY.
 *
 * @param {Object<string, number>} positions - { symbol: quantity }
 * @param {Object<string, number[]>} returnSeries - { symbol: daily_returns[] }
 * @param {Object<string, number>} prices - { symbol: current_price }
 * @param {number} capital
 * @returns {{ portfolioBeta: number, hedgeOrder: object, positionBetas: Object<string, number> }}
 */
export function computeBetaHedge(positions, returnSeries, prices, capital) {
  const spyReturns = returnSeries["SPY"];
  if (!spyReturns || spyReturns.length < 20) {
    return { portfolioBeta: 0, hedgeOrder: null, positionBetas: {}, error: "No SPY data for beta calculation" };
  }

  const positionBetas = {};
  let portfolioBeta = 0;
  let totalExposure = 0;

  for (const [sym, qty] of Object.entries(positions)) {
    if (sym === "SPY") continue;
    const symReturns = returnSeries[sym];
    if (!symReturns || symReturns.length < 20) continue;

    const ols = olsHedgeRatio(symReturns, spyReturns);
    const beta = -ols.hedgeRatio; // ols.hedgeRatio = -beta, so beta = -hedgeRatio
    positionBetas[sym] = +beta.toFixed(4);

    const posValue = qty * (prices[sym] || 100);
    totalExposure += Math.abs(posValue);
    portfolioBeta += beta * posValue;
  }

  // Add SPY's own beta contribution (beta = 1)
  if (positions["SPY"]) {
    positionBetas["SPY"] = 1.0;
    const spyValue = positions["SPY"] * (prices["SPY"] || 450);
    totalExposure += Math.abs(spyValue);
    portfolioBeta += 1.0 * spyValue;
  }

  // Hedge order: short enough SPY to make portfolio beta-neutral
  const spyPrice = prices["SPY"] || 450;
  const hedgeQty = -Math.round(portfolioBeta / spyPrice);

  const hedgeOrder = hedgeQty !== 0 ? {
    symbol: "SPY",
    direction: hedgeQty > 0 ? "buy" : "sell",
    quantity: Math.abs(hedgeQty),
    type: "beta_hedge",
    reason: `Neutralize portfolio beta of ${(portfolioBeta / capital).toFixed(4)}`,
    notionalValue: Math.abs(hedgeQty * spyPrice),
  } : null;

  return {
    portfolioBeta: totalExposure > 0 ? +(portfolioBeta / totalExposure).toFixed(4) : 0,
    rawBetaDollar: +portfolioBeta.toFixed(2),
    hedgeOrder,
    positionBetas,
  };
}

// ─── Pair Hedging ───────────────────────────────────────

/**
 * Compute pair hedges: for each position, find the most correlated
 * existing position and suggest offsetting trades.
 *
 * @param {Object<string, number>} positions
 * @param {Object<string, number[]>} returnSeries
 * @param {Object<string, number>} prices
 * @param {number[][]} corrMatrix
 * @param {string[]} symbols
 * @returns {Array<{ pair: string, correlation: number, hedgeOrder: object }>}
 */
export function computePairHedges(positions, returnSeries, prices, corrMatrix, symbols) {
  const posSymbols = Object.keys(positions);
  const hedges = [];

  // For each pair of held positions with high positive correlation,
  // suggest reducing the smaller one (redundant risk).
  for (let i = 0; i < posSymbols.length; i++) {
    for (let j = i + 1; j < posSymbols.length; j++) {
      const symA = posSymbols[i];
      const symB = posSymbols[j];
      const idxA = symbols.indexOf(symA);
      const idxB = symbols.indexOf(symB);

      if (idxA < 0 || idxB < 0) continue;

      const corr = corrMatrix[idxA][idxB];
      const qtyA = positions[symA];
      const qtyB = positions[symB];

      // Both long or both short + high correlation = redundant risk
      if (corr > 0.7 && Math.sign(qtyA) === Math.sign(qtyB)) {
        const valA = Math.abs(qtyA * (prices[symA] || 100));
        const valB = Math.abs(qtyB * (prices[symB] || 100));
        const smallerSym = valA < valB ? symA : symB;
        const smallerQty = smallerSym === symA ? qtyA : qtyB;

        // Suggest reducing smaller position by 50%
        const reduceQty = Math.round(Math.abs(smallerQty) * 0.5);
        if (reduceQty > 0) {
          hedges.push({
            pair: `${symA}/${symB}`,
            correlation: +corr.toFixed(4),
            type: "pair_reduce",
            hedgeOrder: {
              symbol: smallerSym,
              direction: smallerQty > 0 ? "sell" : "buy",
              quantity: reduceQty,
              type: "pair_hedge",
              reason: `Reduce redundant exposure: ${symA}/${symB} corr=${corr.toFixed(3)}`,
              notionalValue: reduceQty * (prices[smallerSym] || 100),
            },
          });
        }
      }

      // Opposite directions + high negative correlation = also redundant
      if (corr < -0.5 && Math.sign(qtyA) !== Math.sign(qtyB)) {
        const ols = olsHedgeRatio(returnSeries[symA], returnSeries[symB]);
        hedges.push({
          pair: `${symA}/${symB}`,
          correlation: +corr.toFixed(4),
          type: "pair_natural_hedge",
          hedgeOrder: null, // Already hedged naturally
          note: `Natural hedge detected. OLS beta: ${ols.beta.toFixed(4)}, R2: ${ols.rSquared.toFixed(4)}`,
        });
      }
    }
  }

  // For positions without a natural hedge, find best external hedge
  for (const sym of posSymbols) {
    const idx = symbols.indexOf(sym);
    if (idx < 0) continue;

    let bestHedgeSym = null;
    let bestCorr = 0;

    for (let j = 0; j < symbols.length; j++) {
      if (j === idx) continue;
      if (posSymbols.includes(symbols[j])) continue; // skip held symbols

      const corr = corrMatrix[idx][j];
      if (corr < bestCorr) {
        bestCorr = corr;
        bestHedgeSym = symbols[j];
      }
    }

    if (bestHedgeSym && bestCorr < -0.2) {
      const ols = olsHedgeRatio(returnSeries[sym], returnSeries[bestHedgeSym]);
      const qty = positions[sym];
      const hedgeQty = Math.round(Math.abs(qty) * Math.abs(ols.hedgeRatio));

      if (hedgeQty > 0) {
        hedges.push({
          pair: `${sym}/${bestHedgeSym}`,
          correlation: +bestCorr.toFixed(4),
          type: "pair_external",
          hedgeOrder: {
            symbol: bestHedgeSym,
            direction: qty > 0 ? "buy" : "sell", // opposite exposure via negative corr
            quantity: hedgeQty,
            type: "pair_hedge",
            reason: `Hedge ${sym} with ${bestHedgeSym} (corr=${bestCorr.toFixed(3)}, beta=${ols.beta.toFixed(4)})`,
            notionalValue: hedgeQty * (prices[bestHedgeSym] || 100),
          },
        });
      }
    }
  }

  return hedges;
}

// ─── Tail Hedging ───────────────────────────────────────

/**
 * Detect vol regime and compute tail hedges.
 *
 * Tail hedging strategy:
 *   - Compute realized vol vs. historical avg
 *   - If current vol > 1.5x avg, we're in a high-vol regime (tail risk elevated)
 *   - In high-vol regime, add protective hedges (reduce position size or add inverse)
 *
 * @param {Object<string, number>} positions
 * @param {Object<string, number[]>} returnSeries
 * @param {Object<string, number>} prices
 * @param {number} capital
 * @param {number} window - Short window for current vol (default 20)
 * @returns {{ volRegime: string, currentVol: number, avgVol: number, tailRisk: object, hedgeOrders: object[] }}
 */
export function computeTailHedge(positions, returnSeries, prices, capital, window = 20) {
  // Compute portfolio returns
  const posSymbols = Object.keys(positions);
  const totalValue = posSymbols.reduce((s, sym) => s + Math.abs(positions[sym] * (prices[sym] || 100)), 0);

  if (totalValue === 0) {
    return { volRegime: "NONE", currentVol: 0, avgVol: 0, tailRisk: {}, hedgeOrders: [] };
  }

  // Weighted portfolio returns
  const minLen = Math.min(...posSymbols.map(s => (returnSeries[s] || []).length));
  if (minLen < window * 2) {
    return { volRegime: "INSUFFICIENT_DATA", currentVol: 0, avgVol: 0, tailRisk: {}, hedgeOrders: [] };
  }

  const portfolioReturns = [];
  for (let t = 0; t < minLen; t++) {
    let dayReturn = 0;
    for (const sym of posSymbols) {
      const weight = (positions[sym] * (prices[sym] || 100)) / totalValue;
      dayReturn += weight * (returnSeries[sym]?.[t] || 0);
    }
    portfolioReturns.push(dayReturn);
  }

  // Current vs historical vol
  const recentReturns = portfolioReturns.slice(-window);
  const fullReturns = portfolioReturns;

  const currentVol = annualizedVol(recentReturns);
  const avgVol = annualizedVol(fullReturns);
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1;

  // VaR and CVaR
  const var95 = valueAtRisk(recentReturns, 0.95);
  const cvar95 = conditionalVaR(recentReturns, 0.95);
  const var99 = valueAtRisk(recentReturns, 0.99);

  let volRegime;
  if (volRatio > 2.0) volRegime = "CRISIS";
  else if (volRatio > 1.5) volRegime = "HIGH_VOL";
  else if (volRatio > 1.2) volRegime = "ELEVATED";
  else if (volRatio > 0.8) volRegime = "NORMAL";
  else volRegime = "LOW_VOL";

  const tailRisk = {
    var95: +var95.toFixed(6),
    cvar95: +cvar95.toFixed(6),
    var99: +var99.toFixed(6),
    var95Dollar: +(var95 * totalValue).toFixed(2),
    cvar95Dollar: +(cvar95 * totalValue).toFixed(2),
    volRatio: +volRatio.toFixed(4),
  };

  // Generate hedge orders based on regime
  const hedgeOrders = [];

  if (volRegime === "CRISIS" || volRegime === "HIGH_VOL") {
    // Reduce all long positions by a factor proportional to excess vol
    const reductionPct = Math.min((volRatio - 1) * 0.3, 0.5); // up to 50% reduction

    for (const [sym, qty] of Object.entries(positions)) {
      if (qty > 0) {
        const reduceQty = Math.round(qty * reductionPct);
        if (reduceQty > 0) {
          hedgeOrders.push({
            symbol: sym,
            direction: "sell",
            quantity: reduceQty,
            type: "tail_hedge",
            reason: `${volRegime} regime: reduce long exposure by ${(reductionPct * 100).toFixed(0)}% (vol ratio: ${volRatio.toFixed(2)}x)`,
            notionalValue: reduceQty * (prices[sym] || 100),
          });
        }
      }
    }

    // If portfolio is net long, add a small TLT hedge (flight to safety)
    const netExposure = posSymbols.reduce((s, sym) => s + positions[sym] * (prices[sym] || 100), 0);
    if (netExposure > 0) {
      const tltPrice = prices["TLT"] || 100;
      const hedgeNotional = netExposure * 0.1 * (volRatio - 1); // 10% per unit excess vol
      const tltQty = Math.round(hedgeNotional / tltPrice);
      if (tltQty > 0) {
        hedgeOrders.push({
          symbol: "TLT",
          direction: "buy",
          quantity: tltQty,
          type: "tail_hedge",
          reason: `${volRegime} regime: flight-to-safety hedge via TLT`,
          notionalValue: tltQty * tltPrice,
        });
      }
    }
  } else if (volRegime === "ELEVATED") {
    // Mild warning, tighten stops but no hedge orders
    hedgeOrders.push({
      symbol: null,
      direction: null,
      quantity: 0,
      type: "tail_advisory",
      reason: `ELEVATED vol (${volRatio.toFixed(2)}x normal). Consider tightening stop-losses.`,
      notionalValue: 0,
    });
  }

  return { volRegime, currentVol, avgVol, tailRisk, hedgeOrders };
}

// ─── Hedge Efficiency ───────────────────────────────────

/**
 * Compute hedge efficiency ratio.
 *
 * Efficiency = (portfolio vol reduction) / (hedge cost as % of portfolio)
 * Higher is better. A ratio of 5 means each 1% of capital spent on hedging
 * reduces vol by 5%.
 *
 * @param {number} unhedgedVol - Portfolio vol without hedges
 * @param {number} hedgedVol - Portfolio vol with hedges
 * @param {number} hedgeCost - Total hedge notional as fraction of portfolio
 * @returns {{ efficiency: number, volReduction: number, costPct: number }}
 */
export function hedgeEfficiency(unhedgedVol, hedgedVol, hedgeCost) {
  const volReduction = unhedgedVol > 0 ? (unhedgedVol - hedgedVol) / unhedgedVol : 0;
  const costPct = hedgeCost;
  const efficiency = costPct > 0 ? volReduction / costPct : 0;

  return {
    efficiency: +efficiency.toFixed(4),
    volReduction: +volReduction.toFixed(4),
    costPct: +costPct.toFixed(4),
  };
}

// ─── CLI ─────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    positions: {},
    capital: 100000,
    window: 60,
    symbols: ["SPY", "QQQ", "IWM", "TLT", "GLD", "XLF", "XLE", "XLK", "AAPL", "MSFT", "TSLA"],
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--positions") {
      try {
        opts.positions = JSON.parse(args[++i]);
      } catch (e) {
        console.error("Invalid JSON for --positions:", e.message);
        process.exit(1);
      }
    }
    if (args[i] === "--capital") opts.capital = parseFloat(args[++i]);
    if (args[i] === "--window") opts.window = parseInt(args[++i]);
    if (args[i] === "--symbols") opts.symbols = args[++i].split(",").map(s => s.trim().toUpperCase());
    if (args[i] === "--help" || args[i] === "-h") opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
Dynamic Hedger — Optimal Hedge Computation & Order Generation

Usage:
  node agents/risk/dynamic-hedger.mjs --positions '{"SPY":1,"QQQ":-1}' --capital 100000
  node agents/risk/dynamic-hedger.mjs --positions '{"AAPL":100,"MSFT":50}' --capital 500000

Options:
  --positions <json>      JSON object of { symbol: quantity } (required)
  --capital <n>           Total capital in dollars (default: 100000)
  --window <n>            Lookback window in days (default: 60)
  --symbols <s1,s2,...>   Universe of symbols for hedging candidates
  --help                  Show this help

Output:
  Hedge orders in format compatible with paper-trader.mjs:
    { symbol, direction, quantity, type, reason, notionalValue }
`);
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (Object.keys(opts.positions).length === 0) {
    console.error("No positions specified. Use --positions '{\"SPY\":100,\"QQQ\":-50}'");
    process.exit(1);
  }

  console.log("=".repeat(75));
  console.log("  DYNAMIC HEDGER — Optimal Hedge Computation");
  console.log("=".repeat(75));
  console.log(`  Capital:    $${opts.capital.toLocaleString()}`);
  console.log(`  Window:     ${opts.window} days`);
  console.log(`  Positions:  ${JSON.stringify(opts.positions)}`);
  console.log("=".repeat(75));

  // Ensure all position symbols are in the universe
  const allSymbols = [...new Set([...opts.symbols, ...Object.keys(opts.positions)])];

  // Load price data
  console.log("\n--- Loading Price Data ---\n");
  const priceData = {};
  for (const sym of allSymbols) {
    priceData[sym] = generateRealisticPrices(sym);
  }

  // Compute returns and current prices
  const returnSeries = {};
  const currentPrices = {};
  for (const sym of allSymbols) {
    const prices = priceData[sym];
    returnSeries[sym] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1].close > 0 && prices[i].close > 0) {
        returnSeries[sym].push(Math.log(prices[i].close / prices[i - 1].close));
      }
    }
    currentPrices[sym] = prices[prices.length - 1].close;
  }

  // Compute correlation matrix
  const { symbols, matrix, avgPairwise } = computeCorrelationMatrix(returnSeries, opts.window);

  // Display current portfolio
  console.log("\n--- Current Portfolio ---\n");
  console.log("  " + "Symbol".padEnd(8) + "Qty".padStart(8) + "Price".padStart(10) + "Value".padStart(12) + "Weight".padStart(10));
  console.log("  " + "-".repeat(48));

  let totalValue = 0;
  for (const [sym, qty] of Object.entries(opts.positions)) {
    totalValue += Math.abs(qty * currentPrices[sym]);
  }

  for (const [sym, qty] of Object.entries(opts.positions)) {
    const price = currentPrices[sym];
    const value = qty * price;
    const weight = totalValue > 0 ? value / totalValue : 0;
    console.log(
      "  " +
      sym.padEnd(8) +
      String(qty).padStart(8) +
      ("$" + price.toFixed(2)).padStart(10) +
      ("$" + value.toFixed(0)).padStart(12) +
      ((weight * 100).toFixed(1) + "%").padStart(10)
    );
  }
  console.log("  " + "-".repeat(48));
  console.log("  " + "TOTAL".padEnd(8) + "".padStart(8) + "".padStart(10) + ("$" + totalValue.toFixed(0)).padStart(12));

  // 1. Beta Hedge
  console.log("\n--- Beta Hedging (SPY) ---\n");
  const betaResult = computeBetaHedge(opts.positions, returnSeries, currentPrices, opts.capital);

  console.log(`  Portfolio Beta: ${betaResult.portfolioBeta}`);
  console.log(`  Beta Dollar Exposure: $${betaResult.rawBetaDollar}`);
  console.log("\n  Per-position betas:");
  for (const [sym, beta] of Object.entries(betaResult.positionBetas)) {
    console.log(`    ${sym}: ${beta}`);
  }

  if (betaResult.hedgeOrder) {
    console.log("\n  Hedge Order:");
    console.log(`    ${betaResult.hedgeOrder.direction.toUpperCase()} ${betaResult.hedgeOrder.quantity} ${betaResult.hedgeOrder.symbol} ($${betaResult.hedgeOrder.notionalValue.toFixed(0)})`);
    console.log(`    Reason: ${betaResult.hedgeOrder.reason}`);
  } else {
    console.log("\n  No beta hedge needed (portfolio already near beta-neutral)");
  }

  // 2. Pair Hedges
  console.log("\n--- Pair Hedging ---\n");
  const pairResult = computePairHedges(opts.positions, returnSeries, currentPrices, matrix, symbols);

  if (pairResult.length === 0) {
    console.log("  No pair hedges identified.");
  }
  for (const hedge of pairResult) {
    console.log(`  Pair: ${hedge.pair} (corr: ${hedge.correlation}, type: ${hedge.type})`);
    if (hedge.hedgeOrder) {
      console.log(`    Order: ${hedge.hedgeOrder.direction.toUpperCase()} ${hedge.hedgeOrder.quantity} ${hedge.hedgeOrder.symbol} ($${hedge.hedgeOrder.notionalValue.toFixed(0)})`);
      console.log(`    Reason: ${hedge.hedgeOrder.reason}`);
    }
    if (hedge.note) {
      console.log(`    Note: ${hedge.note}`);
    }
    console.log("");
  }

  // 3. Tail Hedge
  console.log("--- Tail Hedging (Vol Regime) ---\n");
  const tailResult = computeTailHedge(opts.positions, returnSeries, currentPrices, opts.capital, 20);

  console.log(`  Vol Regime:       ${tailResult.volRegime}`);
  console.log(`  Current Vol:      ${(tailResult.currentVol * 100).toFixed(2)}%`);
  console.log(`  Historical Vol:   ${(tailResult.avgVol * 100).toFixed(2)}%`);

  if (tailResult.tailRisk.volRatio) {
    console.log(`  Vol Ratio:        ${tailResult.tailRisk.volRatio}x`);
    console.log(`  VaR (95%):        ${(tailResult.tailRisk.var95 * 100).toFixed(3)}% ($${tailResult.tailRisk.var95Dollar})`);
    console.log(`  CVaR (95%):       ${(tailResult.tailRisk.cvar95 * 100).toFixed(3)}% ($${tailResult.tailRisk.cvar95Dollar})`);
    console.log(`  VaR (99%):        ${(tailResult.tailRisk.var99 * 100).toFixed(3)}%`);
  }

  if (tailResult.hedgeOrders.length > 0) {
    console.log("\n  Tail Hedge Orders:");
    for (const order of tailResult.hedgeOrders) {
      if (order.symbol) {
        console.log(`    ${order.direction.toUpperCase()} ${order.quantity} ${order.symbol} ($${order.notionalValue.toFixed(0)})`);
      }
      console.log(`    Reason: ${order.reason}`);
    }
  } else {
    console.log("\n  No tail hedges needed in current vol regime.");
  }

  // 4. Hedge Efficiency Summary
  console.log("\n--- Hedge Efficiency Summary ---\n");

  // Compute unhedged portfolio vol
  const posSymbols = Object.keys(opts.positions);
  const posWeights = posSymbols.map(s => {
    const idx = symbols.indexOf(s);
    return idx >= 0 ? opts.positions[s] * currentPrices[s] / totalValue : 0;
  });
  const posVols = posSymbols.map(s => annualizedVol(returnSeries[s] || []));
  const posIndices = posSymbols.map(s => symbols.indexOf(s));

  // Build sub-matrix for portfolio
  const subMatrix = posIndices.map((i, a) =>
    posIndices.map((j, b) => (i >= 0 && j >= 0) ? matrix[i][j] : (a === b ? 1 : 0))
  );

  const divResult = diversificationRatio(posWeights, posVols, subMatrix);

  // Estimate total hedge cost
  const allHedgeOrders = [];
  if (betaResult.hedgeOrder) allHedgeOrders.push(betaResult.hedgeOrder);
  for (const ph of pairResult) {
    if (ph.hedgeOrder) allHedgeOrders.push(ph.hedgeOrder);
  }
  for (const th of tailResult.hedgeOrders) {
    if (th.symbol) allHedgeOrders.push(th);
  }

  const totalHedgeCost = allHedgeOrders.reduce((s, o) => s + (o.notionalValue || 0), 0);
  const hedgeCostPct = totalValue > 0 ? totalHedgeCost / totalValue : 0;

  // Rough estimate of vol reduction from hedging
  const estVolReduction = hedgeCostPct * 0.3; // rough heuristic
  const eff = hedgeEfficiency(divResult.portfolioVol, divResult.portfolioVol * (1 - estVolReduction), hedgeCostPct);

  console.log(`  Unhedged Portfolio Vol: ${(divResult.portfolioVol * 100).toFixed(2)}%`);
  console.log(`  Diversification Ratio: ${divResult.ratio.toFixed(4)}`);
  console.log(`  Total Hedge Notional:  $${totalHedgeCost.toFixed(0)} (${(hedgeCostPct * 100).toFixed(1)}% of portfolio)`);
  console.log(`  Est. Vol Reduction:    ${(eff.volReduction * 100).toFixed(1)}%`);
  console.log(`  Hedge Efficiency:      ${eff.efficiency.toFixed(2)}x`);

  // 5. Combined Hedge Orders
  console.log("\n--- All Hedge Orders (for paper-trader.mjs) ---\n");

  if (allHedgeOrders.length === 0) {
    console.log("  No hedge orders generated. Portfolio risk is acceptable.");
  } else {
    console.log("  " + "Action".padEnd(6) + "Qty".padStart(8) + "Symbol".padStart(8) + "Notional".padStart(12) + "  Type".padEnd(16) + "  Reason");
    console.log("  " + "-".repeat(85));

    for (const order of allHedgeOrders) {
      console.log(
        "  " +
        order.direction.toUpperCase().padEnd(6) +
        String(order.quantity).padStart(8) +
        order.symbol.padStart(8) +
        ("$" + order.notionalValue.toFixed(0)).padStart(12) +
        ("  " + order.type).padEnd(16) +
        "  " + order.reason
      );
    }

    // Output as JSON for piping to paper-trader
    console.log("\n  JSON (pipe to paper-trader.mjs):");
    console.log(JSON.stringify(allHedgeOrders, null, 2));
  }

  console.log("\n" + "=".repeat(75));

  return {
    betaHedge: betaResult,
    pairHedges: pairResult,
    tailHedge: tailResult,
    hedgeOrders: allHedgeOrders,
    efficiency: eff,
  };
}

// Run if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("dynamic-hedger.mjs") ||
  process.argv[1].includes("dynamic-hedger")
);
if (isMain) {
  main().catch(err => {
    console.error("Dynamic hedger failed:", err.message);
    process.exit(1);
  });
}
