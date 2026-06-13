/**
 * Session polling helper.
 *
 * Waits for a session conversation file containing a given marker string to
 * appear in a sessions directory. Needed because onSessionEnd may still be
 * writing/renaming files when the agent process returns — files appear as
 * either `{id}_conversation.jsonl` (mid-write) or
 * `completed_{id}_conversation.jsonl` (after rename).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionPollOptions {
  /** Maximum time to wait in milliseconds. Default: 30 000 */
  timeoutMs?: number;
  /** Polling interval in milliseconds. Default: 1 000 */
  intervalMs?: number;
}

export interface SessionPollResult {
  /** Session ID (with completed_ prefix if renamed), or null if timed out */
  sessionId: string | null;
  /** Human-readable description of sessions dir contents for error messages */
  dirContents: string;
}

/**
 * Poll a sessions directory until a `*_conversation.jsonl` file containing
 * `marker` appears, then return its session ID.
 *
 * Returns `{ sessionId: null, dirContents }` if the timeout is reached without
 * finding a match — callers should assert `sessionId !== null` with
 * `dirContents` in the failure message.
 */
export async function pollForSession(
  sessionsDir: string,
  marker: string,
  options: SessionPollOptions = {},
): Promise<SessionPollResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1_000;

  let sessionId: string | null = null;
  const pollStart = Date.now();

  while (sessionId === null && Date.now() - pollStart < timeoutMs) {
    if (existsSync(sessionsDir)) {
      for (const fileName of readdirSync(sessionsDir).filter(f => f.endsWith('_conversation.jsonl'))) {
        try {
          if (readFileSync(join(sessionsDir, fileName), 'utf-8').includes(marker)) {
            sessionId = fileName.replace('_conversation.jsonl', '');
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (sessionId === null) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  let dirContents = '(dir missing)';
  if (existsSync(sessionsDir)) {
    try {
      dirContents = readdirSync(sessionsDir).join(', ') || '(empty)';
    } catch {
      dirContents = '(read error)';
    }
  }

  return { sessionId, dirContents };
}
