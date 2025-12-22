/**
 * Cross-platform utility to check if a command exists in PATH
 *
 * Uses 'where' on Windows, 'which' on Unix systems
 */

import os from 'os';
import { exec } from './exec.js';

/**
 * Check if a command is available in PATH
 *
 * @param command - Command name to check (e.g., 'npm', 'python', 'git')
 * @returns True if command exists, false otherwise
 */
export async function commandExists(command: string): Promise<boolean> {
  try {
    const isWindows = os.platform() === 'win32';
    // On Windows, use full path to where.exe to avoid shell: true deprecation (DEP0190)
    const whichCommand = isWindows ? 'C:\\Windows\\System32\\where.exe' : 'which';

    const result = await exec(whichCommand, [command]);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Get the full path to a command
 *
 * @param command - Command name to locate
 * @returns Full path to command, or null if not found
 */
export async function getCommandPath(command: string): Promise<string | null> {
  try {
    const isWindows = os.platform() === 'win32';
    // On Windows, use full path to where.exe to avoid shell: true deprecation (DEP0190)
    const whichCommand = isWindows ? 'C:\\Windows\\System32\\where.exe' : 'which';

    const result = await exec(whichCommand, [command]);

    if (result.code === 0) {
      // On Windows, 'where' can return multiple paths, take the first one
      // Split by any line ending (\n, \r\n, or \r) for maximum compatibility
      // This handles Unix (\n), Windows (\r\n), and old Mac (\r) line endings
      const paths = result.stdout
        .split(/\r?\n|\r/)  // Split by \r\n, \n, or \r
        .map(p => p.trim())
        .filter(p => p);
      return paths[0] || null;
    }

    return null;
  } catch {
    return null;
  }
}
