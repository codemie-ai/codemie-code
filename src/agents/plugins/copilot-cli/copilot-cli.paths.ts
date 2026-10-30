/**
 * Copilot CLI storage locations.
 *
 * Copilot honors `COPILOT_HOME` as an override of `~/.copilot`. Discovery that ignores it
 * silently returns zero sessions for anyone who sets it.
 */

import { join, resolve } from 'path';
import { resolveHomeDir } from '../../../utils/paths.js';

/** `~/.copilot`, or `$COPILOT_HOME` when set. */
export function getCopilotHome(): string {
  const override = process.env.COPILOT_HOME?.trim();
  if (override) {
    return override;
  }
  return resolveHomeDir('.copilot');
}

/** Directory holding one subdirectory per session. */
export function getCopilotSessionStateRoot(): string {
  return join(getCopilotHome(), 'session-state');
}

/** Default (non-overridden) session-state root, evaluated at call time. */
export function getDefaultCopilotSessionStateRoot(): string {
  return join(resolveHomeDir('.copilot'), 'session-state');
}

/** Path equality ignoring trailing separators; case-insensitive on Windows. */
export function sameDirectory(a: string, b: string): boolean {
  const normalize = (p: string): string => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
}
