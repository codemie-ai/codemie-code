import { existsSync } from 'fs';
import { cp, mkdir } from 'fs/promises';
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
  await cp(sourceDir, destDir, { recursive: true, force: true });
}
