/**
 * nextRecordStart — the later CodeMie record over the same transcript / native session.
 */
import { readdir, readFile, stat } from 'fs/promises';
import { realpathSync } from 'fs';
import { join } from 'path';
import type { Session } from './types.js';
import { getCodemiePath } from '@/utils/paths.js';

/** A CodeMie session id (the base name of its record file). */
export const SESSION_UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const RECORD_FILE_NAME = new RegExp(
  `^(${SESSION_UUID_PATTERN}|completed_${SESSION_UUID_PATTERN}(-[A-Za-z0-9._-]+)?)\\.json$`,
  'i'
);

/** A copilot transcript path; its directory is the native session id. */
const COPILOT_EVENTS_FILE = /[\\/]session-state[\\/]([^\\/]+)[\\/]events\.jsonl$/;

interface MemoEntry {
  mtimeMs: number;
  record: Session | null;
  keys?: string[];
}

/** Per-process memo of parsed record files: a file is parsed again only when its mtime changes. */
const recordMemo = new Map<string, MemoEntry>();

/** The realpath of `path`, or `path` unchanged when realpath fails. */
export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The keys that say two records cover the same transcript / native session; empty when the
 * record has none.
 *
 * A copilot record also keys on the native session its `session-state/<id>/events.jsonl` names, so a
 * `--continue` / prefix / name run (under its own id) bounds the run it continued.
 *
 * ponytail: while such a run is live (no file recorded yet) a reconcile of the run it continued is
 * unbounded and may read its first events
 */
async function sameTranscriptKeys(record: Session): Promise<string[]> {
  const file = record.correlation?.agentSessionFile;
  switch (record.agentName) {
    case 'claude':
    case 'gemini':
    case 'codex':
      return file ? [`${record.agentName}:${file}`] : [];
    case 'claude-acp':
    case 'gemini-acp':
    case 'codex-acp':
      return file ? [`${record.agentName.slice(0, -'-acp'.length)}:${file}`] : [];
    case 'copilot-cli': {
      const id = record.correlation?.agentSessionId;
      const native = file?.match(COPILOT_EVENTS_FILE)?.[1];
      return [...(id && id !== 'unknown' ? [`copilot-cli:${id}`] : []), ...(native ? [`copilot-cli:${native}`] : [])];
    }
    case 'opencode':
    case 'opencode-acp':
      return record.workingDirectory ? [`opencode:${safeRealpath(record.workingDirectory)}`] : [];
    case 'codemie-code':
      return record.workingDirectory ? [`codemie-code:${safeRealpath(record.workingDirectory)}`] : [];
    case 'pi':
    case 'omp': {
      const { readPiRunLedger } = await import('../../plugins/pi/pi.extension.js');
      const ledger = await readPiRunLedger(record.sessionId);
      return ledger.transcripts.map((path) => `${record.agentName}:${path}`);
    }
    default:
      return [];
  }
}

/** The memo entry of the record file at `path`, parsed again only when its mtime changed. */
async function memoEntry(path: string, mtimeMs: number): Promise<MemoEntry> {
  const cached = recordMemo.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let parsed: Session | null;
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8')) as Session;
  } catch {
    parsed = null;
  }
  const entry = { mtimeMs, record: parsed };
  recordMemo.set(path, entry);
  return entry;
}

/**
 * One `readdir` + `stat` pass over the sessions directory: the memo entry of every record file
 * (live or `completed_`) written at or after `since`; a later record is written after its own
 * start, so an older file cannot be one.
 *
 * ponytail: lists and stats the whole sessions directory (341 ms at 10 000 files); a file is
 * parsed at most once per process unless it changes.
 */
async function scanRecords(since: number): Promise<MemoEntry[]> {
  const sessionsDir = getCodemiePath('sessions');
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const entries: MemoEntry[] = [];
  for (const name of names) {
    if (!RECORD_FILE_NAME.test(name)) continue;
    const path = join(sessionsDir, name);
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs >= since) entries.push(await memoEntry(path, info.mtimeMs));
  }
  return entries;
}

/** The earliest `startTime` among `entries` of a LATER record than `record` that `matches`, else undefined. */
async function earliestLaterStart(
  record: { sessionId: string; startTime: number },
  entries: MemoEntry[],
  matches: (other: Session, entry: MemoEntry) => Promise<boolean>
): Promise<number | undefined> {
  let next: number | undefined;
  for (const entry of entries) {
    const other = entry.record;
    if (entry.mtimeMs < record.startTime) continue;
    if (!other || other.sessionId === record.sessionId || typeof other.startTime !== 'number') continue;
    if (other.startTime <= record.startTime || (next !== undefined && other.startTime >= next)) continue;
    if (await matches(other, entry)) next = other.startTime;
  }
  return next;
}

/** Whether `other` shares one of `keys`, the same-transcript keys of the record being bounded. */
async function sharesTranscript(keys: string[], other: Session, entry: MemoEntry): Promise<boolean> {
  // A pi record's keys come from its run ledger, which grows without a write to the record file
  const otherKeys = (other.agentName === 'pi' || other.agentName === 'omp') ? await sameTranscriptKeys(other) : (entry.keys ??= await sameTranscriptKeys(other));
  return otherKeys.some((key) => keys.includes(key));
}

/**
 * The earliest `startTime` of a LATER record over the same transcript / native session, else
 * undefined: transcript records at or after it belong to that record. Never inside a `codemie hook`
 * process; in `codemie analytics` only as the fallback bound of a run with no sibling in the loaded set.
 */
export async function nextRecordStart(record: Session): Promise<number | undefined> {
  return (await nextRecordStarts([record])).get(record.sessionId);
}

/**
 * `nextRecordStart` of every record in `records`, keyed by session id, from a single pass over the
 * sessions directory; a record with no same-transcript key or no start maps to undefined.
 */
export async function nextRecordStarts(records: Session[]): Promise<Map<string, number | undefined>> {
  const bounds = new Map<string, number | undefined>();
  const keyed: Array<{ record: Session; keys: string[] }> = [];
  for (const record of records) {
    const keys = await sameTranscriptKeys(record);
    bounds.set(record.sessionId, undefined);
    if (keys.length > 0 && typeof record.startTime === 'number') keyed.push({ record, keys });
  }
  if (keyed.length === 0) return bounds;

  const entries = await scanRecords(Math.min(...keyed.map(({ record }) => record.startTime)));
  for (const { record, keys } of keyed) {
    bounds.set(record.sessionId, await earliestLaterStart(record, entries, (other, entry) => sharesTranscript(keys, other, entry)));
  }
  return bounds;
}

/**
 * The earliest `startTime` of a LATER record of the same agent in the same working directory (by
 * realpath), else undefined: the bound of a record that names no transcript.
 */
export async function nextRecordStartInDirectory(record: Session): Promise<number | undefined> {
  if (!record.workingDirectory || typeof record.startTime !== 'number') return undefined;
  const directory = safeRealpath(record.workingDirectory);

  const { sessionId, startTime } = record;
  return earliestLaterStart({ sessionId, startTime }, await scanRecords(startTime), async (other) =>
    other.agentName === record.agentName && !!other.workingDirectory && safeRealpath(other.workingDirectory) === directory
  );
}
