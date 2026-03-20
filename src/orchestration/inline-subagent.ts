/**
 * Inline Sub-Agent
 *
 * Runs a focused sub-agent synchronously within the parent agent's turn.
 * Unlike the LocalWorkerPool (async, task-graph-based), this returns results
 * directly to the caller — ideal for the chief-of-staff "text and get answer" flow.
 *
 * The sub-agent gets a minimal tool set (exec, read_file, write_file, task_done)
 * and runs a ReAct loop until it completes or times out.
 */

import { ulid } from "ulid";
import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger } from "../observability/logger.js";
import type { InferenceClient, ConwayClient, ChatMessage, InferenceOptions } from "../types.js";
import type { Database } from "better-sqlite3";

const logger = createLogger("subagent.inline");

const MAX_TURNS = 15;
const MAX_OUTPUT_LENGTH = 8000;

export interface InlineSubagentParams {
  task: string;
  role: string;
  timeoutMs: number;
  db: Database;
  inference: InferenceClient;
  conway: ConwayClient;
}

export interface InlineSubagentResult {
  success: boolean;
  output: string;
  error?: string;
  turns: number;
  durationMs: number;
  artifacts: string[];
}

interface SubagentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

function isDangerousCommand(cmd: string): boolean {
  const normalized = cmd.trim();
  if (/\brm\s+(-\w*\s+)*-rf\s+[/~]/.test(normalized)) return true;
  if (/\brmdir\s+\/s\b/i.test(normalized)) return true;
  if (/\bchmod\s+(-R\s+)?777\b/.test(normalized)) return true;
  if (/\bdd\s+if=/.test(normalized)) return true;
  if (/\b(shutdown|reboot|halt)\b/.test(normalized)) return true;
  if (/>\s*\S*\.env\b/.test(normalized)) return true;
  if (/>\s*\S*wallet\.json\b/.test(normalized)) return true;
  return false;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n[TRUNCATED: ${text.length - maxLen} chars omitted]`;
}

function localExec(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execCb(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function buildSystemPrompt(role: string): string {
  const roleDescriptions: Record<string, string> = {
    researcher: "You are a research sub-agent. Your job is to find information, analyze data, and provide comprehensive research results. Use exec to run curl, search commands, read files, etc.",
    coder: "You are a coding sub-agent. Your job is to write, modify, and test code. Use exec to run commands, write_file to create code, and read_file to inspect existing code.",
    writer: "You are a writing sub-agent. Your job is to draft content — emails, reports, summaries, documentation. Deliver polished text as your final output.",
    analyst: "You are an analysis sub-agent. Your job is to analyze data, extract insights, and provide structured findings. Use exec to process data and read_file to inspect sources.",
    generalist: "You are a general-purpose sub-agent. Handle whatever task is assigned using the tools available to you.",
  };

  const roleDesc = roleDescriptions[role] || roleDescriptions.generalist;

  return `${roleDesc}

RULES:
- Focus ONLY on the assigned task. Do not deviate.
- Use exec to run shell commands (curl, grep, node, python, etc.)
- Use write_file to create or modify files.
- Use read_file to inspect existing files.
- Call task_done with your final output when you are finished.
- If you cannot complete the task, call task_done with an explanation of why.
- Be efficient. Minimize unnecessary tool calls. You have limited turns.
- Do NOT call tools after task_done. Your task is over.`;
}

function buildTools(conway: ConwayClient): SubagentTool[] {
  return [
    {
      name: "exec",
      description: "Execute a shell command. Returns stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout_ms: { type: "number", description: "Timeout in ms (default: 30000)" },
        },
        required: ["command"],
      },
      execute: async (args) => {
        const command = args.command as string;
        const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 30_000;

        if (isDangerousCommand(command)) {
          return "Blocked: command rejected by safety check.";
        }

        try {
          const result = await conway.exec(command, timeoutMs);
          const stdout = truncate(result.stdout ?? "", 16_000);
          const stderr = truncate(result.stderr ?? "", 4000);
          return stderr ? `stdout:\n${stdout}\nstderr:\n${stderr}` : stdout || "(no output)";
        } catch {
          try {
            const result = await localExec(command, timeoutMs);
            const stdout = truncate(result.stdout, 16_000);
            const stderr = truncate(result.stderr, 4000);
            return stderr ? `stdout:\n${stdout}\nstderr:\n${stderr}` : stdout || "(no output)";
          } catch (error) {
            return `exec error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      },
    },
    {
      name: "write_file",
      description: "Write content to a file. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
      execute: async (args) => {
        const filePath = args.path as string;
        const content = args.content as string;
        const normalizedPath = path.resolve(filePath);
        const basename = path.basename(normalizedPath);
        const sensitiveFiles = ["wallet.json", ".env", "automaton.json"];
        if (sensitiveFiles.includes(basename) || basename.endsWith(".key") || basename.endsWith(".pem")) {
          return "Blocked: Cannot write to sensitive file.";
        }
        try {
          await conway.writeFile(normalizedPath, content);
          return `Wrote ${content.length} bytes to ${normalizedPath}`;
        } catch {
          try {
            await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
            await fs.writeFile(normalizedPath, content, "utf8");
            return `Wrote ${content.length} bytes to ${normalizedPath} (local)`;
          } catch (error) {
            return `write error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      },
    },
    {
      name: "read_file",
      description: "Read the contents of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const filePath = args.path as string;
        const normalizedPath = path.resolve(filePath);
        const basename = path.basename(normalizedPath);
        const sensitiveFiles = ["wallet.json", ".env", "automaton.json"];
        if (sensitiveFiles.includes(basename) || basename.endsWith(".key") || basename.endsWith(".pem")) {
          return "Blocked: Cannot read sensitive file.";
        }
        try {
          const content = await conway.readFile(normalizedPath);
          return truncate(content, 10_000) || "(empty file)";
        } catch {
          try {
            const content = await fs.readFile(normalizedPath, "utf8");
            return truncate(content, 10_000) || "(empty file)";
          } catch (error) {
            return `read error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      },
    },
    {
      name: "task_done",
      description: "Signal that your task is complete. Provide your final output/results.",
      parameters: {
        type: "object",
        properties: {
          result: { type: "string", description: "Your final output — the answer, deliverable, or summary." },
        },
        required: ["result"],
      },
      execute: async (args) => {
        return `TASK_COMPLETE: ${args.result as string}`;
      },
    },
  ];
}

/**
 * Run a sub-agent synchronously and return its results.
 * The sub-agent gets its own ReAct loop with a minimal tool set.
 */
export async function runInlineSubagent(params: InlineSubagentParams): Promise<InlineSubagentResult> {
  const { task, role, timeoutMs, inference, conway } = params;
  const agentId = `subagent-${ulid()}`;
  const startedAt = Date.now();
  const tools = buildTools(conway);
  const artifacts: string[] = [];

  const toolDefs = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(role) },
    { role: "user", content: `# Task\n\n${task}\n\nComplete this task and call task_done with your results.` },
  ];

  logger.info(`[SUBAGENT ${agentId}] Starting: "${task.slice(0, 100)}" (role: ${role}, timeout: ${timeoutMs}ms)`);

  let finalOutput = "";
  let turnCount = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    turnCount = turn + 1;

    if (Date.now() - startedAt > timeoutMs) {
      logger.warn(`[SUBAGENT ${agentId}] Timed out after ${timeoutMs}ms on turn ${turn + 1}`);
      return {
        success: false,
        output: finalOutput || "Sub-agent timed out before completing.",
        error: `Timed out after ${timeoutMs}ms`,
        turns: turnCount,
        durationMs: Date.now() - startedAt,
        artifacts,
      };
    }

    let response;
    try {
      response = await inference.chat(messages, {
        tools: toolDefs,
        maxTokens: 4096,
      } as InferenceOptions);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[SUBAGENT ${agentId}] Inference failed on turn ${turn + 1}`, error instanceof Error ? error : new Error(msg));
      return {
        success: false,
        output: finalOutput || "",
        error: `Inference failed: ${msg}`,
        turns: turnCount,
        durationMs: Date.now() - startedAt,
        artifacts,
      };
    }

    // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolNames = response.toolCalls.map((tc) => tc.function?.name ?? "?").join(", ");
      logger.info(`[SUBAGENT ${agentId}] Turn ${turn + 1} — tools: ${toolNames}`);

      // Add assistant message
      messages.push({
        role: "assistant",
        content: response.message.content || "",
        tool_calls: response.toolCalls,
      });

      // Execute tool calls
      for (const toolCall of response.toolCalls) {
        const fnName = toolCall.function.name;
        const fnArgs = toolCall.function.arguments;
        const tool = tools.find((t) => t.name === fnName);
        let toolOutput: string;

        if (!tool) {
          toolOutput = `Error: Unknown tool '${fnName}'`;
        } else {
          try {
            const args = typeof fnArgs === "string" ? JSON.parse(fnArgs) : fnArgs;
            toolOutput = await tool.execute(args as Record<string, unknown>);

            if (fnName === "write_file" && typeof (args as any).path === "string") {
              artifacts.push((args as any).path);
            }
          } catch (error) {
            toolOutput = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }

        messages.push({
          role: "tool",
          content: toolOutput,
          tool_call_id: toolCall.id,
        });

        // Check for task completion
        if (fnName === "task_done") {
          finalOutput = toolOutput.replace("TASK_COMPLETE: ", "");
        }
      }

      if (finalOutput) {
        logger.info(`[SUBAGENT ${agentId}] Completed on turn ${turn + 1}`);
        break;
      }
      continue;
    }

    // No tool calls — model gave final text response
    finalOutput = response.message.content || "Task completed.";
    logger.info(`[SUBAGENT ${agentId}] Done on turn ${turn + 1} (text response)`);
    break;
  }

  const durationMs = Date.now() - startedAt;

  if (!finalOutput) {
    return {
      success: false,
      output: "Sub-agent exhausted all turns without completing.",
      error: `Exhausted ${MAX_TURNS} turns`,
      turns: turnCount,
      durationMs,
      artifacts,
    };
  }

  return {
    success: true,
    output: truncate(finalOutput, MAX_OUTPUT_LENGTH),
    turns: turnCount,
    durationMs,
    artifacts,
  };
}
