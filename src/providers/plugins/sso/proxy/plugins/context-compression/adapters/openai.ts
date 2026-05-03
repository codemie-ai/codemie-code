import { ICMMessage } from '../transforms/icm.js';
import { MessageAdapter, ProviderFormat } from './types.js';

function normalizeRole(role: unknown): ICMMessage['role'] {
  if (role === 'function') return 'tool';
  return role as ICMMessage['role'];
}

function normalizeContent(
  content: unknown,
): string | Array<{ type: string; text?: string; [key: string]: unknown }> {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content as Array<{ type: string; text?: string; [key: string]: unknown }>;
  }
  return '';
}

export class OpenAIAdapter implements MessageAdapter {
  readonly format: ProviderFormat = 'openai';

  normalize(messages: unknown[]): ICMMessage[] {
    return messages.map((msg): ICMMessage => {
      const m = msg as Record<string, unknown>;
      return {
        ...m,
        role: normalizeRole(m['role']),
        content: normalizeContent(m['content']),
      };
    });
  }

  serialize(messages: ICMMessage[]): unknown[] {
    return messages.map((msg): unknown => {
      const { content, ...rest } = msg;
      // Restore null content for assistant messages that have tool_calls and empty string content
      if (content === '' && Array.isArray(rest['tool_calls']) && rest['tool_calls'].length > 0) {
        return { ...rest, content: null };
      }
      return { ...rest, content };
    });
  }
}

export function createOpenAIAdapter(): OpenAIAdapter {
  return new OpenAIAdapter();
}
