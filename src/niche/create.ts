/**
 * Niche Creation
 *
 * Factory function that builds a new Niche object with legal screening
 * applied. The caller is responsible for persisting the returned Niche
 * to the database -- this function performs no I/O.
 */

import { ulid } from "ulid";
import type { Niche } from "./types.js";
import { evaluateNicheLegalRisk } from "../policy/legal.js";

/**
 * Create a new Niche with automatic legal/ethical screening.
 *
 * - Generates a ULID identifier
 * - Runs the niche through evaluateNicheLegalRisk()
 * - Sets status to "rejected" if the legal flag is "reject", otherwise "draft"
 * - Stores the legal flag and reasons on the Niche for audit purposes
 *
 * The returned Niche is a plain object. The caller is responsible for
 * persisting it to the database.
 */
export function createNiche(params: {
  name: string;
  domain: string;
  description: string;
  tags: string[];
}): Niche {
  const now = new Date().toISOString();

  // Build a partial niche for legal evaluation (needs all Niche fields)
  const niche: Niche = {
    id: ulid(),
    name: params.name,
    domain: params.domain,
    description: params.description,
    tags: params.tags,
    status: "draft", // provisional; may be overridden below
    createdAt: now,
    updatedAt: now,
  };

  // Run legal/ethical screening
  const legalResult = evaluateNicheLegalRisk(niche);

  // Apply screening results
  niche.legalFlag = legalResult.flag;
  niche.legalReasons = legalResult.reasons;

  // Auto-reject niches that fail legal screening
  if (legalResult.flag === "reject") {
    niche.status = "rejected";
  }

  return niche;
}
