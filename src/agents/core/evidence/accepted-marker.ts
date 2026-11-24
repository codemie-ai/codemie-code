import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptedFileName, endedFileName, evidenceDir, projectTag, publish } from './record-store.js';

/*
 * Destination markers (EPMCDME-17054): create-once sidecars keyed by recordKey(), written by the forwarder.
 * - accepted: the first time the backend accepts a consent session's publication to a project with a verified echo
 *   (contract, destination `project`, bound project equal to the frozen one). One per accepted project (its tag in the
 *   file name): the legacy `/v1/metrics` gate reads the one for the project it is about to send, so a session accepted
 *   for project A and resumed under project B is unconfirmed for B until the backend accepts B.
 * - ended: a final discard that ended the session's publication (`endsSessionDiscard`). The gate checks it before any
 *   acceptance, so an earlier acceptance never authorizes a legacy send after the spool status that also recorded the
 *   discard is swept.
 * Both outlive the swept spool status and share the evidence record's retention (the ended one is swept only after every
 * accepted one). A marker the forwarder could not write is kept as an intent in the spool status and repaired from there
 * (see destination-intent.ts). Hold no project or path text.
 */

interface MarkerFile {
  schema: 1;
  session_id: string;
  at: number;
}

/** Which marker: an acceptance for the project with this tag (`projectTag`), or the end. */
export type DestinationMarker = { marker: 'accepted'; projectTag: string } | { marker: 'ended' };

const pathOf = (target: DestinationMarker, key: string): string =>
  join(evidenceDir(), target.marker === 'accepted' ? acceptedFileName(key, target.projectTag) : endedFileName(key));

/** Create-once; throws when it cannot be written (the caller decides whether that is fatal). */
export async function writeDestinationMarker(target: DestinationMarker, key: string, sessionId: string): Promise<void> {
  const file: MarkerFile = { schema: 1, session_id: sessionId.slice(0, 200), at: Date.now() };
  await mkdir(evidenceDir(), { recursive: true, mode: 0o700 });
  await publish(pathOf(target, key), JSON.stringify(file), { strict: true });
}

/** The backend accepted the session's publication to `project`. Create-once; throws when it cannot be written. */
export function writeAccepted(key: string, sessionId: string, project: string): Promise<void> {
  return writeDestinationMarker({ marker: 'accepted', projectTag: projectTag(project) }, key, sessionId);
}

export type MarkerPresence = 'present' | 'absent' | 'unknown';

async function presence(target: DestinationMarker, key: string, corrupt: MarkerPresence): Promise<MarkerPresence> {
  try {
    const m = JSON.parse(await readFile(pathOf(target, key), 'utf-8')) as Partial<MarkerFile>;
    return m.schema === 1 && typeof m.at === 'number' ? 'present' : corrupt;
  } catch (err) {
    if (err instanceof SyntaxError) return corrupt;
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

export type AcceptedState = 'accepted' | 'absent' | 'unknown';

/** Whether the backend accepted the session's publication to `project`. Only a whole, well-formed marker counts. */
export async function acceptedState(key: string, project: string): Promise<AcceptedState> {
  const state = await presence({ marker: 'accepted', projectTag: projectTag(project) }, key, 'absent'); // corrupt: not a confirmation
  return state === 'present' ? 'accepted' : state;
}

/** Whether a final discard ended the session's publication. Fail closed: a corrupt marker counts as ended. */
export function endedState(key: string): Promise<MarkerPresence> {
  return presence({ marker: 'ended' }, key, 'present');
}
