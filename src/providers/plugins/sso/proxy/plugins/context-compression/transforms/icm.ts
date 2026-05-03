import { Tokenizer } from '../tokenizer/tiktoken.js';
import { ContentRouter } from './content-router.js';
import { CompressionResult } from '../compressors/types.js';

export interface ICMMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
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

export class IntelligentContextManager {
  private readonly router: ContentRouter;
  private readonly tokenizer: Tokenizer;
  private readonly config: ICMConfig;

  constructor(router: ContentRouter, tokenizer: Tokenizer, config?: Partial<ICMConfig>) {
    this.router = router;
    this.tokenizer = tokenizer;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async apply(messages: ICMMessage[], contextLimit?: number): Promise<ICMMessage[]> {
    const limit = contextLimit ?? this.config.contextLimit;
    const { frozenRoles, tailSize } = this.config;

    let current = [...messages];
    let tokenCount = await this.tokenizer.countMessages(current);

    const isFrozen = (msg: ICMMessage): boolean => frozenRoles.includes(msg.role);

    const mutableIndices = current
      .map((msg, idx) => ({ msg, idx }))
      .filter(({ msg }) => !isFrozen(msg))
      .map(({ idx }) => idx);

    const tailIndices = new Set(mutableIndices.slice(-tailSize));

    // Phase 1: compress tail messages (most recent) — only when already over context limit
    for (const idx of tailIndices) {
      if (tokenCount <= limit) break;
      const outcome = await compressMessage(current[idx], this.router);
      if (outcome !== null) {
        current[idx] = outcome.message;
        tokenCount = await this.tokenizer.countMessages(current);
      }
    }

    const nonTailMutableIndices = mutableIndices.filter(idx => !tailIndices.has(idx));

    // Phase 2: compress non-tail (older) messages — always runs when tokenSavingMode is on
    for (const idx of nonTailMutableIndices) {
      const outcome = await compressMessage(current[idx], this.router);
      if (outcome !== null) {
        current[idx] = outcome.message;
        tokenCount = await this.tokenizer.countMessages(current);
      }
    }

    tokenCount = await this.tokenizer.countMessages(current);
    if (tokenCount <= limit) {
      return current;
    }

    // Build list of droppable messages by reference (before any filtering)
    const droppableMessages = [...nonTailMutableIndices, ...Array.from(tailIndices)]
      .map(idx => current[idx]);
    // non-tail first (oldest), then tail (oldest-within-tail) — Set iteration preserves insertion order (ES2015+)

    for (const msg of droppableMessages) {
      if (tokenCount <= limit) break;
      current = current.filter(m => m !== msg);
      tokenCount = await this.tokenizer.countMessages(current);
    }

    return current;
  }
}

export function createICM(
  router: ContentRouter,
  tokenizer: Tokenizer,
  config?: Partial<ICMConfig>,
): IntelligentContextManager {
  return new IntelligentContextManager(router, tokenizer, config);
}
