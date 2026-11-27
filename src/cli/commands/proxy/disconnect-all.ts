/**
 * `codemie proxy disconnect --all` — disconnect every target `proxy clients` reports as connected.
 *
 * Kept out of `disconnect-orchestrator.ts`: `client-targets.ts` imports the orchestrator, so the reverse import
 * would cycle. A failing target never stops the others; the daemon keeps running (`codemie proxy stop` stops it).
 */
import chalk from 'chalk';

import { logger } from '@/utils/logger.js';
import { readClientTargetStates } from './client-targets.js';
import { renderHint } from '@/utils/hint.js';
import { checkStatus } from './daemon-manager.js';

/** While the daemon runs, one line naming `codemie proxy stop`; a failed status read prints nothing. */
async function namedStillRunning(): Promise<void> {
  try {
    const { running } = await checkStatus();
    if (running) console.log(renderHint({ reason: 'The proxy is still running', command: 'codemie proxy stop' }));
  } catch (error) {
    logger.debug('[disconnect-all] daemon status read failed:', error);
  }
}

export interface DisconnectAllResult {
  disconnected: string[];
  failed: string[];
}

/**
 * Disconnects every connected target, reports each, sets `process.exitCode = 1` when any failed. A target whose
 * connected check failed may still be connected: it is reported as not disconnected, never skipped silently.
 */
export async function disconnectAll(): Promise<DisconnectAllResult> {
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

  await namedStillRunning();
  return result;
}
