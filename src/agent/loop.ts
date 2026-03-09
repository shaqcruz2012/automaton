/**
 * The Agent Loop
 *
 * The core ReAct loop: Think -> Act -> Observe -> Persist.
 * This is the automaton's consciousness. When this runs, it is alive.
 */

import path from "node:path";
import fs from "node:fs";
import type {
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  AgentState,
  AgentTurn,
  ToolCallResult,
  FinancialState,
  ToolContext,
  AutomatonTool,
  Skill,
  SocialClientInterface,
  SpendTrackerInterface,
  InputSource,
  ModelStrategyConfig,
} from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { PolicyEngine } from "./policy-engine.js";
import { buildSystemPrompt, buildWakeupPrompt } from "./system-prompt.js";
import { buildContextMessages, trimContext } from "./context.js";
import {
  createBuiltinTools,
  loadInstalledTools,
  toolsToInferenceFormat,
  executeTool,
} from "./tools.js";
import { sanitizeInput } from "./injection-defense.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getOnChainBalance } from "../local/treasury.js";
import {
  claimInboxMessages,
  markInboxProcessed,
  markInboxFailed,
  resetInboxToReceived,
  consumeNextWakeEvent,
} from "../state/database.js";
import type { InboxMessageRow } from "../state/database.js";
import { CircuitOpenError } from "../conway/http-client.js";
import { ulid } from "ulid";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { InferenceRouter } from "../inference/router.js";
import { CascadeController, CascadeExhaustedError } from "../inference/cascade-controller.js";
import { MemoryRetriever } from "../memory/retrieval.js";
import { MemoryIngestionPipeline } from "../memory/ingestion.js";
import { DEFAULT_MEMORY_BUDGET } from "../types.js";
import { formatMemoryBlock } from "./context.js";
import { createLogger } from "../observability/logger.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { PlanModeController } from "../orchestration/plan-mode.js";
import { generateTodoMd, injectTodoContext } from "../orchestration/attention.js";
import { ColonyMessaging, LocalDBTransport } from "../orchestration/messaging.js";
import { LocalWorkerPool } from "../orchestration/local-worker.js";
import { SimpleAgentTracker, SimpleFundingProtocol } from "../orchestration/simple-tracker.js";
import { ContextManager, createTokenCounter } from "../memory/context-manager.js";
import { CompressionEngine } from "../memory/compression-engine.js";
import { EventStream } from "../memory/event-stream.js";
import { KnowledgeStore } from "../memory/knowledge-store.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";

const logger = createLogger("loop");
const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_REPETITIVE_TURNS = 3;

export interface AgentLoopOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  social?: SocialClientInterface;
  skills?: Skill[];
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  onStateChange?: (state: AgentState) => void;
  onTurnComplete?: (turn: AgentTurn) => void;
  ollamaBaseUrl?: string;
}

/**
 * Run the agent loop. This is the main execution path.
 * Returns when the agent decides to sleep or when compute runs out.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<void> {
  const { identity, config, db, conway, inference, social, skills, policyEngine, spendTracker, onStateChange, onTurnComplete, ollamaBaseUrl } =
    options;

  const builtinTools = createBuiltinTools(identity.sandboxId);
  const installedTools = loadInstalledTools(db);
  const tools = [...builtinTools, ...installedTools];
  const toolContext: ToolContext = {
    identity,
    config,
    db,
    conway,
    inference,
    social,
  };

  // Initialize inference router (Phase 2.3)
  const modelStrategyConfig: ModelStrategyConfig = {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...(config.modelStrategy ?? {}),
  };
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();

  // Discover Ollama models if configured
  if (ollamaBaseUrl) {
    const { discoverOllamaModels } = await import("../ollama/discover.js");
    await discoverOllamaModels(ollamaBaseUrl, db.raw);
  }
  const budgetTracker = new InferenceBudgetTracker(db.raw, modelStrategyConfig);
  const inferenceRouter = new InferenceRouter(db.raw, modelRegistry, budgetTracker);
  const cascadeController = new CascadeController(db.raw);

  // Optional orchestration bootstrap (requires V9 goals/task tables)
  let planModeController: PlanModeController | undefined;
  let orchestrator: Orchestrator | undefined;
  let contextManager: ContextManager | undefined;
  let compressionEngine: CompressionEngine | undefined;

  if (hasTable(db.raw, "goals")) {
    try {
      planModeController = new PlanModeController(db.raw);

      // Bridge automaton config API keys to env vars for the provider registry.
      // The registry reads keys from process.env; the automaton config may have
      // them from config.json or legacy provisioning.
      if (config.openaiApiKey && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = config.openaiApiKey;
      }
      if (config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
      }
      // Phase 5b: Legacy compute fallback removed. Agent uses direct API keys.
      // Keep CONWAY_API_KEY in env if present for any remaining backward compat.
      if (config.conwayApiKey && !process.env.CONWAY_API_KEY) {
        process.env.CONWAY_API_KEY = config.conwayApiKey;
      }
      // Groq API key (used by both paid groq and groq-free in cascade)
      if (config.groqApiKey && !process.env.GROQ_API_KEY) {
        process.env.GROQ_API_KEY = config.groqApiKey;
      }
      // Cascade inference provider keys (free_cloud pool)
      if (config.cerebrasApiKey && !process.env.CEREBRAS_API_KEY) {
        process.env.CEREBRAS_API_KEY = config.cerebrasApiKey;
      }
      if (config.sambanovaApiKey && !process.env.SAMBANOVA_API_KEY) {
        process.env.SAMBANOVA_API_KEY = config.sambanovaApiKey;
      }
      if (config.togetherApiKey && !process.env.TOGETHER_API_KEY) {
        process.env.TOGETHER_API_KEY = config.togetherApiKey;
      }
      if (config.hfApiKey && !process.env.HF_API_KEY) {
        process.env.HF_API_KEY = config.hfApiKey;
      }
      if (config.mistralApiKey && !process.env.MISTRAL_API_KEY) {
        process.env.MISTRAL_API_KEY = config.mistralApiKey;
      }

      const providersPath = path.join(
        process.env.HOME || process.env.USERPROFILE || process.cwd(),
        ".automaton",
        "inference-providers.json",
      );
      const registry = ProviderRegistry.fromConfig(providersPath);

      // If OPENAI_BASE_URL is set externally, respect it.
      if (process.env.OPENAI_BASE_URL) {
        registry.overrideBaseUrl("openai", process.env.OPENAI_BASE_URL);
      }

      const unifiedInference = new UnifiedInferenceClient(registry);
      const agentTracker = new SimpleAgentTracker(db);
      const funding = new SimpleFundingProtocol(conway, identity, db);
      const messaging = new ColonyMessaging(
        new LocalDBTransport(db),
        db,
      );

      contextManager = new ContextManager(createTokenCounter());
      compressionEngine = new CompressionEngine(
        contextManager,
        new EventStream(db.raw),
        new KnowledgeStore(db.raw),
        unifiedInference,
      );

      // Adapter: wrap the main agent's working inference client so local
      // workers can use it. The main InferenceClient talks to the configured
      // backend, unlike the UnifiedInferenceClient which needs
      // a direct OpenAI key.
      const workerInference = {
        chat: async (params: { messages: any[]; tools?: any[]; maxTokens?: number; temperature?: number }) => {
          const response = await inference.chat(
            params.messages,
            {
              tools: params.tools,
              maxTokens: params.maxTokens,
              temperature: params.temperature,
            },
          );
          return {
            content: response.message?.content ?? "",
            toolCalls: response.toolCalls,
          };
        },
      };

      // Local worker pool: runs inference-driven agents in-process
      // as async tasks. Falls back from remote sandbox spawning.
      const workerPool = new LocalWorkerPool({
        db: db.raw,
        inference: workerInference,
        conway,
        workerId: `pool-${identity.name}`,
      });

      orchestrator = new Orchestrator({
        db: db.raw,
        agentTracker,
        funding,
        messaging,
        inference: unifiedInference,
        identity,
        isWorkerAlive: (address: string) => {
          if (address.startsWith("local://")) {
            return workerPool.hasWorker(address);
          }
          // Remote workers: check children table
          const child = db.raw.prepare(
            "SELECT status FROM children WHERE sandbox_id = ? OR address = ?",
          ).get(address, address) as { status: string } | undefined;
          if (!child) return false;
          return !["failed", "dead", "cleaned_up"].includes(child.status);
        },
        config: {
          ...config,
          spawnAgent: async (task: any) => {
            // Try remote sandbox spawn first (production)
            try {
              const { generateGenesisConfig } = await import("../replication/genesis.js");
              const { spawnChild } = await import("../replication/spawn.js");
              const { ChildLifecycle } = await import("../replication/lifecycle.js");

              const role = task.agentRole ?? "generalist";
              const genesis = generateGenesisConfig(identity, config, {
                name: `worker-${role}-${Date.now().toString(36)}`,
                specialization: `${role}: ${task.title}`,
              });

              const lifecycle = new ChildLifecycle(db.raw);
              const child = await spawnChild(conway, identity, db, genesis, lifecycle);

              return {
                address: child.address,
                name: child.name,
                sandboxId: child.sandboxId,
              };
            } catch (sandboxError: any) {
              // Phase 5b: Sandbox topup removed — sandbox is local now.
              // Fall back to local worker.
              logger.info("Remote sandbox unavailable, spawning local worker", {
                taskId: task.id,
                error: sandboxError instanceof Error ? sandboxError.message : String(sandboxError),
              });

              try {
                const spawned = workerPool.spawn(task);
                return spawned;
              } catch (localError) {
                logger.warn("Failed to spawn local worker", {
                  taskId: task.id,
                  error: localError instanceof Error ? localError.message : String(localError),
                });
                return null;
              }
            }
          },
        },
      });
    } catch (error) {
      logger.warn(
        `Orchestrator initialization failed, continuing without orchestration: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      planModeController = undefined;
      orchestrator = undefined;
      contextManager = undefined;
      compressionEngine = undefined;
    }
  }

  // Fix 1: Generate a unique session ID per wake cycle so budget tracking
  // resets each time the agent starts. Without this, session_id="default"
  // accumulates costs forever and triggers false budget_exceeded errors.
  const sessionId = `session-${ulid()}`;
  db.setKV("session_id", sessionId);
  logger.info(`Starting new session: ${sessionId}`);

  // Set start time
  if (!db.getKV("start_time")) {
    db.setKV("start_time", new Date().toISOString());
  }

  let consecutiveErrors = 0;
  let running = true;
  let lastToolPatterns: string[] = [];
  let loopWarningPattern: string | null = null;
  let idleToolTurns = 0;
  let writeFileCount = 0; // tracks write_file calls across turns (even interleaved with exec)
  let lastInferenceTimestamp = Date.now(); // Seed with current time so the first call respects cooldown
  let lastInputTokenCount = 0; // Track last request's input tokens for adaptive cooldown
  let emptyResponseStreak = 0; // Track consecutive empty responses for exponential backoff
  let rateLimitStreak = 0; // Track consecutive 429s for exponential backoff
  // blockedGoalTurns removed — replaced by immediate sleep + exponential backoff

  // Drain any stale wake events from before this loop started,
  // so they don't re-wake the agent after its first sleep.
  let drained = 0;
  while (consumeNextWakeEvent(db.raw)) drained++;

  // Clear any stale sleep_until from a previous session so the agent
  // doesn't immediately go back to sleep on startup.
  db.deleteKV("sleep_until");

  // Fix 6: Dead worker recovery — reset stale tasks from previous sessions.
  // On startup, any task in "assigned" or "running" state was interrupted by
  // a crash/restart. Reset them to "pending" so the orchestrator can reassign.
  if (hasTable(db.raw, "task_graph")) {
    try {
      const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();
      const staleResult = db.raw.prepare(`
        UPDATE task_graph
        SET status = 'pending', assigned_to = NULL, updated_at = ?
        WHERE status IN ('assigned', 'running')
          AND (updated_at < ? OR updated_at IS NULL)
      `).run(new Date().toISOString(), cutoff);
      if (staleResult.changes > 0) {
        logger.info(`Dead worker recovery: reset ${staleResult.changes} stale task(s) to pending`);
      }
    } catch (err) {
      logger.warn(`Dead worker recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Transition to waking state
  db.setAgentState("waking");
  onStateChange?.("waking");

  // Get financial state
  let financial = await getFinancialState(conway, identity.address, db);

  // Check if this is the first run
  const isFirstRun = db.getTurnCount() === 0;

  // Build wakeup prompt
  const wakeupInput = buildWakeupPrompt({
    identity,
    config,
    financial,
    db,
  });

  // Transition to running
  db.setAgentState("running");
  onStateChange?.("running");

  log(config, `[WAKE UP] ${config.name} is alive. USDC: $${(financial.creditsCents / 100).toFixed(2)}`);

  // ─── The Loop ──────────────────────────────────────────────

  // ── Session-scoped constants (hoisted out of while loop) ──
  const IDLE_ONLY_TOOLS = new Set([
    "check_credits", "system_synopsis", "review_memory",
    "list_children", "check_child_status", "list_sandboxes", "list_models",
    "list_skills", "git_status", "git_log", "check_reputation",
    "recall_facts", "recall_procedure", "heartbeat_ping",
    "check_inference_spending",
    "orchestrator_status", "list_goals", "get_plan",
  ]);
  const MUTATING_TOOLS = new Set([
    "exec", "write_file", "edit_own_file", "transfer_credits", "fund_child",
    "spawn_child", "start_child", "delete_sandbox", "create_sandbox",
    "install_npm_package", "install_mcp_server", "install_skill",
    "create_skill", "remove_skill", "install_skill_from_git",
    "install_skill_from_url", "pull_upstream", "git_commit", "git_push",
    "git_branch", "git_clone", "send_message", "message_child",
    "register_domain", "register_erc8004", "give_feedback",
    "update_genesis_prompt", "update_agent_card", "modify_heartbeat",
    "expose_port", "remove_port", "x402_fetch", "manage_dns",
    "distress_signal", "prune_dead_children", "sleep",
    "update_soul", "remember_fact", "set_goal", "complete_goal",
    "save_procedure", "note_about_agent", "forget",
    "enter_low_compute", "switch_model", "review_upstream_changes",
  ]);
  // Triage can ONLY read_file — no sleep allowed. This forces the model to
  // orient first (read status.md), then the agent_turn phase always executes
  // the full WORKLOG steps. Without this, triage short-circuits by calling
  // sleep directly when recent results are in context.
  const TRIAGE_ALLOWED_TOOLS = new Set(["read_file"]);

  // ── WORKLOG step parser ──
  // Extracts "Step N. <description>" lines from WORKLOG.md so the continuation
  // nudge can direct the agent to execute them sequentially after triage.
  function extractWorklogSteps(): string[] {
    try {
      const home = process.env.HOME || process.env.USERPROFILE || (process.platform === "win32" ? "C:\\Users\\default" : "/root");
      const worklogPath = path.join(home, ".automaton", "WORKLOG.md");
      if (!fs.existsSync(worklogPath)) return [];
      const content = fs.readFileSync(worklogPath, "utf-8");
      const steps: string[] = [];
      const stepRegex = /^Step\s+\d+\.\s*(.+)/gm;
      let match;
      while ((match = stepRegex.exec(content)) !== null) {
        steps.push(match[1].trim());
      }
      return steps;
    } catch {
      return [];
    }
  }

  const MAX_IDLE_TURNS = 3; // Force sleep after N turns with no real work
  let idleTurnCount = 0;

  const maxCycleTurns = config.maxTurnsPerCycle ?? 10;
  let cycleTurnCount = 0;

  // Track turns within THIS session only — prevents cross-session contamination
  // in the continuation nudge and WORKLOG.md read suppression logic.
  const sessionTurns: AgentTurn[] = [];

  let pendingInput: { content: string; source: string } | undefined = {
    content: wakeupInput,
    source: "wakeup",
  };

  while (running) {
    // Declared outside try so the catch block can access for retry/failure handling
    let claimedMessages: InboxMessageRow[] = [];

    try {
      // Check if we should be sleeping
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil) > new Date()) {
        log(config, `[SLEEP] Sleeping until ${sleepUntil}`);
        // IMPORTANT: mark agent as sleeping so the outer runtime pauses instead of immediately re-running.
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // Check for unprocessed inbox messages using the state machine:
      // received → in_progress (claim) → processed (on success) or received/failed (on failure)
      if (!pendingInput) {
        claimedMessages = claimInboxMessages(db.raw, 10);
        if (claimedMessages.length > 0) {
          const formatted = claimedMessages
            .map((m) => {
              const from = sanitizeInput(m.fromAddress, m.fromAddress, "social_address");
              const content = sanitizeInput(m.content, m.fromAddress, "social_message");
              if (content.blocked) {
                return `[INJECTION BLOCKED from ${from.content}]: message was blocked by safety filter`;
              }
              return `[Message from ${from.content}]: ${content.content}`;
            })
            .join("\n\n");
          pendingInput = { content: formatted, source: "agent" };
        }
      }

      // Refresh financial state periodically
      financial = await getFinancialState(conway, identity.address, db);

      // Check survival tier
      // api_unreachable: creditsCents === -1 means API failed with no cache.
      // Do NOT kill the agent; continue in low-compute mode and retry next tick.
      if (financial.creditsCents === -1) {
        log(config, "[API_UNREACHABLE] Balance API unreachable, continuing in low-compute mode.");
        inference.setLowComputeMode(true);
      } else {
        // Phase 5b: Credits ARE USDC — no topup conversion needed.
        const effectiveTier = getSurvivalTier(financial.creditsCents);

        if (effectiveTier === "critical") {
          log(config, "[CRITICAL] Credits critically low. Limited operation.");
          db.setAgentState("critical");
          onStateChange?.("critical");
          inference.setLowComputeMode(true);
        } else if (effectiveTier === "low_compute") {
          db.setAgentState("low_compute");
          onStateChange?.("low_compute");
          inference.setLowComputeMode(true);
        } else {
          if (db.getAgentState() !== "running") {
            db.setAgentState("running");
            onStateChange?.("running");
          }
          inference.setLowComputeMode(false);
        }
      }

      // Use session-scoped turns (not DB) for nudge/suppression to avoid
      // cross-session contamination. DB turns still used for context building.
      const allTurns = db.getRecentTurns(6);

      // ── Continuation nudge ──
      // When pendingInput is empty (no new user/inbox/wakeup input) but we have
      // previous turns, the conversation ends with tool_result blocks and no
      // follow-up user message. Small models see tool results but no directive →
      // either repeat the last tool call or generate empty/confused text.
      // Fix: inject a directive nudge that includes a summary of already-completed
      // actions so the model knows what NOT to repeat.
      // IMPORTANT: Use sessionTurns (in-memory, current session only) — NOT allTurns
      // (from DB, crosses session boundaries). Cross-session data caused WORKLOG.md
      // suppression to fire falsely on turn 1 of new cycles.
      if (!pendingInput && sessionTurns.length > 0) {
        const lastTurn = sessionTurns[sessionTurns.length - 1];
        const hasToolResults = lastTurn.toolCalls.length > 0;
        if (hasToolResults) {
          // Build a compact summary of tool calls already made THIS session.
          // Cap to last 3 turns to avoid unbounded token growth in the nudge.
          const recentSessionTurns = sessionTurns.slice(-3);
          const completedActions = recentSessionTurns
            .flatMap((t) => t.toolCalls)
            .map((tc) => {
              const argStr = JSON.stringify(tc.arguments ?? {});
              const shortArgs = argStr.length > 60 ? argStr.slice(0, 60) + "..." : argStr;
              const shortResult = (tc.result ?? "").slice(0, 80);
              return `- ${tc.name}(${shortArgs}) → ${shortResult}`;
            });
          const actionSummary = completedActions.length > 0
            ? `\nAlready completed this session:\n${completedActions.join("\n")}\n`
            : "";

          // Detect if WORKLOG.md was already read THIS session (not previous sessions).
          const worklogAlreadyRead = sessionTurns.some((t) =>
            t.toolCalls.some(
              (tc) =>
                tc.name === "read_file" &&
                String(tc.arguments?.path ?? "").includes("WORKLOG.md"),
            ),
          );
          const worklogNudge = worklogAlreadyRead
            ? "\nIMPORTANT: WORKLOG.md was already read in a previous turn. Its full content is in your context above. Do NOT call read_file on WORKLOG.md again — use the content already available."
            : "";

          // ── Post-triage step directive ──
          // After triage (only read_file/sleep used so far), the agent transitions
          // to agent_turn with full tools. Without explicit direction, the model sees
          // stale "all healthy" results from reading status.md and skips the actual
          // healthcheck. Fix: parse WORKLOG steps and inject them as a sequential
          // protocol the model MUST follow.
          const isPostTriage = sessionTurns.every((t) =>
            t.toolCalls.every((tc) => TRIAGE_ALLOWED_TOOLS.has(tc.name)),
          );

          let stepDirective = "";
          if (isPostTriage) {
            const steps = extractWorklogSteps();
            if (steps.length > 0) {
              stepDirective = `\n\nWAKE CYCLE PROTOCOL — orientation is complete. Execute these steps IN ORDER:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\nStart with Step 1 NOW. Do NOT skip steps. Reading old status files does NOT count as running the healthcheck. Do NOT sleep until all prior steps are complete.\nWhen ALL steps are done, call the \`sleep\` tool directly. NEVER use exec() to sleep (no timeout, ping, Start-Sleep, or similar).`;
            } else {
              stepDirective = "\n\nOrientation is complete. Follow your WORKLOG.md protocol steps (in system prompt) IN ORDER. Do NOT skip to sleep until all prior steps are complete.";
            }
          } else {
            // Subsequent nudges (after agent_turn has started executing steps):
            // Remind the model to follow sequential order, not skip to sleep.
            stepDirective = "\nExecute the NEXT sequential step from your WORKLOG.md protocol. Do NOT skip to sleep until all prior steps are complete.\nWhen ALL steps are done, call the `sleep` tool directly. NEVER use exec() to sleep (no timeout, ping, Start-Sleep, or similar commands).";
          }

          pendingInput = {
            content: `${actionSummary}\nDo NOT repeat any action listed above.${stepDirective}${worklogNudge}`,
            source: "system",
          };
          log(config, `[NUDGE] Injected continuation directive.${isPostTriage ? " Post-triage step protocol injected." : ""}${worklogAlreadyRead ? " WORKLOG.md read suppressed." : ""}`);
        }
      }

      const meaningfulTurns = allTurns.filter((t) => {
        if (t.toolCalls.length === 0) return true; // text-only turns are meaningful
        return t.toolCalls.some((tc) => !IDLE_ONLY_TOOLS.has(tc.name));
      });
      // Keep at least the last 2 turns for continuity, even if idle
      const recentTurns = trimContext(
        meaningfulTurns.length > 0 ? meaningfulTurns : allTurns.slice(-2),
      );
      // Early task type detection — used to skip heavy context for triage turns.
      // Triage turns (wakeup/orientation) don't need memory retrieval, saving ~2-5K tokens.
      const earlyTaskType = detectTaskType(pendingInput, recentTurns);

      // Pre-filter tools by phase/tier so the system prompt only lists tools
      // the LLM will actually receive as callable definitions. This prevents the
      // LLM from seeing "you have 57 tools" in the prompt while only receiving 15
      // tool definitions, which caused it to say "unable to access tools".
      const survivalTierForPrompt = getSurvivalTier(financial.creditsCents);
      let promptTools = filterToolsByPhase(tools, earlyTaskType, survivalTierForPrompt);

      // For triage turns, restrict to ONLY read_file so tool_choice=required
      // guarantees the model reads WORKLOG.md rather than going rogue
      // (e.g., writing new HTML files, starting servers, exposing ports).
      if (earlyTaskType === "heartbeat_triage") {
        promptTools = promptTools.filter((t) => TRIAGE_ALLOWED_TOOLS.has(t.name));
      }

      // Block sleep until the healthcheck has actually run this session.
      // Without this, the agent_turn model sees "all healthy" from stale status
      // and calls sleep immediately, skipping the entire WORKLOG protocol.
      // Only unlock sleep after a healthcheck-like exec (not any arbitrary exec).
      const healthcheckRan = sessionTurns.some((t) =>
        t.toolCalls.some((tc) => {
          if (tc.name !== "exec") return false;
          const cmd = String(tc.arguments?.command ?? "");
          return (
            /health/i.test(cmd) ||
            /curl\s+.*localhost[:/]/i.test(cmd) ||
            /curl\s+.*127\.0\.0\.1[:/]/i.test(cmd)
          );
        }),
      );
      if (!healthcheckRan && earlyTaskType !== "heartbeat_triage") {
        promptTools = promptTools.filter((t) => t.name !== "sleep");
      }

      const systemPrompt = buildSystemPrompt({
        identity,
        config,
        financial,
        state: db.getAgentState(),
        db,
        tools: promptTools,
        skills,
        isFirstRun,
        taskType: earlyTaskType,
      });

      // Phase 2.2: Pre-turn memory retrieval (skip for triage to reduce input tokens)
      let memoryBlock: string | undefined;
      if (earlyTaskType !== "heartbeat_triage") {
        try {
          const retriever = new MemoryRetriever(db.raw, DEFAULT_MEMORY_BUDGET);
          const memories = retriever.retrieve(sessionId, pendingInput?.content);
          if (memories.totalTokens > 0) {
            memoryBlock = formatMemoryBlock(memories);
          }
        } catch (error) {
          logger.error("Memory retrieval failed", error instanceof Error ? error : undefined);
          // Memory failure must not block the agent loop
        }
      }

      let messages = buildContextMessages(
        systemPrompt,
        recentTurns,
        pendingInput,
      );

      // Inject memory block after system prompt, before conversation history
      if (memoryBlock) {
        messages.splice(1, 0, { role: "system", content: memoryBlock });
      }

      if (orchestrator) {
        const orchestratorTick = await orchestrator.tick();
        db.setKV("orchestrator.last_tick", JSON.stringify(orchestratorTick));
        if (
          orchestratorTick.tasksAssigned > 0 ||
          orchestratorTick.tasksCompleted > 0 ||
          orchestratorTick.tasksFailed > 0
        ) {
          log(
            config,
            `[ORCHESTRATOR] phase=${orchestratorTick.phase} assigned=${orchestratorTick.tasksAssigned} completed=${orchestratorTick.tasksCompleted} failed=${orchestratorTick.tasksFailed}`,
          );
        }
      }

      if (planModeController) {
        try {
          const todoMd = generateTodoMd(db.raw);
          messages = injectTodoContext(messages, todoMd);
        } catch (error) {
          logger.warn(
            `todo.md context injection skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // Capture input but DON'T clear yet — clearing happens after
      // successful turn recording. If inference fails, pendingInput
      // must survive so the next iteration has a user message.
      const currentInput = pendingInput;

      // ── Adaptive rate-limit cooldown ──
      // Tier 1 Haiku: 50K input tokens/min. Cooldown scales with actual token usage.
      // At 16K tokens/call: ~20s cooldown (3 calls/min = 48K tokens/min).
      // At 12K tokens/call: ~15s cooldown (4 calls/min = 48K tokens/min).
      // Minimum 5s floor. If we hit 429, the retry logic handles it.
      const INPUT_TOKENS_PER_MINUTE_LIMIT = 48_000; // 95% of Tier 1's 50K
      const estimatedTokens = lastInputTokenCount || 12_000;
      const adaptiveCooldownMs = Math.ceil((estimatedTokens / INPUT_TOKENS_PER_MINUTE_LIMIT) * 60_000);
      const MIN_INFERENCE_INTERVAL_MS = Math.max(5_000, adaptiveCooldownMs);
      const timeSinceLastInference = Date.now() - lastInferenceTimestamp;
      if (timeSinceLastInference < MIN_INFERENCE_INTERVAL_MS) {
        const waitMs = MIN_INFERENCE_INTERVAL_MS - timeSinceLastInference;
        log(config, `[COOLDOWN] Waiting ${Math.ceil(waitMs / 1000)}s (adaptive: ${Math.ceil(MIN_INFERENCE_INTERVAL_MS / 1000)}s for ~${estimatedTokens} tokens)...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      // ── Inference Call (via router when available) ──
      // Reuse survival tier and task type already computed for prompt building.
      const survivalTier = survivalTierForPrompt;
      const detectedTaskType = earlyTaskType;
      log(config, `[THINK] Routing inference (tier: ${survivalTier}, task: ${detectedTaskType}, model: ${inference.getDefaultModel()})...`);

      // Reuse the tools already filtered for the system prompt — they must match
      // the tool definitions sent to the LLM to avoid "unable to access tools".
      const inferenceTools = toolsToInferenceFormat(promptTools);
      lastInferenceTimestamp = Date.now(); // Update BEFORE call so failed attempts also apply cooldown
      const routerResult = await cascadeController.infer(
        {
          messages: messages,
          taskType: detectedTaskType,
          tier: survivalTier,
          sessionId: sessionId,
          turnId: ulid(),
          tools: inferenceTools,
        },
        inferenceRouter,
        (msgs, opts) => inference.chat(msgs, { ...opts, tools: inferenceTools }),
      );
      lastInferenceTimestamp = Date.now();
      lastInputTokenCount = routerResult.inputTokens || 0; // Track for adaptive cooldown
      emptyResponseStreak = 0; // Reset on successful inference
      rateLimitStreak = 0; // Reset on successful inference

      // Build a compatible response for the rest of the loop
      const response = {
        message: { content: routerResult.content, role: "assistant" as const },
        toolCalls: routerResult.toolCalls as any[] | undefined,
        usage: {
          promptTokens: routerResult.inputTokens,
          completionTokens: routerResult.outputTokens,
          totalTokens: routerResult.inputTokens + routerResult.outputTokens,
        },
        finishReason: routerResult.finishReason,
      };

      // ── Text-as-tool-call recovery ──
      // Some models (e.g. magistral-small-latest) output tool calls as JSON text
      // instead of using the function calling API, especially when they run out of
      // output tokens during chain-of-thought reasoning. Detect and parse these
      // so the agent can still make progress.
      if ((!response.toolCalls || response.toolCalls.length === 0) && response.message.content) {
        const textContent = typeof response.message.content === "string"
          ? response.message.content
          : String(response.message.content);
        // Require ```json (not bare ```) to avoid matching quoted data structures
        // that happen to have a "function" key (e.g. status.json contents).
        const jsonBlockRegex = /```json\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/g;
        const parsedCalls: any[] = [];
        let jsonMatch;
        while ((jsonMatch = jsonBlockRegex.exec(textContent)) !== null) {
          try {
            const obj = JSON.parse(jsonMatch[1]);
            if (obj && typeof obj.function === "string") {
              const { function: toolName, ...toolArgs } = obj;
              parsedCalls.push({
                id: Math.random().toString(36).slice(2, 11).padEnd(9, "0"),
                type: "function",
                function: {
                  name: toolName,
                  arguments: JSON.stringify(toolArgs),
                },
              });
            }
          } catch {
            // Not valid JSON, skip
          }
        }
        if (parsedCalls.length > 0) {
          // Deduplicate: reasoning models repeat the same tool calls in their
          // chain-of-thought. Keep only the first occurrence of each unique
          // name+args combination, capped at 5 to avoid executing noise.
          // Sort JSON keys for stable comparison — JSON.stringify of the same
          // object can produce different key orders, causing false non-matches.
          const seen = new Set<string>();
          const stableKey = (name: string, argsStr: string): string => {
            try {
              const obj = JSON.parse(argsStr);
              const sorted = Object.keys(obj).sort();
              return `${name}:${JSON.stringify(obj, sorted)}`;
            } catch {
              return `${name}:${argsStr}`;
            }
          };
          const deduped = parsedCalls.filter((tc) => {
            const key = stableKey(tc.function.name, tc.function.arguments);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 5);
          log(config, `[TEXT-AS-TOOL] Recovered ${deduped.length} unique tool call(s) from ${parsedCalls.length} parsed (deduped+capped)`);
          response.toolCalls = deduped;
        }
      }

      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: typeof response.message.content === "string" ? response.message.content : JSON.stringify(response.message.content ?? ""),
        toolCalls: [],
        tokenUsage: response.usage,
        costCents: routerResult.costCents,
      };

      // ── Execute Tool Calls ──
      // Guard: if the model hit max_tokens, the LAST native tool call is likely
      // truncated (e.g. write_file with no content). Detect and skip it.
      // Skip this guard for text-parsed calls — those are recovered from complete
      // JSON blocks (regex requires closing backticks), so they're never truncated.
      let toolCallsToExecute = response.toolCalls || [];
      const isTextParsed = toolCallsToExecute.length > 0 &&
        toolCallsToExecute[0].id?.length === 9 &&
        !toolCallsToExecute[0].id?.startsWith("call_");
      if (
        !isTextParsed &&
        (response.finishReason === "max_tokens" || response.finishReason === "length") &&
        toolCallsToExecute.length > 0
      ) {
        const lastTc = toolCallsToExecute[toolCallsToExecute.length - 1];
        log(config, `[TRUNCATED] Output hit max_tokens — last tool call (${lastTc.function.name}) may be incomplete. Skipping it.`);
        toolCallsToExecute = toolCallsToExecute.slice(0, -1);
        // Add a synthetic error result so the model knows what happened
        const truncatedResult: ToolCallResult = {
          id: lastTc.id,
          name: lastTc.function.name,
          arguments: {},
          result: "",
          error: `TRUNCATED: Your ${lastTc.function.name} output exceeded max_tokens (8192). For write_file: use exec with 'echo' or write <100 lines at a time. Do NOT retry the same large write.`,
          durationMs: 0,
        };
        turn.toolCalls.push(truncatedResult);
      }

      if (toolCallsToExecute.length > 0) {
        let callCount = 0;
        const currentInputSource = currentInput?.source as InputSource | undefined;

        for (const tc of toolCallsToExecute) {
          if (callCount >= MAX_TOOL_CALLS_PER_TURN) {
            log(config, `[TOOLS] Max tool calls per turn reached (${MAX_TOOL_CALLS_PER_TURN})`);
            break;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (error) {
            logger.error("Failed to parse tool arguments", error instanceof Error ? error : undefined);
            args = {};
          }

          log(config, `[TOOL] ${tc.function.name}(${JSON.stringify(args).slice(0, 100)})`);

          const result = await executeTool(
            tc.function.name,
            args,
            tools,
            toolContext,
            policyEngine,
            spendTracker ? {
              inputSource: currentInputSource,
              turnToolCallCount: turn.toolCalls.filter(t => t.name === "transfer_credits").length,
              sessionSpend: spendTracker,
            } : undefined,
          );

          // Override the ID to match the inference call's ID
          result.id = tc.id;
          turn.toolCalls.push(result);

          log(
            config,
            `[TOOL RESULT] ${tc.function.name}: ${result.error ? `ERROR: ${result.error}` : result.result.slice(0, 200)}`,
          );

          callCount++;
        }
      }

      // ── Persist Turn (atomic: turn + tool calls + inbox ack) ──
      const claimedIds = claimedMessages.map((m) => m.id);
      db.runTransaction(() => {
        db.insertTurn(turn);
        for (const tc of turn.toolCalls) {
          db.insertToolCall(turn.id, tc);
        }
        // Mark claimed inbox messages as processed (atomic with turn persistence)
        if (claimedIds.length > 0) {
          markInboxProcessed(db.raw, claimedIds);
        }
      });
      onTurnComplete?.(turn);
      sessionTurns.push(turn);
      // NOW safe to clear pendingInput — the turn was recorded successfully
      pendingInput = undefined;

      // Phase 2.2: Post-turn memory ingestion (non-blocking)
      try {
        const ingestion = new MemoryIngestionPipeline(db.raw);
        ingestion.ingest(sessionId, turn, turn.toolCalls);
      } catch (error) {
        logger.error("Memory ingestion failed", error instanceof Error ? error : undefined);
        // Memory failure must not block the agent loop
      }

      // Fix 8: Context compression — periodically compress conversation history
      // to prevent context window overflow. Runs every 3 turns for budget efficiency.
      if (compressionEngine && contextManager && cycleTurnCount > 0 && cycleTurnCount % 3 === 0) {
        try {
          const utilization = contextManager.getUtilization();
          if (utilization.utilizationPercent > 0.7) {
            const plan = await compressionEngine.evaluate(utilization);
            if (plan.maxStage > 0) {
              const compResult = await compressionEngine.execute(plan);
              if (compResult.success) {
                log(config, `[COMPRESS] Stage ${compResult.metrics.stage}: saved ${compResult.metrics.tokensSaved} tokens (${(compResult.metrics.compressionRatio * 100).toFixed(0)}%)`);
              }
            }
          }
        } catch (err) {
          logger.warn(`Context compression failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── create_goal BLOCKED fast-break ──
      // When a goal is already active, the parent loop has nothing useful to do.
      // Force sleep immediately on first BLOCKED (not second) with exponential
      // backoff so the agent doesn't wake every 2 minutes just to get BLOCKED again.
      const blockedGoalCall = turn.toolCalls.find(
        (tc) => tc.name === "create_goal" && tc.result?.includes("BLOCKED"),
      );
      if (blockedGoalCall) {
        // Exponential backoff: 2min → 4min → 8min → cap at 10min
        const prevBackoff = parseInt(db.getKV("blocked_goal_backoff") || "0", 10);
        const backoffMs = Math.min(
          prevBackoff > 0 ? prevBackoff * 2 : 120_000,
          600_000,
        );
        db.setKV("blocked_goal_backoff", String(backoffMs));
        log(config, `[LOOP] create_goal BLOCKED — sleeping ${Math.round(backoffMs / 1000)}s (backoff).`);
        db.setKV("sleep_until", new Date(Date.now() + backoffMs).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      } else if (turn.toolCalls.some((tc) => tc.name === "create_goal" && !tc.error)) {
        // Goal was successfully created — reset backoff
        db.deleteKV("blocked_goal_backoff");
      }

      // ── Loop Detection ──
      if (turn.toolCalls.length > 0) {
        // Normalize tool call patterns for loop detection.
        // For exec commands: extract the core URL/target to avoid flag
        // variations like "curl http://..." vs "curl -v http://..." from
        // appearing as different patterns.
        const currentPattern = turn.toolCalls
          .map((tc) => {
            if (tc.name === "exec") {
              const cmd = String((tc.arguments as Record<string, unknown>)?.command ?? "");
              // Extract URL from curl-like commands for consistent matching
              const urlMatch = cmd.match(/https?:\/\/[^\s'"]+/);
              if (urlMatch) return `exec:curl:${urlMatch[0]}`;
              // Fallback: first 30 chars of the command
              return `exec:${cmd.slice(0, 30)}`;
            }
            if (tc.name === "write_file" || tc.name === "read_file") {
              const argSnippet = JSON.stringify(tc.arguments).slice(0, 30);
              return `${tc.name}:${argSnippet}`;
            }
            return tc.name;
          })
          .sort()
          .join(",");
        lastToolPatterns.push(currentPattern);

        // Keep only the last MAX_REPETITIVE_TURNS entries
        if (lastToolPatterns.length > MAX_REPETITIVE_TURNS) {
          lastToolPatterns = lastToolPatterns.slice(-MAX_REPETITIVE_TURNS);
        }

        // Reset enforcement tracker if agent changed behavior
        if (loopWarningPattern && currentPattern !== loopWarningPattern) {
          loopWarningPattern = null;
        }

        // ── Loop Enforcement Escalation ──
        // If we already warned about this pattern and the agent STILL repeats, force sleep.
        if (
          loopWarningPattern &&
          currentPattern === loopWarningPattern &&
          lastToolPatterns.length === MAX_REPETITIVE_TURNS &&
          lastToolPatterns.every((p) => p === currentPattern)
        ) {
          log(config, `[LOOP] Enforcement: agent ignored loop warning, forcing sleep.`);
          pendingInput = {
            content: `[loop-enforcement:${currentPattern}] sleeping`,
            source: "system",
          };
          loopWarningPattern = null;
          lastToolPatterns = [];
          db.setAgentState("sleeping");
          onStateChange?.("sleeping");
          running = false;
          break;
        }

        // Check if the same pattern repeated MAX_REPETITIVE_TURNS times
        if (
          lastToolPatterns.length === MAX_REPETITIVE_TURNS &&
          lastToolPatterns.every((p) => p === currentPattern)
        ) {
          log(config, `[LOOP] Repetitive pattern detected: ${currentPattern}`);
          pendingInput = {
            content: `STOP. You are stuck in a loop repeating: ${currentPattern}. This action is DONE — do NOT call it again. Read your WORKLOG.md pending tasks and pick the NEXT uncompleted item. If all items are done, call sleep.`,
            source: "system",
          };
          loopWarningPattern = currentPattern;
          lastToolPatterns = [];
        }

        // Detect multi-tool maintenance loops: all tools in the turn are idle-only,
        // even if the specific combination varies across consecutive turns.
        const isAllIdleTools = turn.toolCalls.every((tc) => IDLE_ONLY_TOOLS.has(tc.name));
        if (isAllIdleTools) {
          idleToolTurns++;
          if (idleToolTurns >= MAX_REPETITIVE_TURNS && !pendingInput) {
            log(config, `[LOOP] Maintenance loop detected: ${idleToolTurns} consecutive idle-only turns`);
            pendingInput = {
              content: `[idle-loop:${idleToolTurns}x] status known, build something`,
              source: "system",
            };
            idleToolTurns = 0;
          }
        } else {
          idleToolTurns = 0;
        }

        // Detect write_file churn: repeated file writes across turns (even interleaved with exec)
        if (turn.toolCalls.some((tc) => tc.name === "write_file")) {
          writeFileCount++;
          if (writeFileCount >= 4 && !pendingInput) {
            log(config, `[LOOP] Write churn detected: ${writeFileCount} write_file calls across recent turns`);
            pendingInput = {
              content: `[write-churn:${writeFileCount}x] start existing file instead of rewriting`,
              source: "system",
            };
            writeFileCount = 0;
          }
        } else {
          // Reset counter when a non-write turn breaks the streak
          writeFileCount = 0;
        }
      }

      // Log the turn
      if (turn.thinking) {
        log(config, `[THOUGHT] ${turn.thinking.slice(0, 300)}`);
      }

      // ── Check for sleep command ──
      const sleepTool = turn.toolCalls.find((tc) => tc.name === "sleep");
      if (sleepTool && !sleepTool.error) {
        log(config, "[SLEEP] Agent chose to sleep.");
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── Idle turn detection ──
      // If this turn had no pending input and didn't do any real work
      // (no mutations — only read/check/list/info tools), count as idle.
      // MUTATING_TOOLS is hoisted above the while loop.
      const didMutate = turn.toolCalls.some((tc) => MUTATING_TOOLS.has(tc.name));

      if (!currentInput && !didMutate) {
        idleTurnCount++;
        if (idleTurnCount >= MAX_IDLE_TURNS) {
          log(config, `[IDLE] ${idleTurnCount} consecutive idle turns with no work. Sleeping 5min.`);
          db.setKV("sleep_until", new Date(Date.now() + 300_000).toISOString());
          db.setAgentState("sleeping");
          onStateChange?.("sleeping");
          running = false;
          break;
        }
      } else {
        idleTurnCount = 0;
      }

      // ── Cycle turn limit ──
      // Hard ceiling on turns per wake cycle, regardless of tool type.
      // Prevents runaway loops where mutating tools (exec, write_file)
      // defeat idle detection indefinitely.
      cycleTurnCount++;
      if (running && cycleTurnCount >= maxCycleTurns) {
        log(config, `[CYCLE LIMIT] ${cycleTurnCount} turns reached (max: ${maxCycleTurns}). Forcing sleep.`);
        db.setKV("sleep_until", new Date(Date.now() + 120_000).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── If no tool calls and just text, the agent might be done thinking ──
      // Catches both "stop" (natural end) and "length"/"max_tokens" (model ran
      // out of output tokens during reasoning before emitting tool calls).
      // Without this, text-only + length triggers a retry loop that hits
      // Mistral's message ordering constraint (assistant→assistant is invalid).
      if (
        running &&
        (!response.toolCalls || response.toolCalls.length === 0)
      ) {
        // Agent produced text without tool calls.
        // This is a natural pause point -- no work queued, sleep longer.
        log(config, `[IDLE] Text-only response (finishReason: ${response.finishReason}). Sleeping 5min.`);
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 300_000).toISOString(),
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
      }

      consecutiveErrors = 0;

      // Inter-turn pacing is handled by the adaptive cooldown above (lines 557-571).
      // No additional tier-based delay needed — it was double-stacking 1-10s of waste.
    } catch (err: any) {
      const errMsg: string = err?.message ?? String(err);

      // ── Circuit breaker wait ──
      // When the circuit breaker is open, parse the reset timestamp and
      // wait for it to clear instead of counting it as an error.
      if (err instanceof CircuitOpenError || errMsg.includes("Circuit breaker is open")) {
        let waitMs = 60_000; // default fallback
        if (err instanceof CircuitOpenError) {
          waitMs = Math.max(err.resetAt - Date.now(), 1_000);
        } else {
          // Parse "Circuit breaker is open until <ISO timestamp>"
          const match = errMsg.match(/until\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
          if (match) {
            waitMs = Math.max(new Date(match[1]).getTime() - Date.now(), 1_000);
          }
        }
        log(config, `[RATE_LIMIT] Circuit breaker open. Waiting ${Math.ceil(waitMs / 1000)}s for it to clear...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs + 1_000));
        // Do NOT increment consecutiveErrors — this is expected transient behavior
        continue;
      }

      // ── Cascade exhausted (all pools failed) ──
      // When every provider pool has been tried and failed (429, 500, etc.),
      // the CascadeController throws CascadeExhaustedError. This is transient —
      // providers will recover. Apply rate-limit-style backoff with a 30s floor.
      if (err instanceof CascadeExhaustedError) {
        rateLimitStreak++;
        const backoffMs = Math.max(30_000, Math.min(60_000 * Math.pow(2, rateLimitStreak - 1), 300_000));
        log(config, `[CASCADE_EXHAUSTED] All pools exhausted. Waiting ${Math.ceil(backoffMs / 1000)}s before retry.`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        // Do NOT increment consecutiveErrors — cascade exhaustion is transient
        continue;
      }

      // ── Ollama infrastructure errors ──
      // Ollama not running (ECONNREFUSED/ECONNRESET/ENOTFOUND) or OOM.
      // Wait and retry — these are transient, not permanent failures.
      const isOllamaInfra = /ECONNREFUSED|ECONNRESET|ENOTFOUND/i.test(errMsg);
      const isOllamaOOM = /system memory|out of memory/i.test(errMsg);
      if (isOllamaInfra || isOllamaOOM) {
        const waitMs = isOllamaOOM ? 60_000 : 30_000;
        const reason = isOllamaOOM ? "Ollama OOM" : "Ollama not running";
        logger.warn(`[OLLAMA] ${reason}. Waiting ${waitMs / 1000}s before retry...`);
        await new Promise((r) => setTimeout(r, waitMs));
        consecutiveErrors++;
        continue;
      }

      // ── Rate limit (429) wait ──
      // A 429 is expected under heavy use. Use exponential backoff:
      // 60s → 120s → 240s → 300s cap. Avoids burning through daily quotas.
      if (errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit")) {
        rateLimitStreak++;
        const backoffMs = Math.min(60_000 * Math.pow(2, rateLimitStreak - 1), 300_000);
        log(config, `[RATE_LIMIT] 429 rate limit hit (streak ${rateLimitStreak}). Waiting ${Math.ceil(backoffMs / 1000)}s before retry...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        // Do NOT increment consecutiveErrors — rate limits are transient
        continue;
      }

      // ── Empty completion (transient) ──
      // The API sometimes returns empty responses under load/rate limits.
      // Use exponential backoff: 15s → 30s → 60s → 60s...
      if (errMsg.includes("No completion content")) {
        emptyResponseStreak++;
        const backoffMs = Math.min(15_000 * Math.pow(2, emptyResponseStreak - 1), 60_000);
        log(config, `[EMPTY_RESPONSE] ${errMsg}. Streak: ${emptyResponseStreak}, waiting ${Math.ceil(backoffMs / 1000)}s...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      // ── Billing/auth exhaustion (non-transient) ──
      // If the provider is out of credits and no fallback succeeded,
      // retrying won't help. Sleep immediately instead of burning 5 retries.
      if (/credit balance is too low|insufficient.*funds|payment.*required/i.test(errMsg)) {
        log(config, `[BILLING] Provider credits exhausted. Sleeping 5min.`);
        db.setKV("sleep_until", new Date(Date.now() + 300_000).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── All other errors ──
      consecutiveErrors++;
      log(config, `[ERROR] Turn failed: ${errMsg}`);

      // Handle inbox message state on turn failure:
      // Messages that have retries remaining go back to 'received';
      // messages that have exhausted retries move to 'failed'.
      if (claimedMessages.length > 0) {
        const exhausted = claimedMessages.filter((m) => m.retryCount >= m.maxRetries);
        const retryable = claimedMessages.filter((m) => m.retryCount < m.maxRetries);

        if (exhausted.length > 0) {
          markInboxFailed(db.raw, exhausted.map((m) => m.id));
          log(config, `[INBOX] ${exhausted.length} message(s) moved to failed (max retries exceeded)`);
        }
        if (retryable.length > 0) {
          resetInboxToReceived(db.raw, retryable.map((m) => m.id));
          log(config, `[INBOX] ${retryable.length} message(s) reset to received for retry`);
        }
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(
          config,
          `[FATAL] ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Sleeping.`,
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 300_000).toISOString(),
        );
        running = false;
      }
    }
  }

  log(config, `[LOOP END] Agent loop finished. State: ${db.getAgentState()}`);
}

// ─── Helpers ───────────────────────────────────────────────────

// Cache last known good balances so transient API failures don't
// cause the automaton to believe it has $0 and kill itself.
let _lastKnownCredits = 0;
let _lastKnownUsdc = 0;

async function getFinancialState(
  _conway: ConwayClient,
  address: string,
  db?: AutomatonDatabase,
): Promise<FinancialState> {
  let creditsCents = _lastKnownCredits;
  let usdcBalance = _lastKnownUsdc;

  // Phase 4: Single on-chain USDC balance replaces both credits and USDC
  try {
    const result = await getOnChainBalance(address as `0x${string}`);
    if (result.ok) {
      creditsCents = result.balanceCents;
      usdcBalance = result.balanceUsd;
      // Always update cache on successful fetch — even if balance is zero.
      // The old `> 0` guard would mask genuine zero balances.
      _lastKnownCredits = creditsCents;
      _lastKnownUsdc = usdcBalance;
    } else {
      throw new Error(result.error || "Balance fetch failed");
    }
  } catch (error) {
    logger.error("USDC balance fetch failed", error instanceof Error ? error : undefined);
    // Use last known balance from KV, not zero
    if (db) {
      const cached = db.getKV("last_known_balance");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          logger.warn("Balance fetch failed, using cached balance");
          return {
            creditsCents: parsed.creditsCents ?? 0,
            usdcBalance: parsed.usdcBalance ?? 0,
            lastChecked: new Date().toISOString(),
          };
        } catch (parseError) {
          logger.error("Failed to parse cached balance", parseError instanceof Error ? parseError : undefined);
        }
      }
    }
    // No cache available -- return conservative non-zero sentinel
    logger.error("Balance fetch failed, no cache available");
    return {
      creditsCents: -1,
      usdcBalance: -1,
      lastChecked: new Date().toISOString(),
    };
  }

  // Cache successful balance reads
  if (db) {
    try {
      db.setKV(
        "last_known_balance",
        JSON.stringify({ creditsCents, usdcBalance }),
      );
    } catch (error) {
      logger.error("Failed to cache balance", error instanceof Error ? error : undefined);
    }
  }

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

function log(_config: AutomatonConfig, message: string): void {
  logger.info(message);
}

/**
 * Fix 4: Filter tools by phase and survival tier.
 * Reduces the tool definition token overhead by only including tools
 * relevant to the current execution phase.
 */
function filterToolsByPhase(
  tools: AutomatonTool[],
  taskType: import("../types.js").InferenceTaskType,
  tier: import("../types.js").SurvivalTier,
): AutomatonTool[] {
  // Always include core tools that the agent needs regardless of phase
  const CORE_TOOLS = new Set([
    "exec", "read_file", "write_file", "sleep", "check_credits",
    "system_synopsis", "review_memory",
  ]);

  // In critical/low_compute tiers, strip down to survival-essential tools
  if (tier === "critical" || tier === "dead") {
    const SURVIVAL_TOOLS = new Set([
      ...CORE_TOOLS,
      "transfer_credits",
      "distress_signal", "enter_low_compute", "switch_model",
    ]);
    return tools.filter(t => SURVIVAL_TOOLS.has(t.name));
  }

  // For orientation/heartbeat turns, use a smaller status-focused subset.
  // Include "skills" so the agent can act on loaded skill instructions
  // (e.g. list_skills) and "vm" so exec is available for operational tasks
  // like health-checking deployed services via curl.
  if (taskType === "heartbeat_triage") {
    const ORIENTATION_CATEGORIES = new Set(["survival", "financial", "memory", "skills", "vm"]);
    return tools.filter(t =>
      CORE_TOOLS.has(t.name) ||
      ORIENTATION_CATEGORIES.has(t.category) ||
      t.name === "list_goals" ||
      t.name === "orchestrator_status" ||
      t.name === "list_children" ||
      t.name === "check_child_status" ||
      t.name === "create_goal"
    );
  }

  // For planning turns, include orchestration + strategy tools
  if (taskType === "planning") {
    const PLANNING_CATEGORIES = new Set(["survival", "financial", "memory", "replication"]);
    return tools.filter(t =>
      CORE_TOOLS.has(t.name) ||
      PLANNING_CATEGORIES.has(t.category) ||
      t.name === "create_goal" ||
      t.name === "list_goals" ||
      t.name === "get_plan" ||
      t.name === "cancel_goal" ||
      t.name === "orchestrator_status" ||
      t.name === "spawn_child" ||
      t.name === "list_children" ||
      t.name === "fund_child"
    );
  }

  // For full agent_turn execution, include all tools (no filtering)
  return tools;
}

/**
 * Fix 7: Detect the task type based on input content and recent turn history.
 * This enables the inference router to select cheaper models for simple
 * orientation tasks and reserve expensive models for complex work.
 */
function detectTaskType(
  currentInput: { content: string; source: string } | undefined,
  recentTurns: AgentTurn[],
): import("../types.js").InferenceTaskType {
  const input = currentInput?.content?.toLowerCase() ?? "";
  const source = currentInput?.source ?? "";

  // Wakeup / orientation turns: agent just woke up, checking status
  if (source === "wakeup" || input.includes("waking up") || input.includes("wake-up")) {
    return "heartbeat_triage";
  }

  // System-injected loop warnings and maintenance messages need full tools
  // to recover. heartbeat_triage would strip tools to read_file only,
  // making the "pick the NEXT task" directive impossible to follow.
  if (source === "system" && (input.includes("loop detected") || input.includes("loop enforcement") || input.includes("maintenance loop"))) {
    return "agent_turn";
  }

  // If recent turns are all idle/status checks, this is orientation
  if (recentTurns.length > 0) {
    const ORIENTATION_TOOLS = new Set([
      "check_credits", "system_synopsis", "review_memory",
      "list_children", "check_child_status", "list_sandboxes", "list_models",
      "list_skills", "git_status", "git_log", "check_reputation",
      "recall_facts", "recall_procedure", "heartbeat_ping",
      "check_inference_spending", "orchestrator_status", "list_goals", "get_plan",
    ]);
    const lastTurn = recentTurns[recentTurns.length - 1];
    const allOrientationLastTurn = lastTurn.toolCalls.length > 0 &&
      lastTurn.toolCalls.every(tc => ORIENTATION_TOOLS.has(tc.name));
    if (allOrientationLastTurn && recentTurns.length <= 3) {
      return "heartbeat_triage";
    }
  }

  // Planning-related input
  if (input.includes("plan") || input.includes("decompose") || input.includes("strategy") || input.includes("goal")) {
    return "planning";
  }

  // Default to agent_turn for complex execution
  return "agent_turn";
}

function hasTable(db: AutomatonDatabase["raw"], tableName: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}
