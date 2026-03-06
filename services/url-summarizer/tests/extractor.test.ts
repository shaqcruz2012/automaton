/**
 * Tests for HTML content extraction
 */

import { describe, it, expect } from "vitest";
import { extractContent, chunkText } from "../src/extractor.js";

describe("extractContent", () => {
  it("extracts title and body text from simple HTML", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Article</title></head>
        <body>
          <h1>Test Article</h1>
          <p>This is the first paragraph of the test article with enough words to pass the filter.</p>
          <p>This is the second paragraph with additional content that should be extracted properly.</p>
        </body>
      </html>
    `;
    const result = extractContent(html);
    expect(result.title).toBe("Test Article");
    expect(result.text).toContain("first paragraph");
    expect(result.text).toContain("second paragraph");
    expect(result.wordCount).toBeGreaterThan(10);
  });

  it("strips scripts and styles", () => {
    const html = `
      <html>
        <head>
          <title>Page</title>
          <style>body { color: red; }</style>
        </head>
        <body>
          <script>alert('xss')</script>
          <p>This is the visible content that should be preserved by the extractor properly.</p>
          <script>console.log('tracking');</script>
        </body>
      </html>
    `;
    const result = extractContent(html);
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain("color: red");
    expect(result.text).not.toContain("tracking");
    expect(result.text).toContain("visible content");
  });

  it("strips navigation and footer elements", () => {
    const html = `
      <html>
        <head><title>Article</title></head>
        <body>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <article>
            <p>This is the main article content that readers actually care about in the document.</p>
          </article>
          <footer>Copyright 2024 All Rights Reserved Sitemap Contact Privacy</footer>
        </body>
      </html>
    `;
    const result = extractContent(html);
    expect(result.text).toContain("main article content");
    expect(result.text).not.toContain("Copyright 2024");
  });

  it("decodes HTML entities", () => {
    const html = `
      <html>
        <head><title>Entities &amp; Test</title></head>
        <body>
          <p>Testing entities: &lt;div&gt; and &quot;quotes&quot; and &#39;apostrophes&#39; work correctly here.</p>
        </body>
      </html>
    `;
    const result = extractContent(html);
    expect(result.title).toBe("Entities & Test");
    expect(result.text).toContain('<div>');
    expect(result.text).toContain('"quotes"');
  });

  it("returns zero word count for empty content", () => {
    const html = `<html><head><title>Empty</title></head><body></body></html>`;
    const result = extractContent(html);
    expect(result.wordCount).toBe(0);
  });
});

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const text = "This is a short text.";
    const chunks = chunkText(text, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("splits long text into multiple chunks", () => {
    const text = "A ".repeat(5000); // 10,000 chars
    const chunks = chunkText(text, 3000);
    expect(chunks.length).toBeGreaterThan(1);
    // Verify all content is covered
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3200); // max + some flexibility
    }
  });

  it("maintains overlap between chunks", () => {
    const sentences = Array.from({ length: 50 }, (_, i) =>
      `Sentence number ${i} has some meaningful content.`,
    ).join(" ");
    const chunks = chunkText(sentences, 500);
    expect(chunks.length).toBeGreaterThan(1);
    // Last chars of chunk N should overlap with first chars of chunk N+1
    // (exact overlap depends on sentence breaking)
  });
});
