/**
 * The "Prompt reduction" line shared by `codemie analytics sync install` and `sync status`.
 *
 * Informational only: each run decides reduction per session from that session's own project
 * config (see `report/redact.ts#redactPayloadPerSession`), so a project whose committed
 * `.codemie/codemie-cli.config.json` turns it on is reduced even when it is not counted here.
 */

import { isReductionOn, readOptedInProjects } from '@/utils/analytics-reduction-setting.js';

function projectCount(count: number): string {
  return count === 1 ? '1 project' : `${count} projects`;
}

/** Text after `Prompt reduction:`. Never throws: a failed read reports `unknown`. */
export async function reductionStatusText(): Promise<string> {
  try {
    if (await isReductionOn({ configDirs: [] })) {
      return 'on globally (every session is reduced)';
    }
    const projects = await readOptedInProjects();
    if (projects === 'unreadable') {
      return 'off globally; opted-in project list unreadable';
    }
    return projects.length > 0 ? `off globally; on for ${projectCount(projects.length)} on this machine` : 'off globally';
  } catch {
    return 'unknown (the setting could not be read)';
  }
}
