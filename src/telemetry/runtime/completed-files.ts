import { existsSync } from 'fs';
import { readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getSessionPath } from '@/agents/core/session/session-config.js';
import { logger } from '@/utils/logger.js';

/** Moves a renamed `completed_<id>*` set back to its live names; the `.json` last, so it marks a complete move. */
export async function restoreCompletedFiles(sessionId: string): Promise<void> {
  const sessionsDir = dirname(getSessionPath(sessionId));
  for (const suffix of ['_metrics.jsonl', '_conversation.jsonl', '.json']) {
    const from = join(sessionsDir, `completed_${sessionId}${suffix}`);
    const to = join(sessionsDir, `${sessionId}${suffix}`);
    if (!existsSync(from)) {
      continue;
    }
    if (!existsSync(to)) {
      await rename(from, to);
      continue;
    }
    // Two records are never concatenated: beside a live `.json` the completed one is left as it is
    if (suffix === '.json') {
      continue;
    }
    // Lines written under the live name since the rename go after the completed ones, never over them.
    // A live file already starting with the completed lines is a merge a crash cut short before the unlink.
    // ponytail: a live file whose own lines repeat the completed ones byte for byte reads as merged
    const completed = await readFile(from);
    const live = await readFile(to);
    if (!live.subarray(0, completed.length).equals(completed)) {
      const merged = `${to}.restore.tmp`;
      await writeFile(merged, Buffer.concat([completed, live]));
      await rename(merged, to);
    }
    await unlink(from);
  }
  logger.info('[desktop-telemetry] Restored the completed files of a reopened session', { sessionId });
}
