import { Compressor, CompressionResult } from '../types.js';
import { Tokenizer } from '../../tokenizer/tiktoken.js';
import { TagProtector } from '../tag-protector.js';
import { selectAnchors } from '../anchor-selector.js';
import { truncateToBudget } from '../adaptive-sizer.js';

export interface SmartCrusherConfig {
  targetRatio: number;
  minLinesForCompression: number;
  preserveTags: boolean;
  anchorBias: number;
}

const DEFAULT_CONFIG: SmartCrusherConfig = {
  targetRatio: 0.5,
  minLinesForCompression: 30,
  preserveTags: false,
  anchorBias: 1.5,
};

function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') {
    return false;
  }
  return true;
}

function compressJsonObject(obj: Record<string, unknown>): string[] {
  const lines: string[] = ['{'];
  for (const [key, value] of Object.entries(obj)) {
    if (!isMeaningfulValue(value)) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`  "${key}": [${value.length} items]`);
    } else if (typeof value === 'object') {
      lines.push(`  "${key}": {...}`);
    } else {
      lines.push(`  "${key}": ${JSON.stringify(value)}`);
    }
  }
  lines.push('}');
  return lines;
}

function compressJsonArray(arr: unknown[]): string[] {
  if (arr.length === 0) return ['[]'];

  const maxEdgeItems = 3;
  const lines: string[] = ['['];

  const head = arr.slice(0, Math.min(maxEdgeItems, arr.length));
  // Show tail only if array is large enough to benefit from elision
  const tail = arr.length > maxEdgeItems * 2 ? arr.slice(-maxEdgeItems) : [];
  const middleCount = arr.length - head.length - tail.length;

  for (const item of head) {
    lines.push('  ' + JSON.stringify(item));
  }

  if (middleCount > 0) {
    lines.push(`  [${middleCount} more items...]`);
  }

  for (const item of tail) {
    lines.push('  ' + JSON.stringify(item));
  }

  lines.push(']');
  return lines;
}

const JSON_ARRAY_MIN_ITEMS = 10;

export function extractJsonSchema(items: Record<string, unknown>[]): string {
  if (items.length === 0) return '';
  const keys = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item)) keys.add(key);
  }
  return [...keys].join(', ');
}

export function compactDocumentJson(json: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length < JSON_ARRAY_MIN_ITEMS) return null;

  const items = parsed as Record<string, unknown>[];
  const schema = extractJsonSchema(items);
  if (!schema) return null;

  const lines = [`[Schema: {${schema}}]`, `[${items.length} items]`];
  for (let i = 0; i < Math.min(3, items.length); i++) {
    lines.push(JSON.stringify(items[i]));
  }
  if (items.length > 3) {
    lines.push(`... ${items.length - 3} more items`);
  }
  return lines.join('\n');
}

function tryCompressJson(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    return compressJsonArray(parsed).join('\n');
  }

  if (parsed !== null && typeof parsed === 'object') {
    return compressJsonObject(parsed as Record<string, unknown>).join('\n');
  }

  // Primitive JSON values (string, number, boolean) are not compressible this way
  return null;
}

export class SmartCrusher implements Compressor {
  constructor(
    private tokenizer: Tokenizer,
    private config: SmartCrusherConfig = DEFAULT_CONFIG,
  ) {}

  async compress(content: string, _contextHint?: string): Promise<CompressionResult> {
    const originalTokens = await this.tokenizer.countText(content);

    const lines = content.split(/\r?\n/);
    if (lines.length < this.config.minLinesForCompression) {
      return { compressed: content, originalTokens, compressedTokens: originalTokens, compressionRatio: 1.0 };
    }

    // Try JSON array schema factoring first
    const trimmed = content.trim();
    if (trimmed.startsWith('[')) {
      const compact = compactDocumentJson(trimmed);
      if (compact !== null) {
        const compactTokens = await this.tokenizer.countText(compact);
        const compactRatio = originalTokens > 0 ? compactTokens / originalTokens : 1.0;
        if (compactRatio < 1.0) {
          return { compressed: compact, originalTokens, compressedTokens: compactTokens, compressionRatio: compactRatio };
        }
      }
    }

    const protector = this.config.preserveTags ? new TagProtector() : null;
    const workingContent = protector ? protector.protect(content) : content;

    const jsonCompressed = tryCompressJson(workingContent.trim());
    let compressed: string;

    if (jsonCompressed !== null) {
      compressed = protector ? protector.restore(jsonCompressed) : jsonCompressed;
    } else {
      const workingLines = workingContent.split(/\r?\n/);
      const tokenBudget = Math.floor(originalTokens * this.config.targetRatio);
      const maxAnchors = Math.floor(workingLines.length * this.config.targetRatio);
      const anchorIndices = selectAnchors(workingLines, this.config.anchorBias, 1, maxAnchors);
      const anchorSet = new Set(anchorIndices);

      // Compute anchor token cost to subtract from total budget
      const anchorTokens = anchorIndices.reduce(
        (sum, i) => sum + Math.ceil((workingLines[i] ?? '').length / 4),
        0
      );
      const remainingBudget = Math.max(0, tokenBudget - anchorTokens);

      // Budget non-anchor lines (in document order)
      type IndexedLine = { idx: number; line: string };
      const nonAnchorLines: IndexedLine[] = workingLines
        .map((line, idx) => ({ idx, line }))
        .filter(({ idx }) => !anchorSet.has(idx));

      const budgetedNonAnchors = truncateToBudget(
        nonAnchorLines.map(({ line }) => line),
        remainingBudget,
        item => Math.ceil(item.length / 4),
      );

      // Reconstruct in original document order — use index set (not content set) to handle duplicate lines
      const budgetedNonAnchorIndices = new Set(
        nonAnchorLines.slice(0, budgetedNonAnchors.length).map(({ idx }) => idx),
      );
      const orderedLines: string[] = [];
      for (let i = 0; i < workingLines.length; i++) {
        if (anchorSet.has(i) || budgetedNonAnchorIndices.has(i)) {
          orderedLines.push(workingLines[i]);
        }
      }

      const restoredLines = protector ? protector.restore(orderedLines.join('\n')) : orderedLines.join('\n');
      compressed = restoredLines;
    }

    const compressedTokens = await this.tokenizer.countText(compressed);

    if (compressedTokens >= originalTokens) {
      return { compressed: content, originalTokens, compressedTokens: originalTokens, compressionRatio: 1.0 };
    }

    return {
      compressed,
      originalTokens,
      compressedTokens,
      compressionRatio: originalTokens > 0 ? compressedTokens / originalTokens : 1.0,
    };
  }
}

export function createSmartCrusher(tokenizer: Tokenizer, config?: Partial<SmartCrusherConfig>): SmartCrusher {
  return new SmartCrusher(tokenizer, { ...DEFAULT_CONFIG, ...config });
}
