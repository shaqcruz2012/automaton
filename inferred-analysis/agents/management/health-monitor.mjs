#!/usr/bin/env node
/**
 * Auto-Recovery & Health Monitoring System
 *
 * Monitors service health, system resources, and auto-restarts crashed processes.
 * Tracks health history with rolling window and escalates alerts.
 *
 * Usage:
 *   node agents/management/health-monitor.mjs                  # Run once
 *   node agents/management/health-monitor.mjs --watch          # Continuous (60s default)
 *   node agents/management/health-monitor.mjs --watch 30       # Continuous (30s interval)
 *   node agents/management/health-monitor.mjs --json           # JSON output
 *   node agents/management/health-monitor.mjs --auto-recover   # Attempt restarts
 *   node agents/management/health-monitor.mjs --telegram       # Send alerts via Telegram
 *
 * Environment:
 *   PAPERCLIP_URL=http://localhost:3100
 *   POSTGRES_HOST=localhost
 *   POSTGRES_PORT=5432
 *   HEALTH_CHECK_INTERVAL=60
 *   HEALTH_HISTORY_WINDOW=3600
 *   DEADMAN_TIMEOUT=300
 *   TELEGRAM_BOT_TOKEN=your-bot-token
 *   TELEGRAM_CHAT_ID=your-chat-id
 */

import { execSync, spawn } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import os from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..");
const ROOT = join(AGENTS_DIR, "..");
const LOG_DIR = join(ROOT, "agents", "outputs");
const HEALTH_LOG = join(LOG_DIR, "health-monitor.log");
const HEARTBEAT_FILE = join(ROOT, ".health-heartbeat");
const HEALTH_HISTORY_FILE = join(ROOT, ".health-history.json");

// ─── Config ──────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    watch: args.includes("--watch")
      ? parseInt(args[args.indexOf("--watch") + 1] || process.env.HEALTH_CHECK_INTERVAL || "60")
      : 0,
    json: args.includes("--json"),
    autoRecover: args.includes("--auto-recover"),
    telegram: args.includes("--telegram"),
    paperclipUrl: process.env.PAPERCLIP_URL || "http://localhost:3100",
    postgresHost: process.env.POSTGRES_HOST || "localhost",
    postgresPort: parseInt(process.env.POSTGRES_PORT || "5432"),
    historyWindow: parseInt(process.env.HEALTH_HISTORY_WINDOW || "3600"),
    deadmanTimeout: parseInt(process.env.DEADMAN_TIMEOUT || "300"),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  };
}

// ─── Alert Levels ────────────────────────────────────────

const AlertLevel = {
  OK: "ok",
  WARN: "warn",
  CRITICAL: "critical",
  EMERGENCY: "emergency",
};

const LEVEL_PRIORITY = {
  [AlertLevel.OK]: 0,
  [AlertLevel.WARN]: 1,
  [AlertLevel.CRITICAL]: 2,
  [AlertLevel.EMERGENCY]: 3,
};

// ─── Logging ─────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.error(line);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(HEALTH_LOG, line + "\n");
  } catch {}
}

// ─── Health History ──────────────────────────────────────

function loadHistory() {
  try {
    if (existsSync(HEALTH_HISTORY_FILE)) {
      return JSON.parse(readFileSync(HEALTH_HISTORY_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveHistory(history) {
  try {
    writeFileSync(HEALTH_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    log(`Failed to save history: ${err.message}`);
  }
}

function pruneHistory(history, windowSeconds) {
  const cutoff = Date.now() - windowSeconds * 1000;
  return history.filter((entry) => entry.timestamp >= cutoff);
}

// ─── Heartbeat / Dead-Man's Switch ──────────────────────

function writeHeartbeat() {
  try {
    writeFileSync(HEARTBEAT_FILE, JSON.stringify({ timestamp: Date.now(), pid: process.pid }));
  } catch {}
}

function checkDeadman(timeoutSeconds) {
  try {
    if (!existsSync(HEARTBEAT_FILE)) {
      return { alive: false, reason: "No heartbeat file found" };
    }
    const data = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf-8"));
    const elapsed = (Date.now() - data.timestamp) / 1000;
    if (elapsed > timeoutSeconds) {
      return {
        alive: false,
        reason: `Last heartbeat was ${Math.round(elapsed)}s ago (threshold: ${timeoutSeconds}s)`,
        lastSeen: new Date(data.timestamp).toISOString(),
      };
    }
    return { alive: true, elapsed: Math.round(elapsed) };
  } catch (err) {
    return { alive: false, reason: `Heartbeat read error: ${err.message}` };
  }
}

// ─── Service Checks ─────────────────────────────────────

async function checkDaemon() {
  const pidFile = join(ROOT, ".daemon.pid");
  const result = { service: "daemon", status: AlertLevel.OK, details: {} };

  try {
    if (!existsSync(pidFile)) {
      result.status = AlertLevel.CRITICAL;
      result.details.error = "PID file not found — daemon is not running";
      result.details.pidFile = pidFile;
      return result;
    }

    const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
    result.details.pid = pid;

    try {
      // Signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      result.details.running = true;
    } catch {
      result.status = AlertLevel.CRITICAL;
      result.details.running = false;
      result.details.error = `PID ${pid} is not running (stale PID file)`;
    }
  } catch (err) {
    result.status = AlertLevel.WARN;
    result.details.error = `Could not check daemon: ${err.message}`;
  }

  return result;
}

async function checkPaperclip(baseUrl) {
  const result = { service: "paperclip", status: AlertLevel.OK, details: { url: baseUrl } };

  try {
    const start = Date.now();
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - start;
    result.details.latency_ms = latency;

    if (!res.ok) {
      result.status = AlertLevel.CRITICAL;
      result.details.error = `HTTP ${res.status}`;
      return result;
    }

    const body = await res.json();
    result.details.response = body;

    if (latency > 3000) {
      result.status = AlertLevel.WARN;
      result.details.warning = "High latency (>3s)";
    }
  } catch (err) {
    result.status = AlertLevel.CRITICAL;
    result.details.error = `Unreachable: ${err.message}`;
  }

  return result;
}

async function checkPostgres(host, port) {
  const result = { service: "postgresql", status: AlertLevel.OK, details: { host, port } };

  try {
    // Try pg_isready first
    const output = execSync(`pg_isready -h ${host} -p ${port} 2>&1`, {
      timeout: 5000,
      encoding: "utf-8",
    });
    result.details.output = output.trim();
    if (!output.includes("accepting connections")) {
      result.status = AlertLevel.WARN;
      result.details.warning = "PostgreSQL not accepting connections";
    }
  } catch {
    // Fallback: try TCP connect
    try {
      const output = execSync(
        `(echo > /dev/tcp/${host}/${port}) 2>/dev/null && echo open || echo closed`,
        { timeout: 5000, encoding: "utf-8", shell: "/bin/bash" }
      );
      if (output.trim() === "open") {
        result.details.output = "TCP port open (pg_isready unavailable)";
      } else {
        result.status = AlertLevel.CRITICAL;
        result.details.error = `Port ${port} is closed`;
      }
    } catch {
      result.status = AlertLevel.CRITICAL;
      result.details.error = `Cannot connect to PostgreSQL at ${host}:${port}`;
    }
  }

  return result;
}

async function checkApiEndpoints(baseUrl) {
  const endpoints = [
    { path: "/api/health", label: "health" },
    { path: "/api/companies", label: "companies" },
  ];

  const results = [];

  for (const ep of endpoints) {
    const result = {
      service: `api:${ep.label}`,
      status: AlertLevel.OK,
      details: { url: `${baseUrl}${ep.path}` },
    };

    try {
      const start = Date.now();
      const res = await fetch(`${baseUrl}${ep.path}`, {
        signal: AbortSignal.timeout(5000),
      });
      result.details.latency_ms = Date.now() - start;
      result.details.httpStatus = res.status;

      if (!res.ok) {
        result.status = res.status >= 500 ? AlertLevel.CRITICAL : AlertLevel.WARN;
        result.details.error = `HTTP ${res.status}`;
      }
    } catch (err) {
      result.status = AlertLevel.CRITICAL;
      result.details.error = err.message;
    }

    results.push(result);
  }

  return results;
}

// ─── System Resource Monitoring ─────────────────────────

function checkMemory() {
  const result = { service: "memory", status: AlertLevel.OK, details: {} };

  // System memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const usedPct = (usedMem / totalMem) * 100;

  result.details.system = {
    total_mb: Math.round(totalMem / 1024 / 1024),
    used_mb: Math.round(usedMem / 1024 / 1024),
    free_mb: Math.round(freeMem / 1024 / 1024),
    used_pct: Math.round(usedPct * 10) / 10,
  };

  // Process memory
  const proc = process.memoryUsage();
  result.details.process = {
    rss_mb: Math.round(proc.rss / 1024 / 1024),
    heapUsed_mb: Math.round(proc.heapUsed / 1024 / 1024),
    heapTotal_mb: Math.round(proc.heapTotal / 1024 / 1024),
    external_mb: Math.round(proc.external / 1024 / 1024),
  };

  if (usedPct > 95) {
    result.status = AlertLevel.EMERGENCY;
    result.details.alert = "System memory critically low (<5% free)";
  } else if (usedPct > 90) {
    result.status = AlertLevel.CRITICAL;
    result.details.alert = "System memory very low (<10% free)";
  } else if (usedPct > 80) {
    result.status = AlertLevel.WARN;
    result.details.alert = "System memory usage high (>80%)";
  }

  return result;
}

function checkCpu() {
  const result = { service: "cpu", status: AlertLevel.OK, details: {} };

  const cpus = os.cpus();
  result.details.cores = cpus.length;
  result.details.model = cpus[0]?.model || "unknown";

  // Calculate load averages
  const loadAvg = os.loadavg();
  result.details.loadAvg = {
    "1m": Math.round(loadAvg[0] * 100) / 100,
    "5m": Math.round(loadAvg[1] * 100) / 100,
    "15m": Math.round(loadAvg[2] * 100) / 100,
  };

  const loadPerCore = loadAvg[0] / cpus.length;
  result.details.loadPerCore = Math.round(loadPerCore * 100) / 100;

  if (loadPerCore > 2.0) {
    result.status = AlertLevel.EMERGENCY;
    result.details.alert = "CPU load extremely high (>2x cores)";
  } else if (loadPerCore > 1.5) {
    result.status = AlertLevel.CRITICAL;
    result.details.alert = "CPU load very high (>1.5x cores)";
  } else if (loadPerCore > 1.0) {
    result.status = AlertLevel.WARN;
    result.details.alert = "CPU load elevated (>1x cores)";
  }

  return result;
}

function checkDisk() {
  const result = { service: "disk", status: AlertLevel.OK, details: {} };

  try {
    const output = execSync("df -h / | tail -1", { encoding: "utf-8", timeout: 5000 });
    const parts = output.trim().split(/\s+/);
    // Typical df output: /dev/sda1  50G  30G  20G  60%  /
    const usedPctStr = parts.find((p) => p.endsWith("%"));
    const usedPct = usedPctStr ? parseInt(usedPctStr) : null;

    result.details.filesystem = parts[0];
    result.details.size = parts[1];
    result.details.used = parts[2];
    result.details.available = parts[3];
    result.details.used_pct = usedPct;

    if (usedPct !== null) {
      if (usedPct > 95) {
        result.status = AlertLevel.EMERGENCY;
        result.details.alert = "Disk almost full (>95%)";
      } else if (usedPct > 90) {
        result.status = AlertLevel.CRITICAL;
        result.details.alert = "Disk usage critical (>90%)";
      } else if (usedPct > 80) {
        result.status = AlertLevel.WARN;
        result.details.alert = "Disk usage high (>80%)";
      }
    }
  } catch (err) {
    result.status = AlertLevel.WARN;
    result.details.error = `Could not check disk: ${err.message}`;
  }

  return result;
}

// ─── Auto-Recovery ──────────────────────────────────────

async function restartDaemon() {
  const result = { action: "restart_daemon", success: false, details: {} };

  try {
    // Clean up stale PID file
    const pidFile = join(ROOT, ".daemon.pid");
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
      try {
        process.kill(pid, "SIGTERM");
        result.details.killed = pid;
      } catch {}
    }

    // Start daemon in background
    const daemonPath = join(AGENTS_DIR, "daemon.mjs");
    if (!existsSync(daemonPath)) {
      result.details.error = "daemon.mjs not found";
      return result;
    }

    const child = spawn("node", [daemonPath], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    result.success = true;
    result.details.newPid = child.pid;
    log(`Restarted daemon with PID ${child.pid}`);
  } catch (err) {
    result.details.error = err.message;
    log(`Failed to restart daemon: ${err.message}`);
  }

  return result;
}

async function autoRecover(checks) {
  const actions = [];

  for (const check of checks) {
    if (check.status === AlertLevel.OK || check.status === AlertLevel.WARN) continue;

    if (check.service === "daemon" && !check.details.running) {
      log("Auto-recovery: attempting daemon restart");
      const action = await restartDaemon();
      actions.push(action);
    }

    // For other services, log the issue but don't attempt restart
    // (PostgreSQL, Paperclip need their own restart mechanisms)
    if (check.service === "paperclip") {
      log(`Auto-recovery: Paperclip is down at ${check.details.url} — manual restart needed`);
      actions.push({
        action: "alert_paperclip_down",
        success: false,
        details: { message: "Paperclip requires manual restart" },
      });
    }

    if (check.service === "postgresql") {
      log("Auto-recovery: PostgreSQL is down — manual restart needed");
      actions.push({
        action: "alert_postgresql_down",
        success: false,
        details: { message: "PostgreSQL requires manual restart" },
      });
    }
  }

  return actions;
}

// ─── Alert Escalation ───────────────────────────────────

function escalateLevel(checks) {
  let worst = AlertLevel.OK;

  for (const check of checks) {
    if (LEVEL_PRIORITY[check.status] > LEVEL_PRIORITY[worst]) {
      worst = check.status;
    }
  }

  return worst;
}

function formatAlert(level, checks, recoveryActions) {
  const icon = {
    [AlertLevel.OK]: "[OK]",
    [AlertLevel.WARN]: "[WARN]",
    [AlertLevel.CRITICAL]: "[CRITICAL]",
    [AlertLevel.EMERGENCY]: "[EMERGENCY]",
  };

  const lines = [`${icon[level]} Health Monitor Report`];
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push(`Overall: ${level.toUpperCase()}`);
  lines.push("");

  for (const check of checks) {
    const marker = check.status === AlertLevel.OK ? "+" : check.status === AlertLevel.WARN ? "~" : "!";
    lines.push(`  [${marker}] ${check.service}: ${check.status}`);
    if (check.details.error) lines.push(`      Error: ${check.details.error}`);
    if (check.details.alert) lines.push(`      Alert: ${check.details.alert}`);
    if (check.details.warning) lines.push(`      Warning: ${check.details.warning}`);
  }

  if (recoveryActions && recoveryActions.length > 0) {
    lines.push("");
    lines.push("Recovery Actions:");
    for (const action of recoveryActions) {
      const mark = action.success ? "+" : "!";
      lines.push(`  [${mark}] ${action.action}: ${action.success ? "success" : "failed"}`);
      if (action.details.error) lines.push(`      ${action.details.error}`);
      if (action.details.newPid) lines.push(`      New PID: ${action.details.newPid}`);
    }
  }

  return lines.join("\n");
}

// ─── Telegram Alerting ──────────────────────────────────

async function sendTelegramAlert(token, chatId, message) {
  if (!token || !chatId) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch (err) {
    log(`Telegram alert failed: ${err.message}`);
    return false;
  }
}

// ─── HealthMonitor Class ────────────────────────────────

export class HealthMonitor {
  constructor(config = {}) {
    this.config = {
      paperclipUrl: config.paperclipUrl || process.env.PAPERCLIP_URL || "http://localhost:3100",
      postgresHost: config.postgresHost || process.env.POSTGRES_HOST || "localhost",
      postgresPort: parseInt(config.postgresPort || process.env.POSTGRES_PORT || "5432"),
      historyWindow: parseInt(config.historyWindow || process.env.HEALTH_HISTORY_WINDOW || "3600"),
      deadmanTimeout: parseInt(config.deadmanTimeout || process.env.DEADMAN_TIMEOUT || "300"),
      checkInterval: parseInt(config.checkInterval || process.env.HEALTH_CHECK_INTERVAL || "60"),
      telegramToken: config.telegramToken || process.env.TELEGRAM_BOT_TOKEN || "",
      telegramChatId: config.telegramChatId || process.env.TELEGRAM_CHAT_ID || "",
      autoRecoverEnabled: config.autoRecover || false,
    };
    this.history = loadHistory();
    this._timer = null;
    this._lastLevel = AlertLevel.OK;
  }

  /**
   * Run all health checks and return results.
   */
  async checkAll() {
    const checks = [];

    // Service checks
    checks.push(await checkDaemon());
    checks.push(await checkPaperclip(this.config.paperclipUrl));
    checks.push(await checkPostgres(this.config.postgresHost, this.config.postgresPort));

    // API endpoint checks
    const apiChecks = await checkApiEndpoints(this.config.paperclipUrl);
    checks.push(...apiChecks);

    // System resource checks
    checks.push(checkMemory());
    checks.push(checkCpu());
    checks.push(checkDisk());

    // Dead-man's switch
    const deadman = checkDeadman(this.config.deadmanTimeout);
    checks.push({
      service: "deadman_switch",
      status: deadman.alive ? AlertLevel.OK : AlertLevel.EMERGENCY,
      details: deadman,
    });

    // Write heartbeat after successful check
    writeHeartbeat();

    return checks;
  }

  /**
   * Get aggregated status from latest checks.
   */
  async getStatus() {
    const checks = await this.checkAll();
    const level = escalateLevel(checks);

    const entry = {
      timestamp: Date.now(),
      time: new Date().toISOString(),
      level,
      checks: checks.map((c) => ({
        service: c.service,
        status: c.status,
      })),
    };

    // Record in history
    this.history.push(entry);
    this.history = pruneHistory(this.history, this.config.historyWindow);
    saveHistory(this.history);

    return {
      level,
      checks,
      history: {
        entries: this.history.length,
        window_seconds: this.config.historyWindow,
        worst_recent: this._worstInHistory(),
      },
    };
  }

  /**
   * Run checks and auto-recover any failed services.
   */
  async autoRecover() {
    const checks = await this.checkAll();
    const level = escalateLevel(checks);

    let recoveryActions = [];
    if (level !== AlertLevel.OK) {
      recoveryActions = await autoRecover(checks);
    }

    return {
      level,
      checks,
      recoveryActions,
    };
  }

  /**
   * Start continuous monitoring.
   */
  start() {
    if (this._timer) return;

    log(`Health monitor started (interval: ${this.config.checkInterval}s)`);
    this._runCycle();
    this._timer = setInterval(() => this._runCycle(), this.config.checkInterval * 1000);
  }

  /**
   * Stop continuous monitoring.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      log("Health monitor stopped");
    }
  }

  async _runCycle() {
    try {
      const result = this.config.autoRecoverEnabled
        ? await this.autoRecover()
        : await this.getStatus();

      const level = result.level;

      // Only send alerts on escalation or critical+
      const shouldAlert =
        LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[AlertLevel.CRITICAL] ||
        LEVEL_PRIORITY[level] > LEVEL_PRIORITY[this._lastLevel];

      if (shouldAlert && this.config.telegramToken) {
        const msg = formatAlert(level, result.checks, result.recoveryActions);
        await sendTelegramAlert(this.config.telegramToken, this.config.telegramChatId, msg);
      }

      this._lastLevel = level;
    } catch (err) {
      log(`Health check cycle error: ${err.message}`);
    }
  }

  _worstInHistory() {
    let worst = AlertLevel.OK;
    for (const entry of this.history) {
      if (LEVEL_PRIORITY[entry.level] > LEVEL_PRIORITY[worst]) {
        worst = entry.level;
      }
    }
    return worst;
  }
}

// ─── CLI ─────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  const monitor = new HealthMonitor({
    paperclipUrl: opts.paperclipUrl,
    postgresHost: opts.postgresHost,
    postgresPort: opts.postgresPort,
    historyWindow: opts.historyWindow,
    deadmanTimeout: opts.deadmanTimeout,
    checkInterval: opts.watch || 60,
    telegramToken: opts.telegramToken,
    telegramChatId: opts.telegramChatId,
    autoRecover: opts.autoRecover,
  });

  if (opts.watch) {
    // Continuous mode
    log(`Starting continuous health monitoring (every ${opts.watch}s)`);

    process.on("SIGINT", () => {
      monitor.stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      monitor.stop();
      process.exit(0);
    });

    monitor.start();
  } else {
    // Single run
    let result;
    if (opts.autoRecover) {
      result = await monitor.autoRecover();
    } else {
      result = await monitor.getStatus();
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const msg = formatAlert(result.level, result.checks, result.recoveryActions);
      console.log(msg);
    }

    // Send telegram if requested and level is concerning
    if (opts.telegram && LEVEL_PRIORITY[result.level] >= LEVEL_PRIORITY[AlertLevel.WARN]) {
      const msg = formatAlert(result.level, result.checks, result.recoveryActions);
      const sent = await sendTelegramAlert(opts.telegramToken, opts.telegramChatId, msg);
      if (sent) log("Alert sent via Telegram");
      else log("Telegram alert not sent (missing token/chatId or delivery failed)");
    }

    // Exit code reflects health
    process.exit(result.level === AlertLevel.OK ? 0 : 1);
  }
}

// Run if invoked directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("health-monitor.mjs") ||
    process.argv[1] === fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(2);
  });
}
