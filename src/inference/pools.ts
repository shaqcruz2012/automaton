/**
 * Cascade Pool Definitions
 *
 * Defines the three inference pools and their cascade order.
 * The CascadeController uses these to decide which providers
 * are available based on profitability and survival tier.
 */

import type { CascadePool } from "../types.js";
import { DEFAULT_PROVIDERS, type ProviderConfig } from "./provider-registry.js";

/** The order in which pools are tried when the current pool is exhausted */
export const POOL_CASCADE_ORDER: CascadePool[] = ["paid", "free_cloud", "local"];

/**
 * Return providers belonging to a specific pool.
 * Filters the DEFAULT_PROVIDERS array by the `pool` field.
 * Providers without a pool field are assigned to "paid" by default.
 */
export function getProvidersForPool(pool: CascadePool): ProviderConfig[] {
  return DEFAULT_PROVIDERS.filter((p) => {
    const providerPool = p.pool ?? "paid";
    return providerPool === pool && p.enabled;
  });
}

/**
 * Get the next pool in the cascade after the given pool.
 * Returns null if there is no next pool (we've exhausted everything).
 */
export function getNextPool(currentPool: CascadePool): CascadePool | null {
  const idx = POOL_CASCADE_ORDER.indexOf(currentPool);
  if (idx === -1 || idx >= POOL_CASCADE_ORDER.length - 1) return null;
  return POOL_CASCADE_ORDER[idx + 1];
}
