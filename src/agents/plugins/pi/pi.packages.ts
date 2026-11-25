import { join } from 'path';
import { readFile } from 'fs/promises';
import { exec, type ExecResult } from '@/utils/exec.js';
import { getUserPiAgentDir } from './pi.paths.js';
import { logger } from '@/utils/logger.js';
import { AgentInstallationError } from '@/utils/errors.js';

export const REQUIRED_PI_PACKAGES: readonly string[] = [
  'git:github.com/obra/superpowers',
  'npm:pi-subagents',
];

export interface InstallPiPackagesOptions {
  /** Pi CLI command name or path (default: 'pi') */
  cliCommand?: string | null;
  /** Working directory for the install commands (default: process.cwd()) */
  cwd?: string;
  /** Per-package timeout in milliseconds (default: 300000) */
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Package sources Pi already lists in its global settings (`~/.pi/agent/settings.json`, `packages`).
 * Entries are plain source strings or `{ source }` objects. An absent or unreadable file means none.
 */
async function readInstalledPiPackages(): Promise<Set<string>> {
  try {
    const raw = await readFile(join(getUserPiAgentDir(), 'settings.json'), 'utf-8');
    const packages: unknown = (JSON.parse(raw) as { packages?: unknown }).packages;
    if (!Array.isArray(packages)) return new Set();
    return new Set(
      packages
        .map((entry: unknown) =>
          typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source,
        )
        .filter((source): source is string => typeof source === 'string'),
    );
  } catch {
    return new Set();
  }
}

export async function installRequiredPiPackages(
  options: InstallPiPackagesOptions = {},
): Promise<void> {
  const cliCommand = options.cliCommand || 'pi';
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  const installed = await readInstalledPiPackages();

  logger.info(`[pi] Installing required Pi packages using ${cliCommand}`);

  for (const pkg of REQUIRED_PI_PACKAGES) {
    if (installed.has(pkg)) {
      logger.info(`[pi] Package already installed: ${pkg}`);
      continue;
    }
    logger.info(`[pi] Installing package: ${pkg}`);

    let result: ExecResult;
    try {
      result = await exec(cliCommand, ['install', pkg], {
        cwd,
        timeout,
        // pi is a .cmd shim on Windows, which needs a shell to spawn (as with npm/npx in processes.ts)
        shell: process.platform === 'win32',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentInstallationError(
        'pi',
        `Failed to install Pi package "${pkg}": ${message}`,
      );
    }

    if (result.code !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      throw new AgentInstallationError(
        'pi',
        `Failed to install Pi package "${pkg}": ${output}`,
      );
    }

    logger.success(`[pi] Installed package: ${pkg}`);
  }
}
