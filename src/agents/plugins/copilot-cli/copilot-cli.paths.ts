/**
 * Copilot CLI storage locations.
 *
 * Copilot honors `COPILOT_HOME` as an override of `~/.copilot`. Discovery that ignores it
 * silently returns zero sessions for anyone who sets it.
 */

import { join } from 'path';
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
