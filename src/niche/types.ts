/**
 * Niche Types
 *
 * Defines the core data structures for niches -- the domains of activity
 * that the automaton can pursue. Each niche undergoes legal/ethical
 * screening before activation.
 */

/**
 * A niche represents a specific domain or market the automaton operates in.
 * Niches are screened for legal/ethical compliance before they can become active.
 */
export interface Niche {
  /** Unique identifier (ULID) */
  id: string;

  /** Human-readable name for this niche */
  name: string;

  /** The domain or market area (e.g., "saas", "data-analytics", "content") */
  domain: string;

  /** Free-text description of what the niche involves */
  description: string;

  /** Categorization tags for search and filtering */
  tags: string[];

  /** Lifecycle status of the niche */
  status: "draft" | "active" | "paused" | "rejected";

  /** Result of the legal/ethical screening */
  legalFlag?: "ok" | "sensitive" | "reject";

  /** Human-readable reasons for the legal flag */
  legalReasons?: string[];

  /** ISO 8601 timestamp of creation */
  createdAt: string;

  /** ISO 8601 timestamp of last update */
  updatedAt: string;
}

/**
 * The result of evaluating a niche against legal/ethical policy rules.
 * Returned by evaluateNicheLegalRisk().
 */
export interface NicheLegalResult {
  /** Overall risk flag: ok (safe), sensitive (needs care), reject (hard block) */
  flag: "ok" | "sensitive" | "reject";

  /** Human-readable reasons explaining the flag */
  reasons: string[];
}
