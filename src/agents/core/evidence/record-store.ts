import { createHash, randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
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

/** Publish via temp + hard link (EEXIST = lost the race); `wx` fallback where link is unsupported. */
async function publish(finalPath: string, content: string): Promise<'won' | 'lost'> {
  const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  try {
    await link(tmp, finalPath);
    return 'won';
  } catch (err) {
    if (code(err) === 'EEXIST') return 'lost';
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
  const evict = async (key: string): Promise<boolean> => {
    try {
      await unlink(join(dir, `${key}.json`));
      evicted++;
      // Sticky verdict shares the record's key and retention (and its pending protection).
      await unlink(join(dir, verdictFileName(key))).catch(() => undefined);
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
  return { evicted, capacityBlocked: live > cap };
}
