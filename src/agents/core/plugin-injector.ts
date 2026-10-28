import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { logger } from '../../utils/logger.js';

const PLUGINS_TEMP_DIR = join(tmpdir(), 'codemie-hooks');

export interface PluginInjector {
  /** Write the plugin source to a temp file and return its file:// URL. Idempotent. */
  getPluginFileUrl(): string;
  /** Clean up temp plugin file (best effort). Safe to call multiple times. */
  cleanup(): void;
}

export interface PluginDirInjector {
  /** Write the plugin files to a temp directory and return its file:// URL. Idempotent. */
  getPluginDirUrl(): string;
  /** Clean up temp plugin directory (best effort). Safe to call multiple times. */
  cleanup(): void;
}

/**
 * Factory that creates a temp-file-backed plugin injector.
 *
 * Writes `source` to `<tmpdir>/codemie-hooks/<fileName>` on first call,
 * returns the `file://` URL, and registers a process-exit cleanup handler.
 *
 * @param fileName - Temp file name (e.g. 'shell-hooks.ts')
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
    pluginFilePath = null;
  }

  function registerCleanupHandler(): void {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    process.on('exit', () => cleanup());
  }

  function getPluginFileUrl(): string {
    if (pluginFilePath) {
      return pathToFileURL(pluginFilePath).href;
    }

    mkdirSync(PLUGINS_TEMP_DIR, { recursive: true });
    pluginFilePath = join(PLUGINS_TEMP_DIR, fileName);

    writeFileSync(pluginFilePath, source, 'utf-8');
    registerCleanupHandler();
    logger.debug(`[${logTag}] Wrote plugin to ${pluginFilePath}`);

    // Encode spaces/#/% and Windows drive paths for upstream fileURLToPath().
    return pathToFileURL(pluginFilePath).href;
  }

  return { getPluginFileUrl, cleanup };
}

/**
 * Factory that creates a temp-directory-backed plugin injector (OpenCode 2.x,
 * whose plugin scanner accepts directories only and drops single-file
 * targets with a "configured plugin path must be a directory" warning).
 *
 * Writes each entry of `files` into `<tmpdir>/codemie-hooks/<dirName>/` on
 * first call, returns the `file://` directory URL, and registers a
 * process-exit cleanup handler.
 *
 * @param dirName - Temp directory name (e.g. 'shell-hooks-v2')
 * @param files - File name → full source code (e.g. { 'index.ts': source })
 * @param logTag - Label for log messages (e.g. 'hooks-v2')
 */
export function createPluginDirInjector(dirName: string, files: Record<string, string>, logTag: string): PluginDirInjector {
  let pluginDirPath: string | null = null;
  let cleanupRegistered = false;

  function cleanup(): void {
    if (!pluginDirPath) return;

    try {
      rmSync(pluginDirPath, { recursive: true, force: true });
      logger.debug(`[${logTag}] Cleaned up plugin dir: ${pluginDirPath}`);
    } catch {
      // Ignore — directory may already be deleted
    }
    pluginDirPath = null;
  }

  function registerCleanupHandler(): void {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    process.on('exit', () => cleanup());
  }

  function getPluginDirUrl(): string {
    if (pluginDirPath) {
      return pathToFileURL(pluginDirPath).href;
    }

    mkdirSync(PLUGINS_TEMP_DIR, { recursive: true });
    pluginDirPath = join(PLUGINS_TEMP_DIR, dirName);
    mkdirSync(pluginDirPath, { recursive: true });

    for (const [fileName, source] of Object.entries(files)) {
      writeFileSync(join(pluginDirPath, fileName), source, 'utf-8');
    }
    registerCleanupHandler();
    logger.debug(`[${logTag}] Wrote plugin dir to ${pluginDirPath}`);

    // A filesystem path is not a URL, especially on native Windows.
    return pathToFileURL(pluginDirPath).href;
  }

  return { getPluginDirUrl, cleanup };
}
