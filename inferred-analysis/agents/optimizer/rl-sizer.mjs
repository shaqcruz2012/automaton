#!/usr/bin/env node
/**
 * Reinforcement Learning Position Sizer — Inferred Analysis
 *
 * Q-learning agent that learns optimal position sizing from historical
 * price data. Uses tabular Q-learning with epsilon-greedy exploration,
 * state discretization, and experience replay.
 *
 * State:  [recent returns, current drawdown, vol regime, signal strength]
 * Actions: [0%, 25%, 50%, 75%, 100%] position sizes
 * Reward:  risk-adjusted return (Sharpe ratio over recent window)
 *
 * Usage:
 *   node agents/optimizer/rl-sizer.mjs                        # Train on SPY
 *   node agents/optimizer/rl-sizer.mjs --symbol QQQ           # Train on QQQ
 *   node agents/optimizer/rl-sizer.mjs --episodes 500         # More training
 *   node agents/optimizer/rl-sizer.mjs --evaluate             # Evaluate only
 *
 * Exports: RLSizer, trainAgent(), getOptimalSize(), evaluatePolicy()
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Constants ───────────────────────────────────────────

const ACTIONS = [0.0, 0.25, 0.5, 0.75, 1.0]; // position sizes
const ACTION_LABELS = ["0%", "25%", "50%", "75%", "100%"];

// State discretization bins
const RETURN_BINS    = [-0.03, -0.01, 0.0, 0.01, 0.03];  // 6 buckets
const DRAWDOWN_BINS  = [0.0, 0.02, 0.05, 0.10, 0.20];    // 6 buckets
const VOL_BINS       = [0.005, 0.01, 0.015, 0.025, 0.04]; // 6 buckets
const SIGNAL_BINS    = [-0.5, -0.2, 0.0, 0.2, 0.5];       // 6 buckets

const LOOKBACK_RETURN  = 5;   // days for recent return calc
const LOOKBACK_VOL     = 20;  // days for vol regime
const LOOKBACK_SIGNAL  = 10;  // days for signal (momentum)
const SHARPE_WINDOW    = 20;  // window for reward calculation
const ANNUALIZE_FACTOR = Math.sqrt(252);

// ─── Utility Functions ───────────────────────────────────

function discretize(value, bins) {
  for (let i = 0; i < bins.length; i++) {
    if (value <= bins[i]) return i;
  }
  return bins.length;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function sharpe(returns) {
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const s = stddev(returns);
  if (s === 0) return m > 0 ? 3.0 : -3.0;
  return (m / s) * ANNUALIZE_FACTOR;
}

/** Compute daily log returns from close prices. */
function computeReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  return returns;
}

/** Calculate max drawdown from an equity curve (array of portfolio values). */
function maxDrawdown(equityCurve) {
  let peak = -Infinity;
  let maxDD = 0;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    const dd = (peak - val) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ─── Experience Replay Buffer ────────────────────────────

class ReplayBuffer {
  constructor(capacity = 10_000) {
    this.capacity = capacity;
    this.buffer = [];
    this.pos = 0;
  }

  push(experience) {
    if (this.buffer.length < this.capacity) {
      this.buffer.push(experience);
    } else {
      this.buffer[this.pos] = experience;
    }
    this.pos = (this.pos + 1) % this.capacity;
  }

  sample(batchSize) {
    const batch = [];
    const len = this.buffer.length;
    for (let i = 0; i < batchSize; i++) {
      batch.push(this.buffer[Math.floor(Math.random() * len)]);
    }
    return batch;
  }

  get size() {
    return this.buffer.length;
  }
}

// ─── RL Sizer Class ──────────────────────────────────────

export class RLSizer {
  /**
   * @param {object} opts
   * @param {number} opts.alpha          Learning rate (default 0.1)
   * @param {number} opts.gamma          Discount factor (default 0.95)
   * @param {number} opts.epsilon        Exploration rate start (default 1.0)
   * @param {number} opts.epsilonMin     Min exploration rate (default 0.05)
   * @param {number} opts.epsilonDecay   Decay multiplier per episode (default 0.995)
   * @param {number} opts.replayBatch    Replay batch size (default 32)
   * @param {number} opts.replayCapacity Replay buffer capacity (default 10000)
   */
  constructor(opts = {}) {
    this.alpha = opts.alpha ?? 0.1;
    this.gamma = opts.gamma ?? 0.95;
    this.epsilon = opts.epsilon ?? 1.0;
    this.epsilonMin = opts.epsilonMin ?? 0.05;
    this.epsilonDecay = opts.epsilonDecay ?? 0.995;
    this.replayBatch = opts.replayBatch ?? 32;

    // Q-table: Map from state key -> array of Q-values per action
    this.Q = new Map();

    // Experience replay buffer
    this.replay = new ReplayBuffer(opts.replayCapacity ?? 10_000);

    // Training stats
    this.episodeRewards = [];
    this.episodeCount = 0;
  }

  /** Get or initialize Q-values for a state. */
  _getQ(stateKey) {
    if (!this.Q.has(stateKey)) {
      this.Q.set(stateKey, new Float64Array(ACTIONS.length)); // init to 0
    }
    return this.Q.get(stateKey);
  }

  /**
   * Discretize continuous state into a string key.
   * State: { recentReturn, drawdown, vol, signal }
   */
  discretizeState(state) {
    const rBin = discretize(state.recentReturn, RETURN_BINS);
    const dBin = discretize(state.drawdown, DRAWDOWN_BINS);
    const vBin = discretize(state.vol, VOL_BINS);
    const sBin = discretize(state.signal, SIGNAL_BINS);
    return `${rBin}:${dBin}:${vBin}:${sBin}`;
  }

  /**
   * Select action using epsilon-greedy policy.
   * Returns action index.
   */
  selectAction(stateKey) {
    if (Math.random() < this.epsilon) {
      return Math.floor(Math.random() * ACTIONS.length);
    }
    const qValues = this._getQ(stateKey);
    let bestAction = 0;
    let bestValue = qValues[0];
    for (let i = 1; i < qValues.length; i++) {
      if (qValues[i] > bestValue) {
        bestValue = qValues[i];
        bestAction = i;
      }
    }
    return bestAction;
  }

  /**
   * Update Q-value for a single transition.
   */
  _updateQ(stateKey, action, reward, nextStateKey) {
    const qCurrent = this._getQ(stateKey);
    const qNext = this._getQ(nextStateKey);

    // Max Q(s', a') for all actions
    let maxNextQ = qNext[0];
    for (let i = 1; i < qNext.length; i++) {
      if (qNext[i] > maxNextQ) maxNextQ = qNext[i];
    }

    // Q-learning update
    qCurrent[action] += this.alpha * (reward + this.gamma * maxNextQ - qCurrent[action]);
  }

  /**
   * Extract state features from price data at a given index.
   * @param {Array} returns   Array of daily log returns
   * @param {Array} equity    Equity curve (portfolio values)
   * @param {number} t        Current time index into returns array
   */
  extractState(returns, equity, t) {
    // Recent return (sum of last LOOKBACK_RETURN returns)
    const retSlice = returns.slice(Math.max(0, t - LOOKBACK_RETURN), t);
    const recentReturn = retSlice.length > 0 ? retSlice.reduce((s, v) => s + v, 0) : 0;

    // Current drawdown from equity curve peak
    let peak = 0;
    for (let i = 0; i <= t && i < equity.length; i++) {
      if (equity[i] > peak) peak = equity[i];
    }
    const drawdown = peak > 0 ? (peak - equity[Math.min(t, equity.length - 1)]) / peak : 0;

    // Volatility regime (std of recent returns)
    const volSlice = returns.slice(Math.max(0, t - LOOKBACK_VOL), t);
    const vol = stddev(volSlice);

    // Signal strength (momentum: mean of recent returns normalized)
    const sigSlice = returns.slice(Math.max(0, t - LOOKBACK_SIGNAL), t);
    const signal = sigSlice.length > 0 ? mean(sigSlice) * Math.sqrt(252) : 0;

    return { recentReturn, drawdown, vol, signal };
  }

  /**
   * Compute reward: risk-adjusted return (Sharpe) of recent window.
   */
  computeReward(portfolioReturns, t) {
    const window = portfolioReturns.slice(Math.max(0, t - SHARPE_WINDOW), t);
    if (window.length < 2) return 0;
    return sharpe(window);
  }

  /**
   * Train on a single episode (one pass through price data).
   * Returns episode total reward.
   */
  trainEpisode(prices) {
    const returns = computeReturns(prices);
    if (returns.length < LOOKBACK_VOL + 10) {
      throw new Error(`Not enough data: need at least ${LOOKBACK_VOL + 10} returns, got ${returns.length}`);
    }

    const equity = [1.0]; // normalized starting equity
    const portfolioReturns = [];
    let totalReward = 0;
    const startIdx = LOOKBACK_VOL; // skip warmup period

    for (let t = startIdx; t < returns.length; t++) {
      // Extract current state
      const state = this.extractState(returns, equity, t);
      const stateKey = this.discretizeState(state);

      // Select action (position size)
      const actionIdx = this.selectAction(stateKey);
      const posSize = ACTIONS[actionIdx];

      // Simulate: portfolio return = position_size * market_return
      const mktReturn = returns[t];
      const portReturn = posSize * mktReturn;
      portfolioReturns.push(portReturn);

      // Update equity
      const prevEquity = equity[equity.length - 1];
      equity.push(prevEquity * (1 + portReturn));

      // Compute reward
      const reward = this.computeReward(portfolioReturns, portfolioReturns.length);

      // Next state
      const nextState = this.extractState(returns, equity, t + 1);
      const nextStateKey = this.discretizeState(nextState);

      // Store experience
      this.replay.push({ stateKey, actionIdx, reward, nextStateKey });

      // Direct Q-update
      this._updateQ(stateKey, actionIdx, reward, nextStateKey);

      // Experience replay
      if (this.replay.size >= this.replayBatch) {
        const batch = this.replay.sample(this.replayBatch);
        for (const exp of batch) {
          this._updateQ(exp.stateKey, exp.actionIdx, exp.reward, exp.nextStateKey);
        }
      }

      totalReward += reward;
    }

    // Decay epsilon
    this.epsilon = Math.max(this.epsilonMin, this.epsilon * this.epsilonDecay);
    this.episodeCount++;
    this.episodeRewards.push(totalReward);

    return totalReward;
  }

  /**
   * Get the learned optimal position size for a given state.
   * Uses greedy policy (no exploration).
   */
  getOptimalAction(state) {
    const stateKey = this.discretizeState(state);
    const qValues = this._getQ(stateKey);
    let bestAction = 0;
    let bestValue = qValues[0];
    for (let i = 1; i < qValues.length; i++) {
      if (qValues[i] > bestValue) {
        bestValue = qValues[i];
        bestAction = i;
      }
    }
    return {
      actionIndex: bestAction,
      positionSize: ACTIONS[bestAction],
      label: ACTION_LABELS[bestAction],
      qValues: Array.from(qValues),
      stateKey,
    };
  }

  /**
   * Get the learned Q-table summary: most common actions per state region.
   */
  getPolicySummary() {
    const summary = [];
    for (const [stateKey, qValues] of this.Q.entries()) {
      let bestAction = 0;
      let bestQ = qValues[0];
      for (let i = 1; i < qValues.length; i++) {
        if (qValues[i] > bestQ) {
          bestQ = qValues[i];
          bestAction = i;
        }
      }
      summary.push({
        state: stateKey,
        bestAction: ACTION_LABELS[bestAction],
        bestQ: +bestQ.toFixed(4),
        qValues: Array.from(qValues).map(v => +v.toFixed(4)),
      });
    }
    return summary.sort((a, b) => b.bestQ - a.bestQ);
  }

  /** Export learned Q-table as a plain object. */
  exportPolicy() {
    const table = {};
    for (const [key, vals] of this.Q.entries()) {
      table[key] = Array.from(vals);
    }
    return {
      qTable: table,
      epsilon: this.epsilon,
      episodeCount: this.episodeCount,
      stateCount: this.Q.size,
      avgReward: this.episodeRewards.length > 0
        ? mean(this.episodeRewards.slice(-50))
        : 0,
    };
  }

  /** Import a previously exported Q-table. */
  importPolicy(policy) {
    this.Q.clear();
    for (const [key, vals] of Object.entries(policy.qTable)) {
      this.Q.set(key, new Float64Array(vals));
    }
    this.epsilon = policy.epsilon ?? this.epsilonMin;
    this.episodeCount = policy.episodeCount ?? 0;
  }
}

// ─── Training Function ──────────────────────────────────

/**
 * Train the RL agent on price data for N episodes.
 * Each episode shuffles the start window slightly for variation.
 *
 * @param {Array} prices     Array of { date, open, high, low, close, volume }
 * @param {object} opts
 * @param {number} opts.episodes   Number of training episodes (default 200)
 * @param {boolean} opts.verbose   Print progress (default false)
 * @param {object} opts.agentOpts  Options passed to RLSizer constructor
 * @returns {{ agent: RLSizer, history: number[] }}
 */
export function trainAgent(prices, opts = {}) {
  const episodes = opts.episodes ?? 200;
  const verbose = opts.verbose ?? false;
  const agent = new RLSizer(opts.agentOpts || {});

  const history = [];

  for (let ep = 0; ep < episodes; ep++) {
    // Add slight variation: randomly trim start by up to 10%
    const maxTrim = Math.floor(prices.length * 0.1);
    const trim = Math.floor(Math.random() * maxTrim);
    const subset = prices.slice(trim);

    const reward = agent.trainEpisode(subset);
    history.push(reward);

    if (verbose && (ep % 50 === 0 || ep === episodes - 1)) {
      const recentAvg = mean(history.slice(-50));
      console.log(
        `  Episode ${String(ep + 1).padStart(4)}/${episodes}  ` +
        `reward=${reward.toFixed(2).padStart(8)}  ` +
        `avg50=${recentAvg.toFixed(2).padStart(8)}  ` +
        `eps=${agent.epsilon.toFixed(3)}  ` +
        `states=${agent.Q.size}`
      );
    }
  }

  return { agent, history };
}

// ─── Get Optimal Size (convenience) ─────────────────────

/**
 * Given a trained agent and current market state, return the optimal position size.
 *
 * @param {RLSizer} agent        Trained RLSizer instance
 * @param {object}  state        { recentReturn, drawdown, vol, signal }
 * @returns {{ positionSize: number, label: string, qValues: number[] }}
 */
export function getOptimalSize(agent, state) {
  return agent.getOptimalAction(state);
}

// ─── Policy Evaluation ──────────────────────────────────

/**
 * Backtest a sizing policy on price data and return performance metrics.
 */
function backtestPolicy(prices, sizingFn) {
  const returns = computeReturns(prices);
  const equity = [1.0];
  const portfolioReturns = [];

  for (let t = LOOKBACK_VOL; t < returns.length; t++) {
    const state = {
      recentReturn: mean(returns.slice(Math.max(0, t - LOOKBACK_RETURN), t)) * LOOKBACK_RETURN,
      drawdown: (() => {
        let peak = 0;
        for (let i = 0; i <= t && i < equity.length; i++) {
          if (equity[i] > peak) peak = equity[i];
        }
        return peak > 0 ? (peak - equity[equity.length - 1]) / peak : 0;
      })(),
      vol: stddev(returns.slice(Math.max(0, t - LOOKBACK_VOL), t)),
      signal: mean(returns.slice(Math.max(0, t - LOOKBACK_SIGNAL), t)) * Math.sqrt(252),
    };

    const posSize = sizingFn(state, t, returns);
    const portReturn = posSize * returns[t];
    portfolioReturns.push(portReturn);
    equity.push(equity[equity.length - 1] * (1 + portReturn));
  }

  const totalReturn = equity[equity.length - 1] / equity[0] - 1;
  const annualizedReturn = (1 + totalReturn) ** (252 / portfolioReturns.length) - 1;
  const portSharpe = sharpe(portfolioReturns);
  const mdd = maxDrawdown(equity);
  const calmar = mdd > 0 ? annualizedReturn / mdd : 0;

  return {
    totalReturn: +(totalReturn * 100).toFixed(2),
    annualizedReturn: +(annualizedReturn * 100).toFixed(2),
    sharpe: +portSharpe.toFixed(3),
    maxDrawdown: +(mdd * 100).toFixed(2),
    calmar: +calmar.toFixed(3),
    trades: portfolioReturns.length,
    finalEquity: +equity[equity.length - 1].toFixed(4),
  };
}

/**
 * Kelly criterion position size estimate.
 * Uses recent win rate and avg win/loss ratio.
 */
function kellySizing(returns, t, lookback = 60) {
  const recent = returns.slice(Math.max(0, t - lookback), t);
  if (recent.length < 10) return 0.5;

  const wins = recent.filter(r => r > 0);
  const losses = recent.filter(r => r <= 0);

  const winRate = wins.length / recent.length;
  const avgWin = wins.length > 0 ? mean(wins) : 0;
  const avgLoss = losses.length > 0 ? Math.abs(mean(losses)) : 1;

  if (avgLoss === 0) return 1.0;

  const kelly = winRate - (1 - winRate) / (avgWin / avgLoss);
  // Half-Kelly for safety, clamped to our action space
  const halfKelly = Math.max(0, Math.min(1, kelly * 0.5));

  // Snap to nearest action
  let bestAction = 0;
  let bestDist = Math.abs(ACTIONS[0] - halfKelly);
  for (let i = 1; i < ACTIONS.length; i++) {
    const dist = Math.abs(ACTIONS[i] - halfKelly);
    if (dist < bestDist) {
      bestDist = dist;
      bestAction = i;
    }
  }
  return ACTIONS[bestAction];
}

/**
 * Evaluate the RL policy against fixed sizing and Kelly criterion.
 *
 * @param {RLSizer} agent   Trained agent
 * @param {Array}   prices  Price data (ideally out-of-sample)
 * @returns {object} Comparison results
 */
export function evaluatePolicy(agent, prices) {
  // RL policy (greedy, no exploration)
  const rlResults = backtestPolicy(prices, (state) => {
    const result = agent.getOptimalAction(state);
    return result.positionSize;
  });

  // Fixed sizing benchmarks
  const fixed25 = backtestPolicy(prices, () => 0.25);
  const fixed50 = backtestPolicy(prices, () => 0.50);
  const fixed75 = backtestPolicy(prices, () => 0.75);
  const fixed100 = backtestPolicy(prices, () => 1.00);

  // Kelly criterion
  const kellyResults = backtestPolicy(prices, (_state, t, returns) => {
    return kellySizing(returns, t);
  });

  return {
    rl: rlResults,
    fixed25,
    fixed50,
    fixed75,
    fixed100,
    kelly: kellyResults,
  };
}

// ─── CLI ─────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    symbol: "SPY",
    episodes: 200,
    evaluate: false,
    startDate: "2020-01-01",
    endDate: "2025-03-01",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--symbol":   opts.symbol = args[++i]; break;
      case "--episodes": opts.episodes = parseInt(args[++i]); break;
      case "--evaluate": opts.evaluate = true; break;
      case "--start":    opts.startDate = args[++i]; break;
      case "--end":      opts.endDate = args[++i]; break;
      case "--help":
        console.log(`RL Position Sizer

Options:
  --symbol <SYM>     Symbol to train on (default: SPY)
  --episodes <N>     Training episodes (default: 200)
  --evaluate         Run evaluation comparison
  --start <date>     Start date (default: 2020-01-01)
  --end <date>       End date (default: 2025-03-01)
  --help             Show this help`);
        process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  console.log(`\n${"=".repeat(65)}`);
  console.log(`  RL Position Sizer — Q-Learning Agent`);
  console.log(`${"=".repeat(65)}\n`);

  // Generate price data
  console.log(`Generating price data for ${opts.symbol}...`);
  const allPrices = generateRealisticPrices(opts.symbol, opts.startDate, opts.endDate);

  // Split: 70% train, 30% test
  const splitIdx = Math.floor(allPrices.length * 0.7);
  const trainPrices = allPrices.slice(0, splitIdx);
  const testPrices = allPrices.slice(splitIdx);

  console.log(`  Train: ${trainPrices.length} days (${trainPrices[0].date} -> ${trainPrices[trainPrices.length - 1].date})`);
  console.log(`  Test:  ${testPrices.length} days (${testPrices[0].date} -> ${testPrices[testPrices.length - 1].date})\n`);

  // Train
  console.log(`Training for ${opts.episodes} episodes...\n`);
  const { agent, history } = trainAgent(trainPrices, {
    episodes: opts.episodes,
    verbose: true,
  });

  const policy = agent.exportPolicy();
  console.log(`\nTraining complete.`);
  console.log(`  States explored: ${policy.stateCount}`);
  console.log(`  Final epsilon:   ${policy.epsilon.toFixed(4)}`);
  console.log(`  Avg reward (last 50): ${policy.avgReward.toFixed(2)}\n`);

  // Show learned policy highlights
  console.log(`${"─".repeat(65)}`);
  console.log(`  Learned Policy (top states by Q-value)`);
  console.log(`${"─".repeat(65)}\n`);

  const summary = agent.getPolicySummary().slice(0, 15);
  console.log(`  ${"State".padEnd(14)} ${"Best Action".padEnd(12)} ${"Q-Value".padEnd(10)} Q-Values [0%, 25%, 50%, 75%, 100%]`);
  console.log(`  ${"─".repeat(60)}`);
  for (const row of summary) {
    const qStr = row.qValues.map(v => v.toFixed(2).padStart(6)).join(" ");
    console.log(`  ${row.state.padEnd(14)} ${row.bestAction.padEnd(12)} ${String(row.bestQ).padEnd(10)} [${qStr} ]`);
  }

  // Evaluate on test data
  console.log(`\n${"─".repeat(65)}`);
  console.log(`  Policy Evaluation — Out-of-Sample (${testPrices.length} days)`);
  console.log(`${"─".repeat(65)}\n`);

  const eval_ = evaluatePolicy(agent, testPrices);

  const strategies = [
    ["RL Agent",   eval_.rl],
    ["Kelly",      eval_.kelly],
    ["Fixed 100%", eval_.fixed100],
    ["Fixed 75%",  eval_.fixed75],
    ["Fixed 50%",  eval_.fixed50],
    ["Fixed 25%",  eval_.fixed25],
  ];

  console.log(
    `  ${"Strategy".padEnd(14)} ` +
    `${"Return".padStart(9)} ` +
    `${"Ann.Ret".padStart(9)} ` +
    `${"Sharpe".padStart(8)} ` +
    `${"MaxDD".padStart(8)} ` +
    `${"Calmar".padStart(8)} ` +
    `${"Equity".padStart(8)}`
  );
  console.log(`  ${"─".repeat(62)}`);

  for (const [name, metrics] of strategies) {
    const marker = name === "RL Agent" ? " <-" : "";
    console.log(
      `  ${name.padEnd(14)} ` +
      `${(metrics.totalReturn + "%").padStart(9)} ` +
      `${(metrics.annualizedReturn + "%").padStart(9)} ` +
      `${String(metrics.sharpe).padStart(8)} ` +
      `${(metrics.maxDrawdown + "%").padStart(8)} ` +
      `${String(metrics.calmar).padStart(8)} ` +
      `${String(metrics.finalEquity).padStart(8)}${marker}`
    );
  }

  // Determine winner
  const rlSharpe = eval_.rl.sharpe;
  const bestFixed = Math.max(eval_.fixed25.sharpe, eval_.fixed50.sharpe, eval_.fixed75.sharpe, eval_.fixed100.sharpe);
  const kellySharpe = eval_.kelly.sharpe;

  console.log();
  if (rlSharpe >= bestFixed && rlSharpe >= kellySharpe) {
    console.log(`  >> RL agent outperforms on risk-adjusted basis (Sharpe: ${rlSharpe})`);
  } else if (kellySharpe > rlSharpe && kellySharpe > bestFixed) {
    console.log(`  >> Kelly criterion leads (Sharpe: ${kellySharpe}). RL agent: ${rlSharpe}`);
  } else {
    console.log(`  >> Fixed sizing leads (Sharpe: ${bestFixed}). More training or data may help.`);
  }

  // Show example position sizing decisions
  console.log(`\n${"─".repeat(65)}`);
  console.log(`  Example Sizing Decisions`);
  console.log(`${"─".repeat(65)}\n`);

  const examples = [
    { recentReturn:  0.02, drawdown: 0.01, vol: 0.010, signal:  0.3,  label: "Bullish, low vol, small DD" },
    { recentReturn: -0.02, drawdown: 0.10, vol: 0.025, signal: -0.4,  label: "Bearish, high vol, 10% DD" },
    { recentReturn:  0.00, drawdown: 0.03, vol: 0.015, signal:  0.0,  label: "Neutral, normal vol" },
    { recentReturn:  0.03, drawdown: 0.00, vol: 0.008, signal:  0.5,  label: "Strong bull, very low vol" },
    { recentReturn: -0.04, drawdown: 0.20, vol: 0.040, signal: -0.6,  label: "Crash regime, 20% DD" },
  ];

  for (const ex of examples) {
    const result = getOptimalSize(agent, ex);
    console.log(`  ${ex.label}`);
    console.log(`    State: ret=${ex.recentReturn}, dd=${ex.drawdown}, vol=${ex.vol}, sig=${ex.signal}`);
    console.log(`    -> Position: ${result.label} (Q: [${result.qValues.map(v => v.toFixed(2)).join(", ")}])\n`);
  }

  console.log(`${"=".repeat(65)}\n`);
}

// Run CLI if called directly
const isMain = process.argv[1] && (
  process.argv[1].includes("rl-sizer.mjs") ||
  process.argv[1].endsWith("rl-sizer")
);

if (isMain) {
  main().catch(err => {
    console.error("RL Sizer failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
