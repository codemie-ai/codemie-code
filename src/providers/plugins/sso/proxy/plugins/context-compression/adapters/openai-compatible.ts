import { ICMMessage } from '../transforms/icm.js';
import { MessageAdapter, ProviderFormat } from './types.js';
import { OpenAIAdapter } from './openai.js';

function preprocessMessage(msg: unknown): unknown {
  const m = msg as Record<string, unknown>;
  const result: Record<string, unknown> = { ...m };

  // Treat undefined content as empty string
  if (result['content'] === undefined) {
    result['content'] = '';
  }

  // Normalize legacy 'function' role to 'tool'
  if (result['role'] === 'function') {
    result['role'] = 'tool';
  }

  return result;
}

export class OpenAICompatibleAdapter implements MessageAdapter {
  readonly format: ProviderFormat = 'openai-compatible';

  private readonly openaiAdapter: OpenAIAdapter;

  constructor() {
    this.openaiAdapter = new OpenAIAdapter();
  }

  normalize(messages: unknown[]): ICMMessage[] {
    const preprocessed = messages.map(preprocessMessage);
    return this.openaiAdapter.normalize(preprocessed);
  }

  serialize(messages: ICMMessage[]): unknown[] {
    return this.openaiAdapter.serialize(messages);
  }
}

export function createOpenAICompatibleAdapter(): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter();
}
