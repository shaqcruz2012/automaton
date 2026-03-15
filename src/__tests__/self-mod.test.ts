/**
 * Self-Modification Module Tests
 *
 * Covers:
 *   - audit-log.ts  — logModification, getRecentModifications, generateAuditReport
 *   - tools-manager.ts — installNpmPackage, installMcpServer, listInstalledTools, removeTool
 *   - upstream.ts   — getRepoInfo, checkUpstream, getUpstreamDiffs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  AutomatonDatabase,
  ModificationEntry,
  InstalledTool,
} from "../types.js";

// ─── Mock child_process before upstream.ts is imported ──────────────────────
// upstream.ts calls execFileSync at module scope (REPO_ROOT = process.cwd())
// and inside each function. We stub the module entirely.
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "child_process";

// Lazy imports so mocks are wired before module evaluation
const { logModification, getRecentModifications, generateAuditReport } =
  await import("../self-mod/audit-log.js");
const { installNpmPackage, installMcpServer, listInstalledTools, removeTool } =
  await import("../self-mod/tools-manager.js");
const { getRepoInfo, checkUpstream, getUpstreamDiffs } = await import(
  "../self-mod/upstream.js"
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(overrides: Partial<AutomatonDatabase> = {}): AutomatonDatabase {
  return {
    // Modifications
    insertModification: vi.fn(),
    getRecentModifications: vi.fn().mockReturnValue([]),
    // Installed tools
    getInstalledTools: vi.fn().mockReturnValue([]),
    installTool: vi.fn(),
    removeTool: vi.fn(),
    // Remaining interface stubs — not exercised here
    getIdentity: vi.fn(),
    setIdentity: vi.fn(),
    insertTurn: vi.fn(),
    getRecentTurns: vi.fn().mockReturnValue([]),
    getTurnById: vi.fn(),
    getTurnCount: vi.fn().mockReturnValue(0),
    insertToolCall: vi.fn(),
    getToolCallsForTurn: vi.fn().mockReturnValue([]),
    getHeartbeatEntries: vi.fn().mockReturnValue([]),
    upsertHeartbeatEntry: vi.fn(),
    updateHeartbeatLastRun: vi.fn(),
    insertTransaction: vi.fn(),
    getRecentTransactions: vi.fn().mockReturnValue([]),
    getKV: vi.fn(),
    setKV: vi.fn(),
    deleteKV: vi.fn(),
    deleteKVReturning: vi.fn(),
    getSkills: vi.fn().mockReturnValue([]),
    getSkillByName: vi.fn(),
    upsertSkill: vi.fn(),
    removeSkill: vi.fn(),
    getChildren: vi.fn().mockReturnValue([]),
    getChildById: vi.fn(),
    insertChild: vi.fn(),
    updateChildStatus: vi.fn(),
    getRegistryEntry: vi.fn(),
    setRegistryEntry: vi.fn(),
    insertReputation: vi.fn(),
    getReputation: vi.fn().mockReturnValue([]),
    insertInboxMessage: vi.fn(),
    getUnprocessedInboxMessages: vi.fn().mockReturnValue([]),
    markInboxMessageProcessed: vi.fn(),
    getAgentState: vi.fn().mockReturnValue("running"),
    setAgentState: vi.fn(),
    runTransaction: vi.fn((fn: () => unknown) => fn()),
    close: vi.fn(),
    raw: {} as AutomatonDatabase["raw"],
    ...overrides,
  };
}

function makeConway() {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    exposePort: vi.fn(),
    removePort: vi.fn(),
    createSandbox: vi.fn(),
    deleteSandbox: vi.fn(),
    listSandboxes: vi.fn(),
    getCreditsBalance: vi.fn(),
    getCreditsPricing: vi.fn(),
    transferCredits: vi.fn(),
    registerAutomaton: vi.fn(),
    searchDomains: vi.fn(),
    registerDomain: vi.fn(),
    listDnsRecords: vi.fn(),
    addDnsRecord: vi.fn(),
    deleteDnsRecord: vi.fn(),
    listModels: vi.fn(),
    createScopedClient: vi.fn(),
  };
}

const mockedExecFileSync = execFileSync as ReturnType<typeof vi.fn>;

// ─── audit-log.ts ────────────────────────────────────────────────────────────

describe("audit-log", () => {
  describe("logModification", () => {
    it("returns an entry with a non-empty id, timestamp, type, and description", () => {
      const db = makeDb();
      const entry = logModification(db, "code_edit", "Edited src/index.ts", {
        filePath: "src/index.ts",
      });

      expect(entry.id).toBeTruthy();
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.timestamp).toBeTruthy();
      expect(entry.type).toBe("code_edit");
      expect(entry.description).toBe("Edited src/index.ts");
    });

    it("timestamp is a valid ISO-8601 string", () => {
      const db = makeDb();
      const entry = logModification(db, "config_change", "Updated config");
      const parsed = new Date(entry.timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it("persists entry via db.insertModification", () => {
      const db = makeDb();
      const entry = logModification(db, "tool_install", "Installed jq");
      expect(db.insertModification).toHaveBeenCalledOnce();
      expect(db.insertModification).toHaveBeenCalledWith(entry);
    });

    it("each call produces a unique id", () => {
      const db = makeDb();
      const a = logModification(db, "code_edit", "first");
      const b = logModification(db, "code_edit", "second");
      expect(a.id).not.toBe(b.id);
    });

    it("stores optional filePath and diff when provided", () => {
      const db = makeDb();
      const entry = logModification(db, "code_edit", "patch", {
        filePath: "src/foo.ts",
        diff: "--- a\n+++ b",
      });
      expect(entry.filePath).toBe("src/foo.ts");
      expect(entry.diff).toBe("--- a\n+++ b");
    });

    it("defaults reversible to true when not supplied", () => {
      const db = makeDb();
      const entry = logModification(db, "code_edit", "change");
      expect(entry.reversible).toBe(true);
    });

    it("respects reversible:false when supplied", () => {
      const db = makeDb();
      const entry = logModification(db, "code_edit", "irreversible", {
        reversible: false,
      });
      expect(entry.reversible).toBe(false);
    });

    it("propagates db write errors rather than silently swallowing them", () => {
      // The current implementation does NOT catch DB errors — the caller learns immediately.
      const db = makeDb({
        insertModification: vi.fn().mockImplementation(() => {
          throw new Error("DB locked");
        }),
      });
      expect(() =>
        logModification(db, "code_edit", "will fail"),
      ).toThrow("DB locked");
    });
  });

  describe("getRecentModifications", () => {
    it("delegates to db.getRecentModifications with the requested limit", () => {
      const fakeEntries: ModificationEntry[] = [
        {
          id: "01J",
          timestamp: new Date().toISOString(),
          type: "code_edit",
          description: "edit A",
          reversible: true,
        },
      ];
      const db = makeDb({
        getRecentModifications: vi.fn().mockReturnValue(fakeEntries),
      });

      const result = getRecentModifications(db, 5);
      expect(db.getRecentModifications).toHaveBeenCalledWith(5);
      expect(result).toEqual(fakeEntries);
    });

    it("uses default limit of 20 when none provided", () => {
      const db = makeDb();
      getRecentModifications(db);
      expect(db.getRecentModifications).toHaveBeenCalledWith(20);
    });

    it("returns empty array when no modifications exist", () => {
      const db = makeDb({
        getRecentModifications: vi.fn().mockReturnValue([]),
      });
      expect(getRecentModifications(db, 10)).toEqual([]);
    });
  });

  describe("generateAuditReport", () => {
    it("returns a no-modifications message when db is empty", () => {
      const db = makeDb({
        getRecentModifications: vi.fn().mockReturnValue([]),
      });
      const report = generateAuditReport(db);
      expect(report).toContain("No self-modifications recorded");
    });

    it("includes modification count and details when entries exist", () => {
      const entries: ModificationEntry[] = [
        {
          id: "01ABC",
          timestamp: "2025-01-01T00:00:00.000Z",
          type: "tool_install",
          description: "Installed jq",
          reversible: true,
        },
        {
          id: "01DEF",
          timestamp: "2025-01-02T00:00:00.000Z",
          type: "code_edit",
          description: "Patched index.ts",
          filePath: "src/index.ts",
          reversible: true,
        },
      ];
      const db = makeDb({
        getRecentModifications: vi.fn().mockReturnValue(entries),
      });

      const report = generateAuditReport(db);
      expect(report).toContain("Total modifications: 2");
      expect(report).toContain("tool_install");
      expect(report).toContain("Installed jq");
      expect(report).toContain("code_edit");
      expect(report).toContain("src/index.ts");
    });
  });
});

// ─── tools-manager.ts ────────────────────────────────────────────────────────

describe("tools-manager", () => {
  describe("listInstalledTools", () => {
    it("returns an empty array when no tools are installed", () => {
      const db = makeDb({ getInstalledTools: vi.fn().mockReturnValue([]) });
      expect(listInstalledTools(db)).toEqual([]);
    });

    it("returns the array of InstalledTool descriptors from the database", () => {
      const tools: InstalledTool[] = [
        {
          id: "01AA",
          name: "jq",
          type: "custom",
          config: { source: "npm" },
          installedAt: new Date().toISOString(),
          enabled: true,
        },
      ];
      const db = makeDb({ getInstalledTools: vi.fn().mockReturnValue(tools) });
      expect(listInstalledTools(db)).toEqual(tools);
    });
  });

  describe("installNpmPackage", () => {
    it("installs successfully when npm exits 0", async () => {
      const db = makeDb();
      const conway = makeConway();
      const result = await installNpmPackage(conway as any, db, "lodash");
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("calls db.installTool after a successful install", async () => {
      const db = makeDb();
      const conway = makeConway();
      await installNpmPackage(conway as any, db, "lodash");
      expect(db.installTool).toHaveBeenCalledOnce();
      const installed = (db.installTool as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as InstalledTool;
      expect(installed.name).toBe("lodash");
      expect(installed.type).toBe("custom");
      expect(installed.enabled).toBe(true);
    });

    it("writes an audit log entry after a successful install", async () => {
      const db = makeDb();
      const conway = makeConway();
      await installNpmPackage(conway as any, db, "lodash");
      expect(db.insertModification).toHaveBeenCalledOnce();
      const mod = (db.insertModification as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as ModificationEntry;
      expect(mod.type).toBe("tool_install");
      expect(mod.description).toContain("lodash");
    });

    it("returns failure when npm exits non-zero", async () => {
      const db = makeDb();
      const conway = makeConway();
      conway.exec.mockResolvedValue({
        stdout: "",
        stderr: "not found",
        exitCode: 1,
      });
      const result = await installNpmPackage(conway as any, db, "nonexistent");
      expect(result.success).toBe(false);
      expect(result.error).toContain("npm install failed");
    });

    it("does NOT call db.installTool or audit-log on npm failure", async () => {
      const db = makeDb();
      const conway = makeConway();
      conway.exec.mockResolvedValue({ stdout: "", stderr: "fail", exitCode: 1 });
      await installNpmPackage(conway as any, db, "broken-pkg");
      expect(db.installTool).not.toHaveBeenCalled();
      expect(db.insertModification).not.toHaveBeenCalled();
    });

    it("rejects package names with invalid characters (injection guard)", async () => {
      const db = makeDb();
      const conway = makeConway();
      const result = await installNpmPackage(
        conway as any,
        db,
        "evil; rm -rf /",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid package name");
      // exec must never be called for malformed package names
      expect(conway.exec).not.toHaveBeenCalled();
    });

    it("rejects empty package name", async () => {
      const db = makeDb();
      const conway = makeConway();
      const result = await installNpmPackage(conway as any, db, "");
      expect(result.success).toBe(false);
    });

    it("accepts scoped npm packages (e.g. @scope/pkg)", async () => {
      const db = makeDb();
      const conway = makeConway();
      const result = await installNpmPackage(
        conway as any,
        db,
        "@scope/my-pkg",
      );
      expect(result.success).toBe(true);
    });
  });

  describe("installMcpServer", () => {
    it("returns success and writes tool + audit log entry", async () => {
      const db = makeDb();
      const conway = makeConway();
      const result = await installMcpServer(
        conway as any,
        db,
        "my-server",
        "npx",
        ["my-server"],
        { API_KEY: "test" },
      );

      expect(result.success).toBe(true);
      expect(db.installTool).toHaveBeenCalledOnce();

      const installed = (db.installTool as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as InstalledTool;
      expect(installed.name).toBe("mcp:my-server");
      expect(installed.type).toBe("mcp");

      expect(db.insertModification).toHaveBeenCalledOnce();
      const mod = (db.insertModification as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as ModificationEntry;
      expect(mod.type).toBe("mcp_install");
      expect(mod.description).toContain("my-server");
    });

    it("installs without optional args and env", async () => {
      const db = makeDb();
      const conway = makeConway();
      const result = await installMcpServer(
        conway as any,
        db,
        "minimal-server",
        "/usr/bin/my-server",
      );
      expect(result.success).toBe(true);
    });

    it("installed tool has a unique id per call", async () => {
      const db = makeDb();
      const conway = makeConway();
      await installMcpServer(conway as any, db, "srv-a", "cmd-a");
      await installMcpServer(conway as any, db, "srv-b", "cmd-b");

      const calls = (db.installTool as ReturnType<typeof vi.fn>).mock.calls;
      const idA = (calls[0][0] as InstalledTool).id;
      const idB = (calls[1][0] as InstalledTool).id;
      expect(idA).not.toBe(idB);
    });
  });

  describe("removeTool", () => {
    it("delegates to db.removeTool with the correct toolId", () => {
      const db = makeDb();
      removeTool(db, "tool-id-123");
      expect(db.removeTool).toHaveBeenCalledWith("tool-id-123");
    });

    it("writes an audit log entry when removing a tool", () => {
      const db = makeDb();
      removeTool(db, "tool-id-123");
      expect(db.insertModification).toHaveBeenCalledOnce();
      const mod = (db.insertModification as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as ModificationEntry;
      expect(mod.description).toContain("tool-id-123");
    });

    it("propagates db errors (no silent swallowing)", () => {
      const db = makeDb({
        removeTool: vi.fn().mockImplementation(() => {
          throw new Error("no such tool");
        }),
      });
      expect(() => removeTool(db, "ghost-id")).toThrow("no such tool");
    });
  });
});

// ─── upstream.ts ────────────────────────────────────────────────────────────

describe("upstream", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getRepoInfo", () => {
    it("returns origin URL with credentials stripped", () => {
      mockedExecFileSync
        .mockReturnValueOnce("https://user:secret@github.com/org/repo.git\n")
        .mockReturnValueOnce("main\n")
        .mockReturnValueOnce("abc1234 Initial commit\n");

      const info = getRepoInfo();
      expect(info.originUrl).toBe("https://github.com/org/repo.git");
      expect(info.originUrl).not.toContain("secret");
    });

    it("returns current branch and head info", () => {
      mockedExecFileSync
        .mockReturnValueOnce("https://github.com/org/repo.git\n")
        .mockReturnValueOnce("feature/my-branch\n")
        .mockReturnValueOnce("deadbeef Add feature\n");

      const info = getRepoInfo();
      expect(info.branch).toBe("feature/my-branch");
      expect(info.headHash).toBe("deadbeef");
      expect(info.headMessage).toBe("Add feature");
    });

    it("does not leak credentials when URL has no credentials", () => {
      mockedExecFileSync
        .mockReturnValueOnce("https://github.com/org/repo.git\n")
        .mockReturnValueOnce("main\n")
        .mockReturnValueOnce("abc123 fix: bug\n");

      const info = getRepoInfo();
      expect(info.originUrl).toBe("https://github.com/org/repo.git");
    });

    it("throws when git config command fails", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("git config failed");
      });
      expect(() => getRepoInfo()).toThrow("git config failed");
    });
  });

  describe("checkUpstream", () => {
    it("returns { behind: 0, commits: [] } when already up-to-date", () => {
      // fetch → void (trim → ""), log → ""
      mockedExecFileSync
        .mockReturnValueOnce("") // git fetch
        .mockReturnValueOnce(""); // git log — empty means up-to-date

      const result = checkUpstream();
      expect(result.behind).toBe(0);
      expect(result.commits).toEqual([]);
    });

    it("returns commit list when behind origin", () => {
      mockedExecFileSync
        .mockReturnValueOnce("") // git fetch
        .mockReturnValueOnce(
          "abc123 fix: critical bug\ndef456 feat: new feature\n",
        );

      const result = checkUpstream();
      expect(result.behind).toBe(2);
      expect(result.commits).toHaveLength(2);
      expect(result.commits[0].hash).toBe("abc123");
      expect(result.commits[0].message).toBe("fix: critical bug");
      expect(result.commits[1].hash).toBe("def456");
    });

    it("returns { changed: false } semantics — behind:0 when git log is whitespace only", () => {
      mockedExecFileSync
        .mockReturnValueOnce("") // fetch
        .mockReturnValueOnce("   "); // log: whitespace trimmed to empty

      // "   ".trim() === "" → falsy → returns { behind: 0, commits: [] }
      const result = checkUpstream();
      expect(result.behind).toBe(0);
    });

    it("propagates git fetch errors rather than hiding them", () => {
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error("network unreachable");
      });
      expect(() => checkUpstream()).toThrow("network unreachable");
    });
  });

  describe("getUpstreamDiffs", () => {
    it("returns empty array when no commits are ahead of HEAD", () => {
      mockedExecFileSync.mockReturnValueOnce(""); // git log — empty
      const result = getUpstreamDiffs();
      expect(result).toEqual([]);
    });

    it("returns diff entries for each upstream commit", () => {
      mockedExecFileSync
        // git log --format=%H %an|||%s
        .mockReturnValueOnce(
          "abcdef123456 Alice Smith|||fix: correct typo\n",
        )
        // git diff hash~1..hash
        .mockReturnValueOnce(
          "diff --git a/foo.ts b/foo.ts\n--- a\n+++ b\n",
        );

      const diffs = getUpstreamDiffs();
      expect(diffs).toHaveLength(1);
      expect(diffs[0].hash).toBe("abcdef123456".slice(0, 12));
      expect(diffs[0].message).toBe("fix: correct typo");
      expect(diffs[0].author).toBe("Alice Smith");
      expect(diffs[0].diff).toContain("diff --git");
    });

    it("falls back to git show when diff of first commit fails (no parent)", () => {
      mockedExecFileSync
        // git log
        .mockReturnValueOnce("aabbcc112233 Root|||initial commit\n")
        // git diff hash~1..hash — throws (no parent)
        .mockImplementationOnce(() => {
          throw new Error("bad revision");
        })
        // git show fallback
        .mockReturnValueOnce("foo.ts | 3 +++\n");

      const diffs = getUpstreamDiffs();
      expect(diffs).toHaveLength(1);
      expect(diffs[0].diff).toContain("foo.ts");
    });

    it("truncates hash to 12 characters", () => {
      mockedExecFileSync
        .mockReturnValueOnce(
          "0123456789abcdef0000 Dev|||add feature\n",
        )
        .mockReturnValueOnce("patch content\n");

      const diffs = getUpstreamDiffs();
      expect(diffs[0].hash).toHaveLength(12);
      expect(diffs[0].hash).toBe("0123456789ab");
    });

    it("propagates git log errors", () => {
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error("git unavailable");
      });
      expect(() => getUpstreamDiffs()).toThrow("git unavailable");
    });
  });
});
