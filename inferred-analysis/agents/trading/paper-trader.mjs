#!/usr/bin/env node
/**
 * Paper Trader — Alpaca Paper Trading Integration
 *
 * Bridges inferred-analysis strategy signals to Alpaca's paper trading API.
 * Takes the best strategy from agents/strategies/<role>.js, generates signals
 * from price data, and executes paper trades via Alpaca REST API.
 *
 * Usage:
 *   node agents/trading/paper-trader.mjs --agent alpha_researcher --mode paper
 *   node agents/trading/paper-trader.mjs --status
 *   node agents/trading/paper-trader.mjs --flatten
 *
 * Environment:
 *   ALPACA_API_KEY      — Alpaca API key ID
 *   ALPACA_SECRET_KEY   — Alpaca secret key
 *   ALPACA_PAPER=true   — Force paper trading (safety default)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const AGENTS_DIR = join(__dirname, "..");
const OUTPUTS_DIR = join(AGENTS_DIR, "outputs");
const TRADES_TSV = join(OUTPUTS_DIR, "trades.tsv");

// ─── Safety Defaults ──────────────────────────────────────

const SAFETY = {
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE) || 10_000,
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 500,
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS) || 5,
  drawdownKillPct: parseFloat(process.env.DRAWDOWN_KILL_PCT) || 0.05, // 5%
};

// ─── Alpaca REST Client ───────────────────────────────────

const ALPACA_BASE = process.env.ALPACA_PAPER !== "false"
  ? "https://paper-api.alpaca.markets"
  : "https://api.alpaca.markets";

const ALPACA_DATA_BASE = "https://data.alpaca.markets";

function alpacaHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) {
    throw new Error("Missing ALPACA_API_KEY or ALPACA_SECRET_KEY environment variables");
  }
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
    "Content-Type": "application/json",
  };
}

async function alpacaRequest(method, path, body, base) {
  const url = `${base || ALPACA_BASE}${path}`;
  const opts = {
    method,
    headers: alpacaHeaders(),
  };
  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Alpaca ${method} ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

const alpaca = {
  /** Get account info: balance, buying power, equity */
  async getAccount() {
    return alpacaRequest("GET", "/v2/account");
  },

  /** Get all current positions */
  async getPositions() {
    return alpacaRequest("GET", "/v2/positions");
  },

  /** Get a single position by symbol */
  async getPosition(symbol) {
    try {
      return await alpacaRequest("GET", `/v2/positions/${encodeURIComponent(symbol)}`);
    } catch {
      return null; // no position
    }
  },

  /**
   * Submit an order
   * @param {string} symbol - Ticker symbol
   * @param {number} qty - Quantity of shares
   * @param {string} side - "buy" or "sell"
   * @param {string} type - "market", "limit", "stop", "stop_limit"
   * @param {object} [extra] - Optional: { limit_price, stop_price, time_in_force }
   */
  async submitOrder(symbol, qty, side, type, extra = {}) {
    return alpacaRequest("POST", "/v2/orders", {
      symbol,
      qty: String(qty),
      side,
      type,
      time_in_force: extra.time_in_force || "day",
      ...(extra.limit_price ? { limit_price: String(extra.limit_price) } : {}),
      ...(extra.stop_price ? { stop_price: String(extra.stop_price) } : {}),
    });
  },

  /** List orders, optionally filtered */
  async getOrders(status = "all", limit = 50) {
    return alpacaRequest("GET", `/v2/orders?status=${status}&limit=${limit}`);
  },

  /** Close a position by symbol */
  async closePosition(symbol) {
    return alpacaRequest("DELETE", `/v2/positions/${encodeURIComponent(symbol)}`);
  },

  /** Close all positions (flatten) */
  async closeAllPositions() {
    return alpacaRequest("DELETE", "/v2/positions");
  },

  /** Get recent bars for a symbol (for signal generation) */
  async getBars(symbol, timeframe = "1Day", limit = 100) {
    const path = `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&limit=${limit}`;
    return alpacaRequest("GET", path, null, ALPACA_DATA_BASE);
  },

  /** Get latest quote */
  async getLatestQuote(symbol) {
    const path = `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`;
    return alpacaRequest("GET", path, null, ALPACA_DATA_BASE);
  },
};

// ─── Trade Logger ─────────────────────────────────────────

function ensureTradesFile() {
  mkdirSync(OUTPUTS_DIR, { recursive: true });
  if (!existsSync(TRADES_TSV)) {
    writeFileSync(TRADES_TSV, [
      "timestamp", "agent", "symbol", "side", "qty", "price",
      "order_id", "status", "equity_before", "equity_after",
      "daily_pnl", "signal_source",
    ].join("\t") + "\n");
  }
}

function logTrade(entry) {
  ensureTradesFile();
  const line = [
    entry.timestamp || new Date().toISOString(),
    entry.agent || "unknown",
    entry.symbol || "",
    entry.side || "",
    entry.qty || 0,
    entry.price || 0,
    entry.order_id || "",
    entry.status || "",
    entry.equity_before || 0,
    entry.equity_after || 0,
    entry.daily_pnl || 0,
    entry.signal_source || "",
  ].join("\t");
  appendFileSync(TRADES_TSV, line + "\n");
}

// ─── Strategy Bridge ──────────────────────────────────────

/** Agent-to-symbol mapping (mirrors agent-runner.mjs) */
const AGENT_SYMBOLS = {
  alpha_researcher: "SPY",
  stat_arb_quant: "QQQ",
  macro_quant: "TLT",
  vol_quant: "SPY",
  hf_quant: "AAPL",
  microstructure_researcher: "IWM",
  econ_researcher: "GLD",
};

/**
 * Load and evaluate the strategy file for a given agent.
 * Extracts the generateSignals function and CONFIG, then runs signals
 * against the provided price data.
 */
function loadStrategy(agentRole) {
  const stratPath = join(AGENTS_DIR, "strategies", `${agentRole}.js`);
  if (!existsSync(stratPath)) {
    throw new Error(`Strategy file not found: ${stratPath}`);
  }
  const code = readFileSync(stratPath, "utf-8");

  // Extract CONFIG
  const configMatch = code.match(/const CONFIG = (\{[\s\S]*?\n\});/);
  let config = {};
  if (configMatch) {
    try {
      config = new Function(`return ${configMatch[1]}`)();
    } catch {
      console.warn("Could not parse CONFIG from strategy file, using defaults");
    }
  }

  // Extract generateSignals function
  const fnMatch = code.match(/(function generateSignals\(prices\) \{[\s\S]*?\n\})/);
  if (!fnMatch) {
    throw new Error("Could not extract generateSignals() from strategy file");
  }

  // Build the signal generator as a callable function
  const signalFn = new Function("prices", `
    ${fnMatch[1]}
    return generateSignals(prices);
  `);

  return { config, signalFn, stratPath, code };
}

/**
 * Convert Alpaca bar data to the price format our strategies expect.
 */
function alpacaBarsToPrice(bars) {
  return bars.map(b => ({
    date: b.t ? b.t.split("T")[0] : b.Timestamp?.split("T")[0] || "",
    open: b.o ?? b.OpenPrice,
    high: b.h ?? b.HighPrice,
    low: b.l ?? b.LowPrice,
    close: b.c ?? b.ClosePrice,
    volume: b.v ?? b.Volume,
  }));
}

/**
 * Load price data: try Alpaca API first, fall back to local cache, then synthetic.
 */
async function loadPriceData(symbol) {
  // Try Alpaca bars
  try {
    const resp = await alpaca.getBars(symbol, "1Day", 200);
    const bars = resp.bars || resp;
    if (Array.isArray(bars) && bars.length > 0) {
      console.log(`  Price data: ${symbol} from Alpaca API (${bars.length} bars)`);
      return alpacaBarsToPrice(bars);
    }
  } catch (err) {
    console.log(`  Alpaca data fetch failed: ${err.message}`);
  }

  // Try local cache
  const cachePath = join(AGENTS_DIR, "data", "cache", `${symbol}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    console.log(`  Price data: ${symbol} from cache (${cached.count || cached.prices?.length} bars)`);
    return cached.prices;
  }

  // Synthetic fallback
  console.log(`  Price data: ${symbol} synthetic (no API key or cache)`);
  return generateSyntheticPrices(200);
}

function generateSyntheticPrices(days, initialPrice = 100) {
  const prices = [];
  let price = initialPrice;
  const start = new Date();
  start.setDate(start.getDate() - days);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const ret = (Math.random() - 0.48) * 0.02;
    price *= (1 + ret);
    prices.push({
      date: d.toISOString().split("T")[0],
      open: price * (1 + (Math.random() - 0.5) * 0.005),
      high: price * (1 + Math.random() * 0.01),
      low: price * (1 - Math.random() * 0.01),
      close: price,
      volume: Math.floor(Math.random() * 1_000_000) + 100_000,
    });
  }
  return prices;
}

// ─── Safety Controls ──────────────────────────────────────

class SafetyGuard {
  constructor(account) {
    this.startEquity = parseFloat(account.equity);
    this.dailyHighWater = this.startEquity;
    this.tradeCount = 0;
    this.killed = false;
    this.killReason = null;
  }

  async check(account, positions) {
    if (this.killed) return { ok: false, reason: this.killReason };

    const equity = parseFloat(account.equity);
    const dailyPnl = equity - this.startEquity;
    const drawdownPct = (this.dailyHighWater - equity) / this.dailyHighWater;

    if (equity > this.dailyHighWater) this.dailyHighWater = equity;

    // Max daily loss
    if (dailyPnl < -SAFETY.maxDailyLoss) {
      this.killed = true;
      this.killReason = `Daily loss limit hit: $${dailyPnl.toFixed(2)} exceeds -$${SAFETY.maxDailyLoss}`;
      return { ok: false, reason: this.killReason };
    }

    // Drawdown kill switch
    if (drawdownPct > SAFETY.drawdownKillPct) {
      this.killed = true;
      this.killReason = `Drawdown kill switch: ${(drawdownPct * 100).toFixed(2)}% exceeds ${(SAFETY.drawdownKillPct * 100).toFixed(1)}%`;
      return { ok: false, reason: this.killReason };
    }

    // Max open positions
    if (positions.length >= SAFETY.maxOpenPositions) {
      return { ok: false, reason: `Max open positions reached: ${positions.length}/${SAFETY.maxOpenPositions}` };
    }

    return { ok: true, equity, dailyPnl, drawdownPct };
  }

  validateOrderSize(price, qty) {
    const notional = price * qty;
    if (notional > SAFETY.maxPositionSize) {
      return {
        ok: false,
        reason: `Position size $${notional.toFixed(2)} exceeds max $${SAFETY.maxPositionSize}`,
        adjustedQty: Math.floor(SAFETY.maxPositionSize / price),
      };
    }
    return { ok: true, notional };
  }
}

// ─── CLI Argument Parsing ─────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    agent: "alpha_researcher",
    mode: "paper",
    status: false,
    flatten: false,
    symbol: null,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent": opts.agent = args[++i]; break;
      case "--mode": opts.mode = args[++i]; break;
      case "--status": opts.status = true; break;
      case "--flatten": opts.flatten = true; break;
      case "--symbol": opts.symbol = args[++i]; break;
      case "--dry-run": opts.dryRun = true; break;
    }
  }
  return opts;
}

// ─── Commands ─────────────────────────────────────────────

async function showStatus() {
  console.log("\n=== Alpaca Paper Trading Status ===\n");

  const account = await alpaca.getAccount();
  console.log("Account:");
  console.log(`  Equity:        $${parseFloat(account.equity).toLocaleString()}`);
  console.log(`  Buying Power:  $${parseFloat(account.buying_power).toLocaleString()}`);
  console.log(`  Cash:          $${parseFloat(account.cash).toLocaleString()}`);
  console.log(`  Day P&L:       $${(parseFloat(account.equity) - parseFloat(account.last_equity)).toFixed(2)}`);
  console.log(`  Status:        ${account.status}`);
  console.log(`  PDT:           ${account.pattern_day_trader ? "YES" : "no"}`);

  const positions = await alpaca.getPositions();
  console.log(`\nPositions (${positions.length}):`);
  if (positions.length === 0) {
    console.log("  (none)");
  } else {
    for (const p of positions) {
      const pnl = parseFloat(p.unrealized_pl);
      const pnlPct = parseFloat(p.unrealized_plpc) * 100;
      const marker = pnl >= 0 ? "+" : "";
      console.log(`  ${p.symbol.padEnd(6)} ${p.qty.padStart(6)} shares @ $${parseFloat(p.avg_entry_price).toFixed(2)}  P&L: ${marker}$${pnl.toFixed(2)} (${marker}${pnlPct.toFixed(1)}%)`);
    }
  }

  const orders = await alpaca.getOrders("open", 10);
  console.log(`\nOpen Orders (${orders.length}):`);
  if (orders.length === 0) {
    console.log("  (none)");
  } else {
    for (const o of orders) {
      console.log(`  ${o.side.toUpperCase().padEnd(4)} ${o.qty.padStart(6)} ${o.symbol.padEnd(6)} ${o.type} — ${o.status} (${o.id.slice(0, 8)})`);
    }
  }

  // Show recent trades from log
  if (existsSync(TRADES_TSV)) {
    const lines = readFileSync(TRADES_TSV, "utf-8").trim().split("\n");
    const recent = lines.slice(-6); // header + last 5
    console.log(`\nRecent Logged Trades:`);
    for (const line of recent) {
      console.log(`  ${line}`);
    }
  }
}

async function flattenAll() {
  console.log("\n=== Flattening All Positions ===\n");
  const positions = await alpaca.getPositions();
  if (positions.length === 0) {
    console.log("No open positions.");
    return;
  }

  const account = await alpaca.getAccount();
  const equityBefore = parseFloat(account.equity);

  console.log(`Closing ${positions.length} positions...`);
  const result = await alpaca.closeAllPositions();
  console.log("Close all request sent.");

  // Log each closure
  for (const p of positions) {
    logTrade({
      agent: "manual_flatten",
      symbol: p.symbol,
      side: "flatten",
      qty: p.qty,
      price: parseFloat(p.current_price),
      order_id: "flatten_all",
      status: "closing",
      equity_before: equityBefore,
      equity_after: equityBefore, // will settle later
      daily_pnl: parseFloat(p.unrealized_pl),
      signal_source: "manual",
    });
  }

  console.log("Done. Positions are being closed (may take a moment to settle).");
}

async function runPaperTrading(opts) {
  const agentRole = opts.agent;
  const symbol = opts.symbol || AGENT_SYMBOLS[agentRole] || "SPY";

  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  Paper Trader                                    ║`);
  console.log(`║  Agent:  ${agentRole.padEnd(40)}║`);
  console.log(`║  Symbol: ${symbol.padEnd(40)}║`);
  console.log(`║  Mode:   ${opts.mode.padEnd(40)}║`);
  console.log(`║  Dry Run: ${String(opts.dryRun).padEnd(38)}║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  // 1. Load account and init safety
  console.log("Connecting to Alpaca...");
  const account = await alpaca.getAccount();
  const equity = parseFloat(account.equity);
  console.log(`  Account equity: $${equity.toLocaleString()}`);
  console.log(`  Buying power:   $${parseFloat(account.buying_power).toLocaleString()}`);

  const positions = await alpaca.getPositions();
  const guard = new SafetyGuard(account);

  console.log(`  Open positions: ${positions.length}`);
  console.log(`  Safety limits:  max_position=$${SAFETY.maxPositionSize} max_daily_loss=$${SAFETY.maxDailyLoss} max_positions=${SAFETY.maxOpenPositions}`);

  // 2. Load strategy
  console.log(`\nLoading strategy for ${agentRole}...`);
  const { config, signalFn, stratPath } = loadStrategy(agentRole);
  console.log(`  Strategy file: ${stratPath}`);
  console.log(`  CONFIG: lookback=${config.lookback || "?"} positionSize=${config.positionSize || 0.10}`);

  // 3. Load price data
  console.log(`\nFetching price data for ${symbol}...`);
  const prices = await loadPriceData(symbol);
  if (prices.length < 2) {
    console.error("Insufficient price data");
    process.exit(1);
  }
  console.log(`  Loaded ${prices.length} bars`);

  // 4. Generate signals
  console.log("\nGenerating signals...");
  const signals = signalFn(prices);
  if (!signals || signals.length === 0) {
    console.log("No signals generated. Strategy may need more data.");
    process.exit(0);
  }

  const latestSignal = signals[signals.length - 1];
  const signalLabel = latestSignal.signal === 1 ? "LONG" : latestSignal.signal === -1 ? "SHORT" : "FLAT";
  console.log(`  Total signals: ${signals.length}`);
  console.log(`  Latest signal: ${signalLabel} (${latestSignal.signal}) at $${latestSignal.price?.toFixed(2)} on ${latestSignal.date}`);

  // Signal summary
  const longs = signals.filter(s => s.signal === 1).length;
  const shorts = signals.filter(s => s.signal === -1).length;
  const flats = signals.filter(s => s.signal === 0).length;
  console.log(`  Distribution: LONG=${longs} SHORT=${shorts} FLAT=${flats}`);

  // 5. Determine action based on latest signal
  const currentPosition = positions.find(p => p.symbol === symbol);
  const currentSide = currentPosition
    ? (parseFloat(currentPosition.qty) > 0 ? 1 : -1)
    : 0;

  console.log(`\nCurrent position in ${symbol}: ${currentPosition ? `${currentPosition.qty} shares` : "none"}`);
  console.log(`Signal says: ${signalLabel}`);

  if (latestSignal.signal === currentSide) {
    console.log("Signal matches current position. No action needed.");
    logTrade({
      agent: agentRole,
      symbol,
      side: "hold",
      qty: currentPosition?.qty || 0,
      price: latestSignal.price,
      order_id: "n/a",
      status: "hold",
      equity_before: equity,
      equity_after: equity,
      daily_pnl: currentPosition ? parseFloat(currentPosition.unrealized_pl) : 0,
      signal_source: agentRole,
    });
    return;
  }

  // Safety check before trading
  const safetyResult = await guard.check(account, positions);
  if (!safetyResult.ok && latestSignal.signal !== 0) {
    console.log(`\n  SAFETY BLOCK: ${safetyResult.reason}`);
    console.log("  Skipping trade. Consider --flatten if needed.");
    return;
  }

  // 6. Execute trades
  const equityBefore = equity;

  // Close existing position if signal changed
  if (currentPosition && latestSignal.signal !== currentSide) {
    console.log(`\nClosing ${symbol} position (${currentPosition.qty} shares)...`);
    if (opts.dryRun) {
      console.log("  [DRY RUN] Would close position");
    } else {
      try {
        await alpaca.closePosition(symbol);
        console.log("  Position closed.");
        logTrade({
          agent: agentRole,
          symbol,
          side: "close",
          qty: currentPosition.qty,
          price: latestSignal.price,
          order_id: "close",
          status: "filled",
          equity_before: equityBefore,
          equity_after: equityBefore,
          daily_pnl: parseFloat(currentPosition.unrealized_pl),
          signal_source: agentRole,
        });
      } catch (err) {
        console.error(`  Failed to close position: ${err.message}`);
      }
    }
  }

  // Open new position if signal is not flat
  if (latestSignal.signal !== 0) {
    const side = latestSignal.signal === 1 ? "buy" : "sell";
    const positionFraction = config.positionSize || 0.10;
    const tradeCapital = Math.min(equity * positionFraction, SAFETY.maxPositionSize);
    const estimatedPrice = latestSignal.price;
    let qty = Math.floor(tradeCapital / estimatedPrice);

    if (qty < 1) {
      console.log(`\nInsufficient capital for 1 share of ${symbol} at ~$${estimatedPrice.toFixed(2)}`);
      return;
    }

    // Validate against safety limits
    const sizeCheck = guard.validateOrderSize(estimatedPrice, qty);
    if (!sizeCheck.ok) {
      console.log(`\n  SIZE LIMIT: ${sizeCheck.reason}`);
      qty = sizeCheck.adjustedQty;
      if (qty < 1) {
        console.log("  Cannot trade even 1 share within limits.");
        return;
      }
      console.log(`  Adjusted qty to ${qty}`);
    }

    console.log(`\nPlacing order: ${side.toUpperCase()} ${qty} ${symbol} (market, ~$${(estimatedPrice * qty).toFixed(2)})...`);
    if (opts.dryRun) {
      console.log("  [DRY RUN] Would place order");
    } else {
      try {
        const order = await alpaca.submitOrder(symbol, qty, side, "market");
        console.log(`  Order submitted: ${order.id}`);
        console.log(`  Status: ${order.status}`);

        logTrade({
          agent: agentRole,
          symbol,
          side,
          qty,
          price: estimatedPrice,
          order_id: order.id,
          status: order.status,
          equity_before: equityBefore,
          equity_after: equityBefore, // actual settles later
          daily_pnl: 0,
          signal_source: agentRole,
        });
      } catch (err) {
        console.error(`  Order failed: ${err.message}`);
        logTrade({
          agent: agentRole,
          symbol,
          side,
          qty,
          price: estimatedPrice,
          order_id: "error",
          status: `error: ${err.message.slice(0, 80)}`,
          equity_before: equityBefore,
          equity_after: equityBefore,
          daily_pnl: 0,
          signal_source: agentRole,
        });
      }
    }
  } else {
    console.log("\nSignal is FLAT. No new position opened.");
  }

  // 7. Backtest comparison
  console.log("\n─── Backtest vs Paper Comparison ───");
  try {
    const backtestSignals = signalFn(prices);
    let btCapital = 100_000;
    let btPosition = 0;
    let btTrades = 0;
    for (const sig of backtestSignals) {
      const target = sig.signal;
      const curr = btPosition > 0 ? 1 : btPosition < 0 ? -1 : 0;
      if (target !== curr) {
        if (btPosition !== 0) {
          btCapital += btPosition * sig.price;
          btPosition = 0;
          btTrades++;
        }
        if (target !== 0) {
          const alloc = btCapital * (config.positionSize || 0.10);
          btPosition = (target * alloc) / sig.price;
          btCapital -= alloc;
          btTrades++;
        }
      }
    }
    if (btPosition !== 0 && backtestSignals.length > 0) {
      btCapital += btPosition * backtestSignals[backtestSignals.length - 1].price;
    }
    const btReturn = ((btCapital - 100_000) / 100_000 * 100).toFixed(2);
    console.log(`  Backtest return (${prices.length} bars): ${btReturn}%`);
    console.log(`  Backtest trades: ${btTrades}`);
    console.log(`  Paper equity:    $${equity.toLocaleString()}`);
  } catch (err) {
    console.log(`  Backtest comparison failed: ${err.message}`);
  }

  console.log("\nDone.");
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Force paper trading safety
  if (process.env.ALPACA_PAPER === undefined) {
    process.env.ALPACA_PAPER = "true";
  }

  try {
    if (opts.status) {
      await showStatus();
    } else if (opts.flatten) {
      await flattenAll();
    } else {
      await runPaperTrading(opts);
    }
  } catch (err) {
    if (err.message.includes("Missing ALPACA_API_KEY")) {
      console.error("\nError: Alpaca API credentials not set.");
      console.error("Set these environment variables:");
      console.error("  export ALPACA_API_KEY=your_key_id");
      console.error("  export ALPACA_SECRET_KEY=your_secret_key");
      console.error("  export ALPACA_PAPER=true");
      process.exit(1);
    }
    console.error(`\nFatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
