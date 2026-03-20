#!/usr/bin/env node
/**
 * Drawdown-Aware Circuit Breakers
 *
 * Multi-level circuit breaker system for the inferred-analysis daemon
 * and paper trading system. Protects capital by halting strategies,
 * agents, or the entire portfolio when drawdown/loss thresholds are breached.
 *
 * Levels:
 *   1. Strategy-level  — pauses individual strategies on cumulative loss or consecutive losses
 *   2. Agent-level     — pauses agents with poor keep rates or stagnant Sharpe
 *   3. Portfolio-level  — halts ALL trading on portfolio drawdown, daily loss, or agent crashes
 *   4. Recovery logic   — re-enables with reduced sizing, gradual ramp-up
 *
 * State persisted to agents/outputs/breaker-state.json.
 *
 * Usage:
 *   node agents/risk/circuit-breaker.mjs --status
 *   node agents/risk/circuit-breaker.mjs --reset alpha_researcher
 *   node agents/risk/circuit-breaker.mjs --trip portfolio "Manual halt for review"
 *
 * Integration (import):
 *   import { checkBreakers, shouldTrade, tripBreaker, resetBreaker, getBreakerStatus } from './circuit-breaker.mjs'
 *
 * Environment:
 *   BREAKER_STATE_PATH  — override state file location
 *   TELEGRAM_BOT_TOKEN  — for breach alerts
 *   TELEGRAM_CHAT_ID    — for breach alerts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const OUTPUTS_DIR = join(AGENTS_DIR, "outputs");
const RESULTS_TSV = join(AGENTS_DIR, "results.tsv");

const STATE_PATH = process.env.BREAKER_STATE_PATH ||
  join(OUTPUTS_DIR, "breaker-state.json");

// ─── Thresholds ───────────────────────────────────────────

const DEFAULTS = {
  // Strategy-level
  strategyCumulativeReturnFloor: -0.10,   // -10% cumulative return → pause strategy
  strategyConsecutiveLossLimit: 10,        // 10 consecutive losing experiments → pause
  strategyCooldownMs: 24 * 60 * 60 * 1000, // 24 hours

  // Agent-level
  agentKeepRateFloor: 0.05,               // 5% keep rate over last N experiments → pause
  agentKeepRateWindow: 20,                 // look at last 20 experiments
  agentSharpeStagnationLimit: 50,          // 50 experiments with no Sharpe improvement → suggest reset

  // Portfolio-level
  portfolioDrawdownFloor: -0.15,           // -15% combined portfolio drawdown → halt ALL
  portfolioDailyLossFloor: -0.02,          // -2% of capital daily loss → stop for the day
  portfolioCrashThreshold: 3,              // 3+ agent crashes in same cycle → pause daemon

  // Recovery
  recoveryPositionScale: 0.50,            // re-enable at 50% of normal position size
  recoveryRampExperiments: 5,             // 5 profitable experiments to return to full size
};

// ─── State Management ─────────────────────────────────────

/**
 * Default empty breaker state.
 */
function emptyState() {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    breakers: {
      // keyed by "strategy:<name>" | "agent:<name>" | "portfolio"
    },
    crashLog: [],       // { timestamp, agentRole, reason }
    dailyLossTracker: {
      date: null,       // YYYY-MM-DD
      cumulativeLoss: 0,
      capital: 0,
    },
  };
}

/**
 * Load persisted breaker state from disk, or return empty state.
 */
export function loadState() {
  try {
    if (existsSync(STATE_PATH)) {
      const raw = readFileSync(STATE_PATH, "utf-8");
      const state = JSON.parse(raw);
      // Ensure structural integrity
      if (!state.breakers) state.breakers = {};
      if (!state.crashLog) state.crashLog = [];
      if (!state.dailyLossTracker) {
        state.dailyLossTracker = { date: null, cumulativeLoss: 0, capital: 0 };
      }
      return state;
    }
  } catch (err) {
    console.error(`Warning: failed to load breaker state: ${err.message}`);
  }
  return emptyState();
}

/**
 * Persist breaker state to disk.
 */
export function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    console.error(`Warning: failed to save breaker state: ${err.message}`);
  }
}

// ─── Results.tsv Reader ───────────────────────────────────

/**
 * Parse results.tsv into experiment records grouped by agent.
 * Returns { byAgent: { [agentRole]: Experiment[] }, all: Experiment[] }
 */
function loadExperiments() {
  if (!existsSync(RESULTS_TSV)) return { byAgent: {}, all: [] };

  const raw = readFileSync(RESULTS_TSV, "utf-8").trim();
  const lines = raw.split("\n");
  if (lines.length <= 1) return { byAgent: {}, all: [] };

  const all = [];
  const byAgent = {};

  for (const line of lines.slice(1)) {
    const parts = line.split("\t");
    if (parts.length < 6) continue;

    const experiment = {
      timestamp: parts[0],
      agent: parts[1],
      strategy: parts[2],
      sharpe: parseFloat(parts[3]) || 0,
      cumulativeReturn: parseFloat(parts[4]) || 0,
      maxDrawdown: parseFloat(parts[5]) || 0,
      accuracy: parseFloat(parts[6]) || 0,
      composite: parseFloat(parts[7]) || 0,
      winRate: parseFloat(parts[8]) || 0,
      trades: parseInt(parts[9]) || 0,
      status: (parts[10] || parts[parts.length - 1] || "").trim(),
    };

    all.push(experiment);
    if (!byAgent[experiment.agent]) byAgent[experiment.agent] = [];
    byAgent[experiment.agent].push(experiment);
  }

  return { byAgent, all };
}

// ─── Breaker Record Helpers ───────────────────────────────

function breakerKey(level, name) {
  if (level === "portfolio") return "portfolio";
  return `${level}:${name}`;
}

function getBreaker(state, level, name) {
  return state.breakers[breakerKey(level, name)] || null;
}

function setBreaker(state, level, name, data) {
  state.breakers[breakerKey(level, name)] = {
    level,
    name,
    tripped: true,
    trippedAt: new Date().toISOString(),
    reason: data.reason || "Unknown",
    cooldownUntil: data.cooldownUntil || null,
    recoveryStatus: data.recoveryStatus || "paused",
    recoveryProfitableCount: 0,
    positionScale: DEFAULTS.recoveryPositionScale,
    ...data,
  };
}

function clearBreaker(state, level, name) {
  const key = breakerKey(level, name);
  delete state.breakers[key];
}

// ─── Strategy-Level Breaker ───────────────────────────────

/**
 * Check strategy-level breaker conditions.
 * Returns { tripped: boolean, reason?: string }
 */
function checkStrategyBreaker(agentRole, strategyName, experiments) {
  // Filter to this agent + strategy combination
  const relevant = experiments.filter(
    e => e.agent === agentRole && e.strategy === strategyName
  );
  if (relevant.length === 0) return { tripped: false };

  // Check cumulative return
  const cumulativeReturn = relevant.reduce((sum, e) => sum + e.cumulativeReturn, 0);
  if (cumulativeReturn < DEFAULTS.strategyCumulativeReturnFloor) {
    return {
      tripped: true,
      reason: `Strategy ${strategyName} cumulative return ${(cumulativeReturn * 100).toFixed(2)}% below floor ${(DEFAULTS.strategyCumulativeReturnFloor * 100).toFixed(0)}%`,
    };
  }

  // Check consecutive losses (non-keep experiments = losses)
  let consecutiveLosses = 0;
  for (let i = relevant.length - 1; i >= 0; i--) {
    if (relevant[i].status !== "keep" && relevant[i].status !== "baseline") {
      consecutiveLosses++;
    } else {
      break;
    }
  }
  if (consecutiveLosses >= DEFAULTS.strategyConsecutiveLossLimit) {
    return {
      tripped: true,
      reason: `Strategy ${strategyName} has ${consecutiveLosses} consecutive losing experiments (limit: ${DEFAULTS.strategyConsecutiveLossLimit})`,
    };
  }

  return { tripped: false };
}

// ─── Agent-Level Breaker ──────────────────────────────────

/**
 * Check agent-level breaker conditions.
 * Returns { tripped: boolean, reason?: string, suggestReset?: boolean }
 */
function checkAgentBreaker(agentRole, experiments) {
  const agentExps = experiments.filter(e => e.agent === agentRole);
  if (agentExps.length === 0) return { tripped: false };

  // Keep rate over last N experiments
  const window = agentExps.slice(-DEFAULTS.agentKeepRateWindow);
  const nonBaseline = window.filter(e => e.status !== "baseline");
  if (nonBaseline.length >= DEFAULTS.agentKeepRateWindow) {
    const keeps = nonBaseline.filter(e => e.status === "keep").length;
    const keepRate = keeps / nonBaseline.length;
    if (keepRate < DEFAULTS.agentKeepRateFloor) {
      return {
        tripped: true,
        reason: `Agent ${agentRole} keep rate ${(keepRate * 100).toFixed(1)}% over last ${nonBaseline.length} experiments is below ${(DEFAULTS.agentKeepRateFloor * 100).toFixed(0)}% floor`,
      };
    }
  }

  // Sharpe stagnation: best Sharpe hasn't improved in N experiments
  let suggestReset = false;
  if (agentExps.length >= DEFAULTS.agentSharpeStagnationLimit) {
    const older = agentExps.slice(0, -DEFAULTS.agentSharpeStagnationLimit);
    const recent = agentExps.slice(-DEFAULTS.agentSharpeStagnationLimit);
    if (older.length > 0) {
      const olderBest = Math.max(...older.map(e => e.sharpe));
      const recentBest = Math.max(...recent.map(e => e.sharpe));
      if (recentBest <= olderBest) {
        suggestReset = true;
      }
    }
  }

  return { tripped: false, suggestReset };
}

// ─── Portfolio-Level Breaker ──────────────────────────────

/**
 * Check portfolio-level breaker conditions.
 * Returns { tripped: boolean, reason?: string }
 */
function checkPortfolioBreaker(state, latestResult) {
  const today = new Date().toISOString().split("T")[0];

  // Reset daily tracker on new day
  if (state.dailyLossTracker.date !== today) {
    state.dailyLossTracker.date = today;
    state.dailyLossTracker.cumulativeLoss = 0;
  }

  // Accumulate daily loss from latest result
  if (latestResult && latestResult.cumulativeReturn < 0) {
    state.dailyLossTracker.cumulativeLoss += latestResult.cumulativeReturn;
  }

  // Check portfolio drawdown from all experiments today
  const { all } = loadExperiments();
  const todayExps = all.filter(e => e.timestamp && e.timestamp.startsWith(today));
  if (todayExps.length > 0) {
    const totalReturn = todayExps.reduce((sum, e) => sum + e.cumulativeReturn, 0);
    if (totalReturn < DEFAULTS.portfolioDrawdownFloor) {
      return {
        tripped: true,
        reason: `Portfolio drawdown ${(totalReturn * 100).toFixed(2)}% exceeds threshold ${(DEFAULTS.portfolioDrawdownFloor * 100).toFixed(0)}%`,
      };
    }
  }

  // Check daily loss limit
  if (state.dailyLossTracker.cumulativeLoss < DEFAULTS.portfolioDailyLossFloor) {
    return {
      tripped: true,
      reason: `Daily loss ${(state.dailyLossTracker.cumulativeLoss * 100).toFixed(2)}% exceeds limit ${(DEFAULTS.portfolioDailyLossFloor * 100).toFixed(0)}%`,
    };
  }

  // Check agent crash count in recent window (last hour)
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  const recentCrashes = state.crashLog.filter(c => c.timestamp > oneHourAgo);
  const uniqueCrashedAgents = new Set(recentCrashes.map(c => c.agentRole));
  if (uniqueCrashedAgents.size >= DEFAULTS.portfolioCrashThreshold) {
    return {
      tripped: true,
      reason: `${uniqueCrashedAgents.size} agents crashed in the last hour (threshold: ${DEFAULTS.portfolioCrashThreshold}): ${[...uniqueCrashedAgents].join(", ")}`,
    };
  }

  return { tripped: false };
}

// ─── Recovery Logic ───────────────────────────────────────

/**
 * Determine the position scale multiplier for an agent/strategy
 * that is in recovery mode.
 *
 * Returns a number between 0 and 1:
 *   - 0 = still paused (cooldown not expired)
 *   - DEFAULTS.recoveryPositionScale to 1.0 = ramping back up
 */
function getRecoveryScale(breaker) {
  if (!breaker || !breaker.tripped) return 1.0;

  // Still in cooldown?
  if (breaker.cooldownUntil) {
    const cooldownEnd = new Date(breaker.cooldownUntil).getTime();
    if (Date.now() < cooldownEnd) return 0;
  }

  // In recovery: scale based on profitable experiments since re-enable
  if (breaker.recoveryStatus === "recovering") {
    const profitCount = breaker.recoveryProfitableCount || 0;
    if (profitCount >= DEFAULTS.recoveryRampExperiments) {
      return 1.0; // fully recovered
    }
    // Linear ramp from recoveryPositionScale to 1.0
    const base = DEFAULTS.recoveryPositionScale;
    const ramp = (1.0 - base) * (profitCount / DEFAULTS.recoveryRampExperiments);
    return base + ramp;
  }

  return 0; // paused
}

/**
 * Record a profitable experiment during recovery, advancing the ramp-up.
 */
function advanceRecovery(state, level, name) {
  const key = breakerKey(level, name);
  const breaker = state.breakers[key];
  if (!breaker || breaker.recoveryStatus !== "recovering") return;

  breaker.recoveryProfitableCount = (breaker.recoveryProfitableCount || 0) + 1;

  if (breaker.recoveryProfitableCount >= DEFAULTS.recoveryRampExperiments) {
    // Full recovery — clear breaker
    clearBreaker(state, level, name);
  }
}

// ─── Alerting ─────────────────────────────────────────────

async function sendAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  console.error(`[CIRCUIT BREAKER ALERT] ${message}`);

  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `CIRCUIT BREAKER\n\n${message}`,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    // best effort
  }
}

// ─── Public API ───────────────────────────────────────────

/**
 * Main entry point: check all breaker levels for a given agent and result.
 *
 * Called by daemon.mjs after each experiment cycle.
 *
 * @param {string} agentRole - e.g. "alpha_researcher"
 * @param {{ strategy?: string, sharpe?: number, status?: string, cumulativeReturn?: number, ok?: boolean, error?: string }} latestResult
 * @returns {{ allowed: boolean, reasons: string[], positionScale: number, suggestReset: boolean }}
 */
export function checkBreakers(agentRole, latestResult) {
  const state = loadState();
  const { all } = loadExperiments();
  const reasons = [];
  let suggestReset = false;

  // Record crash if applicable
  if (latestResult && !latestResult.ok && latestResult.error) {
    state.crashLog.push({
      timestamp: new Date().toISOString(),
      agentRole,
      reason: (latestResult.error || "").slice(0, 200),
    });
    // Trim crash log to last 100 entries
    if (state.crashLog.length > 100) {
      state.crashLog = state.crashLog.slice(-100);
    }
  }

  // 1. Check portfolio-level breaker (highest priority)
  const existingPortfolio = getBreaker(state, "portfolio", "");
  if (existingPortfolio && existingPortfolio.tripped) {
    const scale = getRecoveryScale(existingPortfolio);
    if (scale === 0) {
      reasons.push(`Portfolio breaker active: ${existingPortfolio.reason}`);
      saveState(state);
      return { allowed: false, reasons, positionScale: 0, suggestReset: false };
    }
    // Cooldown expired, transition to recovery
    if (existingPortfolio.recoveryStatus === "paused") {
      existingPortfolio.recoveryStatus = "recovering";
      existingPortfolio.recoveryProfitableCount = 0;
    }
  }

  const portfolioCheck = checkPortfolioBreaker(state, latestResult);
  if (portfolioCheck.tripped) {
    setBreaker(state, "portfolio", "", {
      reason: portfolioCheck.reason,
      cooldownUntil: new Date(Date.now() + DEFAULTS.strategyCooldownMs).toISOString(),
      recoveryStatus: "paused",
    });
    reasons.push(portfolioCheck.reason);
    sendAlert(portfolioCheck.reason);
    saveState(state);
    return { allowed: false, reasons, positionScale: 0, suggestReset: false };
  }

  // 2. Check agent-level breaker
  const existingAgent = getBreaker(state, "agent", agentRole);
  if (existingAgent && existingAgent.tripped) {
    const scale = getRecoveryScale(existingAgent);
    if (scale === 0) {
      reasons.push(`Agent breaker active for ${agentRole}: ${existingAgent.reason}`);
      saveState(state);
      return { allowed: false, reasons, positionScale: 0, suggestReset: false };
    }
    // In recovery — track profitable results
    if (latestResult && latestResult.status === "keep") {
      advanceRecovery(state, "agent", agentRole);
    }
    saveState(state);
    return { allowed: true, reasons: [`Agent ${agentRole} in recovery`], positionScale: scale, suggestReset: false };
  }

  const agentCheck = checkAgentBreaker(agentRole, all);
  if (agentCheck.tripped) {
    setBreaker(state, "agent", agentRole, {
      reason: agentCheck.reason,
      cooldownUntil: new Date(Date.now() + DEFAULTS.strategyCooldownMs).toISOString(),
      recoveryStatus: "paused",
    });
    reasons.push(agentCheck.reason);
    sendAlert(agentCheck.reason);
    saveState(state);
    return { allowed: false, reasons, positionScale: 0, suggestReset: agentCheck.suggestReset || false };
  }
  if (agentCheck.suggestReset) {
    suggestReset = true;
    reasons.push(`Agent ${agentRole}: Sharpe has not improved in last ${DEFAULTS.agentSharpeStagnationLimit} experiments. Consider strategy reset.`);
  }

  // 3. Check strategy-level breaker (if strategy info available)
  let minScale = 1.0;
  if (latestResult && latestResult.strategy) {
    const stratName = latestResult.strategy;
    const existingStrat = getBreaker(state, "strategy", `${agentRole}/${stratName}`);
    if (existingStrat && existingStrat.tripped) {
      const scale = getRecoveryScale(existingStrat);
      if (scale === 0) {
        reasons.push(`Strategy breaker active for ${agentRole}/${stratName}: ${existingStrat.reason}`);
        saveState(state);
        // Strategy breaker doesn't block the whole agent, just this strategy
        return { allowed: true, reasons, positionScale: 0, suggestReset, skipStrategy: stratName };
      }
      if (latestResult.status === "keep") {
        advanceRecovery(state, "strategy", `${agentRole}/${stratName}`);
      }
      minScale = Math.min(minScale, scale);
    } else {
      const stratCheck = checkStrategyBreaker(agentRole, stratName, all);
      if (stratCheck.tripped) {
        setBreaker(state, "strategy", `${agentRole}/${stratName}`, {
          reason: stratCheck.reason,
          cooldownUntil: new Date(Date.now() + DEFAULTS.strategyCooldownMs).toISOString(),
          recoveryStatus: "paused",
        });
        reasons.push(stratCheck.reason);
        sendAlert(stratCheck.reason);
      }
    }
  }

  // Check portfolio recovery advancement
  if (existingPortfolio && existingPortfolio.recoveryStatus === "recovering") {
    if (latestResult && latestResult.status === "keep") {
      advanceRecovery(state, "portfolio", "");
    }
    minScale = Math.min(minScale, getRecoveryScale(existingPortfolio));
  }

  saveState(state);
  return {
    allowed: reasons.filter(r => r.includes("breaker active")).length === 0,
    reasons,
    positionScale: minScale,
    suggestReset,
  };
}

/**
 * Quick check: should this agent be allowed to trade right now?
 *
 * Called by paper-trader.mjs before executing orders.
 *
 * @param {string} agentRole
 * @returns {{ allowed: boolean, positionScale: number, reason?: string }}
 */
export function shouldTrade(agentRole) {
  const state = loadState();

  // Portfolio breaker blocks everything
  const portfolio = getBreaker(state, "portfolio", "");
  if (portfolio && portfolio.tripped) {
    const scale = getRecoveryScale(portfolio);
    if (scale === 0) {
      return { allowed: false, positionScale: 0, reason: `Portfolio halted: ${portfolio.reason}` };
    }
    // In recovery
    return { allowed: true, positionScale: scale, reason: "Portfolio in recovery mode" };
  }

  // Agent breaker
  const agent = getBreaker(state, "agent", agentRole);
  if (agent && agent.tripped) {
    const scale = getRecoveryScale(agent);
    if (scale === 0) {
      return { allowed: false, positionScale: 0, reason: `Agent ${agentRole} paused: ${agent.reason}` };
    }
    return { allowed: true, positionScale: scale, reason: `Agent ${agentRole} in recovery` };
  }

  return { allowed: true, positionScale: 1.0 };
}

/**
 * Manually trip a breaker. Used for manual halts or external triggers.
 *
 * @param {"strategy"|"agent"|"portfolio"} level
 * @param {string} agentRole - agent or strategy name (ignored for portfolio)
 * @param {string} reason
 */
export function tripBreaker(level, agentRole, reason) {
  const state = loadState();
  const name = level === "portfolio" ? "" : agentRole;

  setBreaker(state, level, name, {
    reason: reason || `Manual trip at ${new Date().toISOString()}`,
    cooldownUntil: new Date(Date.now() + DEFAULTS.strategyCooldownMs).toISOString(),
    recoveryStatus: "paused",
  });

  saveState(state);
  sendAlert(`Manual breaker trip: [${level}] ${agentRole || "all"} — ${reason}`);

  return { ok: true, key: breakerKey(level, name) };
}

/**
 * Reset (clear) a breaker for a given agent/strategy.
 * Can also reset all breakers with agentRole = "all".
 *
 * @param {string} agentRole - agent name, "strategy:agent/strat", or "all"
 * @returns {{ ok: boolean, cleared: string[] }}
 */
export function resetBreaker(agentRole) {
  const state = loadState();
  const cleared = [];

  if (agentRole === "all") {
    // Clear everything
    for (const key of Object.keys(state.breakers)) {
      cleared.push(key);
    }
    state.breakers = {};
    state.crashLog = [];
    state.dailyLossTracker = { date: null, cumulativeLoss: 0, capital: 0 };
  } else if (agentRole === "portfolio") {
    if (state.breakers["portfolio"]) {
      cleared.push("portfolio");
      delete state.breakers["portfolio"];
    }
  } else {
    // Clear agent-level and all strategy-level breakers for this agent
    for (const key of Object.keys(state.breakers)) {
      if (key === `agent:${agentRole}` || key.startsWith(`strategy:${agentRole}/`)) {
        cleared.push(key);
        delete state.breakers[key];
      }
    }
  }

  saveState(state);
  return { ok: true, cleared };
}

/**
 * Get full breaker status for display/monitoring.
 *
 * @returns {{ breakers: object, crashLog: object[], dailyLossTracker: object, lastUpdated: string }}
 */
export function getBreakerStatus() {
  const state = loadState();

  // Enrich each breaker with computed recovery scale
  const enriched = {};
  for (const [key, breaker] of Object.entries(state.breakers)) {
    enriched[key] = {
      ...breaker,
      currentScale: getRecoveryScale(breaker),
      cooldownRemaining: breaker.cooldownUntil
        ? Math.max(0, new Date(breaker.cooldownUntil).getTime() - Date.now())
        : 0,
    };
  }

  return {
    breakers: enriched,
    activeBreakerCount: Object.keys(enriched).length,
    crashLog: state.crashLog.slice(-10),
    dailyLossTracker: state.dailyLossTracker,
    lastUpdated: state.lastUpdated,
  };
}

// ─── CLI ──────────────────────────────────────────────────

function formatMs(ms) {
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function printStatus() {
  const status = getBreakerStatus();

  console.log("\n=== Circuit Breaker Status ===\n");
  console.log(`Last updated: ${status.lastUpdated}`);
  console.log(`Active breakers: ${status.activeBreakerCount}\n`);

  if (status.activeBreakerCount === 0) {
    console.log("  All clear. No breakers tripped.\n");
  } else {
    for (const [key, breaker] of Object.entries(status.breakers)) {
      const scaleStr = breaker.currentScale === 0
        ? "HALTED"
        : `${(breaker.currentScale * 100).toFixed(0)}% position scale`;
      const cooldown = breaker.cooldownRemaining > 0
        ? `(cooldown: ${formatMs(breaker.cooldownRemaining)})`
        : "(cooldown expired)";

      console.log(`  [${breaker.level.toUpperCase()}] ${breaker.name || "ALL"}`);
      console.log(`    Status:   ${breaker.recoveryStatus} — ${scaleStr}`);
      console.log(`    Reason:   ${breaker.reason}`);
      console.log(`    Tripped:  ${breaker.trippedAt} ${cooldown}`);
      if (breaker.recoveryStatus === "recovering") {
        console.log(`    Recovery: ${breaker.recoveryProfitableCount || 0}/${DEFAULTS.recoveryRampExperiments} profitable experiments`);
      }
      console.log();
    }
  }

  // Daily loss tracker
  const dl = status.dailyLossTracker;
  if (dl.date) {
    console.log(`Daily loss tracker (${dl.date}): ${(dl.cumulativeLoss * 100).toFixed(2)}% (limit: ${(DEFAULTS.portfolioDailyLossFloor * 100).toFixed(0)}%)`);
  }

  // Recent crashes
  if (status.crashLog.length > 0) {
    console.log(`\nRecent crashes (last ${status.crashLog.length}):`);
    for (const c of status.crashLog) {
      console.log(`  ${c.timestamp} — ${c.agentRole}: ${c.reason.slice(0, 80)}`);
    }
  }

  console.log();
}

function printHelp() {
  console.log(`
Circuit Breaker — Drawdown-Aware Trading Protection

Usage:
  node agents/risk/circuit-breaker.mjs --status
  node agents/risk/circuit-breaker.mjs --reset <agent|all|portfolio>
  node agents/risk/circuit-breaker.mjs --trip <strategy|agent|portfolio> [name] "reason"
  node agents/risk/circuit-breaker.mjs --help

Options:
  --status          Show all breaker states and recovery progress
  --reset <name>    Clear breaker for agent, or "all" to clear everything
  --trip <level>    Manually trip a breaker (strategy, agent, or portfolio)
  --help            Show this help

Thresholds:
  Strategy cumulative return floor:  ${(DEFAULTS.strategyCumulativeReturnFloor * 100).toFixed(0)}%
  Strategy consecutive loss limit:   ${DEFAULTS.strategyConsecutiveLossLimit}
  Agent keep rate floor:             ${(DEFAULTS.agentKeepRateFloor * 100).toFixed(0)}% over last ${DEFAULTS.agentKeepRateWindow} experiments
  Agent Sharpe stagnation limit:     ${DEFAULTS.agentSharpeStagnationLimit} experiments
  Portfolio drawdown floor:          ${(DEFAULTS.portfolioDrawdownFloor * 100).toFixed(0)}%
  Portfolio daily loss floor:        ${(DEFAULTS.portfolioDailyLossFloor * 100).toFixed(0)}%
  Portfolio crash threshold:         ${DEFAULTS.portfolioCrashThreshold} agents
  Recovery initial position scale:   ${(DEFAULTS.recoveryPositionScale * 100).toFixed(0)}%
  Recovery ramp experiments:         ${DEFAULTS.recoveryRampExperiments}
  Cooldown period:                   ${DEFAULTS.strategyCooldownMs / 3600000}h

Integration:
  import { checkBreakers, shouldTrade, tripBreaker, resetBreaker, getBreakerStatus } from './circuit-breaker.mjs'
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--status")) {
    printStatus();
    return;
  }

  if (args.includes("--reset")) {
    const idx = args.indexOf("--reset");
    const target = args[idx + 1] || "all";
    const result = resetBreaker(target);
    if (result.cleared.length > 0) {
      console.log(`Cleared ${result.cleared.length} breaker(s):`);
      for (const key of result.cleared) {
        console.log(`  - ${key}`);
      }
    } else {
      console.log(`No active breakers found for "${target}".`);
    }
    return;
  }

  if (args.includes("--trip")) {
    const idx = args.indexOf("--trip");
    const level = args[idx + 1] || "portfolio";
    // For portfolio, the next arg (if any) is the reason
    // For strategy/agent, next arg is the name, then reason
    let name = "";
    let reason = "";
    if (level === "portfolio") {
      reason = args.slice(idx + 2).join(" ") || "Manual halt";
    } else {
      name = args[idx + 2] || "";
      reason = args.slice(idx + 3).join(" ") || "Manual trip";
    }

    if (!["strategy", "agent", "portfolio"].includes(level)) {
      console.error(`Invalid level: "${level}". Use strategy, agent, or portfolio.`);
      process.exit(1);
    }

    const result = tripBreaker(level, name, reason);
    console.log(`Breaker tripped: ${result.key}`);
    console.log(`  Level:  ${level}`);
    console.log(`  Name:   ${name || "(all)"}`);
    console.log(`  Reason: ${reason}`);
    console.log(`  Cooldown: ${DEFAULTS.strategyCooldownMs / 3600000}h`);
    return;
  }

  // Default: show status
  printStatus();
}

// Run if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("circuit-breaker.mjs") ||
  process.argv[1].includes("circuit-breaker")
);
if (isMain) {
  main().catch(err => {
    console.error(`Circuit breaker error: ${err.message}`);
    process.exit(1);
  });
}
