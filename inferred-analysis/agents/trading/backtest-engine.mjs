#!/usr/bin/env node
/**
 * Event-Driven Backtesting Engine
 *
 * Simulates historical trading with realistic execution modeling:
 * commission, slippage, margin, and order management.
 *
 * Usage:
 *   node agents/trading/backtest-engine.mjs              # Run momentum demo
 *   node agents/trading/backtest-engine.mjs --symbols SPY QQQ
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Order Class ─────────────────────────────────────────

const OrderState = { PENDING: "PENDING", FILLED: "FILLED", CANCELLED: "CANCELLED", REJECTED: "REJECTED" };
const OrderSide = { BUY: "BUY", SELL: "SELL" };
const OrderType = { MARKET: "MARKET", LIMIT: "LIMIT", STOP: "STOP" };

let nextOrderId = 1;

class Order {
  constructor(symbol, side, qty, type = OrderType.MARKET, limitPrice = null) {
    this.id = nextOrderId++;
    this.symbol = symbol;
    this.side = side;
    this.qty = Math.abs(qty);
    this.type = type;
    this.limitPrice = limitPrice;
    this.state = OrderState.PENDING;
    this.filledQty = 0;
    this.filledPrice = 0;
    this.filledAt = null;
    this.createdAt = null;
    this.commission = 0;
    this.slippage = 0;
  }

  fill(price, commission, slippage, date) {
    this.state = OrderState.FILLED;
    this.filledQty = this.qty;
    this.filledPrice = price;
    this.filledAt = date;
    this.commission = commission;
    this.slippage = slippage;
  }

  cancel() { this.state = OrderState.CANCELLED; }
  reject(reason) { this.state = OrderState.REJECTED; this.rejectReason = reason; }

  toString() {
    return `Order#${this.id} ${this.side} ${this.qty} ${this.symbol} @${this.type}` +
      (this.limitPrice ? ` limit=${this.limitPrice}` : "") +
      ` [${this.state}]`;
  }
}

// ─── Position Class ──────────────────────────────────────

class Position {
  constructor(symbol) {
    this.symbol = symbol;
    this.qty = 0;
    this.avgCost = 0;
    this.realizedPnl = 0;
    this.totalCommission = 0;
  }

  get isFlat() { return this.qty === 0; }
  get isLong() { return this.qty > 0; }
  get isShort() { return this.qty < 0; }

  unrealizedPnl(currentPrice) {
    return this.qty * (currentPrice - this.avgCost);
  }

  marketValue(currentPrice) {
    return Math.abs(this.qty) * currentPrice;
  }

  applyFill(side, qty, price, commission) {
    const direction = side === OrderSide.BUY ? 1 : -1;
    const fillQty = qty * direction;

    if (this.qty === 0) {
      // New position
      this.qty = fillQty;
      this.avgCost = price;
    } else if (Math.sign(this.qty) === Math.sign(fillQty)) {
      // Adding to position — weighted average cost
      const totalCost = this.avgCost * Math.abs(this.qty) + price * qty;
      this.qty += fillQty;
      this.avgCost = totalCost / Math.abs(this.qty);
    } else {
      // Reducing or reversing
      const closeQty = Math.min(Math.abs(this.qty), qty);
      this.realizedPnl += closeQty * (price - this.avgCost) * Math.sign(this.qty);
      const remaining = qty - closeQty;

      if (remaining === 0) {
        this.qty += fillQty;
        if (this.qty === 0) this.avgCost = 0;
      } else {
        // Reversal — new position in opposite direction
        this.qty = remaining * direction;
        this.avgCost = price;
      }
    }

    this.totalCommission += commission;
  }

  clone() {
    const p = new Position(this.symbol);
    p.qty = this.qty;
    p.avgCost = this.avgCost;
    p.realizedPnl = this.realizedPnl;
    p.totalCommission = this.totalCommission;
    return p;
  }
}

// ─── BacktestEngine ──────────────────────────────────────

class BacktestEngine {
  constructor(options = {}) {
    this.initialCapital = options.initialCapital ?? 100_000;
    this.commissionBps = options.commissionBps ?? 5;      // 5 bps per side
    this.slippageBps = options.slippageBps ?? 3;          // 3 bps slippage
    this.marginReq = options.marginReq ?? 0.25;           // 25% margin

    this.cash = this.initialCapital;
    this.feeds = {};                 // symbol → price array
    this.positions = {};             // symbol → Position
    this.orders = [];                // all orders
    this.pendingOrders = [];         // currently pending
    this.trades = [];                // filled order log
    this.equityCurve = [];
    this.drawdownCurve = [];

    this.strategyFn = null;
    this._onBar = [];
    this._onFill = [];
    this._onRebalance = [];

    this._currentBar = {};           // symbol → current bar
    this._barIndex = 0;
    this._currentDate = null;
    this._peakEquity = this.initialCapital;
    this._running = false;
  }

  // ─── Data & Strategy Setup ────────────────────────────

  addDataFeed(symbol, prices) {
    this.feeds[symbol.toUpperCase()] = prices;
  }

  setStrategy(strategyFn) {
    this.strategyFn = strategyFn;
  }

  // ─── Event Registration ───────────────────────────────

  onBar(callback) { this._onBar.push(callback); }
  onFill(callback) { this._onFill.push(callback); }
  onRebalance(callback) { this._onRebalance.push(callback); }

  // ─── Order Management ─────────────────────────────────

  submitOrder(symbol, side, qty, type = OrderType.MARKET, limitPrice = null) {
    symbol = symbol.toUpperCase();
    if (qty <= 0) return null;

    const order = new Order(symbol, side, qty, type, limitPrice);
    order.createdAt = this._currentDate;

    // Reject if no data feed
    if (!this.feeds[symbol]) {
      order.reject("No data feed for " + symbol);
      this.orders.push(order);
      return order;
    }

    // Margin check for new buys
    if (side === OrderSide.BUY) {
      const price = this._currentBar[symbol]?.close ?? 0;
      const cost = qty * price * this.marginReq;
      if (cost > this.cash) {
        order.reject("Insufficient margin");
        this.orders.push(order);
        return order;
      }
    }

    this.orders.push(order);
    this.pendingOrders.push(order);
    return order;
  }

  cancelOrder(orderId) {
    const idx = this.pendingOrders.findIndex(o => o.id === orderId);
    if (idx >= 0) {
      this.pendingOrders[idx].cancel();
      this.pendingOrders.splice(idx, 1);
      return true;
    }
    return false;
  }

  getOpenOrders() {
    return [...this.pendingOrders];
  }

  // ─── Portfolio Queries ────────────────────────────────

  getPosition(symbol) {
    symbol = symbol.toUpperCase();
    if (!this.positions[symbol]) this.positions[symbol] = new Position(symbol);
    return this.positions[symbol];
  }

  getEquity() {
    let equity = this.cash;
    for (const sym of Object.keys(this.positions)) {
      const pos = this.positions[sym];
      if (pos.qty === 0) continue;
      const price = this._currentBar[sym]?.close ?? pos.avgCost;
      equity += pos.qty * price;
    }
    return equity;
  }

  getCash() { return this.cash; }

  getMarginUsed() {
    let margin = 0;
    for (const sym of Object.keys(this.positions)) {
      const pos = this.positions[sym];
      if (pos.qty === 0) continue;
      const price = this._currentBar[sym]?.close ?? pos.avgCost;
      margin += Math.abs(pos.qty) * price * this.marginReq;
    }
    return margin;
  }

  // ─── Execution Engine ─────────────────────────────────

  _processOrders(date) {
    const filled = [];
    const remaining = [];

    for (const order of this.pendingOrders) {
      const bar = this._currentBar[order.symbol];
      if (!bar) { remaining.push(order); continue; }

      let execPrice = null;

      if (order.type === OrderType.MARKET) {
        execPrice = bar.open;
      } else if (order.type === OrderType.LIMIT) {
        if (order.side === OrderSide.BUY && bar.low <= order.limitPrice) {
          execPrice = Math.min(order.limitPrice, bar.open);
        } else if (order.side === OrderSide.SELL && bar.high >= order.limitPrice) {
          execPrice = Math.max(order.limitPrice, bar.open);
        }
      } else if (order.type === OrderType.STOP) {
        if (order.side === OrderSide.BUY && bar.high >= order.limitPrice) {
          execPrice = Math.max(order.limitPrice, bar.open);
        } else if (order.side === OrderSide.SELL && bar.low <= order.limitPrice) {
          execPrice = Math.min(order.limitPrice, bar.open);
        }
      }

      if (execPrice === null) {
        remaining.push(order);
        continue;
      }

      // Apply slippage
      const slippageMult = order.side === OrderSide.BUY ? 1 : -1;
      const slippage = execPrice * (this.slippageBps / 10000) * slippageMult;
      execPrice += slippage;

      // Commission
      const commission = execPrice * order.qty * (this.commissionBps / 10000);

      // Update position
      const pos = this.getPosition(order.symbol);
      pos.applyFill(order.side, order.qty, execPrice, commission);

      // Update cash
      const cashDelta = order.side === OrderSide.BUY
        ? -(order.qty * execPrice) - commission
        : (order.qty * execPrice) - commission;
      this.cash += cashDelta;

      order.fill(execPrice, commission, Math.abs(slippage) * order.qty, date);
      this.trades.push(order);
      filled.push(order);
    }

    this.pendingOrders = remaining;

    // Fire fill callbacks
    for (const order of filled) {
      for (const cb of this._onFill) cb(order, this);
    }
  }

  // ─── Main Run Loop ────────────────────────────────────

  run() {
    if (this._running) throw new Error("Backtest already running");
    this._running = true;

    const symbols = Object.keys(this.feeds);
    if (symbols.length === 0) throw new Error("No data feeds added");

    // Build unified date index
    const dateSet = new Set();
    for (const sym of symbols) {
      for (const bar of this.feeds[sym]) dateSet.add(bar.date);
    }
    const dates = [...dateSet].sort();

    // Build lookup maps: symbol → date → bar
    const lookup = {};
    for (const sym of symbols) {
      lookup[sym] = {};
      for (const bar of this.feeds[sym]) lookup[sym][bar.date] = bar;
    }

    // Track bars for strategy lookback
    const history = {};
    for (const sym of symbols) history[sym] = [];

    let rebalanceTick = 0;
    const rebalanceInterval = 20; // every 20 bars

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      this._currentDate = date;
      this._barIndex = i;

      // Update current bars
      for (const sym of symbols) {
        const bar = lookup[sym][date];
        if (bar) {
          this._currentBar[sym] = bar;
          history[sym].push(bar);
        }
      }

      // Process pending orders at bar open
      this._processOrders(date);

      // Fire onBar callbacks
      for (const cb of this._onBar) cb(date, this._currentBar, this);

      // Run strategy
      if (this.strategyFn) {
        this.strategyFn({
          date,
          bars: this._currentBar,
          history,
          barIndex: i,
          engine: this,
        });
      }

      // Rebalance event
      rebalanceTick++;
      if (rebalanceTick >= rebalanceInterval) {
        rebalanceTick = 0;
        for (const cb of this._onRebalance) cb(date, this);
      }

      // Record equity
      const equity = this.getEquity();
      this.equityCurve.push({ date, equity });
      if (equity > this._peakEquity) this._peakEquity = equity;
      const dd = this._peakEquity > 0 ? (equity - this._peakEquity) / this._peakEquity : 0;
      this.drawdownCurve.push({ date, drawdown: dd });
    }

    this._running = false;
    return this.getResults();
  }

  // ─── Results ──────────────────────────────────────────

  getResults() {
    const eq = this.equityCurve;
    if (eq.length === 0) return { error: "No data" };

    const finalEquity = eq[eq.length - 1].equity;
    const totalReturn = (finalEquity - this.initialCapital) / this.initialCapital;
    const days = eq.length;
    const years = days / 252;

    // Annualized return
    const annReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;

    // Daily returns for Sharpe/Sortino
    const dailyReturns = [];
    for (let i = 1; i < eq.length; i++) {
      dailyReturns.push((eq[i].equity - eq[i - 1].equity) / eq[i - 1].equity);
    }

    const avgDaily = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
    const variance = dailyReturns.reduce((s, r) => s + (r - avgDaily) ** 2, 0) / (dailyReturns.length || 1);
    const dailyStd = Math.sqrt(variance);

    // Downside deviation for Sortino
    const downside = dailyReturns.filter(r => r < 0);
    const downVar = downside.reduce((s, r) => s + r ** 2, 0) / (downside.length || 1);
    const downsideStd = Math.sqrt(downVar);

    const sharpe = dailyStd > 0 ? (avgDaily / dailyStd) * Math.sqrt(252) : 0;
    const sortino = downsideStd > 0 ? (avgDaily / downsideStd) * Math.sqrt(252) : 0;

    // Max drawdown
    const maxDD = Math.min(...this.drawdownCurve.map(d => d.drawdown));

    // Win rate from trades
    const roundTrips = this._computeRoundTrips();
    const winners = roundTrips.filter(t => t.pnl > 0).length;
    const winRate = roundTrips.length > 0 ? winners / roundTrips.length : 0;
    const avgWin = roundTrips.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / (winners || 1);
    const losers = roundTrips.filter(t => t.pnl <= 0);
    const avgLoss = losers.reduce((s, t) => s + t.pnl, 0) / (losers.length || 1);
    const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? Infinity : 0;

    // Total commissions
    const totalCommission = this.trades.reduce((s, o) => s + o.commission, 0);

    // Calmar ratio
    const calmar = maxDD !== 0 ? annReturn / Math.abs(maxDD) : 0;

    return {
      initialCapital: this.initialCapital,
      finalEquity: +finalEquity.toFixed(2),
      totalReturn: +(totalReturn * 100).toFixed(2),
      annualizedReturn: +(annReturn * 100).toFixed(2),
      sharpeRatio: +sharpe.toFixed(3),
      sortinoRatio: +sortino.toFixed(3),
      maxDrawdown: +(maxDD * 100).toFixed(2),
      calmarRatio: +calmar.toFixed(3),
      totalTrades: this.trades.length,
      roundTrips: roundTrips.length,
      winRate: +(winRate * 100).toFixed(1),
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      profitFactor: +profitFactor.toFixed(2),
      totalCommission: +totalCommission.toFixed(2),
      tradingDays: days,
      startDate: eq[0].date,
      endDate: eq[eq.length - 1].date,
      equityCurve: eq,
      drawdownCurve: this.drawdownCurve,
    };
  }

  _computeRoundTrips() {
    // Group fills by symbol and pair entries/exits
    const bySymbol = {};
    for (const t of this.trades) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
      bySymbol[t.symbol].push(t);
    }

    const roundTrips = [];
    for (const sym of Object.keys(bySymbol)) {
      const fills = bySymbol[sym];
      let openQty = 0;
      let openCost = 0;
      let openSide = null;

      for (const fill of fills) {
        const dir = fill.side === OrderSide.BUY ? 1 : -1;
        const qty = fill.filledQty * dir;

        if (openQty === 0) {
          openQty = qty;
          openCost = fill.filledPrice;
          openSide = fill.side;
        } else if (Math.sign(openQty) !== Math.sign(qty)) {
          const closeQty = Math.min(Math.abs(openQty), fill.filledQty);
          const pnl = closeQty * (fill.filledPrice - openCost) * Math.sign(openQty);
          roundTrips.push({
            symbol: sym,
            side: openSide,
            qty: closeQty,
            entryPrice: openCost,
            exitPrice: fill.filledPrice,
            pnl: pnl - fill.commission,
            entryDate: fills[0].filledAt,
            exitDate: fill.filledAt,
          });
          openQty += qty;
          if (openQty !== 0) {
            openCost = fill.filledPrice;
            openSide = fill.side;
          }
        } else {
          // Adding to position
          const totalCost = openCost * Math.abs(openQty) + fill.filledPrice * fill.filledQty;
          openQty += qty;
          openCost = totalCost / Math.abs(openQty);
        }
      }
    }
    return roundTrips;
  }

  // ─── ASCII Report ─────────────────────────────────────

  formatResults() {
    const r = this.getResults();
    if (r.error) return `Backtest error: ${r.error}`;

    const line = "─".repeat(52);
    const dline = "═".repeat(52);

    const pad = (label, value, width = 50) => {
      const valStr = String(value);
      const gap = width - label.length - valStr.length;
      return `  ${label}${" ".repeat(Math.max(1, gap))}${valStr}`;
    };

    const pct = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    const usd = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Equity sparkline (30 chars wide)
    const spark = this._sparkline(r.equityCurve.map(e => e.equity), 40);

    const lines = [
      "",
      `  ${dline}`,
      `  BACKTEST RESULTS`,
      `  ${dline}`,
      `  ${r.startDate}  -->  ${r.endDate}   (${r.tradingDays} trading days)`,
      `  ${line}`,
      "",
      pad("Initial Capital", usd(r.initialCapital)),
      pad("Final Equity", usd(r.finalEquity)),
      pad("Total Return", pct(r.totalReturn)),
      pad("Annualized Return", pct(r.annualizedReturn)),
      "",
      `  ${line}`,
      `  RISK METRICS`,
      `  ${line}`,
      "",
      pad("Sharpe Ratio", r.sharpeRatio.toFixed(3)),
      pad("Sortino Ratio", r.sortinoRatio.toFixed(3)),
      pad("Max Drawdown", pct(r.maxDrawdown)),
      pad("Calmar Ratio", r.calmarRatio.toFixed(3)),
      "",
      `  ${line}`,
      `  TRADE STATISTICS`,
      `  ${line}`,
      "",
      pad("Total Trades", r.totalTrades),
      pad("Round Trips", r.roundTrips),
      pad("Win Rate", r.winRate.toFixed(1) + "%"),
      pad("Avg Winner", usd(r.avgWin)),
      pad("Avg Loser", usd(r.avgLoss)),
      pad("Profit Factor", r.profitFactor.toFixed(2)),
      pad("Total Commission", usd(r.totalCommission)),
      "",
      `  ${line}`,
      `  EQUITY CURVE`,
      `  ${line}`,
      "",
      `  ${spark}`,
      "",
      `  ${dline}`,
      "",
    ];

    return lines.join("\n");
  }

  _sparkline(data, width = 40) {
    if (data.length === 0) return "";
    const chars = "▁▂▃▄▅▆▇█";
    const step = Math.max(1, Math.floor(data.length / width));
    const sampled = [];
    for (let i = 0; i < data.length; i += step) sampled.push(data[i]);
    const min = Math.min(...sampled);
    const max = Math.max(...sampled);
    const range = max - min || 1;
    return sampled.map(v => chars[Math.floor(((v - min) / range) * (chars.length - 1))]).join("");
  }
}

// ─── CLI Demo: Dual Momentum Strategy ────────────────────

function momentumStrategy({ date, bars, history, barIndex, engine }) {
  const lookback = 20;       // 20-day momentum window
  const symbols = Object.keys(bars);

  if (barIndex < lookback) return;

  for (const sym of symbols) {
    const h = history[sym];
    if (!h || h.length < lookback) continue;

    const current = h[h.length - 1].close;
    const past = h[h.length - lookback].close;
    const momentum = (current - past) / past;

    const pos = engine.getPosition(sym);
    const equity = engine.getEquity();
    const targetSize = Math.floor((equity * 0.3) / current); // 30% per position

    // Go long on strong positive momentum
    if (momentum > 0.03 && pos.qty === 0) {
      engine.submitOrder(sym, OrderSide.BUY, targetSize, OrderType.MARKET);
    }
    // Exit on momentum reversal
    else if (momentum < -0.02 && pos.qty > 0) {
      engine.submitOrder(sym, OrderSide.SELL, pos.qty, OrderType.MARKET);
    }
    // Short on strong negative momentum
    else if (momentum < -0.04 && pos.qty === 0) {
      const shortSize = Math.floor((equity * 0.15) / current);
      engine.submitOrder(sym, OrderSide.SELL, shortSize, OrderType.MARKET);
    }
    // Cover short on positive reversal
    else if (momentum > 0.01 && pos.qty < 0) {
      engine.submitOrder(sym, OrderSide.BUY, Math.abs(pos.qty), OrderType.MARKET);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Parse symbols from CLI
  const symIdx = args.indexOf("--symbols");
  const symbols = symIdx >= 0
    ? args.slice(symIdx + 1).filter(a => !a.startsWith("--"))
    : ["SPY", "QQQ", "AAPL"];

  console.log("\n  Backtest Engine — Dual Momentum Strategy");
  console.log("  Symbols:", symbols.join(", "));
  console.log("");

  // Initialize engine
  const engine = new BacktestEngine({
    initialCapital: 100_000,
    commissionBps: 5,
    slippageBps: 3,
    marginReq: 0.25,
  });

  // Load synthetic price data
  for (const sym of symbols) {
    const prices = generateRealisticPrices(sym, "2021-01-01", "2025-01-01");
    engine.addDataFeed(sym, prices);
  }

  // Wire up events
  engine.onFill((order) => {
    if (args.includes("--verbose")) {
      console.log(`  [FILL] ${order}`);
    }
  });

  engine.onRebalance((date, eng) => {
    if (args.includes("--verbose")) {
      console.log(`  [REBALANCE] ${date}  equity=${eng.getEquity().toFixed(2)}  cash=${eng.getCash().toFixed(2)}`);
    }
  });

  // Set strategy and run
  engine.setStrategy(momentumStrategy);
  engine.run();

  // Print report
  console.log(engine.formatResults());
}

// ─── Exports ─────────────────────────────────────────────

export { BacktestEngine, Order, Position, OrderState, OrderSide, OrderType };

// Run CLI if called directly
const isMain = process.argv[1]?.replace(/\\/g, "/").includes("backtest-engine");
if (isMain) {
  main().catch(err => {
    console.error("Backtest failed:", err.message);
    process.exit(1);
  });
}
