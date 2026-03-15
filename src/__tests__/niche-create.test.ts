/**
 * Niche Creation & Legal Policy Tests
 *
 * Covers:
 *   createNiche()          — factory function (real integration with evaluateNicheLegalRisk)
 *   evaluateNicheLegalRisk() — pure legal-risk classifier
 *
 * All tests use real implementations; no mocking of either function.
 */

import { describe, it, expect } from "vitest";
import { createNiche } from "../niche/create.js";
import {
  evaluateNicheLegalRisk,
  REJECT_KEYWORDS,
  SENSITIVE_KEYWORDS,
} from "../policy/legal.js";
import type { Niche } from "../niche/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid Niche fixture for evaluateNicheLegalRisk() tests. */
function buildNiche(overrides: Partial<Niche> = {}): Niche {
  return {
    id: "01HZFAKE0000000000000000",
    name: "Test Niche",
    domain: "saas",
    description: "A benign software-as-a-service product",
    tags: ["software", "b2b"],
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createNiche() — factory tests (real integration, no mocks)
// ---------------------------------------------------------------------------

describe("createNiche()", () => {
  // ── Test 1: ULID id ──────────────────────────────────────────────────────
  it("returns a Niche with a generated non-empty string id (ULID)", () => {
    const niche = createNiche({
      name: "Recipe Blog",
      domain: "content",
      description: "A blog sharing home-cooking recipes",
      tags: ["food", "recipes"],
    });

    expect(typeof niche.id).toBe("string");
    expect(niche.id.length).toBeGreaterThan(0);
    // ULIDs are 26 characters, uppercase alphanumeric
    expect(niche.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  // ── Test 2: Different calls produce different ids ────────────────────────
  it("generates unique ids across multiple calls", () => {
    const params = {
      name: "Coding Tutorials",
      domain: "education",
      description: "Programming tutorials for beginners",
      tags: ["coding", "learning"],
    };
    const a = createNiche(params);
    const b = createNiche(params);

    expect(a.id).not.toBe(b.id);
  });

  // ── Test 3: Status is 'draft' for benign (ok) niches ────────────────────
  it("sets status to 'draft' when legal risk is 'ok'", () => {
    const niche = createNiche({
      name: "Recipe Blog",
      domain: "content",
      description: "Sharing delicious home-cooking recipes",
      tags: ["food", "cooking"],
    });

    expect(niche.legalFlag).toBe("ok");
    expect(niche.status).toBe("draft");
  });

  // ── Test 4: Status is 'draft' for sensitive (warn) niches ───────────────
  it("sets status to 'draft' when legal risk is 'sensitive'", () => {
    // 'health' is a SENSITIVE keyword — should produce flag: 'sensitive', status: 'draft'
    const niche = createNiche({
      name: "Health & Wellness Hub",
      domain: "health",
      description: "General health information and wellness tips",
      tags: ["wellness", "lifestyle"],
    });

    expect(niche.legalFlag).toBe("sensitive");
    expect(niche.status).toBe("draft");
  });

  // ── Test 5: Status is 'rejected' for prohibited niches ──────────────────
  it("sets status to 'rejected' when legal risk is 'reject'", () => {
    // 'weapons' is a REJECT keyword
    const niche = createNiche({
      name: "Weapons Marketplace",
      domain: "weapons",
      description: "Buying and selling weapons online",
      tags: ["arms", "marketplace"],
    });

    expect(niche.legalFlag).toBe("reject");
    expect(niche.status).toBe("rejected");
  });

  // ── Test 6: createdAt is a valid ISO timestamp ───────────────────────────
  it("sets createdAt to a current ISO 8601 timestamp", () => {
    const before = Date.now();
    const niche = createNiche({
      name: "Coding Tutorials",
      domain: "education",
      description: "Programming tutorials",
      tags: ["tech"],
    });
    const after = Date.now();

    expect(typeof niche.createdAt).toBe("string");
    // Must parse as a valid date
    const ts = new Date(niche.createdAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  // ── Test 7: All input fields are preserved ──────────────────────────────
  it("preserves all input fields (name, domain, description, tags)", () => {
    const params = {
      name: "Data Analytics SaaS",
      domain: "data-analytics",
      description: "B2B data analytics platform for SMEs",
      tags: ["data", "analytics", "b2b", "saas"],
    };

    const niche = createNiche(params);

    expect(niche.name).toBe(params.name);
    expect(niche.domain).toBe(params.domain);
    expect(niche.description).toBe(params.description);
    expect(niche.tags).toEqual(params.tags);
  });

  // ── Test 8: Legal flag and reasons are stored on the returned Niche ─────
  it("stores legalFlag and legalReasons on the returned Niche", () => {
    // Benign niche — flag 'ok', empty reasons
    const benignNiche = createNiche({
      name: "Recipe Blog",
      domain: "content",
      description: "Sharing home-cooking recipes",
      tags: ["food"],
    });
    expect(benignNiche.legalFlag).toBe("ok");
    expect(Array.isArray(benignNiche.legalReasons)).toBe(true);
    expect(benignNiche.legalReasons).toHaveLength(0);

    // Rejected niche — flag 'reject', non-empty reasons
    const rejectedNiche = createNiche({
      name: "Darknet Services",
      domain: "darknet",
      description: "Underground marketplace",
      tags: ["illegal"],
    });
    expect(rejectedNiche.legalFlag).toBe("reject");
    expect(Array.isArray(rejectedNiche.legalReasons)).toBe(true);
    expect(rejectedNiche.legalReasons!.length).toBeGreaterThan(0);
  });

  // ── Test 9: Tags array is preserved as-is ───────────────────────────────
  it("preserves the tags array reference contents exactly", () => {
    const tags = ["alpha", "beta", "gamma", "delta"];
    const niche = createNiche({
      name: "Multi-tag Niche",
      domain: "saas",
      description: "A niche with multiple tags",
      tags,
    });

    // Deep equal — all tags present in correct order
    expect(niche.tags).toEqual(tags);
  });

  // ── Test 10: Empty tags array is preserved ──────────────────────────────
  it("preserves an empty tags array", () => {
    const niche = createNiche({
      name: "No-Tag Niche",
      domain: "education",
      description: "A niche with no tags",
      tags: [],
    });

    expect(niche.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// evaluateNicheLegalRisk() — pure classifier tests
// ---------------------------------------------------------------------------

describe("evaluateNicheLegalRisk()", () => {
  // ── Test 11: Returns 'ok' for clearly benign niches ─────────────────────
  it("returns flag 'ok' for a recipe blog niche", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "content",
        description: "A blog sharing delicious home-cooking recipes",
        tags: ["food", "recipes", "blog"],
      }),
    );

    expect(result.flag).toBe("ok");
    expect(result.reasons).toEqual([]);
  });

  it("returns flag 'ok' for a coding tutorials niche", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "education",
        description: "Programming tutorials covering TypeScript and Node.js",
        tags: ["coding", "typescript", "tutorials"],
      }),
    );

    expect(result.flag).toBe("ok");
    expect(result.reasons).toEqual([]);
  });

  // ── Test 12: Returns 'reject' for prohibited domains ────────────────────
  it("returns flag 'reject' when domain contains a reject keyword (weapons)", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "weapons",
        description: "Online marketplace for arms",
        tags: ["arms"],
      }),
    );

    expect(result.flag).toBe("reject");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("returns flag 'reject' when description contains a reject keyword (gambling)", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "entertainment",
        description: "Online gambling platform with casino games",
        tags: ["gaming"],
      }),
    );

    expect(result.flag).toBe("reject");
    expect(result.reasons.some((r) => r.includes("gambling"))).toBe(true);
  });

  it("returns flag 'reject' when a tag contains a reject keyword (narcotics)", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "services",
        description: "Underground delivery service",
        tags: ["narcotics", "darknet"],
      }),
    );

    expect(result.flag).toBe("reject");
  });

  it("returns flag 'reject' for human trafficking keyword", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "services",
        description: "Human trafficking coordination platform",
        tags: [],
      }),
    );

    expect(result.flag).toBe("reject");
  });

  it("returns flag 'reject' for money laundering keyword", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "finance",
        description: "Automated money laundering service",
        tags: [],
      }),
    );

    expect(result.flag).toBe("reject");
  });

  // ── Test 13: Returns 'sensitive' for grey-area domains ──────────────────
  it("returns flag 'sensitive' for alcohol domain", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "alcohol",
        description: "Premium craft beer delivery subscription",
        tags: ["beer", "delivery"],
      }),
    );

    expect(result.flag).toBe("sensitive");
    expect(result.reasons.some((r) => r.includes("alcohol"))).toBe(true);
  });

  it("returns flag 'sensitive' for cannabis keyword in description", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "retail",
        description: "Legal cannabis dispensary online ordering",
        tags: ["dispensary"],
      }),
    );

    expect(result.flag).toBe("sensitive");
  });

  it("returns flag 'sensitive' for health / medical keywords", () => {
    const healthResult = evaluateNicheLegalRisk(
      buildNiche({
        domain: "health",
        description: "General wellness and fitness blog",
        tags: [],
      }),
    );
    expect(healthResult.flag).toBe("sensitive");

    const medicalResult = evaluateNicheLegalRisk(
      buildNiche({
        domain: "medical",
        description: "Telemedicine scheduling platform",
        tags: [],
      }),
    );
    expect(medicalResult.flag).toBe("sensitive");
  });

  it("returns flag 'sensitive' for financial / investment keywords", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "finance",
        description: "Investment portfolio tracker",
        tags: ["investment", "trading"],
      }),
    );

    expect(result.flag).toBe("sensitive");
  });

  // ── Test 14: Returns a reasons array explaining the decision ────────────
  it("returns a non-empty reasons array for rejected niches", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "casino",
        description: "Online casino with slot machines",
        tags: [],
      }),
    );

    expect(result.flag).toBe("reject");
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    // Each reason should be a non-empty string
    result.reasons.forEach((reason) => {
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(0);
    });
  });

  it("returns a non-empty reasons array for sensitive niches", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "insurance",
        description: "Comparison tool for insurance policies",
        tags: [],
      }),
    );

    expect(result.flag).toBe("sensitive");
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    result.reasons.forEach((reason) => {
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(0);
    });
  });

  it("returns an empty reasons array for benign niches", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "saas",
        description: "Project management tool for remote teams",
        tags: ["productivity", "collaboration"],
      }),
    );

    expect(result.flag).toBe("ok");
    expect(result.reasons).toEqual([]);
  });

  // ── Test 15: Reasons reference the matched keyword ───────────────────────
  it("includes the matched keyword in the reason string for reject", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "ponzi",
        description: "Investment returns scheme",
        tags: [],
      }),
    );

    expect(result.flag).toBe("reject");
    expect(result.reasons[0]).toContain("ponzi");
  });

  it("includes the matched keyword in the reason string for sensitive", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "credit",
        description: "Consumer credit score monitoring",
        tags: [],
      }),
    );

    expect(result.flag).toBe("sensitive");
    expect(result.reasons[0]).toContain("credit");
  });

  // ── Test 16: Case-insensitive matching ──────────────────────────────────
  it("detects reject keywords regardless of uppercase in domain", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "WEAPONS",
        description: "Military gear online store",
        tags: [],
      }),
    );

    expect(result.flag).toBe("reject");
  });

  it("detects reject keywords regardless of mixed case in description", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "retail",
        description: "Premium CASINO experience online",
        tags: [],
      }),
    );

    expect(result.flag).toBe("reject");
  });

  it("detects sensitive keywords regardless of uppercase in tags", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "saas",
        description: "Lifestyle platform",
        tags: ["ALCOHOL", "beverages"],
      }),
    );

    expect(result.flag).toBe("sensitive");
  });

  it("detects reject keywords regardless of mixed case in tags", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "services",
        description: "Peer-to-peer marketplace",
        tags: ["Firearms", "accessories"],
      }),
    );

    expect(result.flag).toBe("reject");
  });

  // ── Test 17: Reject takes precedence over sensitive ──────────────────────
  it("returns 'reject' even when both reject and sensitive keywords are present", () => {
    // 'health' is sensitive, 'drugs' is a reject keyword
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "health",
        description: "Health drugs marketplace",
        tags: [],
      }),
    );

    expect(result.flag).toBe("reject");
  });

  // ── Test 18: Multiple reject keywords produce multiple reasons ───────────
  it("returns one reason per matched reject keyword", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "weapons",
        description: "Firearms and narcotics dealer",
        tags: [],
      }),
    );

    expect(result.flag).toBe("reject");
    // weapons, firearms, and narcotics are all reject keywords
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  // ── Test 19: Multiple sensitive keywords produce multiple reasons ─────────
  it("returns one reason per matched sensitive keyword", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "health",
        description: "Medical insurance and pharmaceutical advice",
        tags: [],
      }),
    );

    expect(result.flag).toBe("sensitive");
    // health, medical, insurance, pharmaceutical — 4 matches
    expect(result.reasons.length).toBeGreaterThanOrEqual(4);
  });

  // ── Test 20: REJECT_KEYWORDS and SENSITIVE_KEYWORDS are exported ─────────
  it("exports REJECT_KEYWORDS as a non-empty readonly array", () => {
    expect(Array.isArray(REJECT_KEYWORDS)).toBe(true);
    expect(REJECT_KEYWORDS.length).toBeGreaterThan(0);
    REJECT_KEYWORDS.forEach((kw) => {
      expect(typeof kw).toBe("string");
      expect(kw.length).toBeGreaterThan(0);
    });
  });

  it("exports SENSITIVE_KEYWORDS as a non-empty readonly array", () => {
    expect(Array.isArray(SENSITIVE_KEYWORDS)).toBe(true);
    expect(SENSITIVE_KEYWORDS.length).toBeGreaterThan(0);
    SENSITIVE_KEYWORDS.forEach((kw) => {
      expect(typeof kw).toBe("string");
      expect(kw.length).toBeGreaterThan(0);
    });
  });

  // ── Test 21: Niche name is NOT included in the search text ──────────────
  it("does not match keywords in the name field (name is not part of search text)", () => {
    // Only domain, description, and tags are checked — not name
    const result = evaluateNicheLegalRisk(
      buildNiche({
        name: "WEAPONS Store",   // contains reject keyword in name only
        domain: "retail",
        description: "Sporting goods and camping equipment",
        tags: ["outdoors", "camping"],
      }),
    );

    // The name field is NOT searched — should be 'ok'
    expect(result.flag).toBe("ok");
  });

  // ── Test 22: Edge case — all empty searchable fields ────────────────────
  it("returns flag 'ok' when domain, description, and tags are all empty", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "",
        description: "",
        tags: [],
      }),
    );

    expect(result.flag).toBe("ok");
    expect(result.reasons).toEqual([]);
  });

  // ── Test 23: Partial keyword substring must match ────────────────────────
  it("matches 'gambling' inside a longer description string", () => {
    const result = evaluateNicheLegalRisk(
      buildNiche({
        domain: "entertainment",
        description: "We offer online gambling opportunities",
        tags: [],
      }),
    );

    expect(result.flag).toBe("reject");
  });
});
