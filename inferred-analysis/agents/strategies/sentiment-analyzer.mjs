#!/usr/bin/env node
/**
 * Sentiment Analysis Module — Inferred Analysis
 *
 * Keyword-based sentiment scoring for trading signals:
 * 1. Financial keyword dictionary with weights
 * 2. Sector-specific adjustments
 * 3. Sentiment decay (recency weighting)
 * 4. Sentiment momentum (rate of change)
 * 5. Combined sentiment + price action confirmation
 *
 * Usage:
 *   node agents/strategies/sentiment-analyzer.mjs
 *   import { analyzeSentiment, generateSentimentSignals } from './sentiment-analyzer.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Financial Keyword Dictionary ───────────────────────

const BULLISH_KEYWORDS = {
  // Strong bullish (weight: 2-3)
  "surge": 3, "soar": 3, "skyrocket": 3, "rally": 2.5, "breakout": 2.5,
  "record high": 3, "all-time high": 3, "beat expectations": 2.5, "blowout": 2.5,
  "upgrade": 2, "outperform": 2, "strong buy": 3, "bullish": 2,

  // Moderate bullish (weight: 1-2)
  "growth": 1.5, "gain": 1.5, "rise": 1, "climb": 1, "advance": 1,
  "optimistic": 1.5, "positive": 1, "improve": 1.5, "recover": 1.5,
  "exceed": 1.5, "upside": 1.5, "momentum": 1, "demand": 1,
  "expansion": 1.5, "profit": 1, "revenue growth": 2, "margin expansion": 2,

  // Mild bullish (weight: 0.5-1)
  "stable": 0.5, "steady": 0.5, "solid": 0.7, "resilient": 0.8,
  "support": 0.5, "accumulation": 0.8, "opportunity": 0.7, "value": 0.5,
};

const BEARISH_KEYWORDS = {
  // Strong bearish (weight: -2 to -3)
  "crash": -3, "collapse": -3, "plunge": -3, "selloff": -2.5, "panic": -3,
  "bankruptcy": -3, "default": -2.5, "fraud": -3, "downgrade": -2, "miss": -2,
  "recession": -2.5, "crisis": -2.5, "bearish": -2, "strong sell": -3,

  // Moderate bearish (weight: -1 to -2)
  "decline": -1.5, "drop": -1.5, "fall": -1, "loss": -1.5, "weak": -1.5,
  "concern": -1, "risk": -1, "warning": -1.5, "pressure": -1, "headwind": -1.5,
  "contraction": -1.5, "slowdown": -1.5, "cut": -1, "layoff": -1.5,
  "supply chain": -1, "inflation": -1, "rate hike": -1.5,

  // Mild bearish (weight: -0.5 to -1)
  "uncertainty": -0.8, "volatile": -0.7, "caution": -0.5, "mixed": -0.3,
  "resistance": -0.5, "distribution": -0.7, "overvalued": -0.8,
};

const SECTOR_ADJUSTMENTS = {
  technology: { "AI": 2, "cloud": 1.5, "cybersecurity": 1.5, "semiconductor": 1, "chip shortage": -1.5, "antitrust": -1.5, "regulation": -1 },
  energy: { "oil": 0.5, "OPEC": 1, "production cut": 1.5, "renewables": 0.5, "carbon tax": -1, "oversupply": -1.5 },
  financials: { "rate hike": 1, "yield curve": -1, "credit": -0.5, "lending": 0.5, "delinquency": -1.5 },
  healthcare: { "FDA approval": 2.5, "clinical trial": 1, "patent": 1, "FDA rejection": -2.5, "recall": -2 },
};

// ─── Sentiment Analysis ─────────────────────────────────

/**
 * Analyze sentiment of a text string.
 * Returns { score, magnitude, keywords }
 */
export function analyzeSentiment(text, sector = null) {
  const lower = text.toLowerCase();
  let score = 0;
  let magnitude = 0;
  const matched = [];

  // Check bullish keywords
  for (const [keyword, weight] of Object.entries(BULLISH_KEYWORDS)) {
    if (lower.includes(keyword)) {
      score += weight;
      magnitude += Math.abs(weight);
      matched.push({ keyword, weight, type: "bullish" });
    }
  }

  // Check bearish keywords
  for (const [keyword, weight] of Object.entries(BEARISH_KEYWORDS)) {
    if (lower.includes(keyword)) {
      score += weight;
      magnitude += Math.abs(weight);
      matched.push({ keyword, weight, type: "bearish" });
    }
  }

  // Sector-specific adjustments
  if (sector && SECTOR_ADJUSTMENTS[sector]) {
    for (const [keyword, weight] of Object.entries(SECTOR_ADJUSTMENTS[sector])) {
      if (lower.includes(keyword.toLowerCase())) {
        score += weight;
        magnitude += Math.abs(weight);
        matched.push({ keyword, weight, type: weight > 0 ? "sector_bullish" : "sector_bearish" });
      }
    }
  }

  // Negation detection (simple)
  const negations = ["not", "no", "never", "neither", "hardly", "barely", "doesn't", "don't", "won't", "isn't"];
  for (const neg of negations) {
    if (lower.includes(neg)) {
      score *= -0.5; // flip and dampen
      break;
    }
  }

  // Normalize score
  const normalizedScore = magnitude > 0 ? score / magnitude : 0;

  return {
    score,
    normalizedScore, // -1 to 1
    magnitude,
    keywordCount: matched.length,
    keywords: matched,
    sentiment: normalizedScore > 0.2 ? "bullish" : normalizedScore < -0.2 ? "bearish" : "neutral",
  };
}

/**
 * Get aggregate sentiment score from multiple text items.
 */
export function getSentimentScore(texts, sector = null, decayFactor = 0.95) {
  let totalScore = 0;
  let totalWeight = 0;

  // Most recent texts get higher weight (sentiment decay)
  for (let i = 0; i < texts.length; i++) {
    const weight = Math.pow(decayFactor, texts.length - 1 - i);
    const analysis = analyzeSentiment(texts[i], sector);
    totalScore += analysis.normalizedScore * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? totalScore / totalWeight : 0;
}

// ─── Synthetic News Event Generator ─────────────────────

function generateSyntheticNews(prices, eventsPerDay = 0.3) {
  const templates = {
    bullish: [
      "{symbol} shares surge on strong earnings beat",
      "Analysts upgrade {symbol} citing growth momentum",
      "{symbol} reports record revenue, stock rallies",
      "Institutional investors accumulate {symbol} positions",
      "{symbol} announces expansion into new markets",
      "Strong demand drives {symbol} to new highs",
    ],
    bearish: [
      "{symbol} shares plunge after earnings miss",
      "Analysts downgrade {symbol} on slowing growth",
      "{symbol} warns of headwinds, stock falls",
      "Investors sell {symbol} amid recession concerns",
      "{symbol} faces regulatory pressure, shares decline",
      "Weak demand causes {symbol} revenue to drop",
    ],
    neutral: [
      "{symbol} trading mixed ahead of earnings",
      "{symbol} stock stable despite market volatility",
      "Analysts maintain hold rating on {symbol}",
      "{symbol} reports in-line results",
    ],
  };

  const events = [];
  const symbol = "SPY";

  for (let i = 1; i < prices.length; i++) {
    const ret = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;

    // Generate events correlated with price moves (but noisy)
    if (Math.random() < eventsPerDay) {
      let category;
      if (ret > 0.01) category = "bullish";
      else if (ret < -0.01) category = "bearish";
      else category = Math.random() < 0.5 ? "neutral" : (ret > 0 ? "bullish" : "bearish");

      // Add some noise — sometimes news contradicts price
      if (Math.random() < 0.15) {
        category = category === "bullish" ? "bearish" : "bullish";
      }

      const pool = templates[category];
      const headline = pool[Math.floor(Math.random() * pool.length)].replace("{symbol}", symbol);

      events.push({
        date: prices[i].date,
        headline,
        category,
        priceReturn: ret,
      });
    }
  }

  return events;
}

// ─── Signal Generation ──────────────────────────────────

/**
 * Generate trading signals from sentiment data combined with price action.
 */
export function generateSentimentSignals(prices, events, options = {}) {
  const {
    sentimentWindow = 5,     // days of sentiment to aggregate
    priceConfirmation = true, // require price to confirm sentiment
    momentumWindow = 10,      // for price momentum
    entryThreshold = 0.3,     // sentiment threshold for entry
    decayFactor = 0.9,
  } = options;

  // Index events by date
  const eventsByDate = {};
  for (const e of events) {
    if (!eventsByDate[e.date]) eventsByDate[e.date] = [];
    eventsByDate[e.date].push(e.headline);
  }

  const signals = [];
  const sentimentHistory = [];

  for (let i = momentumWindow; i < prices.length; i++) {
    const date = prices[i].date;

    // Collect recent sentiment
    const recentTexts = [];
    for (let j = Math.max(0, i - sentimentWindow); j <= i; j++) {
      const dayEvents = eventsByDate[prices[j].date];
      if (dayEvents) recentTexts.push(...dayEvents);
    }

    const sentimentScore = recentTexts.length > 0 ? getSentimentScore(recentTexts, null, decayFactor) : 0;
    sentimentHistory.push(sentimentScore);

    // Sentiment momentum (rate of change)
    const sentimentMomentum = sentimentHistory.length >= 3
      ? sentimentHistory[sentimentHistory.length - 1] - sentimentHistory[sentimentHistory.length - 3]
      : 0;

    // Price momentum for confirmation
    const priceReturn = (prices[i].close - prices[i - momentumWindow].close) / prices[i - momentumWindow].close;

    let signal = 0;

    if (priceConfirmation) {
      // Require both sentiment and price to agree
      if (sentimentScore > entryThreshold && priceReturn > 0) signal = 1;
      if (sentimentScore < -entryThreshold && priceReturn < 0) signal = -1;
    } else {
      // Pure sentiment signal
      if (sentimentScore > entryThreshold) signal = 1;
      if (sentimentScore < -entryThreshold) signal = -1;
    }

    // Boost signal on sentiment momentum
    if (sentimentMomentum > 0.2 && signal === 1) signal = 1;
    if (sentimentMomentum < -0.2 && signal === -1) signal = -1;

    signals.push({
      date,
      signal,
      sentimentScore,
      sentimentMomentum,
      priceReturn,
      newsCount: recentTexts.length,
      price: prices[i].close,
    });
  }

  return signals;
}

// ─── Backtest Integration ───────────────────────────────

function backtestSentiment(signals, options = {}) {
  const { initialCapital = 1_000_000, positionSize = 0.10, costBps = 15 } = options;
  let capital = initialCapital;
  let position = 0;
  let prevSignal = 0;
  let trades = 0;
  let peak = capital;
  let maxDD = 0;
  const dailyReturns = [];
  let prevEquity = capital;

  for (const sig of signals) {
    if (sig.signal !== prevSignal) {
      if (position !== 0) {
        capital += position * sig.price;
        capital -= Math.abs(position * sig.price) * costBps / 10000;
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
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  if (position !== 0 && signals.length > 0) {
    capital += position * signals[signals.length - 1].price;
  }

  const n = dailyReturns.length;
  const mean = n > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / n : 0;
  const std = n > 1 ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : 0;

  return {
    total_return: (capital - initialCapital) / initialCapital,
    sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : 0,
    max_drawdown: maxDD,
    trades,
    days: n,
  };
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Sentiment Analysis Module ═══\n");

  // Test individual sentiment analysis
  const testHeadlines = [
    "Tech stocks surge on strong earnings beat expectations",
    "Market crashes amid recession concerns and panic selling",
    "Analysts upgrade Apple citing AI growth momentum",
    "Fed announces rate hike, markets show uncertainty",
    "Company reports stable revenue, maintains guidance",
  ];

  console.log("─── Headline Sentiment Analysis ───\n");
  for (const headline of testHeadlines) {
    const result = analyzeSentiment(headline);
    const bar = result.normalizedScore > 0
      ? "▓".repeat(Math.round(result.normalizedScore * 10))
      : "░".repeat(Math.round(-result.normalizedScore * 10));
    console.log(`  [${result.sentiment.padEnd(7)}] ${result.normalizedScore.toFixed(2)} ${bar}`);
    console.log(`    "${headline}"`);
    console.log(`    Keywords: ${result.keywords.map(k => k.keyword).join(", ")}\n`);
  }

  // Generate and backtest
  const prices = generateRealisticPrices("SPY", "2020-01-01", "2024-12-31");
  const events = generateSyntheticNews(prices, 0.4);
  console.log(`Generated ${events.length} synthetic news events over ${prices.length} days\n`);

  // With price confirmation
  console.log("─── Backtest: Sentiment + Price Confirmation ───");
  const signals1 = generateSentimentSignals(prices, events, { priceConfirmation: true });
  const result1 = backtestSentiment(signals1);
  console.log(`  Return: ${(result1.total_return * 100).toFixed(2)}%`);
  console.log(`  Sharpe: ${result1.sharpe.toFixed(3)}`);
  console.log(`  MaxDD:  ${(result1.max_drawdown * 100).toFixed(2)}%`);
  console.log(`  Trades: ${result1.trades}`);

  // Pure sentiment
  console.log("\n─── Backtest: Pure Sentiment (No Confirmation) ───");
  const signals2 = generateSentimentSignals(prices, events, { priceConfirmation: false });
  const result2 = backtestSentiment(signals2);
  console.log(`  Return: ${(result2.total_return * 100).toFixed(2)}%`);
  console.log(`  Sharpe: ${result2.sharpe.toFixed(3)}`);
  console.log(`  MaxDD:  ${(result2.max_drawdown * 100).toFixed(2)}%`);
  console.log(`  Trades: ${result2.trades}`);

  // Signal distribution
  const longDays = signals1.filter(s => s.signal === 1).length;
  const shortDays = signals1.filter(s => s.signal === -1).length;
  const flatDays = signals1.filter(s => s.signal === 0).length;
  console.log(`\n  Signal distribution: Long=${longDays} Short=${shortDays} Flat=${flatDays}`);
}

if (process.argv[1]?.includes("sentiment-analyzer")) {
  main().catch(console.error);
}
