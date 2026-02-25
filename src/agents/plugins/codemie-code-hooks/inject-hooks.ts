/**
 * Hooks Plugin Injection Utility
 *
 * Writes the shell-hooks plugin to a temp file and returns its file:// URL
 * for injection into OpenCode's plugin array via OPENCODE_CONFIG_CONTENT.
 *
 * Lifecycle:
 * 1. beforeRun: getHooksPluginFileUrl() writes plugin to /tmp/codemie-hooks/shell-hooks.ts
 * 2. opencode binary loads plugin from file:// URL
 * 3. process exit: cleanup handler removes temp file (best effort)
 */

import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../../../utils/logger.js';
import { SHELL_HOOKS_PLUGIN_SOURCE } from './shell-hooks-source.js';

const HOOKS_TEMP_DIR = join(tmpdir(), 'codemie-hooks');
const HOOKS_FILE_NAME = 'shell-hooks.ts';

let pluginFilePath: string | null = null;
let cleanupRegistered = false;

/**
 * Register process exit handler for temp file cleanup (best effort).
 * Only registers once.
 */
function registerCleanupHandler(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  process.on('exit', () => {
    cleanupHooksPlugin();
  });
}

/**
 * Write the shell-hooks plugin to a temp file and return its file:// URL.
 * Idempotent — reuses the same file path if already written.
 */
export function getHooksPluginFileUrl(): string {
  if (pluginFilePath) {
    return `file://${pluginFilePath}`;
  }

  mkdirSync(HOOKS_TEMP_DIR, { recursive: true });
  pluginFilePath = join(HOOKS_TEMP_DIR, HOOKS_FILE_NAME);

  writeFileSync(pluginFilePath, SHELL_HOOKS_PLUGIN_SOURCE, 'utf-8');
  registerCleanupHandler();
  logger.debug(`[hooks] Wrote shell-hooks plugin to ${pluginFilePath}`);

  return `file://${pluginFilePath}`;
}

/**
 * Clean up temp plugin files (best effort).
 * Called on process exit and can be called explicitly.
 */
export function cleanupHooksPlugin(): void {
  if (!pluginFilePath) return;

  try {
    unlinkSync(pluginFilePath);
    logger.debug(`[hooks] Cleaned up plugin: ${pluginFilePath}`);
  } catch {
    // Ignore — file may already be deleted
  }
  pluginFilePath = null;
}
