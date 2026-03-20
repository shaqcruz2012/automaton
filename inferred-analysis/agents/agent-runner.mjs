#!/usr/bin/env node
/**
 * Agent Runner — Autoresearch Loop for Paperclip Agents
 *
 * This is the bridge between Paperclip (agent management) and autoresearch (self-improvement).
 * When Paperclip wakes an agent, this runner:
 *   1. Reads the agent's assigned task from Paperclip
 *   2. Loads the agent's strategy file (their version of template.js)
 *   3. Runs the autoresearch loop: hypothesize → modify → backtest → evaluate → keep/discard
 *   4. Reports results back to Paperclip
 *   5. Logs experiment to results.tsv
 *
 * Usage:
 *   node agents/agent-runner.mjs                          # Run with defaults
 *   node agents/agent-runner.mjs --agent alpha_researcher  # Run specific agent
 *   node agents/agent-runner.mjs --iterations 10           # Run N experiments
 *   node agents/agent-runner.mjs --paperclip-url http://localhost:3100 --company-id <id>
 *
 * Each agent gets its own strategy file in agents/strategies/<role>.js
 * The autoresearch loop modifies the generateSignals() function, backtests, and keeps/discards.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─── CLI Args ────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    agent: "alpha_researcher",
    iterations: 5,
    paperclipUrl: "http://localhost:3100",
    companyId: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent") opts.agent = args[++i];
    if (args[i] === "--iterations") opts.iterations = parseInt(args[++i]);
    if (args[i] === "--paperclip-url") opts.paperclipUrl = args[++i];
    if (args[i] === "--company-id") opts.companyId = args[++i];
  }
  return opts;
}

// ─── Strategy Mutations ──────────────────────────────────

/**
 * Library of strategy mutations an agent can apply.
 * Each mutation modifies the generateSignals function and CONFIG.
 */
const MUTATIONS = [
  {
    name: "mean_reversion",
    description: "Mean reversion: buy when price drops below moving average, sell when above",
    apply(config, signalFn) {
      config.lookback = 10 + Math.floor(Math.random() * 40);
      config.threshold = 0.005 + Math.random() * 0.03;
      return `function generateSignals(prices) {
  const signals = [];
  const lookback = ${config.lookback};
  const threshold = ${config.threshold.toFixed(4)};
  for (let i = lookback; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += prices[j].close;
    const ma = sum / lookback;
    const deviation = (prices[i].close - ma) / ma;
    let signal = 0;
    if (deviation < -threshold) signal = 1;   // buy dip
    if (deviation > threshold) signal = -1;    // sell rally
    signals.push({ date: prices[i].date, signal, price: prices[i].close });
  }
  return signals;
}`;
    },
  },
  {
    name: "momentum_crossover",
    description: "Dual moving average crossover momentum strategy",
    apply(config) {
      const fast = 5 + Math.floor(Math.random() * 15);
      const slow = fast + 10 + Math.floor(Math.random() * 30);
      config.lookback = slow;
      return `function generateSignals(prices) {
  const signals = [];
  const fast = ${fast}, slow = ${slow};
  for (let i = slow; i < prices.length; i++) {
    let fastSum = 0, slowSum = 0;
    for (let j = i - fast; j < i; j++) fastSum += prices[j].close;
    for (let j = i - slow; j < i; j++) slowSum += prices[j].close;
    const fastMA = fastSum / fast;
    const slowMA = slowSum / slow;
    let signal = 0;
    if (fastMA > slowMA * 1.001) signal = 1;
    if (fastMA < slowMA * 0.999) signal = -1;
    signals.push({ date: prices[i].date, signal, price: prices[i].close });
  }
  return signals;
}`;
    },
  },
  {
    name: "volatility_breakout",
    description: "Breakout strategy based on volatility expansion",
    apply(config) {
      const lookback = 10 + Math.floor(Math.random() * 20);
      const volMult = 1.0 + Math.random() * 2.0;
      config.lookback = lookback;
      return `function generateSignals(prices) {
  const signals = [];
  const lookback = ${lookback};
  const volMult = ${volMult.toFixed(3)};
  for (let i = lookback; i < prices.length; i++) {
    let sum = 0, sqSum = 0;
    for (let j = i - lookback; j < i; j++) {
      const ret = (prices[j].close - prices[j-1 >= 0 ? j-1 : 0].close) / prices[j-1 >= 0 ? j-1 : 0].close;
      sum += ret;
      sqSum += ret * ret;
    }
    const mean = sum / lookback;
    const vol = Math.sqrt(sqSum / lookback - mean * mean);
    const todayRet = (prices[i].close - prices[i-1].close) / prices[i-1].close;
    let signal = 0;
    if (todayRet > vol * volMult) signal = 1;
    if (todayRet < -vol * volMult) signal = -1;
    signals.push({ date: prices[i].date, signal, price: prices[i].close });
  }
  return signals;
}`;
    },
  },
  {
    name: "rsi_contrarian",
    description: "RSI-based contrarian strategy — buy oversold, sell overbought",
    apply(config) {
      const period = 7 + Math.floor(Math.random() * 21);
      const oversold = 20 + Math.floor(Math.random() * 15);
      const overbought = 100 - oversold;
      config.lookback = period;
      return `function generateSignals(prices) {
  const signals = [];
  const period = ${period};
  for (let i = period + 1; i < prices.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period; j < i; j++) {
      const change = prices[j+1].close - prices[j].close;
      if (change > 0) gains += change;
      else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
    const rsi = 100 - 100 / (1 + rs);
    let signal = 0;
    if (rsi < ${oversold}) signal = 1;    // oversold → buy
    if (rsi > ${overbought}) signal = -1;  // overbought → sell
    signals.push({ date: prices[i].date, signal, price: prices[i].close });
  }
  return signals;
}`;
    },
  },
  {
    name: "adaptive_momentum",
    description: "Momentum with adaptive threshold based on recent volatility",
    apply(config) {
      const lookback = 15 + Math.floor(Math.random() * 25);
      const volWindow = 5 + Math.floor(Math.random() * 15);
      const sensitivity = 0.5 + Math.random() * 2.0;
      config.lookback = lookback;
      return `function generateSignals(prices) {
  const signals = [];
  const lookback = ${lookback};
  const volWindow = ${volWindow};
  const sensitivity = ${sensitivity.toFixed(3)};
  for (let i = Math.max(lookback, volWindow + 1); i < prices.length; i++) {
    const current = prices[i].close;
    const past = prices[i - lookback].close;
    const momentum = (current - past) / past;
    let volSum = 0;
    for (let j = i - volWindow; j < i; j++) {
      const ret = Math.abs((prices[j].close - prices[j-1].close) / prices[j-1].close);
      volSum += ret;
    }
    const avgVol = volSum / volWindow;
    const threshold = avgVol * sensitivity;
    let signal = 0;
    if (momentum > threshold) signal = 1;
    if (momentum < -threshold) signal = -1;
    signals.push({ date: prices[i].date, signal, price: prices[i].close });
  }
  return signals;
}`;
    },
  },
  {
    name: "price_channel",
    description: "Donchian channel breakout — buy at highs, sell at lows",
    apply(config) {
      const lookback = 10 + Math.floor(Math.random() * 40);
      config.lookback = lookback;
      return `function generateSignals(prices) {
  const signals = [];
  const lookback = ${lookback};
  for (let i = lookback; i < prices.length; i++) {
    let highest = -Infinity, lowest = Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (prices[j].high > highest) highest = prices[j].high;
      if (prices[j].low < lowest) lowest = prices[j].low;
    }
    let signal = 0;
    if (prices[i].close > highest) signal = 1;
    if (prices[i].close < lowest) signal = -1;
    signals.push({ date: prices[i].date, signal, price: prices[i].close });
  }
  return signals;
}`;
    },
  },
];

// ─── Strategy File Management ────────────────────────────

function getStrategyPath(agentRole) {
  return join(ROOT, "agents", "strategies", `${agentRole}.js`);
}

function ensureStrategyFile(agentRole) {
  const stratPath = getStrategyPath(agentRole);
  if (!existsSync(stratPath)) {
    const templatePath = join(ROOT, "agents", "backtests", "template.js");
    mkdirSync(dirname(stratPath), { recursive: true });
    copyFileSync(templatePath, stratPath);
  }
  return stratPath;
}

function applyMutation(stratPath, mutation) {
  let content = readFileSync(stratPath, "utf-8");

  // Parse current CONFIG
  const configMatch = content.match(/const CONFIG = \{([^}]+)\}/s);
  const config = {
    lookback: 20,
    threshold: 0.02,
    stopLoss: -0.05,
    takeProfit: 0.10,
    positionSize: 0.10,
  };

  // Generate new signal function
  const newSignalFn = mutation.apply(config);

  // Replace generateSignals function
  const signalRegex = /function generateSignals\(prices\) \{[\s\S]*?\n\}/;
  if (signalRegex.test(content)) {
    content = content.replace(signalRegex, newSignalFn);
  }

  // Update CONFIG lookback
  content = content.replace(/lookback: \d+/, `lookback: ${config.lookback}`);
  if (config.threshold !== undefined) {
    content = content.replace(/threshold: [\d.]+/, `threshold: ${config.threshold.toFixed(4)}`);
  }

  writeFileSync(stratPath, content);
  return config;
}

// ─── Backtest Runner ─────────────────────────────────────

// Map agents to their focus symbols
const AGENT_SYMBOLS = {
  alpha_researcher: "SPY",
  stat_arb_quant: "QQQ",
  macro_quant: "TLT",
  vol_quant: "SPY",
  hf_quant: "AAPL",
  microstructure_researcher: "IWM",
  econ_researcher: "GLD",
};

function runBacktest(stratPath, agentRole) {
  const symbol = AGENT_SYMBOLS[agentRole] || "SPY";
  try {
    const output = execSync(`node "${stratPath}"`, {
      cwd: ROOT,
      timeout: 30_000,
      encoding: "utf-8",
      env: { ...process.env, SYMBOL: symbol },
    });

    // Parse metrics
    const metrics = {};
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^(\w+):\s+(.+)$/);
      if (match) {
        const key = match[1].trim();
        let val = match[2].trim();
        if (val.endsWith("%")) val = parseFloat(val) / 100;
        else val = parseFloat(val);
        if (!isNaN(val)) metrics[key] = val;
      }
    }
    return { ok: true, metrics, raw: output };
  } catch (err) {
    return { ok: false, error: err.message, metrics: null, raw: err.stderr || err.message };
  }
}

// ─── Results Logger ──────────────────────────────────────

function logResult(agent, experiment, metrics, status) {
  const resultsPath = join(ROOT, "agents", "results.tsv");
  const header = "timestamp\tagent\texperiment\tsharpe\tsortino\tcalmar\ttotal_return\tmax_drawdown\twin_rate\ttrades\tstatus\n";

  if (!existsSync(resultsPath)) {
    writeFileSync(resultsPath, header);
  }

  const line = [
    new Date().toISOString(),
    agent,
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

// ─── Paperclip Integration ──────────────────────────────

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

async function findAgent(baseUrl, companyId, agentRole) {
  const agents = await paperclipApi(baseUrl, "GET", `/api/companies/${companyId}/agents`);
  if (!agents) return null;
  return agents.find(a => a.capabilities?.includes(`[${agentRole}]`)) || null;
}

async function reportToP(baseUrl, companyId, agentId, result) {
  // Create an issue in Paperclip with experiment results
  if (!companyId || !agentId) return;
  try {
    await paperclipApi(baseUrl, "POST", `/api/companies/${companyId}/issues`, {
      title: `Experiment: ${result.experiment} — ${result.mutation}`,
      body: `**Strategy**: ${result.mutation}\n**Sharpe**: ${result.metrics?.sharpe?.toFixed(4) ?? 'N/A'}\n**Status**: ${result.status}\n**Total Return**: ${((result.metrics?.total_return ?? 0) * 100).toFixed(2)}%`,
      assigneeAgentId: agentId,
      priority: result.status === "keep" ? "high" : "medium",
    });
  } catch {
    // Paperclip reporting is best-effort
  }
}

// ─── Main Loop ───────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  Autoresearch Agent Runner                       ║`);
  console.log(`║  Agent: ${opts.agent.padEnd(40)}║`);
  console.log(`║  Iterations: ${String(opts.iterations).padEnd(35)}║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  // Setup strategy file
  const stratPath = ensureStrategyFile(opts.agent);
  console.log(`Strategy file: ${stratPath}\n`);

  // Get baseline
  console.log("Running baseline...");
  const baseline = runBacktest(stratPath, opts.agent);
  let bestSharpe = baseline.ok ? (baseline.metrics.sharpe ?? -Infinity) : -Infinity;
  console.log(`Baseline Sharpe: ${bestSharpe.toFixed(4)}\n`);
  logResult(opts.agent, "baseline", baseline.metrics, "baseline");

  // Save baseline strategy
  const baselineContent = readFileSync(stratPath, "utf-8");

  // Find Paperclip agent if available
  let paperclipAgent = null;
  let companyId = opts.companyId;
  if (!companyId) {
    const companies = await paperclipApi(opts.paperclipUrl, "GET", "/api/companies");
    if (companies?.length > 0) companyId = companies[0].id;
  }
  if (companyId) {
    paperclipAgent = await findAgent(opts.paperclipUrl, companyId, opts.agent);
    if (paperclipAgent) {
      console.log(`Paperclip agent: ${paperclipAgent.name} [${paperclipAgent.id}]\n`);
    }
  }

  // Autoresearch loop
  let keepCount = 0;
  let discardCount = 0;
  let crashCount = 0;
  let bestContent = baselineContent;

  for (let i = 1; i <= opts.iterations; i++) {
    // Pick random mutation
    const mutation = MUTATIONS[Math.floor(Math.random() * MUTATIONS.length)];
    console.log(`─── Experiment ${i}/${opts.iterations}: ${mutation.name} ───`);
    console.log(`  ${mutation.description}`);

    // Apply mutation
    applyMutation(stratPath, mutation);

    // Run backtest
    const result = runBacktest(stratPath, opts.agent);

    if (!result.ok) {
      console.log(`  CRASH: ${result.error?.slice(0, 100)}`);
      logResult(opts.agent, mutation.name, null, "crash");
      crashCount++;
      // Revert to best
      writeFileSync(stratPath, bestContent);
      await reportToP(opts.paperclipUrl, companyId, paperclipAgent?.id, {
        experiment: `${i}/${opts.iterations}`, mutation: mutation.name, status: "crash", metrics: null,
      });
      continue;
    }

    const sharpe = result.metrics.sharpe ?? -Infinity;
    const totalReturn = result.metrics.total_return ?? 0;

    if (sharpe > bestSharpe) {
      console.log(`  KEEP — Sharpe: ${sharpe.toFixed(4)} (was ${bestSharpe.toFixed(4)}) | Return: ${(totalReturn * 100).toFixed(2)}%`);
      bestSharpe = sharpe;
      bestContent = readFileSync(stratPath, "utf-8");
      keepCount++;
      logResult(opts.agent, mutation.name, result.metrics, "keep");
    } else {
      console.log(`  DISCARD — Sharpe: ${sharpe.toFixed(4)} <= ${bestSharpe.toFixed(4)} | Return: ${(totalReturn * 100).toFixed(2)}%`);
      writeFileSync(stratPath, bestContent);
      discardCount++;
      logResult(opts.agent, mutation.name, result.metrics, "discard");
    }

    await reportToP(opts.paperclipUrl, companyId, paperclipAgent?.id, {
      experiment: `${i}/${opts.iterations}`, mutation: mutation.name,
      status: sharpe > bestSharpe ? "keep" : "discard", metrics: result.metrics,
    });
  }

  // Summary
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  Results Summary                                 ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
  console.log(`║  Best Sharpe:  ${bestSharpe.toFixed(4).padEnd(34)}║`);
  console.log(`║  Kept:         ${String(keepCount).padEnd(34)}║`);
  console.log(`║  Discarded:    ${String(discardCount).padEnd(34)}║`);
  console.log(`║  Crashed:      ${String(crashCount).padEnd(34)}║`);
  console.log(`║  Keep Rate:    ${((keepCount / opts.iterations) * 100).toFixed(1).padEnd(31)}%  ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  // Run final backtest with best strategy
  const finalResult = runBacktest(stratPath, opts.agent);
  if (finalResult.ok) {
    console.log("Final best strategy metrics:");
    console.log(finalResult.raw);
  }
}

main().catch(err => {
  console.error("Agent runner failed:", err.message);
  process.exit(1);
});
