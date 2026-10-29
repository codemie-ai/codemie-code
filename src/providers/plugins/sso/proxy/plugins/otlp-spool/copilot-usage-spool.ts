import { readFile } from 'node:fs/promises';
import { streamFile } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';

/** The wire events already in a session's hooks spool (read under the session lock). */
export async function listHookRecords(sessionId: string): Promise<Record<string, unknown>[]> {
  return withSessionLock(sessionId, async () => {
    let text: string;
    try {
      text = await readFile(streamFile(sessionId, 'hooks'), 'utf-8');
    } catch {
      return [];
    }
    const out: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse((JSON.parse(line) as { hookEvent: string }).hookEvent) as Record<string, unknown>);
      } catch {
        // skip malformed record
      }
    }
    return out;
  });
}
