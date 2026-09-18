/**
 * Gemini CLI storage locations.
 *
 * Gemini honors `GEMINI_HOME` as an override of `~/.gemini`. Discovery that ignores it
 * silently returns zero sessions for anyone who sets it.
 */

import { join } from 'path';
import { resolveHomeDir } from '../../../utils/paths.js';

/** `~/.gemini`, or `$GEMINI_HOME` when set. */
export function getGeminiHome(): string {
  const override = process.env.GEMINI_HOME?.trim();
  if (override) {
    return override;
  }
  return resolveHomeDir('.gemini');
}

/** Root of per-project session hash directories: `<geminiHome>/tmp`. */
export function getGeminiTmpRoot(): string {
  return join(getGeminiHome(), 'tmp');
}
