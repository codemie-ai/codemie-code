/** Plugin manifest parsing shared with read-only discovery. */
import { logger } from '../../utils/logger.js';
import { hasManifest, parseManifest as parseManifestQuietly } from './manifest-readonly.js';
import type { PluginManifest } from './types.js';

export { expandPluginRoot, expandPluginRootDeep, hasManifest } from './manifest-readonly.js';

export async function parseManifest(pluginDir: string): Promise<PluginManifest> {
  if (!hasManifest(pluginDir)) {
    logger.debug(`[plugin] No manifest found in ${pluginDir}, deriving from directory name`);
  }
  return parseManifestQuietly(pluginDir);
}
