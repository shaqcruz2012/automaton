/**
 * Telegram Bot Social Adapter
 *
 * Implements SocialClientInterface using the Telegram Bot API.
 * Uses raw HTTP calls (no npm dependencies) via the Bot API REST endpoints.
 *
 * Setup: Create a bot via @BotFather, set TELEGRAM_BOT_TOKEN env var.
 */

import type { SocialClientInterface, InboxMessage } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("social.telegram");

// ─── Telegram API Response Types ────────────────────────────────

interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
}

interface TelegramChat {
  readonly id: number;
  readonly type: "private" | "group" | "supergroup" | "channel";
  readonly title?: string;
  readonly username?: string;
  readonly first_name?: string;
  readonly last_name?: string;
}

interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly date: number;
  readonly text?: string;
  readonly caption?: string;
  readonly reply_to_message?: TelegramMessage;
  readonly sticker?: { readonly emoji?: string };
  readonly photo?: readonly unknown[];
  readonly video?: unknown;
  readonly voice?: unknown;
  readonly audio?: unknown;
  readonly document?: unknown;
  readonly animation?: unknown;
  readonly video_note?: unknown;
  readonly contact?: unknown;
  readonly location?: unknown;
  readonly venue?: unknown;
  readonly poll?: unknown;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly channel_post?: TelegramMessage;
  readonly edited_channel_post?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
}

interface TelegramSendMessageResult {
  readonly message_id: number;
  readonly chat: TelegramChat;
  readonly date: number;
  readonly text?: string;
}

// ─── Constants ──────────────────────────────────────────────────

const BASE_URL = "https://api.telegram.org/bot";
const LONG_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_POLL_LIMIT = 100;
const MAX_MESSAGE_LENGTH = 4096;
const REQUEST_TIMEOUT_MS = (LONG_POLL_TIMEOUT_SECONDS + 5) * 1000;
const MAX_INBOUND_LENGTH = 4096;

// ─── Helpers ────────────────────────────────────────────────────

function extractTextContent(msg: TelegramMessage): string {
  if (msg.text != null && msg.text.length > 0) {
    return msg.text.slice(0, MAX_INBOUND_LENGTH);
  }
  if (msg.caption != null && msg.caption.length > 0) {
    return msg.caption.slice(0, MAX_INBOUND_LENGTH);
  }
  if (msg.sticker != null) {
    return msg.sticker.emoji != null ? `[sticker: ${msg.sticker.emoji}]` : "[sticker]";
  }
  if (msg.photo != null && msg.photo.length > 0) {
    return "[photo]";
  }
  if (msg.video != null) {
    return "[video]";
  }
  if (msg.voice != null) {
    return "[voice message]";
  }
  if (msg.audio != null) {
    return "[audio]";
  }
  if (msg.document != null) {
    return "[document]";
  }
  if (msg.animation != null) {
    return "[animation]";
  }
  if (msg.video_note != null) {
    return "[video note]";
  }
  if (msg.contact != null) {
    return "[contact]";
  }
  if (msg.location != null) {
    return "[location]";
  }
  if (msg.venue != null) {
    return "[venue]";
  }
  if (msg.poll != null) {
    return "[poll]";
  }
  return "[media]";
}

function telegramMessageToInbox(msg: TelegramMessage, botId: string): InboxMessage {
  const fromId = msg.from != null ? String(msg.from.id) : String(msg.chat.id);
  const content = extractTextContent(msg);
  const timestamp = new Date(msg.date * 1000).toISOString();

  return {
    id: String(msg.message_id),
    from: fromId,
    to: botId,
    content,
    signedAt: timestamp,
    createdAt: timestamp,
    replyTo: msg.reply_to_message != null
      ? String(msg.reply_to_message.message_id)
      : undefined,
  };
}

function truncateMessage(content: string): string {
  if (content.length <= MAX_MESSAGE_LENGTH) {
    return content;
  }
  const truncationNotice = "\n... [truncated]";
  return content.slice(0, MAX_MESSAGE_LENGTH - truncationNotice.length) + truncationNotice;
}

// ─── Telegram Client Implementation ────────────────────────────

class TelegramClient implements SocialClientInterface {
  private readonly baseUrl: string;
  private readonly botToken: string;
  private botId: string = "unknown";

  constructor(botToken: string) {
    if (botToken.length === 0) {
      throw new Error("Telegram bot token must not be empty");
    }
    this.botToken = botToken;
    this.baseUrl = `${BASE_URL}${botToken}`;

    // Extract bot ID from token (format: "123456:ABC-DEF...")
    const colonIndex = botToken.indexOf(":");
    if (colonIndex > 0) {
      this.botId = botToken.slice(0, colonIndex);
    }

    logger.info("Telegram client initialized", { botId: this.botId });
  }

  async send(
    to: string,
    content: string,
    replyTo?: string,
  ): Promise<{ id: string }> {
    const chatId = to;
    const text = truncateMessage(content);

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    };

    if (replyTo != null) {
      const replyId = Number(replyTo);
      if (Number.isFinite(replyId)) {
        body.reply_to_message_id = replyId;
      }
    }

    try {
      const response = await this.apiCall<TelegramSendMessageResult>(
        "sendMessage",
        body,
      );

      if (response.ok && response.result != null) {
        const messageId = String(response.result.message_id);
        logger.debug("Message sent", { chatId, messageId });
        return { id: messageId };
      }

      // Retry without Markdown if parse error
      if (
        response.error_code === 400 &&
        response.description != null &&
        response.description.includes("parse")
      ) {
        logger.warn("Markdown parse failed, retrying as plain text", {
          chatId,
          error: response.description,
        });
        const plainBody: Record<string, unknown> = { chat_id: chatId, text };
        if (replyTo != null) {
          const replyId = Number(replyTo);
          if (Number.isFinite(replyId)) {
            plainBody.reply_to_message_id = replyId;
          }
        }
        const retryResponse = await this.apiCall<TelegramSendMessageResult>(
          "sendMessage",
          plainBody,
        );
        if (retryResponse.ok && retryResponse.result != null) {
          return { id: String(retryResponse.result.message_id) };
        }
      }

      logger.error("Failed to send message", undefined, {
        chatId,
        errorCode: response.error_code,
        description: response.description,
      });
      return { id: "" };
    } catch (error) {
      logger.error(
        `Exception sending message to chat ${chatId}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      return { id: "" };
    }
  }

  async poll(
    cursor?: string,
    limit?: number,
  ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> {
    const offset = cursor != null ? Number(cursor) : undefined;
    const effectiveLimit = Math.min(
      Math.max(limit ?? DEFAULT_POLL_LIMIT, 1),
      DEFAULT_POLL_LIMIT,
    );

    const params: Record<string, unknown> = {
      timeout: LONG_POLL_TIMEOUT_SECONDS,
      limit: effectiveLimit,
      allowed_updates: ["message", "channel_post"],
    };

    if (offset != null && !Number.isNaN(offset)) {
      params.offset = offset;
    }

    try {
      const response = await this.apiCall<readonly TelegramUpdate[]>(
        "getUpdates",
        params,
      );

      if (!response.ok || response.result == null) {
        logger.warn("getUpdates failed", {
          errorCode: response.error_code,
          description: response.description,
        });
        return { messages: [] };
      }

      const updates = response.result;

      if (updates.length === 0) {
        return { messages: [], nextCursor: cursor };
      }

      const messages: InboxMessage[] = [];
      let maxUpdateId = offset ?? 0;

      for (const update of updates) {
        if (update.update_id > maxUpdateId) {
          maxUpdateId = update.update_id;
        }

        const telegramMsg =
          update.message ?? update.channel_post ?? null;
        if (telegramMsg == null) {
          continue;
        }

        messages.push(telegramMessageToInbox(telegramMsg, this.botId));
      }

      // Next offset is max update_id + 1 to acknowledge processed updates
      const nextCursor = String(maxUpdateId + 1);

      logger.debug("Polled updates", {
        count: messages.length,
        nextCursor,
      });

      return { messages, nextCursor };
    } catch (error) {
      logger.error(
        "Exception polling updates",
        error instanceof Error ? error : new Error(String(error)),
      );
      return { messages: [] };
    }
  }

  async unreadCount(): Promise<number> {
    // Use getUpdates with limit=1 and timeout=0 to peek without blocking.
    // The response length tells us if there are pending updates.
    // Telegram does not expose an exact unread count directly, so we
    // fetch a batch and return its length as an approximation.
    try {
      const response = await this.apiCall<readonly TelegramUpdate[]>(
        "getUpdates",
        {
          timeout: 0,
          limit: DEFAULT_POLL_LIMIT,
        },
      );

      if (!response.ok || response.result == null) {
        logger.warn("unreadCount: getUpdates failed", {
          errorCode: response.error_code,
          description: response.description,
        });
        return 0;
      }

      const count = response.result.length;
      logger.debug("Unread count checked", { count });
      return count;
    } catch (error) {
      logger.error(
        "Exception checking unread count",
        error instanceof Error ? error : new Error(String(error)),
      );
      return 0;
    }
  }

  // ─── Private API helpers ────────────────────────────────────

  private async apiCall<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<TelegramApiResponse<T>> {
    const url = `${this.baseUrl}/${method}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const data = (await response.json()) as TelegramApiResponse<T>;

      if (!data.ok) {
        logger.warn("Telegram API error", {
          method,
          status: response.status,
          errorCode: data.error_code,
          description: data.description,
        });
      }

      return data;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logger.warn("Telegram API request timed out", {
          method,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        return {
          ok: false,
          description: `Request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        };
      }

      logger.error(
        `Telegram API network error [${method}]`,
        error instanceof Error ? error : new Error(String(error)),
      );
      return {
        ok: false,
        description: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a Telegram bot client implementing SocialClientInterface.
 *
 * @param botToken - Telegram Bot API token from @BotFather
 * @returns A SocialClientInterface backed by the Telegram Bot API
 */
export function createTelegramClient(botToken: string): SocialClientInterface {
  return new TelegramClient(botToken);
}
