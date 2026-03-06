/**
 * LLM Summarizer
 *
 * Calls any OpenAI-compatible chat completions endpoint to generate
 * summaries. Works with Mistral (free tier), OpenAI, Ollama, etc.
 *
 * TODO: Plug into Datchi's cascade controller for automatic
 * model routing and cost tracking.
 */

import type { DetailLevel } from "./types.js";
import type { ServiceConfig } from "./config.js";
import { chunkText } from "./extractor.js";

export interface SummarizationResult {
  readonly summary: string;
  readonly keyPoints: readonly string[];
  readonly tokenEstimate: number;
}

const DETAIL_PROMPTS: Record<DetailLevel, string> = {
  short: "Provide a concise 2-3 sentence summary.",
  medium: "Provide a clear summary in one paragraph (4-6 sentences).",
  long: "Provide a detailed summary in 2-3 paragraphs covering all major points.",
};

/**
 * Summarize text content via an LLM.
 * For long content, chunks are summarized individually then composed.
 */
export async function summarizeText(
  config: ServiceConfig,
  text: string,
  options: {
    readonly detailLevel: DetailLevel;
    readonly title: string;
    readonly language: string;
  },
): Promise<SummarizationResult> {
  const { detailLevel, title, language } = options;

  // Chunk if content is very long (>8K chars)
  const chunks = chunkText(text, 8000);
  let totalTokenEstimate = 0;

  let contentToSummarize: string;

  if (chunks.length > 1) {
    // Multi-pass: summarize each chunk, then compose
    const chunkSummaries: string[] = [];

    for (const chunk of chunks) {
      const result = await callLlm(config, [
        {
          role: "system",
          content: "You are a precise content summarizer. Summarize the following text chunk concisely, preserving key facts and findings.",
        },
        {
          role: "user",
          content: `Summarize this text:\n\n${chunk}`,
        },
      ]);

      chunkSummaries.push(result.content);
      totalTokenEstimate += result.tokenEstimate;
    }

    contentToSummarize = chunkSummaries.join("\n\n---\n\n");
  } else {
    contentToSummarize = text;
  }

  // Final summarization pass
  const languageInstruction = language.toLowerCase() !== "english"
    ? ` Write the summary in ${language}.`
    : "";

  const systemPrompt = [
    "You are a professional content summarizer.",
    `${DETAIL_PROMPTS[detailLevel]}${languageInstruction}`,
    "After the summary, list 3-5 key points as a JSON array of strings under the key 'key_points'.",
    "Return ONLY valid JSON with keys: 'summary' (string) and 'key_points' (string array).",
  ].join(" ");

  // Sanitize title to prevent prompt injection from external page titles
  const safeTitle = title.replace(/["\\\n\r]/g, " ").slice(0, 200).trim();
  const userPrompt = safeTitle
    ? `Summarize this article titled "${safeTitle}":\n\n${contentToSummarize}`
    : `Summarize this content:\n\n${contentToSummarize}`;

  const result = await callLlm(config, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  totalTokenEstimate += result.tokenEstimate;

  // Parse structured response
  const parsed = parseStructuredResponse(result.content);

  return {
    summary: parsed.summary,
    keyPoints: parsed.keyPoints,
    tokenEstimate: totalTokenEstimate,
  };
}

interface LlmResponse {
  readonly content: string;
  readonly tokenEstimate: number;
}

/** Call the configured OpenAI-compatible chat completions endpoint */
async function callLlm(
  config: ServiceConfig,
  messages: ReadonlyArray<{ readonly role: string; readonly content: string }>,
): Promise<LlmResponse> {
  if (!config.llmApiKey) {
    throw new LlmError("LLM_NOT_CONFIGURED", "No LLM API key configured. Set LLM_API_KEY or MISTRAL_API_KEY.");
  }

  const url = `${config.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;

  const body = {
    model: config.llmModel,
    messages,
    max_tokens: config.llmMaxTokens,
    temperature: 0.3,
    stream: false,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    // Log upstream details server-side only; don't leak to clients
    const errorText = await response.text().catch(() => "");
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      module: "url-summarizer.llm",
      message: `LLM API error: ${response.status}`,
      context: { status: response.status, body: errorText.slice(0, 500) },
    };
    process.stdout.write(JSON.stringify(logEntry) + "\n");

    throw new LlmError("LLM_API_ERROR", `LLM service error (HTTP ${response.status})`);
  }

  const json = (await response.json()) as any;
  const content = json.choices?.[0]?.message?.content ?? "";
  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const outputTokens = json.usage?.completion_tokens ?? 0;

  const normalizedContent = typeof content === "string" ? content : String(content);
  if (!normalizedContent || normalizedContent.trim().length === 0) {
    throw new LlmError("LLM_EMPTY_RESPONSE", "LLM returned empty content");
  }

  return {
    content: normalizedContent,
    tokenEstimate: inputTokens + outputTokens,
  };
}

/** Parse the LLM's structured JSON response with fallbacks */
function parseStructuredResponse(
  content: string,
): { summary: string; keyPoints: readonly string[] } {
  // Try parsing as JSON
  try {
    // Extract JSON from markdown code block if wrapped
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, content];
    const jsonStr = jsonMatch[1]?.trim() ?? content.trim();
    const parsed = JSON.parse(jsonStr);

    if (typeof parsed.summary === "string" && Array.isArray(parsed.key_points)) {
      return {
        summary: parsed.summary,
        keyPoints: parsed.key_points.filter((p: unknown) => typeof p === "string"),
      };
    }
  } catch {
    // Fall through to text parsing
  }

  // Fallback: treat entire content as summary, extract bullet points
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const bulletLines = lines.filter((l) => /^[\s]*[-*•]\s/.test(l));
  const nonBulletLines = lines.filter((l) => !/^[\s]*[-*•]\s/.test(l));

  return {
    summary: nonBulletLines.join(" ").trim() || content.trim(),
    keyPoints: bulletLines.map((l) => l.replace(/^[\s]*[-*•]\s*/, "").trim()),
  };
}

export class LlmError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}
