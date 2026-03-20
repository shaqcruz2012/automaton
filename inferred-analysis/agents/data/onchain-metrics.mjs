#!/usr/bin/env node

// On-chain metrics simulator and analysis for crypto-adjacent quant strategies

// ── Utility helpers ────────────────────────────────────────────────────────────

function randomNormal(mean = 0, stddev = 1) {
  const u1 = Math.random();
  const u2 = Math.random();
  return mean + stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function meanOf(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function formatUSD(n) {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatNumber(n) {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function sparkline(values, width = 20) {
  const chars = '▁▂▃▄▅▆▇█';
  if (!values.length) return '';
  const sampled = [];
  for (let i = 0; i < width; i++) {
    const idx = Math.floor((i / width) * values.length);
    sampled.push(values[idx]);
  }
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;
  return sampled.map(v => chars[Math.floor(((v - min) / range) * (chars.length - 1))]).join('');
}

function padRight(str, len) {
  return String(str).padEnd(len);
}

function padLeft(str, len) {
  return String(str).padStart(len);
}

// ── MVRV Signal ────────────────────────────────────────────────────────────────

function mvrvSignal(mvrv) {
  if (typeof mvrv !== 'number' || isNaN(mvrv)) return { zone: 'unknown', action: 'no data' };
  if (mvrv < 1) {
    return {
      zone: 'undervalued',
      action: 'accumulate',
      confidence: clamp(1 - mvrv, 0, 1),
      description: `MVRV ${mvrv.toFixed(2)} — market value below realized value, historically strong buy zone`
    };
  }
  if (mvrv <= 3) {
    return {
      zone: 'fair',
      action: 'hold',
      confidence: 0.5,
      description: `MVRV ${mvrv.toFixed(2)} — market fairly valued relative to realized value`
    };
  }
  return {
    zone: 'overvalued',
    action: 'reduce exposure',
    confidence: clamp((mvrv - 3) / 4, 0, 1),
    description: `MVRV ${mvrv.toFixed(2)} — market value significantly above realized, distribution likely`
  };
}

// ── Funding Rate Strategy ──────────────────────────────────────────────────────

function fundingRateStrategy(fundingRates, prices) {
  if (!fundingRates.length || fundingRates.length !== prices.length) {
    return { signals: [], summary: 'insufficient data' };
  }

  const avgFunding = meanOf(fundingRates);
  const stdFunding = Math.sqrt(
    meanOf(fundingRates.map(r => (r - avgFunding) ** 2))
  );

  const signals = [];
  let pnl = 0;

  for (let i = 1; i < fundingRates.length; i++) {
    const zScore = stdFunding > 0 ? (fundingRates[i] - avgFunding) / stdFunding : 0;
    const priceChange = (prices[i] - prices[i - 1]) / prices[i - 1];

    if (zScore > 1.5) {
      // Extreme positive funding → market overleveraged long → go short
      signals.push({
        day: i,
        type: 'contrarian_short',
        fundingRate: fundingRates[i],
        zScore: zScore.toFixed(2),
        reasoning: 'extreme positive funding — overleveraged longs'
      });
      pnl -= priceChange; // short position
    } else if (zScore < -1.5) {
      // Extreme negative funding → market overleveraged short → go long
      signals.push({
        day: i,
        type: 'contrarian_long',
        fundingRate: fundingRates[i],
        zScore: zScore.toFixed(2),
        reasoning: 'extreme negative funding — overleveraged shorts'
      });
      pnl += priceChange; // long position
    }
  }

  const hitRate = signals.length > 0
    ? signals.filter((s, idx) => {
        const nextIdx = s.day + 1;
        if (nextIdx >= prices.length) return false;
        const move = (prices[nextIdx] - prices[s.day]) / prices[s.day];
        return s.type === 'contrarian_long' ? move > 0 : move < 0;
      }).length / signals.length
    : 0;

  return {
    signals,
    summary: {
      totalSignals: signals.length,
      avgFunding: (avgFunding * 100).toFixed(4) + '%',
      stdFunding: (stdFunding * 100).toFixed(4) + '%',
      estimatedPnL: (pnl * 100).toFixed(2) + '%',
      hitRate: (hitRate * 100).toFixed(1) + '%'
    }
  };
}

// ── Exchange Flow Analysis ─────────────────────────────────────────────────────

function exchangeFlowAnalysis(inflows, outflows) {
  if (!inflows.length || inflows.length !== outflows.length) {
    return { netFlows: [], interpretation: 'insufficient data' };
  }

  const netFlows = inflows.map((inf, i) => inf - outflows[i]);
  const totalNetFlow = netFlows.reduce((s, v) => s + v, 0);
  const avgNetFlow = meanOf(netFlows);
  const recentNetFlow = meanOf(netFlows.slice(-7));

  const outflowDays = netFlows.filter(n => n < 0).length;
  const inflowDays = netFlows.filter(n => n > 0).length;

  // Detect spikes (>2 std dev from mean)
  const stdNetFlow = Math.sqrt(meanOf(netFlows.map(n => (n - avgNetFlow) ** 2)));
  const spikes = [];
  for (let i = 0; i < netFlows.length; i++) {
    const zScore = stdNetFlow > 0 ? (netFlows[i] - avgNetFlow) / stdNetFlow : 0;
    if (Math.abs(zScore) > 2) {
      spikes.push({
        day: i,
        netFlow: netFlows[i],
        zScore: zScore.toFixed(2),
        type: netFlows[i] < 0 ? 'outflow_spike' : 'inflow_spike'
      });
    }
  }

  let trend;
  if (recentNetFlow < -avgNetFlow * 0.5 && recentNetFlow < 0) {
    trend = 'bullish_accumulation';
  } else if (recentNetFlow > avgNetFlow * 0.5 && recentNetFlow > 0) {
    trend = 'bearish_distribution';
  } else {
    trend = 'neutral';
  }

  return {
    netFlows,
    totalNetFlow,
    avgDailyNetFlow: avgNetFlow,
    recentTrend: trend,
    inflowDominantDays: inflowDays,
    outflowDominantDays: outflowDays,
    spikes,
    interpretation: trend === 'bullish_accumulation'
      ? 'Coins leaving exchanges — holders accumulating, reducing sell pressure'
      : trend === 'bearish_distribution'
        ? 'Coins entering exchanges — holders preparing to sell, increasing sell pressure'
        : 'Exchange flows balanced — no strong directional bias'
  };
}

// ── OnChainMetrics Class ───────────────────────────────────────────────────────

class OnChainMetrics {
  constructor() {
    this.days = 0;
    this.metrics = {
      activeAddresses: [],
      transactionVolume: [],
      hashRateProxy: [],
      exchangeInflow: [],
      exchangeOutflow: [],
      mvrv: [],
      nupl: [],
      fundingRates: [],
      openInterest: [],
      prices: []
    };
  }

  simulateMetrics(days = 90) {
    this.days = days;

    let price = 40000 + Math.random() * 20000;
    let hashRate = 400 + Math.random() * 100;    // EH/s proxy
    let activeAddr = 800000 + Math.random() * 200000;
    let oi = 15e9 + Math.random() * 5e9;
    let realizedPrice = price * (0.6 + Math.random() * 0.3);

    for (let d = 0; d < days; d++) {
      // Price random walk with slight drift
      const priceDrift = randomNormal(0.001, 0.035);
      price = clamp(price * (1 + priceDrift), 15000, 120000);

      // Active addresses correlate loosely with price momentum
      const addrShock = randomNormal(0, 0.04);
      activeAddr = clamp(activeAddr * (1 + addrShock + priceDrift * 0.3), 400000, 2000000);

      // Transaction volume in USD
      const txVol = activeAddr * (50 + Math.random() * 150) * (1 + Math.abs(priceDrift) * 5);

      // Hash rate: slow upward trend with noise
      hashRate = clamp(hashRate * (1 + randomNormal(0.0005, 0.008)), 200, 900);

      // Exchange flows
      const baseFlow = 5000 + Math.random() * 15000; // BTC
      const inflowBias = priceDrift < -0.02 ? 1.3 : priceDrift > 0.02 ? 0.7 : 1.0;
      const inflow = baseFlow * inflowBias * (0.8 + Math.random() * 0.4);
      const outflow = baseFlow * (1 / inflowBias) * (0.8 + Math.random() * 0.4);

      // Realized price drifts slowly toward market price
      realizedPrice = realizedPrice * 0.995 + price * 0.005;
      const mvrv = price / realizedPrice;

      // NUPL derived from MVRV: (MV - RV) / MV = 1 - 1/MVRV
      const nupl = clamp(1 - 1 / mvrv + randomNormal(0, 0.02), -0.5, 0.8);

      // Funding rate: mean-reverting with occasional spikes
      const baseFunding = randomNormal(0.0001, 0.0008);
      const fundingSpike = Math.random() > 0.92 ? randomNormal(0, 0.003) : 0;
      const funding = clamp(baseFunding + fundingSpike + priceDrift * 0.01, -0.01, 0.01);

      // Open interest tracks price with leverage cycles
      const oiChange = randomNormal(0, 0.03) + priceDrift * 0.5;
      oi = clamp(oi * (1 + oiChange), 5e9, 40e9);

      this.metrics.prices.push(price);
      this.metrics.activeAddresses.push(Math.round(activeAddr));
      this.metrics.transactionVolume.push(txVol);
      this.metrics.hashRateProxy.push(hashRate);
      this.metrics.exchangeInflow.push(inflow);
      this.metrics.exchangeOutflow.push(outflow);
      this.metrics.mvrv.push(mvrv);
      this.metrics.nupl.push(nupl);
      this.metrics.fundingRates.push(funding);
      this.metrics.openInterest.push(oi);
    }

    return this.metrics;
  }

  getSignals() {
    if (!this.days) return { error: 'no data — call simulateMetrics() first' };

    const latest = (arr) => arr[arr.length - 1];
    const recent = (arr, n = 7) => arr.slice(-n);

    const currentMVRV = latest(this.metrics.mvrv);
    const currentNUPL = latest(this.metrics.nupl);
    const currentFunding = latest(this.metrics.fundingRates);
    const recentInflow = meanOf(recent(this.metrics.exchangeInflow));
    const recentOutflow = meanOf(recent(this.metrics.exchangeOutflow));
    const avgInflow = meanOf(this.metrics.exchangeInflow);
    const avgOutflow = meanOf(this.metrics.exchangeOutflow);

    const signals = [];

    // MVRV signal
    const mvrvSig = mvrvSignal(currentMVRV);
    signals.push({
      indicator: 'MVRV',
      value: currentMVRV.toFixed(3),
      signal: mvrvSig.zone,
      action: mvrvSig.action,
      strength: mvrvSig.confidence
    });

    // NUPL signal
    let nuplSignal;
    if (currentNUPL < 0) nuplSignal = { signal: 'capitulation', action: 'strong buy' };
    else if (currentNUPL < 0.25) nuplSignal = { signal: 'hope', action: 'accumulate' };
    else if (currentNUPL < 0.5) nuplSignal = { signal: 'optimism', action: 'hold' };
    else if (currentNUPL < 0.75) nuplSignal = { signal: 'euphoria', action: 'take profit' };
    else nuplSignal = { signal: 'greed', action: 'sell' };

    signals.push({
      indicator: 'NUPL',
      value: currentNUPL.toFixed(3),
      signal: nuplSignal.signal,
      action: nuplSignal.action,
      strength: Math.abs(currentNUPL)
    });

    // Exchange flow signal
    const netFlowRatio = (recentOutflow - recentInflow) / avgInflow;
    let flowSignal;
    if (netFlowRatio > 0.15) flowSignal = { signal: 'outflow_spike', action: 'bullish — accumulation detected' };
    else if (netFlowRatio < -0.15) flowSignal = { signal: 'inflow_spike', action: 'bearish — distribution detected' };
    else flowSignal = { signal: 'neutral', action: 'no strong bias' };

    signals.push({
      indicator: 'Exchange Flow',
      value: `net ${netFlowRatio > 0 ? 'outflow' : 'inflow'} ${Math.abs(netFlowRatio * 100).toFixed(1)}%`,
      signal: flowSignal.signal,
      action: flowSignal.action,
      strength: clamp(Math.abs(netFlowRatio), 0, 1)
    });

    // Funding rate signal
    const avgFunding = meanOf(this.metrics.fundingRates);
    const stdFunding = Math.sqrt(meanOf(this.metrics.fundingRates.map(r => (r - avgFunding) ** 2)));
    const fundingZ = stdFunding > 0 ? (currentFunding - avgFunding) / stdFunding : 0;

    let fundingSig;
    if (fundingZ > 1.5) fundingSig = { signal: 'extreme_positive', action: 'contrarian short bias' };
    else if (fundingZ < -1.5) fundingSig = { signal: 'extreme_negative', action: 'contrarian long bias' };
    else fundingSig = { signal: 'normal', action: 'no contrarian edge' };

    signals.push({
      indicator: 'Funding Rate',
      value: `${(currentFunding * 100).toFixed(4)}% (z=${fundingZ.toFixed(2)})`,
      signal: fundingSig.signal,
      action: fundingSig.action,
      strength: clamp(Math.abs(fundingZ) / 3, 0, 1)
    });

    // Composite score: weighted average of strengths with direction
    const weights = { MVRV: 0.3, NUPL: 0.25, 'Exchange Flow': 0.25, 'Funding Rate': 0.2 };
    const directionMap = {
      accumulate: 1, 'strong buy': 1, hold: 0.3, 'take profit': -0.5, sell: -1,
      'reduce exposure': -0.8, 'bullish — accumulation detected': 0.7,
      'bearish — distribution detected': -0.7, 'no strong bias': 0,
      'contrarian short bias': -0.5, 'contrarian long bias': 0.5, 'no contrarian edge': 0
    };

    let composite = 0;
    for (const sig of signals) {
      const w = weights[sig.indicator] || 0.25;
      const dir = directionMap[sig.action] ?? 0;
      composite += w * dir * sig.strength;
    }

    return {
      signals,
      composite: {
        score: composite.toFixed(3),
        bias: composite > 0.15 ? 'BULLISH' : composite < -0.15 ? 'BEARISH' : 'NEUTRAL',
        recommendation: composite > 0.3 ? 'increase position'
          : composite > 0.15 ? 'lean long'
          : composite < -0.3 ? 'decrease position'
          : composite < -0.15 ? 'lean short'
          : 'stay flat'
      }
    };
  }

  formatDashboard() {
    if (!this.days) return 'No data. Call simulateMetrics() first.';

    const m = this.metrics;
    const latest = (arr) => arr[arr.length - 1];
    const lines = [];
    const w = 72;
    const hr = '─'.repeat(w);

    lines.push('┌' + '─'.repeat(w) + '┐');
    lines.push('│' + '  ON-CHAIN METRICS DASHBOARD'.padEnd(w) + '│');
    lines.push('│' + `  Simulation: ${this.days} days`.padEnd(w) + '│');
    lines.push('├' + hr + '┤');

    // Price
    const price = latest(m.prices);
    const priceChange = ((price - m.prices[0]) / m.prices[0] * 100).toFixed(1);
    const priceDir = priceChange >= 0 ? '+' : '';
    lines.push('│' + `  Price: ${formatUSD(price)}  (${priceDir}${priceChange}%)`.padEnd(w) + '│');
    lines.push('│' + `  ${sparkline(m.prices, 50)}`.padEnd(w) + '│');
    lines.push('├' + hr + '┤');

    // Metrics table
    const rows = [
      ['Active Addresses', formatNumber(latest(m.activeAddresses)), sparkline(m.activeAddresses, 20)],
      ['Tx Volume (USD)', formatUSD(latest(m.transactionVolume)), sparkline(m.transactionVolume, 20)],
      ['Hash Rate (EH/s)', latest(m.hashRateProxy).toFixed(1), sparkline(m.hashRateProxy, 20)],
      ['Exchange Inflow', formatNumber(latest(m.exchangeInflow)) + ' BTC', sparkline(m.exchangeInflow, 20)],
      ['Exchange Outflow', formatNumber(latest(m.exchangeOutflow)) + ' BTC', sparkline(m.exchangeOutflow, 20)],
      ['MVRV Ratio', latest(m.mvrv).toFixed(3), sparkline(m.mvrv, 20)],
      ['NUPL', latest(m.nupl).toFixed(3), sparkline(m.nupl, 20)],
      ['Funding Rate', (latest(m.fundingRates) * 100).toFixed(4) + '%', sparkline(m.fundingRates, 20)],
      ['Open Interest', formatUSD(latest(m.openInterest)), sparkline(m.openInterest, 20)],
    ];

    lines.push('│' + `  ${'Metric'.padEnd(20)} ${'Value'.padEnd(18)} ${'Trend'}`.padEnd(w) + '│');
    lines.push('│' + `  ${'─'.repeat(20)} ${'─'.repeat(18)} ${'─'.repeat(20)}`.padEnd(w) + '│');
    for (const [label, value, trend] of rows) {
      const row = `  ${label.padEnd(20)} ${value.padEnd(18)} ${trend}`;
      lines.push('│' + row.padEnd(w) + '│');
    }

    lines.push('├' + hr + '┤');

    // Signals summary
    const sigs = this.getSignals();
    lines.push('│' + '  SIGNALS'.padEnd(w) + '│');
    lines.push('│' + `  ${'─'.repeat(w - 4)}`.padEnd(w) + '│');
    for (const sig of sigs.signals) {
      const row = `  ${sig.indicator.padEnd(16)} ${sig.signal.padEnd(20)} → ${sig.action}`;
      lines.push('│' + row.padEnd(w) + '│');
    }

    lines.push('│' + `  ${'─'.repeat(w - 4)}`.padEnd(w) + '│');
    const comp = sigs.composite;
    lines.push('│' + `  COMPOSITE: ${comp.score} → ${comp.bias} (${comp.recommendation})`.padEnd(w) + '│');

    lines.push('└' + '─'.repeat(w) + '┘');

    return lines.join('\n');
  }
}

// ── CLI Demo ───────────────────────────────────────────────────────────────────

function runDemo() {
  console.log('=== On-Chain Metrics Simulator ===\n');

  const chain = new OnChainMetrics();
  chain.simulateMetrics(90);

  // Dashboard
  console.log(chain.formatDashboard());
  console.log();

  // MVRV signal examples
  console.log('--- MVRV Signal Examples ---');
  for (const val of [0.5, 0.9, 1.5, 2.5, 3.5, 5.0]) {
    const sig = mvrvSignal(val);
    console.log(`  MVRV ${val.toFixed(1)} → ${sig.zone} (${sig.action}) confidence=${sig.confidence.toFixed(2)}`);
  }
  console.log();

  // Funding rate strategy
  console.log('--- Funding Rate Strategy ---');
  const fundingResult = fundingRateStrategy(chain.metrics.fundingRates, chain.metrics.prices);
  console.log(`  Total signals: ${fundingResult.summary.totalSignals}`);
  console.log(`  Avg funding:   ${fundingResult.summary.avgFunding}`);
  console.log(`  Std funding:   ${fundingResult.summary.stdFunding}`);
  console.log(`  Est. PnL:      ${fundingResult.summary.estimatedPnL}`);
  console.log(`  Hit rate:      ${fundingResult.summary.hitRate}`);
  if (fundingResult.signals.length > 0) {
    console.log('  Recent signals:');
    for (const s of fundingResult.signals.slice(-5)) {
      console.log(`    Day ${s.day}: ${s.type} (funding=${(s.fundingRate * 100).toFixed(4)}%, z=${s.zScore})`);
    }
  }
  console.log();

  // Exchange flow analysis
  console.log('--- Exchange Flow Analysis ---');
  const flowResult = exchangeFlowAnalysis(chain.metrics.exchangeInflow, chain.metrics.exchangeOutflow);
  console.log(`  Trend:          ${flowResult.recentTrend}`);
  console.log(`  Inflow days:    ${flowResult.inflowDominantDays}`);
  console.log(`  Outflow days:   ${flowResult.outflowDominantDays}`);
  console.log(`  Total net flow: ${formatNumber(flowResult.totalNetFlow)} BTC`);
  console.log(`  Spikes:         ${flowResult.spikes.length}`);
  console.log(`  Interpretation: ${flowResult.interpretation}`);
  if (flowResult.spikes.length > 0) {
    console.log('  Notable spikes:');
    for (const spike of flowResult.spikes.slice(-5)) {
      console.log(`    Day ${spike.day}: ${spike.type} (net=${formatNumber(spike.netFlow)} BTC, z=${spike.zScore})`);
    }
  }
  console.log();

  // Composite signal
  const signals = chain.getSignals();
  console.log('--- Composite Signal ---');
  console.log(`  Score:          ${signals.composite.score}`);
  console.log(`  Bias:           ${signals.composite.bias}`);
  console.log(`  Recommendation: ${signals.composite.recommendation}`);
}

runDemo();

export { OnChainMetrics, mvrvSignal, fundingRateStrategy, exchangeFlowAnalysis };
