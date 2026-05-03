import { ICMMessage } from '../transforms/icm.js';
import { MessageAdapter, ProviderFormat } from './types.js';

function normalizeRole(role: unknown): ICMMessage['role'] {
  if (role === 'function') return 'tool';
  if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role;
  return 'user';
}

export class AnthropicAdapter implements MessageAdapter {
  readonly format: ProviderFormat = 'anthropic';

  normalize(messages: unknown[]): ICMMessage[] {
    return messages.map((msg): ICMMessage => {
      const m = msg as Record<string, unknown>;
      return {
        ...m,
        role: normalizeRole(m['role']),
        content: m['content'] as ICMMessage['content'],
      };
    });
  }

  serialize(messages: ICMMessage[]): unknown[] {
    return messages.map((msg): unknown => ({ ...msg }));
  }
}

export function createAnthropicAdapter(): AnthropicAdapter {
  return new AnthropicAdapter();
}
