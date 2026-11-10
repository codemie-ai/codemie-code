import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';
import { canonicalizePath, comparable, isPathInside } from '@/agents/core/project-allowlist.js';
import { acquirePidLock } from '@/utils/pid-lock.js';
import { atomicReplace } from './record-store.js';

/*
 * Explicit work consent: user-local, revocable, never in a repo, profile or workspace config. One entry per
 * (owner, backend, canonical folder, project). Unreadable or unknown-version store = no consent.
 * Written only by the explicit connect action; removed by disconnect.
 */

const STORE_VERSION = 1;

export interface ConsentEntry {
  owner_hash: string;
  api_identity: string;
  project: string;
  /** Canonical folder; every descendant folder resolving to the project is covered. */
  folder: string;
  /**
   * Connection incarnation, random per actual connect. Disconnect + reconnect gets a new one, so a session that froze an
   * earlier connection's reference is never authorized by the new one.
   */
  id: string;
}

export interface ConsentScope {
  owner_hash: string;
  api_identity: string;
  project: string;
}

type Loaded = { kind: 'ok'; entries: ConsentEntry[] } | { kind: 'unreadable' };

export function consentStorePath(): string {
  return getCodemiePath('work-consent.json');
}

const sameProject = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Stable, path-free reference frozen into the evidence record; changes with any of its parts and with each reconnect. */
export function consentRef(e: ConsentEntry): string {
  const h = createHash('sha256');
  const parts = [comparable(e.folder), e.api_identity, e.owner_hash, e.project.trim().toLowerCase(), e.id];
  for (const p of parts) h.update(`${p.length}:${p}|`);
  return h.digest('hex').slice(0, 16);
}

function validEntry(v: unknown): v is ConsentEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== 'string' || !/^[0-9a-f]{16}$/.test(e.id)) return false;
  return ['owner_hash', 'api_identity', 'project', 'folder'].every((k) => typeof e[k] === 'string' && (e[k] as string).length > 0);
}

/** Same connection target (not incarnation): owner, backend, project and canonical folder. */
const sameTarget = (a: ConsentEntry, b: ConsentEntry): boolean =>
  a.owner_hash === b.owner_hash && a.api_identity === b.api_identity && sameProject(a.project, b.project) && comparable(a.folder) === comparable(b.folder);

async function load(): Promise<Loaded> {
  let raw: string;
  try {
    raw = await readFile(consentStorePath(), 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'ok', entries: [] } : { kind: 'unreadable' };
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.entries) || !parsed.entries.every(validEntry)) {
      return { kind: 'unreadable' };
    }
    return { kind: 'ok', entries: parsed.entries as ConsentEntry[] };
  } catch {
    return { kind: 'unreadable' };
  }
}

async function save(entries: ConsentEntry[]): Promise<void> {
  await mkdir(dirname(consentStorePath()), { recursive: true });
  await atomicReplace(consentStorePath(), JSON.stringify({ version: STORE_VERSION, entries }, null, 2));
}

const scopeMatches = (e: ConsentEntry, s: ConsentScope): boolean =>
  e.owner_hash === s.owner_hash && e.api_identity === s.api_identity && sameProject(e.project, s.project);

/** A consent lookup that keeps "no entry" apart from "the store could not be read". */
export type ConsentLookup = { kind: 'found'; ref: string } | { kind: 'none' } | { kind: 'unknown' };

/**
 * The entry that grants consent for this owner, backend, project and folder (the folder or an ancestor of it is
 * connected): `found`, `none` when no entry grants it, `unknown` when the store or the folder could not be read.
 * Never throws.
 */
export async function lookupConsent(scope: ConsentScope, cwd: string): Promise<ConsentLookup> {
  if (!scope.project.trim()) return { kind: 'none' };
  try {
    const store = await load();
    if (store.kind !== 'ok') return { kind: 'unknown' };
    const canonicalCwd = await canonicalizePath(cwd);
    const entry = store.entries.find((e) => scopeMatches(e, scope) && isPathInside(canonicalCwd, e.folder));
    return entry ? { kind: 'found', ref: consentRef(entry) } : { kind: 'none' };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The reference of the entry that grants consent for this owner, backend, project and folder, else undefined.
 * Never throws; any doubt is no consent.
 */
export async function resolveConsent(scope: ConsentScope, cwd: string): Promise<string | undefined> {
  const found = await lookupConsent(scope, cwd);
  return found.kind === 'found' ? found.ref : undefined;
}

/**
 * Whether the entry a record froze is still connected for this scope (and, with `cwd`, still covers that folder):
 * `holds`, `revoked`, or `unknown` when the store or the folder could not be read. Never throws.
 */
export async function consentStatus(ref: string, scope: ConsentScope, cwd?: string): Promise<'holds' | 'revoked' | 'unknown'> {
  if (!scope.project.trim()) return 'revoked';
  try {
    const store = await load();
    if (store.kind !== 'ok') return 'unknown';
    const canonicalCwd = cwd === undefined ? undefined : await canonicalizePath(cwd);
    const holds = store.entries.some(
      (e) => scopeMatches(e, scope) && consentRef(e) === ref && (canonicalCwd === undefined || isPathInside(canonicalCwd, e.folder))
    );
    return holds ? 'holds' : 'revoked';
  } catch {
    return 'unknown';
  }
}

/** Whether the entry a record froze is still connected for this scope; any doubt is false. */
export async function consentHolds(ref: string, scope: ConsentScope, cwd?: string): Promise<boolean> {
  return (await consentStatus(ref, scope, cwd)) === 'holds';
}

/** Roots, the home directory and any ancestor of it are too broad to connect. */
export async function assertConnectableFolder(canonical: string): Promise<void> {
  const home = await canonicalizePath(homedir());
  if (dirname(canonical) === canonical || isPathInside(home, canonical)) {
    throw new ConfigurationError(
      'Refusing to connect a filesystem root, your home directory or one of its parents. Choose a specific project folder.'
    );
  }
}

/** Serializes every load-modify-save of the store across processes (a concurrent revoke must not be undone by a connect). */
async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = await acquirePidLock(`${consentStorePath()}.lock`, { mode: 'wait', budgetMs: 10_000 });
  if (!lock) throw new ConfigurationError('The work-consent store is busy and was not changed. Retry in a moment.');
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/** Adds (idempotently) the entry; returns the canonical folder. Refuses to overwrite an unreadable store. */
export async function connectFolder(scope: ConsentScope, folder: string): Promise<string> {
  const canonical = await canonicalizePath(folder);
  await assertConnectableFolder(canonical);
  if (!scope.project.trim()) throw new ConfigurationError('A CodeMie project is required to connect a folder.');
  return withStoreLock(async () => {
    const store = await load();
    if (store.kind !== 'ok') {
      throw new ConfigurationError(`The work-consent store is unreadable and was not changed: ${consentStorePath()}. Fix or delete it, then retry.`);
    }
    const entry: ConsentEntry = { ...scope, project: scope.project.trim(), folder: canonical, id: randomBytes(8).toString('hex') };
    if (!store.entries.some((e) => sameTarget(e, entry))) await save([...store.entries, entry]);
    return canonical;
  });
}

/** Removes the folder's entries for this owner and backend (any project). Returns how many were removed. */
export async function disconnectFolder(scope: Omit<ConsentScope, 'project'>, folder: string): Promise<number> {
  const canonical = await canonicalizePath(folder);
  return withStoreLock(async () => {
    const store = await load();
    if (store.kind !== 'ok') {
      throw new ConfigurationError(`The work-consent store is unreadable and was not changed: ${consentStorePath()}. Fix or delete it, then retry.`);
    }
    const kept = store.entries.filter(
      (e) => !(e.owner_hash === scope.owner_hash && e.api_identity === scope.api_identity && comparable(e.folder) === comparable(canonical))
    );
    const removed = store.entries.length - kept.length;
    if (removed > 0) await save(kept);
    return removed;
  });
}

/** Entries of this owner and backend that still cover the folder (the folder itself or an ancestor), whatever the project. */
export async function coveringEntries(scope: Omit<ConsentScope, 'project'>, folder: string): Promise<ConsentEntry[]> {
  const store = await load();
  if (store.kind !== 'ok') return [];
  const canonical = await canonicalizePath(folder);
  return store.entries.filter(
    (e) => e.owner_hash === scope.owner_hash && e.api_identity === scope.api_identity && isPathInside(canonical, e.folder)
  );
}
