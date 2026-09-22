import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';
import { getLatestVersion } from './processes.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000; // keeps a stale/first-run lookup from stalling agent startup

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

export async function getCachedLatestVersion(packageName: string): Promise<string | null> {
	const cache = await loadCache();
	const entry = cache.packages[packageName];
	const isFresh = entry && Date.now() - Date.parse(entry.fetchedAt) < TTL_MS;
	if (isFresh) return entry.version;

	try {
		const live = await getLatestVersion(packageName, { timeout: FETCH_TIMEOUT_MS });
		if (!live) return entry?.version ?? null;
		cache.packages[packageName] = { version: live, fetchedAt: new Date().toISOString() };
		await saveCache(cache);
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
}
