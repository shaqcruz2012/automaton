#!/usr/bin/env node
/**
 * Portfolio Dashboard — Inferred Analysis
 *
 * Real-time ASCII dashboard combining all portfolio metrics:
 * 1. P&L summary (daily, MTD, YTD)
 * 2. Position overview with heat map
 * 3. Risk gauges (VaR, vol, drawdown)
 * 4. Strategy performance comparison
 * 5. Alert panel
 *
 * Usage:
 *   node agents/management/portfolio-dashboard.mjs
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

/**
 * Generate a gauge visualization.
 * @param {number} value - current value (0-1 range)
 * @param {number} width - gauge width in characters
 * @param {string} label - gauge label
 * @returns {string}
 */
export function gauge(value, width = 20, label = "") {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `${label ? label.padEnd(12) : ""}[${bar}] ${(clamped * 100).toFixed(0)}%`;
}

/**
 * Mini sparkline for a data series.
 */
export function sparkline(data, width = 20) {
  const blocks = "▁▂▃▄▅▆▇█";
  if (data.length === 0) return "";

  // Resample to width
  const resampled = [];
  for (let i = 0; i < width; i++) {
    const idx = Math.floor(i * data.length / width);
    resampled.push(data[idx]);
  }

  const min = Math.min(...resampled);
  const max = Math.max(...resampled);
  const range = max - min || 1;

  return resampled.map(v => {
    const idx = Math.floor(((v - min) / range) * 7);
    return blocks[Math.min(7, Math.max(0, idx))];
  }).join("");
}

/**
 * Format a number with color-neutral +/- prefix and padding.
 */
function fmtPnL(value, width = 10) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`.padStart(width);
}

/**
 * Generate portfolio dashboard.
 */
export class PortfolioDashboard {
  constructor(config = {}) {
    this.positions = config.positions || {};
    this.strategies = config.strategies || {};
    this.alerts = [];
    this.priceHistory = config.priceHistory || {};
  }

  addAlert(level, message) {
    this.alerts.push({ level, message, time: new Date().toISOString().split("T")[1].slice(0, 8) });
    if (this.alerts.length > 10) this.alerts.shift();
  }

  _computePortfolioStats() {
    const symbols = Object.keys(this.positions);
    const totalValue = symbols.reduce((s, sym) => s + (this.positions[sym].value || 0), 0);

    // Daily P&L from price history
    let dailyPnL = 0, weekPnL = 0, monthPnL = 0;
    for (const sym of symbols) {
      const hist = this.priceHistory[sym];
      if (!hist || hist.length < 2) continue;
      const weight = this.positions[sym].value / totalValue;
      const n = hist.length;
      const dayRet = (hist[n - 1].close - hist[n - 2].close) / hist[n - 2].close;
      dailyPnL += weight * dayRet;

      if (n >= 6) {
        weekPnL += weight * (hist[n - 1].close - hist[n - 6].close) / hist[n - 6].close;
      }
      if (n >= 22) {
        monthPnL += weight * (hist[n - 1].close - hist[n - 22].close) / hist[n - 22].close;
      }
    }

    // Portfolio volatility (21-day rolling)
    const portReturns = [];
    const minLen = Math.min(...symbols.map(s => (this.priceHistory[s] || []).length));
    for (let t = 1; t < minLen; t++) {
      let r = 0;
      for (const sym of symbols) {
        const w = this.positions[sym].value / totalValue;
        r += w * (this.priceHistory[sym][t].close - this.priceHistory[sym][t - 1].close) / this.priceHistory[sym][t - 1].close;
      }
      portReturns.push(r);
    }

    const recent = portReturns.slice(-63);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const vol = Math.sqrt(recent.reduce((s, r) => s + (r - mean) ** 2, 0) / (recent.length - 1)) * Math.sqrt(252);

    // Drawdown
    let equity = 1, peak = 1, maxDD = 0, currentDD = 0;
    for (const r of portReturns) {
      equity *= (1 + r);
      if (equity > peak) peak = equity;
      currentDD = (peak - equity) / peak;
      if (currentDD > maxDD) maxDD = currentDD;
    }

    // VaR
    const sorted = [...recent].sort((a, b) => a - b);
    const var95 = -sorted[Math.floor(sorted.length * 0.05)];

    return { totalValue, dailyPnL, weekPnL, monthPnL, vol, maxDD, currentDD, var95, portReturns };
  }

  render() {
    const stats = this._computePortfolioStats();
    const symbols = Object.keys(this.positions);
    const totalValue = stats.totalValue;
    const w = 60;

    let out = "";
    out += `╔${"═".repeat(w - 2)}╗\n`;
    out += `║  PORTFOLIO DASHBOARD  ${new Date().toISOString().split("T")[0]}${"".padEnd(w - 38)}║\n`;
    out += `╠${"═".repeat(w - 2)}╣\n`;

    // P&L Section
    out += `║  NAV: $${(totalValue / 1e6).toFixed(3)}M${"".padEnd(w - 22)}║\n`;
    out += `║  Daily P&L: ${fmtPnL(stats.dailyPnL * 100)}%  $${fmtPnL(stats.dailyPnL * totalValue)}${"".padEnd(w - 42)}║\n`;
    out += `║  Week  P&L: ${fmtPnL(stats.weekPnL * 100)}%  $${fmtPnL(stats.weekPnL * totalValue)}${"".padEnd(w - 42)}║\n`;
    out += `║  Month P&L: ${fmtPnL(stats.monthPnL * 100)}%  $${fmtPnL(stats.monthPnL * totalValue)}${"".padEnd(w - 42)}║\n`;
    out += `╠${"═".repeat(w - 2)}╣\n`;

    // Risk Gauges
    out += `║  RISK GAUGES${"".padEnd(w - 15)}║\n`;
    out += `║  ${gauge(stats.vol / 0.30, 20, "Volatility")}${"".padEnd(w - 43)}║\n`;
    out += `║  ${gauge(stats.currentDD / 0.20, 20, "Drawdown")}${"".padEnd(w - 43)}║\n`;
    out += `║  ${gauge(stats.var95 / 0.05, 20, "VaR Usage")}${"".padEnd(w - 43)}║\n`;
    out += `╠${"═".repeat(w - 2)}╣\n`;

    // Positions
    out += `║  POSITIONS${"".padEnd(w - 13)}║\n`;
    out += `║  ${"Sym".padEnd(6)} ${"Weight".padStart(7)} ${"Value".padStart(10)} ${"Day%".padStart(7)} ${"Spark".padStart(20)}  ║\n`;
    out += `║  ${"─".repeat(w - 5)}║\n`;

    for (const sym of symbols) {
      const weight = this.positions[sym].value / totalValue;
      const hist = this.priceHistory[sym];
      const dayRet = hist && hist.length >= 2
        ? (hist[hist.length - 1].close - hist[hist.length - 2].close) / hist[hist.length - 2].close
        : 0;
      const spark = hist ? sparkline(hist.slice(-30).map(p => p.close), 18) : "";
      out += `║  ${sym.padEnd(6)} ${(weight * 100).toFixed(1).padStart(6)}% $${(this.positions[sym].value / 1000).toFixed(0).padStart(7)}K ${(dayRet >= 0 ? "+" : "") + (dayRet * 100).toFixed(2).padStart(6)}% ${spark}  ║\n`;
    }

    // Alerts
    if (this.alerts.length > 0) {
      out += `╠${"═".repeat(w - 2)}╣\n`;
      out += `║  ALERTS${"".padEnd(w - 10)}║\n`;
      for (const alert of this.alerts.slice(-5)) {
        const icon = alert.level === "CRITICAL" ? "!!" : alert.level === "WARNING" ? " !" : " i";
        const msg = `${icon} ${alert.time} ${alert.message}`.slice(0, w - 5);
        out += `║  ${msg.padEnd(w - 4)}║\n`;
      }
    }

    out += `╚${"═".repeat(w - 2)}╝\n`;
    return out;
  }
}

// ─── CLI ────────────────────────────────────────────────

async function main() {
  console.log("═══ Portfolio Dashboard ═══\n");

  const symbols = ["SPY", "QQQ", "TLT", "GLD", "XLK"];
  const priceHistory = {};
  for (const sym of symbols) {
    priceHistory[sym] = generateRealisticPrices(sym, "2023-01-01", "2024-12-31");
  }

  const positions = {
    SPY: { value: 400_000 },
    QQQ: { value: 300_000 },
    TLT: { value: 150_000 },
    GLD: { value: 100_000 },
    XLK: { value: 50_000 },
  };

  const dashboard = new PortfolioDashboard({ positions, priceHistory });
  dashboard.addAlert("INFO", "Market open, all systems nominal");
  dashboard.addAlert("WARNING", "QQQ vol elevated (28.5% ann)");
  dashboard.addAlert("INFO", "Rebalance due in 3 days");
  console.log(dashboard.render());
}

if (process.argv[1]?.includes("portfolio-dashboard")) {
  main().catch(console.error);
}
