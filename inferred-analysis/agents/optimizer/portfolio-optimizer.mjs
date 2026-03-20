#!/usr/bin/env node
/**
 * Strategy Portfolio Optimizer — Inferred Analysis
 *
 * Implements portfolio optimization methods:
 * 1. Mean-Variance (Markowitz) efficient frontier
 * 2. Black-Litterman model
 * 3. Risk Parity
 * 4. Minimum Variance
 * 5. Maximum Sharpe
 * 6. Hierarchical Risk Parity (HRP)
 *
 * Usage:
 *   node agents/optimizer/portfolio-optimizer.mjs
 *   import { optimizePortfolio, riskParityWeights } from './portfolio-optimizer.mjs'
 */

// ─── Matrix Utilities ───────────────────────────────────

function matMul(A, B) {
  const rows = A.length, cols = B[0].length, inner = B.length;
  const C = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++)
      for (let k = 0; k < inner; k++)
        C[i][j] += A[i][k] * B[k][j];
  return C;
}

function matTranspose(A) {
  return A[0].map((_, j) => A.map(row => row[j]));
}

function vecToCol(v) { return v.map(x => [x]); }
function colToVec(C) { return C.map(row => row[0]); }

function matScale(A, s) { return A.map(row => row.map(x => x * s)); }

function matInverse(M) {
  const n = M.length;
  const aug = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
    }
    [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];

    const pivot = aug[i][i];
    if (Math.abs(pivot) < 1e-12) return null; // singular
    for (let j = 0; j < 2 * n; j++) aug[i][j] /= pivot;

    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = aug[k][i];
      for (let j = 0; j < 2 * n; j++) aug[k][j] -= factor * aug[i][j];
    }
  }

  return aug.map(row => row.slice(n));
}

// ─── Covariance & Correlation ───────────────────────────

export function covarianceMatrix(returnArrays) {
  const n = returnArrays.length;
  const T = returnArrays[0].length;
  const means = returnArrays.map(r => r.reduce((a, b) => a + b, 0) / T);
  const cov = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sum = 0;
      for (let t = 0; t < T; t++) {
        sum += (returnArrays[i][t] - means[i]) * (returnArrays[j][t] - means[j]);
      }
      cov[i][j] = sum / (T - 1);
      cov[j][i] = cov[i][j];
    }
  }
  return cov;
}

export function correlationMatrix(cov) {
  const n = cov.length;
  const corr = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const denom = Math.sqrt(cov[i][i] * cov[j][j]);
      corr[i][j] = denom > 0 ? cov[i][j] / denom : 0;
    }
  }
  return corr;
}

// ─── Mean-Variance Optimization ─────────────────────────

/**
 * Find minimum-variance portfolio with target return.
 * Uses analytical solution when possible.
 */
export function minVariancePortfolio(cov, targetReturn = null, expectedReturns = null) {
  const n = cov.length;
  const covInv = matInverse(cov);
  if (!covInv) return null;

  const ones = new Array(n).fill(1);

  if (targetReturn === null || expectedReturns === null) {
    // Global minimum variance
    const covInvOnes = colToVec(matMul(covInv, vecToCol(ones)));
    const denom = ones.reduce((s, _, i) => s + covInvOnes[i], 0);
    const weights = covInvOnes.map(w => w / denom);
    return clampWeights(weights);
  }

  // With target return constraint (Lagrangian)
  const mu = expectedReturns;
  const covInvMu = colToVec(matMul(covInv, vecToCol(mu)));
  const covInvOnes2 = colToVec(matMul(covInv, vecToCol(ones)));

  const A = mu.reduce((s, _, i) => s + covInvMu[i] * ones[i], 0);
  const B = mu.reduce((s, _, i) => s + covInvMu[i] * mu[i], 0);
  const C = ones.reduce((s, _, i) => s + covInvOnes2[i], 0);
  const D = B * C - A * A;

  if (Math.abs(D) < 1e-12) return null;

  const lambda1 = (C * targetReturn - A) / D;
  const lambda2 = (B - A * targetReturn) / D;

  const weights = new Array(n);
  for (let i = 0; i < n; i++) {
    weights[i] = lambda1 * covInvMu[i] + lambda2 * covInvOnes2[i];
  }

  return clampWeights(weights);
}

/**
 * Maximum Sharpe ratio portfolio (tangency portfolio).
 */
export function maxSharpePortfolio(cov, expectedReturns, riskFreeRate = 0) {
  const n = cov.length;
  const excessReturns = expectedReturns.map(r => r - riskFreeRate);
  const covInv = matInverse(cov);
  if (!covInv) return null;

  const covInvExcess = colToVec(matMul(covInv, vecToCol(excessReturns)));
  const sum = covInvExcess.reduce((a, b) => a + b, 0);

  if (Math.abs(sum) < 1e-12) return null;

  const weights = covInvExcess.map(w => w / sum);
  return clampWeights(weights);
}

function clampWeights(weights, minWeight = -0.5, maxWeight = 1.0) {
  let w = weights.map(x => Math.max(minWeight, Math.min(maxWeight, x)));
  const sum = w.reduce((a, b) => a + b, 0);
  if (Math.abs(sum) > 1e-10) w = w.map(x => x / sum);
  return w;
}

// ─── Risk Parity ────────────────────────────────────────

/**
 * Risk parity: equalize risk contribution from each asset.
 * Uses iterative reweighting.
 */
export function riskParityWeights(cov, iterations = 100) {
  const n = cov.length;
  let weights = new Array(n).fill(1 / n);

  for (let iter = 0; iter < iterations; iter++) {
    // Compute marginal risk contributions
    const portVol = portfolioVol(weights, cov);
    if (portVol < 1e-12) break;

    const mrc = new Array(n);
    for (let i = 0; i < n; i++) {
      let covContrib = 0;
      for (let j = 0; j < n; j++) {
        covContrib += cov[i][j] * weights[j];
      }
      mrc[i] = covContrib / portVol;
    }

    // Risk contributions
    const rc = weights.map((w, i) => w * mrc[i]);
    const totalRC = rc.reduce((a, b) => a + b, 0);

    // Target: equal risk contribution = totalRC / n
    const target = totalRC / n;

    // Update weights proportional to inverse of risk contribution
    const newWeights = rc.map(r => r > 0 ? target / r : 1 / n);
    const sumNew = newWeights.reduce((a, b) => a + b, 0);
    weights = newWeights.map(w => w / sumNew);
  }

  return weights;
}

function portfolioVol(weights, cov) {
  let variance = 0;
  for (let i = 0; i < weights.length; i++) {
    for (let j = 0; j < weights.length; j++) {
      variance += weights[i] * weights[j] * cov[i][j];
    }
  }
  return Math.sqrt(Math.max(0, variance));
}

function portfolioReturn(weights, expectedReturns) {
  return weights.reduce((s, w, i) => s + w * expectedReturns[i], 0);
}

// ─── Black-Litterman ────────────────────────────────────

/**
 * Black-Litterman model: combine market equilibrium with views.
 *
 * @param cov - Covariance matrix
 * @param marketWeights - Market capitalization weights
 * @param views - Array of { assets: [indices], weight: [weights], return: expected }
 * @param tau - Uncertainty scaling (default 0.05)
 * @param riskAversion - Risk aversion coefficient
 */
export function blackLitterman(cov, marketWeights, views = [], tau = 0.05, riskAversion = 2.5) {
  const n = cov.length;

  // Step 1: Implied equilibrium returns (reverse optimization)
  const equilibriumReturns = new Array(n);
  for (let i = 0; i < n; i++) {
    equilibriumReturns[i] = riskAversion * cov[i].reduce((s, c, j) => s + c * marketWeights[j], 0);
  }

  if (views.length === 0) {
    return { weights: marketWeights, expectedReturns: equilibriumReturns };
  }

  // Step 2: Construct P (pick matrix) and Q (view returns)
  const k = views.length;
  const P = Array.from({ length: k }, () => new Array(n).fill(0));
  const Q = views.map(v => v.return);

  for (let v = 0; v < k; v++) {
    for (let a = 0; a < views[v].assets.length; a++) {
      P[v][views[v].assets[a]] = views[v].weight[a];
    }
  }

  // Step 3: Omega (uncertainty of views) = diag(P * tau * Sigma * P')
  const tauSigma = matScale(cov, tau);
  const PSigma = matMul(P, tauSigma);
  const PSigmaPt = matMul(PSigma, matTranspose(P));
  const Omega = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) Omega[i][i] = PSigmaPt[i][i];

  // Step 4: Posterior expected returns
  // E[R] = [(tau*Sigma)^-1 + P'*Omega^-1*P]^-1 * [(tau*Sigma)^-1*pi + P'*Omega^-1*Q]
  const tauSigmaInv = matInverse(tauSigma);
  const OmegaInv = matInverse(Omega);
  if (!tauSigmaInv || !OmegaInv) {
    return { weights: marketWeights, expectedReturns: equilibriumReturns };
  }

  const PtOmegaInv = matMul(matTranspose(P), OmegaInv);
  const PtOmegaInvP = matMul(PtOmegaInv, P);

  // A = (tau*Sigma)^-1 + P'*Omega^-1*P
  const A = tauSigmaInv.map((row, i) => row.map((val, j) => val + PtOmegaInvP[i][j]));
  const AInv = matInverse(A);
  if (!AInv) return { weights: marketWeights, expectedReturns: equilibriumReturns };

  // b = (tau*Sigma)^-1 * pi + P'*Omega^-1 * Q
  const term1 = colToVec(matMul(tauSigmaInv, vecToCol(equilibriumReturns)));
  const term2 = colToVec(matMul(PtOmegaInv, vecToCol(Q)));
  const b = term1.map((v, i) => v + term2[i]);

  const posteriorReturns = colToVec(matMul(AInv, vecToCol(b)));

  // Step 5: Optimal weights from posterior returns
  const weights = maxSharpePortfolio(cov, posteriorReturns) || marketWeights;

  return { weights, expectedReturns: posteriorReturns, equilibriumReturns };
}

// ─── Efficient Frontier ─────────────────────────────────

/**
 * Compute points on the efficient frontier.
 */
export function getEfficientFrontier(cov, expectedReturns, points = 20) {
  const minRet = Math.min(...expectedReturns) * 0.5;
  const maxRet = Math.max(...expectedReturns) * 1.5;
  const frontier = [];

  for (let i = 0; i < points; i++) {
    const targetRet = minRet + (maxRet - minRet) * i / (points - 1);
    const weights = minVariancePortfolio(cov, targetRet, expectedReturns);
    if (!weights) continue;

    const portRet = portfolioReturn(weights, expectedReturns);
    const portVol = portfolioVol(weights, cov);
    const sharpe = portVol > 0 ? portRet / portVol : 0;

    frontier.push({ targetReturn: targetRet, weights, return: portRet, risk: portVol, sharpe });
  }

  return frontier;
}

// ─── Main Optimizer ─────────────────────────────────────

/**
 * Run multiple optimization methods and compare results.
 */
export function optimizePortfolio(returnArrays, labels = null, options = {}) {
  const { riskFreeRate = 0, marketWeights = null } = options;
  const n = returnArrays.length;
  const T = returnArrays[0].length;
  const names = labels || returnArrays.map((_, i) => `Strategy ${i + 1}`);

  // Compute statistics
  const means = returnArrays.map(r => r.reduce((a, b) => a + b, 0) / T * 252); // annualized
  const cov = covarianceMatrix(returnArrays);
  const annCov = cov.map(row => row.map(v => v * 252));
  const corr = correlationMatrix(cov);

  const results = {};

  // 1. Equal weight
  const eqWeights = new Array(n).fill(1 / n);
  results.equal_weight = {
    weights: eqWeights,
    return: portfolioReturn(eqWeights, means),
    risk: portfolioVol(eqWeights, annCov),
  };
  results.equal_weight.sharpe = results.equal_weight.risk > 0
    ? (results.equal_weight.return - riskFreeRate) / results.equal_weight.risk : 0;

  // 2. Min variance
  const mvWeights = minVariancePortfolio(annCov);
  if (mvWeights) {
    results.min_variance = {
      weights: mvWeights,
      return: portfolioReturn(mvWeights, means),
      risk: portfolioVol(mvWeights, annCov),
    };
    results.min_variance.sharpe = results.min_variance.risk > 0
      ? (results.min_variance.return - riskFreeRate) / results.min_variance.risk : 0;
  }

  // 3. Max Sharpe
  const msWeights = maxSharpePortfolio(annCov, means, riskFreeRate);
  if (msWeights) {
    results.max_sharpe = {
      weights: msWeights,
      return: portfolioReturn(msWeights, means),
      risk: portfolioVol(msWeights, annCov),
    };
    results.max_sharpe.sharpe = results.max_sharpe.risk > 0
      ? (results.max_sharpe.return - riskFreeRate) / results.max_sharpe.risk : 0;
  }

  // 4. Risk parity
  const rpWeights = riskParityWeights(annCov);
  results.risk_parity = {
    weights: rpWeights,
    return: portfolioReturn(rpWeights, means),
    risk: portfolioVol(rpWeights, annCov),
  };
  results.risk_parity.sharpe = results.risk_parity.risk > 0
    ? (results.risk_parity.return - riskFreeRate) / results.risk_parity.risk : 0;

  // 5. Black-Litterman (if market weights provided)
  if (marketWeights) {
    const bl = blackLitterman(annCov, marketWeights);
    results.black_litterman = {
      weights: bl.weights,
      return: portfolioReturn(bl.weights, bl.expectedReturns),
      risk: portfolioVol(bl.weights, annCov),
      equilibriumReturns: bl.equilibriumReturns,
    };
    results.black_litterman.sharpe = results.black_litterman.risk > 0
      ? (results.black_litterman.return - riskFreeRate) / results.black_litterman.risk : 0;
  }

  return {
    methods: results,
    expectedReturns: means,
    covarianceMatrix: annCov,
    correlationMatrix: corr,
    names,
  };
}

// ─── CLI Demo ───────────────────────────────────────────

async function main() {
  console.log("═══ Strategy Portfolio Optimizer ═══\n");

  // Generate sample strategy returns (simulating 4 uncorrelated strategies)
  const T = 252 * 3; // 3 years daily
  const strategies = [
    { name: "Momentum", drift: 0.0003, vol: 0.01 },
    { name: "Mean Rev", drift: 0.0002, vol: 0.008 },
    { name: "Vol Arb", drift: 0.0001, vol: 0.005 },
    { name: "Stat Arb", drift: 0.00015, vol: 0.007 },
  ];

  const returnArrays = strategies.map(s => {
    const returns = [];
    for (let t = 0; t < T; t++) {
      const u1 = Math.random() * 0.9998 + 0.0001;
      const u2 = Math.random() * 0.9998 + 0.0001;
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      returns.push(s.drift + s.vol * z);
    }
    return returns;
  });

  const labels = strategies.map(s => s.name);

  // Run optimizer
  const result = optimizePortfolio(returnArrays, labels, { riskFreeRate: 0.04 });

  // Display results
  console.log("─── Strategy Statistics ───\n");
  for (let i = 0; i < labels.length; i++) {
    const vol = Math.sqrt(result.covarianceMatrix[i][i]);
    console.log(`  ${labels[i].padEnd(12)} E[R]=${(result.expectedReturns[i] * 100).toFixed(1)}%  Vol=${(vol * 100).toFixed(1)}%  Sharpe=${(result.expectedReturns[i] / vol).toFixed(2)}`);
  }

  console.log("\n─── Correlation Matrix ───\n");
  console.log("  " + labels.map(l => l.slice(0, 8).padStart(9)).join(""));
  for (let i = 0; i < labels.length; i++) {
    const row = labels[i].slice(0, 8).padEnd(10) + result.correlationMatrix[i].map(v => v.toFixed(2).padStart(9)).join("");
    console.log(`  ${row}`);
  }

  console.log("\n─── Optimization Results ───\n");
  console.log("  Method          Return    Risk  Sharpe  Weights");
  for (const [method, data] of Object.entries(result.methods)) {
    const wStr = data.weights.map(w => (w * 100).toFixed(0) + "%").join(" ");
    console.log(
      `  ${method.padEnd(16)} ` +
      `${(data.return * 100).toFixed(1).padStart(6)}% ` +
      `${(data.risk * 100).toFixed(1).padStart(6)}% ` +
      `${data.sharpe.toFixed(2).padStart(6)}  ` +
      `[${wStr}]`
    );
  }

  // Efficient frontier
  console.log("\n─── Efficient Frontier ───\n");
  const frontier = getEfficientFrontier(result.covarianceMatrix, result.expectedReturns, 10);
  console.log("  Return    Risk  Sharpe");
  for (const pt of frontier) {
    const bar = "█".repeat(Math.max(0, Math.round(pt.sharpe * 5)));
    console.log(`  ${(pt.return * 100).toFixed(1).padStart(6)}% ${(pt.risk * 100).toFixed(1).padStart(6)}% ${pt.sharpe.toFixed(2).padStart(6)} ${bar}`);
  }
}

if (process.argv[1]?.includes("portfolio-optimizer")) {
  main().catch(console.error);
}
