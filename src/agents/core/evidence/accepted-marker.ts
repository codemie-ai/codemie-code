import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptedFileName, endedFileName, evidenceDir, publish } from './record-store.js';

/*
 * Destination markers (EPMCDME-17054): create-once sidecars keyed by recordKey(), written by the forwarder.
 * - accepted: the first time the backend accepts a consent session's publication with a verified echo (contract,
 *   destination `project`, bound project equal to the frozen one). It is the positive answer the legacy `/v1/metrics`
 *   gate waits for: until it exists, the backend has not confirmed that this user may publish to the project.
 * - ended: a final discard that ended the session's publication (`endsSessionDiscard`). The gate checks it before the
 *   acceptance, so an earlier acceptance never authorizes a legacy send after the spool status that also recorded the
 *   discard is swept.
 * Both outlive the swept spool status and share the evidence record's retention (the ended one is swept only after the
 * accepted one). A marker the forwarder could not write is kept as an intent in the spool status and repaired from there
 * (see destination-intent.ts). Hold no project or path text.
 */

interface MarkerFile {
  schema: 1;
  session_id: string;
  at: number;
}

export type DestinationMarker = 'accepted' | 'ended';

const pathOf = (marker: DestinationMarker, key: string): string =>
  join(evidenceDir(), marker === 'accepted' ? acceptedFileName(key) : endedFileName(key));

/** Create-once; throws when it cannot be written (the caller decides whether that is fatal). */
export async function writeDestinationMarker(marker: DestinationMarker, key: string, sessionId: string): Promise<void> {
  const file: MarkerFile = { schema: 1, session_id: sessionId.slice(0, 200), at: Date.now() };
  await mkdir(evidenceDir(), { recursive: true, mode: 0o700 });
  await publish(pathOf(marker, key), JSON.stringify(file), { strict: true });
}

/** Create-once; throws when it cannot be written. */
export function writeAccepted(key: string, sessionId: string): Promise<void> {
  return writeDestinationMarker('accepted', key, sessionId);
}

export type MarkerPresence = 'present' | 'absent' | 'unknown';

async function presence(marker: DestinationMarker, key: string, corrupt: MarkerPresence): Promise<MarkerPresence> {
  try {
    const m = JSON.parse(await readFile(pathOf(marker, key), 'utf-8')) as Partial<MarkerFile>;
    return m.schema === 1 && typeof m.at === 'number' ? 'present' : corrupt;
  } catch (err) {
    if (err instanceof SyntaxError) return corrupt;
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

export type AcceptedState = 'accepted' | 'absent' | 'unknown';

/** Whether the backend accepted the session's publication. Only a whole, well-formed marker counts as accepted. */
export async function acceptedState(key: string): Promise<AcceptedState> {
  const state = await presence('accepted', key, 'absent'); // corrupt: not a confirmation
  return state === 'present' ? 'accepted' : state;
}

/** Whether a final discard ended the session's publication. Fail closed: a corrupt marker counts as ended. */
export function endedState(key: string): Promise<MarkerPresence> {
  return presence('ended', key, 'present');
}
