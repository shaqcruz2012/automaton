# Paper Trader — Alpaca Integration

Paper trading bridge between inferred-analysis strategy agents and Alpaca's paper trading API.

## Setup

### 1. Create an Alpaca Account

Sign up at [https://alpaca.markets](https://alpaca.markets) and enable paper trading.

### 2. Get API Keys

Go to **Paper Trading** > **API Keys** and generate a new key pair.

### 3. Set Environment Variables

```bash
export ALPACA_API_KEY=PKXXXXXXXXXXXXXXXXXX
export ALPACA_SECRET_KEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
export ALPACA_PAPER=true
```

Or create a `.env` file in the project root (do NOT commit this):

```
ALPACA_API_KEY=PKXXXXXXXXXXXXXXXXXX
ALPACA_SECRET_KEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
ALPACA_PAPER=true
```

## Usage

### Run a strategy in paper mode

```bash
node agents/trading/paper-trader.mjs --agent alpha_researcher --mode paper
node agents/trading/paper-trader.mjs --agent stat_arb_quant --mode paper
```

### Check account status, positions, and open orders

```bash
node agents/trading/paper-trader.mjs --status
```

### Flatten all positions (close everything)

```bash
node agents/trading/paper-trader.mjs --flatten
```

### Dry run (preview what would happen without placing orders)

```bash
node agents/trading/paper-trader.mjs --agent alpha_researcher --dry-run
```

### Override the symbol

```bash
node agents/trading/paper-trader.mjs --agent alpha_researcher --symbol AAPL
```

## Agent-Symbol Mapping

| Agent | Default Symbol |
|-------|---------------|
| alpha_researcher | SPY |
| stat_arb_quant | QQQ |
| macro_quant | TLT |
| vol_quant | SPY |
| hf_quant | AAPL |
| microstructure_researcher | IWM |
| econ_researcher | GLD |

## Safety Controls

All defaults can be overridden via environment variables.

| Control | Default | Env Var |
|---------|---------|---------|
| Max position size | $10,000 | `MAX_POSITION_SIZE` |
| Max daily loss | $500 | `MAX_DAILY_LOSS` |
| Max open positions | 5 | `MAX_OPEN_POSITIONS` |
| Drawdown kill switch | 5% | `DRAWDOWN_KILL_PCT` |

When any limit is hit, the trader stops opening new positions and logs the event. Use `--flatten` to close everything if needed.

## Trade Log

All trades are logged to `agents/outputs/trades.tsv` with columns:

```
timestamp  agent  symbol  side  qty  price  order_id  status  equity_before  equity_after  daily_pnl  signal_source
```

## How It Works

1. Loads the strategy from `agents/strategies/<agent>.js`
2. Fetches price data (Alpaca API, local cache, or synthetic fallback)
3. Runs the strategy's `generateSignals()` to get the latest signal
4. Compares signal to current Alpaca position
5. Executes trades if signal differs from current position
6. Logs everything to `agents/outputs/trades.tsv`
7. Runs a quick backtest comparison for sanity checking

## File Structure

```
agents/trading/
  paper-trader.mjs   — Main module (this file)
  README.md          — Setup instructions

agents/strategies/
  alpha_researcher.js — Strategy files (signals come from here)
  stat_arb_quant.js

agents/outputs/
  trades.tsv         — Trade log (auto-created)
```
