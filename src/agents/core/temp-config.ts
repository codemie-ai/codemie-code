import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { logger } from '../../utils/logger.js';

// Environment variable size limit (conservative - varies by platform)
// Linux: ~128KB per var, Windows: ~32KB total env block
export const MAX_ENV_SIZE = 32 * 1024;

// Track temp config files for cleanup on process exit
const tempConfigFiles: string[] = [];
let cleanupRegistered = false;

/**
 * Register process exit handler for temp file cleanup (best effort).
 * Only registers once, even if called multiple times.
 */
function registerCleanupHandler(agentTag: string): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  process.on('exit', () => {
    for (const file of tempConfigFiles) {
      try {
        unlinkSync(file);
        logger.debug(`[${agentTag}] Cleaned up temp config: ${file}`);
      } catch {
        // Ignore cleanup errors - file may already be deleted
      }
    }
  });
}

/**
 * Write config JSON to a temp file as fallback when env var size is exceeded.
 * Returns the temp file path.
 *
 * @param configJson - The JSON string to write
 * @param agentTag - Agent identifier for temp file naming and log messages (e.g. 'opencode', 'codemie-code')
 */
export function writeConfigToTempFile(configJson: string, agentTag: string): string {
  const configPath = join(
    tmpdir(),
    `codemie-${agentTag}-config-${process.pid}-${Date.now()}.json`
  );
  writeFileSync(configPath, configJson, 'utf-8');
  tempConfigFiles.push(configPath);
  registerCleanupHandler(agentTag);
  return configPath;
}
