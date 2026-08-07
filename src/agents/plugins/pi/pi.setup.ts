import { existsSync } from 'fs';
import { cp, mkdir } from 'fs/promises';
import { join } from 'path';
import { logger } from '@/utils/logger.js';
import { getPiAgentDir, getUserPiAgentDir } from './pi.paths.js';

export async function preparePiAgentDir(cwd: string = process.cwd()): Promise<void> {
  const sourceDir = getUserPiAgentDir();
  const destDir = getPiAgentDir(cwd);

  if (existsSync(destDir)) {
    logger.debug(`[pi-setup] CodeMie Pi agent dir already exists, skipping copy: ${destDir}`);
    return;
  }

  if (!existsSync(sourceDir)) {
    logger.warn(`[pi-setup] User Pi agent dir not found, starting fresh: ${sourceDir}`);
    await mkdir(destDir, { recursive: true });
    return;
  }

  logger.debug(`[pi-setup] Copying ${sourceDir} → ${destDir}`);
  try {
    const excludedSessionsDir = join(sourceDir, 'sessions');
    await cp(sourceDir, destDir, {
      recursive: true,
      force: true,
      filter: (source) => source !== excludedSessionsDir,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[pi-setup] Failed to copy user Pi agent dir, starting fresh: ${message}`);
    await mkdir(destDir, { recursive: true });
  }
}
