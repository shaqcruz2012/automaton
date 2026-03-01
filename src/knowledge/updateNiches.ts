/**
 * Niche Discovery: Update Niches from Batch Data
 *
 * Processes YC (Y Combinator) and HN (Hacker News) items to discover,
 * score, and persist market niches. Each item is classified into a domain,
 * scored for trend strength / gap / moat potential, screened for legal risk,
 * and upserted into the niches SQLite table.
 *
 * All scoring functions are STUBS that use simple heuristics. In production
 * these would delegate to an LLM for richer classification.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { Niche } from "../niche/types.js";
import { evaluateNicheLegalRisk } from "../policy/legal.js";
import { ulid } from "ulid";
import { webSearch, resolvePerplexityApiKey } from "../tools/web-search.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("knowledge.updateNiches");

type Database = BetterSqlite3.Database;

// ── Input types ──────────────────────────────────────────────────

/** A Y Combinator company/startup item. */
export interface YCItem {
  name: string;
  description: string;
  batch?: string;
  tags?: string[];
  url?: string;
}

/** A Hacker News front-page item. */
export interface HNItem {
  title: string;
  url?: string;
  points?: number;
  comments?: number;
  tags?: string[];
}

/** A source reference attached to a niche candidate. */
interface Source {
  type: "yc" | "hn";
  url?: string;
  name?: string;
}

/** An intermediate niche candidate before merge and persistence. */
interface NicheCandidate {
  domain: string;
  subdomain: string;
  userType: string;
  description: string;
  trendScore: number;
  gapScore: number;
  moatPotential: number;
  sources: Source[];
}

// ── Keyword-to-domain mapping ────────────────────────────────────

/**
 * Mapping from keywords to { domain, subdomain, userType }.
 * Checked in order; first match wins.
 */
const DOMAIN_RULES: Array<{
  keywords: string[];
  domain: string;
  subdomain: string;
  userType: string;
}> = [
  { keywords: ["health", "medical", "biotech", "clinical", "patient"],   domain: "health",     subdomain: "medical",   userType: "provider" },
  { keywords: ["fintech", "payment", "banking", "neobank"],              domain: "finance",    subdomain: "fintech",   userType: "business" },
  { keywords: ["investment", "trading", "portfolio"],                    domain: "finance",    subdomain: "investing", userType: "investor" },
  { keywords: ["insurance", "insurtech"],                                domain: "finance",    subdomain: "insurance", userType: "consumer" },
  { keywords: ["ai", "ml", "machine learning", "llm", "deep learning"], domain: "ai",         subdomain: "ml",        userType: "developer" },
  { keywords: ["dev tools", "developer tool", "api", "sdk", "cli"],     domain: "devtools",   subdomain: "infra",     userType: "developer" },
  { keywords: ["education", "edtech", "learning", "course", "tutor"],   domain: "education",  subdomain: "edtech",    userType: "student" },
  { keywords: ["ecommerce", "e-commerce", "marketplace", "retail"],     domain: "ecommerce",  subdomain: "retail",    userType: "consumer" },
  { keywords: ["security", "cybersecurity", "infosec", "auth"],         domain: "security",   subdomain: "cyber",     userType: "enterprise" },
  { keywords: ["climate", "energy", "cleantech", "solar", "ev"],        domain: "climate",    subdomain: "energy",    userType: "business" },
  { keywords: ["logistics", "supply chain", "shipping", "freight"],     domain: "logistics",  subdomain: "supply",    userType: "business" },
  { keywords: ["real estate", "proptech", "housing", "rental"],         domain: "realestate", subdomain: "proptech",  userType: "consumer" },
  { keywords: ["saas", "b2b", "enterprise software"],                   domain: "saas",       subdomain: "b2b",       userType: "business" },
  { keywords: ["gaming", "game", "esports"],                            domain: "gaming",     subdomain: "games",     userType: "consumer" },
  { keywords: ["food", "restaurant", "grocery", "delivery"],            domain: "food",       subdomain: "delivery",  userType: "consumer" },
  { keywords: ["hr", "hiring", "recruiting", "talent"],                 domain: "hr",         subdomain: "recruiting",userType: "business" },
  { keywords: ["legal", "legaltech", "compliance", "contract"],         domain: "legal",      subdomain: "legaltech", userType: "business" },
];

// ── Stub scoring functions ───────────────────────────────────────

/**
 * STUB: In production, this would call an LLM to classify the item.
 * For now, uses simple keyword heuristics matching against DOMAIN_RULES.
 *
 * @param text - Combined text from the item (name + description + tags)
 * @returns Classified { domain, subdomain, userType }
 */
function classifyDomain(text: string): { domain: string; subdomain: string; userType: string } {
  const lower = text.toLowerCase();

  for (const rule of DOMAIN_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return { domain: rule.domain, subdomain: rule.subdomain, userType: rule.userType };
    }
  }

  // Default when no keyword matches
  return { domain: "general", subdomain: "", userType: "business" };
}

/**
 * STUB: Computes trend_score from 0.0 to 1.0 based on frequency and signals.
 *
 * Formula:
 *   base                          = 0.3
 *   + frequency bonus (up to 0.3) = min(sourceCount / 5, 1.0) * 0.3
 *   + YC RFS bonus    (0.2)       = 0.2 if any source is a YC item
 *   + HN engagement   (up to 0.2) = min(hnPoints / 500, 1.0) * 0.2
 *
 * Clamped to [0.0, 1.0].
 *
 * @param sources   - Array of sources that contributed to this candidate
 * @param hnPoints  - Maximum HN points seen across HN sources (optional)
 */
function computeTrendScore(sources: Source[], hnPoints?: number): number {
  const base = 0.3;

  // Frequency bonus: more sources = stronger signal, caps at 5 sources
  const frequencyBonus = Math.min(sources.length / 5, 1.0) * 0.3;

  // YC RFS bonus: presence on Y Combinator's radar is a strong trend signal
  const hasYC = sources.some((s) => s.type === "yc");
  const ycBonus = hasYC ? 0.2 : 0.0;

  // HN engagement bonus: high points indicate community interest
  const points = hnPoints ?? 0;
  const hnBonus = Math.min(points / 500, 1.0) * 0.2;

  return Math.min(base + frequencyBonus + ycBonus + hnBonus, 1.0);
}

/**
 * STUB: Computes gap_score from 0.0 to 1.0.
 *
 * Formula:
 *   starts at 0.5 (neutral)
 *   + 0.2 if few existing companies in the niche
 *   - 0.2 if saturated
 *
 * For now, always returns 0.5 (neutral) since we don't have competition
 * data yet. In production, this would query a market database or LLM.
 */
function computeGapScore(): number {
  return 0.5;
}

/**
 * STUB: Computes moat_potential from 0.0 to 1.0.
 *
 * Formula:
 *   base                             = 0.3
 *   + data moat bonus         (0.3)  if domain involves proprietary data
 *   + network effects bonus   (0.2)  if domain involves user networks
 *   + technical complexity    (0.2)  if domain involves AI/ML
 *
 * Domains with proprietary data moats: health, finance, security
 * Domains with network effects:        ecommerce, saas, hr, food
 * Domains with technical complexity:   ai, security, climate
 */
function computeMoatPotential(domain: string): number {
  const base = 0.3;

  // Data moat: domains where proprietary data creates defensibility
  const datamoatDomains = new Set(["health", "finance", "security", "legal"]);
  const dataBonus = datamoatDomains.has(domain) ? 0.3 : 0.0;

  // Network effects: domains where user networks create defensibility
  const networkDomains = new Set(["ecommerce", "saas", "hr", "food", "realestate"]);
  const networkBonus = networkDomains.has(domain) ? 0.2 : 0.0;

  // Technical complexity: domains requiring deep technical capability
  const techDomains = new Set(["ai", "security", "climate"]);
  const techBonus = techDomains.has(domain) ? 0.2 : 0.0;

  return Math.min(base + dataBonus + networkBonus + techBonus, 1.0);
}

// ── Merge key helper ─────────────────────────────────────────────

/** Build a merge key from domain+subdomain for deduplication. */
function mergeKey(domain: string, subdomain: string): string {
  return `${domain}::${subdomain}`;
}

// ── Main batch update function ───────────────────────────────────

/**
 * Process YC and HN items, classify them into niches, score them,
 * run legal screening, and upsert into the niches table.
 *
 * @param db      - The SQLite database handle
 * @param ycItems - Array of Y Combinator company/startup items
 * @param hnItems - Array of Hacker News front-page items
 * @returns Counts of created, updated, and rejected niches
 */
export function updateNichesFromBatch(
  db: Database,
  ycItems: YCItem[],
  hnItems: HNItem[],
): { created: number; updated: number; rejected: number } {
  const candidateMap = new Map<string, NicheCandidate>();

  // ── Step 1: Process YC items ────────────────────────────────
  for (const yc of ycItems) {
    const text = [yc.name, yc.description, ...(yc.tags ?? [])].join(" ");
    const { domain, subdomain, userType } = classifyDomain(text);
    const source: Source = { type: "yc", url: yc.url, name: yc.name };

    const key = mergeKey(domain, subdomain);
    const existing = candidateMap.get(key);

    if (existing) {
      // Merge: combine sources, average scores
      existing.sources.push(source);
      existing.trendScore = (existing.trendScore + computeTrendScore([source])) / 2;
      existing.description = existing.description + "; " + yc.description;
    } else {
      candidateMap.set(key, {
        domain,
        subdomain,
        userType,
        description: yc.description,
        trendScore: computeTrendScore([source]),
        gapScore: computeGapScore(),
        moatPotential: computeMoatPotential(domain),
        sources: [source],
      });
    }
  }

  // ── Step 2: Process HN items ────────────────────────────────
  for (const hn of hnItems) {
    const text = [hn.title, ...(hn.tags ?? [])].join(" ");
    const { domain, subdomain, userType } = classifyDomain(text);
    const source: Source = { type: "hn", url: hn.url, name: hn.title };

    const key = mergeKey(domain, subdomain);
    const existing = candidateMap.get(key);

    if (existing) {
      // Merge: combine sources, re-average scores incorporating HN engagement
      existing.sources.push(source);
      existing.trendScore =
        (existing.trendScore + computeTrendScore(existing.sources, hn.points)) / 2;
      existing.description = existing.description + "; " + hn.title;
    } else {
      candidateMap.set(key, {
        domain,
        subdomain,
        userType,
        description: hn.title,
        trendScore: computeTrendScore([source], hn.points),
        gapScore: computeGapScore(),
        moatPotential: computeMoatPotential(domain),
        sources: [source],
      });
    }
  }

  // ── Step 3: Recompute merged scores ─────────────────────────
  // After merging, recompute trend scores using the full source list
  // and the max HN points across all HN sources.
  for (const candidate of candidateMap.values()) {
    const maxHNPoints = candidate.sources
      .filter((s) => s.type === "hn")
      .reduce((max, _s) => {
        // We don't have per-source points stored in Source, so rely on
        // the incrementally averaged score from Steps 1 & 2.
        return max;
      }, 0);

    // Final trend score uses all sources
    candidate.trendScore = computeTrendScore(candidate.sources, maxHNPoints || undefined);
  }

  // ── Step 4: Upsert into DB with legal screening ─────────────
  let created = 0;
  let updated = 0;
  let rejected = 0;

  const upsertStmt = db.prepare(`
    INSERT INTO niches (
      niche_id, domain, subdomain, user_type, description,
      trend_score, gap_score, moat_potential,
      ethics_flag, legal_flag, sources, status,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(niche_id) DO UPDATE SET
      trend_score   = excluded.trend_score,
      gap_score     = excluded.gap_score,
      moat_potential = excluded.moat_potential,
      ethics_flag   = excluded.ethics_flag,
      legal_flag    = excluded.legal_flag,
      sources       = excluded.sources,
      description   = excluded.description,
      status        = excluded.status,
      updated_at    = datetime('now')
  `);

  // Check if a row exists for the given domain+subdomain
  const findExisting = db.prepare(
    `SELECT niche_id FROM niches WHERE domain = ? AND subdomain = ?`,
  );

  const runUpserts = db.transaction(() => {
    for (const candidate of candidateMap.values()) {
      // Build a Niche object for legal screening
      const nicheForScreening: Niche = {
        id: "",
        name: `${candidate.domain}/${candidate.subdomain || "general"}`,
        domain: candidate.domain,
        description: candidate.description,
        tags: [candidate.subdomain, candidate.userType].filter(Boolean),
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Legal/ethical screening
      const legalResult = evaluateNicheLegalRisk(nicheForScreening);
      const legalFlag = legalResult.flag;
      const status = legalFlag === "reject" ? "rejected" : "draft";

      // Check if this domain+subdomain already exists in the DB
      const existingRow = findExisting.get(
        candidate.domain,
        candidate.subdomain,
      ) as { niche_id: string } | undefined;

      const nicheId = existingRow?.niche_id ?? ulid();

      upsertStmt.run(
        nicheId,
        candidate.domain,
        candidate.subdomain,
        candidate.userType,
        candidate.description,
        candidate.trendScore,
        candidate.gapScore,
        candidate.moatPotential,
        "ok",       // ethics_flag: no ethics screening yet, default to ok
        legalFlag,
        JSON.stringify(candidate.sources),
        status,
      );

      if (legalFlag === "reject") {
        rejected++;
      } else if (existingRow) {
        updated++;
      } else {
        created++;
      }
    }
  });

  runUpserts();

  return { created, updated, rejected };
}

// ── Niche Enrichment via Web Search ─────────────────────────────

/** Enrichment data returned by Perplexity-powered niche research. */
export interface NicheEnrichment {
  /** Estimated market size description (e.g. "$4.2B global TAM") */
  marketSize: string;
  /** Competitive landscape summary */
  competition: string;
  /** Recent trend signals */
  trends: string;
  /** Source URLs backing the enrichment */
  sources: string[];
  /** Whether enrichment was successfully performed */
  ok: boolean;
}

const EMPTY_ENRICHMENT: NicheEnrichment = {
  marketSize: "",
  competition: "",
  trends: "",
  sources: [],
  ok: false,
};

/**
 * Enrich a niche candidate with real-time web data via Perplexity AI.
 *
 * This is optional — if no Perplexity API key is configured, the function
 * returns an empty enrichment (no-op). Callers can use the result to
 * adjust niche scores or add context to the niche description.
 *
 * @param niche - Object with name and domain of the niche to research
 * @returns NicheEnrichment with market data, competition, and trends
 */
export async function enrichNicheWithWebSearch(
  niche: { name: string; domain: string },
): Promise<NicheEnrichment> {
  // No-op if Perplexity is not configured
  if (!resolvePerplexityApiKey()) {
    logger.debug("Skipping niche enrichment — no Perplexity API key configured", {
      niche: niche.name,
    });
    return EMPTY_ENRICHMENT;
  }

  const query =
    `Market size, competition, and trends for "${niche.name}" in the ${niche.domain} sector. ` +
    `Include estimated TAM/SAM, key competitors, and recent growth trends with specific numbers.`;

  logger.info("Enriching niche via web search", { niche: niche.name, domain: niche.domain });

  const result = await webSearch(query, `Industry sector: ${niche.domain}`);

  if (!result.ok) {
    logger.warn("Niche enrichment failed", {
      niche: niche.name,
      error: result.error,
    });
    return EMPTY_ENRICHMENT;
  }

  // Parse the answer into structured sections.
  // The Perplexity response is free-form text; we do a best-effort split.
  const answer = result.answer;
  const sections = parseEnrichmentSections(answer);

  const enrichment: NicheEnrichment = {
    marketSize: sections.marketSize || answer.slice(0, 200),
    competition: sections.competition || "",
    trends: sections.trends || "",
    sources: result.sources,
    ok: true,
  };

  logger.info("Niche enrichment complete", {
    niche: niche.name,
    sourceCount: enrichment.sources.length,
    hasMarketSize: !!enrichment.marketSize,
    hasCompetition: !!enrichment.competition,
    hasTrends: !!enrichment.trends,
  });

  return enrichment;
}

/**
 * Best-effort parsing of Perplexity's free-form answer into sections.
 * Looks for common heading patterns (Market Size, Competition, Trends).
 */
function parseEnrichmentSections(text: string): {
  marketSize: string;
  competition: string;
  trends: string;
} {
  const marketSizePatterns = [
    /market\s*size[:\s]*([^]*?)(?=competition|competitors|trends|growth|$)/i,
    /tam[:\s/]*(?:sam)?[:\s]*([^]*?)(?=competition|competitors|trends|$)/i,
  ];
  const competitionPatterns = [
    /competi(?:tion|tors?|tive\s*landscape)[:\s]*([^]*?)(?=trends?|growth|market\s*size|$)/i,
    /key\s*players?[:\s]*([^]*?)(?=trends?|growth|market\s*size|$)/i,
  ];
  const trendsPatterns = [
    /trends?[:\s]*([^]*?)(?=market\s*size|competi|$)/i,
    /growth[:\s]*([^]*?)(?=market\s*size|competi|$)/i,
  ];

  function extractFirst(patterns: RegExp[], source: string): string {
    for (const p of patterns) {
      const match = p.exec(source);
      if (match?.[1]) {
        return match[1].trim().slice(0, 500);
      }
    }
    return "";
  }

  return {
    marketSize: extractFirst(marketSizePatterns, text),
    competition: extractFirst(competitionPatterns, text),
    trends: extractFirst(trendsPatterns, text),
  };
}
