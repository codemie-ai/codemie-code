/**
 * The analytics project of one Cowork session, fixed once: `~/.codemie/analytics/state/<cliSessionId>.cowork-attribution.json`.
 * Written before the session's first analytics events reach the spool and never changed afterwards, so adding, removing
 * or reordering folders, working in another project's folder or restarting the daemon cannot move the session to
 * another project. Kept apart from the cursor (which is saved only after the events are spooled) and from the served
 * mark (which the request path rewrites).
 *
 * Also the one place that decides whether the forwarder may declare a session CodeMie-funded: a daemon-written served
 * mark (the daemon answered a request of this session) plus a pin that names the project the spool sends under.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { coworkServedMarkPath } from './cowork-served-mark.js';
import { withSessionLock } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/session-lock.js';
import { AnalyticsSourceError } from '@/utils/errors.js';

export type CoworkProjectSource = 'linked_folder' | 'profile' | 'none';

export interface CoworkAttribution {
  /** The non-empty project every event is stamped with. Unresolved projects are retried, never pinned. */
  project: string;
  /** Where the project came from, as the backend's `Project-Source` header. */
  projectSource: CoworkProjectSource;
}

const SOURCES: readonly string[] = ['linked_folder', 'profile', 'none'];

function attributionPath(cliSessionId: string): string {
  return getCodemiePath('analytics', 'state', `${cliSessionId}.cowork-attribution.json`);
}

/** Reads the pin file: the pin, 'corrupt' (not JSON or of another shape), or null when missing. Any other I/O error (permissions, a directory, ...) is thrown, never taken for "no pin". */
async function readPin(cliSessionId: string): Promise<CoworkAttribution | 'corrupt' | null> {
  let text: string;
  try {
    text = await readFile(attributionPath(cliSessionId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<CoworkAttribution> | null;
    if (typeof parsed?.project !== 'string' || !parsed.project || typeof parsed.projectSource !== 'string' || !SOURCES.includes(parsed.projectSource)) return 'corrupt';
    return { project: parsed.project, projectSource: parsed.projectSource };
  } catch {
    return 'corrupt';
  }
}

/**
 * The pin of a session; null when there is none, the file is corrupt or it cannot be read. The caller then resolves again,
 * but a project the spool already holds for the session is kept (see `pinAttribution`), so an unreadable pin cannot move a session.
 */
export async function loadCoworkAttribution(cliSessionId: string): Promise<CoworkAttribution | null> {
  try {
    const pin = await readPin(cliSessionId);
    return pin === 'corrupt' ? null : pin;
  } catch {
    return null;
  }
}

/**
 * Publishes the pin atomically and write-once under the daemon's session lock: an existing valid pin is returned and
 * corrupt JSON is replaced. Other read failures (permissions, I/O) leave the file alone and retry next processing.
 * The only writer is the Cowork producer, which the runner serializes per session; no cross-process lock is claimed.
 * Returns the pin now in effect.
 */
export async function saveCoworkAttribution(cliSessionId: string, attribution: CoworkAttribution): Promise<CoworkAttribution> {
  if (!attribution.project) throw new AnalyticsSourceError('An unresolved project must not be pinned');
  return withSessionLock(cliSessionId, async () => {
    const path = attributionPath(cliSessionId);
    await mkdir(dirname(path), { recursive: true });
    const existing = await readPin(cliSessionId);
    if (existing && existing !== 'corrupt') return existing;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(attribution), 'utf-8');
      await rename(temp, path);
      return attribution;
    } finally {
      await rm(temp, { force: true });
    }
  });
}

/**
 * The `Project-Source` to send with a CodeMie-funded declaration for `project`, or undefined when the session may not
 * claim it: no served mark (nothing proves the daemon served it, e.g. a session collected before marks existed), no
 * pin, a pin of another project, or no source (the backend would then route by repository or default project and
 * could move the session).
 */
export async function coworkFundingSource(cliSessionId: string, project: string): Promise<'linked_folder' | 'profile' | undefined> {
  if (!project || !existsSync(coworkServedMarkPath(cliSessionId))) return undefined;
  const pin = await loadCoworkAttribution(cliSessionId);
  if (!pin || pin.project.toLowerCase() !== project.toLowerCase() || pin.projectSource === 'none') return undefined;
  return pin.projectSource;
}
