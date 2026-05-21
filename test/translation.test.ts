import { describe, expect, it } from "vitest";
import {
  buildChatCompletionsUrl,
  protectInlineMarkdown,
  restoreInlineMarkdown,
  splitMarkdownSegments,
  splitTextForTranslation,
  translateMarkdown
} from "../src/translation";

describe("translation helpers", () => {
  it("builds an OpenAI-compatible chat completions URL", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions"
    );
    expect(buildChatCompletionsUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1/chat/completions"
    );
  });

  it("splits Markdown into protected and translatable segments", () => {
    const markdown = [
      "---",
      "title: Hello",
      "---",
      "# Hello",
      "",
      "```ts",
      "const value = 'do not translate';",
      "```",
      "",
      "Translate this sentence."
    ].join("\n");

    const segments = splitMarkdownSegments(markdown);
    expect(segments.filter((segment) => segment.kind === "protected")).toHaveLength(2);
    expect(segments.map((segment) => segment.content).join("")).toBe(markdown);
  });

  it("protects inline Markdown syntax", () => {
    const protectedChunk = protectInlineMarkdown(
      "Use `const answer = 42` and [docs](https://example.com) before $x + y$."
    );

    expect(protectedChunk.text).toContain("__TRANSLATE_MD_KEEP_0__");
    expect(protectedChunk.text).not.toContain("https://example.com");
    expect(restoreInlineMarkdown(protectedChunk.text, protectedChunk.tokens)).toContain(
      "[docs](https://example.com)"
    );
  });

  it("does not send fenced code or frontmatter to the translator", async () => {
    const markdown = [
      "---",
      "title: Hello",
      "---",
      "# Hello",
      "",
      "```ts",
      "const msg = 'Hello';",
      "```",
      "",
      "Use `inlineCode()` and [docs](https://example.com)."
    ].join("\n");
    const chunks: string[] = [];

    const translated = await translateMarkdown(markdown, {
      targetLanguage: "Chinese (Simplified)",
      maxChunkChars: 1000,
      translateChunk: async (chunk) => {
        chunks.push(chunk);
        expect(chunk).not.toContain("const msg");
        expect(chunk).not.toContain("inlineCode");
        expect(chunk).not.toContain("https://example.com");
        return chunk.replace("Hello", "Ni hao").replace("Use", "Use-translated");
      }
    });

    expect(translated).toContain("title: Hello");
    expect(translated).toContain("const msg = 'Hello';");
    expect(translated).toContain("Use-translated `inlineCode()` and [docs](https://example.com).");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("splits large text without dropping content", () => {
    const text = "A".repeat(1200) + "\n\n" + "B".repeat(1200);
    const chunks = splitTextForTranslation(text, 1000);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
  });
});
