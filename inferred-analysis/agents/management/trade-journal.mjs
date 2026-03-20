#!/usr/bin/env node
/**
 * Trade Journal & Analytics System
 *
 * Records, closes, and analyzes trades for a quant fund platform.
 * P&L breakdowns by period/strategy/symbol, streak analysis,
 * expectancy, risk metrics, and ASCII-formatted summaries.
 *
 * Usage:
 *   node agents/management/trade-journal.mjs          # Run demo
 *   node agents/management/trade-journal.mjs --json   # Output JSON
 *
 * @module trade-journal
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Helpers ────────────────────────────────────────────

let _nextId = 1;
/** @returns {string} Unique trade ID */
function genId() { return `TRD-${String(_nextId++).padStart(5, "0")}`; }
/** @param {string|Date} d @returns {Date} */
function toDate(d) { return d instanceof Date ? d : new Date(d); }
/** @param {number} n @returns {string} Currency formatted */
function fmt$(n) { return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`; }
function isoDay(d) { return toDate(d).toISOString().slice(0, 10); }
function isoWeek(d) {
  const dt = toDate(d), jan1 = new Date(dt.getFullYear(), 0, 1);
  const week = Math.ceil(((dt - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${dt.getFullYear()}-W${String(week).padStart(2, "0")}`;
}
function isoMonth(d) { return toDate(d).toISOString().slice(0, 7); }

/** Group closed trades by a key function, returning { pnl, count, winRate } per group */
function groupBy(closed, keyFn) {
  const g = {};
  for (const t of closed) {
    const k = keyFn(t);
    const b = (g[k] ??= { pnl: 0, count: 0, wins: 0 });
    b.pnl += t.pnl; b.count++; if (t.pnl > 0) b.wins++;
  }
  for (const b of Object.values(g)) b.winRate = b.count ? b.wins / b.count : 0;
  return g;
}

// ─── TradeJournal Class ─────────────────────────────────

/** Trade journal that records entries/exits and computes analytics. */
export class TradeJournal {
  constructor() { /** @type {Map<string, object>} */ this.trades = new Map(); }

  /**
   * Record a new trade entry.
   * @param {object} p
   * @param {string} p.symbol @param {"BUY"|"SELL"} p.side @param {number} p.quantity
   * @param {number} p.price @param {string|Date} p.date @param {string} p.strategy
   * @param {number} [p.fees=0]
   * @returns {string} Trade ID
   */
  recordTrade({ symbol, side, quantity, price, date, strategy, fees = 0 }) {
    const id = genId();
    this.trades.set(id, {
      id, symbol: symbol.toUpperCase(), side: side.toUpperCase(),
      quantity, entryPrice: price, entryDate: toDate(date),
      strategy, fees, exitPrice: null, exitDate: null, closed: false,
    });
    return id;
  }

  /**
   * Close an open position.
   * @param {string} tradeId @param {number} exitPrice @param {string|Date} exitDate
   * @returns {object} Closed trade with computed pnl, returnPct, holdingDays
   */
  closeTrade(tradeId, exitPrice, exitDate) {
    const t = this.trades.get(tradeId);
    if (!t) throw new Error(`Trade ${tradeId} not found`);
    if (t.closed) throw new Error(`Trade ${tradeId} already closed`);
    t.exitPrice = exitPrice; t.exitDate = toDate(exitDate); t.closed = true;
    const dir = t.side === "BUY" ? 1 : -1;
    t.pnl = dir * (t.exitPrice - t.entryPrice) * t.quantity - t.fees;
    t.returnPct = dir * (t.exitPrice - t.entryPrice) / t.entryPrice;
    t.holdingDays = (t.exitDate - t.entryDate) / 86400000;
    return t;
  }

  /** @returns {object[]} All open positions */
  getOpenPositions() { return [...this.trades.values()].filter((t) => !t.closed); }

  /** @returns {object[]} All closed round-trip trades */
  getClosedTrades() { return [...this.trades.values()].filter((t) => t.closed); }

  /**
   * P&L grouped by time period.
   * @param {"day"|"week"|"month"} period
   * @returns {Map<string, number>}
   */
  getPnL(period = "day") {
    const keyFn = period === "week" ? isoWeek : period === "month" ? isoMonth : isoDay;
    const buckets = new Map();
    for (const t of this.getClosedTrades()) {
      const k = keyFn(t.exitDate);
      buckets.set(k, (buckets.get(k) || 0) + t.pnl);
    }
    return new Map([...buckets.entries()].sort());
  }

  /** @returns {object} P&L grouped by strategy name → { pnl, count, winRate } */
  getStrategyBreakdown() { return groupBy(this.getClosedTrades(), (t) => t.strategy); }

  /** @returns {object} P&L grouped by symbol → { pnl, count, winRate } */
  getSymbolBreakdown() { return groupBy(this.getClosedTrades(), (t) => t.symbol); }

  /** @returns {object} avgHoldingDays, bestDayOfWeek, worstDayOfWeek, bestHour, worstHour */
  getTimeAnalysis() {
    const closed = this.getClosedTrades();
    if (!closed.length) return { avgHoldingDays: 0, bestDayOfWeek: null, worstDayOfWeek: null };
    const avgHoldingDays = closed.reduce((s, t) => s + t.holdingDays, 0) / closed.length;
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dowPnl = Array(7).fill(0), dowCnt = Array(7).fill(0);
    const hourPnl = Array(24).fill(0), hourCnt = Array(24).fill(0);
    for (const t of closed) {
      const dow = t.entryDate.getDay(), h = t.entryDate.getHours();
      dowPnl[dow] += t.pnl; dowCnt[dow]++;
      hourPnl[h] += t.pnl; hourCnt[h]++;
    }
    const dowAvg = dowPnl.map((p, i) => (dowCnt[i] ? p / dowCnt[i] : -Infinity));
    const valid = dowAvg.filter((v) => v > -Infinity);
    const bestDow = dowAvg.indexOf(Math.max(...valid));
    const worstDow = dowAvg.indexOf(Math.min(...valid));
    const hourAvg = hourPnl.map((p, i) => (hourCnt[i] ? p / hourCnt[i] : -Infinity));
    const hValid = hourAvg.filter((v) => v > -Infinity);
    return {
      avgHoldingDays: Math.round(avgHoldingDays * 10) / 10,
      bestDayOfWeek: dayNames[bestDow], worstDayOfWeek: dayNames[worstDow],
      bestHour: hValid.length ? hourAvg.indexOf(Math.max(...hValid)) : null,
      worstHour: hValid.length ? hourAvg.indexOf(Math.min(...hValid)) : null,
    };
  }

  /** @returns {object} currentStreak, maxWinStreak, maxLossStreak, streaks[] */
  getStreakAnalysis() {
    const closed = this.getClosedTrades().sort((a, b) => a.exitDate - b.exitDate);
    if (!closed.length) return { currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0, streaks: [] };
    let maxWin = 0, maxLoss = 0, curLen = 0, curType = null;
    const streaks = [];
    for (const t of closed) {
      const type = t.pnl >= 0 ? "win" : "loss";
      if (type === curType) { curLen++; } else {
        if (curType) streaks.push({ type: curType, length: curLen });
        curType = type; curLen = 1;
      }
      if (type === "win" && curLen > maxWin) maxWin = curLen;
      if (type === "loss" && curLen > maxLoss) maxLoss = curLen;
    }
    if (curType) streaks.push({ type: curType, length: curLen });
    return { currentStreak: curLen * (curType === "win" ? 1 : -1), maxWinStreak: maxWin, maxLossStreak: maxLoss, streaks };
  }

  /** @returns {object} expectancy, winRate, avgWin, avgLoss */
  getExpectancy() {
    const closed = this.getClosedTrades();
    if (!closed.length) return { expectancy: 0, winRate: 0, avgWin: 0, avgLoss: 0 };
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl <= 0);
    const winRate = wins.length / closed.length, lossRate = 1 - winRate;
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    return { expectancy: winRate * avgWin - lossRate * avgLoss, winRate, avgWin, avgLoss };
  }

  /** @returns {object} avgRiskReward, largestWin, largestLoss, profitFactor, totalPnl */
  getRiskMetrics() {
    const closed = this.getClosedTrades();
    if (!closed.length) return { avgRiskReward: 0, largestWin: 0, largestLoss: 0, profitFactor: 0, totalPnl: 0 };
    const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl <= 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const avgW = wins.length ? grossProfit / wins.length : 0;
    const avgL = losses.length ? grossLoss / losses.length : 1;
    const pnls = closed.map((t) => t.pnl);
    return {
      avgRiskReward: avgL > 0 ? Math.round((avgW / avgL) * 100) / 100 : Infinity,
      largestWin: Math.max(...pnls), largestLoss: Math.min(...pnls),
      profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : Infinity,
      totalPnl: pnls.reduce((a, b) => a + b, 0),
    };
  }

  /** @returns {string} ASCII-formatted trade journal summary */
  formatSummary() {
    const open = this.getOpenPositions(), risk = this.getRiskMetrics();
    const exp = this.getExpectancy(), streak = this.getStreakAnalysis();
    const time = this.getTimeAnalysis();
    const strats = this.getStrategyBreakdown(), syms = this.getSymbolBreakdown();
    const sep = "═".repeat(60);
    const lines = [
      sep, "  TRADE JOURNAL SUMMARY", sep,
      `  Total Trades : ${this.getClosedTrades().length} closed, ${open.length} open`,
      `  Total P&L    : ${fmt$(risk.totalPnl)}`,
      `  Profit Factor: ${risk.profitFactor}`,
      `  Win Rate     : ${(exp.winRate * 100).toFixed(1)}%`,
      `  Expectancy   : ${fmt$(exp.expectancy)} per trade`,
      `  Avg Win      : ${fmt$(exp.avgWin)}   Avg Loss: ${fmt$(exp.avgLoss)}`,
      `  R:R Ratio    : ${risk.avgRiskReward}`,
      `  Largest Win  : ${fmt$(risk.largestWin)}`,
      `  Largest Loss : ${fmt$(risk.largestLoss)}`,
      "", "  ── Streaks ──",
      `  Current      : ${streak.currentStreak > 0 ? "+" : ""}${streak.currentStreak}`,
      `  Max Win Run  : ${streak.maxWinStreak}   Max Loss Run: ${streak.maxLossStreak}`,
      "", "  ── Time Analysis ──",
      `  Avg Hold     : ${time.avgHoldingDays} days`,
      `  Best Day     : ${time.bestDayOfWeek}   Worst Day: ${time.worstDayOfWeek}`,
      "", "  ── Strategy Breakdown ──",
    ];
    for (const [name, s] of Object.entries(strats))
      lines.push(`    ${name.padEnd(20)} ${fmt$(s.pnl).padStart(10)}  (${s.count} trades, ${(s.winRate * 100).toFixed(0)}% win)`);
    lines.push("", "  ── Symbol Breakdown ──");
    for (const [sym, s] of Object.entries(syms))
      lines.push(`    ${sym.padEnd(8)} ${fmt$(s.pnl).padStart(10)}  (${s.count} trades, ${(s.winRate * 100).toFixed(0)}% win)`);
    lines.push(sep);
    return lines.join("\n");
  }
}

// ─── Standalone Analytics ───────────────────────────────

/**
 * Analyze an array of trade objects without maintaining journal state.
 * @param {object[]} trades - Array with symbol, side, quantity, entryPrice, exitPrice, entryDate, exitDate, strategy, fees
 * @returns {object} Aggregated analytics
 */
export function tradeAnalytics(trades) {
  const journal = new TradeJournal();
  for (const t of trades) {
    const id = journal.recordTrade({
      symbol: t.symbol, side: t.side || "BUY", quantity: t.quantity || 100,
      price: t.entryPrice || t.price, date: t.entryDate || t.date,
      strategy: t.strategy || "unknown", fees: t.fees || 0,
    });
    if (t.exitPrice != null && t.exitDate != null) journal.closeTrade(id, t.exitPrice, t.exitDate);
  }
  return {
    expectancy: journal.getExpectancy(), riskMetrics: journal.getRiskMetrics(),
    strategyBreakdown: journal.getStrategyBreakdown(), symbolBreakdown: journal.getSymbolBreakdown(),
    timeAnalysis: journal.getTimeAnalysis(), streaks: journal.getStreakAnalysis(),
    pnlByDay: Object.fromEntries(journal.getPnL("day")),
  };
}

// ─── CLI Demo ───────────────────────────────────────────

/** Main CLI entry — generates simulated trades and prints analytics. */
async function main() {
  console.log("Trade Journal — Simulated Demo\n");
  const symbols = ["SPY", "AAPL", "TSLA", "MSFT", "QQQ"];
  const strategies = ["momentum", "mean-reversion", "breakout", "pairs-trade"];
  const journal = new TradeJournal();

  // Generate price data
  const priceData = {};
  for (const sym of symbols) priceData[sym] = generateRealisticPrices(sym, "2024-01-01", "2024-12-31");

  // Simulate trades
  const pending = [];
  for (const sym of symbols) {
    const prices = priceData[sym];
    if (prices.length < 20) continue;
    for (let i = 5; i < Math.min(prices.length - 10, 60); i += 7) {
      const entry = prices[i], exitIdx = i + 3 + Math.floor(Math.random() * 7);
      const exit = prices[Math.min(exitIdx, prices.length - 1)];
      const side = entry.close < prices[i - 1].close ? "BUY" : "SELL";
      const id = journal.recordTrade({
        symbol: sym, side, quantity: 50 + Math.floor(Math.random() * 150),
        price: entry.close, date: entry.date, strategy: strategies[i % strategies.length], fees: 1.5,
      });
      pending.push({ id, exitPrice: exit.close, exitDate: exit.date });
    }
  }
  for (const { id, exitPrice, exitDate } of pending) journal.closeTrade(id, exitPrice, exitDate);

  // Output
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({
      expectancy: journal.getExpectancy(), riskMetrics: journal.getRiskMetrics(),
      strategyBreakdown: journal.getStrategyBreakdown(), symbolBreakdown: journal.getSymbolBreakdown(),
      timeAnalysis: journal.getTimeAnalysis(), streaks: journal.getStreakAnalysis(),
      closedCount: journal.getClosedTrades().length, openCount: journal.getOpenPositions().length,
    }, null, 2));
  } else {
    console.log(journal.formatSummary());
    const days = [...journal.getPnL("day").entries()].slice(-10);
    if (days.length) {
      console.log("\n  ── Recent Daily P&L ──");
      for (const [day, pnl] of days) {
        const ch = pnl >= 0 ? "█" : "░", len = Math.min(Math.round(Math.abs(pnl) / 50), 30);
        console.log(`    ${day}  ${fmt$(pnl).padStart(10)}  ${pnl >= 0 ? "+" : "-"}${ch.repeat(len)}`);
      }
    }
  }
}

main().catch(console.error);
