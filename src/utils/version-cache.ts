import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { logger } from './logger.js';
import { fetchLatestVersionFromRegistry, resolveRegistry } from './npm-registry.js';
import { getCodemiePath } from './paths.js';

const TTL_MS = 24 * 60 * 60 * 1000;
// After a failed lookup, skip further lookups for this long, so an offline or firewalled machine
// doesn't wait FETCH_TIMEOUT_MS on every agent launch. Short enough that a restored connection
// is picked up soon; `bypassCache` (explicit `codemie update`) always retries.
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
// keeps a stale/first-run lookup from stalling agent startup; exported so callers racing this
// lookup against their own timeout (e.g. `codemie setup`) can size their timeout with margin.
export const FETCH_TIMEOUT_MS = 3000;

// A version as the registry reports it. Prerelease/build suffixes are kept (not stripped) so
// version-resolution can still recognize and reject them.
const NPM_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

// Shape of a key produced by versionCacheKey: `<origin>#<sha256 hex>|<package>`.
const KEY_PATTERN = /^[^|#\s]+#[0-9a-f]{64}\|/;

/**
 * Cache key for a package looked up against a registry. Never embeds the resolved registry URL,
 * which may carry credentials or a token in its userinfo or path: only the URL origin (which
 * excludes userinfo, path and query) plus a SHA-256 of the full URL, so distinct registries on
 * one host still get distinct entries.
 *
 * @param registry - the resolved registry URL the lookup would ask
 * @param packageName - npm package name
 * @returns `<origin>#<sha256(registry)>|<packageName>`; origin is `invalid-registry` when the
 *   URL cannot be parsed
 */
export function versionCacheKey(registry: string, packageName: string): string {
  let origin = 'invalid-registry';
  try {
    origin = new URL(registry).origin;
  } catch {
    // keep the placeholder; the raw string must never reach the key
  }
  if (origin === 'null') origin = 'invalid-registry';
  const hash = createHash('sha256').update(registry).digest('hex');
  return `${origin}#${hash}|${packageName}`;
}

interface CacheEntry {
  version: string;
  fetchedAt: string;
}

interface CacheFile {
  version: 1;
  packages: Record<string, CacheEntry>;
  /** When each package's most recent lookup failed (ISO timestamp); cleared by a success. */
  failures: Record<string, string>;
}

const filePath = (): string => getCodemiePath('version-cache.json');
const emptyCache = (): CacheFile => ({ version: 1, packages: {}, failures: {} });

// Serializes cache writes within this process so concurrent callers (e.g. `Promise.all` over all
// agents in `checkAllAgentsForUpdates`) can't interleave a read-modify-write and drop each
// other's entries. Across processes the last write wins; the loser just refetches later.
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueCacheWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(task, task);
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CacheEntry).version === 'string' &&
    typeof (value as CacheEntry).fetchedAt === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Keeps only well-formed entries, so a corrupt or torn file degrades to "not cached" and the
// next successful write repairs it.
async function loadCache(): Promise<CacheFile> {
  try {
    const parsed = JSON.parse(await readFile(filePath(), 'utf-8')) as { packages?: unknown; failures?: unknown } | null;
    const cache = emptyCache();
    if (!isRecord(parsed?.packages)) {
      return cache;
    }
    // Keys not in the current format are dropped: legacy raw-URL keys may hold registry
    // credentials, and dropping them here lets the next save scrub them from disk.
    for (const [name, entry] of Object.entries(parsed.packages)) {
      if (KEY_PATTERN.test(name) && isCacheEntry(entry)) cache.packages[name] = entry;
    }
    if (isRecord(parsed.failures)) {
      for (const [name, failedAt] of Object.entries(parsed.failures)) {
        if (KEY_PATTERN.test(name) && typeof failedAt === 'string') cache.failures[name] = failedAt;
      }
    }
    return cache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[version-cache] corrupt or unreadable file — treating as empty', { error: String(error) });
    }
    return emptyCache();
  }
}

async function saveCache(cache: CacheFile): Promise<void> {
  const file = filePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cache, null, 2), 'utf-8');
}

// A timestamp younger than `windowMs`; a future timestamp (clock skew, hand-edited file) never
// counts, so it can't pin a value forever.
function isWithin(timestamp: string | undefined, windowMs: number): boolean {
  if (!timestamp) return false;
  const ageMs = Date.now() - Date.parse(timestamp);
  return ageMs >= 0 && ageMs < windowMs;
}

// Scoped write: re-read at write time (inside the queue) so a concurrent refresh of another
// package isn't clobbered. A failed write is logged and otherwise ignored.
async function updateCache(packageName: string, update: (cache: CacheFile) => void): Promise<void> {
  try {
    await enqueueCacheWrite(async () => {
      const latest = await loadCache();
      update(latest);
      await saveCache(latest);
    });
  } catch (error) {
    logger.warn('[version-cache] failed to persist lookup result', { packageName, error: String(error) });
  }
}

/**
 * The package's `latest` version, served from a 24h cache and fetched from the npm registry on
 * a miss. A failed fetch is logged and returns `null` (an expired entry is never presented as
 * current), and further lookups are skipped for {@link FAILURE_BACKOFF_MS} so repeated launches
 * don't each wait for the timeout.
 *
 * @param packageName - npm package name, e.g. `@openai/codex`
 * @param options.bypassCache - skip the cache (a fresh entry or a recent failure) and always
 *   fetch; the result is still written back. For explicit user-requested checks such as
 *   `codemie update`.
 * @returns the version string, or `null` when no current value is available
 */
export async function getCachedLatestVersion(
  packageName: string,
  options: { bypassCache?: boolean } = {}
): Promise<string | null> {
  // Keyed by registry as well as package, so an answer (or failure) from one registry is never
  // served to a lookup that would ask another one.
  const key = versionCacheKey(resolveRegistry(packageName), packageName);
  if (!options.bypassCache) {
    const cache = await loadCache();
    const entry = cache.packages[key];
    if (entry && isWithin(entry.fetchedAt, TTL_MS)) return entry.version;
    if (isWithin(cache.failures[key], FAILURE_BACKOFF_MS)) {
      logger.debug('[version-cache] skipping lookup after a recent failure', { packageName });
      return null;
    }
  }

  const fetched = await fetchLatestVersionFromRegistry(packageName, { timeoutMs: FETCH_TIMEOUT_MS });
  const version = fetched?.trim();
  if (!version || !NPM_VERSION_PATTERN.test(version)) {
    logger.warn('[version-cache] live version lookup failed', {
      packageName,
      reason: fetched ? 'unparsable registry response' : 'no version returned (offline, registry error or timeout)',
    });
    await updateCache(packageName, (cache) => {
      cache.failures[key] = new Date().toISOString();
    });
    return null;
  }

  await updateCache(packageName, (cache) => {
    cache.packages[key] = { version, fetchedAt: new Date().toISOString() };
    delete cache.failures[key];
  });
  return version;
}
