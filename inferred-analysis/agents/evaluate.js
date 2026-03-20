#!/usr/bin/env node
/**
 * Inferred Analysis — Experiment Evaluator
 *
 * Scores research experiments on multiple dimensions.
 * Implements the self-improvement feedback loop: the evaluator's critique
 * is fed back to the agent to improve future experiments.
 *
 * For the quant fund: scoring focuses on alpha quality, risk-adjusted returns,
 * statistical significance, and implementation feasibility.
 *
 * Usage:
 *   node agents/evaluate.js <experiment_id>
 *   node agents/evaluate.js --criteria          # show scoring criteria
 *   node agents/evaluate.js --calibrate <id>    # re-evaluate with updated criteria
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = path.join(__dirname, "outputs");

// ─── Scoring Criteria (v2 — Quant Fund) ────────────────────

const CRITERIA = {
  alpha_quality: {
    weight: 0.30,
    description: "Quality of the alpha signal or trading insight",
    rubric: {
      "90-100": "Novel signal with strong theoretical basis and empirical evidence. Not in published literature.",
      "70-89": "Known signal class but novel application, data source, or combination.",
      "50-69": "Standard signal with some refinement or new market application.",
      "30-49": "Well-known signal, minimal novelty. Likely already crowded.",
      "0-29": "Trivial or already fully arbitraged signal.",
    },
  },
  statistical_rigor: {
    weight: 0.25,
    description: "Statistical significance, robustness, and methodology",
    rubric: {
      "90-100": "Multiple hypothesis corrections, out-of-sample validation, bootstrap confidence intervals. No p-hacking.",
      "70-89": "Proper train/test split, significance tests, sensitivity analysis.",
      "50-69": "Basic backtesting with some statistical checks. Limited robustness testing.",
      "30-49": "In-sample only, or no statistical significance assessment.",
      "0-29": "No quantitative evidence. Pure speculation.",
    },
  },
  risk_adjusted_returns: {
    weight: 0.25,
    description: "Sharpe ratio, drawdown, tail risk, and practical return profile",
    rubric: {
      "90-100": "Sharpe > 2.0, max drawdown < 10%, low correlation to major factors. Survives transaction cost analysis.",
      "70-89": "Sharpe 1.0-2.0, reasonable drawdowns, some factor exposure but controlled.",
      "50-69": "Sharpe 0.5-1.0, or good returns but high drawdowns / factor loading.",
      "30-49": "Marginal returns after costs, or untested for realistic constraints.",
      "0-29": "Negative risk-adjusted returns or unrealistic assumptions.",
    },
  },
  implementability: {
    weight: 0.20,
    description: "Feasibility of live deployment: data availability, latency, capital requirements, market impact",
    rubric: {
      "90-100": "Ready for paper trading. Data pipeline identified, execution logic specified, capacity estimated.",
      "70-89": "Clear implementation path, most data sources identified. Some engineering work needed.",
      "50-69": "Conceptually implementable but significant infrastructure gaps.",
      "30-49": "Major data or execution challenges unresolved.",
      "0-29": "Requires data/technology that doesn't exist or isn't accessible.",
    },
  },
};

// ─── Evaluation Engine ────────────────────────────────────

function evaluateExperiment(experimentId) {
  const outputDir = path.join(OUTPUTS_DIR, experimentId);

  if (!fs.existsSync(outputDir)) {
    console.error(`Experiment output directory not found: ${outputDir}`);
    console.error(`Create it with: mkdir -p agents/outputs/${experimentId}`);
    process.exit(1);
  }

  // Read all output files
  const files = fs.readdirSync(outputDir).filter(f => !f.startsWith("."));
  if (files.length === 0) {
    console.error(`No output files found in ${outputDir}`);
    process.exit(1);
  }

  const contents = {};
  let totalWords = 0;
  for (const file of files) {
    const content = fs.readFileSync(path.join(outputDir, file), "utf-8");
    contents[file] = content;
    totalWords += content.split(/\s+/).length;
  }

  // Read hypothesis if available
  const hypothesisPath = path.join(__dirname, "hypotheses", `${experimentId}.md`);
  const hypothesis = fs.existsSync(hypothesisPath)
    ? fs.readFileSync(hypothesisPath, "utf-8")
    : null;

  // Automated scoring heuristics
  const scores = autoScore(contents, hypothesis, totalWords);

  // Generate critique (feedback for the agent)
  const critique = generateCritique(scores, contents, hypothesis);

  // Write evaluation report
  const reportPath = path.join(outputDir, "_evaluation.md");
  const report = formatReport(experimentId, scores, critique, files, totalWords);
  fs.writeFileSync(reportPath, report);

  // Output scores for logging
  console.log(`Evaluation: ${experimentId}`);
  console.log(`---`);
  for (const [dim, score] of Object.entries(scores)) {
    const criteria = CRITERIA[dim];
    console.log(`${dim.padEnd(25)} ${score.toString().padStart(3)} (weight: ${criteria.weight})`);
  }
  const composite = computeComposite(scores);
  console.log(`---`);
  console.log(`composite:               ${composite.toFixed(1)}`);
  console.log(`total_words:             ${totalWords}`);
  console.log(`files:                   ${files.length}`);
  console.log(`---`);
  console.log(`\nCritique:\n${critique}`);
  console.log(`\nFull evaluation written to: ${reportPath}`);

  // Output machine-readable scores
  console.log(`\n_SCORES_: ${scores.alpha_quality} ${scores.statistical_rigor} ${scores.risk_adjusted_returns} ${scores.implementability} ${composite.toFixed(1)}`);
}

// ─── Auto-Scoring Heuristics ────────────────────────────

function autoScore(contents, hypothesis, totalWords) {
  const allText = Object.values(contents).join("\n").toLowerCase();

  // Alpha Quality — look for signals of novelty
  let alpha = 40; // baseline
  if (allText.includes("novel") || allText.includes("new signal") || allText.includes("undiscovered")) alpha += 15;
  if (allText.includes("literature") || allText.includes("research paper") || allText.includes("academic")) alpha += 10;
  if (allText.includes("alternative data") || allText.includes("satellite") || allText.includes("nlp") || allText.includes("sentiment")) alpha += 10;
  if (allText.includes("crowded") || allText.includes("well-known")) alpha -= 15;
  if (hypothesis && hypothesis.length > 200) alpha += 5; // well-formed hypothesis

  // Statistical Rigor — look for methodology signals
  let stats = 30; // baseline
  if (allText.includes("sharpe") || allText.includes("sortino") || allText.includes("calmar")) stats += 15;
  if (allText.includes("out-of-sample") || allText.includes("walk-forward") || allText.includes("cross-validation")) stats += 20;
  if (allText.includes("p-value") || allText.includes("t-stat") || allText.includes("significance")) stats += 10;
  if (allText.includes("bootstrap") || allText.includes("monte carlo")) stats += 10;
  if (allText.includes("backtest") || allText.includes("backtested")) stats += 10;
  if (allText.includes("overfit") || allText.includes("data snooping") || allText.includes("multiple comparison")) stats += 5;

  // Risk-Adjusted Returns — look for actual numbers
  let risk = 25; // baseline
  const sharpeMatch = allText.match(/sharpe[:\s]+(\d+\.?\d*)/);
  if (sharpeMatch) {
    const sharpe = parseFloat(sharpeMatch[1]);
    if (sharpe > 2.0) risk += 40;
    else if (sharpe > 1.0) risk += 25;
    else if (sharpe > 0.5) risk += 10;
  }
  if (allText.includes("drawdown")) risk += 10;
  if (allText.includes("transaction cost") || allText.includes("slippage") || allText.includes("market impact")) risk += 10;
  if (allText.includes("capacity") || allText.includes("liquidity")) risk += 5;

  // Implementability — look for practical details
  let impl = 30; // baseline
  if (allText.includes("data source") || allText.includes("api") || allText.includes("data feed")) impl += 15;
  if (allText.includes("code") || allText.includes("python") || allText.includes("implementation")) impl += 10;
  if (allText.includes("latency") || allText.includes("execution") || allText.includes("order routing")) impl += 10;
  if (allText.includes("paper trading") || allText.includes("simulation") || allText.includes("live test")) impl += 15;
  if (totalWords > 1000) impl += 5; // more detailed = more implementable
  if (totalWords > 3000) impl += 5;

  // Clamp all scores to 0-100
  return {
    alpha_quality: clamp(alpha, 0, 100),
    statistical_rigor: clamp(stats, 0, 100),
    risk_adjusted_returns: clamp(risk, 0, 100),
    implementability: clamp(impl, 0, 100),
  };
}

function generateCritique(scores, contents, hypothesis) {
  const lines = [];

  // Identify weakest dimension
  const weakest = Object.entries(scores).reduce((a, b) => a[1] < b[1] ? a : b);
  lines.push(`**Weakest dimension**: ${weakest[0]} (${weakest[1]}/100)`);
  lines.push(`Improvement suggestion: ${CRITERIA[weakest[0]].rubric["70-89"]}`);
  lines.push("");

  // Specific feedback
  if (scores.alpha_quality < 50) {
    lines.push("- Alpha: The signal lacks novelty. Consider alternative data sources, non-linear combinations, or cross-asset signals that aren't in published literature.");
  }
  if (scores.statistical_rigor < 50) {
    lines.push("- Statistics: Add out-of-sample testing, bootstrap confidence intervals, and address multiple hypothesis testing. Show that results aren't due to chance.");
  }
  if (scores.risk_adjusted_returns < 50) {
    lines.push("- Returns: Include Sharpe ratio, max drawdown, and transaction cost analysis. Show the strategy survives realistic constraints.");
  }
  if (scores.implementability < 50) {
    lines.push("- Implementation: Specify data sources, execution logic, and capacity estimates. A strategy is worthless if it can't be deployed.");
  }

  // What went well
  const strongest = Object.entries(scores).reduce((a, b) => a[1] > b[1] ? a : b);
  if (strongest[1] >= 60) {
    lines.push("");
    lines.push(`**Strongest dimension**: ${strongest[0]} (${strongest[1]}/100) — keep building on this.`);
  }

  if (!hypothesis) {
    lines.push("");
    lines.push("**Missing hypothesis**: Write a hypothesis before running the experiment. This forces clear thinking about what you expect and why.");
  }

  return lines.join("\n");
}

// ─── Report Formatting ────────────────────────────────────

function formatReport(id, scores, critique, files, totalWords) {
  const composite = computeComposite(scores);
  const lines = [
    `# Evaluation Report: ${id}`,
    ``,
    `**Timestamp**: ${new Date().toISOString()}`,
    `**Composite Score**: ${composite.toFixed(1)}/100`,
    `**Files**: ${files.length}`,
    `**Total Words**: ${totalWords.toLocaleString()}`,
    ``,
    `## Scores`,
    ``,
    `| Dimension | Score | Weight | Weighted |`,
    `|-----------|-------|--------|----------|`,
  ];

  for (const [dim, score] of Object.entries(scores)) {
    const c = CRITERIA[dim];
    const weighted = (score * c.weight).toFixed(1);
    lines.push(`| ${dim} | ${score} | ${c.weight} | ${weighted} |`);
  }
  lines.push(`| **Composite** | **${composite.toFixed(1)}** | | |`);

  lines.push(``, `## Critique`, ``, critique);

  lines.push(``, `## Scoring Criteria Reference`, ``);
  for (const [dim, c] of Object.entries(CRITERIA)) {
    lines.push(`### ${dim} (weight: ${c.weight})`);
    lines.push(`${c.description}`);
    for (const [range, desc] of Object.entries(c.rubric)) {
      lines.push(`- **${range}**: ${desc}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ─── Utilities ────────────────────────────────────────────

function computeComposite(scores) {
  return Object.entries(scores).reduce((sum, [dim, score]) => {
    return sum + score * (CRITERIA[dim]?.weight || 0);
  }, 0);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function showCriteria() {
  console.log("Scoring Criteria (v2 — Quant Fund)\n");
  for (const [dim, c] of Object.entries(CRITERIA)) {
    console.log(`${dim} (weight: ${c.weight})`);
    console.log(`  ${c.description}`);
    for (const [range, desc] of Object.entries(c.rubric)) {
      console.log(`  ${range}: ${desc}`);
    }
    console.log();
  }
}

// ─── Main ────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

if (command === "--criteria") {
  showCriteria();
} else if (command === "--calibrate") {
  evaluateExperiment(args[0]);
} else if (command) {
  evaluateExperiment(command);
} else {
  console.log("Usage:");
  console.log("  node agents/evaluate.js <experiment_id>  — evaluate an experiment");
  console.log("  node agents/evaluate.js --criteria       — show scoring criteria");
}
