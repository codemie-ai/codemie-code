import { createHash } from 'node:crypto';
import { logger } from '../../../../../../../utils/logger.js';
import { BM25Scorer } from './bm25.js';
import type { CcrStore, CompressionEntry, RetrievalEvent, StoreOpts } from './types.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_ENTRIES = 1000;
const MAX_EVENTS = 1000;
const MAX_SEARCH_QUERIES_PER_ENTRY = 10;
const HEAP_REBUILD_THRESHOLD = 0.5; // rebuild when 50% of heap entries are stale

// ── Min-heap keyed by createdAt ──────────────────────────────────────────────

type HeapEntry = [number, string]; // [createdAt, hash]

class MinHeap {
  private data: HeapEntry[] = [];
  private staleCount = 0;

  push(item: HeapEntry): void {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapEntry | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.data.length;
  }

  markStale(): void {
    this.staleCount++;
  }

  resetStale(): void {
    this.staleCount = 0;
  }

  get staleRatio(): number {
    return this.data.length > 0 ? this.staleCount / this.data.length : 0;
  }

  rebuild(entries: IterableIterator<[string, CompressionEntry]>): void {
    this.data = [];
    for (const [hash, entry] of entries) {
      this.data.push([entry.createdAt, hash]);
    }
    for (let i = Math.floor(this.data.length / 2) - 1; i >= 0; i--) {
      this.sinkDown(i);
    }
    this.staleCount = 0;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.data[parent][0] <= this.data[i][0]) break;
      [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left][0] < this.data[smallest][0]) smallest = left;
      if (right < n && this.data[right][0] < this.data[smallest][0]) smallest = right;
      if (smallest === i) break;
      [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
      i = smallest;
    }
  }
}

// ── CompressionStore ─────────────────────────────────────────────────────────

export class CompressionStore implements CcrStore {
  private readonly entries = new Map<string, CompressionEntry>();
  private readonly heap = new MinHeap();
  private readonly scorer = new BM25Scorer();
  private readonly defaultTtl: number;
  private readonly maxEntries: number;
  private readonly retrievalEvents: RetrievalEvent[] = [];

  constructor(ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.defaultTtl = ttlMs;
    this.maxEntries = maxEntries;
  }

  store(original: string, compressed: string, opts: StoreOpts = {}): string {
    this.evictIfNeeded();

    const hash = createHash('md5').update(original).digest('hex').slice(0, 24);

    const existing = this.entries.get(hash);
    if (existing !== undefined) {
      if (existing.originalContent !== original) {
        logger.warn('CCR: hash collision detected', {
          hash,
          toolName: opts.toolName,
          existingLen: existing.originalContent.length,
          newLen: original.length,
        });
      } else {
        logger.debug('CCR: duplicate store for hash, updating', { hash });
      }
      this.heap.markStale();
    }

    const entry: CompressionEntry = {
      hash,
      originalContent: original,
      compressedContent: compressed,
      originalTokens: opts.originalTokens ?? 0,
      compressedTokens: opts.compressedTokens ?? 0,
      originalItemCount: opts.originalItemCount ?? 0,
      compressedItemCount: opts.compressedItemCount ?? 0,
      toolName: opts.toolName ?? null,
      toolCallId: opts.toolCallId ?? null,
      queryContext: opts.queryContext ?? null,
      createdAt: Date.now(),
      ttl: opts.ttl ?? this.defaultTtl,
      toolSignatureHash: opts.toolSignatureHash ?? null,
      compressionStrategy: opts.compressionStrategy ?? null,
      retrievalCount: 0,
      searchQueries: [],
      lastAccessed: null,
    };

    this.entries.set(hash, entry);
    this.heap.push([entry.createdAt, hash]);

    return hash;
  }

  retrieve(hash: string, query?: string): CompressionEntry | null {
    const entry = this.entries.get(hash);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(hash);
      this.heap.markStale();
      return null;
    }

    entry.retrievalCount++;
    entry.lastAccessed = Date.now();
    if (query) {
      if (!entry.searchQueries.includes(query)) {
        entry.searchQueries.push(query);
        if (entry.searchQueries.length > MAX_SEARCH_QUERIES_PER_ENTRY) {
          entry.searchQueries = entry.searchQueries.slice(-MAX_SEARCH_QUERIES_PER_ENTRY);
        }
      }
    }

    this.logRetrieval({
      hash,
      query: query ?? null,
      itemsRetrieved: entry.originalItemCount,
      totalItems: entry.originalItemCount,
      toolName: entry.toolName,
      timestamp: Date.now(),
      retrievalType: 'full',
      toolSignatureHash: entry.toolSignatureHash,
    });

    return { ...entry, searchQueries: [...entry.searchQueries] };
  }

  search(
    hash: string,
    query: string,
    maxResults = 20,
    scoreThreshold = 0.3,
  ): unknown[] {
    const entry = this.getEntryForSearch(hash, query);
    if (!entry) return [];

    let items: unknown[];
    try {
      const parsed = JSON.parse(entry.originalContent);
      if (!Array.isArray(parsed)) return [];
      items = parsed;
    } catch {
      return [];
    }

    if (items.length === 0) return [];

    const itemStrs = items.map(item => JSON.stringify(item));
    const scores = this.scorer.scoreBatch(itemStrs, query);

    const scored = items
      .map((item, i) => ({ item, score: scores[i].score }))
      .filter(({ score }) => score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(({ item }) => item);

    this.logRetrieval({
      hash,
      query,
      itemsRetrieved: scored.length,
      totalItems: items.length,
      toolName: entry.toolName,
      timestamp: Date.now(),
      retrievalType: 'search',
      toolSignatureHash: entry.toolSignatureHash,
    });

    return scored;
  }

  getMetadata(hash: string): Record<string, unknown> | null {
    const entry = this.entries.get(hash);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(hash);
      this.heap.markStale();
      return null;
    }
    return {
      hash: entry.hash,
      toolName: entry.toolName,
      originalItemCount: entry.originalItemCount,
      compressedItemCount: entry.compressedItemCount,
      queryContext: entry.queryContext,
      compressedContent: entry.compressedContent,
      createdAt: entry.createdAt,
      ttl: entry.ttl,
    };
  }

  size(): number {
    return this.entries.size;
  }

  getStats(): Record<string, unknown> {
    this.cleanExpired();
    let totalOriginalTokens = 0;
    let totalCompressedTokens = 0;
    let totalRetrievals = 0;
    for (const entry of this.entries.values()) {
      totalOriginalTokens += entry.originalTokens;
      totalCompressedTokens += entry.compressedTokens;
      totalRetrievals += entry.retrievalCount;
    }
    return {
      entryCount: this.entries.size,
      maxEntries: this.maxEntries,
      totalOriginalTokens,
      totalCompressedTokens,
      totalRetrievals,
      eventCount: this.retrievalEvents.length,
    };
  }

  getRetrievalEvents(limit = 100, toolName?: string): RetrievalEvent[] {
    let events = [...this.retrievalEvents];
    if (toolName) events = events.filter(e => e.toolName === toolName);
    return events.slice(-limit).reverse();
  }

  clear(): void {
    this.entries.clear();
    this.retrievalEvents.length = 0;
    this.heap.rebuild([][Symbol.iterator]() as unknown as IterableIterator<[string, CompressionEntry]>);
  }

  private isExpired(entry: CompressionEntry): boolean {
    return Date.now() - entry.createdAt > entry.ttl;
  }

  private cleanExpired(): void {
    for (const [hash, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(hash);
        this.heap.markStale();
      }
    }
  }

  private evictIfNeeded(): void {
    this.cleanExpired();

    if (this.heap.staleRatio >= HEAP_REBUILD_THRESHOLD) {
      this.heap.rebuild(this.entries.entries());
    }

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.heap.pop();
      if (!oldest) break;
      const [createdAt, hash] = oldest;
      const entry = this.entries.get(hash);
      if (entry && entry.createdAt === createdAt) {
        this.entries.delete(hash);
      } else {
        this.heap.markStale(); // stale heap entry — decrement counter
      }
    }
  }

  private getEntryForSearch(hash: string, query?: string): CompressionEntry | null {
    const entry = this.entries.get(hash);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(hash);
      this.heap.markStale();
      return null;
    }
    if (query) {
      entry.retrievalCount++;
      entry.lastAccessed = Date.now();
      if (!entry.searchQueries.includes(query)) {
        entry.searchQueries.push(query);
        if (entry.searchQueries.length > MAX_SEARCH_QUERIES_PER_ENTRY) {
          entry.searchQueries = entry.searchQueries.slice(-MAX_SEARCH_QUERIES_PER_ENTRY);
        }
      }
    }
    return { ...entry, searchQueries: [...entry.searchQueries] };
  }

  private logRetrieval(event: RetrievalEvent): void {
    this.retrievalEvents.push(event);
    if (this.retrievalEvents.length > MAX_EVENTS) {
      this.retrievalEvents.splice(0, this.retrievalEvents.length - MAX_EVENTS);
    }
  }
}

export function createCompressionStore(ttlMs?: number, maxEntries?: number): CompressionStore {
  return new CompressionStore(ttlMs, maxEntries);
}
