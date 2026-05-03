export interface CompressionResult {
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
}

export interface Compressor {
  compress(content: string, contextHint?: string): Promise<CompressionResult>;
}
