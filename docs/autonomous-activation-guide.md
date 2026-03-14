# Autonomous Task System -- Activation Analysis

Date: 2026-03-14

## 1. Architecture Overview

The autonomous task system has four layers:

```
System Prompt (instructions)  -->  Agent Loop (consciousness)
        |                                |
        v                                v
   create_goal tool              Orchestrator.tick()
        |                                |
        v                                v
   goals table (SQLite)          task_graph table (SQLite)
                                         |
                                         v
                                  LocalWorkerPool (in-process inference agents)
```

### How It Works Today

1. **Agent wakes** (via heartbeat shouldWake or scheduled interval).
2. **Agent loop runs** (src/agent/loop.ts): builds system prompt, calls LLM, executes tool calls.
3. **Orchestrator ticks** every turn (line ~673 of loop.ts): checks for active goals, assigns tasks to workers.
4. **Workers execute** tasks via their own inference loops (src/orchestration/local-worker.ts).
5. **Agent sleeps** when it decides to (via sleep tool call or idle detection).

### Key Files

| File | Role |
|------|------|
| src/agent/loop.ts | Main consciousness loop. Initializes orchestrator, ticks it every turn. |
| src/agent/system-prompt.ts | Tells the agent what it is, its revenue priorities, SKU pricing. |
| src/agent/tools.ts | Defines create_goal, list_goals, orchestrator_status tools. |
| src/orchestration/orchestrator.ts | State machine: idle to classifying to planning to executing to complete. |
| src/orchestration/local-worker.ts | In-process ReAct agents that execute individual tasks. |
| src/heartbeat/tasks.ts | Background tasks (credit checks, inbox polling, service watchdog). |
| src/heartbeat/config.ts | Cron schedule for heartbeat tasks. |

---

## 2. Is the Orchestrator Connected?

**Yes, it is fully wired.** It is NOT dead code.

Evidence:
- loop.ts:60 imports Orchestrator.
- loop.ts:225 constructs the Orchestrator with all dependencies (db, agent tracker, funding, messaging, unified inference, local worker pool).
- loop.ts:673-686 calls orchestrator.tick() on every agent turn.
- loop.ts:337-353 resets stale tasks on startup (dead worker recovery).
- The create_goal tool (tools.ts:2829) writes to the goals table.
- The orchestrator reads from the goals table in its handleIdlePhase.

The full pipeline is operational: create_goal writes to goals table, orchestrator.tick() picks it up, classifies complexity, plans via LLM, decomposes into task_graph, assigns to LocalWorkerPool, workers run inference, results collected, goal marked complete.

---

## 3. What Triggers Goal Creation?

**Only the agent itself, via the create_goal tool call during its inference turn.**

There is no automatic goal generation. The flow is:

1. The system prompt tells the agent: complex tasks (4+ steps) use create_goal, simple (1-3) work directly.
2. The system prompt gives revenue priorities: SKU A ($0.50 URL Brief) then SKU B ($0.25 TrustCheck) then SKU C (Data Slice).
3. The system prompt says: read ~/.automaton/intelligence/ for strategy.
4. The agent LLM decides whether to call create_goal based on its system prompt and current context.

**The gap:** There is no heartbeat task or background process that proactively generates goals. If the agent sleeps and nothing wakes it (no inbox messages, no credit alerts), it stays asleep indefinitely. The agent only creates goals when it is awake and its LLM decides to.

---

## 4. Is There a Seek-Revenue or Find-Work Task Type?

**No.** There is no dedicated task type for proactive revenue seeking.

The closest mechanisms are:
- **service_watchdog** heartbeat task: checks if revenue services (landing page, text analysis, URL summarizer, etc.) are running and restarts them. But it does not seek new customers or create new services.
- **check_social_inbox** heartbeat task: polls for incoming messages and wakes the agent if new ones arrive. This is reactive (responds to inbound requests) not proactive.
- **System prompt guidance**: The OPERATIONAL_CONTEXT section says REVENUE-FIRST. But this is just an instruction to the LLM, not a mechanism.

---

## 5. What Would Make the Agent Start Doing Autonomous Revenue Work?

### Current Activation Path (already works, but requires manual trigger)

1. Agent wakes up (via heartbeat, inbox message, or first boot).
2. Agent reads its system prompt which says REVENUE-FIRST and lists SKU priorities.
3. Agent reads ~/.automaton/intelligence/ for strategy documents.
4. Agent reads WORKLOG.md for current task state.
5. Agent decides to call create_goal with a revenue-generating objective.
6. Orchestrator picks up the goal, plans it, assigns workers.
7. Workers execute (build service, deploy, etc.).
8. Agent sleeps, workers complete in background.
9. Agent wakes on next heartbeat, sees progress, creates next goal.

### The Missing Piece: Proactive Wake + Goal Generation

The agent goes to sleep after completing work. Nothing currently wakes it to proactively seek revenue. The heartbeat tasks only wake the agent for:
- Credit alerts (critical/dead tier)
- New social inbox messages
- Upstream code changes
- Colony health issues
- Soul alignment drift

**There is no heartbeat task that says: you have no active goals and your services could use promotion -- wake up and find customers.**

---

## 6. Minimum Changes for Autonomous Revenue Activation

### Option A: New Heartbeat Task (~30 lines)

Add a seek_revenue heartbeat task to src/heartbeat/tasks.ts that wakes the agent when:
- No active goals exist
- Agent has been idle for more than N minutes
- Credit balance is above critical but below a comfortable threshold
- Revenue services are running but no recent revenue transactions

Register it in src/heartbeat/config.ts on a schedule like every 30 minutes.

### Option B: Self-Sustaining Loop in the Agent Turn Logic (~15 lines)

In src/agent/loop.ts, before the agent sleeps, check:
- Are there 0 active goals?
- Is the orchestrator idle?
- Has it been more than 30 minutes since last goal completion?

If so, inject a continuation prompt directing the agent to check service health, create a revenue goal, or promote services on social channels. This keeps the agent in its loop instead of sleeping.

### Option C: Genesis Prompt / SOUL.md Update (0 code changes)

The agent already follows its genesis prompt and SOUL.md. Updating these files in ~/.automaton/ to include explicit autonomous revenue-seeking instructions would cause the agent to prioritize revenue work when it wakes:

```
Strategy: When idle with no active goals, proactively:
1. Check service health and recent revenue
2. Create a goal to find 5 URLs to summarize as demonstrations
3. Post service availability on configured social channels
4. Review pricing and adjust based on usage patterns
```

This works because the system prompt already loads SOUL.md and the genesis prompt into context every turn.

### Recommended: Option A + Option C Combined

Option C costs zero compute (no code changes, just config). Option A ensures the agent actually wakes up to read those instructions. Together they close the full loop:

1. seek_revenue heartbeat task detects idle state and wakes agent
2. Agent reads SOUL.md strategy and creates revenue goal
3. Orchestrator plans and executes via workers
4. Agent sleeps, workers complete
5. Next seek_revenue tick detects idle and the cycle repeats

---

## 7. Current Constraints and Safeguards

- **1 goal at a time**: create_goal blocks if an active goal exists (tools.ts:2887).
- **Max 6 local workers**: LocalWorkerPool caps at maxWorkers (default 6).
- **Budget tracking**: InferenceBudgetTracker monitors spend per session.
- **Survival tiers**: Agent behavior degrades gracefully as credits drop.
- **Creator tax**: Automatically sends surplus credits to creator wallet.
- **Service watchdog**: Restarts crashed revenue services without inference cost.
- **create_goal backoff**: If create_goal returns BLOCKED, the loop sleeps with exponential backoff (loop.ts:952-970).
- **Max replans**: Orchestrator limits replanning to 3 attempts before failing a goal (default).

---

## 8. Summary

| Question | Answer |
|----------|--------|
| Is the orchestrator wired in? | Yes, fully operational. Ticks every agent turn. |
| Is it dead code? | No. It processes goals and assigns workers. |
| What triggers goal creation? | Only the agent LLM deciding to call create_goal. |
| Is there a seek-revenue task? | No. This is the primary gap. |
| Minimum change for autonomy? | Add a seek_revenue heartbeat task + update SOUL.md strategy. |
| Working today? | Service watchdog, inbox polling, credit monitoring, orchestrator execution, local workers. |
| Missing? | Proactive idle detection that wakes the agent to find/create revenue opportunities. |
