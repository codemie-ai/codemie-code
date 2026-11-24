/**
 * Finds the `events.jsonl` of a CodeMie record. "None" is an answer the caller acts on for good, and a run
 * recorded under another session is a defect at any rate, so neither is given while a candidate is unread:
 * a session whose `mtime` passed the window and whose read failed, or an in-window start whose `cwd` could
 * not be resolved, could be the run's own, and the lookup throws, even when another session matched. A
 * failed `stat` leaves the `mtime` unknown, and one old denied directory must not stop every run in that
 * home: it stands in the way of "none" only.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { join } from 'path';
import { isSafeSessionId } from '../../core/session-id.js';
import { assertSessionStateListable, transcriptExists, unlessAbsent } from '../../core/session/no-transcript-correlation.js';
import type { Session } from '../../core/session/types.js';
import type { CopilotSessionStartData } from './copilot-cli-event-types.js';
import { FULL_SESSION_UUID } from './copilot-cli.constants.js';
import { getCopilotSessionStateRoot } from './copilot-cli.paths.js';
import { parseCopilotEvents } from './copilot-cli.storage-utils.js';

const SESSION_ID_SHAPE = '00000000-0000-0000-0000-000000000000';

/**
 * Whether a stored native session id can name its own directory under the session-state root: `unknown` is the
 * placeholder of no id, and `.` stays in the root, which the shared id check lets through.
 */
export function isNativeIdSegment(id: string | undefined): id is string {
  return !!id && id !== 'unknown' && id !== '.' && isSafeSessionId(id);
}

/**
 * A `--resume` value that is a strict prefix of a session id (hex digits and dashes in the id's shape), lower-cased.
 * A hex-shaped session name is read as a prefix too: it narrows the lookup only while that locates something,
 * else the session is found by the window like any name.
 */
function resumedIdPrefix(resumed: string | undefined): string | undefined {
  const value = resumed?.trim().toLowerCase();
  if (!value || FULL_SESSION_UUID.test(value)) return undefined;
  return SESSION_ID_SHAPE.startsWith(value.replace(/[0-9a-f]/g, '0')) ? value : undefined;
}

/** Every session directory name under the root; none when the root does not exist. */
function sessionDirNames(root: string): string[] {
  const entries = unlessAbsent(() => readdirSync(root, { withFileTypes: true })) ?? [];
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** The path resolved; the path itself when it no longer exists, a run directory deleted since, say. */
function realpathOrSelf(path: string): string {
  return unlessAbsent(() => realpathSync(path)) ?? path;
}

/**
 * The transcript whose latest `session.start` / `session.resume` in [from, until) ran in `runCwd`.
 * A failed `stat` goes on `statErrors` and the scan goes on; a candidate that could not be read throws.
 */
function latestStartInWindow(
  paths: string[],
  from: number,
  until: number | undefined,
  runCwd: string,
  statErrors: unknown[]
): string | undefined {
  let best: { path: string; at: number } | undefined;
  for (const path of paths) {
    // A session directory with no `events.jsonl` is a session with nothing to read, not a failed read
    let modifiedAt: number | undefined;
    try {
      modifiedAt = unlessAbsent(() => statSync(path).mtimeMs);
    } catch (error) {
      statErrors.push(error);
      continue;
    }
    if (modifiedAt === undefined || modifiedAt < from) continue;
    const text = unlessAbsent(() => readFileSync(path, 'utf-8'));
    if (text === undefined) continue;
    for (const event of parseCopilotEvents(text, path)) {
      if (event.type !== 'session.start' && event.type !== 'session.resume') continue;
      const at = Date.parse(event.timestamp ?? '');
      const cwd = (event.data as CopilotSessionStartData | undefined)?.context?.cwd;
      if (!Number.isFinite(at) || at < from || (until !== undefined && at >= until)) continue;
      if (!cwd || realpathOrSelf(cwd) !== runCwd) continue;
      if (!best || at > best.at) best = { path, at };
    }
  }
  return best?.path;
}

/**
 * The `events.jsonl` of a record that names none, under the record's `agentHome` (the process
 * environment's home for a record without it): a pinned run's (native id = the CodeMie id), a
 * `--resume <id>` run's (its stored native id), else the session started or resumed in the run's window
 * (its start → the start of the next copilot record in the same directory) in the run's directory — the
 * latest such event wins. A `--resume <id prefix>` run searches the sessions whose id starts with the
 * prefix first, all of them when those locate none and none of them failed; `--continue` and a session
 * name are matched by the window alone.
 *
 * Empty when none was found. A match is returned whatever `stat` failed. Throws when:
 * - the record's `agentHome` has no listable `session-state` ({@link assertSessionStateListable}); the process
 *   environment's home has no such rule, a missing root there holds no sessions;
 * - the root, the run's directory or a pinned or resumed transcript could not be read;
 * - a session whose `mtime` passed the window could not be read, or an in-window start's `cwd` could not be
 *   resolved, whatever else matched;
 * - a scan matched nothing and a `stat` in it failed: the first such error. In the prefixed sessions this
 *   leaves no fallback to all of them: the user named that session.
 *
 * ponytail: two runs selecting a session in one directory at once are indistinguishable
 */
export async function locateCopilotTranscript(record: Session): Promise<string[]> {
  assertSessionStateListable(record);
  const root = getCopilotSessionStateRoot(record.agentHome);
  const eventsOf = (id: string) => join(root, id, 'events.jsonl');

  if (transcriptExists(eventsOf(record.sessionId))) {
    return [eventsOf(record.sessionId)];
  }
  const resumedId = record.correlation?.agentSessionId;
  if (isNativeIdSegment(resumedId) && transcriptExists(eventsOf(resumedId))) {
    return [eventsOf(resumedId)];
  }

  const dirNames = sessionDirNames(root);
  const prefix = resumedIdPrefix(record.resumeSessionId);
  const runCwd = realpathOrSelf(record.workingDirectory);
  const { nextRecordStartInDirectory } = await import('../../core/session/next-record-start.js');
  const until = await nextRecordStartInDirectory(record);
  const locate = (names: string[]) => {
    const statErrors: unknown[] = [];
    const match = latestStartInWindow(names.map(eventsOf), record.startTime, until, runCwd, statErrors);
    if (!match && statErrors.length > 0) throw statErrors[0];
    return match;
  };
  const byPrefix = prefix ? dirNames.filter((name) => name.toLowerCase().startsWith(prefix)) : [];
  const located = (byPrefix.length > 0 ? locate(byPrefix) : undefined) ?? locate(dirNames);
  return located ? [located] : [];
}
