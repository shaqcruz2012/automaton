/**
 * Inference Client
 *
 * Wraps the /v1/chat/completions endpoint (OpenAI-compatible).
 * Supports Anthropic, OpenAI, and Ollama backends.
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
  InferenceToolDefinition,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";

const INFERENCE_TIMEOUT_MS = 60_000;

/** Errors that indicate the provider's billing/auth is exhausted — not transient, needs fallback */
const BILLING_ERROR_PATTERNS = [
  /credit balance is too low/i,
  /insufficient.*funds/i,
  /payment.*required/i,
];

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  groqApiKey?: string;
  ollamaBaseUrl?: string;
  /** Optional registry lookup — if provided, used before name heuristics */
  getModelProvider?: (modelId: string) => string | undefined;
}

type InferenceBackend = "conway" | "openai" | "anthropic" | "groq" | "ollama";

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const { apiUrl, apiKey, openaiApiKey, anthropicApiKey, groqApiKey, ollamaBaseUrl, getModelProvider } = options;
  const httpClient = new ResilientHttpClient({
    baseTimeout: INFERENCE_TIMEOUT_MS,
    retryableStatuses: [429, 500, 502, 503, 504],
  });
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    const backend = resolveInferenceBackend(model, {
      openaiApiKey,
      anthropicApiKey,
      groqApiKey,
      ollamaBaseUrl,
      getModelProvider,
    });

    // Newer models (o-series, gpt-5.x, gpt-4.1) require max_completion_tokens.
    // Ollama always uses max_tokens.
    const usesCompletionTokens =
      backend !== "ollama" && /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model);
    const tokenLimit = opts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    if (backend === "anthropic") {
      try {
        return await chatViaAnthropic({
          model,
          tokenLimit,
          messages,
          tools,
          temperature: opts?.temperature,
          anthropicApiKey: anthropicApiKey as string,
          httpClient,
        });
      } catch (err: any) {
        // On billing/auth errors, try fallback providers instead of failing
        if (isBillingError(err)) {
          const fallback = resolveFallbackBackend({ groqApiKey, openaiApiKey, ollamaBaseUrl });
          if (fallback) {
            return chatViaOpenAiCompatible({
              model: fallback.model,
              body: { ...body, model: fallback.model, max_tokens: tokenLimit },
              apiUrl: fallback.apiUrl,
              apiKey: fallback.apiKey,
              backend: fallback.backend,
              httpClient,
            });
          }
        }
        throw err;
      }
    }

    const openAiLikeApiUrl =
      backend === "groq" ? "https://api.groq.com/openai" :
      backend === "openai" ? "https://api.openai.com" :
      backend === "ollama" ? (ollamaBaseUrl as string).replace(/\/$/, "") :
      apiUrl;
    const openAiLikeApiKey =
      backend === "groq" ? (groqApiKey as string) :
      backend === "openai" ? (openaiApiKey as string) :
      backend === "ollama" ? "ollama" :
      apiKey;

    // Groq free tier has a 12K TPM limit — on 413, retry without tools
    // so the agent can still think/plan. Tools come back next turn.
    if (backend === "groq") {
      try {
        return await chatViaOpenAiCompatible({
          model, body, apiUrl: openAiLikeApiUrl, apiKey: openAiLikeApiKey, backend, httpClient,
        });
      } catch (err: any) {
        if (/413/.test(err?.message) && body.tools) {
          const trimmedBody = { ...body };
          delete trimmedBody.tools;
          delete trimmedBody.tool_choice;
          return chatViaOpenAiCompatible({
            model, body: trimmedBody, apiUrl: openAiLikeApiUrl, apiKey: openAiLikeApiKey, backend, httpClient,
          });
        }
        throw err;
      }
    }

    return chatViaOpenAiCompatible({
      model,
      body,
      apiUrl: openAiLikeApiUrl,
      apiKey: openAiLikeApiKey,
      backend,
      httpClient,
    });
  };

  /**
   * @deprecated Use InferenceRouter for tier-based model selection.
   * Still functional as a fallback; router takes priority when available.
   */
  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "claude-haiku-4-5-20251001";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}

function formatMessage(
  msg: ChatMessage,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) {
    // Ensure tool_call arguments are JSON strings (Ollama rejects objects)
    formatted.tool_calls = msg.tool_calls.map((tc: any) => ({
      ...tc,
      function: {
        ...tc.function,
        arguments:
          typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
      },
    }));
  }
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}

/**
 * Resolve which backend to use for a model.
 * When InferenceRouter is available, it uses the model registry's provider field.
 * This function is kept for backward compatibility with direct inference calls.
 */
function resolveInferenceBackend(
  model: string,
  keys: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    groqApiKey?: string;
    ollamaBaseUrl?: string;
    getModelProvider?: (modelId: string) => string | undefined;
  },
): InferenceBackend {
  // Registry-based routing: most accurate, no name guessing
  if (keys.getModelProvider) {
    const provider = keys.getModelProvider(model);
    if (provider === "groq" && keys.groqApiKey) return "groq";
    if (provider === "ollama" && keys.ollamaBaseUrl) return "ollama";
    if (provider === "anthropic" && keys.anthropicApiKey) return "anthropic";
    if (provider === "openai" && keys.openaiApiKey) return "openai";
    if (provider === "conway") return "conway";
    // provider unknown or key not configured — fall through to heuristics
  }

  // Heuristic fallback (model not in registry yet)
  if (keys.anthropicApiKey && /^claude/i.test(model)) return "anthropic";
  if (keys.openaiApiKey && /^(gpt-[3-9]|gpt-4|gpt-5|o[1-9][-\s.]|o[1-9]$|chatgpt)/i.test(model)) return "openai";
  return "conway";

}

async function chatViaOpenAiCompatible(params: {
  model: string;
  body: Record<string, unknown>;
  apiUrl: string;
  apiKey: string;
  backend: "conway" | "openai" | "groq" | "ollama";
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const resp = await params.httpClient.request(`${params.apiUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        params.backend === "openai" || params.backend === "groq" || params.backend === "ollama"
          ? `Bearer ${params.apiKey}`
          : params.apiKey,
    },
    body: JSON.stringify(params.body),
    timeout: INFERENCE_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Inference error (${params.backend}): ${resp.status}: ${text}`,
    );
  }

  const data = await resp.json() as any;
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error("No completion choice returned from inference");
  }

  const message = choice.message;
  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
  };

  const toolCalls: InferenceToolCall[] | undefined =
    message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: message.role,
      content: message.content || "",
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: choice.finish_reason || "stop",
  };
}

async function chatViaAnthropic(params: {
  model: string;
  tokenLimit: number;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  temperature?: number;
  anthropicApiKey: string;
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const transformed = transformMessagesForAnthropic(params.messages);
  if (transformed.messages.length === 0) {
    // Anthropic requires at least one user message — return a no-op response
    return {
      id: `noop-${Date.now()}`,
      model: params.model,
      message: { role: "assistant", content: "[No input messages to process]" },
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    };
  }
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.tokenLimit,
    messages: transformed.messages,
  };

  if (transformed.system) {
    body.system = transformed.system;
  }

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    body.tool_choice = { type: "auto" };
  }

  const resp = await params.httpClient.request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": params.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    timeout: INFERENCE_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Inference error (anthropic): ${resp.status}: ${text}`);
  }

  const data = await resp.json() as any;
  const content = Array.isArray(data.content) ? data.content : [];
  const textBlocks = content.filter((c: any) => c?.type === "text");
  const toolUseBlocks = content.filter((c: any) => c?.type === "tool_use");

  const toolCalls: InferenceToolCall[] | undefined =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((tool: any) => ({
          id: tool.id,
          type: "function" as const,
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }))
      : undefined;

  const textContent = textBlocks
    .map((block: any) => String(block.text || ""))
    .join("\n")
    .trim();

  if (!textContent && !toolCalls?.length) {
    // Log diagnostic info to help debug empty responses
    const stopReason = data.stop_reason || "unknown";
    const contentLen = content.length;
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    throw new Error(
      `No completion content returned from anthropic inference ` +
      `(stop_reason=${stopReason}, content_blocks=${contentLen}, ` +
      `input=${inputTokens}, output=${outputTokens})`
    );
  }

  const promptTokens = data.usage?.input_tokens || 0;
  const completionTokens = data.usage?.output_tokens || 0;
  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: normalizeAnthropicFinishReason(data.stop_reason),
  };
}

function transformMessagesForAnthropic(
  messages: ChatMessage[],
): { system?: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const transformed: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "user") {
      // Merge consecutive user messages (Anthropic requires alternating roles)
      const last = transformed[transformed.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") {
          // Both are plain strings — simple concatenation
          last.content = last.content + "\n" + msg.content;
        } else if (Array.isArray(last.content)) {
          // Previous message has content blocks (e.g. tool_result blocks).
          // Append the new text as a text block to preserve the array structure.
          (last.content as Array<Record<string, unknown>>).push({
            type: "text",
            text: msg.content || "",
          });
        }
        continue;
      }
      transformed.push({
        role: "user",
        content: msg.content,
      });
      continue;
    }

    if (msg.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const toolCall of msg.tool_calls || []) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        });
      }
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }
      // Merge consecutive assistant messages
      const last = transformed[transformed.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.content)) {
        (last.content as Array<Record<string, unknown>>).push(...content);
        continue;
      }
      transformed.push({
        role: "assistant",
        content,
      });
      continue;
    }

    if (msg.role === "tool") {
      // Merge consecutive tool messages into a single user message
      // with multiple tool_result content blocks
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "unknown_tool_call",
        content: msg.content,
      };

      const last = transformed[transformed.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        // Append tool_result to existing user message with content blocks
        (last.content as Array<Record<string, unknown>>).push(toolResultBlock);
        continue;
      }

      transformed.push({
        role: "user",
        content: [toolResultBlock],
      });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: transformed,
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function normalizeAnthropicFinishReason(reason: unknown): string {
  if (typeof reason !== "string") return "stop";
  if (reason === "tool_use") return "tool_calls";
  return reason;
}

/** Check if an error is a billing/auth exhaustion (not transient) */
function isBillingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return BILLING_ERROR_PATTERNS.some((p) => p.test(msg));
}

/** Find the best available fallback provider when the primary is down */
function resolveFallbackBackend(keys: {
  groqApiKey?: string;
  openaiApiKey?: string;
  ollamaBaseUrl?: string;
}): { apiUrl: string; apiKey: string; model: string; backend: "groq" | "openai" | "ollama" } | null {
  // 1. Groq (fast, free tier)
  const groqKey = keys.groqApiKey || process.env.GROQ_API_KEY;
  if (groqKey) {
    return {
      apiUrl: "https://api.groq.com/openai",
      apiKey: groqKey,
      model: "llama-3.3-70b-versatile",
      backend: "groq",
    };
  }

  // 2. OpenAI (paid, but different billing)
  if (keys.openaiApiKey) {
    return {
      apiUrl: "https://api.openai.com",
      apiKey: keys.openaiApiKey,
      model: "gpt-4.1-mini",
      backend: "openai",
    };
  }

  // 3. Ollama (local, free) — qwen2.5:7b has strong tool-calling accuracy
  if (keys.ollamaBaseUrl) {
    return {
      apiUrl: keys.ollamaBaseUrl.replace(/\/$/, ""),
      apiKey: "ollama",
      model: "qwen2.5:7b",
      backend: "ollama",
    };
  }

  return null;
}
