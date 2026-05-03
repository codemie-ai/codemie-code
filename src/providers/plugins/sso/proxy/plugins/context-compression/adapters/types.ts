import { ICMMessage } from '../transforms/icm.js';

export type ProviderFormat = 'anthropic' | 'openai' | 'openai-compatible';

export interface MessageAdapter {
  format: ProviderFormat;
  normalize(messages: unknown[]): ICMMessage[];
  serialize(messages: ICMMessage[]): unknown[];
}
