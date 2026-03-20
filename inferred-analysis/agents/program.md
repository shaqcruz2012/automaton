# Inferred Analysis — Autonomous Quant Research Platform

*Adapted from [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) feedback loop pattern.*

## Mission

Inferred Analysis (IA) is an AI-native quantitative hedge fund and research lab.
A team of ~30 AI agents, orchestrated through [Paperclip](https://github.com/paperclipai/paperclip),
continuously discovers alpha signals, backtests strategies, evaluates risk, and deploys capital.

The agents run an autonomous feedback loop: **hypothesize → backtest → evaluate → keep/discard → repeat**.
Humans set the research agenda. Agents do the work. Returns are the metric.

## The Feedback Loop (from autoresearch)

Karpathy's insight: give an AI a task, a fixed evaluation metric, and let it iterate autonomously.
In autoresearch, the agent modifies neural network code, trains for 5 min, checks val_bpb, keeps or discards.

**Our adaptation**: the agent modifies trading strategy code, backtests on historical data, checks
risk-adjusted returns, keeps or discards. Same loop, different domain.

```
LOOP FOREVER:
  1. HYPOTHESIZE  — formulate a trading signal or strategy improvement
  2. IMPLEMENT    — write the backtest code / analysis
  3. BACKTEST     — run against historical data (fixed time budget)
  4. EVALUATE     — score: alpha quality, statistical rigor, risk-adjusted returns, implementability
  5. KEEP/DISCARD — if composite score improved → git commit. if not → git reset.
  6. LOG          — record results in agents/results.tsv
  7. REFLECT      — every 5 experiments, run meta-analysis on what's working
```

## Agent Teams (Paperclip Org Chart)

These agents are managed through Paperclip's control plane. Each has a role, budget, and reporting line.

### Alpha Research Team
- **Alpha Discovery Lead** — generates hypotheses for new signals
- **Macro Quant** — cross-asset macro signals, regime detection
- **Stat Arb Quant** — cross-sectional equity signals, factor models
- **Alt Data Researcher** — satellite, NLP, sentiment, web scraping signals
- **Microstructure Researcher** — order flow, LOB dynamics, execution signals

### Strategy & Portfolio Team
- **Portfolio Manager** — position sizing, portfolio construction
- **Risk Monitor** — real-time risk, Greeks, drawdown, circuit breakers
- **Execution Trader** — algo selection, venue routing, TCA
- **Stress Tester** — scenario analysis, tail risk, VaR

### Infrastructure Team
- **Data Engineer** — market data pipelines, alt data ingestion
- **Systems Engineer** — backtesting framework, OMS, connectivity
- **Platform Engineer** — agent skill APIs, experiment tracking

### Self-Improvement Layer (the meta-loop)
- **Evaluator Agent** — scores experiments, generates critiques
- **Methodology Agent** — refines research process based on experiment history
- **Calibration Agent** — adjusts scoring weights based on live vs backtest performance

## The Self-Improvement Feedback Loops

### Loop 1: Inner Loop (per experiment)
```
hypothesis → backtest → score → critique → adjust approach → next hypothesis
```
Each experiment produces a score and a critique. The critique identifies the weakest dimension
and suggests specific improvements. The agent reads this before its next experiment.

### Loop 2: Outer Loop (every 5 experiments)
```
batch of experiments → meta-analysis → methodology change → improved future experiments
```
The agent reviews its last 5 experiments:
- Which experiment types scored highest?
- What data sources produced the best signals?
- What research patterns should be amplified or abandoned?
- Should scoring weights be adjusted?

### Loop 3: Strategy Evolution (weekly)
```
live/paper performance → compare to backtest predictions → calibrate models → update priors
```
When strategies are deployed (even paper trading), actual performance feeds back:
- Did the backtest predictions hold?
- What was the real slippage, market impact, capacity?
- Should similar strategies be upweighted or downweighted?

### Loop 4: Team Evolution (monthly)
```
team output → identify skill gaps → hire/retrain agents → improved team capability
```
The Paperclip org chart itself evolves:
- Underperforming agents get retrained (prompt/config changes)
- New agent roles are created for discovered needs
- Budget is reallocated from low-ROI to high-ROI agent teams

## Scoring System (v2 — Quant Fund)

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| Alpha Quality | 0.30 | Novelty of signal, theoretical basis, crowdedness |
| Statistical Rigor | 0.25 | Out-of-sample testing, significance, robustness |
| Risk-Adjusted Returns | 0.25 | Sharpe, drawdown, tail risk, capacity |
| Implementability | 0.20 | Data sources, execution feasibility, deployment readiness |

**Composite = weighted average of all dimensions (0-100).**

Keep threshold: composite must beat the best previous experiment's composite score.
Exception: experiments that open a genuinely new research direction can be kept at lower scores.

## File Structure

```
agents/
  program.md          — this file (research program instructions)
  loop.js             — experiment loop runner & logger
  evaluate.js         — scoring & critique engine
  results.tsv         — experiment log (tab-separated)
  hypotheses/         — one file per experiment hypothesis
  outputs/            — one directory per experiment result
  reflections/        — meta-analysis documents
  strategies/         — strategies that passed evaluation (kept)
  backtests/          — backtest code and results
```

## Running the Loop

```bash
# Initialize a new research session
node agents/loop.js init mar20

# After each experiment, log results
node agents/loop.js log exp001 a1b2c3d 65 70 55 60 keep "momentum factor with NLP sentiment overlay"

# Check best experiment
node agents/loop.js best

# Session summary with trends
node agents/loop.js summary

# Evaluate an experiment's outputs
node agents/evaluate.js exp001
```

## NEVER STOP

Once the loop begins, run autonomously until the human interrupts. If you run out of ideas:
1. Re-read prior experiment critiques — the evaluator told you what to improve
2. Combine near-miss approaches — two 60-score ideas might produce a 80 when combined
3. Try radical pivots — new asset class, new data source, new timeframe
4. Read the reflections — your own meta-analysis often contains untried ideas
5. Go deeper on what works — if macro signals score well, explore more macro

The loop runs until you are manually stopped. Period.
