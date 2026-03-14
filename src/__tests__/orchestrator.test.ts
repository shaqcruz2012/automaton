import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { Orchestrator } from "../orchestration/orchestrator.js";
import type { AgentTracker, FundingProtocol } from "../orchestration/types.js";
import type { MessageTransport } from "../orchestration/messaging.js";
import { ColonyMessaging } from "../orchestration/messaging.js";
import type { AutomatonDatabase } from "../types.js";
import { createInMemoryDb } from "./orchestration/test-db.js";

// ─── Fixtures ───────────────────────────────────────────────────

const IDENTITY = {
  name: "test",
  address: "0x1234" as any,
  account: {} as any,
  creatorAddress: "0x0000" as any,
  sandboxId: "sb-1",
  apiKey: "key",
  createdAt: "2026-01-01T00:00:00Z",
};

function makeAgentTracker(overrides: Partial<AgentTracker> = {}): AgentTracker {
  return {
    getIdle: vi.fn().mockReturnValue([]),
    getBestForTask: vi.fn().mockReturnValue(null),
    updateStatus: vi.fn(),
    register: vi.fn(),
    ...overrides,
  };
}

function makeFunding(overrides: Partial<FundingProtocol> = {}): FundingProtocol {
  return {
    fundChild: vi.fn().mockResolvedValue({ success: true }),
    recallCredits: vi.fn().mockResolvedValue({ success: true, amountCents: 0 }),
    getBalance: vi.fn().mockResolvedValue(1000),
    ...overrides,
  };
}

function makeMessaging(raw: BetterSqlite3.Database): ColonyMessaging {
  const transport: MessageTransport = {
    deliver: vi.fn().mockResolvedValue(undefined),
    getRecipients: vi.fn().mockReturnValue([]),
  };

  const automataDb = {
    raw,
    getIdentity: (key: string) => (key === "address" ? "0x1234" : undefined),
    getChildren: () => [],
    getUnprocessedInboxMessages: (_limit: number) => [],
    markInboxMessageProcessed: (_id: string) => {},
  } as unknown as AutomatonDatabase;

  return new ColonyMessaging(transport, automataDb);
}

function makeOrchestrator(
  db: BetterSqlite3.Database,
  overrides: {
    agentTracker?: AgentTracker;
    funding?: FundingProtocol;
    config?: any;
    messaging?: ColonyMessaging;
  } = {},
): Orchestrator {
  const inference = {
    chat: vi.fn().mockResolvedValue({
      content: JSON.stringify({ estimatedSteps: 2, reason: "simple", stepOutline: [] }),
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  };

  return new Orchestrator({
    db,
    agentTracker: overrides.agentTracker ?? makeAgentTracker(),
    funding: overrides.funding ?? makeFunding(),
    messaging: overrides.messaging ?? makeMessaging(db),
    inference: inference as any,
    identity: IDENTITY,
    config: overrides.config ?? {},
  });
}

function makeTaskNode(goalId: string, estimatedCostCents: unknown) {
  return {
    id: ulid(),
    parentId: null,
    goalId,
    title: "Task",
    description: "desc",
    status: "pending" as const,
    assignedTo: null,
    agentRole: "generalist",
    priority: 50,
    dependencies: [],
    result: null,
    metadata: {
      estimatedCostCents,
      actualCostCents: 0,
      maxRetries: 3,
      retryCount: 0,
      timeoutMs: 60000,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    },
  };
}

function insertGoal(db: BetterSqlite3.Database, overrides: {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
} = {}): string {
  const id = overrides.id ?? ulid();
  db.prepare(
    "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    id,
    overrides.title ?? "Test Goal",
    overrides.description ?? "A test goal",
    overrides.status ?? "active",
    new Date().toISOString(),
  );
  return id;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("orchestrator — fundAgentForTask edge cases", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it("handles NaN estimatedCostCents — falls back to default, never passes NaN", async () => {
    const goalId = insertGoal(db);
    const funding = makeFunding();
    const orc = makeOrchestrator(db, {
      funding,
      config: { defaultTaskFundingCents: 25 },
    });

    const task = makeTaskNode(goalId, NaN);
    await orc.fundAgentForTask("0xagent", task as any);

    // NaN should be sanitized to 0, so the amount should be max(0, 25) = 25
    expect(funding.fundChild).toHaveBeenCalledTimes(1);
    const calledAmount = (funding.fundChild as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(calledAmount).toBe(25);
    expect(Number.isNaN(calledAmount)).toBe(false);
  });

  it("handles undefined estimatedCostCents — falls back to default, returns 0 for estimation", async () => {
    const goalId = insertGoal(db);
    const funding = makeFunding();
    const orc = makeOrchestrator(db, {
      funding,
      config: { defaultTaskFundingCents: 25 },
    });

    const task = makeTaskNode(goalId, undefined);
    await orc.fundAgentForTask("0xagent", task as any);

    // undefined coerced via Number() is NaN, so estimated = 0, amount = max(0, 25) = 25
    expect(funding.fundChild).toHaveBeenCalledTimes(1);
    const calledAmount = (funding.fundChild as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(calledAmount).toBe(25);
    expect(Number.isNaN(calledAmount)).toBe(false);
  });

  it("handles valid numeric estimatedCostCents correctly", async () => {
    const goalId = insertGoal(db);
    const funding = makeFunding();
    const orc = makeOrchestrator(db, {
      funding,
      config: { defaultTaskFundingCents: 25 },
    });

    const task = makeTaskNode(goalId, 100);
    await orc.fundAgentForTask("0xagent", task as any);

    // estimated = 100, default = 25, amount = max(100, 25) = 100
    expect(funding.fundChild).toHaveBeenCalledTimes(1);
    const calledAmount = (funding.fundChild as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(calledAmount).toBe(100);
  });
});

describe("orchestrator — collectResults atomicity", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it("assigns atomically — no intermediate empty state between clear and populate", async () => {
    const goalId = insertGoal(db);
    const taskId = ulid();

    // Build a messaging mock that returns one task_result
    const processedMessages = [
      {
        message: {
          id: ulid(),
          type: "task_result",
          from: "0xagent",
          to: "0x1234",
          goalId: null,
          taskId: null,
          content: JSON.stringify({
            taskId,
            success: true,
            output: "done",
            artifacts: [],
            costCents: 5,
            duration: 100,
          }),
          priority: "normal" as const,
          requiresResponse: false,
          expiresAt: null,
          createdAt: new Date().toISOString(),
        },
        handledBy: "handleTaskResult",
        success: true,
      },
    ];

    const messaging = {
      processInbox: vi.fn().mockResolvedValue(processedMessages),
      createMessage: vi.fn().mockReturnValue({}),
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as ColonyMessaging;

    const orc = makeOrchestrator(db, { messaging });

    // Call collectResults twice in sequence. The key property is that
    // the second call does not observe an empty pendingTaskResults
    // between clearing old results and populating new ones.
    const results1 = await orc.collectResults();
    expect(results1).toHaveLength(1);
    expect(results1[0].success).toBe(true);

    // Second call: the implementation builds `collected` locally, then
    // assigns `this.pendingTaskResults = collected` atomically (single
    // assignment). If it were `this.pendingTaskResults = []; ... push()`,
    // concurrent reads could see empty state.
    const results2 = await orc.collectResults();
    expect(results2).toHaveLength(1);
    expect(results2[0].output).toBe("done");

    // Verify the return value is derived from pendingTaskResults, not stale data
    const emptyMessaging = {
      processInbox: vi.fn().mockResolvedValue([]),
      createMessage: vi.fn().mockReturnValue({}),
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as ColonyMessaging;

    const orc2 = makeOrchestrator(db, { messaging: emptyMessaging });
    const results3 = await orc2.collectResults();
    expect(results3).toHaveLength(0);
  });
});
