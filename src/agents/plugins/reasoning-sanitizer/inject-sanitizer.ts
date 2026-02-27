/**
 * Reasoning Sanitizer Plugin Injection Utility
 *
 * Writes the reasoning-sanitizer plugin to a temp file and returns its file:// URL
 * for injection into OpenCode's plugin array via OPENCODE_CONFIG_CONTENT.
 *
 * Lifecycle:
 * 1. beforeRun: getReasoningSanitizerPluginUrl() writes plugin to /tmp/codemie-hooks/reasoning-sanitizer.ts
 * 2. opencode binary loads plugin from file:// URL
 * 3. process exit: cleanup handler removes temp file (best effort)
 */

import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../../../utils/logger.js';
import { REASONING_SANITIZER_PLUGIN_SOURCE } from './reasoning-sanitizer-source.js';

const SANITIZER_TEMP_DIR = join(tmpdir(), 'codemie-hooks');
const SANITIZER_FILE_NAME = 'reasoning-sanitizer.ts';

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
    cleanupReasoningSanitizerPlugin();
  });
}

/**
 * Write the reasoning-sanitizer plugin to a temp file and return its file:// URL.
 * Idempotent — reuses the same file path if already written.
 */
export function getReasoningSanitizerPluginUrl(): string {
  if (pluginFilePath) {
    return `file://${pluginFilePath}`;
  }

  mkdirSync(SANITIZER_TEMP_DIR, { recursive: true });
  pluginFilePath = join(SANITIZER_TEMP_DIR, SANITIZER_FILE_NAME);

  writeFileSync(pluginFilePath, REASONING_SANITIZER_PLUGIN_SOURCE, 'utf-8');
  registerCleanupHandler();
  logger.debug(`[reasoning-sanitizer] Wrote plugin to ${pluginFilePath}`);

  return `file://${pluginFilePath}`;
}

/**
 * Clean up temp plugin files (best effort).
 * Called on process exit and can be called explicitly.
 */
export function cleanupReasoningSanitizerPlugin(): void {
  if (!pluginFilePath) return;

  try {
    unlinkSync(pluginFilePath);
    logger.debug(`[reasoning-sanitizer] Cleaned up plugin: ${pluginFilePath}`);
  } catch {
    // Ignore — file may already be deleted
  }
  pluginFilePath = null;
}
