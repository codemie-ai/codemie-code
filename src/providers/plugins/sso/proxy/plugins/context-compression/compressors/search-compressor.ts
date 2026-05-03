import { Compressor, CompressionResult } from './types.js';
import { Tokenizer } from '../tokenizer/tiktoken.js';
import type { CcrStore } from '../ccr/types.js';

export interface SearchCompressorConfig {
  maxResults: number;
  maxContextLinesPerResult: number;
  minLinesForCompression: number;
  groupByFile: boolean;
}

interface SearchResult {
  file?: string;
  lineNum?: number;
  content: string;
  contextLines: string[];
}

const DEFAULT_CONFIG: SearchCompressorConfig = {
  maxResults: 30,
  maxContextLinesPerResult: 2,
  minLinesForCompression: 20,
  groupByFile: true,
};

const CCR_RATIO_THRESHOLD = 0.6;

function parseGrepLine(line: string): { file?: string; lineNum?: number; content: string } | null {
  // filename:linenum:content
  const withLineNum = line.match(/^([^:]+):(\d+):(.*)$/);
  if (withLineNum) {
    return { file: withLineNum[1], lineNum: parseInt(withLineNum[2], 10), content: withLineNum[3] };
  }
  // filename:content
  const withFile = line.match(/^([^:]+):(.+)$/);
  if (withFile) {
    return { file: withFile[1], content: withFile[2] };
  }
  return null;
}

function isNumberedListEntry(line: string): boolean {
  return /^\d+[.)]\s+/.test(line.trim());
}

function isRipgrepFileHeader(line: string): boolean {
  return /^[^\s:]+\.[a-zA-Z0-9]{1,6}$/.test(line.trim());
}

function parseResults(lines: string[]): SearchResult[] {
  const results: SearchResult[] = [];

  let ripgrepCurrentFile: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    if (!stripped) continue;

    if (isRipgrepFileHeader(stripped)) {
      ripgrepCurrentFile = stripped;
      continue;
    }

    const grepParsed = parseGrepLine(stripped);
    if (grepParsed) {
      results.push({ ...grepParsed, contextLines: [] });
      ripgrepCurrentFile = undefined;
      continue;
    }

    if (ripgrepCurrentFile) {
      const lineNumMatch = stripped.match(/^(\d+)[:-]\s*(.*)$/);
      if (lineNumMatch) {
        results.push({
          file: ripgrepCurrentFile,
          lineNum: parseInt(lineNumMatch[1], 10),
          content: lineNumMatch[2],
          contextLines: [],
        });
        continue;
      }
    }

    if (isNumberedListEntry(stripped)) {
      const content = stripped.replace(/^\d+[.)]\s+/, '');
      results.push({ content, contextLines: [] });
      continue;
    }

    if (results.length > 0) {
      results[results.length - 1].contextLines.push(line);
    } else {
      results.push({ content: stripped, contextLines: [] });
    }
  }

  return results;
}

function scoreResult(result: SearchResult, index: number, total: number): number {
  let score = 0.0;

  if (index === 0 || index === total - 1) {
    score += 0.2;
  }

  if (result.file !== undefined) {
    score += 0.1;
  }

  if (/["'].*["']/.test(result.content)) {
    score += 0.3;
  }

  const low = result.content.toLowerCase();
  const relevanceKeywords = ['match', 'found', 'result', 'error', 'warning', 'todo', 'fixme'];
  for (const kw of relevanceKeywords) {
    if (low.includes(kw)) {
      score += 0.2;
      break;
    }
  }

  if (result.content.length < 80) {
    score += 0.1;
  }

  return Math.min(1.0, score);
}

function groupByFile(results: SearchResult[]): string[] {
  const fileMap = new Map<string, SearchResult[]>();
  const noFile: SearchResult[] = [];

  for (const r of results) {
    if (r.file !== undefined) {
      const existing = fileMap.get(r.file);
      if (existing) {
        existing.push(r);
      } else {
        fileMap.set(r.file, [r]);
      }
    } else {
      noFile.push(r);
    }
  }

  const parts: string[] = [];

  for (const [file, fileResults] of fileMap) {
    parts.push(`${file} (${fileResults.length} match${fileResults.length === 1 ? '' : 'es'}):`);
    for (const r of fileResults) {
      const linePrefix = r.lineNum !== undefined ? `  line ${r.lineNum}: ` : '  ';
      parts.push(`${linePrefix}${r.content}`);
      for (const ctx of r.contextLines) {
        parts.push(`    ${ctx}`);
      }
    }
  }

  for (const r of noFile) {
    parts.push(r.content);
    for (const ctx of r.contextLines) {
      parts.push(ctx);
    }
  }

  return parts;
}

function formatFlat(results: SearchResult[]): string[] {
  const parts: string[] = [];
  for (const r of results) {
    const filePrefix = r.file !== undefined
      ? r.lineNum !== undefined
        ? `${r.file}:${r.lineNum}: `
        : `${r.file}: `
      : '';
    parts.push(`${filePrefix}${r.content}`);
    for (const ctx of r.contextLines) {
      parts.push(ctx);
    }
  }
  return parts;
}

export class SearchCompressor implements Compressor {
  constructor(
    private tokenizer: Tokenizer,
    private config: SearchCompressorConfig = DEFAULT_CONFIG,
    private store?: CcrStore,
  ) {}

  async compress(content: string, _contextHint?: string): Promise<CompressionResult> {
    const originalTokens = await this.tokenizer.countText(content);

    const lines = content.split(/\r?\n/);
    if (lines.length < this.config.minLinesForCompression) {
      return { compressed: content, originalTokens, compressedTokens: originalTokens, compressionRatio: 1.0 };
    }

    const results = parseResults(lines);
    if (results.length === 0) {
      return { compressed: content, originalTokens, compressedTokens: originalTokens, compressionRatio: 1.0 };
    }

    const scored = results.map((r, i) => ({ result: r, score: scoreResult(r, i, results.length) }));
    scored.sort((a, b) => b.score - a.score);

    const omittedCount = Math.max(0, scored.length - this.config.maxResults);
    const kept = scored.slice(0, this.config.maxResults).map(({ result }) => result);

    for (const r of kept) {
      r.contextLines = r.contextLines.slice(0, this.config.maxContextLinesPerResult);
    }

    const outputLines = this.config.groupByFile ? groupByFile(kept) : formatFlat(kept);

    if (omittedCount > 0) {
      outputLines.push(`[${omittedCount} results omitted]`);
    }

    const compressed = outputLines.join('\n');
    const compressedTokens = await this.tokenizer.countText(compressed);

    if (compressedTokens >= originalTokens) {
      return { compressed: content, originalTokens, compressedTokens: originalTokens, compressionRatio: 1.0 };
    }

    const compressionRatio = originalTokens > 0 ? compressedTokens / originalTokens : 1.0;
    let cacheKey: string | undefined;
    let finalCompressed = compressed;
    if (this.store && compressionRatio < CCR_RATIO_THRESHOLD) {
      cacheKey = this.store.store(content, compressed, {
        originalTokens,
        compressedTokens,
        compressionStrategy: 'search',
      });
      const saved = originalTokens - compressedTokens;
      finalCompressed = `[COMPRESSED id=${cacheKey} tokens_saved=${saved} type=search]\n${compressed}`;
    }
    return { compressed: finalCompressed, originalTokens, compressedTokens, compressionRatio, cacheKey };
  }
}

export function createSearchCompressor(tokenizer: Tokenizer, config?: Partial<SearchCompressorConfig>, store?: CcrStore): SearchCompressor {
  return new SearchCompressor(tokenizer, { ...DEFAULT_CONFIG, ...config }, store);
}
