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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { coworkServedMarkPath } from './cowork-served-mark.js';

export type CoworkProjectSource = 'linked_folder' | 'profile' | 'none';

export interface CoworkAttribution {
  /** The project every event of the session is stamped with; `''` = none resolved (nothing is sent). */
  project: string;
  /** Where the project came from, as the backend's `Project-Source` header. */
  projectSource: CoworkProjectSource;
}

const SOURCES: readonly string[] = ['linked_folder', 'profile', 'none'];

function attributionPath(cliSessionId: string): string {
  return getCodemiePath('analytics', 'state', `${cliSessionId}.cowork-attribution.json`);
}

/** The pin of a session; null when there is none or the file is unreadable (the caller then falls back, never re-resolves blindly). */
export async function loadCoworkAttribution(cliSessionId: string): Promise<CoworkAttribution | null> {
  try {
    const parsed = JSON.parse(await readFile(attributionPath(cliSessionId), 'utf-8')) as Partial<CoworkAttribution> | null;
    if (typeof parsed?.project !== 'string' || typeof parsed.projectSource !== 'string' || !SOURCES.includes(parsed.projectSource)) return null;
    return { project: parsed.project, projectSource: parsed.projectSource };
  } catch {
    return null;
  }
}

/** Writes the pin through a temp file and a rename, so a reader never sees half of it. */
export async function saveCoworkAttribution(cliSessionId: string, attribution: CoworkAttribution): Promise<void> {
  const path = attributionPath(cliSessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(attribution), 'utf-8');
  await rename(`${path}.tmp`, path);
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
