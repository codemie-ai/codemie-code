/**
 * The exclusion mark of the local mode: an empty file named by a session id, left when the session fired a hook in a
 * folder the developer's filters leave out. Nothing more of a marked session is gathered.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';

/** The directory of the exclusion marks. */
export function excludedSessionsRoot(): string {
  return getCodemiePath('analytics', 'excluded');
}

/** Leaves the mark of `sessionId`; an id that is not a safe file name is ignored. */
export async function markSessionExcluded(sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined || !isSafeSessionId(sessionId)) return;
  await mkdir(excludedSessionsRoot(), { recursive: true, mode: 0o700 });
  await writeFile(join(excludedSessionsRoot(), sessionId), '', { mode: 0o600 });
}

/** Whether `sessionId` carries the mark. */
export async function isSessionExcluded(sessionId: string | undefined): Promise<boolean> {
  if (sessionId === undefined || !isSafeSessionId(sessionId)) return false;
  try {
    await stat(join(excludedSessionsRoot(), sessionId));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
