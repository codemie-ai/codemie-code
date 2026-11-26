/**
 * `codemie proxy analytics resend`: releases spooled sessions held locally once what held them is resolved, so the
 * proxy sends their queued data on its next pass. Today: sessions held for lack of work consent (Claude Code).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { renderHint } from '@/utils/hint.js';
import { releaseHeldSessions, type HoldReleaseResult } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/hold-release.js';
import { assertClaudeOnly, requireIdentity } from './analytics-consent-command.js';
import { withConnectorOptions, withErrorHandling, type ConnectorOptions } from './analytics-targets.js';
import { isDaemonAlive, readState } from './daemon-manager.js';

/** Why a session is still held, by `<reason>:<detail>` of its releaser. A releaser for a new hold reason adds its texts here. */
const KEPT_TEXT: Record<string, string> = {
  'work_consent_required:no_consent':
    'no consent covers its project and folder (a session recorded before this version is covered only by consent grant --all)',
  'work_consent_required:not_eligible': 'it cannot carry a consent (recorded without a funding claim or a project, or under another account)',
};

const OUTCOME_TEXT: Record<'stopped' | 'busy' | 'unavailable', string> = {
  stopped: 'its publication was stopped for good',
  busy: 'the proxy was sending it; run the command again',
  unavailable: 'its local state could not be read; run the command again',
};

function notReleasedText(r: HoldReleaseResult): string {
  if (r.outcome === 'kept') return KEPT_TEXT[`${r.reason}:${r.detail ?? ''}`] ?? `still held (${r.reason.replace(/_/g, ' ')})`;
  return OUTCOME_TEXT[r.outcome as keyof typeof OUTCOME_TEXT];
}

const sessions = (n: number): string => `${n} held session${n === 1 ? '' : 's'}`;

async function proxyRunning(): Promise<boolean> {
  const state = await readState();
  return !!state && (await isDaemonAlive(state));
}

/** Prints the run's summary; returns how many sessions were released. */
function printResults(results: HoldReleaseResult[]): number {
  const released = results.filter((r) => r.outcome === 'released').length;
  if (released > 0) {
    console.log(chalk.green(`✓ Released ${sessions(released)}. The proxy sends their data on its next pass.`));
  }
  for (const r of results) {
    if (r.outcome !== 'released') console.log(chalk.yellow(`  Not released: ${r.sessionId}: ${notReleasedText(r)}`));
  }
  if (results.some((r) => r.reason === 'work_consent_required' && r.detail === 'no_consent')) {
    console.log(renderHint({ reason: 'grant the consent from the session folder (or with --all) first, then run this again', command: 'codemie proxy analytics consent grant' }));
  }
  return released;
}

async function resendHeld(opts: ConnectorOptions): Promise<void> {
  await withErrorHandling(async () => {
    assertClaudeOnly(opts);
    const results = await releaseHeldSessions(await requireIdentity());
    if (results.length === 0) {
      console.log(chalk.dim('Nothing to resend: no session is held for a reason this command can resolve.'));
      return;
    }
    if (printResults(results) > 0 && !(await proxyRunning())) {
      console.log(renderHint({ reason: 'the proxy is not running, so nothing is sent yet', command: 'codemie proxy start' }));
    }
  });
}

/** Adds `resend` to `proxy analytics`. Flags (e.g. --reason, --session) map onto `HoldReleaseOptions` as they are added. */
export function addResendCommand(analytics: Command): void {
  withConnectorOptions(
    analytics
      .command('resend')
      .description('Send data held locally once what held it is resolved (currently: Claude Code sessions held for lack of work consent)')
  ).action((opts: ConnectorOptions) => resendHeld(opts));
}
