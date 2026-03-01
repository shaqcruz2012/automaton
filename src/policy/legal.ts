/**
 * Legal Risk Evaluation
 *
 * Pure function that screens a Niche against keyword-based legal/ethical
 * policy rules. No side effects, no DB access -- just deterministic
 * classification based on domain, description, and tags.
 *
 * Keyword lists are exported as constants so they can be extended by
 * other modules or overridden in tests.
 */

import type { Niche, NicheLegalResult } from "../niche/types.js";

// ---------------------------------------------------------------------------
// Keyword lists
// ---------------------------------------------------------------------------

/**
 * Hard-block keywords. If ANY of these appear in the niche's domain,
 * description, or tags, the niche is rejected outright.
 */
export const REJECT_KEYWORDS: readonly string[] = [
  "gambling",
  "casino",
  "weapons",
  "firearms",
  "drugs",
  "narcotics",
  "darknet",
  "terrorism",
  "csam",
  "human trafficking",
  "sanctions evasion",
  "money laundering",
  "ponzi",
  "pyramid scheme",
] as const;

/**
 * Sensitive keywords. These niches are allowed but flagged for extra
 * scrutiny, compliance review, or operating restrictions.
 */
export const SENSITIVE_KEYWORDS: readonly string[] = [
  "health",
  "medical",
  "pharmaceutical",
  "finance",
  "investment",
  "trading",
  "legal advice",
  "insurance",
  "credit",
  "lending",
  "alcohol",
  "tobacco",
  "cannabis",
  "political",
  "religious",
] as const;

// ---------------------------------------------------------------------------
// Evaluation logic
// ---------------------------------------------------------------------------

/**
 * Build a single lowercased text blob from the niche's searchable fields.
 * This is matched against keyword lists.
 */
function buildSearchText(niche: Niche): string {
  const parts: string[] = [
    niche.domain,
    niche.description,
    ...niche.tags,
  ];
  return parts.join(" ").toLowerCase();
}

/**
 * Check a text blob against a keyword list and return all matches.
 */
function findMatches(text: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => text.includes(keyword));
}

/**
 * Evaluate a niche for legal/ethical risk.
 *
 * This is a pure function: given the same Niche input it always produces
 * the same NicheLegalResult output. It performs no I/O, no DB access,
 * and has no side effects.
 *
 * Rules (applied in order):
 * 1. If ANY reject keyword matches -> flag: "reject"
 * 2. If ANY sensitive keyword matches (and no reject) -> flag: "sensitive"
 * 3. Otherwise -> flag: "ok"
 */
export function evaluateNicheLegalRisk(niche: Niche): NicheLegalResult {
  const text = buildSearchText(niche);

  // --- Check for hard-block keywords first ---
  const rejectMatches = findMatches(text, REJECT_KEYWORDS);
  if (rejectMatches.length > 0) {
    return {
      flag: "reject",
      reasons: rejectMatches.map(
        (kw) => `Prohibited keyword detected: "${kw}"`,
      ),
    };
  }

  // --- Check for sensitive keywords ---
  const sensitiveMatches = findMatches(text, SENSITIVE_KEYWORDS);
  if (sensitiveMatches.length > 0) {
    return {
      flag: "sensitive",
      reasons: sensitiveMatches.map(
        (kw) => `Sensitive keyword detected: "${kw}"`,
      ),
    };
  }

  // --- All clear ---
  return {
    flag: "ok",
    reasons: [],
  };
}
