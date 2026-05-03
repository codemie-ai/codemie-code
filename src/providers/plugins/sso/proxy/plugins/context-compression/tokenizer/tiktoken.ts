import { logger } from '../../../../../../../utils/logger.js';

interface MessageForCounting {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

const MESSAGE_OVERHEAD_TOKENS = 4;

export class Tokenizer {
  private encoding: { encode: (text: string) => Uint32Array } | null = null;
  private fallback = false;

  private async init(): Promise<void> {
    if (this.encoding !== null || this.fallback) {
      return;
    }
    try {
      const { encoding_for_model } = await import('tiktoken');
      this.encoding = encoding_for_model('gpt-4o-mini');
    } catch (err) {
      logger.warn('tiktoken init failed, falling back to character-based approximation', err);
      this.fallback = true;
    }
  }

  private approximateCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async countText(text: string): Promise<number> {
    await this.init();
    if (this.fallback || this.encoding === null) {
      return this.approximateCount(text);
    }
    return this.encoding.encode(text).length;
  }

  async countMessages(messages: MessageForCounting[]): Promise<number> {
    await this.init();
    let total = 0;
    for (const message of messages) {
      const text = this.extractText(message.content);
      const tokens = this.fallback || this.encoding === null
        ? this.approximateCount(text)
        : this.encoding.encode(text).length;
      total += tokens + MESSAGE_OVERHEAD_TOKENS;
    }
    return total;
  }

  private extractText(content: string | Array<{ type: string; text?: string }>): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .filter(block => block.type === 'text' && block.text !== undefined)
      .map(block => block.text as string)
      .join('');
  }
}

export function createTokenizer(): Tokenizer {
  return new Tokenizer();
}
