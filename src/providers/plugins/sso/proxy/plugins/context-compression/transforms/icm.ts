import { Tokenizer } from '../tokenizer/tiktoken.js';
import { ContentRouter } from './content-router.js';
import { CompressionResult } from '../compressors/types.js';
import { CompressConfig, DEFAULT_COMPRESS_CONFIG } from './config.js';
import { CompressionHooks, CompressionContext, CompressionEvent } from './hooks.js';

export interface ICMMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ICMResult {
  messages: ICMMessage[];
  cacheKeys: string[];
}

export interface ICMConfig {
  contextLimit: number;
  frozenRoles: string[];
  tailSize: number;
}

const DEFAULT_CONFIG: ICMConfig = {
  contextLimit: 100_000,
  frozenRoles: ['system'],
  tailSize: 10,
};

function extractText(content: ICMMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(block => block.type === 'text' && block.text !== undefined)
    .map(block => block.text as string)
    .join('');
}

function replaceText(original: ICMMessage['content'], compressed: string): ICMMessage['content'] {
  if (typeof original === 'string') {
    return compressed;
  }
  let remaining = compressed;
  return original.map(block => {
    if (block.type !== 'text' || block.text === undefined) {
      return block;
    }
    const replaced = { ...block, text: remaining };
    remaining = '';
    return replaced;
  });
}

async function compressMessage(
  message: ICMMessage,
  router: ContentRouter,
): Promise<{ message: ICMMessage; result: CompressionResult } | null> {
  const text = extractText(message.content);
  if (!text) return null;

  const result = await router.route(text, message.role);
  if (result.compressionRatio >= 1.0) return null;

  return {
    message: { ...message, content: replaceText(message.content, result.compressed) },
    result,
  };
}

function buildFrozenRoles(cfg: CompressConfig): Set<string> {
  const frozen = new Set<string>();
  if (!cfg.compressSystemMessages) frozen.add('system');
  if (!cfg.compressUserMessages) frozen.add('user');
  if (cfg.protectAnalysisContext) frozen.add('tool');
  return frozen;
}

/**
 * Strategy enum for future caller-controlled phase selection.
 * Currently Phase 3 always uses DROP_BY_SCORE. This enum is exported
 * to allow callers to express intent without breaking changes when
 * the strategy parameter is added to `apply()`.
 */
export enum ContextStrategy {
  NONE = 'none',
  COMPRESS_FIRST = 'compress',
  DROP_BY_SCORE = 'drop_scored',
}

export interface MessageScore {
  index: number;
  total: number;
  recencyScore: number;
  errorScore: number;
}

export interface DropCandidate {
  indices: number[];
  score: number;
  position: number;
}

export function scoreMessage(
  msg: ICMMessage,
  index: number,
  total: number,
): MessageScore {
  const recencyScore = total > 1 ? index / (total - 1) : 1.0;
  const text = extractText(msg.content).toLowerCase();
  let errorScore = 0;
  const errorTerms = ['error', 'exception', 'fatal', 'traceback', 'fail', 'timeout', 'abort', 'denied', 'rejected'];
  for (const term of errorTerms) {
    if (text.includes(term)) { errorScore = 0.5; break; }
  }
  const total_ = Math.min(1.0, recencyScore * 0.7 + errorScore * 0.3);
  return { index, total: total_, recencyScore, errorScore };
}

export function buildDropCandidates(
  messages: ICMMessage[],
  protected_: Set<number>,
): DropCandidate[] {
  const candidates: DropCandidate[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (protected_.has(i)) continue;
    const score = scoreMessage(messages[i], i, messages.length);
    candidates.push({ indices: [i], score: score.total, position: i });
  }
  candidates.sort((a, b) => a.score - b.score || a.position - b.position);
  return candidates;
}

export class IntelligentContextManager {
  private readonly router: ContentRouter;
  private readonly tokenizer: Tokenizer;
  private readonly config: ICMConfig;

  constructor(router: ContentRouter, tokenizer: Tokenizer, config?: Partial<ICMConfig>) {
    this.router = router;
    this.tokenizer = tokenizer;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async apply(
    messages: ICMMessage[],
    contextLimit?: number,
    compressConfig?: CompressConfig,
    hooks?: CompressionHooks,
    requestId?: string,
  ): Promise<ICMResult> {
    const limit = contextLimit ?? this.config.contextLimit;
    const cfg = compressConfig ?? DEFAULT_COMPRESS_CONFIG;

    let current = [...messages];

    if (hooks?.preCompress) {
      const ctx: CompressionContext = { messages: current, config: cfg, requestId };
      current = await hooks.preCompress(ctx);
    }

    const cacheKeys: string[] = [];

    let currentTokens = await this.tokenizer.countMessages(current);
    const originalTokens = currentTokens;
    if (currentTokens <= cfg.minTokensToCompress) {
      return { messages: current, cacheKeys };
    }

    const frozenRoles = buildFrozenRoles(cfg);
    const isFrozen = (msg: ICMMessage): boolean => frozenRoles.has(msg.role);

    const mutableIndices = current
      .map((msg, idx) => ({ msg, idx }))
      .filter(({ msg }) => !isFrozen(msg))
      .map(({ idx }) => idx);

    const protectCount = cfg.protectRecent;
    const tailIndices = new Set(mutableIndices.slice(-protectCount));

    // Phase 1: compress tail messages (most recent) — only when already over context limit
    for (const idx of tailIndices) {
      if (currentTokens <= limit) break;
      const outcome = await compressMessage(current[idx], this.router);
      if (outcome !== null) {
        if (outcome.result.cacheKey) cacheKeys.push(outcome.result.cacheKey);
        const event: CompressionEvent = {
          messageIndex: idx,
          role: current[idx].role,
          originalTokens: outcome.result.originalTokens,
          compressedTokens: outcome.result.compressedTokens,
          compressionRatio: outcome.result.compressionRatio,
          cacheKey: outcome.result.cacheKey,
        };
        current[idx] = outcome.message;
        currentTokens = await this.tokenizer.countMessages(current);
        if (hooks?.postCompress) await hooks.postCompress(event);
        if (cfg.targetRatio !== null && currentTokens / originalTokens <= cfg.targetRatio) break;
      }
    }

    const nonTailMutableIndices = mutableIndices.filter(idx => !tailIndices.has(idx));

    // Phase 2: compress non-tail (older) messages — always runs when compression is enabled
    for (const idx of nonTailMutableIndices) {
      const outcome = await compressMessage(current[idx], this.router);
      if (outcome !== null) {
        if (outcome.result.cacheKey) cacheKeys.push(outcome.result.cacheKey);
        const event: CompressionEvent = {
          messageIndex: idx,
          role: current[idx].role,
          originalTokens: outcome.result.originalTokens,
          compressedTokens: outcome.result.compressedTokens,
          compressionRatio: outcome.result.compressionRatio,
          cacheKey: outcome.result.cacheKey,
        };
        current[idx] = outcome.message;
        currentTokens = await this.tokenizer.countMessages(current);
        if (hooks?.postCompress) await hooks.postCompress(event);
        if (cfg.targetRatio !== null && currentTokens / originalTokens <= cfg.targetRatio) break;
      }
    }

    currentTokens = await this.tokenizer.countMessages(current);
    if (currentTokens <= limit) {
      return { messages: current, cacheKeys };
    }

    // Phase 3: drop messages by score (lowest first)
    const protected_ = new Set<number>();
    current.forEach((msg, idx) => {
      if (isFrozen(msg)) protected_.add(idx);
    });
    // Protect tail
    for (const idx of tailIndices) protected_.add(idx);

    const dropCandidates = buildDropCandidates(current, protected_);
    let biasedCandidates = dropCandidates;
    if (hooks?.computeBiases) {
      const biases = await hooks.computeBiases(current);
      biasedCandidates = [...dropCandidates].sort(
        (a, b) => (biases[a.indices[0]] ?? a.score) - (biases[b.indices[0]] ?? b.score),
      );
    }
    for (const candidate of biasedCandidates) {
      if (currentTokens <= limit) break;
      const snapshots = candidate.indices.map(i => current[i]);
      current = current.filter(m => !snapshots.includes(m));
      currentTokens = await this.tokenizer.countMessages(current);
    }

    return { messages: current, cacheKeys };
  }
}

export function createICM(
  router: ContentRouter,
  tokenizer: Tokenizer,
  config?: Partial<ICMConfig>,
): IntelligentContextManager {
  return new IntelligentContextManager(router, tokenizer, config);
}
