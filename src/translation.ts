export interface MarkdownSegment {
  kind: "protected" | "translatable";
  content: string;
}

export interface TranslateMarkdownOptions {
  targetLanguage: string;
  maxChunkChars?: number;
  onProgress?: (progress: TranslationProgress) => void | Promise<void>;
  translateChunk: (markdown: string, targetLanguage: string) => Promise<string>;
}

export interface TranslationProgress {
  completedParts: number;
  completedRequests: number;
  markdown: string;
  totalParts: number;
  totalRequests: number;
}

export interface InlineProtectionResult {
  text: string;
  tokens: Map<string, string>;
}

interface TranslationPlanPart {
  kind: "passthrough" | "translatable";
  content: string;
  tokens?: Map<string, string>;
}

const DEFAULT_MAX_CHUNK_CHARS = 6000;
const INLINE_KEEP_PREFIX = "__TRANSLATE_MD_KEEP_";

export function buildOpenAiChatCompletionsUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "https://api.openai.com/v1/chat/completions";
  }
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

export function buildAnthropicMessagesUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "https://api.anthropic.com/v1/messages";
  }
  if (/\/v1\/messages$/i.test(trimmed) || /\/messages$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}/messages`;
  }
  return `${trimmed}/v1/messages`;
}

export async function translateMarkdown(
  markdown: string,
  options: TranslateMarkdownOptions
): Promise<string> {
  const maxChunkChars = Math.max(1000, options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS);
  const parts = createTranslationPlan(markdown, maxChunkChars);
  const totalRequests = parts.filter((part) => part.kind === "translatable").length;
  const output: string[] = [];
  let completedParts = 0;
  let completedRequests = 0;

  for (const part of parts) {
    if (part.kind === "passthrough") {
      output.push(part.content);
    } else {
      const translatedChunk = await options.translateChunk(part.content, options.targetLanguage);
      output.push(restoreInlineMarkdown(translatedChunk, part.tokens ?? new Map()));
      completedRequests += 1;
    }

    completedParts += 1;
    await options.onProgress?.({
      completedParts,
      completedRequests,
      markdown: output.join(""),
      totalParts: parts.length,
      totalRequests
    });
  }

  return output.join("");
}

function createTranslationPlan(markdown: string, maxChunkChars: number): TranslationPlanPart[] {
  const segments = splitMarkdownSegments(markdown);
  const parts: TranslationPlanPart[] = [];

  for (const segment of segments) {
    if (segment.kind === "protected" || !hasLetters(segment.content)) {
      parts.push({ kind: "passthrough", content: segment.content });
      continue;
    }

    for (const chunk of splitTextForTranslation(segment.content, maxChunkChars)) {
      if (!hasLetters(chunk)) {
        parts.push({ kind: "passthrough", content: chunk });
        continue;
      }

      const protectedChunk = protectInlineMarkdown(chunk);
      parts.push({
        kind: "translatable",
        content: protectedChunk.text,
        tokens: protectedChunk.tokens
      });
    }
  }

  return parts;
}

export function splitMarkdownSegments(markdown: string): MarkdownSegment[] {
  const lines = splitLinesKeepEndings(markdown);
  const segments: MarkdownSegment[] = [];
  let translatableBuffer: string[] = [];
  let index = 0;

  const flushTranslatable = () => {
    if (translatableBuffer.length > 0) {
      segments.push({ kind: "translatable", content: translatableBuffer.join("") });
      translatableBuffer = [];
    }
  };

  const pushProtected = (endExclusive: number) => {
    flushTranslatable();
    segments.push({
      kind: "protected",
      content: lines.slice(index, endExclusive).join("")
    });
    index = endExclusive;
  };

  while (index < lines.length) {
    const line = lines[index];
    const stripped = stripLineEnding(line).trim();

    if (index === 0 && stripped === "---") {
      const end = findFrontmatterEnd(lines, index + 1);
      if (end > index) {
        pushProtected(end);
        continue;
      }
    }

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      pushProtected(findFenceEnd(lines, index, fence[1][0], fence[1].length));
      continue;
    }

    if (stripped === "$$") {
      pushProtected(findMathBlockEnd(lines, index));
      continue;
    }

    if (line.includes("<!--")) {
      pushProtected(findHtmlCommentEnd(lines, index));
      continue;
    }

    if (/^ {0,3}<(script|style|pre|svg|iframe)\b/i.test(line)) {
      pushProtected(findHtmlBlockEnd(lines, index));
      continue;
    }

    translatableBuffer.push(line);
    index += 1;
  }

  flushTranslatable();
  return segments;
}

export function protectInlineMarkdown(text: string): InlineProtectionResult {
  const ranges = collectInlineProtectedRanges(text);
  const tokens = new Map<string, string>();

  if (ranges.length === 0) {
    return { text, tokens };
  }

  let protectedText = "";
  let cursor = 0;
  let tokenIndex = 0;

  for (const range of ranges) {
    if (range.start < cursor) {
      continue;
    }

    const token = `${INLINE_KEEP_PREFIX}${tokenIndex}__`;
    tokens.set(token, text.slice(range.start, range.end));
    protectedText += text.slice(cursor, range.start);
    protectedText += token;
    cursor = range.end;
    tokenIndex += 1;
  }

  protectedText += text.slice(cursor);
  return { text: protectedText, tokens };
}

export function restoreInlineMarkdown(text: string, tokens: Map<string, string>): string {
  let restored = text;
  for (const [token, value] of tokens) {
    restored = restored.split(token).join(value);
  }
  return restored;
}

export function splitTextForTranslation(text: string, maxChunkChars: number): string[] {
  if (text.length <= maxChunkChars) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";

  for (const part of text.split(/(\n{2,})/)) {
    if (part.length > maxChunkChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitOversizedText(part, maxChunkChars));
      continue;
    }

    if (current.length + part.length > maxChunkChars && current) {
      chunks.push(current);
      current = "";
    }
    current += part;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitOversizedText(text: string, maxChunkChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of splitLinesKeepEndings(text)) {
    if (line.length > maxChunkChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < line.length; offset += maxChunkChars) {
        chunks.push(line.slice(offset, offset + maxChunkChars));
      }
      continue;
    }

    if (current.length + line.length > maxChunkChars && current) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function collectInlineProtectedRanges(text: string): Array<{ start: number; end: number }> {
  const patterns = [
    /`+[^`\n]*?`+/g,
    /\$\$[\s\S]*?\$\$/g,
    /\$[^$\n]+\$/g,
    /!\[[^\]\n]*\]\([^)]+\)/g,
    /\[[^\]\n]+\]\([^)]+\)/g,
    /\[\[[^\]\n]+\]\]/g,
    /https?:\/\/[^\s<>)]+/g,
    /<[^>\n]+>/g,
    /&[a-zA-Z][a-zA-Z0-9]+;|&#\d+;|&#x[\da-fA-F]+;/g
  ];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }
    }
  }

  const sortedRanges = ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const acceptedRanges: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  for (const range of sortedRanges) {
    if (range.start < cursor) {
      continue;
    }
    acceptedRanges.push(range);
    cursor = range.end;
  }

  return acceptedRanges;
}

function findFrontmatterEnd(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i += 1) {
    const stripped = stripLineEnding(lines[i]).trim();
    if (stripped === "---" || stripped === "...") {
      return i + 1;
    }
  }
  return -1;
}

function findFenceEnd(lines: string[], start: number, fenceChar: string, fenceLength: number): number {
  const closeFence = new RegExp(`^ {0,3}${escapeRegExp(fenceChar)}{${fenceLength},}\\s*$`);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (closeFence.test(stripLineEnding(lines[i]))) {
      return i + 1;
    }
  }
  return lines.length;
}

function findMathBlockEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i += 1) {
    if (stripLineEnding(lines[i]).trim() === "$$") {
      return i + 1;
    }
  }
  return lines.length;
}

function findHtmlCommentEnd(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].includes("-->")) {
      return i + 1;
    }
  }
  return lines.length;
}

function findHtmlBlockEnd(lines: string[], start: number): number {
  const tagMatch = lines[start].match(/^ {0,3}<([a-z0-9-]+)/i);
  if (!tagMatch) {
    return start + 1;
  }

  const closingTag = new RegExp(`</${escapeRegExp(tagMatch[1])}>`, "i");
  for (let i = start; i < lines.length; i += 1) {
    if (closingTag.test(lines[i])) {
      return i + 1;
    }
  }
  return start + 1;
}

function stripLineEnding(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function splitLinesKeepEndings(text: string): string[] {
  if (!text) {
    return [""];
  }

  const lines = text.match(/[^\r\n]*(?:\r?\n|$)/g) ?? [text];
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
