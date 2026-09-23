import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';
import { getLatestVersion } from './processes.js';

const TTL_MS = 24 * 60 * 60 * 1000;
// keeps a stale/first-run lookup from stalling agent startup; exported so callers racing this
// lookup against their own timeout (e.g. `codemie setup`) can size their timeout with margin.
export const FETCH_TIMEOUT_MS = 3000;

interface CacheEntry {
	version: string;
	fetchedAt: string;
}

interface CacheFile {
	version: 1;
	packages: Record<string, CacheEntry>;
}

const filePath = (): string => getCodemiePath('version-cache.json');
const emptyCache = (): CacheFile => ({ version: 1, packages: {} });

// Serializes every cache write (including clear) behind an in-process promise chain so
// concurrent callers (e.g. `Promise.all` over all agents in `checkAllAgentsForUpdates`) can't
// interleave a read-modify-write and silently drop each other's freshly-fetched entries.
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueCacheWrite<T>(task: () => Promise<T>): Promise<T> {
	const result = writeQueue.then(task, task);
	writeQueue = result.then(
		() => undefined,
		() => undefined
	);
	return result;
}

async function loadCache(): Promise<CacheFile> {
	try {
		const content = await fs.readFile(filePath(), 'utf-8');
		const parsed = JSON.parse(content) as unknown;
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as CacheFile).packages === 'object'
		) {
			return parsed as CacheFile;
		}
		return emptyCache();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return emptyCache();
		logger.warn('[version-cache] corrupt or unreadable file — treating as empty', {
			error: String(error),
		});
		return emptyCache();
	}
}

async function saveCache(cache: CacheFile): Promise<void> {
	const file = filePath();
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(cache, null, 2), 'utf-8');
}

export async function getCachedLatestVersion(
	packageName: string,
	options: { forceRefresh?: boolean } = {}
): Promise<string | null> {
	const cache = await loadCache();
	const entry = cache.packages[packageName];
	const isFresh =
		!options.forceRefresh && !!entry && Date.now() - Date.parse(entry.fetchedAt) < TTL_MS;
	if (isFresh) return entry.version;

	try {
		const live = await getLatestVersion(packageName, { timeout: FETCH_TIMEOUT_MS });
		if (!live) return entry?.version ?? null;
		// Scoped write: only this package's entry changes. Re-read the cache at write time
		// (inside the serialized queue) rather than reusing the pre-fetch snapshot, so a
		// concurrent refresh of another package isn't clobbered by this one.
		await enqueueCacheWrite(async () => {
			const latest = await loadCache();
			latest.packages[packageName] = { version: live, fetchedAt: new Date().toISOString() };
			await saveCache(latest);
		});
		return live;
	} catch (error) {
		logger.debug('[version-cache] live lookup failed, using stale cache if present', {
			packageName,
			error: String(error),
		});
		return entry?.version ?? null;
	}
}

export async function clearVersionCache(): Promise<{ removed: number }> {
	return enqueueCacheWrite(async () => {
		const file = filePath();
		const cache = await loadCache();
		const removed = Object.keys(cache.packages).length;
		try {
			await fs.unlink(file);
			return { removed };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return { removed: 0 };
			logger.warn('[version-cache] clear() failed; cache left in place', { file, code });
			return { removed: 0 };
		}
	});
}
