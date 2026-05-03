import { Compressor, CompressionResult } from './types.js';
import { Tokenizer } from '../tokenizer/tiktoken.js';
import type { CcrStore } from '../ccr/types.js';

export enum LogFormat {
  PYTEST = 'pytest',
  NPM = 'npm',
  CARGO = 'cargo',
  MAKE = 'make',
  JEST = 'jest',
  GENERIC = 'generic',
}

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  FAIL = 'fail',
}

export interface LogCompressorConfig {
  maxLines: number;
  maxTotalLines?: number;
  maxErrors?: number;
  contextWindow: number;
  minLinesForCompression: number;
  deduplicateThreshold: number;
}

const DEFAULT_CONFIG: LogCompressorConfig = {
  maxLines: 200,
  contextWindow: 3,
  minLinesForCompression: 5,
  deduplicateThreshold: 3,
};

const CCR_RATIO_THRESHOLD = 0.6;

const ERROR_PATTERN = /\b(error|exception|traceback|fatal|critical|panic)\b/i;
const WARN_PATTERN = /\bwarn(?:ing)?\b/i;
const STACK_TRACE_PATTERN = /^(\s+at\s|\s*File\s"|\s+\^)/;
const STRUCTURAL_COLON_PATTERN = /:\s*$/;
const TIMESTAMP_PATTERN = /\d{2}:\d{2}/;
const LOG_LEVEL_PATTERN = /\[(INFO|ERROR|DEBUG|WARN)\]/;

function isStackTraceStart(line: string): boolean {
  return /^Traceback \(most recent call last\)/i.test(line) ||
    /^[ ]{2}File ".*", line \d+/i.test(line);
}

function isStackTraceContinuation(line: string): boolean {
  return /^\s{2,}/.test(line) ||
    /^[ ]{2}File ".*", line \d+/.test(line) ||
    /^[A-Z][a-zA-Z]*Error:/.test(line) ||
    /^During handling of the above/.test(line) ||
    line.trim() === '';
}

function scoreLine(line: string, index: number, totalLines: number): number {
  let score = 0.0;

  if (ERROR_PATTERN.test(line)) {
    score += 0.4;
  }

  if (WARN_PATTERN.test(line)) {
    score += 0.2;
  }

  if (STACK_TRACE_PATTERN.test(line)) {
    score += 0.1;
  }

  if (
    STRUCTURAL_COLON_PATTERN.test(line) ||
    TIMESTAMP_PATTERN.test(line) ||
    LOG_LEVEL_PATTERN.test(line)
  ) {
    score += 0.15;
  }

  const numericMatches = [...line.matchAll(/\d+(?:\.\d+)?/g)];
  if (numericMatches.length >= 3) {
    score += 0.1;
  }

  const positionalBoundary = 5;
  if (index < positionalBoundary || index >= totalLines - positionalBoundary) {
    score += 0.2;
  }

  return Math.min(1.0, score);
}

function normalizeForDedupe(line: string): string {
  const colonIdx = line.indexOf(':');
  const eqIdx = line.indexOf('=');
  const splitIdx = Math.min(
    colonIdx >= 0 ? colonIdx : Infinity,
    eqIdx >= 0 ? eqIdx : Infinity,
  );
  if (!isFinite(splitIdx)) return line;
  const prefix = line.slice(0, splitIdx);
  const suffix = line.slice(splitIdx).replace(/\b\d+\.\d+\.\d+\.\d+\b|\b\d{5,}\b/g, 'N');
  return prefix + suffix;
}

function deduplicateLines(
  lines: string[],
  threshold: number,
): string[] {
  const normCounts = new Map<string, number>();
  for (const line of lines) {
    const key = normalizeForDedupe(line);
    normCounts.set(key, (normCounts.get(key) ?? 0) + 1);
  }

  const result: string[] = [];
  const normSeen = new Map<string, number>();

  for (const line of lines) {
    const key = normalizeForDedupe(line);
    const total = normCounts.get(key) ?? 1;
    if (total <= threshold) {
      result.push(line);
      continue;
    }

    const seenCount = normSeen.get(key) ?? 0;
    if (seenCount < threshold) {
      result.push(line);
      normSeen.set(key, seenCount + 1);
    } else if (seenCount === threshold) {
      const remaining = total - threshold;
      result.push(`[... repeated ${remaining} more times]`);
      normSeen.set(key, seenCount + 1);
    }
  }

  return result;
}

function selectKeptIndices(
  lines: string[],
  contextWindow: number,
  maxLines: number,
): Set<number> {
  const total = lines.length;
  const scores = lines.map((line, i) => scoreLine(line, i, total));

  const importanceThreshold = 0.3;
  const important = new Set<number>();

  for (let i = 0; i < total; i++) {
    if (scores[i] >= importanceThreshold || /^\[... repeated \d+ more times\]$/.test(lines[i])) {
      important.add(i);
    }
  }

  // Stack-trace pass: mark all lines inside tracebacks as important
  let inStackTrace = false;
  for (let i = 0; i < total; i++) {
    if (isStackTraceStart(lines[i])) {
      inStackTrace = true;
    }
    if (inStackTrace) {
      important.add(i);
      if (!isStackTraceContinuation(lines[i]) && !isStackTraceStart(lines[i])) {
        inStackTrace = false;
      }
    }
  }

  const kept = new Set<number>();

  for (const idx of important) {
    const start = Math.max(0, idx - contextWindow);
    const end = Math.min(total - 1, idx + contextWindow);
    for (let i = start; i <= end; i++) {
      kept.add(i);
    }
  }

  const frameSize = 3;
  for (let i = 0; i < Math.min(frameSize, total); i++) {
    kept.add(i);
  }
  for (let i = Math.max(0, total - frameSize); i < total; i++) {
    kept.add(i);
  }

  if (kept.size <= maxLines) {
    return kept;
  }

  const sortedIndices = Array.from(kept).sort((a, b) => a - b);
  const headLines = new Set(sortedIndices.slice(0, frameSize));
  const tailLines = new Set(sortedIndices.slice(-frameSize));
  const frameLines = new Set([...headLines, ...tailLines]);

  const middleSlots = maxLines - frameLines.size;
  if (middleSlots <= 0) {
    return frameLines;
  }

  // fill middle slots with highest-scored non-frame lines
  const middleCandidates = sortedIndices
    .filter(i => !frameLines.has(i))
    .sort((a, b) => scores[b] - scores[a]);  // sort by descending score

  const selected = new Set(frameLines);
  for (let i = 0; i < Math.min(middleSlots, middleCandidates.length); i++) {
    selected.add(middleCandidates[i]);
  }
  return selected;
}

function reassemble(lines: string[], keptIndices: Set<number>): string {
  const sorted = Array.from(keptIndices).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return '';
  }

  const parts: string[] = [];
  let prev = -1;

  for (const idx of sorted) {
    if (prev === -1) {
      if (idx > 0) {
        parts.push(`[... ${idx} lines omitted ...]`);
      }
    } else if (idx > prev + 1) {
      const gap = idx - prev - 1;
      parts.push(`[... ${gap} lines omitted ...]`);
    }
    parts.push(lines[idx]);
    prev = idx;
  }

  const lastKept = sorted[sorted.length - 1];
  if (lastKept < lines.length - 1) {
    const trailing = lines.length - 1 - lastKept;
    parts.push(`[... ${trailing} lines omitted ...]`);
  }

  return parts.join('\n');
}

export class LogCompressor implements Compressor {
  constructor(
    private tokenizer: Tokenizer,
    private config: LogCompressorConfig = DEFAULT_CONFIG,
    private store?: CcrStore,
  ) {}

  async compress(content: string, _contextHint?: string): Promise<CompressionResult> {
    const originalTokens = await this.tokenizer.countText(content);

    const lines = content.split(/\r?\n/);
    if (lines.length < this.config.minLinesForCompression) {
      return {
        compressed: content,
        originalTokens,
        compressedTokens: originalTokens,
        compressionRatio: 1.0,
      };
    }

    const deduplicated = deduplicateLines(lines, this.config.deduplicateThreshold);
    const keptIndices = selectKeptIndices(deduplicated, this.config.contextWindow, this.config.maxLines);
    const compressed = reassemble(deduplicated, keptIndices);

    const compressedTokens = await this.tokenizer.countText(compressed);

    if (compressedTokens >= originalTokens) {
      return {
        compressed: content,
        originalTokens,
        compressedTokens: originalTokens,
        compressionRatio: 1.0,
      };
    }

    const compressionRatio = originalTokens > 0 ? compressedTokens / originalTokens : 1.0;
    let cacheKey: string | undefined;
    let finalCompressed = compressed;
    if (this.store && compressionRatio < CCR_RATIO_THRESHOLD) {
      cacheKey = this.store.store(content, compressed, {
        originalTokens,
        compressedTokens,
        compressionStrategy: 'log',
      });
      const saved = originalTokens - compressedTokens;
      finalCompressed = `[COMPRESSED id=${cacheKey} tokens_saved=${saved} type=log]\n${compressed}`;
    }
    return { compressed: finalCompressed, originalTokens, compressedTokens, compressionRatio, cacheKey };
  }
}

export function createLogCompressor(tokenizer: Tokenizer, config?: Partial<LogCompressorConfig>, store?: CcrStore): LogCompressor {
  const merged = { ...DEFAULT_CONFIG, ...config };
  if (config?.maxTotalLines !== undefined) {
    merged.maxLines = config.maxTotalLines;
  }
  return new LogCompressor(tokenizer, merged, store);
}
