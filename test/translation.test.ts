import { describe, expect, it } from "vitest";
import {
  buildAnthropicMessagesUrl,
  buildOpenAiChatCompletionsUrl,
  protectInlineMarkdown,
  restoreInlineMarkdown,
  splitMarkdownSegments,
  splitTextForTranslation,
  translateMarkdown
} from "../src/translation";

describe("translation helpers", () => {
  it("builds an OpenAI-compatible chat completions URL", () => {
    expect(buildOpenAiChatCompletionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions"
    );
    expect(buildOpenAiChatCompletionsUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1/chat/completions"
    );
  });

  it("builds an Anthropic messages URL", () => {
    expect(buildAnthropicMessagesUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages"
    );
    expect(buildAnthropicMessagesUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/messages"
    );
    expect(buildAnthropicMessagesUrl("https://api.example.com/v1/messages")).toBe(
      "https://api.example.com/v1/messages"
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

  it("reports progress with Markdown block metadata", async () => {
    const markdown = [
      "---",
      "title: Hello",
      "---",
      "",
      "First paragraph.",
      "",
      "Second paragraph."
    ].join("\n");
    const progressMarkdown: string[] = [];
    const progressSourceLines: number[][] = [];

    const translated = await translateMarkdown(markdown, {
      targetLanguage: "Chinese (Simplified)",
      maxChunkChars: 20,
      onProgress: async (progress) => {
        progressMarkdown.push(progress.markdown);
        progressSourceLines.push(progress.parts.map((part) => part.sourceStartLine));
        expect(progress.completedParts).toBeLessThanOrEqual(progress.totalParts);
        expect(progress.completedRequests).toBeLessThanOrEqual(progress.totalRequests);
      },
      translateChunk: async (chunk) => chunk.replace(/paragraph/g, "段落")
    });

    expect(progressMarkdown.length).toBeGreaterThan(1);
    expect(progressMarkdown.at(-1)).toBe(translated);
    expect(progressSourceLines.at(-1)).toEqual([0, 3, 4, 5, 6]);
    expect(translated).toContain("First 段落.");
    expect(translated).toContain("Second 段落.");
  });

  it("batches several natural blocks into one translation request", async () => {
    const markdown = [
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph."
    ].join("\n");
    const chunks: string[] = [];

    const translated = await translateMarkdown(markdown, {
      targetLanguage: "Chinese (Simplified)",
      maxChunkChars: 1000,
      translateChunk: async (chunk) => {
        chunks.push(chunk);
        expect(chunk).toContain("<translate-md-block id=\"0\">");
        expect(chunk).toContain("<translate-md-block id=\"1\">");
        expect(chunk).toContain("<translate-md-block id=\"2\">");
        return chunk.replace(/paragraph/g, "段落");
      }
    });

    expect(chunks).toHaveLength(1);
    expect(translated).toBe([
      "First 段落.",
      "",
      "Second 段落.",
      "",
      "Third 段落."
    ].join("\n"));
  });

  it("splits a failed batch into smaller requests instead of aborting", async () => {
    const markdown = [
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
      "",
      "Fourth paragraph."
    ].join("\n");
    const chunks: string[] = [];

    const translated = await translateMarkdown(markdown, {
      targetLanguage: "Chinese (Simplified)",
      maxChunkChars: 2000,
      translateChunk: async (chunk) => {
        chunks.push(chunk);
        if (chunks.length === 1) {
          return "";
        }
        return chunk.replace(/paragraph/g, "段落");
      }
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(translated).toContain("First 段落.");
    expect(translated).toContain("Fourth 段落.");
  });

  it("splits translatable text on natural Markdown block boundaries", () => {
    const text = [
      "First paragraph.",
      "",
      "- one",
      "- two",
      "",
      "Second paragraph."
    ].join("\n");
    const chunks = splitTextForTranslation(text, 1000);
    expect(chunks).toEqual([
      "First paragraph.\n",
      "\n",
      "- one\n- two\n",
      "\n",
      "Second paragraph."
    ]);
  });

  it("splits large text without dropping content", () => {
    const text = "A".repeat(1200) + "\n\n" + "B".repeat(1200);
    const chunks = splitTextForTranslation(text, 1000);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
  });
});
