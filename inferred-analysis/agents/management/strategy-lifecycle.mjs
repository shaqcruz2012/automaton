#!/usr/bin/env node
/**
 * Strategy Lifecycle Manager — Inferred Analysis
 *
 * Manages quant trading strategies through: RESEARCH → INCUBATION → PAPER_TRADING → LIVE → SCALING → DEGRADING → RETIRED
 * Enforces promotion gates (Sharpe, drawdown, days) at each stage.
 *
 * Usage:
 *   node agents/management/strategy-lifecycle.mjs
 *   import { StrategyLifecycleManager } from './strategy-lifecycle.mjs'
 * @module strategy-lifecycle
 */
import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Constants ──────────────────────────────────────────

/** @enum {string} Strategy lifecycle states */
const STATES = {
  RESEARCH: "RESEARCH",
  INCUBATION: "INCUBATION",
  PAPER_TRADING: "PAPER_TRADING",
  LIVE: "LIVE",
  SCALING: "SCALING",
  DEGRADING: "DEGRADING",
  RETIRED: "RETIRED",
};

/** Ordered promotion path (DEGRADING/RETIRED are lateral transitions) */
const PROMO_PATH = [STATES.RESEARCH, STATES.INCUBATION, STATES.PAPER_TRADING, STATES.LIVE, STATES.SCALING];

/** Capital allocation multipliers by state (INCUBATION=0%, LIVE=base, SCALING=2x) */
const CAP_MULT = {
  [STATES.RESEARCH]: 0, [STATES.INCUBATION]: 0, [STATES.PAPER_TRADING]: 0,
  [STATES.LIVE]: 1.0, [STATES.SCALING]: 2.0, [STATES.DEGRADING]: 0.5, [STATES.RETIRED]: 0,
};

// ─── Statistical Helpers ────────────────────────────────

/**
 * Compute daily log returns from price bars.
 * @param {{ close: number }[]} prices - OHLCV bar array
 * @returns {number[]} daily log returns
 */
function computeReturns(prices) {
  return prices.slice(1).map((p, i) => Math.log(p.close / prices[i].close));
}

/**
 * Annualized Sharpe ratio from daily returns.
 * @param {number[]} ret - daily return series
 * @param {number} rf - daily risk-free rate (default ~4% annual)
 * @returns {number} annualized Sharpe ratio
 */
function sharpeRatio(ret, rf = 0.04 / 252) {
  if (ret.length < 2) return 0;
  const ex = ret.map(r => r - rf);
  const mu = ex.reduce((a, b) => a + b, 0) / ex.length;
  const std = Math.sqrt(ex.reduce((a, r) => a + (r - mu) ** 2, 0) / (ex.length - 1));
  return std === 0 ? 0 : (mu / std) * Math.sqrt(252);
}

/**
 * Maximum drawdown from daily returns as positive fraction.
 * @param {number[]} ret - daily return series
 * @returns {number} max drawdown (e.g. 0.15 = 15%)
 */
function maxDrawdown(ret) {
  let peak = 1, eq = 1, dd = 0;
  for (const r of ret) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    dd = Math.max(dd, (peak - eq) / peak);
  }
  return dd;
}

/**
 * Rolling Sharpe over a trailing window.
 * @param {number[]} ret - daily returns
 * @param {number} w - lookback window in days
 * @returns {number} Sharpe of trailing window
 */
function rollingSharpe(ret, w = 63) {
  return sharpeRatio(ret.length < w ? ret : ret.slice(-w));
}

/**
 * Estimate annualized alpha (excess return over benchmark).
 * @param {number[]} s - strategy daily returns
 * @param {number[]} b - benchmark daily returns
 * @returns {number} annualized alpha
 */
function estimateAlpha(s, b) {
  const n = Math.min(s.length, b.length);
  if (n < 20) return 0;
  const sm = s.slice(-n).reduce((a, v) => a + v, 0) / n;
  const bm = b.slice(-n).reduce((a, v) => a + v, 0) / n;
  return (sm - bm) * 252;
}

// ─── Strategy Lifecycle Manager ─────────────────────────
/** Manages strategy lifecycles with promotion gates and capital allocation. */
export class StrategyLifecycleManager {
  /** @param {number} baseAllocation base capital per strategy ($) */
  constructor(baseAllocation = 100_000) {
    /** @type {Map<string, object>} */ this.strategies = new Map();
    this.baseAllocation = baseAllocation;
    this.benchmarkReturns = null;
  }

  /** @param {number[]} returns benchmark daily returns */
  setBenchmark(returns) { this.benchmarkReturns = returns; }

  /**
   * Register a new strategy in RESEARCH state.
   * @param {string} name unique strategy identifier
   * @param {object} config strategy configuration ({ asset, type, author })
   * @returns {object} created strategy record
   */
  registerStrategy(name, config = {}) {
    if (this.strategies.has(name)) throw new Error(`Strategy "${name}" already registered`);
    const strategy = {
      name, state: STATES.RESEARCH, config, registeredAt: new Date().toISOString(),
      stateHistory: [{ state: STATES.RESEARCH, at: new Date().toISOString() }],
      metrics: { backtestSharpe: null, backtestDays: 0, walkForwardSharpe: null,
        walkForwardMaxDD: null, paperSharpe: null, paperDays: 0,
        liveSharpe: null, liveDays: 0, liveAlpha: null, rollingSharpe63: null },
      retireReason: null, degradingSince: null,
    };
    this.strategies.set(name, strategy);
    return strategy;
  }

  _get(name) { const s = this.strategies.get(name); if (!s) throw new Error(`Strategy "${name}" not found`); return s; }
  _transition(s, st) { s.state = st; s.stateHistory.push({ state: st, at: new Date().toISOString() }); }

  /**
   * Promote strategy to next lifecycle stage (with validation gates).
   * @param {string} name @returns {{ success: boolean, from: string, to: string, reason?: string }}
   */
  promote(name) {
    const s = this._get(name), idx = PROMO_PATH.indexOf(s.state);
    if (s.state === STATES.RETIRED) return { success: false, from: s.state, to: s.state, reason: "Cannot promote retired strategy" };
    if (s.state === STATES.DEGRADING) return { success: false, from: s.state, to: s.state, reason: "Must recover or retire" };
    if (idx < 0 || idx >= PROMO_PATH.length - 1) return { success: false, from: s.state, to: s.state, reason: "At max level" };
    const next = PROMO_PATH[idx + 1], gate = this._checkGate(s, next);
    if (!gate.pass) return { success: false, from: s.state, to: next, reason: gate.reason };
    this._transition(s, next);
    return { success: true, from: PROMO_PATH[idx], to: next };
  }

  /** Check promotion gate for target state. */
  _checkGate(s, target) {
    const m = s.metrics, fmt = (v) => (v ?? 0).toFixed(2);
    switch (target) {
      case STATES.INCUBATION:
        if (!m.backtestSharpe || m.backtestSharpe <= 0.5) return { pass: false, reason: `Backtest Sharpe ${fmt(m.backtestSharpe)} <= 0.5` };
        if (m.backtestDays < 252) return { pass: false, reason: `Backtest days ${m.backtestDays} < 252` };
        return { pass: true };
      case STATES.PAPER_TRADING:
        if (!m.walkForwardSharpe || m.walkForwardSharpe <= 0.3) return { pass: false, reason: `WF Sharpe ${fmt(m.walkForwardSharpe)} <= 0.3` };
        if (m.walkForwardMaxDD != null && m.walkForwardMaxDD > 0.20) return { pass: false, reason: `WF MaxDD ${(m.walkForwardMaxDD * 100).toFixed(1)}% > 20%` };
        return { pass: true };
      case STATES.LIVE:
        if (m.paperDays < 63) return { pass: false, reason: `Paper days ${m.paperDays} < 63` };
        if (!m.paperSharpe || m.paperSharpe <= 0.2) return { pass: false, reason: `Paper Sharpe ${fmt(m.paperSharpe)} <= 0.2` };
        return { pass: true };
      case STATES.SCALING:
        if (m.liveDays < 126) return { pass: false, reason: `Live days ${m.liveDays} < 126` };
        if (!m.liveSharpe || m.liveSharpe <= 0.3) return { pass: false, reason: `Live Sharpe ${fmt(m.liveSharpe)} <= 0.3` };
        if (!m.liveAlpha || m.liveAlpha <= 0) return { pass: false, reason: `No alpha (${fmt(m.liveAlpha)})` };
        return { pass: true };
      default: return { pass: false, reason: `Unknown state: ${target}` };
    }
  }

  /** Demote strategy back one stage. @param {string} name */
  demote(name) {
    const s = this._get(name);
    if (s.state === STATES.RETIRED) return { success: false, from: s.state, to: s.state, reason: "Cannot demote retired" };
    if (s.state === STATES.DEGRADING) { this._transition(s, STATES.RETIRED); s.retireReason = "Demoted from DEGRADING"; return { success: true, from: STATES.DEGRADING, to: STATES.RETIRED }; }
    const idx = PROMO_PATH.indexOf(s.state);
    if (idx <= 0) return { success: false, from: s.state, to: s.state, reason: "At lowest stage" };
    this._transition(s, PROMO_PATH[idx - 1]);
    return { success: true, from: PROMO_PATH[idx], to: PROMO_PATH[idx - 1] };
  }

  /** Force retire a strategy. @param {string} name @param {string} reason */
  retire(name, reason = "Manual retirement") {
    const s = this._get(name);
    if (s.state === STATES.RETIRED) return { success: false, from: s.state };
    const from = s.state; this._transition(s, STATES.RETIRED); s.retireReason = reason;
    return { success: true, from };
  }

  /** Get current state and metrics. @param {string} name */
  getStatus(name) {
    const s = this._get(name);
    return { name: s.name, state: s.state, config: s.config, registeredAt: s.registeredAt,
      metrics: { ...s.metrics }, capitalAllocation: CAP_MULT[s.state] * this.baseAllocation,
      retireReason: s.retireReason, transitions: s.stateHistory.length };
  }

  /** Get all strategies grouped by state. */
  getAllStrategies() {
    const g = Object.fromEntries(Object.values(STATES).map(s => [s, []]));
    for (const [name, s] of this.strategies) g[s.state].push({ name, metrics: { ...s.metrics }, allocation: CAP_MULT[s.state] * this.baseAllocation });
    return g;
  }

  /**
   * Evaluate strategy returns — updates metrics, checks auto-promote/demote.
   * @param {string} name @param {number[]} returns daily return series
   * @returns {{ action: string, details: string }}
   */
  evaluateStrategy(name, returns) {
    const s = this._get(name), m = s.metrics;
    const sr = sharpeRatio(returns), mdd = maxDrawdown(returns), r63 = rollingSharpe(returns, 63);
    const alpha = this.benchmarkReturns ? estimateAlpha(returns, this.benchmarkReturns) : null;
    // Update metrics by state
    if (s.state === STATES.RESEARCH) { m.backtestSharpe = sr; m.backtestDays = returns.length; }
    else if (s.state === STATES.INCUBATION) { m.walkForwardSharpe = sr; m.walkForwardMaxDD = mdd; }
    else if (s.state === STATES.PAPER_TRADING) { m.paperSharpe = sr; m.paperDays = returns.length; }
    else if (s.state === STATES.LIVE || s.state === STATES.SCALING) { m.liveSharpe = sr; m.liveDays = returns.length; m.liveAlpha = alpha; m.rollingSharpe63 = r63; }
    else if (s.state === STATES.DEGRADING) { m.liveSharpe = sr; m.rollingSharpe63 = r63; }
    // Auto-demote: rolling 63d Sharpe < -0.5
    if ((s.state === STATES.LIVE || s.state === STATES.SCALING) && r63 < -0.5) {
      const from = s.state; this._transition(s, STATES.DEGRADING); s.degradingSince = new Date().toISOString();
      return { action: "AUTO_DEMOTE", details: `${from} → DEGRADING (63d Sharpe ${r63.toFixed(2)})` };
    }
    if (s.state === STATES.DEGRADING && r63 < -0.5) {
      this._transition(s, STATES.RETIRED); s.retireReason = `No recovery (Sharpe ${r63.toFixed(2)})`;
      return { action: "AUTO_RETIRE", details: `DEGRADING → RETIRED (Sharpe ${r63.toFixed(2)})` };
    }
    if (s.state === STATES.DEGRADING && r63 >= 0) {
      this._transition(s, STATES.LIVE); s.degradingSince = null;
      return { action: "RECOVERY", details: `DEGRADING → LIVE (Sharpe recovered ${r63.toFixed(2)})` };
    }
    return { action: "HOLD", details: `Sharpe=${sr.toFixed(2)}, DD=${(mdd * 100).toFixed(1)}%` };
  }

  /** Generate formatted ASCII lifecycle report. @returns {string} */
  getLifecycleReport() {
    const div = "=".repeat(85), lines = [div, "  STRATEGY LIFECYCLE REPORT", div, ""];
    const icons = { RESEARCH: "[R]", INCUBATION: "[I]", PAPER_TRADING: "[P]", LIVE: "[L]", SCALING: "[S]", DEGRADING: "[!]", RETIRED: "[X]" };
    lines.push(`  ${"Strategy".padEnd(20)} ${"State".padEnd(18)} ${"Sharpe".padEnd(9)} ${"MaxDD".padEnd(9)} ${"Days".padEnd(7)} Capital`);
    lines.push("  " + "-".repeat(80));
    for (const [name, s] of this.strategies) {
      const m = s.metrics, sr = m.liveSharpe ?? m.paperSharpe ?? m.walkForwardSharpe ?? m.backtestSharpe;
      const dd = m.walkForwardMaxDD, days = m.liveDays || m.paperDays || m.backtestDays || 0;
      const cap = CAP_MULT[s.state] * this.baseAllocation;
      lines.push(`  ${name.padEnd(20)} ${(icons[s.state] + " " + s.state).padEnd(18)} ${(sr != null ? sr.toFixed(2) : "--").padEnd(9)} ${(dd != null ? (dd * 100).toFixed(1) + "%" : "--").padEnd(9)} ${String(days).padEnd(7)} $${cap.toLocaleString()}`);
    }
    lines.push("  " + "-".repeat(80));
    const cnt = Object.fromEntries(Object.values(STATES).map(s => [s, 0]));
    for (const [, s] of this.strategies) cnt[s.state]++;
    lines.push(`  ${cnt.RESEARCH}R | ${cnt.INCUBATION}I | ${cnt.PAPER_TRADING}P | ${cnt.LIVE}L | ${cnt.SCALING}S | ${cnt.DEGRADING}D | ${cnt.RETIRED}X`);
    const total = [...this.strategies.values()].reduce((s, v) => s + CAP_MULT[v.state] * this.baseAllocation, 0);
    lines.push(`  Total Capital: $${total.toLocaleString()}`);
    lines.push(div);
    return lines.join("\n");
  }

  /** Suggested capital per strategy based on lifecycle stage. */
  getCapitalAllocation() {
    const allocs = []; let total = 0;
    for (const [name, s] of this.strategies) {
      const m = CAP_MULT[s.state] ?? 0, cap = m * this.baseAllocation; total += cap;
      allocs.push({ name, state: s.state, multiplier: m, capital: cap, pctOfBase: (m * 100).toFixed(0) + "%" });
    }
    return { allocations: allocs, totalDeployed: total, baseAllocation: this.baseAllocation };
  }
}

// ─── Synthetic Return Generators (for demo) ─────────────

/**
 * Generate synthetic strategy returns with controlled alpha and market beta.
 * Uses Box-Muller for zero-mean Gaussian noise.
 * @param {number[]} mktRet - benchmark market returns
 * @param {number} alpha - daily excess return (strategy edge)
 * @param {number} vol - idiosyncratic volatility
 * @param {number} len - number of trading days
 * @param {number} beta - market beta exposure
 * @returns {number[]} synthetic daily returns
 */
function syntheticReturns(mktRet, alpha, vol, len, beta = 0.15) {
  let seed = Math.abs(alpha * 1e7 + vol * 1e5) | 0 || 7;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const randn = () => {
    const u1 = rng() * 0.9998 + 0.0001, u2 = rng() * 0.9998 + 0.0001;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  return Array.from({ length: len }, (_, i) =>
    (i < mktRet.length ? mktRet[i] * beta : 0) + alpha + vol * randn()
  );
}

/** Generate consistently negative returns to trigger degradation. */
function degradingReturns(len) {
  let seed = 42;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  return Array.from({ length: len }, () => -0.003 + 0.01 * rng());
}

// ─── CLI Demo ───────────────────────────────────────────
async function main() {
  console.log("\n=== Strategy Lifecycle Manager Demo ===\n");
  const mgr = new StrategyLifecycleManager(250_000);
  const bench = computeReturns(generateRealisticPrices("SPY", "2019-01-01", "2025-06-01"));
  mgr.setBenchmark(bench);

  const cfgs = [
    { name: "MomentumAlpha", config: { asset: "SPY", type: "momentum", author: "team-1" }, a: 0.0008, v: 0.006 },
    { name: "PairsMeanRev", config: { asset: "AAPL/MSFT", type: "mean-reversion", author: "team-2" }, a: 0.0006, v: 0.005 },
    { name: "VolSurface", config: { asset: "QQQ", type: "volatility", author: "team-1" }, a: 0.0003, v: 0.009 },
    { name: "MacroCarry", config: { asset: "TLT/GLD", type: "carry", author: "team-3" }, a: 0.0007, v: 0.005 },
    { name: "MicroHFT", config: { asset: "XLF", type: "market-making", author: "team-2" }, a: 0.0010, v: 0.005 },
  ];
  cfgs.forEach(c => { mgr.registerStrategy(c.name, c.config); console.log(`  Registered: ${c.name}`); });

  // Phase 1: Backtest
  console.log("\n--- Phase 1: Backtest (RESEARCH) ---");
  for (const c of cfgs) {
    mgr.evaluateStrategy(c.name, syntheticReturns(bench, c.a, c.v, 1260));
    const s = mgr.getStatus(c.name); console.log(`  ${c.name}: Sharpe=${s.metrics.backtestSharpe?.toFixed(2)}, Days=${s.metrics.backtestDays}`);
  }

  // Phase 2: RESEARCH → INCUBATION
  console.log("\n--- Phase 2: Promote → INCUBATION ---");
  cfgs.forEach(c => { const r = mgr.promote(c.name); console.log(`  ${c.name}: ${r.success ? "PROMOTED" : "BLOCKED"} ${r.reason || ""}`); });

  // Phase 3: Walk-forward
  console.log("\n--- Phase 3: Walk-Forward (INCUBATION) ---");
  for (const c of cfgs) { if (mgr.getStatus(c.name).state !== STATES.INCUBATION) continue;
    mgr.evaluateStrategy(c.name, syntheticReturns(bench.slice(-504), c.a * 0.7, c.v, 504));
    const s = mgr.getStatus(c.name); console.log(`  ${c.name}: WF-Sharpe=${s.metrics.walkForwardSharpe?.toFixed(2)}, MaxDD=${((s.metrics.walkForwardMaxDD ?? 0) * 100).toFixed(1)}%`);
  }

  // Phase 4: INCUBATION → PAPER_TRADING
  console.log("\n--- Phase 4: Promote → PAPER_TRADING ---");
  cfgs.forEach(c => { if (mgr.getStatus(c.name).state !== STATES.INCUBATION) return; const r = mgr.promote(c.name); console.log(`  ${c.name}: ${r.success ? "PROMOTED" : "BLOCKED"} ${r.reason || ""}`); });

  // Phase 5: Paper trading
  console.log("\n--- Phase 5: Paper Trading ---");
  for (const c of cfgs) { if (mgr.getStatus(c.name).state !== STATES.PAPER_TRADING) continue;
    mgr.evaluateStrategy(c.name, syntheticReturns(bench.slice(-126), c.a * 0.5, c.v, 126));
    const s = mgr.getStatus(c.name); console.log(`  ${c.name}: Paper-Sharpe=${s.metrics.paperSharpe?.toFixed(2)}, Days=${s.metrics.paperDays}`);
  }

  // Phase 6: PAPER_TRADING → LIVE
  console.log("\n--- Phase 6: Promote → LIVE ---");
  cfgs.forEach(c => { if (mgr.getStatus(c.name).state !== STATES.PAPER_TRADING) return; const r = mgr.promote(c.name); console.log(`  ${c.name}: ${r.success ? "PROMOTED" : "BLOCKED"} ${r.reason || ""}`); });

  // Phase 7: Live evaluation + scaling
  console.log("\n--- Phase 7: Live → SCALING ---");
  for (const c of cfgs) { if (mgr.getStatus(c.name).state !== STATES.LIVE) continue;
    mgr.evaluateStrategy(c.name, syntheticReturns(bench.slice(-252), c.a, c.v * 0.5, 252, 0.8));
    const s = mgr.getStatus(c.name); console.log(`  ${c.name}: Live-Sharpe=${s.metrics.liveSharpe?.toFixed(2)}, Alpha=${(s.metrics.liveAlpha ?? 0).toFixed(4)}`);
    const r = mgr.promote(c.name); console.log(`    ${r.success ? "→ SCALING" : "Blocked"} ${r.reason || ""}`);
  }

  // Phase 8: Degradation
  console.log("\n--- Phase 8: Degradation ---");
  const ms = mgr.getStatus("MacroCarry");
  if (ms.state === STATES.LIVE || ms.state === STATES.SCALING) {
    let r = mgr.evaluateStrategy("MacroCarry", degradingReturns(126));
    console.log(`  MacroCarry: ${r.action} (${r.details})`);
    if (mgr.getStatus("MacroCarry").state === STATES.DEGRADING) {
      r = mgr.evaluateStrategy("MacroCarry", degradingReturns(63));
      console.log(`  MacroCarry: ${r.action} (${r.details})`);
    }
  }

  // Phase 9: Force retire
  console.log("\n--- Phase 9: Force Retire ---");
  const rr = mgr.retire("MicroHFT", "Spread compression in XLF");
  console.log(`  MicroHFT: ${rr.success ? "RETIRED" : "ALREADY RETIRED"} from ${rr.from}`);

  // Reports
  console.log("\n" + mgr.getLifecycleReport());
  console.log("\n--- Capital Allocation ---");
  const alloc = mgr.getCapitalAllocation();
  alloc.allocations.forEach(a => console.log(`  ${a.name.padEnd(18)} ${a.state.padEnd(15)} ${a.pctOfBase.padStart(5)} → $${a.capital.toLocaleString()}`));
  console.log(`  Total: $${alloc.totalDeployed.toLocaleString()} (base $${alloc.baseAllocation.toLocaleString()}/strategy)\n`);
  const all = mgr.getAllStrategies();
  for (const [st, arr] of Object.entries(all)) { if (arr.length) console.log(`  ${st}: ${arr.map(s => s.name).join(", ")}`); }
  console.log("");
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
