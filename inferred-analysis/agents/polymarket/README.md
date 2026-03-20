# Polymarket BTC 5-Minute Prediction Agent

Autoresearch agent that trades BTC 5-minute prediction markets on Polymarket.

Uses the same hypothesize-test-evaluate-keep/discard loop as `agent-runner.mjs`, with crypto-specific strategy mutations (momentum, RSI, VWAP reversion, Bollinger bands, order flow imbalance, EMA crossover).

## Quick Start

```bash
# Run with synthetic data (no API keys needed)
cd /home/user/automaton/inferred-analysis
node agents/polymarket/btc-agent.mjs --iterations 10

# More candles for deeper backtest
node agents/polymarket/btc-agent.mjs --iterations 20 --candles 1000
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POLYMARKET_API_KEY` | No | (stub mode) | Polymarket CLOB API key |
| `POLYMARKET_SECRET` | No | (stub mode) | Polymarket signing secret |
| `BTC_DATA_SOURCE` | No | `synthetic` | Set to a candle API URL for real data |

## Modes

### Dry Run (default)
Runs the autoresearch loop with synthetic candle data and Polymarket stubs. No real trades are placed. Results are logged to `agents/results.tsv`.

```bash
node agents/polymarket/btc-agent.mjs --iterations 10
```

### Live Trading
Requires `POLYMARKET_API_KEY` and `POLYMARKET_SECRET`. Pass `--live` to enable real trade execution.

```bash
POLYMARKET_API_KEY=pk_... POLYMARKET_SECRET=sk_... \
  node agents/polymarket/btc-agent.mjs --iterations 10 --live
```

### Real BTC Data
Point `BTC_DATA_SOURCE` at a candle endpoint that returns JSON arrays of `[timestamp, open, high, low, close, volume]`.

```bash
BTC_DATA_SOURCE=https://api.example.com/candles \
  node agents/polymarket/btc-agent.mjs --iterations 10
```

## CLI Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--iterations N` | 5 | Number of strategy experiments to run |
| `--candles N` | 500 | Number of 5-minute candles to generate/fetch |
| `--paperclip-url URL` | `http://localhost:3100` | Paperclip server URL |
| `--company-id ID` | (auto-detect) | Paperclip company ID |
| `--live` | off | Enable real Polymarket trade execution |

## Strategy Mutations

The agent randomly selects and parameterizes these strategies each iteration:

- **btc_momentum** — Streak-based momentum (configurable streak length and minimum move)
- **btc_rsi** — RSI contrarian (randomized period, oversold/overbought thresholds)
- **btc_vwap_reversion** — Mean reversion to rolling VWAP
- **btc_bollinger** — Bollinger Band breakout or reversion (randomly selected mode)
- **btc_order_flow** — Volume-weighted buy/sell pressure imbalance
- **btc_ma_crossover** — EMA crossover with randomized fast/slow periods

## Output

Results are appended to `agents/results.tsv` in the same format as `agent-runner.mjs`. If Paperclip is running, experiment results are also reported as issues.

## Architecture

```
btc-agent.mjs
  |
  +-- fetchCandles()         # synthetic or real BTC 5-min OHLCV
  +-- MUTATIONS[]            # strategy library (each .generate() returns params + signal fn)
  +-- backtest()             # runs signals against candles, computes Sharpe/win-rate/PnL
  +-- polymarket.*           # API stubs (getMarkets/buy/sell/getPositions)
  +-- logResult()            # append to results.tsv
  +-- reportToPaperclip()    # POST experiment results as Paperclip issues
  +-- main()                 # autoresearch loop
```
