#!/usr/bin/env node
/**
 * BTC Prediction Market Agent — Polymarket 5-Minute Candle Trader
 *
 * Autoresearch loop for BTC prediction markets on Polymarket.
 * Follows the same pattern as agent-runner.mjs:
 *   hypothesize -> apply mutation -> backtest on candle data -> evaluate -> keep/discard
 *
 * Generates synthetic 5-minute BTC candle data when no external API is available.
 * Stubs Polymarket API calls (buy/sell/getMarkets/getPositions) for production use.
 *
 * Usage:
 *   node agents/polymarket/btc-agent.mjs                        # defaults
 *   node agents/polymarket/btc-agent.mjs --iterations 10         # run N experiments
 *   node agents/polymarket/btc-agent.mjs --candles 500           # synthetic candle count
 *   node agents/polymarket/btc-agent.mjs --paperclip-url http://localhost:3100
 *
 * Environment:
 *   POLYMARKET_API_KEY   — Polymarket API key (optional, uses stubs without it)
 *   POLYMARKET_SECRET    — Polymarket signing secret
 *   BTC_DATA_SOURCE      — "synthetic" (default) | URL to candle API endpoint
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

// ─── CLI Args ────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    iterations: 5,
    candles: 500,
    paperclipUrl: "http://localhost:3100",
    companyId: null,
    dryRun: true,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--iterations") opts.iterations = parseInt(args[++i]);
    if (args[i] === "--candles") opts.candles = parseInt(args[++i]);
    if (args[i] === "--paperclip-url") opts.paperclipUrl = args[++i];
    if (args[i] === "--company-id") opts.companyId = args[++i];
    if (args[i] === "--live") opts.dryRun = false;
  }
  return opts;
}

// ─── Polymarket API Stubs ────────────────────────────────
//
// These stubs return plausible shapes so the rest of the agent works.
// When POLYMARKET_API_KEY is set, swap these for real HTTP calls.

const POLY_BASE = "https://clob.polymarket.com";
const POLY_API_KEY = process.env.POLYMARKET_API_KEY || null;
const POLY_SECRET = process.env.POLYMARKET_SECRET || null;

async function polyFetch(method, path, body) {
  if (!POLY_API_KEY) return null; // stub mode
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${POLY_API_KEY}`,
    };
    const res = await fetch(`${POLY_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const polymarket = {
  /** Fetch active BTC 5-minute prediction markets */
  async getMarkets() {
    const live = await polyFetch("GET", "/markets?tag=crypto&asset=BTC&resolution=5min");
    if (live) return live;
    // Stub: simulate two markets (UP / DOWN for next 5-min candle)
    const now = Date.now();
    return [
      {
        id: "btc-5min-up-stub",
        question: "Will BTC close higher in the next 5 minutes?",
        outcomes: ["Yes", "No"],
        prices: [0.52, 0.48],
        volume: 12400,
        endDate: new Date(now + 5 * 60_000).toISOString(),
      },
      {
        id: "btc-5min-down-stub",
        question: "Will BTC close lower in the next 5 minutes?",
        outcomes: ["Yes", "No"],
        prices: [0.48, 0.52],
        volume: 11800,
        endDate: new Date(now + 5 * 60_000).toISOString(),
      },
    ];
  },

  /** Place a buy order on a market outcome */
  async buy(marketId, outcome, amount, price) {
    const live = await polyFetch("POST", "/orders", {
      market: marketId,
      side: "BUY",
      outcome,
      amount,
      price,
    });
    if (live) return live;
    return {
      orderId: `stub-buy-${Date.now()}`,
      market: marketId,
      side: "BUY",
      outcome,
      amount,
      price,
      status: "FILLED",
      fillTimestamp: new Date().toISOString(),
    };
  },

  /** Place a sell order */
  async sell(marketId, outcome, amount, price) {
    const live = await polyFetch("POST", "/orders", {
      market: marketId,
      side: "SELL",
      outcome,
      amount,
      price,
    });
    if (live) return live;
    return {
      orderId: `stub-sell-${Date.now()}`,
      market: marketId,
      side: "SELL",
      outcome,
      amount,
      price,
      status: "FILLED",
      fillTimestamp: new Date().toISOString(),
    };
  },

  /** Get current positions */
  async getPositions() {
    const live = await polyFetch("GET", "/positions");
    if (live) return live;
    return [];
  },
};

// ─── Synthetic BTC 5-Minute Candle Generator ─────────────
//
// Produces realistic 5-minute OHLCV candles using geometric Brownian motion
// with mean-reverting volatility (Heston-like, simplified).

function generateSyntheticCandles(count) {
  const candles = [];
  let price = 65000 + Math.random() * 5000; // start 65k-70k
  let vol = 0.001; // per-candle vol (5-min scale)
  const volMean = 0.001;
  const volRevert = 0.05;
  const drift = 0.0; // no directional bias
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    // Evolve volatility (mean-reverting)
    vol += volRevert * (volMean - vol) + 0.0003 * (Math.random() - 0.5);
    vol = Math.max(0.0002, Math.min(vol, 0.005));

    // Generate intra-candle ticks (open -> high/low -> close)
    const open = price;
    const ret = drift + vol * gaussianRandom();
    const close = open * (1 + ret);

    // High/low from intra-bar excursions
    const intraVol = vol * 0.6;
    const high = Math.max(open, close) * (1 + Math.abs(intraVol * gaussianRandom()));
    const low = Math.min(open, close) * (1 - Math.abs(intraVol * gaussianRandom()));

    // Volume: base + spike on big moves
    const baseVol = 50 + Math.random() * 100;
    const moveSize = Math.abs(ret) / vol;
    const volume = baseVol * (1 + moveSize * 2);

    candles.push({
      date: new Date(now - (count - i) * 5 * 60_000).toISOString(),
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume: round2(volume),
      vwap: round2((high + low + close) / 3), // simplified VWAP
    });

    price = close;
  }
  return candles;
}

function gaussianRandom() {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ─── Fetch Real BTC Data (when BTC_DATA_SOURCE is a URL) ─

async function fetchCandles(count) {
  const source = process.env.BTC_DATA_SOURCE || "synthetic";
  if (source === "synthetic") {
    return generateSyntheticCandles(count);
  }
  // Attempt to fetch from external API
  try {
    const res = await fetch(`${source}?symbol=BTCUSD&interval=5m&limit=${count}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Normalize to our candle format (assumes array of [timestamp, o, h, l, c, v])
    return data.map(d => ({
      date: new Date(d[0] || d.timestamp).toISOString(),
      open: parseFloat(d[1] || d.open),
      high: parseFloat(d[2] || d.high),
      low: parseFloat(d[3] || d.low),
      close: parseFloat(d[4] || d.close),
      volume: parseFloat(d[5] || d.volume),
      vwap: parseFloat(d[6] || d.vwap || ((parseFloat(d[2] || d.high) + parseFloat(d[3] || d.low) + parseFloat(d[4] || d.close)) / 3)),
    }));
  } catch (err) {
    console.warn(`Failed to fetch candles from ${source}: ${err.message}. Falling back to synthetic.`);
    return generateSyntheticCandles(count);
  }
}

// ─── Strategy Mutations (Crypto/BTC-specific) ────────────

const MUTATIONS = [
  {
    name: "btc_momentum",
    description: "Short-term momentum: buy on N-candle up-streak, sell on down-streak",
    generate() {
      const streak = 2 + Math.floor(Math.random() * 4);
      const minMove = 0.0005 + Math.random() * 0.002;
      return {
        name: "btc_momentum",
        params: { streak, minMove },
        fn: function generateSignals(candles, params) {
          const signals = [];
          for (let i = params.streak; i < candles.length; i++) {
            let upCount = 0, downCount = 0;
            for (let j = i - params.streak; j < i; j++) {
              const ret = (candles[j + 1].close - candles[j].close) / candles[j].close;
              if (ret > params.minMove) upCount++;
              if (ret < -params.minMove) downCount++;
            }
            let signal = 0;
            if (upCount === params.streak) signal = 1;
            if (downCount === params.streak) signal = -1;
            signals.push({ date: candles[i].date, signal, price: candles[i].close });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "btc_rsi",
    description: "RSI contrarian on 5-min candles: buy oversold, sell overbought",
    generate() {
      const period = 6 + Math.floor(Math.random() * 18);
      const oversold = 20 + Math.floor(Math.random() * 15);
      const overbought = 100 - oversold;
      return {
        name: "btc_rsi",
        params: { period, oversold, overbought },
        fn: function generateSignals(candles, params) {
          const signals = [];
          for (let i = params.period + 1; i < candles.length; i++) {
            let gains = 0, losses = 0;
            for (let j = i - params.period; j < i; j++) {
              const change = candles[j + 1].close - candles[j].close;
              if (change > 0) gains += change;
              else losses -= change;
            }
            const avgGain = gains / params.period;
            const avgLoss = losses / params.period;
            const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
            const rsi = 100 - 100 / (1 + rs);
            let signal = 0;
            if (rsi < params.oversold) signal = 1;
            if (rsi > params.overbought) signal = -1;
            signals.push({ date: candles[i].date, signal, price: candles[i].close });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "btc_vwap_reversion",
    description: "Mean reversion to VWAP: buy below VWAP, sell above",
    generate() {
      const lookback = 10 + Math.floor(Math.random() * 30);
      const threshold = 0.001 + Math.random() * 0.004;
      return {
        name: "btc_vwap_reversion",
        params: { lookback, threshold },
        fn: function generateSignals(candles, params) {
          const signals = [];
          for (let i = params.lookback; i < candles.length; i++) {
            // Rolling VWAP
            let priceVolSum = 0, volSum = 0;
            for (let j = i - params.lookback; j <= i; j++) {
              priceVolSum += candles[j].vwap * candles[j].volume;
              volSum += candles[j].volume;
            }
            const rollingVwap = priceVolSum / volSum;
            const deviation = (candles[i].close - rollingVwap) / rollingVwap;
            let signal = 0;
            if (deviation < -params.threshold) signal = 1;  // below VWAP -> buy
            if (deviation > params.threshold) signal = -1;  // above VWAP -> sell
            signals.push({ date: candles[i].date, signal, price: candles[i].close });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "btc_bollinger",
    description: "Bollinger Band breakout/reversion on 5-min candles",
    generate() {
      const period = 10 + Math.floor(Math.random() * 20);
      const stdMult = 1.5 + Math.random() * 1.5;
      const mode = Math.random() > 0.5 ? "reversion" : "breakout";
      return {
        name: "btc_bollinger",
        params: { period, stdMult, mode },
        fn: function generateSignals(candles, params) {
          const signals = [];
          for (let i = params.period; i < candles.length; i++) {
            let sum = 0, sqSum = 0;
            for (let j = i - params.period; j < i; j++) {
              sum += candles[j].close;
              sqSum += candles[j].close * candles[j].close;
            }
            const mean = sum / params.period;
            const std = Math.sqrt(sqSum / params.period - mean * mean);
            const upper = mean + std * params.stdMult;
            const lower = mean - std * params.stdMult;
            const price = candles[i].close;
            let signal = 0;
            if (params.mode === "reversion") {
              if (price < lower) signal = 1;   // buy at lower band
              if (price > upper) signal = -1;  // sell at upper band
            } else {
              if (price > upper) signal = 1;   // breakout up
              if (price < lower) signal = -1;  // breakout down
            }
            signals.push({ date: candles[i].date, signal, price });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "btc_order_flow",
    description: "Volume-weighted order flow imbalance signal",
    generate() {
      const lookback = 5 + Math.floor(Math.random() * 15);
      const threshold = 0.1 + Math.random() * 0.4;
      return {
        name: "btc_order_flow",
        params: { lookback, threshold },
        fn: function generateSignals(candles, params) {
          const signals = [];
          for (let i = params.lookback; i < candles.length; i++) {
            // Approximate order flow from candle data:
            // positive volume when close > open (buying pressure)
            // negative volume when close < open (selling pressure)
            let buyVol = 0, sellVol = 0;
            for (let j = i - params.lookback; j <= i; j++) {
              const range = candles[j].high - candles[j].low;
              if (range === 0) continue;
              const buyRatio = (candles[j].close - candles[j].low) / range;
              buyVol += candles[j].volume * buyRatio;
              sellVol += candles[j].volume * (1 - buyRatio);
            }
            const totalVol = buyVol + sellVol;
            const imbalance = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;
            let signal = 0;
            if (imbalance > params.threshold) signal = 1;   // buy pressure
            if (imbalance < -params.threshold) signal = -1;  // sell pressure
            signals.push({ date: candles[i].date, signal, price: candles[i].close });
          }
          return signals;
        },
      };
    },
  },
  {
    name: "btc_ma_crossover",
    description: "EMA crossover tuned for 5-minute BTC candles",
    generate() {
      const fast = 3 + Math.floor(Math.random() * 10);
      const slow = fast + 5 + Math.floor(Math.random() * 20);
      return {
        name: "btc_ma_crossover",
        params: { fast, slow },
        fn: function generateSignals(candles, params) {
          const signals = [];
          // Compute EMAs
          const emaFast = [candles[0].close];
          const emaSlow = [candles[0].close];
          const multFast = 2 / (params.fast + 1);
          const multSlow = 2 / (params.slow + 1);
          for (let i = 1; i < candles.length; i++) {
            emaFast.push(candles[i].close * multFast + emaFast[i - 1] * (1 - multFast));
            emaSlow.push(candles[i].close * multSlow + emaSlow[i - 1] * (1 - multSlow));
          }
          for (let i = params.slow; i < candles.length; i++) {
            let signal = 0;
            if (emaFast[i] > emaSlow[i] * 1.0002) signal = 1;
            if (emaFast[i] < emaSlow[i] * 0.9998) signal = -1;
            signals.push({ date: candles[i].date, signal, price: candles[i].close });
          }
          return signals;
        },
      };
    },
  },
];

// ─── Backtester ──────────────────────────────────────────
//
// Runs a strategy's signal function against candle data.
// Simulates Polymarket-style binary bets: each signal is a bet
// on the direction of the next candle.

function backtest(candles, strategy) {
  const signals = strategy.fn(candles, strategy.params);
  if (!signals || signals.length === 0) {
    return { sharpe: -Infinity, sortino: -Infinity, calmar: -Infinity, total_return: 0, max_drawdown: 0, win_rate: 0, trades: 0, pnl: 0 };
  }

  const returns = [];
  let wins = 0;
  let trades = 0;
  const betSize = 10; // $10 per bet (Polymarket style)

  for (let i = 0; i < signals.length - 1; i++) {
    if (signals[i].signal === 0) continue;
    trades++;

    // Next candle outcome
    const nextIdx = candles.findIndex(c => c.date === signals[i].date);
    if (nextIdx < 0 || nextIdx >= candles.length - 1) continue;

    const nextReturn = (candles[nextIdx + 1].close - candles[nextIdx].close) / candles[nextIdx].close;
    // Profit if direction matches signal
    const correct = (signals[i].signal > 0 && nextReturn > 0) || (signals[i].signal < 0 && nextReturn < 0);

    // Polymarket payout: ~1.8x on correct (accounting for spread), lose stake on wrong
    const payout = correct ? betSize * 0.8 : -betSize;
    returns.push(payout / betSize); // normalized return
    if (correct) wins++;
  }

  if (trades === 0) {
    return { sharpe: -Infinity, sortino: -Infinity, calmar: -Infinity, total_return: 0, max_drawdown: 0, win_rate: 0, trades: 0, pnl: 0 };
  }

  const totalReturn = returns.reduce((a, b) => a + b, 0);
  const meanReturn = totalReturn / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const downside = returns.filter(r => r < 0);
  const downsideVar = downside.length > 0
    ? downside.reduce((sum, r) => sum + r ** 2, 0) / downside.length
    : 0;
  const downsideDev = Math.sqrt(downsideVar);

  // Cumulative PnL for drawdown
  let peak = 0, maxDD = 0, cumulative = 0;
  for (const r of returns) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const dd = (peak - cumulative);
    if (dd > maxDD) maxDD = dd;
  }

  const sharpe = stdDev > 0 ? meanReturn / stdDev : 0;
  const sortino = downsideDev > 0 ? meanReturn / downsideDev : 0;
  const calmar = maxDD > 0 ? totalReturn / maxDD : totalReturn > 0 ? 10 : 0;
  const winRate = trades > 0 ? wins / trades : 0;

  return {
    sharpe: round2(sharpe),
    sortino: round2(sortino),
    calmar: round2(calmar),
    total_return: round2(totalReturn),
    max_drawdown: round2(maxDD),
    win_rate: round2(winRate),
    trades,
    pnl: round2(totalReturn * betSize),
  };
}

// ─── Results Logger ──────────────────────────────────────

function logResult(experiment, metrics, status) {
  const resultsPath = join(ROOT, "agents", "results.tsv");
  const header = "timestamp\tagent\texperiment\tsharpe\tsortino\tcalmar\ttotal_return\tmax_drawdown\twin_rate\ttrades\tstatus\n";

  if (!existsSync(resultsPath)) {
    writeFileSync(resultsPath, header);
  }

  const line = [
    new Date().toISOString(),
    "polymarket_btc",
    experiment,
    metrics?.sharpe?.toFixed(4) ?? "0",
    metrics?.sortino?.toFixed(4) ?? "0",
    metrics?.calmar?.toFixed(4) ?? "0",
    metrics?.total_return?.toFixed(4) ?? "0",
    metrics?.max_drawdown?.toFixed(4) ?? "0",
    metrics?.win_rate?.toFixed(4) ?? "0",
    metrics?.trades ?? 0,
    status,
  ].join("\t");

  const content = readFileSync(resultsPath, "utf-8");
  writeFileSync(resultsPath, content + line + "\n");
}

// ─── Paperclip Integration ───────────────────────────────

async function paperclipApi(baseUrl, method, path, body) {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function reportToPaperclip(baseUrl, companyId, agentId, result) {
  if (!companyId || !agentId) return;
  try {
    await paperclipApi(baseUrl, "POST", `/api/companies/${companyId}/issues`, {
      title: `BTC Polymarket: ${result.experiment} — ${result.mutation}`,
      body: [
        `**Strategy**: ${result.mutation}`,
        `**Sharpe**: ${result.metrics?.sharpe?.toFixed(4) ?? "N/A"}`,
        `**Win Rate**: ${((result.metrics?.win_rate ?? 0) * 100).toFixed(1)}%`,
        `**PnL**: $${result.metrics?.pnl?.toFixed(2) ?? "0.00"}`,
        `**Trades**: ${result.metrics?.trades ?? 0}`,
        `**Status**: ${result.status}`,
      ].join("\n"),
      assigneeAgentId: agentId,
      priority: result.status === "keep" ? "high" : "medium",
    });
  } catch {
    // Paperclip reporting is best-effort
  }
}

// ─── Polymarket Trade Execution (dry-run aware) ──────────

async function executeTrade(signal, market, dryRun) {
  if (signal === 0) return null;
  const outcome = signal > 0 ? "Yes" : "No";
  const marketId = signal > 0 ? market[0].id : market[1].id;
  const price = signal > 0 ? market[0].prices[0] : market[1].prices[0];

  if (dryRun) {
    return { action: "DRY_RUN", marketId, outcome, price, amount: 10 };
  }

  return signal > 0
    ? await polymarket.buy(marketId, outcome, 10, price)
    : await polymarket.sell(marketId, outcome, 10, price);
}

// ─── Main Loop ───────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Polymarket BTC 5-Min Prediction Agent                   ║`);
  console.log(`║  Iterations: ${String(opts.iterations).padEnd(42)}║`);
  console.log(`║  Candles:    ${String(opts.candles).padEnd(42)}║`);
  console.log(`║  Mode:       ${(opts.dryRun ? "DRY RUN" : "LIVE").padEnd(42)}║`);
  console.log(`║  Data:       ${(process.env.BTC_DATA_SOURCE || "synthetic").padEnd(42)}║`);
  console.log(`║  Polymarket: ${(POLY_API_KEY ? "API key set" : "stub mode").padEnd(42)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);

  // Fetch candle data
  console.log("Fetching BTC candle data...");
  const candles = await fetchCandles(opts.candles);
  console.log(`Loaded ${candles.length} 5-minute candles`);
  console.log(`Price range: $${Math.min(...candles.map(c => c.low)).toFixed(2)} — $${Math.max(...candles.map(c => c.high)).toFixed(2)}\n`);

  // Fetch markets (for trade execution context)
  const markets = await polymarket.getMarkets();
  console.log(`Active markets: ${markets.length}\n`);

  // Run baseline with first mutation
  const baselineMutation = MUTATIONS[0].generate();
  console.log("Running baseline...");
  const baseline = backtest(candles, baselineMutation);
  let bestSharpe = baseline.sharpe;
  let bestStrategy = baselineMutation;
  console.log(`Baseline (${baselineMutation.name}): Sharpe=${bestSharpe.toFixed(4)} WinRate=${(baseline.win_rate * 100).toFixed(1)}% Trades=${baseline.trades}\n`);
  logResult("baseline", baseline, "baseline");

  // Find Paperclip agent
  let companyId = opts.companyId;
  let agentId = null;
  if (!companyId) {
    const companies = await paperclipApi(opts.paperclipUrl, "GET", "/api/companies");
    if (companies?.length > 0) companyId = companies[0].id;
  }
  if (companyId) {
    const agents = await paperclipApi(opts.paperclipUrl, "GET", `/api/companies/${companyId}/agents`);
    const agent = agents?.find(a => a.capabilities?.includes("[polymarket_btc]"));
    if (agent) {
      agentId = agent.id;
      console.log(`Paperclip agent: ${agent.name} [${agent.id}]\n`);
    }
  }

  // Autoresearch loop
  let keepCount = 0, discardCount = 0;

  for (let i = 1; i <= opts.iterations; i++) {
    const mutationDef = MUTATIONS[Math.floor(Math.random() * MUTATIONS.length)];
    const strategy = mutationDef.generate();

    console.log(`─── Experiment ${i}/${opts.iterations}: ${strategy.name} ───`);
    console.log(`  ${mutationDef.description}`);
    console.log(`  Params: ${JSON.stringify(strategy.params)}`);

    const result = backtest(candles, strategy);

    if (result.sharpe > bestSharpe) {
      console.log(`  KEEP — Sharpe: ${result.sharpe.toFixed(4)} (was ${bestSharpe.toFixed(4)}) | WinRate: ${(result.win_rate * 100).toFixed(1)}% | PnL: $${result.pnl.toFixed(2)} | Trades: ${result.trades}`);
      bestSharpe = result.sharpe;
      bestStrategy = strategy;
      keepCount++;
      logResult(strategy.name, result, "keep");

      // Execute a sample trade with the winning strategy (if live)
      if (!opts.dryRun && markets.length > 0) {
        const lastSignal = backtest(candles.slice(-20), strategy);
        // Would place trade based on latest signal
      }
    } else {
      console.log(`  DISCARD — Sharpe: ${result.sharpe.toFixed(4)} <= ${bestSharpe.toFixed(4)} | WinRate: ${(result.win_rate * 100).toFixed(1)}% | PnL: $${result.pnl.toFixed(2)} | Trades: ${result.trades}`);
      discardCount++;
      logResult(strategy.name, result, "discard");
    }

    await reportToPaperclip(opts.paperclipUrl, companyId, agentId, {
      experiment: `${i}/${opts.iterations}`,
      mutation: strategy.name,
      status: result.sharpe > bestSharpe ? "keep" : "discard",
      metrics: result,
    });
  }

  // Final summary
  const finalResult = backtest(candles, bestStrategy);

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Results Summary                                         ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  Best Strategy:  ${bestStrategy.name.padEnd(38)}║`);
  console.log(`║  Best Params:    ${JSON.stringify(bestStrategy.params).slice(0, 38).padEnd(38)}║`);
  console.log(`║  Best Sharpe:    ${bestSharpe.toFixed(4).padEnd(38)}║`);
  console.log(`║  Win Rate:       ${((finalResult.win_rate * 100).toFixed(1) + "%").padEnd(38)}║`);
  console.log(`║  Total PnL:      ${("$" + finalResult.pnl.toFixed(2)).padEnd(38)}║`);
  console.log(`║  Trades:         ${String(finalResult.trades).padEnd(38)}║`);
  console.log(`║  Kept:           ${String(keepCount).padEnd(38)}║`);
  console.log(`║  Discarded:      ${String(discardCount).padEnd(38)}║`);
  console.log(`║  Keep Rate:      ${((keepCount / opts.iterations * 100).toFixed(1) + "%").padEnd(38)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
}

main().catch(err => {
  console.error("BTC agent failed:", err.message);
  process.exit(1);
});
