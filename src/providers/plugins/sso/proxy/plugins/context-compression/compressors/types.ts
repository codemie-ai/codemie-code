export interface CompressionResult {
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  /** Set when original was stored in CompressionStore due to aggressive truncation. */
  cacheKey?: string;
}

export interface Compressor {
  compress(content: string, contextHint?: string): Promise<CompressionResult>;
}
