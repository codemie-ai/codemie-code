export interface CompressionEntry {
  hash: string;
  originalContent: string;
  compressedContent: string;
  originalTokens: number;
  compressedTokens: number;
  originalItemCount: number;
  compressedItemCount: number;
  toolName: string | null;
  toolCallId: string | null;
  queryContext: string | null;
  createdAt: number;
  ttl: number;
  toolSignatureHash: string | null;
  compressionStrategy: string | null;
  retrievalCount: number;
  searchQueries: string[];
  lastAccessed: number | null;
}

export interface RetrievalEvent {
  hash: string;
  query: string | null;
  itemsRetrieved: number;
  totalItems: number;
  toolName: string | null;
  timestamp: number;
  retrievalType: 'full' | 'search' | 'eviction_success';
  toolSignatureHash: string | null;
}

export interface StoreOpts {
  originalTokens?: number;
  compressedTokens?: number;
  originalItemCount?: number;
  compressedItemCount?: number;
  toolName?: string;
  toolCallId?: string;
  queryContext?: string;
  toolSignatureHash?: string;
  compressionStrategy?: string;
  ttl?: number;
}

export interface CcrStore {
  store(original: string, compressed: string, opts?: StoreOpts): string;
  retrieve(hash: string, query?: string): CompressionEntry | null;
  search(
    hash: string,
    query: string,
    maxResults?: number,
    scoreThreshold?: number,
  ): unknown[];
  getMetadata(hash: string): Record<string, unknown> | null;
  size(): number;
}
