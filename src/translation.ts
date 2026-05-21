export interface MarkdownSegment {
  kind: "protected" | "translatable";
  content: string;
  sourceEndLine: number;
  sourceStartLine: number;
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
  parts: TranslationOutputPart[];
  totalParts: number;
  totalRequests: number;
}

export interface TranslationOutputPart {
  id: number;
  markdown: string;
  sourceEndLine: number;
  sourceStartLine: number;
}

export interface InlineProtectionResult {
  text: string;
  tokens: Map<string, string>;
}

interface TranslationPlanPart {
  kind: "passthrough" | "translatable";
  batchable: boolean;
  content: string;
  sourceEndLine: number;
  sourceStartLine: number;
  tokens?: Map<string, string>;
}

interface TranslationPlanBatch {
  kind: "passthrough" | "translatable";
  parts: TranslationPlanPart[];
}

interface TranslatedBatch {
  markdownByPart: string[];
  requestCount: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 6000;
const INLINE_KEEP_PREFIX = "__TRANSLATE_MD_KEEP_";
const WRAPPED_BLOCK_TAG = "translate-md-block";

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
  const batches = createTranslationBatches(parts, maxChunkChars);
  let totalRequests = batches.filter((batch) => batch.kind === "translatable").length;
  const output: string[] = [];
  const outputParts: TranslationOutputPart[] = [];
  let completedParts = 0;
  let completedRequests = 0;

  for (const batch of batches) {
    const translatedBatch = batch.kind === "translatable"
      ? await translateBatch(batch.parts, options)
      : {
          markdownByPart: batch.parts.map((part) => part.content),
          requestCount: 0
        };

    if (translatedBatch.requestCount > 1) {
      totalRequests += translatedBatch.requestCount - 1;
    }
    completedRequests += translatedBatch.requestCount;

    for (let index = 0; index < batch.parts.length; index += 1) {
      const part = batch.parts[index];
      const translatedMarkdown = translatedBatch.markdownByPart[index] ?? part.content;
      output.push(translatedMarkdown);
      outputParts.push({
        id: outputParts.length,
        markdown: translatedMarkdown,
        sourceEndLine: part.sourceEndLine,
        sourceStartLine: part.sourceStartLine
      });
    }
    completedParts += batch.parts.length;
    await options.onProgress?.({
      completedParts,
      completedRequests,
      markdown: output.join(""),
      parts: [...outputParts],
      totalParts: parts.length,
      totalRequests
    });
  }

  return output.join("");
}

async function translateBatch(
  parts: TranslationPlanPart[],
  options: TranslateMarkdownOptions
): Promise<TranslatedBatch> {
  const translatableParts = parts.filter((part) => part.kind === "translatable");
  if (translatableParts.length === 0) {
    return {
      markdownByPart: parts.map((part) => part.content),
      requestCount: 0
    };
  }

  const translatedTranslatableBatch = await translateTranslatableParts(
    translatableParts,
    options
  );

  const markdownByPart: string[] = [];
  let translatableIndex = 0;
  for (const part of parts) {
    if (part.kind === "translatable") {
      markdownByPart.push(
        translatedTranslatableBatch.markdownByPart[translatableIndex] ?? part.content
      );
      translatableIndex += 1;
    } else {
      markdownByPart.push(part.content);
    }
  }

  return {
    markdownByPart,
    requestCount: translatedTranslatableBatch.requestCount
  };
}

async function translateTranslatableParts(
  parts: TranslationPlanPart[],
  options: TranslateMarkdownOptions
): Promise<TranslatedBatch> {
  if (parts.length === 1) {
    const part = parts[0];
    const translatedChunk = await options.translateChunk(part.content, options.targetLanguage);
    return {
      markdownByPart: [
        restoreInlineMarkdown(translatedChunk, part.tokens ?? new Map())
      ],
      requestCount: 1
    };
  }

  try {
    const translatedChunk = await options.translateChunk(
      wrapBatchForTranslation(parts),
      options.targetLanguage
    );
    const parsedParts = parseWrappedBatchTranslation(translatedChunk, parts);
    if (parsedParts) {
      return {
        markdownByPart: parsedParts,
        requestCount: 1
      };
    }
  } catch (error) {
    if (!isRecoverableBatchError(error)) {
      throw error;
    }
  }

  const midpoint = Math.ceil(parts.length / 2);
  const leftBatch = await translateTranslatableParts(parts.slice(0, midpoint), options);
  const rightBatch = await translateTranslatableParts(parts.slice(midpoint), options);
  return {
    markdownByPart: [...leftBatch.markdownByPart, ...rightBatch.markdownByPart],
    requestCount: 1 + leftBatch.requestCount + rightBatch.requestCount
  };
}

function createTranslationPlan(markdown: string, maxChunkChars: number): TranslationPlanPart[] {
  const segments = splitMarkdownSegments(markdown);
  const parts: TranslationPlanPart[] = [];

  for (const segment of segments) {
    if (segment.kind === "protected" || !hasLetters(segment.content)) {
      parts.push({
        kind: "passthrough",
        batchable: segment.kind !== "protected",
        content: segment.content,
        sourceEndLine: segment.sourceEndLine,
        sourceStartLine: segment.sourceStartLine
      });
      continue;
    }

    let chunkStartLine = segment.sourceStartLine;
    for (const chunk of splitTextForTranslation(segment.content, maxChunkChars)) {
      const chunkEndLine = chunkStartLine + countLineBreaks(chunk);
      if (!hasLetters(chunk)) {
        parts.push({
          kind: "passthrough",
          batchable: true,
          content: chunk,
          sourceEndLine: chunkEndLine,
          sourceStartLine: chunkStartLine
        });
        chunkStartLine = chunkEndLine;
        continue;
      }

      const protectedChunk = protectInlineMarkdown(chunk);
      parts.push({
        kind: "translatable",
        batchable: true,
        content: protectedChunk.text,
        sourceEndLine: chunkEndLine,
        sourceStartLine: chunkStartLine,
        tokens: protectedChunk.tokens
      });
      chunkStartLine = chunkEndLine;
    }
  }

  return parts;
}

function createTranslationBatches(
  parts: TranslationPlanPart[],
  maxChunkChars: number
): TranslationPlanBatch[] {
  const batches: TranslationPlanBatch[] = [];
  let currentParts: TranslationPlanPart[] = [];

  const flushCurrentParts = () => {
    if (currentParts.length === 0) {
      return;
    }
    batches.push({
      kind: currentParts.some((part) => part.kind === "translatable")
        ? "translatable"
        : "passthrough",
      parts: currentParts
    });
    currentParts = [];
  };

  for (const part of parts) {
    if (!part.batchable) {
      flushCurrentParts();
      batches.push({
        kind: "passthrough",
        parts: [part]
      });
      continue;
    }

    const nextParts = [...currentParts, part];
    if (
      part.kind === "translatable" &&
      currentParts.some((currentPart) => currentPart.kind === "translatable") &&
      getBatchRequestLength(nextParts) > maxChunkChars
    ) {
      flushCurrentParts();
    }
    currentParts.push(part);
  }

  flushCurrentParts();
  return batches;
}

export function splitMarkdownSegments(markdown: string): MarkdownSegment[] {
  const lines = splitLinesKeepEndings(markdown);
  const segments: MarkdownSegment[] = [];
  let translatableBuffer: string[] = [];
  let translatableStartLine = 0;
  let index = 0;

  const flushTranslatable = () => {
    if (translatableBuffer.length > 0) {
      segments.push({
        kind: "translatable",
        content: translatableBuffer.join(""),
        sourceEndLine: index,
        sourceStartLine: translatableStartLine
      });
      translatableBuffer = [];
    }
  };

  const pushProtected = (endExclusive: number) => {
    flushTranslatable();
    segments.push({
      kind: "protected",
      content: lines.slice(index, endExclusive).join(""),
      sourceEndLine: endExclusive,
      sourceStartLine: index
    });
    index = endExclusive;
    translatableStartLine = index;
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

    if (translatableBuffer.length === 0) {
      translatableStartLine = index;
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
  const chunks: string[] = [];
  let currentBlock = "";

  const flushCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    chunks.push(...splitOversizedText(currentBlock, maxChunkChars));
    currentBlock = "";
  };

  for (const line of splitLinesKeepEndings(text)) {
    if (isBlankLine(line)) {
      flushCurrentBlock();
      chunks.push(line);
    } else {
      currentBlock += line;
    }
  }

  flushCurrentBlock();

  return chunks;
}

function wrapBatchForTranslation(parts: TranslationPlanPart[]): string {
  return parts
    .map((part, index) => {
      const closingPrefix = part.content.endsWith("\n") ? "" : "\n";
      return `<${WRAPPED_BLOCK_TAG} id="${index}">\n${part.content}${closingPrefix}</${WRAPPED_BLOCK_TAG}>`;
    })
    .join("\n");
}

function parseWrappedBatchTranslation(
  markdown: string,
  originalParts: TranslationPlanPart[]
): string[] | null {
  const translatedParts = new Array<string>(originalParts.length);
  const blockPattern = new RegExp(
    `<${WRAPPED_BLOCK_TAG}\\s+id=["'](\\d+)["']\\s*>([\\s\\S]*?)<\\/${WRAPPED_BLOCK_TAG}>`,
    "gi"
  );

  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(markdown)) !== null) {
    const index = Number.parseInt(match[1], 10);
    if (!Number.isInteger(index) || index < 0 || index >= originalParts.length) {
      continue;
    }

    let translatedMarkdown = match[2].replace(/^\r?\n/, "");
    if (!originalParts[index].content.endsWith("\n")) {
      translatedMarkdown = translatedMarkdown.replace(/\r?\n$/, "");
    }
    translatedParts[index] = restoreInlineMarkdown(
      translatedMarkdown,
      originalParts[index].tokens ?? new Map()
    );
  }

  for (let index = 0; index < originalParts.length; index += 1) {
    if (typeof translatedParts[index] !== "string") {
      return null;
    }
  }
  return translatedParts;
}

function getBatchRequestLength(parts: TranslationPlanPart[]): number {
  const translatableParts = parts.filter((part) => part.kind === "translatable");
  if (translatableParts.length <= 1) {
    return translatableParts[0]?.content.length ?? 0;
  }

  return wrapBatchForTranslation(translatableParts).length;
}

function isRecoverableBatchError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "EmptyApiContentError" ||
      /空响应|没有可用内容|empty/i.test(error.message));
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

function isBlankLine(line: string): boolean {
  return stripLineEnding(line).trim() === "";
}

function countLineBreaks(text: string): number {
  return (text.match(/\n/g) ?? []).length;
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
