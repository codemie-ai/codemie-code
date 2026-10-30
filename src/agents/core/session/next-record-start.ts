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

interface MemoEntry {
  mtimeMs: number;
  record: Session | null;
  keys?: string[];
}

/** Per-process memo of parsed record files: a file is parsed again only when its mtime changes. */
const recordMemo = new Map<string, MemoEntry>();

function safeRealpath(path: string): string {
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
 * ponytail: a copilot `--continue` run bounds nothing until its SessionEnd links it.
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
      return id && id !== 'unknown' ? [`copilot-cli:${id}`] : [];
    }
    case 'opencode':
    case 'opencode-acp':
      return record.workingDirectory ? [`opencode:${safeRealpath(record.workingDirectory)}`] : [];
    case 'codemie-code':
      return record.workingDirectory ? [`codemie-code:${safeRealpath(record.workingDirectory)}`] : [];
    case 'pi': {
      const { readPiRunLedger } = await import('../../plugins/pi/pi.extension.js');
      const ledger = await readPiRunLedger(record.sessionId);
      return ledger.transcripts.map((path) => `pi:${path}`);
    }
    default:
      return [];
  }
}

/**
 * The earliest `startTime` of a LATER record in the sessions directory (live or `completed_`) that
 * `matches`, else undefined.
 *
 * ponytail: each call lists and stats the whole sessions directory (341 ms at 10 000 files);
 * a file is parsed at most once per process unless it changes.
 */
async function earliestLaterStart(
  record: { sessionId: string; startTime: number },
  matches: (other: Session, entry: MemoEntry) => Promise<boolean>
): Promise<number | undefined> {
  const sessionsDir = getCodemiePath('sessions');
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return undefined;
  }

  let next: number | undefined;
  for (const name of names) {
    if (!RECORD_FILE_NAME.test(name)) continue;
    const path = join(sessionsDir, name);
    const info = await stat(path).catch(() => null);
    // A later record is written after its own start, so an older file cannot be one
    if (!info || info.mtimeMs < record.startTime) continue;

    let entry = recordMemo.get(path);
    if (!entry || entry.mtimeMs !== info.mtimeMs) {
      let parsed: Session | null;
      try {
        parsed = JSON.parse(await readFile(path, 'utf-8')) as Session;
      } catch {
        parsed = null;
      }
      entry = { mtimeMs: info.mtimeMs, record: parsed };
      recordMemo.set(path, entry);
    }
    const other = entry.record;
    if (!other || other.sessionId === record.sessionId || typeof other.startTime !== 'number') continue;
    if (other.startTime <= record.startTime || (next !== undefined && other.startTime >= next)) continue;

    if (await matches(other, entry)) {
      next = other.startTime;
    }
  }
  return next;
}

/**
 * The earliest `startTime` of a LATER record over the same transcript / native session, else
 * undefined: transcript records at or after it belong to that record. Only for a wrapper or the
 * daemon — never inside a `codemie hook` process, never in `codemie analytics`.
 */
export async function nextRecordStart(record: Session): Promise<number | undefined> {
  const keys = await sameTranscriptKeys(record);
  if (keys.length === 0 || typeof record.startTime !== 'number') return undefined;

  return earliestLaterStart({ sessionId: record.sessionId, startTime: record.startTime }, async (other, entry) => {
    // A pi record's keys come from its run ledger, which grows without a write to the record file
    const otherKeys = other.agentName === 'pi' ? await sameTranscriptKeys(other) : (entry.keys ??= await sameTranscriptKeys(other));
    return otherKeys.some((key) => keys.includes(key));
  });
}

/**
 * The earliest `startTime` of a LATER record of the same agent in the same working directory (by
 * realpath), else undefined: the bound of a record that names no transcript.
 */
export async function nextRecordStartInDirectory(record: Session): Promise<number | undefined> {
  if (!record.workingDirectory || typeof record.startTime !== 'number') return undefined;
  const directory = safeRealpath(record.workingDirectory);

  return earliestLaterStart({ sessionId: record.sessionId, startTime: record.startTime }, async (other) =>
    other.agentName === record.agentName && !!other.workingDirectory && safeRealpath(other.workingDirectory) === directory
  );
}
