#!/usr/bin/env node
/**
 * Data Quality & Integrity Checker
 *
 * Validates OHLCV market data for correctness and detects anomalies.
 *
 * Checks:
 *   1. Missing data (date gaps, missing OHLCV fields)
 *   2. Outlier detection (>5 sigma returns, price jumps)
 *   3. Stale data (repeated prices)
 *   4. OHLC consistency (High >= Open/Close/Low, Low <= Open/Close)
 *   5. Volume anomalies (zero volume, extreme spikes)
 *   6. Corporate action detection (splits, dividends)
 *   7. Data repair (interpolation, split adjustment)
 *
 * Usage:
 *   node agents/data/quality-checker.mjs              # Check SPY synthetic data
 *   node agents/data/quality-checker.mjs AAPL MSFT    # Check multiple symbols
 *
 * Exports: DataQualityChecker, checkQuality(), repairData(), detectSplits()
 */

import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Helpers ─────────────────────────────────────────────

/** Check if a date string falls on a US market holiday (approximate). */
function isLikelyHoliday(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const month = d.getUTCMonth(); // 0-indexed
  const day = d.getUTCDate();
  // New Year's Day
  if (month === 0 && day === 1) return true;
  // MLK Day (3rd Monday Jan) — approximate
  if (month === 0 && day >= 15 && day <= 21 && d.getUTCDay() === 1) return true;
  // Presidents' Day (3rd Monday Feb)
  if (month === 1 && day >= 15 && day <= 21 && d.getUTCDay() === 1) return true;
  // Good Friday — too complex, skip
  // Memorial Day (last Monday May)
  if (month === 4 && day >= 25 && d.getUTCDay() === 1) return true;
  // Juneteenth
  if (month === 5 && day === 19) return true;
  // Independence Day
  if (month === 6 && day === 4) return true;
  // Labor Day (1st Monday Sep)
  if (month === 8 && day <= 7 && d.getUTCDay() === 1) return true;
  // Thanksgiving (4th Thursday Nov)
  if (month === 10 && day >= 22 && day <= 28 && d.getUTCDay() === 4) return true;
  // Christmas
  if (month === 11 && day === 25) return true;
  return false;
}

/** Add business days to a date string, returns YYYY-MM-DD. */
function nextBusinessDay(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().split("T")[0];
}

/** Compute mean and standard deviation for an array. */
function meanStd(arr) {
  if (arr.length === 0) return { mean: 0, std: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return { mean, std: Math.sqrt(variance) };
}

// ─── Issue Types ─────────────────────────────────────────

const Severity = {
  CRITICAL: "CRITICAL",
  WARNING: "WARNING",
  INFO: "INFO",
};

function issue(type, severity, index, date, detail) {
  return { type, severity, index, date, detail };
}

// ─── DataQualityChecker ──────────────────────────────────

export class DataQualityChecker {
  /**
   * @param {Object} [options]
   * @param {number} [options.sigmaThreshold=5]     Outlier threshold in standard deviations.
   * @param {number} [options.staleRunLength=3]     Consecutive identical closes to flag as stale.
   * @param {number} [options.volumeSpikeMultiple=10] Volume spike detection multiplier vs 20-day avg.
   * @param {number} [options.maxGapDays=5]         Max missing business days before flagging gap.
   * @param {number} [options.splitThresholdPct=30] Overnight price change % to suspect a split.
   */
  constructor(options = {}) {
    this.sigmaThreshold = options.sigmaThreshold ?? 5;
    this.staleRunLength = options.staleRunLength ?? 3;
    this.volumeSpikeMultiple = options.volumeSpikeMultiple ?? 10;
    this.maxGapDays = options.maxGapDays ?? 5;
    this.splitThresholdPct = options.splitThresholdPct ?? 30;
  }

  // ── 1. Missing Data Detection ────────────────────────

  _checkMissingFields(prices) {
    const issues = [];
    const required = ["date", "open", "high", "low", "close", "volume"];
    for (let i = 0; i < prices.length; i++) {
      const bar = prices[i];
      for (const field of required) {
        if (bar[field] === undefined || bar[field] === null) {
          issues.push(issue("MISSING_FIELD", Severity.CRITICAL, i, bar.date ?? `index-${i}`,
            `Missing field: ${field}`));
        } else if (field !== "date" && (typeof bar[field] !== "number" || Number.isNaN(bar[field]))) {
          issues.push(issue("INVALID_VALUE", Severity.CRITICAL, i, bar.date ?? `index-${i}`,
            `Invalid ${field}: ${bar[field]}`));
        }
      }
    }
    return issues;
  }

  _checkDateGaps(prices) {
    const issues = [];
    for (let i = 1; i < prices.length; i++) {
      const prev = new Date(prices[i - 1].date + "T12:00:00Z");
      const curr = new Date(prices[i].date + "T12:00:00Z");
      const diffDays = Math.round((curr - prev) / (24 * 60 * 60 * 1000));

      // Count expected business days between them
      let businessDays = 0;
      const walker = new Date(prev);
      walker.setUTCDate(walker.getUTCDate() + 1);
      while (walker < curr) {
        if (walker.getUTCDay() !== 0 && walker.getUTCDay() !== 6) {
          const ds = walker.toISOString().split("T")[0];
          if (!isLikelyHoliday(ds)) {
            businessDays++;
          }
        }
        walker.setUTCDate(walker.getUTCDate() + 1);
      }

      if (businessDays > 0) {
        const sev = businessDays >= this.maxGapDays ? Severity.CRITICAL : Severity.WARNING;
        issues.push(issue("DATE_GAP", sev, i, prices[i].date,
          `Gap of ${businessDays} business day(s) after ${prices[i - 1].date} (${diffDays} calendar days)`));
      }
    }
    return issues;
  }

  // ── 2. Outlier Detection ─────────────────────────────

  _checkOutliers(prices) {
    const issues = [];
    if (prices.length < 20) return issues;

    // Compute daily log returns
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close > 0 && prices[i - 1].close > 0) {
        returns.push({
          index: i,
          date: prices[i].date,
          ret: Math.log(prices[i].close / prices[i - 1].close),
        });
      }
    }

    const { mean, std } = meanStd(returns.map(r => r.ret));
    if (std === 0) return issues;

    for (const r of returns) {
      const zScore = Math.abs((r.ret - mean) / std);
      if (zScore > this.sigmaThreshold) {
        const pctChange = ((Math.exp(r.ret) - 1) * 100).toFixed(2);
        issues.push(issue("OUTLIER_RETURN", Severity.WARNING, r.index, r.date,
          `Return ${pctChange}% (${zScore.toFixed(1)} sigma)`));
      }
    }

    // Price jump detection: gap open vs prior close
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1].close > 0) {
        const gapPct = Math.abs((prices[i].open - prices[i - 1].close) / prices[i - 1].close) * 100;
        if (gapPct > 5) {
          issues.push(issue("PRICE_JUMP", Severity.WARNING, i, prices[i].date,
            `Gap open: ${gapPct.toFixed(2)}% from prior close`));
        }
      }
    }

    return issues;
  }

  // ── 3. Stale Data Detection ──────────────────────────

  _checkStaleData(prices) {
    const issues = [];
    let runLength = 1;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close === prices[i - 1].close &&
          prices[i].open === prices[i - 1].open &&
          prices[i].high === prices[i - 1].high &&
          prices[i].low === prices[i - 1].low) {
        runLength++;
        if (runLength === this.staleRunLength) {
          issues.push(issue("STALE_DATA", Severity.WARNING, i, prices[i].date,
            `${runLength} consecutive identical OHLC bars ending here`));
        } else if (runLength > this.staleRunLength) {
          // Update the count on the last issue
          issues[issues.length - 1].detail = `${runLength} consecutive identical OHLC bars ending here`;
          issues[issues.length - 1].index = i;
          issues[issues.length - 1].date = prices[i].date;
        }
      } else {
        runLength = 1;
      }
    }
    return issues;
  }

  // ── 4. OHLC Consistency Checks ───────────────────────

  _checkOHLCConsistency(prices) {
    const issues = [];
    for (let i = 0; i < prices.length; i++) {
      const { date, open, high, low, close } = prices[i];
      if (typeof high !== "number" || typeof low !== "number" ||
          typeof open !== "number" || typeof close !== "number") continue;

      if (high < open) {
        issues.push(issue("OHLC_INVALID", Severity.CRITICAL, i, date,
          `High (${high}) < Open (${open})`));
      }
      if (high < close) {
        issues.push(issue("OHLC_INVALID", Severity.CRITICAL, i, date,
          `High (${high}) < Close (${close})`));
      }
      if (high < low) {
        issues.push(issue("OHLC_INVALID", Severity.CRITICAL, i, date,
          `High (${high}) < Low (${low})`));
      }
      if (low > open) {
        issues.push(issue("OHLC_INVALID", Severity.CRITICAL, i, date,
          `Low (${low}) > Open (${open})`));
      }
      if (low > close) {
        issues.push(issue("OHLC_INVALID", Severity.CRITICAL, i, date,
          `Low (${low}) > Close (${close})`));
      }
      if (open <= 0 || close <= 0 || high <= 0 || low <= 0) {
        issues.push(issue("NON_POSITIVE_PRICE", Severity.CRITICAL, i, date,
          `Non-positive price: O=${open} H=${high} L=${low} C=${close}`));
      }
    }
    return issues;
  }

  // ── 5. Volume Anomaly Detection ──────────────────────

  _checkVolumeAnomalies(prices) {
    const issues = [];

    for (let i = 0; i < prices.length; i++) {
      if (prices[i].volume === 0) {
        issues.push(issue("ZERO_VOLUME", Severity.WARNING, i, prices[i].date,
          "Zero volume"));
      }
      if (prices[i].volume < 0) {
        issues.push(issue("NEGATIVE_VOLUME", Severity.CRITICAL, i, prices[i].date,
          `Negative volume: ${prices[i].volume}`));
      }
    }

    // Volume spikes relative to 20-day rolling average
    if (prices.length >= 20) {
      for (let i = 20; i < prices.length; i++) {
        let sumVol = 0;
        for (let j = i - 20; j < i; j++) sumVol += prices[j].volume;
        const avgVol = sumVol / 20;
        if (avgVol > 0 && prices[i].volume > avgVol * this.volumeSpikeMultiple) {
          const multiple = (prices[i].volume / avgVol).toFixed(1);
          issues.push(issue("VOLUME_SPIKE", Severity.INFO, i, prices[i].date,
            `Volume ${prices[i].volume.toLocaleString()} is ${multiple}x the 20-day avg (${Math.round(avgVol).toLocaleString()})`));
        }
      }
    }

    return issues;
  }

  // ── 6. Corporate Action Detection ────────────────────

  _detectCorporateActions(prices) {
    const issues = [];
    if (prices.length < 2) return issues;

    for (let i = 1; i < prices.length; i++) {
      const prevClose = prices[i - 1].close;
      const currOpen = prices[i].open;
      if (prevClose <= 0) continue;

      const ratio = currOpen / prevClose;
      const pctChange = Math.abs(ratio - 1) * 100;

      if (pctChange >= this.splitThresholdPct) {
        // Try to identify the split ratio
        const commonRatios = [2, 3, 4, 5, 7, 8, 10, 20, 0.5, 1 / 3, 0.25, 0.1];
        let bestRatio = null;
        let bestErr = Infinity;
        for (const cr of commonRatios) {
          const err = Math.abs(ratio - cr);
          if (err < bestErr) {
            bestErr = err;
            bestRatio = cr;
          }
        }

        if (bestErr < 0.1) {
          const splitStr = bestRatio >= 1
            ? `${bestRatio}:1 split`
            : `1:${Math.round(1 / bestRatio)} reverse split`;
          issues.push(issue("LIKELY_SPLIT", Severity.INFO, i, prices[i].date,
            `Overnight move ${pctChange.toFixed(1)}% (ratio ${ratio.toFixed(3)}). Likely ${splitStr}`));
        } else {
          issues.push(issue("LARGE_OVERNIGHT_MOVE", Severity.WARNING, i, prices[i].date,
            `Overnight move ${pctChange.toFixed(1)}% (ratio ${ratio.toFixed(3)}). Possible corporate action.`));
        }
      }

      // Dividend detection: overnight drop in a narrow range typical of dividends
      // Only flag if the drop is between 1-4% AND volume increased (suggesting ex-div)
      if (ratio < 1 && pctChange >= 1.5 && pctChange < 4) {
        const impliedDiv = prevClose - currOpen;
        const divYield = (impliedDiv / prevClose) * 100;
        // Also check that high didn't recover — real ex-div days often stay below prior close
        const highBelowPrior = prices[i].high < prevClose;
        if (divYield > 1.0 && divYield < 4 && highBelowPrior) {
          issues.push(issue("POSSIBLE_DIVIDEND", Severity.INFO, i, prices[i].date,
            `Overnight drop of ${divYield.toFixed(2)}% ($${impliedDiv.toFixed(2)}). Possible ex-dividend.`));
        }
      }
    }

    return issues;
  }

  // ── Main Quality Check ───────────────────────────────

  /**
   * Run all quality checks on OHLCV data.
   *
   * @param {Array<{date:string, open:number, high:number, low:number, close:number, volume:number}>} prices
   * @returns {{ issues: Array, summary: Object, score: number }}
   */
  checkQuality(prices) {
    if (!Array.isArray(prices) || prices.length === 0) {
      return {
        issues: [issue("EMPTY_DATA", Severity.CRITICAL, -1, "N/A", "No price data provided")],
        summary: { total: 0, critical: 1, warning: 0, info: 0, bars: 0 },
        score: 0,
      };
    }

    const allIssues = [
      ...this._checkMissingFields(prices),
      ...this._checkDateGaps(prices),
      ...this._checkOutliers(prices),
      ...this._checkStaleData(prices),
      ...this._checkOHLCConsistency(prices),
      ...this._checkVolumeAnomalies(prices),
      ...this._detectCorporateActions(prices),
    ];

    const critical = allIssues.filter(i => i.severity === Severity.CRITICAL).length;
    const warning = allIssues.filter(i => i.severity === Severity.WARNING).length;
    const info = allIssues.filter(i => i.severity === Severity.INFO).length;

    // Score: 100 = perfect, deduct for issues
    const deductions = critical * 10 + warning * 2 + info * 0.5;
    const score = Math.max(0, Math.min(100, 100 - deductions));

    return {
      issues: allIssues,
      summary: {
        total: allIssues.length,
        critical,
        warning,
        info,
        bars: prices.length,
        dateRange: `${prices[0].date} to ${prices[prices.length - 1].date}`,
      },
      score: Math.round(score * 10) / 10,
    };
  }
}

// ─── Standalone Functions ────────────────────────────────

/**
 * Run quality checks on OHLCV data.
 * Convenience wrapper around DataQualityChecker.
 */
export function checkQuality(prices, options = {}) {
  const checker = new DataQualityChecker(options);
  return checker.checkQuality(prices);
}

/**
 * Detect stock splits from price data.
 * Returns array of { date, index, ratio, type }.
 */
export function detectSplits(prices, thresholdPct = 30) {
  const splits = [];
  if (!Array.isArray(prices) || prices.length < 2) return splits;

  for (let i = 1; i < prices.length; i++) {
    const prevClose = prices[i - 1].close;
    const currOpen = prices[i].open;
    if (!prevClose || prevClose <= 0) continue;

    const ratio = currOpen / prevClose;
    const pctChange = Math.abs(ratio - 1) * 100;
    if (pctChange < thresholdPct) continue;

    const commonRatios = [2, 3, 4, 5, 7, 8, 10, 20, 0.5, 1 / 3, 0.25, 0.1, 0.05];
    let bestRatio = ratio;
    let bestErr = Infinity;
    for (const cr of commonRatios) {
      const err = Math.abs(ratio - cr);
      if (err < bestErr) {
        bestErr = err;
        bestRatio = cr;
      }
    }

    if (bestErr < 0.15) {
      splits.push({
        date: prices[i].date,
        index: i,
        ratio: bestRatio,
        type: bestRatio >= 1 ? "forward" : "reverse",
        description: bestRatio >= 1
          ? `${bestRatio}:1 split`
          : `1:${Math.round(1 / bestRatio)} reverse split`,
      });
    }
  }

  return splits;
}

/**
 * Repair data: fill small gaps via interpolation, adjust for splits.
 *
 * @param {Array} prices - OHLCV array sorted by date ascending.
 * @param {Object} [options]
 * @param {number} [options.maxInterpolateGap=3] Max business days to interpolate.
 * @param {boolean} [options.adjustSplits=true] Retroactively adjust for detected splits.
 * @returns {{ repaired: Array, repairs: Array<string> }}
 */
export function repairData(prices, options = {}) {
  const maxInterpolateGap = options.maxInterpolateGap ?? 3;
  const adjustSplits = options.adjustSplits ?? true;
  const repairs = [];

  if (!Array.isArray(prices) || prices.length === 0) {
    return { repaired: [], repairs: ["No data to repair"] };
  }

  // Deep copy
  let repaired = prices.map(p => ({ ...p }));

  // ── Fix OHLC consistency ─────────────────────────────
  for (let i = 0; i < repaired.length; i++) {
    const bar = repaired[i];
    const origHigh = bar.high;
    const origLow = bar.low;

    // Ensure high is the max of OHLC
    const maxPrice = Math.max(bar.open, bar.high, bar.low, bar.close);
    const minPrice = Math.min(bar.open, bar.high, bar.low, bar.close);

    if (bar.high < maxPrice) {
      bar.high = maxPrice;
      repairs.push(`${bar.date}: Adjusted high ${origHigh} -> ${bar.high}`);
    }
    if (bar.low > minPrice) {
      bar.low = minPrice;
      repairs.push(`${bar.date}: Adjusted low ${origLow} -> ${bar.low}`);
    }
  }

  // ── Interpolate small gaps ───────────────────────────
  const filled = [];
  for (let i = 0; i < repaired.length; i++) {
    filled.push(repaired[i]);

    if (i < repaired.length - 1) {
      const curr = new Date(repaired[i].date + "T12:00:00Z");
      const next = new Date(repaired[i + 1].date + "T12:00:00Z");

      // Count business days in the gap
      const gapDates = [];
      const walker = new Date(curr);
      walker.setUTCDate(walker.getUTCDate() + 1);
      while (walker < next) {
        if (walker.getUTCDay() !== 0 && walker.getUTCDay() !== 6) {
          const ds = walker.toISOString().split("T")[0];
          if (!isLikelyHoliday(ds)) {
            gapDates.push(ds);
          }
        }
        walker.setUTCDate(walker.getUTCDate() + 1);
      }

      if (gapDates.length > 0 && gapDates.length <= maxInterpolateGap) {
        const startBar = repaired[i];
        const endBar = repaired[i + 1];
        const steps = gapDates.length + 1;

        for (let g = 0; g < gapDates.length; g++) {
          const t = (g + 1) / steps;
          const interpClose = +(startBar.close + t * (endBar.close - startBar.close)).toFixed(2);
          const interpOpen = +(startBar.open + t * (endBar.open - startBar.open)).toFixed(2);
          const interpHigh = +(Math.max(interpOpen, interpClose) * 1.002).toFixed(2);
          const interpLow = +(Math.min(interpOpen, interpClose) * 0.998).toFixed(2);
          const interpVol = Math.round(startBar.volume + t * (endBar.volume - startBar.volume));

          filled.push({
            date: gapDates[g],
            open: interpOpen,
            high: interpHigh,
            low: interpLow,
            close: interpClose,
            volume: interpVol,
            _interpolated: true,
          });
          repairs.push(`${gapDates[g]}: Interpolated missing bar`);
        }
      }
    }
  }

  // Re-sort after interpolation
  repaired = filled.sort((a, b) => a.date.localeCompare(b.date));

  // ── Split adjustment ─────────────────────────────────
  if (adjustSplits) {
    const splits = detectSplits(repaired);
    // Apply split adjustments retroactively (adjust all bars before each split)
    // Process splits from earliest to latest
    for (const split of splits) {
      const ratio = split.ratio;
      repairs.push(`${split.date}: Applying ${split.description} adjustment to prior bars`);
      for (let i = 0; i < split.index; i++) {
        repaired[i].open = +(repaired[i].open * ratio).toFixed(2);
        repaired[i].high = +(repaired[i].high * ratio).toFixed(2);
        repaired[i].low = +(repaired[i].low * ratio).toFixed(2);
        repaired[i].close = +(repaired[i].close * ratio).toFixed(2);
        repaired[i].volume = Math.round(repaired[i].volume / ratio);
        repaired[i]._splitAdjusted = true;
      }
    }
  }

  return { repaired, repairs };
}

// ─── CLI Demo ────────────────────────────────────────────

function printReport(symbol, result) {
  const { issues, summary, score } = result;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Data Quality Report: ${symbol}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Bars analyzed:  ${summary.bars}`);
  console.log(`  Date range:     ${summary.dateRange}`);
  console.log(`  Quality score:  ${score}/100`);
  console.log(`  Total issues:   ${summary.total} (${summary.critical} critical, ${summary.warning} warning, ${summary.info} info)`);

  if (issues.length === 0) {
    console.log("\n  No issues found. Data quality is excellent.");
    return;
  }

  // Group by type
  const byType = {};
  for (const iss of issues) {
    byType[iss.type] = byType[iss.type] || [];
    byType[iss.type].push(iss);
  }

  for (const [type, typeIssues] of Object.entries(byType)) {
    console.log(`\n  [${type}] (${typeIssues.length})`);
    const display = typeIssues.slice(0, 5);
    for (const iss of display) {
      const sevTag = iss.severity === "CRITICAL" ? "!!" : iss.severity === "WARNING" ? " !" : "  ";
      console.log(`    ${sevTag} ${iss.date}: ${iss.detail}`);
    }
    if (typeIssues.length > 5) {
      console.log(`    ... and ${typeIssues.length - 5} more`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const symbols = args.length > 0 ? args : ["SPY"];

  console.log("Data Quality & Integrity Checker");
  console.log("-".repeat(40));

  const checker = new DataQualityChecker();

  for (const symbol of symbols) {
    // Generate synthetic data
    const prices = generateRealisticPrices(symbol);

    // Inject some deliberate issues for demonstration
    const testPrices = [...prices.map(p => ({ ...p }))];

    // Inject an OHLC inconsistency
    if (testPrices.length > 50) {
      const idx = 50;
      testPrices[idx].high = testPrices[idx].low - 1;
    }

    // Inject stale data
    if (testPrices.length > 100) {
      for (let i = 101; i <= 103 && i < testPrices.length; i++) {
        testPrices[i].open = testPrices[100].open;
        testPrices[i].high = testPrices[100].high;
        testPrices[i].low = testPrices[100].low;
        testPrices[i].close = testPrices[100].close;
      }
    }

    // Inject a missing field
    if (testPrices.length > 200) {
      delete testPrices[200].volume;
    }

    // Inject a simulated 2:1 split
    if (testPrices.length > 300) {
      for (let i = 300; i < testPrices.length; i++) {
        testPrices[i].open = +(testPrices[i].open / 2).toFixed(2);
        testPrices[i].high = +(testPrices[i].high / 2).toFixed(2);
        testPrices[i].low = +(testPrices[i].low / 2).toFixed(2);
        testPrices[i].close = +(testPrices[i].close / 2).toFixed(2);
        testPrices[i].volume = testPrices[i].volume * 2;
      }
    }

    // Run quality check
    const result = checker.checkQuality(testPrices);
    printReport(symbol, result);

    // Detect splits
    const splits = detectSplits(testPrices);
    if (splits.length > 0) {
      console.log(`\n  Detected splits:`);
      for (const s of splits) {
        console.log(`    ${s.date}: ${s.description}`);
      }
    }

    // Repair data
    const { repaired, repairs } = repairData(testPrices);
    console.log(`\n  Data Repair:`);
    console.log(`    Bars before: ${testPrices.length}`);
    console.log(`    Bars after:  ${repaired.length}`);
    console.log(`    Repairs applied: ${repairs.length}`);
    const repairDisplay = repairs.slice(0, 8);
    for (const r of repairDisplay) {
      console.log(`      - ${r}`);
    }
    if (repairs.length > 8) {
      console.log(`      ... and ${repairs.length - 8} more`);
    }

    // Re-check after repair
    const afterResult = checker.checkQuality(repaired);
    console.log(`\n    Quality score after repair: ${afterResult.score}/100 (was ${result.score}/100)`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Done.");
}

if (process.argv[1]?.includes("quality-checker")) {
  main().catch(err => {
    console.error("Quality check failed:", err.message);
    process.exit(1);
  });
}
