#!/usr/bin/env node
/**
 * Real-Time Streaming Data Pipeline
 *
 * Event-driven architecture for processing tick-by-tick market data,
 * computing indicators incrementally, and generating trading signals.
 *
 * Usage:
 *   node agents/data/streaming.mjs                  # Run 1000-tick demo
 *   node agents/data/streaming.mjs --ticks 5000     # Custom tick count
 *   node agents/data/streaming.mjs --ws 8080        # Start WebSocket stub
 *
 * Exports: StreamingPipeline, TickBuffer, IncrementalIndicator
 */

import { EventEmitter } from "events";
import { createServer } from "http";
import { createHash } from "crypto";

// ─── Ring Buffer ────────────────────────────────────────

/**
 * Fixed-size circular buffer for O(1) append and efficient windowed access.
 * Avoids array re-allocation on every tick.
 */
class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;   // next write position
    this.length = 0; // current number of elements
  }

  push(value) {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.length < this.capacity) this.length++;
  }

  /** Get element at logical index (0 = oldest). */
  get(index) {
    if (index < 0 || index >= this.length) return undefined;
    const start = (this.head - this.length + this.capacity) % this.capacity;
    return this.buffer[(start + index) % this.capacity];
  }

  /** Most recent element. */
  latest() {
    if (this.length === 0) return undefined;
    return this.buffer[(this.head - 1 + this.capacity) % this.capacity];
  }

  /** Return last N elements as array (newest last). */
  last(n) {
    const count = Math.min(n, this.length);
    const result = new Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = this.get(this.length - count + i);
    }
    return result;
  }

  isFull() {
    return this.length === this.capacity;
  }

  clear() {
    this.head = 0;
    this.length = 0;
  }

  toArray() {
    return this.last(this.length);
  }
}

// ─── Tick Buffer ────────────────────────────────────────

/**
 * Buffered tick storage with windowing support.
 * Accumulates raw ticks and provides time-based and count-based windows.
 */
class TickBuffer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.maxTicks    - Maximum ticks to retain (default 10000)
   * @param {number} opts.flushInterval - Auto-flush interval in ms (0 = disabled)
   */
  constructor(opts = {}) {
    super();
    this.maxTicks = opts.maxTicks || 10_000;
    this.ring = new RingBuffer(this.maxTicks);
    this.pendingBatch = [];
    this.batchSize = opts.batchSize || 50;
    this.flushInterval = opts.flushInterval || 0;
    this.tickCount = 0;
    this._flushTimer = null;

    if (this.flushInterval > 0) {
      this._flushTimer = setInterval(() => this._flush(), this.flushInterval);
    }
  }

  /** Ingest a single tick: { symbol, price, volume, timestamp } */
  ingest(tick) {
    const normalized = {
      symbol: tick.symbol || "UNKNOWN",
      price: +tick.price,
      volume: +tick.volume || 0,
      timestamp: tick.timestamp || Date.now(),
      seq: this.tickCount++,
    };

    this.ring.push(normalized);
    this.pendingBatch.push(normalized);
    this.emit("tick", normalized);

    if (this.pendingBatch.length >= this.batchSize) {
      this._flush();
    }

    return normalized;
  }

  _flush() {
    if (this.pendingBatch.length === 0) return;
    const batch = this.pendingBatch.slice();
    this.pendingBatch = [];
    this.emit("batch", batch);
  }

  /** Get ticks within a time window (ms from now). */
  windowByTime(windowMs) {
    const cutoff = Date.now() - windowMs;
    const result = [];
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const t = this.ring.get(i);
      if (t.timestamp < cutoff) break;
      result.unshift(t);
    }
    return result;
  }

  /** Get last N ticks. */
  windowByCount(n) {
    return this.ring.last(n);
  }

  latest() {
    return this.ring.latest();
  }

  get size() {
    return this.ring.length;
  }

  destroy() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this.removeAllListeners();
  }
}

// ─── Incremental Indicators ─────────────────────────────

/**
 * Base class for indicators that update incrementally on each tick,
 * avoiding full recomputation.
 */
class IncrementalIndicator extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.value = null;
    this.ready = false;
    this.ticksProcessed = 0;
  }

  /** Override in subclass. Returns updated value. */
  update(_tick) {
    throw new Error("update() must be implemented");
  }

  reset() {
    this.value = null;
    this.ready = false;
    this.ticksProcessed = 0;
  }
}

/**
 * Exponential Moving Average — O(1) per tick.
 */
class EMA extends IncrementalIndicator {
  constructor(period) {
    super(`EMA(${period})`);
    this.period = period;
    this.multiplier = 2 / (period + 1);
    this._sum = 0;
  }

  update(tick) {
    const price = tick.price;
    this.ticksProcessed++;

    if (this.ticksProcessed <= this.period) {
      // Seed with SMA
      this._sum += price;
      if (this.ticksProcessed === this.period) {
        this.value = this._sum / this.period;
        this.ready = true;
      }
    } else {
      this.value = (price - this.value) * this.multiplier + this.value;
    }

    return this.value;
  }

  reset() {
    super.reset();
    this._sum = 0;
  }
}

/**
 * Simple Moving Average using a ring buffer — O(1) amortized per tick.
 */
class SMA extends IncrementalIndicator {
  constructor(period) {
    super(`SMA(${period})`);
    this.period = period;
    this.ring = new RingBuffer(period);
    this._sum = 0;
  }

  update(tick) {
    const price = tick.price;
    this.ticksProcessed++;

    // Subtract oldest if buffer is full
    if (this.ring.isFull()) {
      this._sum -= this.ring.get(0);
    }

    this.ring.push(price);
    this._sum += price;

    if (this.ring.length >= this.period) {
      this.value = this._sum / this.period;
      this.ready = true;
    } else {
      this.value = this._sum / this.ring.length;
    }

    return this.value;
  }

  reset() {
    super.reset();
    this.ring.clear();
    this._sum = 0;
  }
}

/**
 * Relative Strength Index — incremental Wilder's smoothing, O(1) per tick.
 */
class RSI extends IncrementalIndicator {
  constructor(period = 14) {
    super(`RSI(${period})`);
    this.period = period;
    this._prevPrice = null;
    this._gains = [];
    this._losses = [];
    this._avgGain = 0;
    this._avgLoss = 0;
  }

  update(tick) {
    const price = tick.price;
    this.ticksProcessed++;

    if (this._prevPrice === null) {
      this._prevPrice = price;
      return this.value;
    }

    const change = price - this._prevPrice;
    this._prevPrice = price;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (!this.ready) {
      this._gains.push(gain);
      this._losses.push(loss);

      if (this._gains.length === this.period) {
        this._avgGain = this._gains.reduce((a, b) => a + b, 0) / this.period;
        this._avgLoss = this._losses.reduce((a, b) => a + b, 0) / this.period;
        this._gains = null;
        this._losses = null;
        this.ready = true;
        this.value = this._avgLoss === 0 ? 100 : 100 - 100 / (1 + this._avgGain / this._avgLoss);
      }
    } else {
      // Wilder's smoothing — O(1)
      this._avgGain = (this._avgGain * (this.period - 1) + gain) / this.period;
      this._avgLoss = (this._avgLoss * (this.period - 1) + loss) / this.period;
      this.value = this._avgLoss === 0 ? 100 : 100 - 100 / (1 + this._avgGain / this._avgLoss);
    }

    return this.value;
  }

  reset() {
    super.reset();
    this._prevPrice = null;
    this._gains = [];
    this._losses = [];
    this._avgGain = 0;
    this._avgLoss = 0;
  }
}

/**
 * Volume-Weighted Average Price — incremental, O(1) per tick.
 */
class VWAP extends IncrementalIndicator {
  constructor() {
    super("VWAP");
    this._cumulativePV = 0;
    this._cumulativeVolume = 0;
  }

  update(tick) {
    this.ticksProcessed++;
    this._cumulativePV += tick.price * tick.volume;
    this._cumulativeVolume += tick.volume;

    if (this._cumulativeVolume > 0) {
      this.value = this._cumulativePV / this._cumulativeVolume;
      this.ready = true;
    }

    return this.value;
  }

  reset() {
    super.reset();
    this._cumulativePV = 0;
    this._cumulativeVolume = 0;
  }
}

// ─── Signal Generator ───────────────────────────────────

/**
 * Generates trading signals from indicator state.
 * Emits: "signal" with { type, strength, reason, indicators, tick }
 */
class SignalGenerator extends EventEmitter {
  constructor() {
    super();
    this._prevSignal = null;
    this._cooldown = 0;
    this.cooldownTicks = 5; // minimum ticks between signals
  }

  evaluate(tick, indicators) {
    if (this._cooldown > 0) {
      this._cooldown--;
      return null;
    }

    const ema20 = indicators.ema20;
    const ema50 = indicators.ema50;
    const rsi = indicators.rsi;
    const vwap = indicators.vwap;

    // Need all indicators ready
    if (!ema20?.ready || !ema50?.ready || !rsi?.ready || !vwap?.ready) {
      return null;
    }

    const signals = [];

    // EMA crossover
    const emaDiff = (ema20.value - ema50.value) / ema50.value;
    if (emaDiff > 0.001 && this._prevSignal !== "BULLISH_CROSS") {
      signals.push({ type: "BULLISH_CROSS", strength: Math.min(emaDiff * 100, 1), reason: "EMA20 crossed above EMA50" });
    } else if (emaDiff < -0.001 && this._prevSignal !== "BEARISH_CROSS") {
      signals.push({ type: "BEARISH_CROSS", strength: Math.min(Math.abs(emaDiff) * 100, 1), reason: "EMA20 crossed below EMA50" });
    }

    // RSI extremes
    if (rsi.value > 70) {
      signals.push({ type: "OVERBOUGHT", strength: (rsi.value - 70) / 30, reason: `RSI at ${rsi.value.toFixed(1)}` });
    } else if (rsi.value < 30) {
      signals.push({ type: "OVERSOLD", strength: (30 - rsi.value) / 30, reason: `RSI at ${rsi.value.toFixed(1)}` });
    }

    // VWAP deviation
    const vwapDev = (tick.price - vwap.value) / vwap.value;
    if (Math.abs(vwapDev) > 0.01) {
      signals.push({
        type: vwapDev > 0 ? "ABOVE_VWAP" : "BELOW_VWAP",
        strength: Math.min(Math.abs(vwapDev) * 10, 1),
        reason: `Price ${(vwapDev * 100).toFixed(2)}% from VWAP`,
      });
    }

    // Pick strongest signal
    if (signals.length === 0) return null;

    signals.sort((a, b) => b.strength - a.strength);
    const best = signals[0];

    const signal = {
      ...best,
      indicators: {
        ema20: ema20.value,
        ema50: ema50.value,
        rsi: rsi.value,
        vwap: vwap.value,
      },
      tick,
      timestamp: Date.now(),
    };

    this._prevSignal = best.type;
    this._cooldown = this.cooldownTicks;
    this.emit("signal", signal);
    return signal;
  }
}

// ─── Backpressure Controller ────────────────────────────

/**
 * Monitors consumer lag and applies backpressure when consumers fall behind.
 * Strategies: drop (skip ticks), sample (take every Nth), pause (halt producer).
 */
class BackpressureController extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.highWaterMark  - Pending items before applying pressure
   * @param {number} opts.lowWaterMark   - Resume threshold
   * @param {string} opts.strategy       - "drop" | "sample" | "pause"
   */
  constructor(opts = {}) {
    super();
    this.highWaterMark = opts.highWaterMark || 100;
    this.lowWaterMark = opts.lowWaterMark || 25;
    this.strategy = opts.strategy || "drop";
    this.pendingCount = 0;
    this.pressureActive = false;
    this.droppedCount = 0;
    this._sampleCounter = 0;
    this.sampleRate = opts.sampleRate || 4; // keep 1 in N when sampling
  }

  /** Check if a tick should be processed. Returns true if allowed. */
  acquire() {
    this.pendingCount++;

    if (this.pendingCount >= this.highWaterMark && !this.pressureActive) {
      this.pressureActive = true;
      this.emit("pressure", { state: "high", pending: this.pendingCount, dropped: this.droppedCount });
    }

    if (this.pressureActive) {
      if (this.strategy === "drop") {
        this.droppedCount++;
        this.pendingCount--;
        return false;
      }
      if (this.strategy === "sample") {
        this._sampleCounter++;
        if (this._sampleCounter % this.sampleRate !== 0) {
          this.droppedCount++;
          this.pendingCount--;
          return false;
        }
      }
      // "pause" strategy: caller should check pressureActive
    }

    return true;
  }

  /** Mark a tick as processed. */
  release() {
    this.pendingCount = Math.max(0, this.pendingCount - 1);

    if (this.pressureActive && this.pendingCount <= this.lowWaterMark) {
      this.pressureActive = false;
      this.emit("pressure", { state: "low", pending: this.pendingCount, dropped: this.droppedCount });
    }
  }

  get stats() {
    return {
      pending: this.pendingCount,
      dropped: this.droppedCount,
      pressureActive: this.pressureActive,
      strategy: this.strategy,
    };
  }
}

// ─── Simulated Market Feed ──────────────────────────────

/**
 * Generates realistic-looking synthetic tick data using geometric Brownian motion.
 */
class SimulatedFeed extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.symbol       - Ticker symbol
   * @param {number} opts.startPrice   - Initial price
   * @param {number} opts.volatility   - Annualized vol (e.g. 0.20)
   * @param {number} opts.intervalMs   - Tick interval in ms
   * @param {number} opts.ticksPerDay  - Ticks per trading day (for vol scaling)
   */
  constructor(opts = {}) {
    super();
    this.symbol = opts.symbol || "SIM";
    this.price = opts.startPrice || 100;
    this.volatility = opts.volatility || 0.20;
    this.intervalMs = opts.intervalMs || 10;
    this.ticksPerDay = opts.ticksPerDay || 6500; // ~6.5hrs * ~1000 ticks/hr
    this.ticksSent = 0;
    this._timer = null;
    this._running = false;

    // Scale vol to per-tick
    this._tickVol = this.volatility / Math.sqrt(252 * this.ticksPerDay);
    this._drift = 0.0001 / this.ticksPerDay; // small positive drift
  }

  /** Generate a single tick and advance price. */
  _generateTick() {
    // Geometric Brownian motion step
    const z = this._gaussianRandom();
    const ret = this._drift + this._tickVol * z;
    this.price = this.price * (1 + ret);
    this.price = Math.max(this.price, 0.01); // floor

    // Randomized volume (log-normal-ish)
    const baseVol = 1000;
    const volume = Math.round(baseVol * Math.exp(0.5 * this._gaussianRandom()));

    const tick = {
      symbol: this.symbol,
      price: Math.round(this.price * 100) / 100,
      volume,
      timestamp: Date.now(),
    };

    this.ticksSent++;
    this.emit("tick", tick);
    return tick;
  }

  /** Box-Muller transform for Gaussian random. */
  _gaussianRandom() {
    let u, v, s;
    do {
      u = Math.random() * 2 - 1;
      v = Math.random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return u * Math.sqrt(-2 * Math.log(s) / s);
  }

  /** Start emitting ticks at configured interval. */
  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this._generateTick(), this.intervalMs);
    this.emit("started", { symbol: this.symbol, price: this.price });
  }

  /** Stop emitting ticks. */
  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.emit("stopped", { ticksSent: this.ticksSent });
  }

  /** Generate N ticks synchronously (for testing). */
  generateSync(n) {
    const ticks = [];
    for (let i = 0; i < n; i++) {
      ticks.push(this._generateTick());
    }
    return ticks;
  }
}

// ─── WebSocket Server Stub ──────────────────────────────

/**
 * Minimal WebSocket-like server for distributing ticks to connected clients.
 * Uses raw HTTP upgrade + minimal framing (for zero-dep requirement).
 * In production, replace with a proper ws library.
 */
class WebSocketStub extends EventEmitter {
  constructor(port = 8080) {
    super();
    this.port = port;
    this.clients = new Set();
    this.server = null;
  }

  start() {
    this.server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        clients: this.clients.size,
        message: "Connect via WebSocket for live data. GET /health for status.",
      }));
    });

    this.server.on("upgrade", (req, socket) => {
      // Minimal WebSocket handshake (RFC 6455)
      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      const acceptKey = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-5AB5DC11650A")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        "\r\n"
      );

      this.clients.add(socket);
      this.emit("connection", socket);

      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => {
        this.clients.delete(socket);
        socket.destroy();
      });
    });

    this.server.listen(this.port, () => {
      this.emit("listening", { port: this.port });
    });
  }

  /** Send a WebSocket text frame to a single socket. */
  _sendFrame(socket, data) {
    const payload = Buffer.from(JSON.stringify(data), "utf8");
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      socket.write(Buffer.concat([header, payload]));
    } catch {
      this.clients.delete(socket);
    }
  }

  /** Broadcast data to all connected clients. */
  broadcast(data) {
    for (const socket of this.clients) {
      this._sendFrame(socket, data);
    }
  }

  stop() {
    for (const socket of this.clients) {
      socket.destroy();
    }
    this.clients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

// ─── Streaming Pipeline ─────────────────────────────────

/**
 * Orchestrates the full streaming pipeline:
 *   Feed → TickBuffer → Indicators → Signals → Output/WS
 *
 * Wires together all components with event-driven data flow.
 */
class StreamingPipeline extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.maxTicks         - Tick buffer size
   * @param {number} opts.backpressureHWM  - High-water mark
   * @param {string} opts.backpressureStrategy - "drop" | "sample" | "pause"
   */
  constructor(opts = {}) {
    super();

    // Core components
    this.buffer = new TickBuffer({ maxTicks: opts.maxTicks || 10_000, batchSize: opts.batchSize || 50 });
    this.backpressure = new BackpressureController({
      highWaterMark: opts.backpressureHWM || 200,
      lowWaterMark: opts.backpressureLWM || 50,
      strategy: opts.backpressureStrategy || "drop",
    });
    this.signalGen = new SignalGenerator();

    // Indicators — all incremental O(1) per tick
    this.indicators = {
      sma20: new SMA(20),
      sma50: new SMA(50),
      ema20: new EMA(20),
      ema50: new EMA(50),
      rsi: new RSI(14),
      vwap: new VWAP(),
    };

    this.signalLog = [];
    this.stats = { ticksProcessed: 0, ticksDropped: 0, signalsGenerated: 0, startTime: null };

    // Wire events
    this._wireEvents();
  }

  _wireEvents() {
    this.buffer.on("tick", (tick) => {
      if (!this.backpressure.acquire()) {
        this.stats.ticksDropped++;
        return;
      }

      // Update all indicators
      for (const ind of Object.values(this.indicators)) {
        ind.update(tick);
      }

      // Evaluate signals
      const signal = this.signalGen.evaluate(tick, this.indicators);
      if (signal) {
        this.signalLog.push(signal);
        this.stats.signalsGenerated++;
        this.emit("signal", signal);
      }

      this.stats.ticksProcessed++;
      this.backpressure.release();

      this.emit("processed", {
        tick,
        indicators: this._snapshotIndicators(),
        signal: signal || null,
      });
    });

    this.backpressure.on("pressure", (info) => {
      this.emit("backpressure", info);
    });

    this.signalGen.on("signal", (signal) => {
      // Pipeline-level signal event already emitted above
    });
  }

  _snapshotIndicators() {
    const snap = {};
    for (const [name, ind] of Object.entries(this.indicators)) {
      snap[name] = { value: ind.value, ready: ind.ready };
    }
    return snap;
  }

  /** Ingest a single tick into the pipeline. */
  ingest(tick) {
    if (!this.stats.startTime) this.stats.startTime = Date.now();
    return this.buffer.ingest(tick);
  }

  /** Connect a SimulatedFeed to this pipeline. */
  connectFeed(feed) {
    feed.on("tick", (tick) => this.ingest(tick));
    return this;
  }

  /** Connect a WebSocketStub for live distribution. */
  connectWebSocket(ws) {
    this.on("processed", (data) => {
      ws.broadcast({
        type: "tick",
        symbol: data.tick.symbol,
        price: data.tick.price,
        volume: data.tick.volume,
        indicators: data.indicators,
        signal: data.signal,
      });
    });
    return this;
  }

  /** Get current pipeline stats. */
  getStats() {
    const elapsed = this.stats.startTime ? (Date.now() - this.stats.startTime) / 1000 : 0;
    return {
      ...this.stats,
      elapsed: elapsed.toFixed(2) + "s",
      throughput: elapsed > 0 ? (this.stats.ticksProcessed / elapsed).toFixed(0) + " ticks/s" : "N/A",
      backpressure: this.backpressure.stats,
      bufferSize: this.buffer.size,
      signals: this.signalLog.length,
    };
  }

  /** Add a custom indicator to the pipeline. */
  addIndicator(name, indicator) {
    if (!(indicator instanceof IncrementalIndicator)) {
      throw new Error("Indicator must extend IncrementalIndicator");
    }
    this.indicators[name] = indicator;
    return this;
  }

  destroy() {
    this.buffer.destroy();
    this.backpressure.removeAllListeners();
    this.signalGen.removeAllListeners();
    this.removeAllListeners();
  }
}

// ─── CLI Demo ───────────────────────────────────────────

async function runDemo(tickCount = 1000, wsPort = 0) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Streaming Data Pipeline — Real-Time Demo");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Ticks: ${tickCount} | WebSocket: ${wsPort > 0 ? `port ${wsPort}` : "disabled"}`);
  console.log("");

  // Create pipeline
  const pipeline = new StreamingPipeline({
    maxTicks: 10_000,
    backpressureHWM: 500,
    backpressureStrategy: "drop",
  });

  // Create simulated feed
  const feed = new SimulatedFeed({
    symbol: "SIM",
    startPrice: 150.00,
    volatility: 0.25,
  });

  // Track signals
  const signals = [];
  pipeline.on("signal", (sig) => {
    signals.push(sig);
  });

  // Optional WebSocket
  let ws = null;
  if (wsPort > 0) {
    ws = new WebSocketStub(wsPort);
    pipeline.connectWebSocket(ws);
    ws.start();
    console.log(`  WebSocket server listening on port ${wsPort}`);
    console.log("");
  }

  // Run synchronous simulation
  console.log("  Processing ticks...\n");
  const startTime = performance.now();

  const ticks = feed.generateSync(tickCount);
  for (const tick of ticks) {
    pipeline.ingest(tick);
  }

  const elapsed = performance.now() - startTime;

  // ─── Results ───

  console.log("  ┌─ Indicator Summary ─────────────────────────────────┐");
  for (const [name, ind] of Object.entries(pipeline.indicators)) {
    const val = ind.ready ? ind.value.toFixed(4) : "warming up";
    const pad = name.padEnd(8);
    console.log(`  │  ${pad} ${ind.name.padEnd(10)} = ${val.padStart(12)}  │`);
  }
  console.log("  └────────────────────────────────────────────────────┘");
  console.log("");

  // Signal summary
  console.log(`  Signals generated: ${signals.length}`);
  if (signals.length > 0) {
    console.log("  ┌─ Recent Signals ──────────────────────────────────────┐");
    const recent = signals.slice(-8);
    for (const sig of recent) {
      const str = `${sig.type.padEnd(16)} str=${sig.strength.toFixed(2)} | ${sig.reason}`;
      console.log(`  │  ${str.padEnd(54)}│`);
    }
    console.log("  └───────────────────────────────────────────────────────┘");
  }
  console.log("");

  // Stats
  const stats = pipeline.getStats();
  console.log("  ┌─ Pipeline Stats ───────────────────────────────────────┐");
  console.log(`  │  Ticks processed:  ${String(stats.ticksProcessed).padStart(8)}                       │`);
  console.log(`  │  Ticks dropped:    ${String(stats.ticksDropped).padStart(8)}                       │`);
  console.log(`  │  Buffer size:      ${String(stats.bufferSize).padStart(8)}                       │`);
  console.log(`  │  Signals:          ${String(stats.signals).padStart(8)}                       │`);
  console.log(`  │  Wall time:        ${(elapsed.toFixed(1) + " ms").padStart(8 + 3)}                    │`);
  console.log(`  │  Throughput:       ${(Math.round(tickCount / (elapsed / 1000)) + " ticks/s").padStart(8 + 9)}             │`);
  console.log("  └────────────────────────────────────────────────────────┘");

  // Price path summary
  const firstPrice = ticks[0].price;
  const lastPrice = ticks[ticks.length - 1].price;
  const pctChange = ((lastPrice - firstPrice) / firstPrice * 100).toFixed(2);
  console.log("");
  console.log(`  Price: $${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)} (${pctChange}%)`);
  console.log("");

  // Cleanup
  pipeline.destroy();
  feed.stop();
  if (ws) ws.stop();

  console.log("  Done.");
}

// ─── CLI Entry Point ────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith("streaming.mjs") ||
  process.argv[1].endsWith("streaming")
);

if (isMain) {
  const args = process.argv.slice(2);
  let tickCount = 1000;
  let wsPort = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ticks" && args[i + 1]) tickCount = parseInt(args[++i], 10);
    if (args[i] === "--ws" && args[i + 1]) wsPort = parseInt(args[++i], 10);
  }

  runDemo(tickCount, wsPort).catch((err) => {
    console.error("Pipeline error:", err);
    process.exit(1);
  });
}

// ─── Exports ────────────────────────────────────────────

export {
  StreamingPipeline,
  TickBuffer,
  IncrementalIndicator,
  RingBuffer,
  EMA,
  SMA,
  RSI,
  VWAP,
  SignalGenerator,
  BackpressureController,
  SimulatedFeed,
  WebSocketStub,
};
