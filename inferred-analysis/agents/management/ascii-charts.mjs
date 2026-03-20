#!/usr/bin/env node
/**
 * ASCII Chart Visualization — Inferred Analysis
 *
 * Renders backtesting results as ASCII charts for terminal display.
 * Supports line charts, bar charts, candlesticks, equity curves,
 * histograms, sparklines, heatmaps, and formatted tables.
 *
 * Usage:
 *   node agents/management/ascii-charts.mjs
 *   import { lineChart, barChart, candlestickChart } from './ascii-charts.mjs'
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Constants ──────────────────────────────────────────

const SPARK_CHARS = "▁▂▃▄▅▆▇█";
const BAR_CHARS = { full: "█", three: "▓", half: "▒", light: "░" };
const BOX = {
  tl: "┌", tr: "┐", bl: "└", br: "┘",
  h: "─", v: "│", cross: "┼",
  lt: "├", rt: "┤", tb: "┬", bt: "┴",
};

// ─── Helpers ────────────────────────────────────────────

/**
 * Clamp a value between min and max.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Pad or truncate a string to a fixed width.
 * @param {string} s
 * @param {number} w
 * @param {"left"|"right"|"center"} align
 * @returns {string}
 */
function pad(s, w, align = "right") {
  s = String(s);
  if (s.length >= w) return s.slice(0, w);
  const gap = w - s.length;
  if (align === "left") return s + " ".repeat(gap);
  if (align === "center") {
    const l = Math.floor(gap / 2);
    return " ".repeat(l) + s + " ".repeat(gap - l);
  }
  return " ".repeat(gap) + s;
}

/**
 * Format a number for axis labels.
 * @param {number} v
 * @returns {string}
 */
function fmtNum(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "k";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

// ─── Line Chart ─────────────────────────────────────────

/**
 * Render an ASCII line chart.
 * @param {Array<{x: number, y: number}|number>} data - Data points
 * @param {Object} [options]
 * @param {number} [options.width=80] - Chart width in characters
 * @param {number} [options.height=20] - Chart height in rows
 * @param {string} [options.title] - Chart title
 * @param {string} [options.xLabel] - X-axis label
 * @param {string} [options.yLabel] - Y-axis label
 * @param {boolean} [options.showGrid=false] - Show grid lines
 * @returns {string} Multi-line ASCII chart
 */
export function lineChart(data, options = {}) {
  const { width = 80, height = 20, title, xLabel, yLabel, showGrid = false } = options;

  const points = data.map((d, i) =>
    typeof d === "number" ? { x: i, y: d } : d
  );
  if (points.length === 0) return "(no data)";

  const yMin = Math.min(...points.map((p) => p.y));
  const yMax = Math.max(...points.map((p) => p.y));
  const yRange = yMax - yMin || 1;

  const labelW = 8;
  const plotW = width - labelW - 2;
  const plotH = height - 2;

  // Build empty grid
  const grid = Array.from({ length: plotH }, () => Array(plotW).fill(" "));

  // Plot points
  for (let i = 0; i < points.length; i++) {
    const col = Math.round((i / Math.max(points.length - 1, 1)) * (plotW - 1));
    const row = plotH - 1 - Math.round(((points[i].y - yMin) / yRange) * (plotH - 1));
    const r = clamp(row, 0, plotH - 1);
    const c = clamp(col, 0, plotW - 1);
    grid[r][c] = "●";

    // Connect to previous point
    if (i > 0) {
      const prevCol = Math.round(((i - 1) / Math.max(points.length - 1, 1)) * (plotW - 1));
      const prevRow = plotH - 1 - Math.round(((points[i - 1].y - yMin) / yRange) * (plotH - 1));
      const pr = clamp(prevRow, 0, plotH - 1);
      const pc = clamp(prevCol, 0, plotW - 1);
      // Horizontal connection
      const minC = Math.min(pc, c);
      const maxC = Math.max(pc, c);
      for (let cc = minC + 1; cc < maxC; cc++) {
        const frac = (cc - pc) / (c - pc || 1);
        const interp = pr + frac * (r - pr);
        const ir = clamp(Math.round(interp), 0, plotH - 1);
        if (grid[ir][cc] === " ") grid[ir][cc] = "─";
      }
    }
  }

  // Apply grid
  if (showGrid) {
    for (let r = 0; r < plotH; r++) {
      for (let c = 0; c < plotW; c++) {
        if (grid[r][c] === " " && (r % 4 === 0 || c % 10 === 0)) {
          grid[r][c] = r % 4 === 0 && c % 10 === 0 ? "┼" : r % 4 === 0 ? "╌" : "╎";
        }
      }
    }
  }

  // Assemble output
  const lines = [];
  if (title) lines.push(pad(title, width, "center"));

  for (let r = 0; r < plotH; r++) {
    const yVal = yMax - (r / (plotH - 1)) * yRange;
    const label = r === 0 || r === plotH - 1 || r % 4 === 0
      ? pad(fmtNum(yVal), labelW - 1)
      : " ".repeat(labelW - 1);
    lines.push(label + BOX.v + grid[r].join(""));
  }

  // X axis
  lines.push(" ".repeat(labelW - 1) + BOX.bl + BOX.h.repeat(plotW));

  // X labels
  const xStart = fmtNum(points[0].x);
  const xEnd = fmtNum(points[points.length - 1].x);
  lines.push(" ".repeat(labelW) + xStart + " ".repeat(Math.max(0, plotW - xStart.length - xEnd.length)) + xEnd);

  if (xLabel) lines.push(pad(xLabel, width, "center"));
  if (yLabel) lines[0] = yLabel + "  " + (lines[0] || "");

  return lines.join("\n");
}

// ─── Bar Chart ──────────────────────────────────────────

/**
 * Render a horizontal ASCII bar chart.
 * @param {Array<{label: string, value: number}>} data
 * @param {Object} [options]
 * @param {number} [options.width=60] - Max bar width
 * @param {string} [options.title] - Chart title
 * @returns {string}
 */
export function barChart(data, options = {}) {
  const { width = 60, title } = options;
  if (data.length === 0) return "(no data)";

  const maxLabel = Math.max(...data.map((d) => d.label.length));
  const maxVal = Math.max(...data.map((d) => Math.abs(d.value)));
  const barW = width - maxLabel - 12;

  const lines = [];
  if (title) lines.push(title, "");

  for (const { label, value } of data) {
    const len = Math.round((Math.abs(value) / (maxVal || 1)) * barW);
    const full = Math.floor(len);
    const frac = len - full;
    let bar = BAR_CHARS.full.repeat(full);
    if (frac > 0.75) bar += BAR_CHARS.three;
    else if (frac > 0.5) bar += BAR_CHARS.half;
    else if (frac > 0.25) bar += BAR_CHARS.light;

    const sign = value < 0 ? "-" : " ";
    lines.push(
      pad(label, maxLabel, "left") + " " + BOX.v + sign + bar + " " + fmtNum(value)
    );
  }

  return lines.join("\n");
}

// ─── Candlestick Chart ──────────────────────────────────

/**
 * Render an ASCII candlestick chart.
 * @param {Array<{date: string, open: number, high: number, low: number, close: number}>} ohlcData
 * @param {Object} [options]
 * @param {number} [options.width=80]
 * @param {number} [options.height=24]
 * @param {string} [options.title]
 * @returns {string}
 */
export function candlestickChart(ohlcData, options = {}) {
  const { width = 80, height = 24, title } = options;
  if (ohlcData.length === 0) return "(no data)";

  const labelW = 9;
  const plotW = width - labelW - 1;
  const plotH = height - 3;

  // Fit data to plot width — sample if too many candles
  const step = Math.max(1, Math.ceil(ohlcData.length / plotW));
  const candles = [];
  for (let i = 0; i < ohlcData.length; i += step) {
    candles.push(ohlcData[i]);
  }

  const allPrices = candles.flatMap((c) => [c.high, c.low]);
  const pMin = Math.min(...allPrices);
  const pMax = Math.max(...allPrices);
  const pRange = pMax - pMin || 1;

  const toRow = (p) => clamp(plotH - 1 - Math.round(((p - pMin) / pRange) * (plotH - 1)), 0, plotH - 1);

  // Build grid
  const grid = Array.from({ length: plotH }, () => Array(plotW).fill(" "));

  for (let i = 0; i < candles.length && i < plotW; i++) {
    const { open, high, low, close } = candles[i];
    const up = close >= open;
    const bodyChar = up ? "▓" : "░";
    const wickChar = "│";

    const rHigh = toRow(high);
    const rLow = toRow(low);
    const rOpen = toRow(open);
    const rClose = toRow(close);
    const bodyTop = Math.min(rOpen, rClose);
    const bodyBot = Math.max(rOpen, rClose);

    // Wicks
    for (let r = rHigh; r <= rLow; r++) {
      if (r < bodyTop || r > bodyBot) {
        grid[r][i] = wickChar;
      } else {
        grid[r][i] = bodyChar;
      }
    }
    // Ensure at least one body char for doji
    if (bodyTop === bodyBot) grid[bodyTop][i] = bodyChar;
  }

  const lines = [];
  if (title) lines.push(pad(title, width, "center"));

  for (let r = 0; r < plotH; r++) {
    const price = pMax - (r / (plotH - 1)) * pRange;
    const label = r % 4 === 0 || r === plotH - 1
      ? pad(fmtNum(price), labelW - 1)
      : " ".repeat(labelW - 1);
    lines.push(label + BOX.v + grid[r].join(""));
  }

  lines.push(" ".repeat(labelW - 1) + BOX.bl + BOX.h.repeat(plotW));

  // Date labels
  if (candles.length > 0) {
    const first = candles[0].date?.slice(5, 10) || "start";
    const last = candles[candles.length - 1].date?.slice(5, 10) || "end";
    lines.push(" ".repeat(labelW) + first + " ".repeat(Math.max(0, plotW - first.length - last.length)) + last);
  }

  return lines.join("\n");
}

// ─── Equity Curve ───────────────────────────────────────

/**
 * Render a specialized equity curve with drawdown shading and peak markers.
 * @param {number[]} returns - Array of period returns (e.g., daily)
 * @param {Object} [options]
 * @param {number} [options.width=80]
 * @param {number} [options.height=20]
 * @param {string} [options.title="Equity Curve"]
 * @param {number} [options.initial=10000] - Starting capital
 * @returns {string}
 */
export function equityCurve(returns, options = {}) {
  const { width = 80, height = 20, title = "Equity Curve", initial = 10000 } = options;

  // Build equity series
  const equity = [initial];
  for (const r of returns) {
    equity.push(equity[equity.length - 1] * (1 + r));
  }

  // Track peaks and drawdowns
  let peak = equity[0];
  const peaks = [];
  const drawdowns = [];
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) {
      peak = equity[i];
      peaks.push(i);
    }
    drawdowns.push((equity[i] - peak) / peak);
  }

  const labelW = 9;
  const plotW = width - labelW - 1;
  const plotH = height - 3;
  const eMin = Math.min(...equity);
  const eMax = Math.max(...equity);
  const eRange = eMax - eMin || 1;

  const toRow = (v) => clamp(plotH - 1 - Math.round(((v - eMin) / eRange) * (plotH - 1)), 0, plotH - 1);
  const toCol = (i) => clamp(Math.round((i / Math.max(equity.length - 1, 1)) * (plotW - 1)), 0, plotW - 1);

  const grid = Array.from({ length: plotH }, () => Array(plotW).fill(" "));

  // Drawdown shading
  for (let i = 0; i < equity.length; i++) {
    const col = toCol(i);
    if (drawdowns[i] < -0.05) {
      const eqRow = toRow(equity[i]);
      // Shade from equity line to peak level
      const peakRow = toRow(peak);
      for (let r = Math.min(eqRow, peakRow); r <= Math.max(eqRow, peakRow); r++) {
        if (grid[r][col] === " ") grid[r][col] = "░";
      }
    }
  }

  // Plot equity line
  for (let i = 0; i < equity.length; i++) {
    const col = toCol(i);
    const row = toRow(equity[i]);
    grid[row][col] = peaks.includes(i) ? "▲" : "●";
  }

  const lines = [];
  if (title) lines.push(pad(title, width, "center"));

  for (let r = 0; r < plotH; r++) {
    const val = eMax - (r / (plotH - 1)) * eRange;
    const label = r % 4 === 0 || r === plotH - 1
      ? pad(fmtNum(val), labelW - 1)
      : " ".repeat(labelW - 1);
    lines.push(label + BOX.v + grid[r].join(""));
  }

  lines.push(" ".repeat(labelW - 1) + BOX.bl + BOX.h.repeat(plotW));

  // Summary stats
  const finalEq = equity[equity.length - 1];
  const totalRet = ((finalEq - initial) / initial * 100).toFixed(1);
  const maxDD = (Math.min(...drawdowns) * 100).toFixed(1);
  lines.push(`  Total: ${totalRet}%  |  Max DD: ${maxDD}%  |  Final: $${fmtNum(finalEq)}`);

  return lines.join("\n");
}

// ─── Histogram ──────────────────────────────────────────

/**
 * Render an ASCII histogram (frequency distribution).
 * @param {number[]} values
 * @param {number} [bins=20]
 * @param {Object} [options]
 * @param {number} [options.width=60]
 * @param {string} [options.title]
 * @returns {string}
 */
export function histogram(values, bins = 20, options = {}) {
  const { width = 60, title } = options;
  if (values.length === 0) return "(no data)";

  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const step = (vMax - vMin) / bins || 1;

  const counts = Array(bins).fill(0);
  for (const v of values) {
    const idx = clamp(Math.floor((v - vMin) / step), 0, bins - 1);
    counts[idx]++;
  }

  const maxCount = Math.max(...counts);
  const labelW = 12;
  const barW = width - labelW - 4;

  const lines = [];
  if (title) lines.push(title, "");

  for (let i = 0; i < bins; i++) {
    const lo = vMin + i * step;
    const hi = lo + step;
    const label = `${fmtNum(lo)}–${fmtNum(hi)}`;
    const len = Math.round((counts[i] / (maxCount || 1)) * barW);
    const bar = BAR_CHARS.full.repeat(len);
    lines.push(pad(label, labelW, "left") + BOX.v + bar + " " + counts[i]);
  }

  return lines.join("\n");
}

// ─── Sparkline ──────────────────────────────────────────

/**
 * Render a single-line sparkline using block characters.
 * @param {number[]} values
 * @returns {string}
 */
export function sparkline(values) {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[clamp(idx, 0, SPARK_CHARS.length - 1)];
    })
    .join("");
}

// ─── Heatmap ────────────────────────────────────────────

/**
 * Render an ASCII heatmap (e.g., correlation matrix).
 * @param {number[][]} matrix - 2D array of values
 * @param {string[]} [rowLabels]
 * @param {string[]} [colLabels]
 * @returns {string}
 */
export function heatmap(matrix, rowLabels = [], colLabels = []) {
  if (matrix.length === 0) return "(no data)";

  const shades = [" ", "░", "▒", "▓", "█"];
  const allVals = matrix.flat();
  const vMin = Math.min(...allVals);
  const vMax = Math.max(...allVals);
  const vRange = vMax - vMin || 1;

  const cellW = 6;
  const labelW = Math.max(6, ...rowLabels.map((l) => l.length)) + 1;
  const cols = matrix[0]?.length || 0;

  const lines = [];

  // Column headers
  if (colLabels.length > 0) {
    lines.push(
      " ".repeat(labelW) +
      colLabels.map((l) => pad(l.slice(0, cellW), cellW, "center")).join("")
    );
  }

  // Top border
  lines.push(" ".repeat(labelW) + BOX.tl + (BOX.h.repeat(cellW) + BOX.tb).repeat(cols - 1) + BOX.h.repeat(cellW) + BOX.tr);

  for (let r = 0; r < matrix.length; r++) {
    const label = rowLabels[r] ? pad(rowLabels[r], labelW, "left") : " ".repeat(labelW);
    let row = label + BOX.v;
    for (let c = 0; c < cols; c++) {
      const v = matrix[r][c];
      const norm = (v - vMin) / vRange;
      const si = clamp(Math.round(norm * (shades.length - 1)), 0, shades.length - 1);
      const cell = shades[si].repeat(2) + fmtNum(v).slice(0, cellW - 2);
      row += pad(cell, cellW, "center") + BOX.v;
    }
    lines.push(row);
  }

  // Bottom border
  lines.push(" ".repeat(labelW) + BOX.bl + (BOX.h.repeat(cellW) + BOX.bt).repeat(cols - 1) + BOX.h.repeat(cellW) + BOX.br);

  return lines.join("\n");
}

// ─── Table ──────────────────────────────────────────────

/**
 * Render a formatted ASCII table with box-drawing borders.
 * @param {Array<Array<string|number>>} rows
 * @param {string[]} headers
 * @param {Object} [options]
 * @param {string} [options.title]
 * @param {Array<"left"|"right"|"center">} [options.align]
 * @returns {string}
 */
export function table(rows, headers, options = {}) {
  const { title, align = [] } = options;
  const allRows = [headers, ...rows];
  const colCount = headers.length;

  // Compute column widths
  const widths = Array(colCount).fill(0);
  for (const row of allRows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], String(row[c] ?? "").length);
    }
  }

  const formatRow = (row, sep = BOX.v) => {
    const cells = row.map((cell, c) => {
      const a = align[c] || (typeof cell === "number" ? "right" : "left");
      return " " + pad(String(cell ?? ""), widths[c], a) + " ";
    });
    return sep + cells.join(sep) + sep;
  };

  const border = (l, m, r) =>
    l + widths.map((w) => BOX.h.repeat(w + 2)).join(m) + r;

  const lines = [];
  if (title) lines.push(title);
  lines.push(border(BOX.tl, BOX.tb, BOX.tr));
  lines.push(formatRow(headers));
  lines.push(border(BOX.lt, BOX.cross, BOX.rt));
  for (const row of rows) {
    lines.push(formatRow(row));
  }
  lines.push(border(BOX.bl, BOX.bt, BOX.br));

  return lines.join("\n");
}

// ─── CLI Demo ───────────────────────────────────────────

/**
 * Demonstrate all chart types with sample financial data.
 */
async function main() {
  console.log("═".repeat(80));
  console.log(pad("ASCII Charts — Backtesting Visualization Demo", 80, "center"));
  console.log("═".repeat(80));

  // Generate sample data
  const prices = generateRealisticPrices("SPY", "2023-01-01", "2024-01-01");
  const closes = prices.map((p) => p.close);
  const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);

  // 1. Line chart
  console.log("\n" + "─".repeat(80));
  console.log(lineChart(closes.slice(0, 60), {
    width: 80,
    height: 18,
    title: "SPY Close Prices",
    xLabel: "Trading Day",
    showGrid: true,
  }));

  // 2. Bar chart — monthly returns
  const monthlyReturns = [];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let m = 0; m < 12 && m * 21 < returns.length; m++) {
    const slice = returns.slice(m * 21, (m + 1) * 21);
    const cumRet = slice.reduce((a, r) => a * (1 + r), 1) - 1;
    monthlyReturns.push({ label: months[m], value: +(cumRet * 100).toFixed(2) });
  }
  console.log("\n" + "─".repeat(80));
  console.log(barChart(monthlyReturns, { width: 60, title: "Monthly Returns (%)" }));

  // 3. Candlestick chart
  console.log("\n" + "─".repeat(80));
  console.log(candlestickChart(prices.slice(0, 60), {
    width: 80,
    height: 22,
    title: "SPY OHLC — 60 Trading Days",
  }));

  // 4. Equity curve
  console.log("\n" + "─".repeat(80));
  console.log(equityCurve(returns, {
    width: 80,
    height: 18,
    title: "Strategy Equity Curve",
    initial: 100000,
  }));

  // 5. Histogram of returns
  console.log("\n" + "─".repeat(80));
  console.log(histogram(returns.map((r) => r * 100), 15, {
    width: 60,
    title: "Return Distribution (%)",
  }));

  // 6. Sparkline
  console.log("\n" + "─".repeat(80));
  console.log("Sparkline (last 50 closes):");
  console.log("  " + sparkline(closes.slice(-50)));

  // 7. Heatmap — correlation matrix
  const assets = ["SPY", "QQQ", "IWM", "TLT"];
  const assetReturns = assets.map((sym) => {
    const p = generateRealisticPrices(sym, "2023-01-01", "2024-01-01");
    const c = p.map((d) => d.close);
    return c.slice(1).map((v, i) => (v - c[i]) / c[i]);
  });

  const minLen = Math.min(...assetReturns.map((r) => r.length));
  const corrMatrix = assets.map((_, i) =>
    assets.map((_, j) => {
      const a = assetReturns[i].slice(0, minLen);
      const b = assetReturns[j].slice(0, minLen);
      const meanA = a.reduce((s, v) => s + v, 0) / a.length;
      const meanB = b.reduce((s, v) => s + v, 0) / b.length;
      const cov = a.reduce((s, v, k) => s + (v - meanA) * (b[k] - meanB), 0) / a.length;
      const stdA = Math.sqrt(a.reduce((s, v) => s + (v - meanA) ** 2, 0) / a.length);
      const stdB = Math.sqrt(b.reduce((s, v) => s + (v - meanB) ** 2, 0) / b.length);
      return +((cov / (stdA * stdB || 1))).toFixed(2);
    })
  );

  console.log("\n" + "─".repeat(80));
  console.log("Correlation Heatmap:");
  console.log(heatmap(corrMatrix, assets, assets));

  // 8. Table — strategy summary
  console.log("\n" + "─".repeat(80));
  const totalRet = ((closes[closes.length - 1] - closes[0]) / closes[0] * 100).toFixed(1);
  const sharpe = (returns.reduce((s, r) => s + r, 0) / returns.length /
    (Math.sqrt(returns.reduce((s, r) => s + r ** 2, 0) / returns.length -
    (returns.reduce((s, r) => s + r, 0) / returns.length) ** 2) || 1) *
    Math.sqrt(252)).toFixed(2);
  const maxDD = (() => {
    let peak = closes[0], dd = 0;
    for (const c of closes) {
      if (c > peak) peak = c;
      dd = Math.min(dd, (c - peak) / peak);
    }
    return (dd * 100).toFixed(1);
  })();

  console.log(table(
    [
      ["SPY Momentum", totalRet + "%", sharpe, maxDD + "%", returns.length, "B+"],
      ["QQQ Mean Rev.", "12.4%", "1.45", "-8.2%", 189, "A-"],
      ["IWM Breakout", "6.1%", "0.82", "-14.5%", 134, "C+"],
    ],
    ["Strategy", "Return", "Sharpe", "Max DD", "Trades", "Grade"],
    { title: "Strategy Performance Summary", align: ["left", "right", "right", "right", "right", "center"] }
  ));

  console.log("\n" + "═".repeat(80));
}

// ─── Entry Point ────────────────────────────────────────

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("ascii-charts.mjs") ||
   process.argv[1].endsWith("ascii-charts"));

if (isMain) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
