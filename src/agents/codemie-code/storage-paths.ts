/**
 * Storage path overrides for OpenCode integration
 *
 * This module ensures that the built-in codemie-code agent (OpenCode-powered)
 * uses a separate storage path from the external opencode plugin to avoid conflicts.
 */

import { getCodemiePath } from '../../utils/paths.js';

/**
 * Base storage path for OpenCode sessions within CodeMie directory
 * Uses: ~/.codemie/opencode-sessions/
 */
export const OPENCODE_STORAGE_BASE = getCodemiePath('opencode-sessions');

/**
 * Patch OpenCode storage paths to use CodeMie directory structure
 *
 * This function should be called before initializing any OpenCode components
 * to ensure proper path isolation.
 */
export function patchOpenCodePaths(): void {
  // Set environment variable to override OpenCode's default storage path
  // OpenCode uses XDG_DATA_HOME or ~/.opencode by default
  // We redirect it to ~/.codemie/opencode-sessions/ to avoid conflicts
  process.env.OPENCODE_STORAGE_PATH = OPENCODE_STORAGE_BASE;

  // Log the override for debugging
  if (process.env.CODEMIE_DEBUG === 'true') {
    console.log(`[OpenCode Adapter] Storage path set to: ${OPENCODE_STORAGE_BASE}`);
  }
}
