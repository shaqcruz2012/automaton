import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { createInMemoryDb } from "../orchestration/test-db.js";
import { MIGRATION_V5 } from "../../state/schema.js";
import {
  EnhancedRetriever,
  enhanceQuery,
  recordRetrievalFeedback,
  calculateMemoryBudget,
  type ScoredMemoryRetrievalResult,
} from "../../memory/enhanced-retriever.js";
import { KnowledgeStore } from "../../memory/knowledge-store.js";
import { ContextManager, createTokenCounter } from "../../memory/context-manager.js";
import { RelationshipMemoryManager } from "../../memory/relationship.js";
import { EpisodicMemoryManager } from "../../memory/episodic.js";
import { SemanticMemoryManager } from "../../memory/semantic.js";
import { MemoryRetriever } from "../../memory/retrieval.js";

/** Creates an in-memory DB that includes both the knowledge_store schema and
 *  the V5 memory tables (episodic, semantic, relationship, working, etc.). */
function createFullMemoryDb(): BetterSqlite3.Database {
  const db = createInMemoryDb();
  db.exec(MIGRATION_V5);
  return db;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function addKnowledge(
  store: KnowledgeStore,
  category: "market" | "technical" | "social" | "financial" | "operational",
  key: string,
  content: string,
  opts: {
    confidence?: number;
    lastVerified?: string;
    tokenCount?: number;
    accessCount?: number;
  } = {},
): string {
  const id = store.add({
    category,
    key,
    content,
    source: "0xtest",
    confidence: opts.confidence ?? 0.8,
    lastVerified: opts.lastVerified ?? new Date().toISOString(),
    tokenCount: opts.tokenCount ?? Math.max(1, Math.ceil(content.length / 4)),
    expiresAt: null,
  });

  if (opts.accessCount && opts.accessCount > 0) {
    for (let i = 0; i < opts.accessCount; i++) {
      store.get(id);
    }
  }

  return id;
}

const NOW = new Date().toISOString();
const RECENT = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
const OLD = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("integration/memory-retrieval", () => {
  let db: BetterSqlite3.Database;
  let knowledgeStore: KnowledgeStore;
  let retriever: EnhancedRetriever;

  beforeEach(() => {
    db = createInMemoryDb();
    knowledgeStore = new KnowledgeStore(db);
    retriever = new EnhancedRetriever(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Scored retrieval ─────────────────────────────────────────────────────────

  describe("scored retrieval", () => {
    it("returns entries sorted descending by relevance score", () => {
      // High confidence, recently verified
      addKnowledge(knowledgeStore, "technical", "api-gateway", "api gateway configuration for routing requests", {
        confidence: 0.95,
        lastVerified: NOW,
        tokenCount: 20,
      });

      // Lower confidence, same topic
      addKnowledge(knowledgeStore, "technical", "api-fallback", "api fallback strategy configuration", {
        confidence: 0.5,
        lastVerified: NOW,
        tokenCount: 20,
      });

      const result: ScoredMemoryRetrievalResult = retriever.retrieveScored({
        sessionId: "sess-1",
        currentInput: "api configuration",
        budgetTokens: 1000,
      });

      expect(result.entries.length).toBeGreaterThanOrEqual(1);

      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].relevanceScore).toBeGreaterThanOrEqual(
          result.entries[i].relevanceScore,
        );
      }
    });

    it("higher confidence entries rank above lower confidence entries for the same query", () => {
      addKnowledge(knowledgeStore, "technical", "deploy-high", "deploy pipeline architecture", {
        confidence: 0.95,
        lastVerified: NOW,
        tokenCount: 20,
      });

      addKnowledge(knowledgeStore, "technical", "deploy-low", "deploy pipeline architecture", {
        confidence: 0.4,
        lastVerified: NOW,
        tokenCount: 20,
      });

      const result = retriever.retrieveScored({
        sessionId: "sess-2",
        currentInput: "deploy pipeline",
        budgetTokens: 2000,
      });

      const entries = result.entries;
      const highIdx = entries.findIndex((e) => e.entry.key === "deploy-high");
      const lowIdx = entries.findIndex((e) => e.entry.key === "deploy-low");

      expect(highIdx).not.toBe(-1);
      expect(lowIdx).not.toBe(-1);
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it("more recently verified entries rank higher than stale entries", () => {
      addKnowledge(knowledgeStore, "operational", "runbook-new", "incident runbook for database outages", {
        confidence: 0.8,
        lastVerified: RECENT,
        tokenCount: 20,
      });

      addKnowledge(knowledgeStore, "operational", "runbook-old", "incident runbook for database outages", {
        confidence: 0.8,
        lastVerified: OLD,
        tokenCount: 20,
      });

      const result = retriever.retrieveScored({
        sessionId: "sess-3",
        currentInput: "incident runbook database",
        budgetTokens: 2000,
      });

      const entries = result.entries;
      const newIdx = entries.findIndex((e) => e.entry.key === "runbook-new");
      const oldIdx = entries.findIndex((e) => e.entry.key === "runbook-old");

      expect(newIdx).not.toBe(-1);
      expect(oldIdx).not.toBe(-1);
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it("all returned entries have a relevance score >= 0.3", () => {
      addKnowledge(knowledgeStore, "financial", "revenue-q1", "revenue figures for Q1 budget report", {
        confidence: 0.9,
        lastVerified: NOW,
        tokenCount: 25,
      });

      const result = retriever.retrieveScored({
        sessionId: "sess-4",
        currentInput: "revenue budget",
        budgetTokens: 2000,
      });

      for (const entry of result.entries) {
        expect(entry.relevanceScore).toBeGreaterThanOrEqual(0.3);
      }
    });
  });

  // ── Dynamic budget ───────────────────────────────────────────────────────────

  describe("dynamic budget", () => {
    beforeEach(() => {
      // Add several entries each with known token counts
      for (let i = 0; i < 8; i++) {
        addKnowledge(
          knowledgeStore,
          "technical",
          `database-entry-${i}`,
          `database architecture details number ${i}`,
          { confidence: 0.85, lastVerified: NOW, tokenCount: 100 },
        );
      }
    });

    it("tight budget returns fewer entries than a generous budget", () => {
      const tight = retriever.retrieveScored({
        sessionId: "sess-5",
        currentInput: "database architecture",
        budgetTokens: 150,
      });

      const generous = retriever.retrieveScored({
        sessionId: "sess-5",
        currentInput: "database architecture",
        budgetTokens: 800,
      });

      expect(generous.entries.length).toBeGreaterThan(tight.entries.length);
    });

    it("zero budget returns no entries and marks truncated when candidates exist", () => {
      const result = retriever.retrieveScored({
        sessionId: "sess-6",
        currentInput: "database architecture",
        budgetTokens: 0,
      });

      expect(result.entries).toHaveLength(0);
      expect(result.truncated).toBe(true);
    });

    it("total tokens in result does not exceed the given budget", () => {
      const budgetTokens = 350;

      const result = retriever.retrieveScored({
        sessionId: "sess-7",
        currentInput: "database architecture",
        budgetTokens,
      });

      expect(result.totalTokens).toBeLessThanOrEqual(budgetTokens);
    });
  });

  // ── Feedback loop ────────────────────────────────────────────────────────────

  describe("feedback tracking", () => {
    it("recordRetrievalFeedback stores feedback and rolling precision is returned in subsequent results", () => {
      addKnowledge(knowledgeStore, "technical", "auth-service", "authentication service token validation", {
        confidence: 0.9,
        lastVerified: NOW,
        tokenCount: 30,
      });

      const first = retriever.retrieveScored({
        sessionId: "sess-8",
        currentInput: "auth service token",
        budgetTokens: 2000,
      });

      const retrievedIds = first.entries.map((e) => e.entry.id as string);

      retriever.recordRetrievalFeedback({
        turnId: "turn-1",
        retrieved: retrievedIds,
        matched: retrievedIds,
        retrievalPrecision: 1.0,
        rollingPrecision: 1.0,
      });

      // After recording feedback the rolling precision propagates to the next result
      const second = retriever.retrieveScored({
        sessionId: "sess-8",
        currentInput: "auth service token",
        budgetTokens: 2000,
      });

      expect(second.retrievalPrecision).toBeDefined();
      expect(second.retrievalPrecision).toBeGreaterThanOrEqual(0);
      expect(second.retrievalPrecision).toBeLessThanOrEqual(1);
    });

    it("feedback with no matched entries yields lower precision than fully matched feedback", () => {
      addKnowledge(knowledgeStore, "technical", "cache-service", "cache invalidation service architecture", {
        confidence: 0.9,
        lastVerified: NOW,
        tokenCount: 30,
      });

      const result = retriever.retrieveScored({
        sessionId: "sess-9",
        currentInput: "cache service",
        budgetTokens: 2000,
      });

      const retrievedIds = result.entries.map((e) => e.entry.id as string);

      // Record zero-match feedback
      recordRetrievalFeedback({
        turnId: "turn-miss",
        retrieved: retrievedIds,
        matched: [],
        retrievalPrecision: 0,
        rollingPrecision: 0,
      });

      const after = retriever.retrieveScored({
        sessionId: "sess-9",
        currentInput: "cache service",
        budgetTokens: 2000,
      });

      expect(after.retrievalPrecision).toBeDefined();
      // Rolling precision should be < 1 after a zero-match round
      expect(after.retrievalPrecision!).toBeLessThan(1);
    });
  });

  // ── Query enhancement ────────────────────────────────────────────────────────

  describe("enhanceQuery", () => {
    it("removes stop words from extracted terms", () => {
      const query = enhanceQuery({ currentInput: "what is the api for the database" });
      // "what", "is", "the", "for" are all stop words
      const stopWords = new Set(["what", "is", "the", "for", "a", "an", "and", "are", "to"]);
      for (const term of query.terms) {
        expect(stopWords.has(term)).toBe(false);
      }
      expect(query.terms).toContain("api");
      expect(query.terms).toContain("database");
    });

    it("expands abbreviations in query terms", () => {
      const query = enhanceQuery({ currentInput: "api and llm integration" });
      // "api" should expand to "application programming interface"
      expect(query.terms).toContain("application programming interface");
      // "llm" should expand to "large language model"
      expect(query.terms).toContain("large language model");
    });

    it("infers categories from task spec and agent role", () => {
      const query = enhanceQuery({
        currentInput: "deploy infra runbook",
        agentRole: "engineer",
        taskSpec: "architecture review",
      });

      // engineer role should bias toward technical/operational categories
      expect(query.categories).toContain("technical");
    });

    it("includes timeRange when query contains recency keywords", () => {
      const query = enhanceQuery({ currentInput: "latest api changes today" });
      expect(query.timeRange).toBeDefined();
      expect(query.timeRange?.since).toBeTruthy();
    });

    it("deduplicates terms and caps at 25 expanded terms", () => {
      // Provide a long input with many repeated tokens
      const words = Array.from({ length: 40 }, (_, i) => `term${i}`).join(" ");
      const query = enhanceQuery({ currentInput: words });
      expect(query.terms.length).toBeLessThanOrEqual(25);

      const uniqueTerms = new Set(query.terms);
      expect(uniqueTerms.size).toBe(query.terms.length);
    });
  });

  // ── calculateMemoryBudget ────────────────────────────────────────────────────

  describe("calculateMemoryBudget", () => {
    it("returns a larger budget when context utilization is low", () => {
      const lowUtilization = { utilizationPercent: 40, totalTokens: 10000, usedTokens: 4000 };
      const highUtilization = { utilizationPercent: 80, totalTokens: 10000, usedTokens: 8000 };

      const lowBudget = calculateMemoryBudget(lowUtilization, 50000);
      const highBudget = calculateMemoryBudget(highUtilization, 50000);

      expect(lowBudget).toBeGreaterThan(highBudget);
    });

    it("clamps result to the minimum budget of 2000 tokens", () => {
      // Very small available tokens
      const utilization = { utilizationPercent: 85, totalTokens: 1000, usedTokens: 850 };
      const budget = calculateMemoryBudget(utilization, 100);
      expect(budget).toBeGreaterThanOrEqual(2000);
    });

    it("clamps result to the maximum budget of 20000 tokens", () => {
      // Huge available tokens with low utilization
      const utilization = { utilizationPercent: 10, totalTokens: 1_000_000, usedTokens: 100_000 };
      const budget = calculateMemoryBudget(utilization, 1_000_000);
      expect(budget).toBeLessThanOrEqual(20000);
    });
  });

  // ── Context window overflow → compression trigger ─────────────────────────

  describe("context window overflow / compression trigger", () => {
    it("recommendation is 'ok' when context is well below the compression threshold", () => {
      const tokenCounter = createTokenCounter();
      const manager = new ContextManager(tokenCounter);

      // 10 000-token window with a short system prompt and no turns
      const result = manager.assembleContext({
        systemPrompt: "You are a test agent.",
        recentTurns: [],
        modelContextWindow: 10_000,
        reserveTokens: 500,
      });

      expect(result.utilization.recommendation).toBe("ok");
    });

    it("recommendation becomes 'compress' when tokens exceed 90% of usable capacity", () => {
      const tokenCounter = createTokenCounter();
      const manager = new ContextManager(tokenCounter);

      // Fill the context with a very large system prompt so utilization pushes into
      // the compression-headroom zone (> 90% of promptCapacity).
      const bigPrompt = "word ".repeat(9_500);

      const result = manager.assembleContext({
        systemPrompt: bigPrompt,
        recentTurns: [],
        modelContextWindow: 10_000,
        reserveTokens: 0,
      });

      expect(["compress", "emergency"]).toContain(result.utilization.recommendation);
    });

    it("compacted output from ContextManager.compact() is smaller than original token sum", () => {
      const tokenCounter = createTokenCounter();
      const manager = new ContextManager(tokenCounter);

      const longContent = "detailed log entry with many words ".repeat(50);
      const events = Array.from({ length: 6 }, (_, i) => ({
        id: `evt-${i}`,
        type: "action" as const,
        agentAddress: "0xtest",
        goalId: null,
        taskId: null,
        content: longContent,
        tokenCount: tokenCounter.countTokens(longContent),
        compactedTo: null,
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
      }));

      const compacted = manager.compact(events);

      expect(compacted.compactedTokens).toBeLessThan(compacted.originalTokens);
      expect(compacted.compressionRatio).toBeLessThan(1);
    });

    it("compactedTokens is populated for every event reference returned", () => {
      const tokenCounter = createTokenCounter();
      const manager = new ContextManager(tokenCounter);

      const events = [
        {
          id: "e1",
          type: "observation" as const,
          agentAddress: "0xtest",
          goalId: "g1",
          taskId: "t1",
          content: "Observed a significant anomaly in the metrics pipeline.",
          tokenCount: 15,
          compactedTo: null,
          createdAt: new Date().toISOString(),
        },
      ];

      const compacted = manager.compact(events);

      expect(compacted.events).toHaveLength(1);
      expect(compacted.events[0].compactedTokens).toBeGreaterThan(0);
    });
  });

  // ── Retrieval ranking ─────────────────────────────────────────────────────

  describe("retrieval ranking — access frequency", () => {
    it("frequently accessed entries rank above identical entries that were never accessed", () => {
      // Both entries have the same content and confidence, but different access counts.
      addKnowledge(knowledgeStore, "technical", "cache-hot", "redis cache eviction policy", {
        confidence: 0.8,
        lastVerified: NOW,
        tokenCount: 20,
        accessCount: 10,
      });

      addKnowledge(knowledgeStore, "technical", "cache-cold", "redis cache eviction policy", {
        confidence: 0.8,
        lastVerified: NOW,
        tokenCount: 20,
        accessCount: 0,
      });

      const result = retriever.retrieveScored({
        sessionId: "sess-rank-freq",
        currentInput: "redis cache",
        budgetTokens: 2000,
      });

      const hotIdx = result.entries.findIndex((e) => e.entry.key === "cache-hot");
      const coldIdx = result.entries.findIndex((e) => e.entry.key === "cache-cold");

      expect(hotIdx).not.toBe(-1);
      expect(coldIdx).not.toBe(-1);
      expect(hotIdx).toBeLessThan(coldIdx);
    });

    it("scoring factors are each between 0 and 1 for every returned entry", () => {
      addKnowledge(knowledgeStore, "market", "competitor-x", "competitor product launch analysis", {
        confidence: 0.75,
        lastVerified: RECENT,
        tokenCount: 30,
      });

      const result = retriever.retrieveScored({
        sessionId: "sess-rank-factors",
        currentInput: "competitor product",
        budgetTokens: 2000,
      });

      for (const entry of result.entries) {
        const f = entry.scoringFactors;
        expect(f.recency).toBeGreaterThanOrEqual(0);
        expect(f.recency).toBeLessThanOrEqual(1);
        expect(f.frequency).toBeGreaterThanOrEqual(0);
        expect(f.frequency).toBeLessThanOrEqual(1);
        expect(f.confidence).toBeGreaterThanOrEqual(0);
        expect(f.confidence).toBeLessThanOrEqual(1);
        expect(f.taskAffinity).toBeGreaterThanOrEqual(0);
        expect(f.taskAffinity).toBeLessThanOrEqual(1);
        expect(f.categoryMatch).toBeGreaterThanOrEqual(0);
        expect(f.categoryMatch).toBeLessThanOrEqual(1);
      }
    });
  });

  // ── Relationship memory queries ───────────────────────────────────────────

  describe("relationship memory", () => {
    let fullDb: BetterSqlite3.Database;
    let relationships: RelationshipMemoryManager;

    beforeEach(() => {
      fullDb = createFullMemoryDb();
      relationships = new RelationshipMemoryManager(fullDb);
    });

    afterEach(() => {
      fullDb.close();
    });

    it("can retrieve a relationship by entity address after recording it", () => {
      const address = "0xRelAgent01";
      relationships.record({
        entityAddress: address,
        entityName: "Alice",
        relationshipType: "collaborator",
        trustScore: 0.9,
        notes: "Key partner in the research team",
      });

      const found = relationships.get(address);

      expect(found).toBeDefined();
      expect(found!.entityAddress).toBe(address);
      expect(found!.entityName).toBe("Alice");
      expect(found!.trustScore).toBeCloseTo(0.9);
    });

    it("getTrusted filters out relationships below the minimum trust threshold", () => {
      relationships.record({
        entityAddress: "0xHighTrust",
        entityName: "Bob",
        relationshipType: "partner",
        trustScore: 0.8,
      });

      relationships.record({
        entityAddress: "0xLowTrust",
        entityName: "Mallory",
        relationshipType: "unknown",
        trustScore: 0.2,
      });

      const trusted = relationships.getTrusted(0.5);
      const addresses = trusted.map((r) => r.entityAddress);

      expect(addresses).toContain("0xHighTrust");
      expect(addresses).not.toContain("0xLowTrust");
    });

    it("upserts on entity address, preserving the latest relationship type", () => {
      const address = "0xUpsertAgent";

      relationships.record({
        entityAddress: address,
        entityName: "Charlie",
        relationshipType: "acquaintance",
        trustScore: 0.5,
      });

      relationships.record({
        entityAddress: address,
        entityName: "Charlie",
        relationshipType: "trusted_peer",
        trustScore: 0.85,
      });

      const found = relationships.get(address);

      expect(found).toBeDefined();
      expect(found!.relationshipType).toBe("trusted_peer");
      expect(found!.trustScore).toBeCloseTo(0.85);
    });
  });

  // ── Cross-type retrieval ──────────────────────────────────────────────────

  describe("cross-type retrieval via MemoryRetriever", () => {
    let fullDb: BetterSqlite3.Database;
    let baseRetriever: MemoryRetriever;
    let episodic: EpisodicMemoryManager;
    let semantic: SemanticMemoryManager;

    beforeEach(() => {
      fullDb = createFullMemoryDb();
      baseRetriever = new MemoryRetriever(fullDb);
      episodic = new EpisodicMemoryManager(fullDb);
      semantic = new SemanticMemoryManager(fullDb);
    });

    afterEach(() => {
      fullDb.close();
    });

    it("retrieves both episodic and semantic entries in a single call", () => {
      const sessionId = "sess-cross-type";

      episodic.record({
        sessionId,
        eventType: "action",
        summary: "Deployed the payment gateway to production",
        outcome: "success",
        importance: 0.9,
      });

      semantic.store({
        category: "self",
        key: "payment-gateway-docs",
        value: "Payment gateway integration guide v2",
        confidence: 0.95,
        source: "0xtest",
      });

      const result = baseRetriever.retrieve(sessionId, "payment gateway");

      // At least one episodic entry should be present
      const hasEpisodic = result.episodicMemory.some((e) =>
        e.summary.toLowerCase().includes("payment"),
      );
      // At least one semantic entry should be present
      const hasSemantic = result.semanticMemory.some((e) =>
        e.value.toLowerCase().includes("payment"),
      );

      expect(hasEpisodic).toBe(true);
      expect(hasSemantic).toBe(true);
    });

    it("returns empty arrays for all tiers when no entries exist", () => {
      const result = baseRetriever.retrieve("empty-session", "anything");

      expect(result.episodicMemory).toHaveLength(0);
      expect(result.semanticMemory).toHaveLength(0);
      expect(result.workingMemory).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });
  });
});
