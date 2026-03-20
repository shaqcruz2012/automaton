#!/usr/bin/env node
/**
 * Signal Aggregator — Inferred Analysis Ensemble System
 *
 * Combines trading signals from multiple strategy agents into a single
 * ensemble signal using configurable aggregation methods.
 *
 * Methods:
 *   - "majority"  — majority vote across agents (sign of sum)
 *   - "weighted"  — weighted average by agent Sharpe ratios
 *   - "unanimous" — only trade when all agents agree on direction
 *   - "rank"      — rank-weighted average (best Sharpe gets highest weight)
 *
 * Usage:
 *   import { aggregateSignals } from './signal-aggregator.mjs';
 *
 *   const agentSignals = [
 *     { name: "alpha_researcher",  signals: [...], weight: 1.0 },
 *     { name: "stat_arb_quant",    signals: [...], weight: 0.5 },
 *   ];
 *   const combined = aggregateSignals(agentSignals, { method: "weighted" });
 *   // => [{ date, signal, price, contributions: {...} }, ...]
 */

// ─── Aggregation Methods ─────────────────────────────────────

/**
 * Majority vote: signal = sign(sum of all agent signals).
 * Ties (sum === 0) produce a flat signal.
 */
function majorityVote(agentSignalsByDate) {
  const sum = agentSignalsByDate.reduce((acc, s) => acc + s.signal, 0);
  return sum > 0 ? 1 : sum < 0 ? -1 : 0;
}

/**
 * Weighted average: signal direction from weighted sum, threshold at 0.3.
 * Weights typically come from agent Sharpe ratios (clipped to >= 0).
 */
function weightedAverage(agentSignalsByDate, threshold = 0.3) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const s of agentSignalsByDate) {
    const w = Math.max(s.weight || 1, 0);
    weightedSum += s.signal * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return 0;
  const avg = weightedSum / totalWeight;
  if (avg > threshold) return 1;
  if (avg < -threshold) return -1;
  return 0;
}

/**
 * Unanimous: only emit a signal when every agent agrees on the same direction.
 */
function unanimous(agentSignalsByDate) {
  const nonZero = agentSignalsByDate.filter((s) => s.signal !== 0);
  if (nonZero.length === 0) return 0;
  const first = nonZero[0].signal;
  return nonZero.every((s) => s.signal === first) ? first : 0;
}

/**
 * Rank-weighted: agents ranked by their weight (Sharpe), higher rank = more influence.
 * Rank 1 (best) gets weight = N, rank N (worst) gets weight = 1.
 */
function rankWeighted(agentSignalsByDate, threshold = 0.3) {
  const sorted = [...agentSignalsByDate].sort(
    (a, b) => (b.weight || 0) - (a.weight || 0)
  );
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < sorted.length; i++) {
    const rankWeight = sorted.length - i; // best agent gets highest rank weight
    weightedSum += sorted[i].signal * rankWeight;
    totalWeight += rankWeight;
  }
  if (totalWeight === 0) return 0;
  const avg = weightedSum / totalWeight;
  if (avg > threshold) return 1;
  if (avg < -threshold) return -1;
  return 0;
}

// ─── Main Aggregation Function ──────────────────────────────

/**
 * Aggregate signals from multiple agents into a single ensemble signal stream.
 *
 * @param {Array} agentSignals - Array of { name, signals: [{ date, signal, price }], weight? }
 * @param {Object} opts
 * @param {string} opts.method - Aggregation method: "majority" | "weighted" | "unanimous" | "rank"
 * @param {number} opts.threshold - Signal threshold for weighted/rank methods (default 0.3)
 * @returns {Array} Combined signal array: [{ date, signal, price, contributions }]
 */
export function aggregateSignals(agentSignals, opts = {}) {
  const method = opts.method || "weighted";
  const threshold = opts.threshold != null ? opts.threshold : 0.3;

  if (agentSignals.length === 0) return [];

  // Build a date-indexed map for each agent's signals
  const dateMap = new Map(); // date -> [{ name, signal, weight }]

  for (const agent of agentSignals) {
    for (const sig of agent.signals) {
      if (!dateMap.has(sig.date)) {
        dateMap.set(sig.date, { price: sig.price, agents: [] });
      }
      dateMap.get(sig.date).agents.push({
        name: agent.name,
        signal: sig.signal,
        weight: agent.weight != null ? agent.weight : 1,
      });
    }
  }

  // Only keep dates where ALL agents have signals
  const numAgents = agentSignals.length;
  const combined = [];

  const sortedDates = [...dateMap.keys()].sort();
  for (const date of sortedDates) {
    const entry = dateMap.get(date);
    if (entry.agents.length < numAgents) continue; // skip partial dates

    let signal;
    switch (method) {
      case "majority":
        signal = majorityVote(entry.agents);
        break;
      case "weighted":
        signal = weightedAverage(entry.agents, threshold);
        break;
      case "unanimous":
        signal = unanimous(entry.agents);
        break;
      case "rank":
        signal = rankWeighted(entry.agents, threshold);
        break;
      default:
        signal = weightedAverage(entry.agents, threshold);
    }

    const contributions = {};
    for (const a of entry.agents) {
      contributions[a.name] = a.signal;
    }

    combined.push({
      date,
      signal,
      price: entry.price,
      contributions,
    });
  }

  return combined;
}

/**
 * Compute optimal weights from individual agent backtest metrics.
 * Uses Sharpe ratio clipped to [0, inf) as weight. Negative-Sharpe agents get 0.
 *
 * @param {Array} agentMetrics - Array of { name, metrics: { sharpe, ... } }
 * @returns {Object} Map of agentName -> weight
 */
export function computeWeights(agentMetrics) {
  const weights = {};
  for (const agent of agentMetrics) {
    // Agents with negative Sharpe get zero weight (don't follow bad strategies)
    weights[agent.name] = Math.max(agent.metrics.sharpe, 0);
  }
  // If all weights are zero, fall back to equal weight
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  if (totalWeight === 0) {
    for (const agent of agentMetrics) {
      weights[agent.name] = 1;
    }
  }
  return weights;
}

export const METHODS = ["majority", "weighted", "unanimous", "rank"];
