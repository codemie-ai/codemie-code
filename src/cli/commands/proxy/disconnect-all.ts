/**
 * `codemie proxy disconnect --all` — disconnect every target `proxy clients` reports as connected.
 *
 * Kept out of `disconnect-orchestrator.ts`: `client-targets.ts` imports the orchestrator, so the reverse import
 * would cycle. A failing target never stops the others; the daemon keeps running unless `stop` is set.
 */
import chalk from 'chalk';

import { logger } from '@/utils/logger.js';
import { readClientTargetStates } from './client-targets.js';
import { checkStatus, stopDaemon } from './daemon-manager.js';
import { DAEMON_LOCK_COMMAND_BUDGET_MS, withDaemonLock } from './daemon-lock.js';

export interface DisconnectAllResult {
  disconnected: string[];
  failed: string[];
}

/** `--stop`: stops the daemon after a disconnect; a failure is reported and sets the exit code. */
export async function stopDaemonAfterDisconnect(): Promise<void> {
  try {
    const stopped = await withDaemonLock(DAEMON_LOCK_COMMAND_BUDGET_MS, async () => {
      const { running } = await checkStatus();
      if (running) await stopDaemon();
      return running;
    });
    console.log(stopped ? chalk.green('✓ Proxy stopped') : chalk.dim('Proxy is not running.'));
  } catch (error) {
    console.error(chalk.red(`✗ Failed to stop proxy — ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  }
}

/**
 * Disconnects every connected target, reports each, sets `process.exitCode = 1` when any failed. A target whose
 * connected check failed may still be connected: it is reported as not disconnected, never skipped silently.
 */
export async function disconnectAll(opts: { stop?: boolean } = {}): Promise<DisconnectAllResult> {
  const result: DisconnectAllResult = { disconnected: [], failed: [] };
  const states = await readClientTargetStates();
  const unchecked = states.filter((state) => state.error !== undefined);
  const targets = states.filter((state) => state.connected).map((state) => state.target);

  for (const state of unchecked) {
    console.error(chalk.red(`! ${state.target.label}: check failed (${state.error}); not disconnected`));
    result.failed.push(state.target.label);
  }
  if (targets.length === 0 && unchecked.length === 0) {
    console.log(chalk.dim('Nothing connected.'));
  }

  const priorExitCode = process.exitCode;
  for (const target of targets) {
    if (!target.disconnect) continue;
    // The per-target removers report their own failure by setting the exit code; read it per target.
    process.exitCode = undefined;
    let failed = false;
    try {
      await target.disconnect();
      failed = process.exitCode !== undefined && Number(process.exitCode) !== 0;
    } catch (error) {
      logger.debug(`[disconnect-all] ${target.id} threw:`, error);
      console.error(chalk.red(`✗ ${target.label} — ${error instanceof Error ? error.message : String(error)}`));
      failed = true;
    }
    (failed ? result.failed : result.disconnected).push(target.label);
  }

  if (result.failed.length > 0) {
    console.error(chalk.red(`✗ Not disconnected: ${result.failed.join(', ')}`));
    process.exitCode = 1;
  } else {
    process.exitCode = priorExitCode;
  }

  if (opts.stop) await stopDaemonAfterDisconnect();
  return result;
}
