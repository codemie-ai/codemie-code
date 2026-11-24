import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { logger } from '../../utils/logger.js';

const PLUGINS_TEMP_DIR = join(tmpdir(), 'codemie-hooks');

export interface PluginInjector {
  /** Write the plugin source to a temp file and return its file:// URL. Idempotent. */
  getPluginFileUrl(): string;
  /** Clean up temp plugin file (best effort). Safe to call multiple times. */
  cleanup(): void;
}

/**
 * Factory that creates a temp-file-backed plugin injector.
 *
 * Writes `source` to `<tmpdir>/codemie-hooks/<fileName>` on first call,
 * returns the `file://` URL, and registers a process-exit cleanup handler.
 *
 * @param fileName - Temp file name (e.g. 'shell-hooks.ts'), or a path below the temp dir
 *                   (e.g. 'my-plugin/index.ts') for a host that loads plugins from a directory
 * @param source   - Full plugin source code to write
 * @param logTag   - Label for log messages (e.g. 'hooks', 'reasoning-sanitizer')
 */
export function createPluginInjector(fileName: string, source: string, logTag: string): PluginInjector {
  let pluginFilePath: string | null = null;
  let cleanupRegistered = false;

  function cleanup(): void {
    if (!pluginFilePath) return;

    try {
      unlinkSync(pluginFilePath);
      logger.debug(`[${logTag}] Cleaned up plugin: ${pluginFilePath}`);
    } catch {
      // Ignore — file may already be deleted
    }
    removePluginDir(dirname(pluginFilePath));
    pluginFilePath = null;
  }

  /** A plugin's own directory goes with its file; the shared temp dir stays. */
  function removePluginDir(dir: string): void {
    if (dir === PLUGINS_TEMP_DIR) return;
    try {
      rmdirSync(dir);
    } catch {
      // Ignore — already removed, or another file still lives there
    }
  }

  function registerCleanupHandler(): void {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    process.on('exit', () => cleanup());
  }

  function getPluginFileUrl(): string {
    if (pluginFilePath) {
      return `file://${pluginFilePath}`;
    }

    pluginFilePath = join(PLUGINS_TEMP_DIR, fileName);
    mkdirSync(dirname(pluginFilePath), { recursive: true });

    writeFileSync(pluginFilePath, source, 'utf-8');
    registerCleanupHandler();
    logger.debug(`[${logTag}] Wrote plugin to ${pluginFilePath}`);

    return `file://${pluginFilePath}`;
  }

  return { getPluginFileUrl, cleanup };
}
