import { exec, type ExecResult } from '@/utils/exec.js';
import { logger } from '@/utils/logger.js';
import { AgentInstallationError } from '@/utils/errors.js';

export const REQUIRED_PI_PACKAGES: readonly string[] = [
  'git:github.com/obra/superpowers',
  'npm:pi-subagents',
  'npm:pi-mcp-adapter',
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

export async function installRequiredPiPackages(
  options: InstallPiPackagesOptions = {},
): Promise<void> {
  const cliCommand = options.cliCommand || 'pi';
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  logger.info(`[pi] Installing required Pi packages using ${cliCommand}`);

  for (const pkg of REQUIRED_PI_PACKAGES) {
    logger.info(`[pi] Installing package: ${pkg}`);

    let result: ExecResult;
    try {
      result = await exec(cliCommand, ['install', pkg], {
        cwd,
        timeout,
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
