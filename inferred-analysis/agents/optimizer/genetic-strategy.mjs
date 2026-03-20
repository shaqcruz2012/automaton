#!/usr/bin/env node
/**
 * Genetic Algorithm for Strategy Evolution — Inferred Analysis
 *
 * Evolves trading strategy parameters through natural selection:
 * 1. Population of strategy "genomes" (parameter sets)
 * 2. Fitness = Sharpe ratio from backtest
 * 3. Selection: tournament selection (top performers breed)
 * 4. Crossover: blend parent parameters
 * 5. Mutation: random parameter perturbation
 * 6. Elitism: best strategies survive unchanged
 *
 * Usage:
 *   node agents/optimizer/genetic-strategy.mjs
 *   import { GeneticOptimizer } from './genetic-strategy.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Genome (Strategy Parameter Set) ────────────────────

/**
 * A genome represents a complete set of strategy parameters.
 */
export function createGenome(paramSpec) {
  const genome = {};
  for (const [key, spec] of Object.entries(paramSpec)) {
    genome[key] = spec.min + Math.random() * (spec.max - spec.min);
    if (spec.integer) genome[key] = Math.round(genome[key]);
  }
  return genome;
}

// ─── Genetic Operators ──────────────────────────────────

/**
 * Tournament selection: pick k random individuals, return best.
 */
export function tournamentSelect(population, fitnesses, k = 3) {
  let bestIdx = Math.floor(Math.random() * population.length);
  let bestFit = fitnesses[bestIdx];

  for (let i = 1; i < k; i++) {
    const idx = Math.floor(Math.random() * population.length);
    if (fitnesses[idx] > bestFit) {
      bestIdx = idx;
      bestFit = fitnesses[idx];
    }
  }

  return population[bestIdx];
}

/**
 * Crossover: blend two parent genomes.
 */
export function crossover(parent1, parent2, paramSpec, crossoverRate = 0.7) {
  if (Math.random() > crossoverRate) {
    return { ...parent1 }; // no crossover, clone parent1
  }

  const child = {};
  for (const key of Object.keys(paramSpec)) {
    // BLX-alpha crossover (blend)
    const alpha = 0.3;
    const p1 = parent1[key];
    const p2 = parent2[key];
    const low = Math.min(p1, p2) - alpha * Math.abs(p1 - p2);
    const high = Math.max(p1, p2) + alpha * Math.abs(p1 - p2);
    child[key] = Math.max(paramSpec[key].min, Math.min(paramSpec[key].max, low + Math.random() * (high - low)));
    if (paramSpec[key].integer) child[key] = Math.round(child[key]);
  }

  return child;
}

/**
 * Mutation: perturb parameters with Gaussian noise.
 */
export function mutate(genome, paramSpec, mutationRate = 0.1, mutationStrength = 0.2) {
  const mutant = { ...genome };

  for (const [key, spec] of Object.entries(paramSpec)) {
    if (Math.random() < mutationRate) {
      const range = spec.max - spec.min;
      const perturbation = (Math.random() * 2 - 1) * range * mutationStrength;
      mutant[key] = Math.max(spec.min, Math.min(spec.max, mutant[key] + perturbation));
      if (spec.integer) mutant[key] = Math.round(mutant[key]);
    }
  }

  return mutant;
}

// ─── Backtest Fitness Function ──────────────────────────

/**
 * Run a momentum backtest with given parameters and return fitness (Sharpe).
 */
function backtestFitness(genome, prices) {
  const { lookback, threshold, stopLoss, takeProfit, positionSize } = genome;

  // Generate signals
  const signals = [];
  for (let i = Math.round(lookback); i < prices.length; i++) {
    const current = prices[i].close;
    const past = prices[i - Math.round(lookback)].close;
    const ret = (current - past) / past;
    let signal = 0;
    if (ret > threshold) signal = 1;
    if (ret < -threshold) signal = -1;
    signals.push({ price: current, signal });
  }

  // Simple backtest
  let capital = 1_000_000;
  let position = 0;
  let prevSignal = 0;
  let trades = 0;
  const dailyReturns = [];
  let prevEquity = capital;

  for (const sig of signals) {
    if (sig.signal !== prevSignal) {
      if (position !== 0) {
        capital += position * sig.price;
        capital -= Math.abs(position * sig.price) * 0.0015;
        position = 0;
        trades++;
      }
      if (sig.signal !== 0) {
        const tradeSize = capital * positionSize;
        position = sig.signal * tradeSize / sig.price;
        capital -= tradeSize;
        trades++;
      }
      prevSignal = sig.signal;
    }

    const equity = capital + position * sig.price;
    dailyReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;
  }

  if (position !== 0 && signals.length > 0) {
    capital += position * signals[signals.length - 1].price;
  }

  const n = dailyReturns.length;
  if (n < 20) return -10;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // Penalize excessive trading
  const tradePenalty = trades > 500 ? (trades - 500) * 0.001 : 0;

  return sharpe - tradePenalty;
}

// ─── Genetic Optimizer ──────────────────────────────────

export class GeneticOptimizer {
  constructor(options = {}) {
    this.populationSize = options.populationSize || 50;
    this.generations = options.generations || 30;
    this.eliteCount = options.eliteCount || 3;
    this.tournamentSize = options.tournamentSize || 3;
    this.crossoverRate = options.crossoverRate || 0.7;
    this.mutationRate = options.mutationRate || 0.15;
    this.mutationStrength = options.mutationStrength || 0.2;
    this.stagnationLimit = options.stagnationLimit || 10;

    this.paramSpec = options.paramSpec || {
      lookback: { min: 5, max: 100, integer: true },
      threshold: { min: 0.001, max: 0.10 },
      stopLoss: { min: -0.15, max: -0.01 },
      takeProfit: { min: 0.02, max: 0.30 },
      positionSize: { min: 0.02, max: 0.30 },
    };

    this.fitnessFunction = options.fitnessFunction || backtestFitness;
    this.history = [];
  }

  /**
   * Run the genetic algorithm.
   * Returns { bestGenome, bestFitness, history }
   */
  evolve(prices) {
    // Initialize population
    let population = Array.from(
      { length: this.populationSize },
      () => createGenome(this.paramSpec)
    );

    let bestEverGenome = null;
    let bestEverFitness = -Infinity;
    let stagnation = 0;

    for (let gen = 0; gen < this.generations; gen++) {
      // Evaluate fitness
      const fitnesses = population.map(genome => this.fitnessFunction(genome, prices));

      // Track best
      const genBestIdx = fitnesses.indexOf(Math.max(...fitnesses));
      const genBestFit = fitnesses[genBestIdx];
      const genAvgFit = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;
      const genWorstFit = Math.min(...fitnesses);

      if (genBestFit > bestEverFitness) {
        bestEverFitness = genBestFit;
        bestEverGenome = { ...population[genBestIdx] };
        stagnation = 0;
      } else {
        stagnation++;
      }

      this.history.push({
        generation: gen,
        bestFitness: genBestFit,
        avgFitness: genAvgFit,
        worstFitness: genWorstFit,
        bestEverFitness,
        bestGenome: { ...population[genBestIdx] },
        diversity: this._populationDiversity(population),
      });

      // Log progress
      if (gen % 5 === 0 || gen === this.generations - 1) {
        console.log(
          `  Gen ${String(gen).padStart(3)}: best=${genBestFit.toFixed(3)} avg=${genAvgFit.toFixed(3)} ` +
          `best_ever=${bestEverFitness.toFixed(3)} div=${this.history[this.history.length - 1].diversity.toFixed(3)}`
        );
      }

      // Early stopping on stagnation
      if (stagnation >= this.stagnationLimit) {
        console.log(`  Early stop: ${stagnation} generations without improvement`);
        break;
      }

      // Create next generation
      const nextGen = [];

      // Elitism: keep top N unchanged
      const sortedIndices = fitnesses
        .map((f, i) => ({ f, i }))
        .sort((a, b) => b.f - a.f)
        .map(x => x.i);

      for (let e = 0; e < this.eliteCount; e++) {
        nextGen.push({ ...population[sortedIndices[e]] });
      }

      // Breed rest
      while (nextGen.length < this.populationSize) {
        const parent1 = tournamentSelect(population, fitnesses, this.tournamentSize);
        const parent2 = tournamentSelect(population, fitnesses, this.tournamentSize);
        let child = crossover(parent1, parent2, this.paramSpec, this.crossoverRate);
        child = mutate(child, this.paramSpec, this.mutationRate, this.mutationStrength);
        nextGen.push(child);
      }

      // Adaptive mutation: increase mutation when stagnating
      if (stagnation > 3) {
        this.mutationRate = Math.min(0.5, this.mutationRate * 1.1);
        this.mutationStrength = Math.min(0.5, this.mutationStrength * 1.1);
      } else {
        this.mutationRate = Math.max(0.05, this.mutationRate * 0.95);
        this.mutationStrength = Math.max(0.05, this.mutationStrength * 0.95);
      }

      population = nextGen;
    }

    return {
      bestGenome: bestEverGenome,
      bestFitness: bestEverFitness,
      history: this.history,
      finalPopulation: population,
    };
  }

  /**
   * Measure population diversity (average pairwise distance).
   */
  _populationDiversity(population) {
    const keys = Object.keys(this.paramSpec);
    let totalDist = 0;
    let pairs = 0;

    const sampleSize = Math.min(population.length, 20);
    for (let i = 0; i < sampleSize; i++) {
      for (let j = i + 1; j < sampleSize; j++) {
        let dist = 0;
        for (const key of keys) {
          const range = this.paramSpec[key].max - this.paramSpec[key].min;
          if (range > 0) {
            dist += ((population[i][key] - population[j][key]) / range) ** 2;
          }
        }
        totalDist += Math.sqrt(dist / keys.length);
        pairs++;
      }
    }

    return pairs > 0 ? totalDist / pairs : 0;
  }
}

// ─── Multi-Strategy Evolution ───────────────────────────

/**
 * Evolve multiple strategy types in parallel, then combine best of each.
 */
export function multiStrategyEvolution(prices, strategies) {
  const results = [];

  for (const strategy of strategies) {
    console.log(`\n─── Evolving: ${strategy.name} ───`);
    const optimizer = new GeneticOptimizer({
      paramSpec: strategy.paramSpec,
      fitnessFunction: strategy.fitnessFunction || backtestFitness,
      populationSize: 30,
      generations: 20,
    });

    const result = optimizer.evolve(prices);
    results.push({
      name: strategy.name,
      ...result,
    });
  }

  return results.sort((a, b) => b.bestFitness - a.bestFitness);
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Genetic Strategy Evolution ═══\n");

  const prices = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  console.log(`Data: ${prices.length} days\n`);

  const optimizer = new GeneticOptimizer({
    populationSize: 40,
    generations: 25,
    eliteCount: 3,
    mutationRate: 0.15,
  });

  const result = optimizer.evolve(prices);

  console.log("\n─── Best Strategy Found ───");
  console.log(`  Sharpe: ${result.bestFitness.toFixed(4)}`);
  console.log("  Parameters:");
  for (const [key, value] of Object.entries(result.bestGenome)) {
    console.log(`    ${key.padEnd(14)} = ${typeof value === "number" ? value.toFixed(4) : value}`);
  }

  // Evolution curve
  console.log("\n─── Evolution Progress ───");
  for (const h of result.history) {
    if (h.generation % 5 === 0) {
      const bar = "█".repeat(Math.max(0, Math.round((h.bestEverFitness + 1) * 10)));
      console.log(`  Gen ${String(h.generation).padStart(3)}: ${bar} ${h.bestEverFitness.toFixed(3)}`);
    }
  }

  // Multi-strategy evolution
  console.log("\n═══ Multi-Strategy Tournament ═══");
  const strategies = [
    {
      name: "Fast Momentum",
      paramSpec: {
        lookback: { min: 3, max: 20, integer: true },
        threshold: { min: 0.005, max: 0.05 },
        positionSize: { min: 0.05, max: 0.25 },
        stopLoss: { min: -0.10, max: -0.02 },
        takeProfit: { min: 0.03, max: 0.15 },
      },
    },
    {
      name: "Slow Trend",
      paramSpec: {
        lookback: { min: 40, max: 200, integer: true },
        threshold: { min: 0.01, max: 0.10 },
        positionSize: { min: 0.05, max: 0.20 },
        stopLoss: { min: -0.15, max: -0.05 },
        takeProfit: { min: 0.10, max: 0.40 },
      },
    },
  ];

  const multiResults = multiStrategyEvolution(prices, strategies);
  console.log("\n─── Tournament Results ───");
  for (const r of multiResults) {
    console.log(`  ${r.name.padEnd(20)} Sharpe=${r.bestFitness.toFixed(3)}`);
    for (const [k, v] of Object.entries(r.bestGenome)) {
      console.log(`    ${k.padEnd(14)} = ${typeof v === "number" ? v.toFixed(4) : v}`);
    }
  }
}

if (process.argv[1]?.includes("genetic-strategy")) {
  main().catch(console.error);
}
