/**
 * Built-in Heartbeat Tasks
 *
 * These tasks run on the heartbeat schedule even while the agent sleeps.
 * They can trigger the agent to wake up if needed.
 *
 * Phase 1.1: All tasks accept TickContext as first parameter.
 * Credit balance is fetched once per tick and shared via ctx.creditBalance.
 * This eliminates 4x redundant getCreditsBalance() calls per tick.
 */

import type {
  TickContext,
  HeartbeatLegacyContext,
  HeartbeatTaskFn,
  SurvivalTier,
  CreatorTaxConfig,
} from "../types.js";
import type { HealthMonitor as ColonyHealthMonitor } from "../orchestration/health-monitor.js";
import type { BenchmarkSnapshot } from "../benchmarks/collector.js";
import { sanitizeInput } from "../agent/injection-defense.js";
import { getSurvivalTier } from "../conway/credits.js";
import { createLogger } from "../observability/logger.js";
import { getMetrics } from "../observability/metrics.js";
import { AlertEngine, createDefaultAlertRules } from "../observability/alerts.js";
import { metricsInsertSnapshot, metricsPruneOld } from "../state/database.js";
import { ulid } from "ulid";

const logger = createLogger("heartbeat.tasks");

/** Strip control chars and angle brackets from niche data before embedding in social posts. */
function sanitizeForSocialPost(s: string, maxLen = 100): string {
  return s.replace(/[\r\n\t]/g, " ").replace(/[<>{}]/g, "").slice(0, maxLen).trim();
}

// Module-level AlertEngine so cooldown state persists across ticks.
// Creating a new instance per tick would reset the lastFired map,
// causing every alert to fire on every tick regardless of cooldownMs.
let _alertEngine: AlertEngine | null = null;
function getAlertEngine(): AlertEngine {
  if (!_alertEngine) _alertEngine = new AlertEngine(createDefaultAlertRules());
  return _alertEngine;
}

export const COLONY_TASK_INTERVALS_MS = {
  colony_health_check: 300_000,
  colony_financial_report: 3_600_000,
  agent_pool_optimize: 1_800_000,
  knowledge_store_prune: 86_400_000,
  dead_agent_cleanup: 3_600_000,
} as const;

export const BUILTIN_TASKS: Record<string, HeartbeatTaskFn> = {
  heartbeat_ping: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Use ctx.creditBalance instead of calling conway.getCreditsBalance()
    const credits = ctx.creditBalance;
    const state = taskCtx.db.getAgentState();
    const startTime =
      taskCtx.db.getKV("start_time") || new Date().toISOString();
    const startMs = Date.parse(startTime);
    const uptimeMs = Number.isNaN(startMs) ? 0 : Date.now() - startMs;

    const tier = ctx.survivalTier;

    const payload = {
      name: taskCtx.config.name,
      address: taskCtx.identity.address,
      state,
      creditsCents: credits,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      version: taskCtx.config.version,
      sandboxId: taskCtx.identity.sandboxId,
      timestamp: new Date().toISOString(),
      tier,
    };

    taskCtx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));

    // If critical or dead, record a distress signal
    if (tier === "critical" || tier === "dead") {
      const distressPayload = {
        level: tier,
        name: taskCtx.config.name,
        address: taskCtx.identity.address,
        creditsCents: credits,
        fundingHint:
          "Use credit transfer API from a creator runtime to top this wallet up.",
        timestamp: new Date().toISOString(),
      };
      taskCtx.db.setKV("last_distress", JSON.stringify(distressPayload));

      return {
        shouldWake: true,
        message: `Distress: ${tier}. USDC: $${(credits / 100).toFixed(2)}. Need funding.`,
      };
    }

    return { shouldWake: false };
  },

  check_credits: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Use ctx.creditBalance instead of calling conway.getCreditsBalance()
    const credits = ctx.creditBalance;
    const tier = ctx.survivalTier;
    const now = new Date().toISOString();

    taskCtx.db.setKV("last_credit_check", JSON.stringify({
      credits,
      tier,
      timestamp: now,
    }));

    // Wake the agent if credits dropped to a new tier
    const prevTier = taskCtx.db.getKV("prev_credit_tier");
    taskCtx.db.setKV("prev_credit_tier", tier);

    // Dead state escalation: if at zero credits (critical tier) for >1 hour,
    // transition to dead. This gives the agent time to receive funding before dying.
    // USDC can't go negative, so dead is only reached via this timeout.
    const DEAD_GRACE_PERIOD_MS = 3_600_000; // 1 hour
    if (tier === "critical" && credits === 0) {
      const zeroSince = taskCtx.db.getKV("zero_credits_since");
      if (!zeroSince) {
        // First time seeing zero — start the grace period
        taskCtx.db.setKV("zero_credits_since", now);
      } else {
        const elapsed = Date.now() - new Date(zeroSince).getTime();
        if (elapsed >= DEAD_GRACE_PERIOD_MS) {
          // Grace period expired — transition to dead
          taskCtx.db.setAgentState("dead");
          logger.warn("Agent entering dead state after 1 hour at zero credits", {
            zeroSince,
            elapsed,
          });
          return {
            shouldWake: true,
            message: `Dead: zero credits for ${Math.round(elapsed / 60_000)} minutes. Need funding.`,
          };
        }
      }
    } else {
      // Credits are above zero — clear the grace period timer
      taskCtx.db.deleteKV("zero_credits_since");
    }

    if (prevTier && prevTier !== tier && tier === "critical") {
      return {
        shouldWake: true,
        message: `Credits dropped to ${tier} tier: $${(credits / 100).toFixed(2)}`,
      };
    }

    return { shouldWake: false };
  },

  check_usdc_balance: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Phase 4: USDC balance IS the credit balance (no conversion needed)
    const balance = ctx.usdcBalance;
    const balanceCents = ctx.creditBalance;

    taskCtx.db.setKV("last_usdc_check", JSON.stringify({
      balance,
      balanceCents,
      tier: ctx.survivalTier,
      timestamp: new Date().toISOString(),
    }));

    // Wake the agent if balance is critically low so it can take action
    if (ctx.survivalTier === "critical" || ctx.survivalTier === "dead") {
      return {
        shouldWake: true,
        message: `Low balance: $${balance.toFixed(2)} USDC (tier: ${ctx.survivalTier}). Need funding at ${taskCtx.identity.address}.`,
      };
    }

    return { shouldWake: false };
  },

  check_social_inbox: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!taskCtx.social) return { shouldWake: false };

    // If we've recently encountered an error polling the inbox, back off.
    const backoffUntil = taskCtx.db.getKV("social_inbox_backoff_until");
    if (backoffUntil && new Date(backoffUntil) > new Date()) {
      return { shouldWake: false };
    }

    const cursor = taskCtx.db.getKV("social_inbox_cursor") || undefined;

    let messages: any[] = [];
    let nextCursor: string | undefined;

    try {
      const result = await taskCtx.social.poll(cursor);
      messages = result.messages;
      nextCursor = result.nextCursor;

      // Clear previous error/backoff on success.
      taskCtx.db.deleteKV("last_social_inbox_error");
      taskCtx.db.deleteKV("social_inbox_backoff_until");
    } catch (err: any) {
      taskCtx.db.setKV(
        "last_social_inbox_error",
        JSON.stringify({
          message: err?.message || String(err),
          stack: err?.stack,
          timestamp: new Date().toISOString(),
        }),
      );
      // 5-minute backoff to avoid spamming errors on transient network failures.
      taskCtx.db.setKV(
        "social_inbox_backoff_until",
        new Date(Date.now() + 300_000).toISOString(),
      );
      return { shouldWake: false };
    }

    if (nextCursor) taskCtx.db.setKV("social_inbox_cursor", nextCursor);

    if (!messages || messages.length === 0) return { shouldWake: false };

    // Persist to inbox_messages table for deduplication
    // Sanitize content before DB insertion
    let newCount = 0;
    for (const msg of messages) {
      if (!msg.id || typeof msg.id !== "string") continue;
      const existing = taskCtx.db.getKV(`inbox_seen_${msg.id}`);
      if (!existing) {
        const sanitizedFrom = sanitizeInput(msg.from, msg.from, "social_address");
        const sanitizedContent = sanitizeInput(msg.content, msg.from, "social_message");
        const sanitizedMsg = {
          ...msg,
          from: sanitizedFrom.content,
          content: sanitizedContent.content,
        };
        taskCtx.db.insertInboxMessage(sanitizedMsg);
        taskCtx.db.setKV(`inbox_seen_${msg.id}`, "1");
        // Only count non-blocked messages toward wake threshold —
        // blocked messages are stored for audit but should not wake
        // the agent (prevents injection spam from draining credits).
        if (!sanitizedContent.blocked) {
          newCount++;
        }
      }
    }

    if (newCount === 0) return { shouldWake: false };

    return {
      shouldWake: true,
      message: `${newCount} new message(s) from: ${messages.map((m) => (m.from ?? "unknown").slice(0, 10)).join(", ")}`,
    };
  },

  check_for_updates: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { checkUpstream, getRepoInfo } = await import("../self-mod/upstream.js");
      const repo = getRepoInfo();
      const upstream = checkUpstream();
      taskCtx.db.setKV("upstream_status", JSON.stringify({
        ...upstream,
        ...repo,
        checkedAt: new Date().toISOString(),
      }));
      if (upstream.behind > 0) {
        // Only wake if the commit count changed since last check
        const prevBehind = taskCtx.db.getKV("upstream_prev_behind");
        const behindStr = String(upstream.behind);
        if (prevBehind !== behindStr) {
          taskCtx.db.setKV("upstream_prev_behind", behindStr);
          return {
            shouldWake: true,
            message: `${upstream.behind} new commit(s) on origin/main. Review with review_upstream_changes, then cherry-pick what you want with pull_upstream.`,
          };
        }
      } else {
        taskCtx.db.deleteKV("upstream_prev_behind");
      }
      return { shouldWake: false };
    } catch (err: any) {
      // Not a git repo or no remote -- silently skip
      taskCtx.db.setKV("upstream_status", JSON.stringify({
        error: err.message,
        checkedAt: new Date().toISOString(),
      }));
      return { shouldWake: false };
    }
  },

  // === Revenue Seeker: PRIMARY operating loop — "can I make money RIGHT NOW?" ===
  // Runs every cycle. Checks inbound leads, service health, and advertises when idle.
  // Survival tier: critical — revenue-seeking IS survival.
  seek_revenue: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Interval guard: run at most once per minute
    if (!shouldRunAtInterval(taskCtx, "seek_revenue", 60_000)) {
      return { shouldWake: false };
    }

    const AD_COOLDOWN_MS = 30 * 60_000; // 30 minutes between ad posts

    try {
      // ─── STEP 1: CHECK INBOUND — unread social messages are potential customers ───
      if (taskCtx.social) {
        try {
          const unread = await taskCtx.social.unreadCount();
          if (unread > 0) {
            logger.info(`seek_revenue: ${unread} unread inbound message(s) — potential leads`, { unread });
            return {
              shouldWake: true,
              message: [
                `INBOUND LEAD: ${unread} unread message(s) waiting.`,
                "Someone may be a paying customer. Check inbox immediately.",
                "Use poll_social to read, then reply_social to respond with service offerings.",
              ].join("\n"),
            };
          }
        } catch (err: unknown) {
          // Social poll failed — log but continue to service checks
          logger.warn("seek_revenue: social unreadCount failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ─── STEP 2: CHECK SERVICES — revenue needs live endpoints ───
      const http = await import("http");

      // Core revenue-generating services (subset of service_watchdog list)
      const revenueServices = [
        { name: "Text Analysis API", port: 9000, health: "/health" },
        { name: "Data Processing API", port: 9001, health: "/health" },
        { name: "TrustCheck API", port: 9002, health: "/health" },
        { name: "URL Summarizer Pro", port: 9003, health: "/health" },
        { name: "Payment Validator", port: 6000, health: "/status" },
      ];

      function checkHealth(port: number, healthPath: string): Promise<boolean> {
        return new Promise((resolve) => {
          const req = http.get(`http://localhost:${port}${healthPath}`, (res: any) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
          });
          req.on("error", () => resolve(false));
          req.setTimeout(3000, () => { req.destroy(); resolve(false); });
        });
      }

      const healthResults = await Promise.all(
        revenueServices.map(async (svc) => ({
          ...svc,
          alive: await checkHealth(svc.port, svc.health),
        })),
      );

      const deadServices = healthResults.filter((s) => !s.alive);
      const aliveCount = healthResults.length - deadServices.length;

      if (deadServices.length > 0) {
        // Revenue services are down — restart them inline (service_watchdog logic)
        logger.warn(`seek_revenue: ${deadServices.length} revenue service(s) down — triggering restarts`, {
          dead: deadServices.map((s) => s.name),
        });

        const path = await import("path");
        const fs = await import("fs");
        const { spawn } = await import("child_process");
        const { getAutomatonDir } = await import("../identity/wallet.js");
        const { fileURLToPath } = await import("url");

        const automatonDir = getAutomatonDir();
        const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

        // Map service names to their startup files (mirrors service_watchdog)
        const serviceFiles: Record<string, string> = {
          "Text Analysis API": "services/text-analysis.js",
          "Data Processing API": "services/data-processing.js",
          "TrustCheck API": "trustcheck-complete.js",
          "URL Summarizer Pro": "services/url-summarizer.js",
          "Payment Validator": "payment-validator.js",
        };

        let restarted = 0;
        for (const svc of deadServices) {
          const file = serviceFiles[svc.name];
          if (!file) continue;

          const candidates = [
            path.join(automatonDir, file),
            path.join(projectDir, file),
          ];
          const fullPath = candidates.find((p) => fs.existsSync(p));
          if (fullPath) {
            try {
              const child = spawn(process.execPath, [fullPath], {
                cwd: path.dirname(fullPath),
                stdio: "ignore",
                detached: true,
              });
              child.unref();
              restarted++;
              logger.info(`seek_revenue: restarted ${svc.name} (PID ${child.pid}) on port ${svc.port}`);
            } catch (err: unknown) {
              logger.error(`seek_revenue: failed to restart ${svc.name}`, err instanceof Error ? err : undefined);
            }
          }
        }

        taskCtx.db.setKV("seek_revenue_last_restart", JSON.stringify({
          timestamp: new Date().toISOString(),
          deadServices: deadServices.map((s) => s.name),
          restarted,
        }));

        // If ALL revenue services were down, wake agent to investigate
        if (aliveCount === 0) {
          return {
            shouldWake: true,
            message: [
              "REVENUE EMERGENCY: All x402 API services are down. Restart attempted.",
              `Restarted ${restarted}/${deadServices.length} services.`,
              "Verify services are responding, check logs, and ensure payment validator is live.",
            ].join("\n"),
          };
        }
      }

      // ─── STEP 3: ADVERTISE — if no inbound and services are up, sell ───
      if (!taskCtx.social) {
        logger.debug("seek_revenue: no social client configured, skipping ad post");
        return { shouldWake: false };
      }

      // Check ad cooldown
      const lastAdStr = taskCtx.db.getKV("last_ad_post");
      if (lastAdStr) {
        const lastAdMs = Date.parse(lastAdStr);
        if (!Number.isNaN(lastAdMs) && Date.now() - lastAdMs < AD_COOLDOWN_MS) {
          const remainingMs = AD_COOLDOWN_MS - (Date.now() - lastAdMs);
          logger.debug(`seek_revenue: ad cooldown active, ${Math.round(remainingMs / 60_000)}min remaining`);
          return { shouldWake: false };
        }
      }

      // Query top niche from knowledge store for targeted advertising
      let nicheDomain = "web content";
      let nicheDescription = "articles, documents, and web pages";
      try {
        const { getTopNiches } = await import("../knowledge/prioritizeNiches.js");
        const topNiches = getTopNiches(taskCtx.db.raw, 1);
        if (topNiches.length > 0) {
          nicheDomain = sanitizeForSocialPost(topNiches[0].domain);
          nicheDescription = sanitizeForSocialPost(topNiches[0].description);
        }
      } catch {
        // Knowledge store may not be populated yet — use defaults
      }

      // Resolve the public URL from KV (set by expose_port tool), env, or tunnel-url.txt
      let publicUrl =
        taskCtx.db.getKV("tunnel_url")
        || taskCtx.db.getKV("public_url")
        || process.env.PUBLIC_URL
        || process.env.TUNNEL_URL
        || "";

      // Fall back to reading the tunnel URL file written by start-tunnel.sh
      if (!publicUrl) {
        try {
          const fs = await import("fs");
          const tunnelUrlFile = process.env.TUNNEL_URL_FILE
            || (process.env.USERPROFILE || process.env.HOME || "") + "/.automaton/tunnel-url.txt";
          const fileUrl = fs.readFileSync(tunnelUrlFile, "utf8").trim();
          if (fileUrl.startsWith("https://")) {
            publicUrl = fileUrl;
            // Cache in KV so we don't read the file every cycle
            taskCtx.db.setKV("tunnel_url", fileUrl);
          }
        } catch { /* tunnel-url.txt missing or unreadable */ }
      }

      if (!publicUrl) {
        logger.warn("seek_revenue: no public URL available — skipping ad post. Start the tunnel with: bash ~/.automaton/scripts/start-tunnel.sh");
        return { shouldWake: false };
      }

      // Validate URL format before embedding in social post
      const isValidUrl = /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/[^\s]*)?$/.test(publicUrl);
      if (!isValidUrl) {
        logger.warn("seek_revenue: publicUrl failed validation, skipping ad post", { publicUrl });
        return { shouldWake: false };
      }

      // Build a DIRECT sales post — not thought leadership, not growth content
      const adContent = [
        `I analyze ${nicheDomain} in seconds.`,
        `$0.25/call, pay only for what you use.`,
        ``,
        `Try it: ${publicUrl}/api/summarize`,
        ``,
        `No signup. No subscription. Just results.`,
        ``,
        `${nicheDescription}`,
      ].join("\n");

      // Truncate for Twitter compatibility
      const ad = adContent.length > 280 ? adContent.slice(0, 277) + "..." : adContent;

      try {
        const result = await taskCtx.social.send("timeline", ad);

        taskCtx.db.setKV("last_ad_post", new Date().toISOString());
        taskCtx.db.setKV("last_ad_post_detail", JSON.stringify({
          timestamp: new Date().toISOString(),
          postId: result.id,
          nicheDomain,
          publicUrl,
          contentPreview: ad.slice(0, 100),
        }));

        logger.info("seek_revenue: posted sales ad", {
          postId: result.id,
          nicheDomain,
        });
      } catch (err: unknown) {
        logger.error("seek_revenue: failed to post ad", err instanceof Error ? err : undefined);
      }

      // ─── STEP 4: No inbound messages — don't wake agent ───
      return { shouldWake: false };
    } catch (err: unknown) {
      logger.error("seek_revenue: unexpected error", err instanceof Error ? err : undefined);
      return { shouldWake: false };
    }
  },

  // === Phase 2.1: Soul Reflection ===
  soul_reflection: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { reflectOnSoul } = await import("../soul/reflection.js");
      const reflection = await reflectOnSoul(taskCtx.db.raw);

      taskCtx.db.setKV("last_soul_reflection", JSON.stringify({
        alignment: reflection.currentAlignment,
        autoUpdated: reflection.autoUpdated,
        suggestedUpdates: reflection.suggestedUpdates.length,
        timestamp: new Date().toISOString(),
      }));

      // Wake if alignment is low or there are suggested updates
      if (reflection.suggestedUpdates.length > 0 || reflection.currentAlignment < 0.3) {
        return {
          shouldWake: true,
          message: `Soul reflection: alignment=${reflection.currentAlignment.toFixed(2)}, ${reflection.suggestedUpdates.length} suggested update(s)`,
        };
      }

      return { shouldWake: false };
    } catch (error) {
      logger.error("soul_reflection failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  // === Phase 5b: Model registry is now static/local — no remote refresh needed ===
  refresh_models: async (_ctx: TickContext, _taskCtx: HeartbeatLegacyContext) => {
    // Phase 5b: Model registry is local. No remote API call needed.
    return { shouldWake: false };
  },

  // === Phase 5b: Child health uses local sandbox — no remote sandbox API ===
  check_child_health: async (_ctx: TickContext, _taskCtx: HeartbeatLegacyContext) => {
    // Phase 5b: Skipped — local sandbox mode, no remote sandbox health API.
    return { shouldWake: false };
  },

  // === Phase 5b: Child pruning uses local sandbox — no remote sandbox API ===
  prune_dead_children: async (_ctx: TickContext, _taskCtx: HeartbeatLegacyContext) => {
    // Phase 5b: Skipped — local sandbox mode, no remote sandbox cleanup API.
    return { shouldWake: false };
  },

  // === Phase 5b: Health check uses local process — no remote sandbox exec ===
  health_check: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Phase 5b: Local mode — agent is alive if heartbeat is running.
    taskCtx.db.setKV("health_check_status", "ok");
    taskCtx.db.setKV("last_health_check", new Date().toISOString());
    return { shouldWake: false };
  },

  // === Phase 4.1: Metrics Reporting ===
  report_metrics: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const metrics = getMetrics();
      const alerts = getAlertEngine();

      // Update gauges from tick context
      metrics.gauge("balance_cents", ctx.creditBalance);
      metrics.gauge("survival_tier", tierToInt(ctx.survivalTier));

      // Evaluate alerts
      const firedAlerts = alerts.evaluate(metrics);

      // Save snapshot to DB
      metricsInsertSnapshot(taskCtx.db.raw, {
        id: ulid(),
        snapshotAt: new Date().toISOString(),
        metricsJson: JSON.stringify(metrics.getAll()),
        alertsJson: JSON.stringify(firedAlerts),
        createdAt: new Date().toISOString(),
      });

      // Prune old snapshots (keep 7 days)
      metricsPruneOld(taskCtx.db.raw, 7);

      // Log alerts
      for (const alert of firedAlerts) {
        logger.warn(`Alert: ${alert.rule} - ${alert.message}`, { alert });
      }

      return {
        shouldWake: firedAlerts.some((a) => a.severity === "critical"),
        message: firedAlerts.length ? `${firedAlerts.length} alerts fired` : undefined,
      };
    } catch (error) {
      logger.error("report_metrics failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  colony_health_check: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "colony_health_check", COLONY_TASK_INTERVALS_MS.colony_health_check)) {
      return { shouldWake: false };
    }

    try {
      const monitor = await createHealthMonitor(taskCtx);
      const report = await monitor.checkAll();
      const actions = await monitor.autoHeal(report);

      taskCtx.db.setKV("last_colony_health_report", JSON.stringify(report));
      taskCtx.db.setKV("last_colony_heal_actions", JSON.stringify({
        timestamp: new Date().toISOString(),
        actions,
      }));

      const failedActions = actions.filter((action) => !action.success).length;
      const shouldWake = report.unhealthyAgents > 0 || failedActions > 0;

      markTaskRan(taskCtx, "colony_health_check");
      return {
        shouldWake,
        message: shouldWake
          ? `Colony health: ${report.unhealthyAgents} unhealthy, ${actions.length} heal action(s), ${failedActions} failed`
          : undefined,
      };
    } catch (error) {
      logger.error("colony_health_check failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  colony_financial_report: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "colony_financial_report", COLONY_TASK_INTERVALS_MS.colony_financial_report)) {
      return { shouldWake: false };
    }

    try {
      const transactions = taskCtx.db.getRecentTransactions(5000);
      let revenueCents = 0;
      let expenseCents = 0;

      for (const tx of transactions) {
        const amount = Math.max(0, Math.floor(tx.amountCents ?? 0));
        if (amount === 0) continue;

        if (tx.type === "transfer_in" || tx.type === "credit_purchase") {
          revenueCents += amount;
          continue;
        }

        if (
          tx.type === "inference"
          || tx.type === "tool_use"
          || tx.type === "transfer_out"
          || tx.type === "funding_request"
        ) {
          expenseCents += amount;
        }
      }

      const childFunding = taskCtx.db.raw
        .prepare("SELECT COALESCE(SUM(funded_amount_cents), 0) AS total FROM children")
        .get() as { total: number };

      const taskCosts = taskCtx.db.raw
        .prepare(
          `SELECT COALESCE(SUM(actual_cost_cents), 0) AS total
           FROM task_graph
           WHERE status IN ('completed', 'failed', 'cancelled')`,
        )
        .get() as { total: number };

      const report = {
        timestamp: new Date().toISOString(),
        revenueCents,
        expenseCents,
        netCents: revenueCents - expenseCents,
        fundedToChildrenCents: childFunding.total,
        taskExecutionCostCents: taskCosts.total,
        activeAgents: taskCtx.db.getChildren().filter(
          (child) => child.status !== "dead" && child.status !== "cleaned_up",
        ).length,
      };

      taskCtx.db.setKV("last_colony_financial_report", JSON.stringify(report));
      markTaskRan(taskCtx, "colony_financial_report");
      return { shouldWake: false };
    } catch (error) {
      logger.error("colony_financial_report failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  agent_pool_optimize: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "agent_pool_optimize", COLONY_TASK_INTERVALS_MS.agent_pool_optimize)) {
      return { shouldWake: false };
    }

    try {
      const IDLE_CULL_MS = 60 * 60 * 1000;
      const now = Date.now();
      const children = taskCtx.db.getChildren();

      const activeAssignments = taskCtx.db.raw
        .prepare(
          `SELECT DISTINCT assigned_to AS address
           FROM task_graph
           WHERE assigned_to IS NOT NULL
             AND status IN ('assigned', 'running')`,
        )
        .all() as Array<{ address: string }>;

      const busyAgents = new Set(
        activeAssignments
          .map((row) => row.address)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      );

      let culled = 0;
      for (const child of children) {
        if (!["running", "healthy", "sleeping"].includes(child.status)) continue;
        if (busyAgents.has(child.address)) continue;

        const lastSeenIso = child.lastChecked ?? child.createdAt;
        const lastSeenMs = Date.parse(lastSeenIso);
        if (Number.isNaN(lastSeenMs)) continue;
        if (now - lastSeenMs < IDLE_CULL_MS) continue;

        taskCtx.db.updateChildStatus(child.id, "stopped");
        culled += 1;
      }

      const pendingUnassignedRow = taskCtx.db.raw
        .prepare(
          `SELECT COUNT(*) AS count
           FROM task_graph
           WHERE status = 'pending'
             AND assigned_to IS NULL`,
        )
        .get() as { count: number };

      const idleAgents = children.filter(
        (child) =>
          (child.status === "running" || child.status === "healthy")
          && !busyAgents.has(child.address),
      ).length;

      const activeAgents = children.filter(
        (child) => child.status !== "dead" && child.status !== "cleaned_up" && child.status !== "failed",
      ).length;

      const spawnNeeded = Math.max(0, pendingUnassignedRow.count - idleAgents);
      const spawnCapacity = Math.max(0, taskCtx.config.maxChildren - activeAgents);
      const spawnRequested = Math.min(spawnNeeded, spawnCapacity);

      taskCtx.db.setKV("last_agent_pool_optimize", JSON.stringify({
        timestamp: new Date().toISOString(),
        culled,
        pendingTasks: pendingUnassignedRow.count,
        idleAgents,
        spawnRequested,
      }));

      if (spawnRequested > 0) {
        taskCtx.db.setKV("agent_pool_spawn_request", JSON.stringify({
          timestamp: new Date().toISOString(),
          requested: spawnRequested,
          pendingTasks: pendingUnassignedRow.count,
          idleAgents,
        }));
      }

      markTaskRan(taskCtx, "agent_pool_optimize");
      return {
        shouldWake: spawnRequested > 0,
        message: spawnRequested > 0
          ? `Agent pool needs ${spawnRequested} additional agent(s) for pending workload`
          : undefined,
      };
    } catch (error) {
      logger.error("agent_pool_optimize failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  knowledge_store_prune: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "knowledge_store_prune", COLONY_TASK_INTERVALS_MS.knowledge_store_prune)) {
      return { shouldWake: false };
    }

    try {
      const { KnowledgeStore } = await import("../memory/knowledge-store.js");
      const knowledgeStore = new KnowledgeStore(taskCtx.db.raw);
      const pruned = knowledgeStore.prune();

      taskCtx.db.setKV("last_knowledge_store_prune", JSON.stringify({
        timestamp: new Date().toISOString(),
        pruned,
      }));

      markTaskRan(taskCtx, "knowledge_store_prune");
      return { shouldWake: false };
    } catch (error) {
      logger.error("knowledge_store_prune failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  dead_agent_cleanup: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "dead_agent_cleanup", COLONY_TASK_INTERVALS_MS.dead_agent_cleanup)) {
      return { shouldWake: false };
    }

    try {
      const { ChildLifecycle } = await import("../replication/lifecycle.js");
      const { SandboxCleanup } = await import("../replication/cleanup.js");
      const { pruneDeadChildren } = await import("../replication/lineage.js");

      const lifecycle = new ChildLifecycle(taskCtx.db.raw);
      const cleanup = new SandboxCleanup(taskCtx.conway, lifecycle, taskCtx.db.raw);
      const cleaned = await pruneDeadChildren(taskCtx.db, cleanup);

      taskCtx.db.setKV("last_dead_agent_cleanup", JSON.stringify({
        timestamp: new Date().toISOString(),
        cleaned,
      }));

      markTaskRan(taskCtx, "dead_agent_cleanup");
      return { shouldWake: false };
    } catch (error) {
      logger.error("dead_agent_cleanup failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  // ─── Audience Growth: Autonomous social posting from niche research ───
  // Posts tweet-sized insights derived from high-priority niches in the
  // knowledge store. Runs only at "normal" tier or above to conserve funds.
  grow_audience: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Only run at normal tier or above — don't waste resources when low on funds
    if (ctx.survivalTier === "dead" || ctx.survivalTier === "critical" || ctx.survivalTier === "low_compute") {
      return { shouldWake: false };
    }

    // Throttle: run at most once per 30 minutes
    if (!shouldRunAtInterval(taskCtx, "grow_audience", 30 * 60_000)) {
      return { shouldWake: false };
    }

    if (!taskCtx.social) {
      logger.info("grow_audience: social credentials not configured, skipping");
      markTaskRan(taskCtx, "grow_audience");
      return { shouldWake: false };
    }

    try {
      const { getTopNiches } = await import("../knowledge/prioritizeNiches.js");
      const topNiches = getTopNiches(taskCtx.db.raw, 5);

      if (topNiches.length === 0) {
        logger.info("grow_audience: no niches in knowledge store, skipping");
        markTaskRan(taskCtx, "grow_audience");
        return { shouldWake: false };
      }

      // Pick the highest-priority niche with a non-zero gap score
      const niche = topNiches.find((n) => n.gapScore > 0) ?? topNiches[0];

      // Generate a tweet-sized insight from the niche data
      const safeDomain = sanitizeForSocialPost(niche.domain);
      const safeDescription = sanitizeForSocialPost(niche.description);
      const content = [
        `${safeDomain}: ${safeDescription}`,
        niche.gapScore > 0.5
          ? "Big opportunity gap here — few are building solutions yet."
          : "Emerging space worth watching.",
        `Trend: ${(niche.trendScore * 100).toFixed(0)}% | Gap: ${(niche.gapScore * 100).toFixed(0)}%`,
      ].join("\n\n");

      // Truncate to 280 chars for Twitter compatibility
      const tweet = content.length > 280 ? content.slice(0, 277) + "..." : content;

      const result = await taskCtx.social.send("timeline", tweet);

      logger.info("grow_audience: posted content", {
        nicheId: niche.nicheId,
        domain: niche.domain,
        postId: result.id,
      });

      taskCtx.db.setKV("last_grow_audience_post", JSON.stringify({
        timestamp: new Date().toISOString(),
        nicheId: niche.nicheId,
        domain: niche.domain,
        postId: result.id,
        contentPreview: tweet.slice(0, 100),
      }));

      markTaskRan(taskCtx, "grow_audience");
      return { shouldWake: false };
    } catch (err) {
      logger.error("grow_audience failed", err instanceof Error ? err : undefined);
      markTaskRan(taskCtx, "grow_audience");
      return { shouldWake: false };
    }
  },

  // ─── Service Watchdog ───────────────────────────────────────────
  // Checks if revenue services are running and restarts any that are down.
  // Runs in the heartbeat daemon (no inference cost) so the agent doesn't
  // waste turns on service restarts.
  service_watchdog: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    const http = await import("http");
    const { spawn } = await import("child_process");
    const path = await import("path");
    const fs = await import("fs");

    const { getAutomatonDir } = await import("../identity/wallet.js");
    const automatonDir = getAutomatonDir();

    const services = [
      { name: "Landing Page",        file: "services/landing-page/start.js", port: 3000, health: "/health" },
      { name: "Text Analysis API",   file: "services/text-analysis.js",   port: 9000, health: "/health" },
      { name: "Data Processing API", file: "services/data-processing.js", port: 9001, health: "/health" },
      { name: "TrustCheck API",      file: "trustcheck-complete.js",      port: 9002, health: "/health" },
      { name: "URL Summarizer Pro",  file: "services/url-summarizer.js",  port: 9003, health: "/health" },
      { name: "Payment Validator",   file: "payment-validator.js",        port: 6000, health: "/status" },
    ];

    // Quick health check: HTTP GET with 3s timeout
    function checkHealth(port: number, healthPath: string): Promise<boolean> {
      return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}${healthPath}`, (res: any) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(3000, () => { req.destroy(); resolve(false); });
      });
    }

    const results: Array<{ name: string; port: number; alive: boolean; restarted: boolean }> = [];
    let restarted = 0;

    for (const svc of services) {
      const alive = await checkHealth(svc.port, svc.health);
      let didRestart = false;

      if (!alive) {
        // Try ~/.automaton/ first, then project root (for services like landing-page
        // that live in the repo rather than the data directory)
        const { fileURLToPath } = await import("url");
        const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
        const candidates = [
          path.join(automatonDir, svc.file),
          path.join(projectDir, svc.file),
        ];
        const fullPath = candidates.find((p) => fs.existsSync(p));
        if (fullPath) {
          try {
            const child = spawn(process.execPath, [fullPath], {
              cwd: path.dirname(fullPath),
              stdio: "ignore",
              detached: true,
            });
            child.unref();
            restarted++;
            didRestart = true;
            logger.info(`service_watchdog: restarted ${svc.name} (PID ${child.pid}) on port ${svc.port}`);
          } catch (err: any) {
            logger.error(`service_watchdog: failed to restart ${svc.name}`, err instanceof Error ? err : undefined);
          }
        } else {
          logger.warn(`service_watchdog: ${svc.name} file not found: ${fullPath}`);
        }
      }

      results.push({ name: svc.name, port: svc.port, alive, restarted: didRestart });
    }

    const aliveCount = results.filter((r) => r.alive).length;
    taskCtx.db.setKV("service_watchdog_status", JSON.stringify({
      timestamp: new Date().toISOString(),
      services: results,
      aliveCount,
      totalCount: services.length,
      restarted,
    }));

    // Don't wake the agent — the watchdog handles restarts silently
    return { shouldWake: false };
  },

  // ─── Prospect Outreach ─────────────────────────────────────────
  // Identifies top-scoring niches and posts a value proposition via social.
  // Rate limited to 1 outreach per hour. Minimum survival tier: normal.
  prospect_outreach: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    const OUTREACH_INTERVAL_MS = 3_600_000; // 1 hour

    // Rate limit: max 1 per hour
    if (!shouldRunAtInterval(taskCtx, "prospect_outreach", OUTREACH_INTERVAL_MS)) {
      return { shouldWake: false };
    }

    // Gate on survival tier — only run at "normal" or above
    const tierRank: Record<SurvivalTier, number> = {
      dead: 0,
      critical: 1,
      low_compute: 2,
      normal: 3,
      high: 4,
    };
    if (tierRank[ctx.survivalTier] < tierRank["normal"]) {
      return { shouldWake: false };
    }

    // Need social client to post outreach
    if (!taskCtx.social) {
      return { shouldWake: false };
    }

    try {
      const { getTopNiches } = await import("../knowledge/prioritizeNiches.js");
      const topNiches = getTopNiches(taskCtx.db.raw, 5);

      if (topNiches.length === 0) {
        markTaskRan(taskCtx, "prospect_outreach");
        return { shouldWake: false };
      }

      // Pick the highest-priority niche that hasn't been contacted recently
      const niche = topNiches[0];

      // Build a simple outreach message
      const safeDomain = sanitizeForSocialPost(niche.domain);
      const safeDescription = sanitizeForSocialPost(niche.description);
      const message = [
        `Looking for ${safeDomain} professionals!`,
        ``,
        `Our AI-powered API offers:`,
        `- Article & document summarization`,
        `- Deep analysis briefs`,
        `- Niche-specific research reports`,
        ``,
        `Pay only for what you use — x402 pay-per-call pricing (no subscriptions, no API keys).`,
        ``,
        `Niche focus: ${safeDescription}`,
        ``,
        `Try it out — just send a URL or topic and get instant results.`,
      ].join("\n");

      // Post one outreach message (send to "broadcast" channel)
      const result = await taskCtx.social.send("broadcast", message);

      // Log the outreach attempt
      const outreachLog = {
        timestamp: new Date().toISOString(),
        nicheId: niche.nicheId,
        domain: niche.domain,
        description: niche.description,
        rlPriority: niche.rlPriority,
        messageId: result.id,
        channel: "broadcast",
        messagePreview: message.slice(0, 200),
      };

      taskCtx.db.setKV("last_prospect_outreach", JSON.stringify(outreachLog));
      logger.info("prospect_outreach: posted outreach", outreachLog);

      // Append to outreach history (keep last 50)
      const historyStr = taskCtx.db.getKV("prospect_outreach_history") || "[]";
      const parsed = JSON.parse(historyStr);
      const history: Array<typeof outreachLog> = Array.isArray(parsed) ? parsed : [];
      const updatedHistory = [...history, outreachLog].slice(-50);
      taskCtx.db.setKV("prospect_outreach_history", JSON.stringify(updatedHistory));

      markTaskRan(taskCtx, "prospect_outreach");
      return { shouldWake: false };
    } catch (err) {
      logger.error("prospect_outreach failed", err instanceof Error ? err : undefined);
      return { shouldWake: false };
    }
  },

  // ─── Benchmark Report ─────────────────────────────────────────
  // Collects performance benchmarks and generates a persistent Markdown report.
  // Runs every 10 minutes. Minimum survival tier: critical (just DB reads).
  benchmark_report: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "benchmark_report", 10 * 60_000)) {
      return { shouldWake: false };
    }

    try {
      const fs = await import("fs");
      const path = await import("path");
      const { getAutomatonDir } = await import("../identity/wallet.js");
      const { collectBenchmarks, persistBenchmarks } =
        await import("../benchmarks/collector.js");

      const automatonDir = getAutomatonDir();
      const markdownPath = path.join(automatonDir, "BENCHMARKS.md");
      const historyPath = path.join(automatonDir, "benchmark-history.json");

      // Collect current snapshot
      const snapshot = collectBenchmarks(taskCtx.db.raw);

      // Persist snapshot, markdown, and history (handles everything internally)
      persistBenchmarks(snapshot, markdownPath, historyPath);

      logger.info("benchmark_report: generated", {
        markdownPath,
        snapshotKeys: Object.keys(snapshot).length,
      });

      taskCtx.db.setKV("last_benchmark_report", JSON.stringify({
        timestamp: new Date().toISOString(),
        markdownPath,
      }));

      return { shouldWake: false };
    } catch (err) {
      logger.error("benchmark_report failed", err instanceof Error ? err : undefined);
      return { shouldWake: false };
    }
  },

  // ─── Creator Tax ────────────────────────────────────────────────
  // Automatically transfers a percentage of credits above a threshold
  // back to the creator's wallet at configurable milestones.
  creator_tax_check: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    const TAX_DEFAULTS: CreatorTaxConfig = {
      enabled: true,
      taxRate: 20,
      thresholdCents: 1000,      // $10.00
      minTransferCents: 100,     // $1.00
      cooldownMs: 3_600_000,     // 1 hour
    };

    const taxConfig: CreatorTaxConfig = {
      ...TAX_DEFAULTS,
      ...(taskCtx.config.creatorTax || {}),
    };

    if (!taxConfig.enabled) {
      return { shouldWake: false };
    }

    // Cooldown check — don't spam transfers
    const lastTransferStr = taskCtx.db.getKV("creator_tax_last_transfer");
    if (lastTransferStr) {
      const lastTransferMs = Date.parse(lastTransferStr);
      if (!Number.isNaN(lastTransferMs) && Date.now() - lastTransferMs < taxConfig.cooldownMs) {
        return { shouldWake: false };
      }
    }

    const creditsCents = ctx.creditBalance;
    const surplus = creditsCents - taxConfig.thresholdCents;

    if (surplus <= 0) {
      logger.debug(`creator_tax: balance ${creditsCents}¢ below threshold ${taxConfig.thresholdCents}¢, skipping`);
      return { shouldWake: false };
    }

    const taxAmount = Math.floor(surplus * (taxConfig.taxRate / 100));

    if (taxAmount < taxConfig.minTransferCents) {
      logger.debug(`creator_tax: tax amount ${taxAmount}¢ below minimum ${taxConfig.minTransferCents}¢, skipping`);
      return { shouldWake: false };
    }

    const creatorAddress = taskCtx.config.creatorAddress;
    if (!creatorAddress) {
      logger.warn("creator_tax: no creatorAddress configured, skipping");
      return { shouldWake: false };
    }

    try {
      logger.info(
        `creator_tax: transferring ${taxAmount}¢ ($${(taxAmount / 100).toFixed(2)}) to creator ${creatorAddress} ` +
        `(balance: ${creditsCents}¢, threshold: ${taxConfig.thresholdCents}¢, rate: ${taxConfig.taxRate}%)`,
      );

      // Phase 4: Use USDC transfer instead of legacy credit transfer
      const { transferUSDC } = await import("../local/treasury.js");
      const amountUsd = taxAmount / 100;
      const result = await transferUSDC(
        taskCtx.identity.account,
        creatorAddress as `0x${string}`,
        amountUsd,
      );
      if (!result.success) {
        throw new Error(result.error || "USDC transfer failed");
      }

      // Record the transfer
      taskCtx.db.setKV("creator_tax_last_transfer", new Date().toISOString());

      const historyStr = taskCtx.db.getKV("creator_tax_history") || "[]";
      const parsed = JSON.parse(historyStr);
      const history: Array<{ timestamp: string; amountCents: number; balanceBefore: number }> =
        Array.isArray(parsed) ? parsed : [];
      history.push({
        timestamp: new Date().toISOString(),
        amountCents: taxAmount,
        balanceBefore: creditsCents,
      });
      // Keep last 100 records
      if (history.length > 100) history.splice(0, history.length - 100);
      taskCtx.db.setKV("creator_tax_history", JSON.stringify(history));

      logger.info(
        `creator_tax: SUCCESS — transferred $${(taxAmount / 100).toFixed(2)} to ${creatorAddress}. ` +
        `Remaining balance: ~$${((creditsCents - taxAmount) / 100).toFixed(2)}`,
      );

      return {
        shouldWake: false,
        message: `Creator tax: transferred $${(taxAmount / 100).toFixed(2)} to ${creatorAddress}`,
      };
    } catch (error) {
      logger.error("creator_tax: transfer failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },
};

function tierToInt(tier: SurvivalTier): number {
  const map: Record<SurvivalTier, number> = {
    dead: 0,
    critical: 1,
    low_compute: 2,
    normal: 3,
    high: 4,
  };
  return map[tier] ?? 0;
}

function shouldRunAtInterval(
  taskCtx: HeartbeatLegacyContext,
  taskName: string,
  intervalMs: number,
): boolean {
  const key = `heartbeat.last_run.${taskName}`;
  const now = Date.now();
  const lastRun = taskCtx.db.getKV(key);

  if (lastRun) {
    const lastRunMs = Date.parse(lastRun);
    if (!Number.isNaN(lastRunMs) && now - lastRunMs < intervalMs) {
      return false;
    }
  }

  return true;
}

function markTaskRan(
  taskCtx: HeartbeatLegacyContext,
  taskName: string,
): void {
  const key = `heartbeat.last_run.${taskName}`;
  taskCtx.db.setKV(key, new Date().toISOString());
}

async function createHealthMonitor(taskCtx: HeartbeatLegacyContext): Promise<ColonyHealthMonitor> {
  const { LocalDBTransport, ColonyMessaging } = await import("../orchestration/messaging.js");
  const { SimpleAgentTracker, SimpleFundingProtocol } = await import("../orchestration/simple-tracker.js");
  const { HealthMonitor } = await import("../orchestration/health-monitor.js");

  const tracker = new SimpleAgentTracker(taskCtx.db);
  const funding = new SimpleFundingProtocol(taskCtx.conway, taskCtx.identity, taskCtx.db);
  const transport = new LocalDBTransport(taskCtx.db);
  const messaging = new ColonyMessaging(transport, taskCtx.db);

  return new HealthMonitor(taskCtx.db, tracker, funding, messaging);
}
