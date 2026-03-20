#!/usr/bin/env node
/**
 * Bayesian Risk Model — conjugate Normal-Inverse-Gamma framework for
 * portfolio risk in a quant fund context. Regime detection, stress testing,
 * marginal contributions, and Bayesian Sharpe estimation.
 *
 * Usage:  node agents/risk/bayesian-risk.mjs [--assets=SPY,QQQ,AAPL,MSFT,GLD,TLT]
 */
import { generateRealisticPrices } from "../data/fetch.mjs";

// ─── Math Helpers ────────────────────────────────────────
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function variance(a) { if (a.length < 2) return 0; const m = mean(a); return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1); }
function stdev(a) { return Math.sqrt(variance(a)); }
function covariance(a, b) {
  const n = Math.min(a.length, b.length); if (n < 2) return 0;
  const ma = mean(a), mb = mean(b);
  let c = 0; for (let i = 0; i < n; i++) c += (a[i] - ma) * (b[i] - mb);
  return c / (n - 1);
}
function priceReturns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++) r.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
  return r;
}

// ─── Normal-Inverse-Gamma Conjugate Update ───────────────
/**
 * Conjugate NIG update.  Prior: mu|s2 ~ N(priorMu, s2/kappa), s2 ~ IG(alpha, beta).
 * Returns posterior hyper-parameters plus summary statistics.
 */
export function normalInverseGammaUpdate(priorMu, priorKappa, priorAlpha, priorBeta, data) {
  const n = data.length;
  if (n === 0) return {
    mu: priorMu, kappa: priorKappa, alpha: priorAlpha, beta: priorBeta,
    posteriorMean: priorMu, posteriorVariance: priorBeta / (priorAlpha - 1) / priorKappa,
  };
  const xbar = mean(data);
  const s2 = data.reduce((s, v) => s + (v - xbar) ** 2, 0);
  const kN = priorKappa + n;
  const muN = (priorKappa * priorMu + n * xbar) / kN;
  const aN = priorAlpha + n / 2;
  const bN = priorBeta + 0.5 * s2 + (priorKappa * n * (xbar - priorMu) ** 2) / (2 * kN);
  return {
    mu: muN, kappa: kN, alpha: aN, beta: bN,
    posteriorMean: muN, posteriorVariance: aN > 1 ? bN / ((aN - 1) * kN) : bN / kN,
  };
}

// ─── Bayesian Sharpe Ratio ───────────────────────────────
/** Bayesian Sharpe: blends sample SR with a prior, returns credible interval. */
export function bayesianSharpe(returns, priorSharpe = 0.4, priorWeight = 0.3) {
  const n = returns.length;
  if (n < 5) return { sharpe: priorSharpe, credibleInterval: [priorSharpe, priorSharpe], effectiveSamples: 0 };
  const mu = mean(returns), sd = stdev(returns);
  if (sd < 1e-12) return { sharpe: priorSharpe, credibleInterval: [priorSharpe, priorSharpe], effectiveSamples: n };
  const sampleSR = (mu / sd) * Math.sqrt(252);
  const blended = priorWeight * priorSharpe + (1 - priorWeight) * sampleSR;
  const se = Math.sqrt((1 + 0.5 * sampleSR ** 2 / 252) / n) * Math.sqrt(252);
  return { sharpe: blended, credibleInterval: [blended - 1.96 * se, blended + 1.96 * se], effectiveSamples: n };
}

// ─── Bayesian Risk Model ─────────────────────────────────
export class BayesianRiskModel {
  constructor(assetReturns, factorReturns = {}) {
    this.assetReturns = assetReturns;
    this.factorReturns = factorReturns;
    this.assets = Object.keys(assetReturns);
    this.factors = Object.keys(factorReturns);
    this.posteriors = {};
    this.covMatrix = [];
    this.regimeState = { bull: 0.5, bear: 0.35, crisis: 0.15 };
    this.observationCount = 0;
  }

  /** Estimate NIG priors from a lookback window (0 = all data). */
  fitPriors(lookback = 0) {
    for (const sym of this.assets) {
      const data = lookback > 0 ? this.assetReturns[sym].slice(-lookback) : this.assetReturns[sym];
      const n = data.length, m = mean(data), v = variance(data);
      this.posteriors[sym] = {
        mu: m, kappa: Math.max(2, n * 0.05),
        alpha: Math.max(2, n * 0.025), beta: Math.max(1e-8, v * n * 0.025),
      };
    }
    this._updateCov(); this._updateRegime();
    this.observationCount = lookback || (this.assets.length ? this.assetReturns[this.assets[0]].length : 0);
  }

  /** Bayesian update with conjugate priors (NIG) for a new observation. */
  updateBeliefs(newObservation) {
    for (const sym of this.assets) {
      if (!(sym in newObservation)) continue;
      const p = this.posteriors[sym]; if (!p) continue;
      const u = normalInverseGammaUpdate(p.mu, p.kappa, p.alpha, p.beta, [newObservation[sym]]);
      this.posteriors[sym] = { mu: u.mu, kappa: u.kappa, alpha: u.alpha, beta: u.beta };
      this.assetReturns[sym].push(newObservation[sym]);
    }
    this.observationCount++;
    this._updateCov(); this._updateRegime();
  }

  /** Posterior predictive (Student-t) for next-period returns. */
  predictiveDistribution() {
    const result = {};
    for (const sym of this.assets) {
      const p = this.posteriors[sym]; if (!p) continue;
      const df = 2 * p.alpha, predMean = p.mu;
      const predScale = Math.sqrt(p.beta * (p.kappa + 1) / (p.alpha * p.kappa));
      const tq95 = this._tQuantile(0.05, df), tq99 = this._tQuantile(0.01, df);
      result[sym] = { mean: predMean, scale: predScale, df,
        var95: -(predMean + tq95 * predScale), var99: -(predMean + tq99 * predScale) };
    }
    return result;
  }

  /** Conditional distribution given factor shocks, propagated via OLS betas. */
  stressScenario(factorShocks) {
    const betas = this._factorBetas(), result = {};
    for (const sym of this.assets) {
      const p = this.posteriors[sym]; if (!p) continue;
      let impact = 0;
      for (const [f, shock] of Object.entries(factorShocks))
        impact += ((betas[sym] && betas[sym][f]) || 0) * shock;
      const cMean = p.mu + impact;
      const baseVol = Math.sqrt(p.beta / Math.max(1, p.alpha - 1));
      const cVol = baseVol * (1 + 0.5 * Math.min(3, Math.abs(impact) / (baseVol || 1e-6)));
      result[sym] = { conditionalMean: cMean, conditionalVol: cVol,
        loss: Math.min(0, cMean) - 1.65 * cVol };
    }
    return result;
  }

  /** Posterior probability of bull/bear/crisis regimes. */
  regimeProbabilities() { return { ...this.regimeState }; }

  _updateRegime() {
    const recent = [];
    for (const sym of this.assets) {
      const r = this.assetReturns[sym];
      if (r.length >= 20) recent.push(...r.slice(-20));
    }
    if (recent.length < 5) return;
    const regimes = { bull: { mu: 0.0005, sigma: 0.010 }, bear: { mu: -0.0003, sigma: 0.018 }, crisis: { mu: -0.0015, sigma: 0.035 } };
    const prior = { bull: 0.50, bear: 0.35, crisis: 0.15 };
    const ll = {}; let maxLL = -Infinity;
    for (const [reg, par] of Object.entries(regimes)) {
      let l = Math.log(prior[reg]);
      for (const r of recent) { const z = (r - par.mu) / par.sigma; l += -0.5 * z * z - Math.log(par.sigma); }
      ll[reg] = l; if (l > maxLL) maxLL = l;
    }
    let tot = 0;
    for (const k of Object.keys(regimes)) { ll[k] = Math.exp(ll[k] - maxLL); tot += ll[k]; }
    for (const k of Object.keys(regimes)) this.regimeState[k] = ll[k] / tot;
  }

  /** Each asset's marginal contribution to portfolio risk (equal-weight). */
  getMarginalContributions() {
    const n = this.assets.length; if (n === 0) return {};
    const w = this.assets.map(() => 1 / n), cov = this.covMatrix;
    let pVar = 0; const cW = new Array(n).fill(0);
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) cW[i] += cov[i][j] * w[j]; pVar += w[i] * cW[i]; }
    const pVol = Math.sqrt(Math.max(0, pVar)), result = {};
    for (let i = 0; i < n; i++) {
      result[this.assets[i]] = {
        marginalVar: pVol > 0 ? cW[i] / pVol : 0,
        pctContribution: pVar > 0 ? (w[i] * cW[i]) / pVar : 1 / n,
        beta: pVar > 0 ? cW[i] / pVar : 1,
      };
    }
    return result;
  }

  /** ASCII risk report. */
  formatReport() {
    const L = [], hr = "\u2550".repeat(78), th = "\u2500".repeat(78);
    L.push(hr, "  BAYESIAN RISK MODEL \u2014 POSTERIOR SUMMARY");
    L.push(`  ${new Date().toISOString().slice(0, 10)}  |  Observations: ${this.observationCount}`, hr);
    // Regime
    const reg = this.regimeProbabilities();
    const bar = p => "\u2588".repeat(Math.round(p * 40)).padEnd(40, "\u2591");
    L.push("", "  REGIME PROBABILITIES", th);
    L.push(`  Bull   ${bar(reg.bull)}  ${(reg.bull * 100).toFixed(1)}%`);
    L.push(`  Bear   ${bar(reg.bear)}  ${(reg.bear * 100).toFixed(1)}%`);
    L.push(`  Crisis ${bar(reg.crisis)}  ${(reg.crisis * 100).toFixed(1)}%`);
    // Predictive
    const pred = this.predictiveDistribution();
    L.push("", "  POSTERIOR PREDICTIVE (next-period)", th);
    L.push("  Asset    E[r] bps   Vol bps   VaR95 bps   VaR99 bps   DF", th);
    for (const sym of this.assets) {
      const p = pred[sym]; if (!p) continue;
      L.push(`  ${sym.padEnd(8)}${(p.mean * 1e4).toFixed(1).padStart(9)}${(p.scale * 1e4).toFixed(1).padStart(9)}${(p.var95 * 1e4).toFixed(1).padStart(11)}${(p.var99 * 1e4).toFixed(1).padStart(11)}${p.df.toFixed(0).padStart(5)}`);
    }
    // Marginal contributions
    const mc = this.getMarginalContributions();
    L.push("", "  MARGINAL RISK CONTRIBUTIONS (equal-weight)", th, "  Asset    Marginal   % Contrib   Beta", th);
    for (const sym of this.assets) {
      const c = mc[sym]; if (!c) continue;
      L.push(`  ${sym.padEnd(8)} ${(c.marginalVar * 1e4).toFixed(2).padStart(9)} ${(c.pctContribution * 100).toFixed(1).padStart(10)}%  ${c.beta.toFixed(3).padStart(7)}`);
    }
    // Sharpe
    L.push("", "  BAYESIAN SHARPE RATIOS", th, "  Asset    Sharpe   95% CI", th);
    for (const sym of this.assets) {
      const bs = bayesianSharpe(this.assetReturns[sym]);
      L.push(`  ${sym.padEnd(8)} ${bs.sharpe.toFixed(3).padStart(7)}   [${bs.credibleInterval[0].toFixed(2)}, ${bs.credibleInterval[1].toFixed(2)}]`);
    }
    L.push("", hr);
    return L.join("\n");
  }

  // ── Internal ────────────────────────────────────────────
  _updateCov() {
    const n = this.assets.length; if (!n) { this.covMatrix = []; return; }
    const minLen = Math.min(...this.assets.map(s => this.assetReturns[s].length));
    if (minLen < 3) { this.covMatrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 2e-4 : 0)); return; }
    const S = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
      const c = covariance(this.assetReturns[this.assets[i]].slice(-minLen), this.assetReturns[this.assets[j]].slice(-minLen));
      S[i][j] = c; S[j][i] = c;
    }
    const d = 0.2; // Ledoit-Wolf-style shrinkage intensity
    this.covMatrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (1 - d) * S[i][j] + (i === j ? d * S[i][i] : 0)));
  }

  _factorBetas() {
    const betas = {}; if (!this.factors.length) return betas;
    for (const sym of this.assets) {
      betas[sym] = {};
      const y = this.assetReturns[sym];
      for (const f of this.factors) {
        const x = this.factorReturns[f], n = Math.min(y.length, x.length);
        if (n < 5) { betas[sym][f] = 0; continue; }
        const ys = y.slice(-n), xs = x.slice(-n), mx = mean(xs), my = mean(ys);
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
        betas[sym][f] = den > 1e-15 ? num / den : 0;
      }
    }
    return betas;
  }

  _tQuantile(p, df) {
    const z = this._normQ(p);
    if (df >= 100) return z;
    const g2 = 6 / Math.max(1, df - 4);
    return z + (z ** 3 - 3 * z) * g2 / 24;
  }

  _normQ(p) {
    if (p <= 0) return -6; if (p >= 1) return 6;
    if (p > 0.5) return -this._normQ(1 - p);
    const t = Math.sqrt(-2 * Math.log(p));
    return -(t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3));
  }
}

// ─── CLI Demo ────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const af = args.find(a => a.startsWith("--assets="));
  const symbols = af ? af.split("=")[1].split(",") : ["SPY", "QQQ", "AAPL", "MSFT", "GLD", "TLT"];

  console.log(`\n  Generating price data for: ${symbols.join(", ")}...`);
  const assetReturns = {};
  for (const sym of symbols) assetReturns[sym] = priceReturns(generateRealisticPrices(sym));

  // Factor returns: market proxy + momentum spread
  const factorReturns = { Market: assetReturns[symbols[0]] };
  if (symbols.length >= 4) {
    const n = Math.min(assetReturns[symbols[1]].length, assetReturns[symbols[symbols.length - 1]].length);
    factorReturns.Momentum = [];
    for (let i = 0; i < n; i++) factorReturns.Momentum.push((assetReturns[symbols[1]][i] || 0) - (assetReturns[symbols[symbols.length - 1]][i] || 0));
  }

  const model = new BayesianRiskModel(assetReturns, factorReturns);
  console.log("  Fitting priors from 252-day lookback...");
  model.fitPriors(252);

  console.log("  Running 10 sequential Bayesian updates...\n");
  for (let t = 0; t < 10; t++) {
    const obs = {};
    for (const sym of symbols) { const r = assetReturns[sym]; obs[sym] = r[r.length - 10 + t] || 0; }
    model.updateBeliefs(obs);
  }

  console.log(model.formatReport());

  // Stress test
  const th = "\u2500".repeat(78);
  console.log("\n  STRESS SCENARIO: Market -5%, Momentum reversal +3%");
  console.log(th);
  const stress = model.stressScenario({ Market: -0.05, Momentum: 0.03 });
  console.log("  Asset     Cond.Mean bps   Cond.Vol bps   Stress Loss bps");
  console.log(th);
  for (const sym of symbols) {
    const s = stress[sym]; if (!s) continue;
    console.log(`  ${sym.padEnd(9)} ${(s.conditionalMean * 1e4).toFixed(1).padStart(14)} ${(s.conditionalVol * 1e4).toFixed(1).padStart(14)} ${(s.loss * 1e4).toFixed(1).padStart(16)}`);
  }

  // Bayesian Sharpe summary
  console.log(`\n  BAYESIAN SHARPE (prior=0.4, weight=0.3)`);
  console.log(th);
  for (const sym of symbols) {
    const bs = bayesianSharpe(assetReturns[sym]);
    console.log(`  ${sym.padEnd(8)} SR: ${bs.sharpe.toFixed(3)}  CI: [${bs.credibleInterval[0].toFixed(2)}, ${bs.credibleInterval[1].toFixed(2)}]  n=${bs.effectiveSamples}`);
  }
  console.log("");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
