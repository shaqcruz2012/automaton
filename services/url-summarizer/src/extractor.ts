/**
 * HTML Content Extractor
 *
 * Extracts readable text from HTML pages by stripping boilerplate,
 * scripts, styles, navigation, and ads. No external dependencies.
 *
 * TODO: Replace with Mozilla Readability or cheerio for production-grade
 * extraction when dependency budget allows.
 */

export interface ExtractedContent {
  readonly title: string;
  readonly text: string;
  readonly wordCount: number;
}

/** Extract readable content from raw HTML */
export function extractContent(html: string): ExtractedContent {
  // Extract title from <title> tag
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch?.[1] ?? "";
  const title = decodeEntities(rawTitle).trim();

  // Remove elements that are not content
  let cleaned = html;

  // Remove script, style, noscript, svg, head blocks
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, " ");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, " ");
  cleaned = cleaned.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  cleaned = cleaned.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  cleaned = cleaned.replace(/<head[\s\S]*?<\/head>/gi, " ");

  // Remove nav, header, footer, aside (common boilerplate containers)
  cleaned = cleaned.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  cleaned = cleaned.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  cleaned = cleaned.replace(/<aside[\s\S]*?<\/aside>/gi, " ");

  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, " ");

  // Replace block elements with newlines
  cleaned = cleaned.replace(/<\/?(?:p|div|br|hr|h[1-6]|li|tr|blockquote|pre|section|article)[^>]*>/gi, "\n");

  // Remove all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, " ");

  // Decode HTML entities
  cleaned = decodeEntities(cleaned);

  // Normalize whitespace
  cleaned = cleaned
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  // Remove very short lines (likely nav remnants)
  const lines = cleaned.split("\n");
  const contentLines = lines.filter((line) => line.split(" ").length >= 3);
  const text = contentLines.join("\n").trim();

  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;

  return { title, text, wordCount };
}

/** Decode common HTML entities */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Chunk long text into segments for multi-pass summarization.
 * Each chunk overlaps slightly to maintain context.
 */
export function chunkText(text: string, maxCharsPerChunk: number = 8000): readonly string[] {
  if (text.length <= maxCharsPerChunk) return [text];

  // Guard: overlap must be less than chunk size to guarantee progress
  const overlap = Math.min(200, Math.floor(maxCharsPerChunk * 0.1));
  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const end = Math.min(offset + maxCharsPerChunk, text.length);

    // Try to break at a sentence boundary
    let breakPoint = end;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      if (lastPeriod > offset + maxCharsPerChunk * 0.5) {
        breakPoint = lastPeriod + 1;
      }
    }

    chunks.push(text.slice(offset, breakPoint).trim());
    offset = Math.max(offset + 1, breakPoint - overlap);
  }

  return chunks;
}
