import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../../../../../../../utils/logger.js';

export interface CompressionSavingsEntry {
  model: string;
  tokensSaved: number;
  totalInputTokens: number;
  timestamp: string; // ISO UTC
}

export interface SavingsStore {
  lifetime: Record<string, { tokensSaved: number; totalInputTokens: number }>;
  history: CompressionSavingsEntry[];
}

const DEFAULT_STORE_PATH = join(homedir(), '.codemie', 'compression-savings.json');
const HISTORY_RETENTION_DAYS = 90;

function emptyStore(): SavingsStore {
  return { lifetime: {}, history: [] };
}

function cutoffDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() - HISTORY_RETENTION_DAYS);
  return d;
}

export class SavingsTracker {
  private readonly storePath: string;
  private cached: SavingsStore | null = null;
  private writePromise: Promise<void> = Promise.resolve();

  constructor(storePath?: string) {
    this.storePath = storePath ?? DEFAULT_STORE_PATH;
  }

  async record(entry: Omit<CompressionSavingsEntry, 'timestamp'>): Promise<void> {
    const newEntry: CompressionSavingsEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    this.writePromise = this.writePromise.then(() => this._persist(newEntry));
    await this.writePromise;
  }

  async getStore(): Promise<SavingsStore> {
    if (this.cached !== null) {
      return this.cached;
    }
    this.cached = await this._load();
    return this.cached;
  }

  async getSummary(): Promise<{
    totalTokensSaved: number;
    totalInputTokens: number;
    byModel: SavingsStore['lifetime'];
  }> {
    const store = await this.getStore();

    let totalTokensSaved = 0;
    let totalInputTokens = 0;

    for (const stats of Object.values(store.lifetime)) {
      totalTokensSaved += stats.tokensSaved;
      totalInputTokens += stats.totalInputTokens;
    }

    return {
      totalTokensSaved,
      totalInputTokens,
      byModel: store.lifetime,
    };
  }

  private async _load(): Promise<SavingsStore> {
    try {
      const raw = await readFile(this.storePath, 'utf8');
      return JSON.parse(raw) as SavingsStore;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return emptyStore();
      }
      logger.warn('SavingsTracker: corrupt store file, starting fresh', { path: this.storePath });
      return emptyStore();
    }
  }

  private async _persist(entry: CompressionSavingsEntry): Promise<void> {
    const store = await this._load();

    // Update history
    store.history.push(entry);

    // Trim history to last 90 days
    const cutoff = cutoffDate();
    store.history = store.history.filter(
      (e) => new Date(e.timestamp) >= cutoff,
    );

    // Update lifetime totals
    const existing = store.lifetime[entry.model] ?? { tokensSaved: 0, totalInputTokens: 0 };
    store.lifetime[entry.model] = {
      tokensSaved: existing.tokensSaved + entry.tokensSaved,
      totalInputTokens: existing.totalInputTokens + entry.totalInputTokens,
    };

    // Ensure directory exists and write atomically
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(store, null, 2), 'utf8');

    // Invalidate cache so next read reflects the new state
    this.cached = store;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export function createSavingsTracker(storePath?: string): SavingsTracker {
  return new SavingsTracker(storePath);
}
