/**
 * Git Utilities
 *
 * Helper functions for git operations.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const execAsync = promisify(exec);

/**
 * Detect current git branch from working directory
 *
 * @param cwd - Working directory path
 * @returns Git branch name or undefined if not in a git repo
 */
export async function detectGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      timeout: 5000 // 5 second timeout
    });

    const branch = stdout.trim();

    // Handle detached HEAD state
    if (branch === 'HEAD') {
      logger.debug('[GitUtils] Detached HEAD state detected');
      return undefined;
    }

    logger.debug(`[GitUtils] Detected git branch: ${branch}`);
    return branch;
  } catch (error) {
    // Not a git repo or git command failed
    logger.debug('[GitUtils] Failed to detect git branch:', error);
    return undefined;
  }
}
