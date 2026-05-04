import type { ICMMessage } from './icm.js';
import type { CompressConfig } from './config.js';

export interface CompressionContext {
  messages: ICMMessage[];
  config: CompressConfig;
  requestId?: string;
}

export interface CompressionEvent {
  messageIndex: number;
  role: string;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  cacheKey?: string;
}

export interface CompressionHooks {
  preCompress?: (context: CompressionContext) => Promise<ICMMessage[]> | ICMMessage[];
  postCompress?: (event: CompressionEvent) => Promise<void> | void;
  computeBiases?: (messages: ICMMessage[]) => Promise<number[]> | number[];
}
