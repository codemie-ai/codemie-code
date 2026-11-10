import { createHash, randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import type { FundingRoute } from './routing.js';
import { parseProjectBinding, type ProjectBindingState } from '@/utils/project-binding.js';
import {
  evidenceRecordIdleDays,
  evidenceRecordMaxFiles,
} from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-config.js';

/*
 * Durable per-session evidence records. NOT spool state: spool cleanup removes pending bytes and
 * cursors only and never touches this directory. Only `sweepRecords` evicts, and never a record a
 * pending spool range still relies on. The backend session binding outlives this local retention.
 */

const DAY_MS = 86_400_000;
const RECORD_RE = /^[0-9a-f]{64}\.json$/;
const MAX_LEN = { organization: 256, project: 256, profile: 128, repo_key: 512, session_id: 200 };

export interface EvidenceFields {
  session_id: string;
  launch_mode: 'managed' | 'native';
  routed_via_codemie: boolean;
  routing_proof: 'proven' | 'unproven';
  organization?: string;
  project?: string;
  project_source: 'linked_folder' | 'profile' | 'none';
  repo_key?: string;
  api_identity: string;
  owner_hash: string;
  profile?: string;
  /** Frozen funding evidence: absent = a session recorded before the publication contract (never upgraded). */
  funding_route?: FundingRoute;
  /** Only newly recorded sessions may negotiate a legacy wire protocol before their first send. */
  negotiate_publication?: true;
  /** Frozen `collection_generation` at the first stamp; absent = 0. */
  collection_generation?: number;
  /** Frozen reference of the explicit work-consent entry that applied at the first stamp (no path); absent = no consent. */
  consent_ref?: string;
  /** Local-only: how the launcher bound `project` (CODEMIE_PROJECT_BINDING); never sent to the backend. */
  projectBinding?: ProjectBindingState;
}

export interface EvidenceRecord extends EvidenceFields {
  schema: 1;
  created: number;
  last_used: number;
}

export type RecordResult =
  | { kind: 'created' | 'existing'; record: EvidenceRecord }
  | { kind: 'stamp_invalid'; reason: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'evidence_capacity'; reason: string };

/** Length-prefixed so no field boundary is ambiguous. */
export function recordKey(apiIdentity: string, ownerHash: string, sessionId: string): string {
  const h = createHash('sha256');
  for (const p of [apiIdentity, ownerHash, sessionId]) h.update(`${p.length}:${p}|`);
  return h.digest('hex');
}

/** Lazy so tests / CODEMIE_HOME overrides apply. Shared with the verdict store. */
export function evidenceDir(): string {
  const legacy = getCodemiePath('evidence');
  try {
    lstatSync(legacy);
    return legacy; // Preserve existing records, verdicts and policy state without re-stamping sessions.
  } catch (err) {
    // An inaccessible or broken legacy store must fail closed, never select a fresh namespace.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return legacy;
  }
  return getCodemiePath('analytics', 'state', 'evidence');
}

/** Sticky-verdict file name for a record key (never matches RECORD_RE). */
export function verdictFileName(key: string): string {
  return `${key}.verdict.json`;
}

/** Publication-stop marker file name for a record key (never matches RECORD_RE). */
export function stopFileName(key: string): string {
  return `${key}.stop.json`;
}

/** Notice-acknowledgement file for a stop marker; swept with it (never matches RECORD_RE or STOP_MARKER_RE). */
export function stopAckFileName(key: string): string {
  return `${key}.stop-ack.json`;
}

export const publicationModeFileName = (key: string): string => `${key}.publication.json`;

/**
 * The project an acceptance is for, as a file-name tag: a hash of the project as the backend echoes it back (compared
 * case-insensitively), so a marker holds no project text and one session's acceptance for one project never stands for another.
 */
export const projectTag = (project: string): string => createHash('sha256').update(project.toLowerCase()).digest('hex').slice(0, 16);

/** Destination-accepted sidecar for a record key and the accepted project's tag; shares the record's retention (never matches RECORD_RE). */
export const acceptedFileName = (key: string, tag: string): string => `${key}.${tag}.accepted.json`;
const ACCEPTED_RE = /^([0-9a-f]{64})\.[0-9a-f]{16}\.accepted\.json$/;

/** Destination-ended sidecar: a discard that ended the session's publication; swept with the record, after the accepted one. */
export const endedFileName = (key: string): string => `${key}.ended.json`;

/** Atomic replace: temp file in the same dir, then rename. */
export async function atomicReplace(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const MAX_RECORD_CHARS = 1024;

/**
 * First limit a serialized record breaks, as a named reason. One rule for creation and for reads, so a
 * record is never published that the next read rejects (and nothing is truncated to fit).
 */
function limitViolation(r: Record<string, unknown>, serialized: string): string | undefined {
  if (serialized.length >= MAX_RECORD_CHARS) return 'record_too_large';
  for (const [field, max] of Object.entries(MAX_LEN)) {
    const v = r[field];
    if (v === undefined) continue;
    if (typeof v !== 'string') return `${field}_invalid`;
    if (v.length > max) return `${field}_too_long`;
  }
  return undefined;
}

function validate(key: string, raw: string): EvidenceRecord | undefined {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!r || typeof r !== 'object' || r.schema !== 1) return undefined;
  if (typeof r.api_identity !== 'string' || typeof r.owner_hash !== 'string' || typeof r.session_id !== 'string') return undefined;
  if (recordKey(r.api_identity, r.owner_hash, r.session_id) !== key) return undefined;
  if (r.launch_mode !== 'managed' && r.launch_mode !== 'native') return undefined;
  if (typeof r.routed_via_codemie !== 'boolean') return undefined;
  if (r.routing_proof !== 'proven' && r.routing_proof !== 'unproven') return undefined;
  if (!['linked_folder', 'profile', 'none'].includes(r.project_source as string)) return undefined;
  if (r.funding_route !== undefined && !['api_based', 'subscription', 'unknown'].includes(r.funding_route as string)) return undefined;
  if (r.negotiate_publication !== undefined && (r.negotiate_publication !== true || r.funding_route === undefined)) return undefined;
  if (r.collection_generation !== undefined && !(Number.isSafeInteger(r.collection_generation) && (r.collection_generation as number) >= 0)) return undefined;
  if (r.consent_ref !== undefined && !(typeof r.consent_ref === 'string' && /^[0-9a-f]{16}$/.test(r.consent_ref))) return undefined;
  if (r.consent_ref !== undefined && r.funding_route === undefined) return undefined; // consent exists only on the new contract
  if (r.projectBinding !== undefined && !parseProjectBinding(r.projectBinding)) return undefined;
  if (typeof r.created !== 'number' || typeof r.last_used !== 'number') return undefined;
  if (limitViolation(r, raw)) return undefined;
  return r as unknown as EvidenceRecord;
}

async function readValidated(key: string): Promise<RecordResult | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(evidenceDir(), `${key}.json`), 'utf-8');
  } catch (err) {
    if (code(err) === 'ENOENT') return undefined;
    return { kind: 'unavailable', reason: `read_failed_${code(err) ?? 'unknown'}` };
  }
  const record = validate(key, raw);
  return record ? { kind: 'existing', record } : { kind: 'stamp_invalid', reason: 'record_invalid' };
}

/** Existing record for `key`, or undefined when none. Never repairs or unlinks. */
export function readRecord(key: string): Promise<RecordResult | undefined> {
  return readValidated(key);
}

async function listRecordFiles(): Promise<string[]> {
  try {
    return (await readdir(evidenceDir())).filter((n) => RECORD_RE.test(n));
  } catch {
    return [];
  }
}

/** Destination-accepted sidecars by record key (one per accepted project). */
async function listAcceptedFiles(dir: string): Promise<Map<string, string[]>> {
  const byKey = new Map<string, string[]>();
  let names: string[];
  try { names = await readdir(dir); } catch { return byKey; }
  for (const name of names) {
    const key = ACCEPTED_RE.exec(name)?.[1];
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), name]);
  }
  return byKey;
}

/** Whether any owner has a readable record for this session (an owner-less outage hook cannot compute the key). Never throws. */
export async function hasRecordForSession(sessionId: string): Promise<boolean> {
  return (await recordForSession(sessionId)) !== undefined;
}

/**
 * The profile a session's record froze (undefined when the record has none), or `not-recorded`. Narrowed to one backend so another
 * login's record is never read as this one's. For hook-time evidence captured while the owner is unknown.
 */
export async function frozenProfileOf(sessionId: string, apiIdentity: string): Promise<{ profile?: string } | 'not-recorded'> {
  const r = await recordForSession(sessionId, apiIdentity);
  return r ? { profile: typeof r.profile === 'string' ? r.profile : undefined } : 'not-recorded';
}

async function recordForSession(sessionId: string, apiIdentity?: string): Promise<{ profile?: unknown } | undefined> {
  for (const name of await listRecordFiles()) {
    try {
      const r = JSON.parse(await readFile(join(evidenceDir(), name), 'utf-8')) as { session_id?: unknown; api_identity?: unknown; profile?: unknown };
      if (r.session_id === sessionId && (apiIdentity === undefined || r.api_identity === apiIdentity)) return r;
    } catch { /* unreadable: not proof */ }
  }
  return undefined;
}

/** Publish via temp + hard link (EEXIST = lost the race); `wx` fallback where link is unsupported. */
export async function publish(finalPath: string, content: string, opts: { strict?: boolean } = {}): Promise<'won' | 'lost'> {
  const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  try {
    await link(tmp, finalPath);
    return 'won';
  } catch (err) {
    if (code(err) === 'EEXIST') return 'lost';
    if (opts.strict) throw err; // atomic-only (stop marker, publication mode): never expose a partial final file
    // ponytail: wx fallback can expose a partially written file to readers; losers retry the read.
    try {
      await writeFile(finalPath, content, { flag: 'wx', mode: 0o600 });
      return 'won';
    } catch (e2) {
      if (code(e2) === 'EEXIST') return 'lost';
      throw e2;
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

export async function createOrRead(
  key: string,
  fields: EvidenceFields,
  opts: { pendingKeys?: Set<string>; pendingSessionIds?: Set<string> } = {},
): Promise<RecordResult> {
  if (recordKey(fields.api_identity, fields.owner_hash, fields.session_id) !== key) {
    return { kind: 'stamp_invalid', reason: 'key_mismatch' };
  }
  const existing = await readValidated(key);
  if (existing) return existing;

  const now = Date.now();
  const record: EvidenceRecord = { schema: 1, ...fields, created: now, last_used: now };
  const content = JSON.stringify(record);
  const violation = limitViolation(record as unknown as Record<string, unknown>, content);
  if (violation) return { kind: 'stamp_invalid', reason: violation };
  if (!validate(key, content)) return { kind: 'stamp_invalid', reason: 'record_invalid' };

  try {
    await mkdir(evidenceDir(), { recursive: true, mode: 0o700 });
    // New session at/over the cap: evict only when the caller told us what is pending.
    if ((await listRecordFiles()).length >= evidenceRecordMaxFiles()) {
      const blocked = opts.pendingKeys || opts.pendingSessionIds
        ? (await sweepRecords({ pendingKeys: opts.pendingKeys ?? new Set(), pendingSessionIds: opts.pendingSessionIds, reserve: 1 })).capacityBlocked
        : true;
      if (blocked) return { kind: 'evidence_capacity', reason: 'evidence_capacity' };
    }
    if ((await publish(join(evidenceDir(), `${key}.json`), content)) === 'won') {
      return { kind: 'created', record };
    }
    for (let i = 0; i < 3; i++) {
      const winner = await readValidated(key);
      if (winner && winner.kind !== 'stamp_invalid') return winner;
      if (winner && i === 2) return winner;
      await sleep(15);
    }
    return { kind: 'unavailable', reason: 'winner_unreadable' };
  } catch (err) {
    logger.debug(`[evidence-record] create failed: ${code(err) ?? 'error'}`);
    return { kind: 'unavailable', reason: `create_failed_${code(err) ?? 'unknown'}` };
  }
}

/** Bump last_used at most once a day. Valid records only; never repairs. */
export async function touch(key: string, now: number = Date.now()): Promise<void> {
  const r = await readValidated(key);
  if (!r || r.kind !== 'existing' || now - r.record.last_used < DAY_MS) return;
  try {
    await atomicReplace(join(evidenceDir(), `${key}.json`), JSON.stringify({ ...r.record, last_used: now }));
  } catch (err) {
    logger.debug(`[evidence-record] touch failed: ${code(err) ?? 'error'}`);
  }
}

export async function sweepRecords(
  opts: { pendingKeys: Set<string>; pendingSessionIds?: Set<string>; reserve?: number },
): Promise<{ evicted: number; capacityBlocked: boolean }> {
  const dir = evidenceDir();
  const now = Date.now();
  const idleMs = evidenceRecordIdleDays() * DAY_MS;
  const entries: Array<{ key: string; lastUsed: number }> = [];
  const pendingKeys = new Set(opts.pendingKeys);
  const acceptedByKey = await listAcceptedFiles(dir);
  for (const name of await listRecordFiles()) {
    const key = name.slice(0, -5);
    let lastUsed: number;
    try {
      const r = JSON.parse(await readFile(join(dir, name), 'utf-8')) as { last_used?: unknown; session_id?: unknown };
      lastUsed = typeof r.last_used === 'number' ? r.last_used : (await stat(join(dir, name))).mtimeMs;
      // The spool knows session ids, not record keys (no identity there): a pending session pins its records.
      if (typeof r.session_id === 'string' && opts.pendingSessionIds?.has(r.session_id)) pendingKeys.add(key);
    } catch {
      try { lastUsed = (await stat(join(dir, name))).mtimeMs; } catch { continue; }
    }
    entries.push({ key, lastUsed });
  }
  let evicted = 0;
  const evictedKeys = new Set<string>();
  const evict = async (key: string): Promise<boolean> => {
    try {
      await unlink(join(dir, `${key}.json`));
      evicted++;
      evictedKeys.add(key);
      // Sticky verdict shares the record's key and retention (and its pending protection).
      await unlink(join(dir, verdictFileName(key))).catch(() => undefined);
      await unlink(join(dir, publicationModeFileName(key))).catch(() => undefined);
      // The ended marker goes only once every acceptance is gone: a lone acceptance would authorize a legacy send again
      let acceptedGone = true;
      for (const name of acceptedByKey.get(key) ?? []) {
        const gone = await unlink(join(dir, name)).then(() => true, (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
        acceptedGone &&= gone;
      }
      if (acceptedGone) await unlink(join(dir, endedFileName(key))).catch(() => undefined);
      return true;
    } catch { return false; }
  };
  let live = entries.length;
  const remaining: typeof entries = [];
  for (const e of entries) {
    if (now - e.lastUsed > idleMs && !pendingKeys.has(e.key) && (await evict(e.key))) live--;
    else remaining.push(e);
  }
  const cap = evidenceRecordMaxFiles() - (opts.reserve ?? 0);
  if (live > cap) {
    remaining.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of remaining) {
      if (live <= cap) break;
      if (!pendingKeys.has(e.key) && (await evict(e.key))) live--;
    }
  }
  await sweepStopMarkers(dir, now, idleMs, (key, sessionId) =>
    (entries.some((e) => e.key === key) && !evictedKeys.has(key)) || pendingKeys.has(key) ||
    (!!sessionId && !!opts.pendingSessionIds?.has(sessionId)));
  return { evicted, capacityBlocked: live > cap };
}

const STOP_MARKER_RE = /^[0-9a-f]{64}\.stop\.json$/;
/** Margin past record idle expiry before an unreferenced marker may go (a later resume then lacks scope evidence and fails closed). */
const STOP_MARKER_MARGIN_MS = 7 * DAY_MS;

/** A marker is pinned while its record or queued data can still authorize publication; only then does it age out. */
async function sweepStopMarkers(
  dir: string,
  now: number,
  idleMs: number,
  pinned: (key: string, sessionId: string | undefined) => boolean,
): Promise<void> {
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => STOP_MARKER_RE.test(n)); } catch { return; }
  for (const name of names) {
    const key = name.slice(0, -'.stop.json'.length);
    let sessionId: string | undefined;
    try {
      const m = JSON.parse(await readFile(join(dir, name), 'utf-8')) as { session_id?: unknown };
      if (typeof m.session_id === 'string') sessionId = m.session_id;
    } catch { /* unreadable marker: pinned by age only */ }
    try {
      if (pinned(key, sessionId)) continue;
      if (now - (await stat(join(dir, name))).mtimeMs > idleMs + STOP_MARKER_MARGIN_MS) {
        await unlink(join(dir, name));
        await unlink(join(dir, stopAckFileName(key))).catch(() => undefined); // a later marker for this key must show its notice
      }
    } catch { /* best effort */ }
  }
}
