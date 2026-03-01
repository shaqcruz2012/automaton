/**
 * Social Client Factory
 *
 * Phase 5b: Social relay disabled. Returns no-op stubs that log
 * "social relay disabled" and return empty results. The relay
 * can be re-enabled when a local or self-hosted relay is available.
 */

import type { PrivateKeyAccount } from "viem";
import type { SocialClientInterface } from "../types.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("social");

/**
 * Create a no-op SocialClient.
 * Phase 5b: Social relay is disabled — no external dependency.
 */
export function createSocialClient(
  _relayUrl: string,
  _account: PrivateKeyAccount,
  _db?: import("better-sqlite3").Database,
): SocialClientInterface {
  logger.info("Social relay disabled (no relay configured)");

  return {
    send: async (
      _to: string,
      _content: string,
      _replyTo?: string,
    ): Promise<{ id: string }> => {
      logger.debug("Social send skipped: relay disabled");
      return { id: "noop" };
    },

    poll: async (
      _cursor?: string,
      _limit?: number,
    ): Promise<{ messages: never[]; nextCursor?: string }> => {
      return { messages: [] };
    },

    unreadCount: async (): Promise<number> => {
      return 0;
    },
  };
}
