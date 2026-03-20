#!/usr/bin/env node
/**
 * Market Data Fetcher — Alpha Vantage
 *
 * Fetches real OHLCV price data and caches it locally for backtesting.
 *
 * Usage:
 *   node agents/data/fetch.mjs SPY                    # Fetch SPY daily
 *   node agents/data/fetch.mjs AAPL MSFT GOOGL        # Fetch multiple
 *   node agents/data/fetch.mjs --list                  # Show cached symbols
 *   node agents/data/fetch.mjs --refresh SPY           # Force re-fetch
 *
 * Environment:
 *   ALPHA_VANTAGE_KEY=your-api-key
 *
 * Cached data is stored in agents/data/cache/<SYMBOL>.json
 * Cache expires after 24 hours for daily data.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "cache");
const API_KEY = process.env.ALPHA_VANTAGE_KEY || "9M9R6PT1SZCK6014";
const BASE_URL = "https://www.alphavantage.co/query";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── API Functions ───────────────────────────────────────

/**
 * Fetch daily OHLCV data from Alpha Vantage.
 * Returns array of { date, open, high, low, close, volume }
 */
async function fetchDaily(symbol, outputSize = "full") {
  const url = `${BASE_URL}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=${outputSize}&apikey=${API_KEY}`;

  console.log(`  Fetching ${symbol} from Alpha Vantage...`);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  // Check for API errors
  if (data["Error Message"]) {
    throw new Error(`Alpha Vantage: ${data["Error Message"]}`);
  }
  if (data["Note"]) {
    throw new Error(`Alpha Vantage rate limit: ${data["Note"]}`);
  }
  if (data["Information"]) {
    throw new Error(`Alpha Vantage: ${data["Information"]}`);
  }

  const timeSeries = data["Time Series (Daily)"];
  if (!timeSeries) {
    throw new Error(`No data returned for ${symbol}. Response: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // Convert to our format, sorted by date ascending
  const prices = Object.entries(timeSeries)
    .map(([date, values]) => ({
      date,
      open: parseFloat(values["1. open"]),
      high: parseFloat(values["2. high"]),
      low: parseFloat(values["3. low"]),
      close: parseFloat(values["4. close"]),
      volume: parseInt(values["5. volume"]),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  console.log(`  Got ${prices.length} days for ${symbol} (${prices[0]?.date} → ${prices[prices.length - 1]?.date})`);
  return prices;
}

/**
 * Fetch intraday data (60-min bars) from Alpha Vantage.
 */
async function fetchIntraday(symbol, interval = "60min") {
  const url = `${BASE_URL}?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=full&apikey=${API_KEY}`;

  console.log(`  Fetching ${symbol} intraday (${interval}) from Alpha Vantage...`);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const data = await res.json();

  if (data["Error Message"]) throw new Error(data["Error Message"]);
  if (data["Note"]) throw new Error(`Rate limit: ${data["Note"]}`);

  const key = `Time Series (${interval})`;
  const timeSeries = data[key];
  if (!timeSeries) throw new Error(`No intraday data for ${symbol}`);

  return Object.entries(timeSeries)
    .map(([datetime, values]) => ({
      date: datetime,
      open: parseFloat(values["1. open"]),
      high: parseFloat(values["2. high"]),
      low: parseFloat(values["3. low"]),
      close: parseFloat(values["4. close"]),
      volume: parseInt(values["5. volume"]),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Cache Management ────────────────────────────────────

function getCachePath(symbol) {
  return join(CACHE_DIR, `${symbol.toUpperCase()}.json`);
}

function isCacheValid(symbol) {
  const path = getCachePath(symbol);
  if (!existsSync(path)) return false;

  try {
    const cached = JSON.parse(readFileSync(path, "utf-8"));
    const age = Date.now() - (cached.fetchedAt || 0);
    return age < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

function readCache(symbol) {
  const path = getCachePath(symbol);
  if (!existsSync(path)) return null;
  try {
    const cached = JSON.parse(readFileSync(path, "utf-8"));
    return cached.prices;
  } catch {
    return null;
  }
}

function writeCache(symbol, prices) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = getCachePath(symbol);
  writeFileSync(path, JSON.stringify({
    symbol: symbol.toUpperCase(),
    fetchedAt: Date.now(),
    fetchedAtISO: new Date().toISOString(),
    count: prices.length,
    startDate: prices[0]?.date,
    endDate: prices[prices.length - 1]?.date,
    prices,
  }, null, 2));
}

function listCached() {
  if (!existsSync(CACHE_DIR)) return [];
  return readdirSync(CACHE_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try {
        const data = JSON.parse(readFileSync(join(CACHE_DIR, f), "utf-8"));
        return {
          symbol: data.symbol,
          days: data.count,
          range: `${data.startDate} → ${data.endDate}`,
          age: Math.round((Date.now() - data.fetchedAt) / 60000) + " min ago",
        };
      } catch {
        return { symbol: f.replace(".json", ""), days: "?", range: "?", age: "?" };
      }
    });
}

// ─── Public API ──────────────────────────────────────────

/**
 * Get prices for a symbol, using cache if available.
 * This is the main function other modules import.
 */
export async function getPrices(symbol, forceRefresh = false) {
  symbol = symbol.toUpperCase();

  if (!forceRefresh && isCacheValid(symbol)) {
    const cached = readCache(symbol);
    if (cached) {
      console.log(`  Using cached data for ${symbol} (${cached.length} days)`);
      return cached;
    }
  }

  const prices = await fetchDaily(symbol);
  writeCache(symbol, prices);
  return prices;
}

/**
 * Get prices for multiple symbols.
 * Respects Alpha Vantage rate limit (5 calls/min on free tier).
 */
export async function getMultiplePrices(symbols, forceRefresh = false) {
  const result = {};
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i].toUpperCase();
    result[sym] = await getPrices(sym, forceRefresh);

    // Rate limit: 5 calls/min on free tier, wait 15s between calls
    if (i < symbols.length - 1 && forceRefresh) {
      console.log("  Rate limit pause (15s)...");
      await new Promise(r => setTimeout(r, 15000));
    }
  }
  return result;
}

// ─── Default Symbols for Quant Fund ─────────────────────

export const DEFAULT_SYMBOLS = [
  "SPY",   // S&P 500 ETF
  "QQQ",   // Nasdaq 100
  "IWM",   // Russell 2000
  "TLT",   // Long-term treasuries
  "GLD",   // Gold
  "VXX",   // VIX short-term futures
  "XLF",   // Financials
  "XLE",   // Energy
  "XLK",   // Technology
  "AAPL",  // Apple
];

// ─── Fallback: Realistic Synthetic Data ──────────────────

/**
 * Generate realistic price data when API is unavailable.
 * Uses geometric Brownian motion with mean-reverting volatility.
 * Better than pure random walk — mimics real equity behavior.
 */
export function generateRealisticPrices(symbol, startDate = "2020-01-01", endDate = "2025-03-01") {
  // Seed parameters by symbol for reproducibility
  const seed = [...symbol].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  const seedRng = (n) => {
    let s = seed + n;
    s = ((s >> 16) ^ s) * 0x45d9f3b;
    s = ((s >> 16) ^ s) * 0x45d9f3b;
    s = (s >> 16) ^ s;
    return (s & 0x7fffffff) / 0x7fffffff;
  };

  // Symbol-specific starting prices and drift
  const SYMBOL_PARAMS = {
    SPY: { price: 320, drift: 0.0003, vol: 0.012 },
    QQQ: { price: 250, drift: 0.0004, vol: 0.015 },
    IWM: { price: 160, drift: 0.0002, vol: 0.014 },
    AAPL: { price: 300, drift: 0.0004, vol: 0.018 },
    MSFT: { price: 200, drift: 0.0003, vol: 0.016 },
    GOOGL: { price: 1400, drift: 0.0003, vol: 0.017 },
    TSLA: { price: 200, drift: 0.0005, vol: 0.035 },
    TLT: { price: 160, drift: -0.0001, vol: 0.010 },
    GLD: { price: 170, drift: 0.0002, vol: 0.008 },
    XLF: { price: 28, drift: 0.0002, vol: 0.013 },
    XLE: { price: 45, drift: 0.0001, vol: 0.020 },
    XLK: { price: 110, drift: 0.0004, vol: 0.015 },
  };

  const params = SYMBOL_PARAMS[symbol.toUpperCase()] || { price: 100, drift: 0.0002, vol: 0.015 };
  let price = params.price;
  let vol = params.vol;
  const prices = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  let rngCounter = 0;

  // Box-Muller for normal distribution
  function randn() {
    const u1 = seedRng(rngCounter++) * 0.9998 + 0.0001;
    const u2 = seedRng(rngCounter++) * 0.9998 + 0.0001;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    // Mean-reverting stochastic volatility
    vol = vol + 0.05 * (params.vol - vol) + 0.002 * randn();
    vol = Math.max(0.003, Math.min(0.05, vol));

    // GBM with drift
    const dailyReturn = params.drift + vol * randn();

    // Occasional regime shifts (earnings, macro events)
    const eventProb = seedRng(rngCounter++);
    const eventShock = eventProb < 0.02 ? randn() * 0.03 : 0;

    price *= (1 + dailyReturn + eventShock);
    price = Math.max(price * 0.5, price); // prevent negative

    const dayVol = vol * (0.8 + seedRng(rngCounter++) * 0.4);
    prices.push({
      date: d.toISOString().split("T")[0],
      open: +(price * (1 + (randn() * 0.003))).toFixed(2),
      high: +(price * (1 + Math.abs(randn()) * dayVol)).toFixed(2),
      low: +(price * (1 - Math.abs(randn()) * dayVol)).toFixed(2),
      close: +price.toFixed(2),
      volume: Math.floor(1_000_000 + seedRng(rngCounter++) * 50_000_000),
    });
  }

  console.log(`  Generated realistic data for ${symbol}: ${prices.length} days (${startDate} → ${endDate})`);
  return prices;
}

// ─── CLI ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    const cached = listCached();
    if (cached.length === 0) {
      console.log("No cached data. Run: node agents/data/fetch.mjs SPY");
      return;
    }
    console.log("Cached market data:\n");
    for (const c of cached) {
      console.log(`  ${c.symbol.padEnd(6)} ${String(c.days).padStart(5)} days  ${c.range}  (${c.age})`);
    }
    return;
  }

  const refresh = args.includes("--refresh");
  const symbols = args.filter(a => !a.startsWith("--"));

  if (symbols.length === 0) {
    console.log("Fetching default symbols for quant fund...\n");
    symbols.push(...DEFAULT_SYMBOLS.slice(0, 3)); // SPY, QQQ, IWM to start
  }

  for (const symbol of symbols) {
    try {
      const prices = await getPrices(symbol, refresh);
      console.log(`  ✓ ${symbol}: ${prices.length} days\n`);
    } catch (err) {
      console.error(`  ✗ ${symbol}: ${err.message}\n`);
    }

    // Rate limit pause between API calls
    if (symbols.indexOf(symbol) < symbols.length - 1) {
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  console.log("\nDone. Use --list to see cached data.");
}

// Run CLI if called directly
if (process.argv[1]?.includes("fetch.mjs")) {
  main().catch(err => {
    console.error("Fetch failed:", err.message);
    process.exit(1);
  });
}
