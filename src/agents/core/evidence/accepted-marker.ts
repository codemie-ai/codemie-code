import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptedFileName, evidenceDir, publish } from './record-store.js';

/*
 * Destination-accepted marker (EPMCDME-17054): a create-once sidecar keyed by recordKey(), written by the forwarder
 * the first time the backend accepts a consent session's publication with a verified echo (contract, destination
 * `project`, bound project equal to the frozen one). It is the positive answer the legacy `/v1/metrics` gate waits
 * for: until it exists, the backend has not confirmed that this user may publish to the project. It outlives the
 * swept spool status and shares the evidence record's retention. Holds no project or path text.
 */

interface AcceptedFile {
  schema: 1;
  session_id: string;
  at: number;
}

const pathOf = (key: string): string => join(evidenceDir(), acceptedFileName(key));

/** Create-once; throws when it cannot be written (the caller decides whether that is fatal). */
export async function writeAccepted(key: string, sessionId: string): Promise<void> {
  const marker: AcceptedFile = { schema: 1, session_id: sessionId.slice(0, 200), at: Date.now() };
  await mkdir(evidenceDir(), { recursive: true, mode: 0o700 });
  await publish(pathOf(key), JSON.stringify(marker), { strict: true });
}

export type AcceptedState = 'accepted' | 'absent' | 'unknown';

/** Whether the backend accepted the session's publication. Only a whole, well-formed marker counts as accepted. */
export async function acceptedState(key: string): Promise<AcceptedState> {
  try {
    const m = JSON.parse(await readFile(pathOf(key), 'utf-8')) as Partial<AcceptedFile>;
    return m.schema === 1 && typeof m.at === 'number' ? 'accepted' : 'absent';
  } catch (err) {
    if (err instanceof SyntaxError) return 'absent'; // corrupt: not a confirmation
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}
