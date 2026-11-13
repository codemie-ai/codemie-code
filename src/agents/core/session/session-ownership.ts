import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getCodemiePath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';

/** Agent names whose session records hold Claude Code native ids. */
const CLAUDE_AGENT_NAMES = new Set(['claude', 'claude-acp']);

/** Prefix of session files renamed on SessionEnd (`completed_<id>[-<generation>].json`). */
const COMPLETED_PREFIX = 'completed_';

interface SessionRecordFile {
  sessionId?: string;
  agentName?: string;
  correlation?: { agentSessionId?: string };
}

export interface ResumeSessionMatch {
  /** False when no session record matches the id. */
  owned: boolean;
  /** Native Claude id to pass to `claude -r`; absent when the record has no usable native id. */
  nativeId?: string;
  /** `sessionId` of the matched record. */
  codemieSessionId?: string;
}

interface LoadedRecord {
  fileName: string;
  record: SessionRecordFile;
  mtimeMs: number;
}

/** A native id is usable unless it is missing, 'unknown', or the placeholder equal to the CodeMie id. */
function usableNativeId(record: SessionRecordFile): string | undefined {
  const native = record.correlation?.agentSessionId;
  if (!native || native === 'unknown' || native === record.sessionId) {
    return undefined;
  }
  return native;
}

/** The id analytics / `log list-sessions` show for a file: name minus `.json` and `completed_`. */
function displayedId(fileName: string): string {
  const base = fileName.slice(0, -'.json'.length);
  return base.startsWith(COMPLETED_PREFIX) ? base.slice(COMPLETED_PREFIX.length) : base;
}

/**
 * Ranking among records matching one CodeMie id: an exact displayed-id match (the
 * `<uuid>-<generation>` the user copied) first, then a record that has a usable native id,
 * then the most recently modified file.
 */
function isBetterMatch(candidate: LoadedRecord, current: LoadedRecord, resumeId: string): boolean {
  const candidateExact = displayedId(candidate.fileName) === resumeId;
  const currentExact = displayedId(current.fileName) === resumeId;
  if (candidateExact !== currentExact) return candidateExact;

  const candidateUsable = usableNativeId(candidate.record) !== undefined;
  const currentUsable = usableNativeId(current.record) !== undefined;
  if (candidateUsable !== currentUsable) return candidateUsable;

  return candidate.mtimeMs > current.mtimeMs;
}

function loadRecords(dir: string): LoadedRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) =>
        f.endsWith('.json') &&
        !f.endsWith('_metrics.json') &&
        !f.endsWith('-codemie-marker.json'),
    );
  } catch {
    return [];
  }

  const records: LoadedRecord[] = [];
  for (const fileName of files) {
    try {
      const path = join(dir, fileName);
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (parsed === null || typeof parsed !== 'object') {
        logger.debug(`[session-ownership] Skipping non-object session file: ${fileName}`);
        continue;
      }
      records.push({
        fileName,
        record: parsed as SessionRecordFile,
        mtimeMs: statSync(path).mtimeMs,
      });
    } catch {
      logger.debug(`[session-ownership] Skipping unreadable session file: ${fileName}`);
    }
  }
  return records;
}

/**
 * Resolve an id given to `--resume` against local session records.
 *
 * Accepts either the native Claude id (matches `correlation.agentSessionId`) or the CodeMie
 * session id shown by `codemie analytics` / `codemie log` (matches `record.sessionId` or the
 * displayed file id, which may carry a `-<generation>` suffix). A native-id match wins.
 */
export function resolveClaudeResumeSession(
  resumeId: string,
  sessionsDir?: string,
): ResumeSessionMatch {
  const records = loadRecords(sessionsDir ?? getCodemiePath('sessions'));

  const nativeMatch = records.find(
    ({ record }) => usableNativeId(record) === resumeId,
  );
  if (nativeMatch) {
    return {
      owned: true,
      nativeId: resumeId,
      codemieSessionId: nativeMatch.record.sessionId,
    };
  }

  const codemieMatches = records.filter(
    ({ fileName, record }) =>
      (!record.agentName || CLAUDE_AGENT_NAMES.has(record.agentName)) &&
      (record.sessionId === resumeId || displayedId(fileName) === resumeId),
  );
  if (codemieMatches.length === 0) {
    return { owned: false };
  }

  const best = codemieMatches.reduce((top, candidate) =>
    isBetterMatch(candidate, top, resumeId) ? candidate : top,
  );
  return {
    owned: true,
    nativeId: usableNativeId(best.record),
    codemieSessionId: best.record.sessionId,
  };
}

export function scanSessionsForClaudeId(
  claudeSessionId: string,
  sessionsDir?: string,
): boolean {
  return resolveClaudeResumeSession(claudeSessionId, sessionsDir).owned;
}
