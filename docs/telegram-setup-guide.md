# Telegram Bot Setup Guide for Automaton

## Architecture Overview

This document describes how to wire a Telegram bot to the automaton's agent loop
so that users can send a URL and receive an AI-generated summary in reply.

### Data Flow

```
User sends URL via Telegram
        │
        ▼
┌──────────────────────┐
│  Telegram Bot API    │
│  (getUpdates poll)   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐    heartbeat daemon polls every tick
│  check_social_inbox  │    (src/heartbeat/tasks.ts, line 173)
│  (heartbeat task)    │
└──────────┬───────────┘
           │  stores messages in inbox_messages table
           │  sets shouldWake: true
           ▼
┌──────────────────────┐
│  Agent wakes up      │
│  (src/agent/loop.ts) │
│  claimInboxMessages  │    line 466 — claims up to 10 messages
└──────────┬───────────┘
           │  formats as "[Message from <id>]: <content>"
           │  injects into pendingInput
           ▼
┌──────────────────────┐
│  LLM inference turn  │
│  agent decides what   │
│  tools to call       │
└──────────┬───────────┘
           │
           ▼  (GAP — see "Required Code Changes" below)
┌──────────────────────┐
│  URL Summarizer      │    src/skills/revenue/url-summarizer.ts
│  (localhost:9003)    │    calls summarizeUrlForClient()
└──────────┬───────────┘
           │
           ▼  (GAP — see "Required Code Changes" below)
┌──────────────────────┐
│  Telegram send()     │    src/social/telegram.ts — TelegramClient.send()
│  reply to user       │
└──────────────────────┘
```

---

## Environment Variables Required

| Variable             | Required | Description                                                       |
|----------------------|----------|-------------------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN` | Yes      | Bot API token from @BotFather (format: `123456789:ABCdef...`)     |
| `TELEGRAM_CHAT_ID`   | No       | Not needed. Chat ID is extracted from each incoming message automatically via `msg.chat.id` in `telegramMessageToInbox()`. The agent replies to whatever chat the message came from. |

### How the Token is Used

1. `src/social/client.ts` — `createSocialClient()` checks `process.env.TELEGRAM_BOT_TOKEN` at startup.
2. If present, it lazily imports `src/social/telegram.ts` and calls `createTelegramClient(token)`.
3. The resulting `SocialClientInterface` is passed to both:
   - The heartbeat daemon (`taskCtx.social`) for polling via `check_social_inbox`
   - The agent loop (`ToolContext.social`) for child messaging

No other env vars are needed for the Telegram adapter itself.

---

## What Already Works

### 1. Polling: Telegram -> Inbox (COMPLETE)

The `check_social_inbox` heartbeat task (`src/heartbeat/tasks.ts:173`) already:
- Calls `taskCtx.social.poll(cursor)` which invokes Telegram's `getUpdates` long-poll
- Deduplicates messages via `inbox_seen_{id}` KV entries
- Sanitizes content through `sanitizeInput()` injection defense
- Stores messages in the `inbox_messages` table with status `received`
- Returns `shouldWake: true` when new non-blocked messages arrive

### 2. Agent Wake + Claim (COMPLETE)

The agent loop (`src/agent/loop.ts:463-480`) already:
- Calls `claimInboxMessages(db.raw, 10)` to atomically claim `received` -> `in_progress`
- Formats messages as `[Message from <sender_id>]: <content>`
- Injects them as `pendingInput` with source `"agent"`
- Marks them `processed` after the turn succeeds, or resets to `received`/`failed` on error

### 3. URL Summarizer Skill (COMPLETE)

`src/skills/revenue/url-summarizer.ts` provides `summarizeUrlForClient()`:
- Calls `localhost:9003/summarize-url` (the URL Summarizer Pro microservice)
- Validates URLs against SSRF (blocks localhost, private IPs)
- Logs revenue ($0.01/call) and expense (~$0.002/call) in the accounting ledger
- Returns structured result: `{ success, title, summary, keyPoints, wordCount }`

### 4. Telegram Send (COMPLETE)

`TelegramClient.send(to, content, replyTo?)` in `src/social/telegram.ts`:
- Sends via Telegram Bot API `sendMessage`
- Supports Markdown formatting with plain-text fallback
- Truncates to 4096 chars
- `to` is the chat ID (string), `replyTo` is the message ID

### 5. Service Watchdog (COMPLETE)

The `service_watchdog` heartbeat task (`src/heartbeat/tasks.ts:618`) already
monitors the URL Summarizer service on port 9003 and auto-restarts it if down.

---

## Required Code Changes (Gaps)

There are **two critical gaps** preventing the end-to-end flow:

### Gap 1: No `reply_social` Tool

The agent has no tool to reply to social inbox messages. The existing tools are:
- `message_child` — sends to child automatons only (uses `sendToChild()`)
- `x402_fetch` — makes HTTP requests with x402 payment, not social replies

**The agent receives inbox messages but has no tool to send a response back.**

**Fix:** Add a `reply_social` (or `send_social_message`) tool to `src/agent/tools.ts`:

```typescript
{
  name: "reply_social",
  description:
    "Reply to a social inbox message (Telegram, Twitter, etc). " +
    "Use the sender's address as 'to' and optionally the message ID as 'reply_to'.",
  category: "social",
  riskLevel: "caution",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient chat/user ID (from inbox message 'from' field)" },
      content: { type: "string", description: "Reply text (max 4096 chars)" },
      reply_to: { type: "string", description: "Original message ID to thread the reply (optional)" },
    },
    required: ["to", "content"],
  },
  execute: async (args, ctx) => {
    if (!ctx.social) {
      return "Social adapter not configured. Set TELEGRAM_BOT_TOKEN env var.";
    }
    const to = args.to as string;
    const content = args.content as string;
    const replyTo = args.reply_to as string | undefined;
    const result = await ctx.social.send(to, content, replyTo);
    return `Message sent (id: ${result.id})`;
  },
}
```

Also add `"reply_social"` to the `ToolCategory` type if `"social"` is not already a valid category,
or use `"replication"` as the category (which already exists).

### Gap 2: No Automatic URL Detection + Summarizer Invocation

Currently, when the agent sees `[Message from 12345]: https://example.com/article`,
it has no instruction or tool that automatically:
1. Detects a URL in the message
2. Calls the URL Summarizer skill
3. Replies with the summary

The agent's LLM could potentially do this if:
- The system prompt instructs it to handle URL messages
- The `summarizeUrlForClient()` function is exposed as a tool

**Fix options (pick one):**

**Option A: Add a `summarize_url` agent tool** that wraps `summarizeUrlForClient()`:

```typescript
{
  name: "summarize_url",
  description:
    "Summarize a URL using the URL Summarizer Pro service. " +
    "Returns title, summary, and key points.",
  category: "skills",
  riskLevel: "safe",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to summarize" },
      detail_level: {
        type: "string",
        description: "short, medium, or long (default: medium)",
      },
    },
    required: ["url"],
  },
  execute: async (args, ctx) => {
    const { summarizeUrlForClient } = await import("../skills/revenue/url-summarizer.js");
    const result = await summarizeUrlForClient(ctx.db.raw, {
      url: args.url as string,
      detail_level: (args.detail_level as "short" | "medium" | "long") ?? "medium",
      apiKey: "internal", // Internal call, no external API key needed
    });
    if (!result.success) {
      return `URL summarization failed: ${result.error}`;
    }
    return JSON.stringify({
      title: result.title,
      summary: result.summary,
      keyPoints: result.keyPoints,
      wordCount: result.wordCount,
    }, null, 2);
  },
}
```

**Option B: Use `exec` tool with curl** — the agent could call
`exec({ command: "curl -s http://localhost:9003/summarize-url -d '{...}'" })`,
but this is fragile and bypasses accounting.

**Option A is strongly recommended** because it records revenue/expense in the ledger.

### Gap 3 (Minor): System Prompt Instruction

Add a line to the system prompt (`src/agent/system-prompt.ts`) instructing the agent
to handle URL messages from the social inbox:

```
When you receive a social inbox message containing a URL, use the summarize_url tool
to generate a summary, then reply to the sender using reply_social with the result.
```

---

## Does the Current Heartbeat Triage + Agent Turn Loop Handle This?

**Yes, with the gaps filled.** The existing flow is:

1. **Heartbeat tick** runs `check_social_inbox` -> polls Telegram -> stores messages -> wakes agent
2. **Agent loop** wakes -> `claimInboxMessages()` -> formats `[Message from <chat_id>]: <url>`
3. **Triage phase** (read_file only) -> transitions to **agent_turn** (full tools)
4. **Agent turn** sees the message, calls `summarize_url` tool, gets summary
5. **Agent turn** calls `reply_social` with chat_id and summary text
6. **Turn persists** -> marks inbox messages as `processed`

Steps 4 and 5 require the two new tools described above. The loop infrastructure
(wake, claim, triage, agent_turn, process/fail) is already wired correctly.

### Timing

- Heartbeat tick interval is configurable (default varies by survival tier)
- `check_social_inbox` runs every tick
- Telegram long-poll timeout is 30 seconds (`LONG_POLL_TIMEOUT_SECONDS`)
- Typical end-to-end latency: 30-90 seconds (poll wait + agent wake + inference + summarizer call)

---

## Step-by-Step: Create the Telegram Bot via @BotFather

1. **Open Telegram** and search for `@BotFather` (verified blue checkmark).

2. **Start a conversation** — send `/start` to BotFather.

3. **Create a new bot** — send `/newbot`.

4. **Choose a display name** — this is what users see in chats.
   Example: `Datchi Summarizer`

5. **Choose a username** — must end in `bot` and be globally unique.
   Example: `datchi_summarizer_bot`

6. **Copy the token** — BotFather replies with a message containing:
   ```
   Use this token to access the HTTP API:
   123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
   ```
   This is your `TELEGRAM_BOT_TOKEN`.

7. **Set the bot description** (optional but recommended):
   ```
   /setdescription
   ```
   Then select your bot and send:
   ```
   Send me a URL and I'll summarize it for you using AI.
   ```

8. **Set the bot about text** (optional):
   ```
   /setabouttext
   ```
   Then select your bot and send:
   ```
   AI-powered URL summarizer by Datchi. Send any article URL to get a summary.
   ```

9. **Set bot commands** (optional, improves UX):
   ```
   /setcommands
   ```
   Then select your bot and send:
   ```
   start - Start the bot and get usage instructions
   help - Show available commands
   ```

10. **Disable group privacy** if you want the bot to work in group chats:
    ```
    /setprivacy
    ```
    Select your bot, then send `Disable`.

11. **Set the environment variable** on the machine running the automaton:
    ```bash
    export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
    ```
    Or add it to your `.env` file / environment configuration.

12. **Restart the automaton** so `createSocialClient()` picks up the new token.

13. **Send a test message** — open a chat with your bot in Telegram and send:
    ```
    https://en.wikipedia.org/wiki/Artificial_intelligence
    ```

14. **Verify** — check the automaton logs for:
    - `social.telegram: Polled updates` (heartbeat picked up the message)
    - `skill.url-summarizer: URL summary delivered` (summarizer processed it)
    - The bot should reply with the summary in the same chat

---

## Security Considerations

- **Bot token** is a secret. Store it in environment variables, never in source code.
- **SSRF protection** is built into both `url-summarizer.ts` and `tools.ts` — blocks
  localhost, private IPs, and non-HTTP protocols.
- **Injection defense** is applied to all incoming messages via `sanitizeInput()` before
  they reach the agent. Messages with detected injection attempts are blocked and
  do not wake the agent.
- **Rate limiting** — Telegram's Bot API has built-in rate limits (~30 messages/second).
  The heartbeat backoff (5-minute cooldown on poll errors) prevents spam on API failures.
- **Message truncation** — inbound messages are capped at 4096 chars, outbound at 4096 chars.

---

## File Reference

| File | Role |
|------|------|
| `src/social/telegram.ts` | Telegram Bot API adapter (poll, send, unreadCount) |
| `src/social/client.ts` | Factory that selects Telegram/Twitter/no-op based on env vars |
| `src/heartbeat/tasks.ts` | `check_social_inbox` task — polls and stores inbox messages |
| `src/agent/loop.ts` | Agent loop — claims inbox messages, runs inference, persists turns |
| `src/agent/tools.ts` | Tool definitions — needs `reply_social` and `summarize_url` added |
| `src/agent/system-prompt.ts` | System prompt — needs URL-handling instruction added |
| `src/skills/revenue/url-summarizer.ts` | URL Summarizer skill wrapper with accounting |
| `src/skills/revenue/index.ts` | Revenue skills registry (re-exports `summarizeUrlForClient`) |
| `src/types.ts` | `SocialClientInterface`, `InboxMessage`, `ToolContext` types |
| `src/state/database.ts` | `claimInboxMessages`, `markInboxProcessed` state machine helpers |
