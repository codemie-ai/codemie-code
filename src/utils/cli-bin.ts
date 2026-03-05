/**
 * CLI Binary Link Protection (Unix-only)
 *
 * When agent packages (e.g., @codemieai/codemie-opencode) are installed globally
 * via `npm install -g`, they may declare a `bin.codemie` entry that overwrites
 * the CodeMie CLI's own `codemie` binary symlink. This module detects and
 * restores the correct symlink after such installations.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from './exec.js';
import { logger } from './logger.js';

/**
 * Restore the global 'codemie' binary symlink if it was overwritten by an
 * agent package that declares the same bin name.
 *
 * After `npm install -g <agent-package>`, npm may replace the global `codemie`
 * symlink (which should point to @codemieai/code/bin/codemie.js) with the
 * agent's own binary (e.g., a Go binary from @codemieai/codemie-opencode).
 *
 * This function checks the symlink target and restores it if necessary,
 * using an atomic rename to avoid leaving a window where the binary is missing.
 */
export async function restoreCliBinLink(): Promise<void> {
  // Skip on Windows — npm global layout differs (no bin/ subdirectory)
  // and fs.rename over an existing path throws EPERM
  if (os.platform() === 'win32') {
    logger.debug('Skipping CLI binary link restore on Windows');
    return;
  }

  try {
    const prefixResult = await exec('npm', ['prefix', '-g']);
    if (prefixResult.code !== 0) return;

    const npmPrefix = prefixResult.stdout.trim();
    const globalBinPath = path.join(npmPrefix, 'bin', 'codemie');

    // Check if the path is a symlink; if not (e.g., regular file), skip.
    // On fresh installs the binary may not exist yet — return silently.
    let stat;
    try {
      stat = await fs.lstat(globalBinPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // Binary doesn't exist yet
      throw error;
    }
    if (!stat.isSymbolicLink()) return;

    // Read current symlink target
    const currentTarget = await fs.readlink(globalBinPath);

    // Our CLI wrapper ends with codemie.js — if the symlink points elsewhere
    // (e.g., the OpenCode Go binary), it was overwritten by the agent install
    if (currentTarget.endsWith('codemie.js')) {
      return; // Still correct
    }

    // Build the correct relative symlink target.
    // Use posix.join so the path always uses forward slashes (symlink targets are Unix paths).
    const correctTarget = path.posix.join(
      '..', 'lib', 'node_modules', '@codemieai', 'code', 'bin', 'codemie.js'
    );

    // Atomic restore: create temp symlink then rename over the old one
    const tmpPath = `${globalBinPath}.codemie-tmp-${process.pid}`;
    try {
      await fs.symlink(correctTarget, tmpPath);
      await fs.rename(tmpPath, globalBinPath);
    } catch (cause) {
      await fs.unlink(tmpPath).catch(() => {});
      throw new Error('Failed to atomically restore codemie symlink', { cause });
    }

    logger.debug('Restored codemie CLI binary link after agent update');
  } catch (error) {
    // Don't fail the update if we can't restore the bin link
    logger.debug('Could not verify/restore CLI binary link:', error);
  }
}
