#!/usr/bin/env node
/**
 * Strategy Lifecycle Manager — Inferred Analysis
 *
 * Manages the full lifecycle of quantitative trading strategies from initial
 * research through scaling and eventual retirement. Enforces rigorous
 * promotion gates at each stage to ensure only robust strategies receive
 * live capital allocation.
 *
 * Lifecycle States:
 *   RESEARCH → INCUBATION → PAPER_TRADING → LIVE → SCALING → DEGRADING → RETIRED
 *
 * Usage:
 *   node agents/management/strategy-lifecycle.mjs
 *   import { StrategyLifecycleManager } from './strategy-lifecycle.mjs'
 *
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

/** Ordered promotion path (excludes DEGRADING/RETIRED which are lateral moves) */
const PROMOTION_PATH = [
  STATES.RESEARCH,
  STATES.INCUBATION,
  STATES.PAPER_TRADING,
  STATES.LIVE,
  STATES.SCALING,
];

/** Capital allocation multipliers by state */
const CAPITAL_MULTIPLIERS = {
  [STATES.RESEARCH]: 0,
  [STATES.INCUBATION]: 0,
  [STATES.PAPER_TRADING]: 0,
  [STATES.LIVE]: 1.0,
  [STATES.SCALING]: 2.0,
  [STATES.DEGRADING]: 0.5,
  [STATES.RETIRED]: 0,
};

// ─── Statistical Helpers ────────────────────────────────

/**
 * Compute daily returns from an array of price objects.
 * @param {{ close: number }[]} prices - Array of OHLCV bars
 * @returns {number[]} Daily log returns
 */
function computeReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  return returns;
}

/**
 * Calculate annualized Sharpe ratio from daily returns.
 * @param {number[]} returns - Daily returns
 * @param {number} riskFreeDaily - Daily risk-free rate (default ~4% annual)
 * @returns {number} Annualized Sharpe ratio
 */
function sharpeRatio(returns, riskFreeDaily = 0.04 / 252) {
  if (returns.length < 2) return 0;
  const excess = returns.map((r) => r - riskFreeDaily);
  const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const variance =
    excess.reduce((a, r) => a + (r - mean) ** 2, 0) / (excess.length - 1);
  const std = Math.sqrt(variance);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
}

/**
 * Calculate maximum drawdown from daily returns.
 * @param {number[]} returns - Daily returns
 * @returns {number} Max drawdown as a positive fraction (e.g. 0.15 = 15%)
 */
function maxDrawdown(returns) {
  let peak = 1;
  let equity = 1;
  let maxDD = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/**
 * Calculate rolling Sharpe over a trailing window.
 * @param {number[]} returns - Daily returns
 * @param {number} window - Lookback window in days
 * @returns {number} Sharpe of the trailing window
 */
function rollingSharpe(returns, window = 63) {
  if (returns.length < window) return sharpeRatio(returns);
  return sharpeRatio(returns.slice(-window));
}

/**
 * Estimate alpha: excess return over benchmark.
 * @param {number[]} stratReturns - Strategy daily returns
 * @param {number[]} benchReturns - Benchmark daily returns
 * @returns {number} Annualized alpha
 */
function estimateAlpha(stratReturns, benchReturns) {
  const n = Math.min(stratReturns.length, benchReturns.length);
  if (n < 20) return 0;
  const sRet = stratReturns.slice(-n);
  const bRet = benchReturns.slice(-n);
  const sMean = sRet.reduce((a, b) => a + b, 0) / n;
  const bMean = bRet.reduce((a, b) => a + b, 0) / n;
  return (sMean - bMean) * 252;
}

// ─── Strategy Lifecycle Manager ─────────────────────────

/**
 * Manages trading strategy lifecycles with promotion gates and capital allocation.
 */
export class StrategyLifecycleManager {
  /**
   * @param {number} baseAllocation - Base capital allocation per strategy in dollars
   */
  constructor(baseAllocation = 100_000) {
    /** @type {Map<string, object>} */
    this.strategies = new Map();
    this.baseAllocation = baseAllocation;
    this.benchmarkReturns = null;
  }

  /**
   * Load benchmark returns for alpha calculations.
   * @param {number[]} returns - Benchmark daily returns
   */
  setBenchmark(returns) {
    this.benchmarkReturns = returns;
  }

  /**
   * Register a new strategy in RESEARCH state.
   * @param {string} name - Unique strategy identifier
   * @param {object} config - Strategy configuration
   * @param {string} [config.asset] - Primary asset traded
   * @param {string} [config.type] - Strategy type (momentum, mean-reversion, etc.)
   * @param {string} [config.author] - Strategy author
   * @returns {object} The created strategy record
   */
  registerStrategy(name, config = {}) {
    if (this.strategies.has(name)) {
      throw new Error(`Strategy "${name}" already registered`);
    }
    const strategy = {
      name,
      state: STATES.RESEARCH,
      config,
      registeredAt: new Date().toISOString(),
      stateHistory: [{ state: STATES.RESEARCH, at: new Date().toISOString() }],
      metrics: {
        backtestSharpe: null,
        backtestDays: 0,
        walkForwardSharpe: null,
        walkForwardMaxDD: null,
        paperSharpe: null,
        paperDays: 0,
        liveSharpe: null,
        liveDays: 0,
        liveAlpha: null,
        rollingSharpe63: null,
      },
      retireReason: null,
      degradingSince: null,
    };
    this.strategies.set(name, strategy);
    return strategy;
  }

  /**
   * Retrieve a strategy by name.
   * @param {string} name
   * @returns {object}
   */
  _getStrategy(name) {
    const s = this.strategies.get(name);
    if (!s) throw new Error(`Strategy "${name}" not found`);
    return s;
  }

  /**
   * Transition a strategy to a new state with history tracking.
   * @param {object} strategy
   * @param {string} newState
   */
  _transition(strategy, newState) {
    strategy.state = newState;
    strategy.stateHistory.push({ state: newState, at: new Date().toISOString() });
  }

  /**
   * Promote a strategy to the next lifecycle stage.
   * Validates promotion gates before allowing transition.
   * @param {string} name - Strategy name
   * @returns {{ success: boolean, from: string, to: string, reason?: string }}
   */
  promote(name) {
    const s = this._getStrategy(name);
    const idx = PROMOTION_PATH.indexOf(s.state);

    if (s.state === STATES.RETIRED) {
      return { success: false, from: s.state, to: s.state, reason: "Cannot promote a retired strategy" };
    }
    if (s.state === STATES.DEGRADING) {
      return { success: false, from: s.state, to: s.state, reason: "Degrading strategies must recover or be retired" };
    }
    if (idx === -1 || idx >= PROMOTION_PATH.length - 1) {
      return { success: false, from: s.state, to: s.state, reason: "Already at maximum promotion level" };
    }

    const nextState = PROMOTION_PATH[idx + 1];
    const gate = this._checkGate(s, nextState);
    if (!gate.pass) {
      return { success: false, from: s.state, to: nextState, reason: gate.reason };
    }

    this._transition(s, nextState);
    return { success: true, from: PROMOTION_PATH[idx], to: nextState };
  }

  /**
   * Check promotion gate requirements for a target state.
   * @param {object} strategy
   * @param {string} targetState
   * @returns {{ pass: boolean, reason?: string }}
   */
  _checkGate(strategy, targetState) {
    const m = strategy.metrics;

    switch (targetState) {
      case STATES.INCUBATION:
        if (m.backtestSharpe === null || m.backtestSharpe <= 0.5) {
          return { pass: false, reason: `Backtest Sharpe ${(m.backtestSharpe ?? 0).toFixed(2)} <= 0.5 required` };
        }
        if (m.backtestDays < 252) {
          return { pass: false, reason: `Backtest days ${m.backtestDays} < 252 required` };
        }
        return { pass: true };

      case STATES.PAPER_TRADING:
        if (m.walkForwardSharpe === null || m.walkForwardSharpe <= 0.3) {
          return { pass: false, reason: `Walk-forward Sharpe ${(m.walkForwardSharpe ?? 0).toFixed(2)} <= 0.3 required` };
        }
        if (m.walkForwardMaxDD !== null && m.walkForwardMaxDD > 0.20) {
          return { pass: false, reason: `Walk-forward MaxDD ${(m.walkForwardMaxDD * 100).toFixed(1)}% > 20% limit` };
        }
        return { pass: true };

      case STATES.LIVE:
        if (m.paperDays < 63) {
          return { pass: false, reason: `Paper trading days ${m.paperDays} < 63 required` };
        }
        if (m.paperSharpe === null || m.paperSharpe <= 0.2) {
          return { pass: false, reason: `Paper Sharpe ${(m.paperSharpe ?? 0).toFixed(2)} <= 0.2 required` };
        }
        return { pass: true };

      case STATES.SCALING:
        if (m.liveDays < 126) {
          return { pass: false, reason: `Live days ${m.liveDays} < 126 required` };
        }
        if (m.liveSharpe === null || m.liveSharpe <= 0.3) {
          return { pass: false, reason: `Live Sharpe ${(m.liveSharpe ?? 0).toFixed(2)} <= 0.3 required` };
        }
        if (m.liveAlpha === null || m.liveAlpha <= 0) {
          return { pass: false, reason: `No consistent alpha detected (alpha=${(m.liveAlpha ?? 0).toFixed(4)})` };
        }
        return { pass: true };

      default:
        return { pass: false, reason: `Unknown target state: ${targetState}` };
    }
  }

  /**
   * Demote a strategy back one stage.
   * @param {string} name - Strategy name
   * @returns {{ success: boolean, from: string, to: string, reason?: string }}
   */
  demote(name) {
    const s = this._getStrategy(name);

    if (s.state === STATES.RETIRED) {
      return { success: false, from: s.state, to: s.state, reason: "Cannot demote a retired strategy" };
    }
    if (s.state === STATES.DEGRADING) {
      this._transition(s, STATES.RETIRED);
      s.retireReason = "Demoted from DEGRADING state";
      return { success: true, from: STATES.DEGRADING, to: STATES.RETIRED };
    }

    const idx = PROMOTION_PATH.indexOf(s.state);
    if (idx <= 0) {
      return { success: false, from: s.state, to: s.state, reason: "Already at lowest stage" };
    }

    const prevState = PROMOTION_PATH[idx - 1];
    this._transition(s, prevState);
    return { success: true, from: PROMOTION_PATH[idx], to: prevState };
  }

  /**
   * Force retire a strategy with a given reason.
   * @param {string} name - Strategy name
   * @param {string} reason - Retirement reason
   * @returns {{ success: boolean, from: string }}
   */
  retire(name, reason = "Manual retirement") {
    const s = this._getStrategy(name);
    if (s.state === STATES.RETIRED) {
      return { success: false, from: s.state };
    }
    const from = s.state;
    this._transition(s, STATES.RETIRED);
    s.retireReason = reason;
    return { success: true, from };
  }

  /**
   * Get current status and metrics for a strategy.
   * @param {string} name - Strategy name
   * @returns {object} Status report
   */
  getStatus(name) {
    const s = this._getStrategy(name);
    return {
      name: s.name,
      state: s.state,
      config: s.config,
      registeredAt: s.registeredAt,
      metrics: { ...s.metrics },
      capitalAllocation: CAPITAL_MULTIPLIERS[s.state] * this.baseAllocation,
      retireReason: s.retireReason,
      transitions: s.stateHistory.length,
    };
  }

  /**
   * Get summary of all strategies grouped by state.
   * @returns {object} Map of state → strategy names
   */
  getAllStrategies() {
    const grouped = {};
    for (const state of Object.values(STATES)) {
      grouped[state] = [];
    }
    for (const [name, s] of this.strategies) {
      grouped[s.state].push({
        name,
        metrics: { ...s.metrics },
        allocation: CAPITAL_MULTIPLIERS[s.state] * this.baseAllocation,
      });
    }
    return grouped;
  }

  /**
   * Evaluate a strategy given its return series. Updates metrics and
   * checks for auto-promotion or auto-demotion triggers.
   * @param {string} name - Strategy name
   * @param {number[]} returns - Daily return series
   * @returns {{ action: string, details: string }}
   */
  evaluateStrategy(name, returns) {
    const s = this._getStrategy(name);
    const m = s.metrics;

    const sr = sharpeRatio(returns);
    const mdd = maxDrawdown(returns);
    const rolling63 = rollingSharpe(returns, 63);
    const alpha = this.benchmarkReturns
      ? estimateAlpha(returns, this.benchmarkReturns)
      : null;

    // Update metrics based on current state
    switch (s.state) {
      case STATES.RESEARCH:
        m.backtestSharpe = sr;
        m.backtestDays = returns.length;
        break;
      case STATES.INCUBATION:
        m.walkForwardSharpe = sr;
        m.walkForwardMaxDD = mdd;
        break;
      case STATES.PAPER_TRADING:
        m.paperSharpe = sr;
        m.paperDays = returns.length;
        break;
      case STATES.LIVE:
      case STATES.SCALING:
        m.liveSharpe = sr;
        m.liveDays = returns.length;
        m.liveAlpha = alpha;
        m.rollingSharpe63 = rolling63;
        break;
      case STATES.DEGRADING:
        m.liveSharpe = sr;
        m.rollingSharpe63 = rolling63;
        break;
    }

    // Auto-demotion check: rolling 63-day Sharpe < -0.5 → DEGRADING
    if (
      (s.state === STATES.LIVE || s.state === STATES.SCALING) &&
      rolling63 < -0.5
    ) {
      const from = s.state;
      this._transition(s, STATES.DEGRADING);
      s.degradingSince = new Date().toISOString();
      return {
        action: "AUTO_DEMOTE",
        details: `${from} → DEGRADING (rolling 63d Sharpe ${rolling63.toFixed(2)} < -0.5)`,
      };
    }

    // DEGRADING auto-retire: simulate 63-day no-recovery check
    if (s.state === STATES.DEGRADING && rolling63 < -0.5) {
      this._transition(s, STATES.RETIRED);
      s.retireReason = `No recovery: rolling Sharpe ${rolling63.toFixed(2)} after degrading period`;
      return {
        action: "AUTO_RETIRE",
        details: `DEGRADING → RETIRED (no recovery, rolling Sharpe ${rolling63.toFixed(2)})`,
      };
    }

    // Recovery from DEGRADING
    if (s.state === STATES.DEGRADING && rolling63 >= 0) {
      this._transition(s, STATES.LIVE);
      s.degradingSince = null;
      return {
        action: "RECOVERY",
        details: `DEGRADING → LIVE (rolling Sharpe recovered to ${rolling63.toFixed(2)})`,
      };
    }

    return { action: "HOLD", details: `No state change warranted (Sharpe=${sr.toFixed(2)}, DD=${(mdd * 100).toFixed(1)}%)` };
  }

  /**
   * Generate formatted ASCII lifecycle report.
   * @returns {string} Multi-line report
   */
  getLifecycleReport() {
    const lines = [];
    const divider = "═".repeat(82);
    lines.push(divider);
    lines.push("  STRATEGY LIFECYCLE REPORT");
    lines.push(divider);
    lines.push("");
    lines.push(
      `  ${"Strategy".padEnd(22)} ${"State".padEnd(15)} ${"Sharpe".padEnd(10)} ${"MaxDD".padEnd(10)} ${"Days".padEnd(8)} ${"Capital".padEnd(12)}`
    );
    lines.push("  " + "─".repeat(78));

    for (const [name, s] of this.strategies) {
      const m = s.metrics;
      const activeSharpe =
        m.liveSharpe ?? m.paperSharpe ?? m.walkForwardSharpe ?? m.backtestSharpe;
      const activeDD = m.walkForwardMaxDD;
      const activeDays = m.liveDays || m.paperDays || m.backtestDays || 0;
      const capital = CAPITAL_MULTIPLIERS[s.state] * this.baseAllocation;

      const stateIcon = {
        [STATES.RESEARCH]: "[R]",
        [STATES.INCUBATION]: "[I]",
        [STATES.PAPER_TRADING]: "[P]",
        [STATES.LIVE]: "[L]",
        [STATES.SCALING]: "[S]",
        [STATES.DEGRADING]: "[!]",
        [STATES.RETIRED]: "[X]",
      };

      lines.push(
        `  ${name.padEnd(22)} ${(stateIcon[s.state] + " " + s.state).padEnd(15)} ${(activeSharpe !== null ? activeSharpe.toFixed(2) : "  --").padEnd(10)} ${(activeDD !== null ? (activeDD * 100).toFixed(1) + "%" : "  --").padEnd(10)} ${String(activeDays).padEnd(8)} $${capital.toLocaleString().padEnd(11)}`
      );
    }

    lines.push("");
    lines.push("  " + "─".repeat(78));

    // Summary counts
    const counts = {};
    for (const state of Object.values(STATES)) counts[state] = 0;
    for (const [, s] of this.strategies) counts[s.state]++;

    lines.push(
      `  Summary: ${counts.RESEARCH} research | ${counts.INCUBATION} incubation | ${counts.PAPER_TRADING} paper | ${counts.LIVE} live | ${counts.SCALING} scaling | ${counts.DEGRADING} degrading | ${counts.RETIRED} retired`
    );

    const totalCapital = [...this.strategies.values()].reduce(
      (sum, s) => sum + CAPITAL_MULTIPLIERS[s.state] * this.baseAllocation,
      0
    );
    lines.push(`  Total Capital Deployed: $${totalCapital.toLocaleString()}`);
    lines.push(divider);

    return lines.join("\n");
  }

  /**
   * Calculate suggested capital allocation per strategy based on lifecycle stage.
   * @returns {{ allocations: object[], totalDeployed: number, unallocated: number }}
   */
  getCapitalAllocation() {
    const allocations = [];
    let totalDeployed = 0;

    for (const [name, s] of this.strategies) {
      const multiplier = CAPITAL_MULTIPLIERS[s.state] ?? 0;
      const capital = multiplier * this.baseAllocation;
      totalDeployed += capital;
      allocations.push({
        name,
        state: s.state,
        multiplier,
        capital,
        pctOfBase: (multiplier * 100).toFixed(0) + "%",
      });
    }

    return {
      allocations,
      totalDeployed,
      baseAllocation: this.baseAllocation,
    };
  }
}

// ─── CLI Demo ───────────────────────────────────────────

/**
 * Generate synthetic strategy returns with controlled alpha.
 * Adds daily drift to market returns to simulate strategy edge.
 * @param {number[]} marketReturns - Base market returns
 * @param {number} dailyAlpha - Daily alpha to add
 * @param {number} vol - Idiosyncratic volatility
 * @param {number} length - Number of days
 * @returns {number[]}
 */
function syntheticStrategyReturns(marketReturns, dailyAlpha, vol, length, beta = 0.15) {
  const returns = [];
  let seed = Math.abs(dailyAlpha * 1e7 + vol * 1e5) | 0 || 7;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  // Box-Muller for zero-mean Gaussian noise
  const randn = () => {
    const u1 = rng() * 0.9998 + 0.0001;
    const u2 = rng() * 0.9998 + 0.0001;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  for (let i = 0; i < length; i++) {
    // Low market beta + strategy-specific alpha + zero-mean noise
    const mkt = i < marketReturns.length ? marketReturns[i] * beta : 0;
    returns.push(mkt + dailyAlpha + vol * randn());
  }
  return returns;
}

/**
 * Generate poor returns that will trigger degradation.
 * @param {number} length - Number of days
 * @returns {number[]}
 */
function degradingReturns(length) {
  const returns = [];
  let seed = 42;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < length; i++) {
    returns.push(-0.003 + 0.01 * rng());
  }
  return returns;
}

/**
 * Simulate strategies progressing through the full lifecycle.
 */
async function main() {
  console.log("\n=== Strategy Lifecycle Manager Demo ===\n");

  const manager = new StrategyLifecycleManager(250_000);

  // Generate benchmark returns
  const spyPrices = generateRealisticPrices("SPY", "2019-01-01", "2025-06-01");
  const benchReturns = computeReturns(spyPrices);
  manager.setBenchmark(benchReturns);

  // Register strategies with varying edge profiles
  // alpha = daily excess return, vol = idiosyncratic noise
  const strategyConfigs = [
    { name: "MomentumAlpha", config: { asset: "SPY", type: "momentum", author: "quant-team-1" }, alpha: 0.0008, vol: 0.006 },
    { name: "PairsMeanRev", config: { asset: "AAPL/MSFT", type: "mean-reversion", author: "quant-team-2" }, alpha: 0.0006, vol: 0.005 },
    { name: "VolSurface", config: { asset: "QQQ", type: "volatility", author: "quant-team-1" }, alpha: 0.0003, vol: 0.009 },
    { name: "MacroCarry", config: { asset: "TLT/GLD", type: "carry", author: "quant-team-3" }, alpha: 0.0007, vol: 0.005 },
    { name: "MicroHFT", config: { asset: "XLF", type: "market-making", author: "quant-team-2" }, alpha: 0.0010, vol: 0.005 },
  ];

  for (const { name, config } of strategyConfigs) {
    manager.registerStrategy(name, config);
    console.log(`  Registered: ${name} (${config.type})`);
  }

  // ── Phase 1: Backtest (RESEARCH state) ──────────────────

  console.log("\n--- Phase 1: Backtest Evaluation ---\n");

  const stratReturns = {};
  for (const sc of strategyConfigs) {
    const returns = syntheticStrategyReturns(benchReturns, sc.alpha, sc.vol, 1260);
    stratReturns[sc.name] = returns;
    const result = manager.evaluateStrategy(sc.name, returns);
    const status = manager.getStatus(sc.name);
    console.log(`  ${sc.name}: Sharpe=${status.metrics.backtestSharpe?.toFixed(2)}, Days=${status.metrics.backtestDays} → ${result.action}`);
  }

  // ── Phase 2: Promote RESEARCH → INCUBATION ─────────────

  console.log("\n--- Phase 2: Promotion (RESEARCH → INCUBATION) ---\n");

  for (const sc of strategyConfigs) {
    const result = manager.promote(sc.name);
    console.log(`  ${sc.name}: ${result.success ? "PROMOTED" : "BLOCKED"} (${result.from} → ${result.to})${result.reason ? " - " + result.reason : ""}`);
  }

  // ── Phase 3: Walk-Forward (INCUBATION state) ───────────

  console.log("\n--- Phase 3: Walk-Forward Evaluation ---\n");

  for (const sc of strategyConfigs) {
    const s = manager.getStatus(sc.name);
    if (s.state !== STATES.INCUBATION) continue;
    const wfReturns = syntheticStrategyReturns(benchReturns.slice(-504), sc.alpha * 0.7, sc.vol, 504);
    const result = manager.evaluateStrategy(sc.name, wfReturns);
    const updated = manager.getStatus(sc.name);
    console.log(`  ${sc.name}: WF-Sharpe=${updated.metrics.walkForwardSharpe?.toFixed(2)}, MaxDD=${((updated.metrics.walkForwardMaxDD ?? 0) * 100).toFixed(1)}% → ${result.action}`);
  }

  // ── Phase 4: Promote INCUBATION → PAPER_TRADING ────────

  console.log("\n--- Phase 4: Promotion (INCUBATION → PAPER_TRADING) ---\n");

  for (const sc of strategyConfigs) {
    const s = manager.getStatus(sc.name);
    if (s.state !== STATES.INCUBATION) continue;
    const result = manager.promote(sc.name);
    console.log(`  ${sc.name}: ${result.success ? "PROMOTED" : "BLOCKED"} → ${result.to}${result.reason ? " - " + result.reason : ""}`);
  }

  // ── Phase 5: Paper Trading Evaluation ──────────────────

  console.log("\n--- Phase 5: Paper Trading Evaluation ---\n");

  for (const sc of strategyConfigs) {
    const s = manager.getStatus(sc.name);
    if (s.state !== STATES.PAPER_TRADING) continue;
    const paperReturns = syntheticStrategyReturns(benchReturns.slice(-126), sc.alpha * 0.5, sc.vol, 126);
    const result = manager.evaluateStrategy(sc.name, paperReturns);
    const updated = manager.getStatus(sc.name);
    console.log(`  ${sc.name}: Paper-Sharpe=${updated.metrics.paperSharpe?.toFixed(2)}, Days=${updated.metrics.paperDays} → ${result.action}`);
  }

  // ── Phase 6: Promote PAPER_TRADING → LIVE ─────────────

  console.log("\n--- Phase 6: Promotion (PAPER_TRADING → LIVE) ---\n");

  for (const sc of strategyConfigs) {
    const s = manager.getStatus(sc.name);
    if (s.state !== STATES.PAPER_TRADING) continue;
    const result = manager.promote(sc.name);
    console.log(`  ${sc.name}: ${result.success ? "PROMOTED" : "BLOCKED"} → ${result.to}${result.reason ? " - " + result.reason : ""}`);
  }

  // ── Phase 7: Live Evaluation & Scaling ─────────────────

  console.log("\n--- Phase 7: Live Evaluation & Scaling ---\n");

  for (const sc of strategyConfigs) {
    const s = manager.getStatus(sc.name);
    if (s.state !== STATES.LIVE) continue;
    const liveReturns = syntheticStrategyReturns(benchReturns.slice(-252), sc.alpha, sc.vol * 0.5, 252, 0.8);
    const result = manager.evaluateStrategy(sc.name, liveReturns);
    const updated = manager.getStatus(sc.name);
    console.log(`  ${sc.name}: Live-Sharpe=${updated.metrics.liveSharpe?.toFixed(2)}, Days=${updated.metrics.liveDays}, Alpha=${(updated.metrics.liveAlpha ?? 0).toFixed(4)} → ${result.action} (${result.details})`);
  }

  // Attempt scaling promotion for strategies that qualify
  for (const sc of strategyConfigs) {
    const s = manager.getStatus(sc.name);
    if (s.state !== STATES.LIVE) continue;
    const result = manager.promote(sc.name);
    console.log(`  ${sc.name}: ${result.success ? "PROMOTED → SCALING" : "SCALING BLOCKED"}${result.reason ? " - " + result.reason : ""}`);
  }

  // ── Phase 8: Degradation & Auto-Retire ─────────────────

  console.log("\n--- Phase 8: Degradation Scenario ---\n");

  // Simulate MacroCarry hitting a bad patch
  const macroStatus = manager.getStatus("MacroCarry");
  if (macroStatus.state === STATES.LIVE || macroStatus.state === STATES.SCALING) {
    const badReturns = degradingReturns(126);
    const result = manager.evaluateStrategy("MacroCarry", badReturns);
    console.log(`  MacroCarry: ${result.action} (${result.details})`);

    // If degrading, evaluate again with continued bad returns → auto-retire
    const afterDeg = manager.getStatus("MacroCarry");
    if (afterDeg.state === STATES.DEGRADING) {
      const stillBad = degradingReturns(63);
      const retireResult = manager.evaluateStrategy("MacroCarry", stillBad);
      console.log(`  MacroCarry: ${retireResult.action} (${retireResult.details})`);
    }
  }

  // ── Phase 9: Force Retire ──────────────────────────────

  console.log("\n--- Phase 9: Force Retire ---\n");

  const retireResult = manager.retire("MicroHFT", "Capacity constraints — spread compression in XLF");
  console.log(`  MicroHFT: ${retireResult.success ? "RETIRED" : "ALREADY RETIRED"} from ${retireResult.from}`);

  // ── Final Reports ──────────────────────────────────────

  console.log("\n" + manager.getLifecycleReport());

  console.log("\n--- Capital Allocation ---\n");
  const allocation = manager.getCapitalAllocation();
  for (const a of allocation.allocations) {
    console.log(`  ${a.name.padEnd(20)} ${a.state.padEnd(15)} ${a.pctOfBase.padStart(5)} of base  $${a.capital.toLocaleString()}`);
  }
  console.log(`\n  Total Deployed: $${allocation.totalDeployed.toLocaleString()}`);
  console.log(`  Base Allocation: $${allocation.baseAllocation.toLocaleString()}/strategy`);

  console.log("\n--- All Strategies by State ---\n");
  const all = manager.getAllStrategies();
  for (const [state, strats] of Object.entries(all)) {
    if (strats.length > 0) {
      console.log(`  ${state}: ${strats.map((s) => s.name).join(", ")}`);
    }
  }
  console.log("");
}

// ─── Entry Point ────────────────────────────────────────

main().catch((err) => {
  console.error("Lifecycle manager error:", err.message);
  process.exit(1);
});
