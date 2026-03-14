/**
 * Social Client Factory
 *
 * Creates a social client based on available credentials.
 * Priority: Telegram (simplest, free) > Twitter/X > no-op fallback.
 *
 * Env vars checked:
 *   TELEGRAM_BOT_TOKEN → Telegram adapter
 *   TWITTER_BEARER_TOKEN + TWITTER_API_KEY → Twitter adapter
 */

import type { PrivateKeyAccount } from "viem";
import type { SocialClientInterface } from "../types.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("social");

export function createSocialClient(
  _relayUrl: string,
  _account: PrivateKeyAccount,
  _db?: import("better-sqlite3").Database,
): SocialClientInterface {
  // Try Telegram first
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    logger.info("Social relay: Telegram bot enabled");
    let client: SocialClientInterface | null = null;
    const getClient = async (): Promise<SocialClientInterface> => {
      if (!client) {
        const { createTelegramClient } = await import("./telegram.js");
        client = createTelegramClient(telegramToken);
      }
      return client;
    };
    return {
      send: async (to: string, content: string, replyTo?: string) =>
        (await getClient()).send(to, content, replyTo),
      poll: async (cursor?: string, limit?: number) =>
        (await getClient()).poll(cursor, limit),
      unreadCount: async () => (await getClient()).unreadCount(),
    };
  }

  // Try Twitter/X
  const twitterBearer = process.env.TWITTER_BEARER_TOKEN;
  const twitterApiKey = process.env.TWITTER_API_KEY;
  if (twitterBearer && twitterApiKey) {
    const twitterUsername = process.env.TWITTER_USERNAME;
    if (!twitterUsername) {
      logger.warn("TWITTER_USERNAME not set — skipping Twitter adapter despite having API keys");
    } else {
      logger.info("Social relay: Twitter/X enabled");
      let client: SocialClientInterface | null = null;
      const getClient = async (): Promise<SocialClientInterface> => {
        if (!client) {
          const { createTwitterClient } = await import("./twitter.js");
          client = createTwitterClient({
            bearerToken: twitterBearer,
            apiKey: twitterApiKey,
            apiSecret: process.env.TWITTER_API_SECRET || "",
            accessToken: process.env.TWITTER_ACCESS_TOKEN || "",
            accessSecret: process.env.TWITTER_ACCESS_SECRET || "",
            username: twitterUsername,
          });
        }
        return client;
      };
      return {
        send: async (to: string, content: string, replyTo?: string) =>
          (await getClient()).send(to, content, replyTo),
        poll: async (cursor?: string, limit?: number) =>
          (await getClient()).poll(cursor, limit),
        unreadCount: async () => (await getClient()).unreadCount(),
      };
    }
  }

  // Fallback to no-op
  logger.info("Social relay disabled (no TELEGRAM_BOT_TOKEN or TWITTER_* env vars)");
  return {
    send: async (_to: string, _content: string, _replyTo?: string) => {
      logger.debug("Social send skipped: no adapter configured");
      return { id: "noop" };
    },
    poll: async (_cursor?: string, _limit?: number) => {
      return { messages: [] };
    },
    unreadCount: async () => 0,
  };
}
