import { createHash } from 'node:crypto';
import type { ICMMessage } from './icm.js';
import { logger } from '../../../../../../../utils/logger.js';

export interface CacheAlignerConfig {
  enabled: boolean;
  dynamicPatterns: RegExp[];
  dynamicLabels: string[];
  placeholder: string;
  normalizeWhitespace: boolean;
  collapseBlankLines: boolean;
  dynamicTailSeparator: string;
}

const DEFAULT_DYNAMIC_PATTERNS: RegExp[] = [
  // ISO 8601 datetime (must come before plain date)
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
  // ISO 8601 date
  /\d{4}-\d{2}-\d{2}/g,
  // UUID
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  // Unix timestamp (standalone 10-digit number starting with 1)
  /\b1[0-9]{9}\b/g,
  // Hex hashes (40+ chars)
  /\b[0-9a-f]{40,}\b/gi,
  // Version strings
  /\bv?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/g,
  // Request ID: req_/sk-/pk- prefixed alphanumeric
  /\b(?:req|sk|pk|tok|sess|sid|uid|cid|rid)_[A-Za-z0-9_-]{6,}/g,
  // JWT (three base64url segments)
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

const DEFAULT_DYNAMIC_LABELS: string[] = [
  'date', 'time', 'timestamp', 'datetime', 'created', 'updated',
  'modified', 'expires', 'last', 'session', 'session_id', 'user_id',
  'request_id', 'trace_id', 'correlation_id', 'authorization',
];

const DEFAULT_CONFIG: CacheAlignerConfig = {
  enabled: false,
  dynamicPatterns: DEFAULT_DYNAMIC_PATTERNS,
  dynamicLabels: DEFAULT_DYNAMIC_LABELS,
  placeholder: '<dynamic>',
  normalizeWhitespace: true,
  collapseBlankLines: true,
  dynamicTailSeparator: '\n\n---\n[Dynamic Context]\n',
};

function computeShortHash(data: string, length = 16): string {
  return createHash('sha256').update(data, 'utf8').digest('hex').slice(0, length);
}

export interface CacheAlignResult {
  messages: ICMMessage[];
  stablePrefixHash: string;
  dynamicExtracted: string[];
}

export class CacheAligner {
  private readonly config: CacheAlignerConfig;
  private previousPrefixHash: string | null = null;

  constructor(config?: Partial<CacheAlignerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  align(messages: ICMMessage[]): CacheAlignResult {
    const result: ICMMessage[] = messages.map(m => ({ ...m }));

    if (!this.config.enabled) {
      const stablePrefixHash = this.computeStablePrefixHash(result);
      return { messages: result, stablePrefixHash, dynamicExtracted: [] };
    }

    const extractedDynamic: string[] = [];

    for (const msg of result) {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        const { cleaned, extracted } = this.extractDynamic(msg.content);
        if (extracted.length > 0) {
          msg.content = cleaned;
          extractedDynamic.push(...extracted);
        }
      }
    }

    if (this.config.normalizeWhitespace) {
      for (const msg of result) {
        if (typeof msg.content === 'string') {
          msg.content = this.normalizeWhitespace(msg.content);
        }
      }
    }

    const stablePrefixContent = this.getStablePrefixContent(result);
    const stablePrefixHash = computeShortHash(stablePrefixContent);

    const prefixChanged =
      this.previousPrefixHash !== null && this.previousPrefixHash !== stablePrefixHash;
    if (prefixChanged) {
      logger.debug('CacheAligner: prefix changed, hash: %s -> %s', this.previousPrefixHash, stablePrefixHash);
    } else {
      logger.debug('CacheAligner: prefix stable, hash: %s', stablePrefixHash);
    }
    this.previousPrefixHash = stablePrefixHash;

    if (extractedDynamic.length > 0) {
      this.reinsertDynamic(result, extractedDynamic);
    }

    return { messages: result, stablePrefixHash, dynamicExtracted: extractedDynamic };
  }

  private extractDynamic(content: string): { cleaned: string; extracted: string[] } {
    const extracted: string[] = [];
    let cleaned = content;

    for (const pattern of this.config.dynamicPatterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      const gPattern = new RegExp(pattern.source, flags);
      cleaned = cleaned.replace(gPattern, match => {
        extracted.push(match);
        return this.config.placeholder;
      });
    }

    // Structural label=value detection
    for (const label of this.config.dynamicLabels) {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const labelPattern = new RegExp(`(^|\\s)(${escapedLabel})[:\\s=]\\s*(\\S+)`, 'gim');
      cleaned = cleaned.replace(labelPattern, (match, prefix, lbl, value) => {
        // Skip if value is already a placeholder
        if (value === this.config.placeholder) return match;
        extracted.push(value);
        return `${prefix}${lbl}: ${this.config.placeholder}`;
      });
    }

    if (extracted.length > 0) {
      cleaned = this.cleanupEmptyLines(cleaned);
    }

    return { cleaned, extracted };
  }

  private normalizeWhitespace(content: string): string {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n').map(l => l.trimEnd());

    if (this.config.collapseBlankLines) {
      const collapsed: string[] = [];
      let prevBlank = false;
      for (const line of lines) {
        const isBlank = line.trim().length === 0;
        if (isBlank && prevBlank) continue;
        collapsed.push(line);
        prevBlank = isBlank;
      }
      return collapsed.join('\n');
    }

    return lines.join('\n');
  }

  private cleanupEmptyLines(content: string): string {
    const lines = content.split('\n');
    const collapsed: string[] = [];
    let prevEmpty = false;
    for (const line of lines) {
      const isEmpty = line.trim().length === 0;
      if (isEmpty && prevEmpty) continue;
      collapsed.push(line);
      prevEmpty = isEmpty;
    }
    return collapsed.join('\n').trim();
  }

  private reinsertDynamic(messages: ICMMessage[], dynamic: string[]): void {
    const note = `[${dynamic.length} dynamic value(s) extracted]`;

    const separator = this.config.dynamicTailSeparator;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'system' && typeof msg.content === 'string') {
        msg.content = msg.content.trim() + separator + note;
        break;
      }
    }
  }

  private getStablePrefixContent(messages: ICMMessage[]): string {
    const parts: string[] = [];
    const sep = this.config.dynamicTailSeparator;

    for (const msg of messages) {
      if (msg.role !== 'system') break;
      if (typeof msg.content === 'string') {
        let content = msg.content;
        if (content.includes(sep)) {
          content = content.split(sep)[0];
        }
        parts.push(content.trim());
      }
    }

    return parts.join('\n---\n');
  }

  private computeStablePrefixHash(messages: ICMMessage[]): string {
    const content = this.getStablePrefixContent(messages);
    return computeShortHash(content);
  }
}

export function createCacheAligner(config?: Partial<CacheAlignerConfig>): CacheAligner {
  return new CacheAligner(config);
}
