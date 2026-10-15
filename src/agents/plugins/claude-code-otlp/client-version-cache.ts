import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { exec } from '@/utils/exec.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';

const CACHE_PATH = getCodemiePath('cache', 'claude-code-client-version.json');
const TTL_MS = 1 * 60 * 60 * 1000; // 1h - staleness here only affects an analytics label, not behavior.

interface CacheEntry {
  version: string;
  resolvedAt: number;
}

async function readCache(): Promise<CacheEntry | undefined> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.resolvedAt < TTL_MS) {
      return entry;
    }
  } catch {
    /* missing/corrupt cache: fall through to re-resolve */
  }
  return undefined;
}

async function writeCache(version: string): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ version, resolvedAt: Date.now() } satisfies CacheEntry));
  } catch (err) {
    logger.debug('client-version-cache: write failed', err instanceof Error ? err.message : String(err));
  }
}

async function execClaudeVersion(): Promise<string> {
  try {
    const result = await exec('claude', ['--version']);
    const trimmed = result.stdout.trim();
    const match = trimmed.match(/^(\d+\.\d+\.\d+)/);
    return match ? match[1] : trimmed;
  } catch {
    return '';
  }
}

/** Resolve the installed `claude` CLI version, backed by a TTL file cache so a fresh
 * `codemie hook` process (one per hook event) doesn't spawn `claude --version` every time. */
export async function resolveClientVersion(): Promise<string> {
  const cached = await readCache();
  if (cached) {
    return cached.version;
  }

  const version = await execClaudeVersion();
  if (version) {
    await writeCache(version);
  }
  return version;
}
