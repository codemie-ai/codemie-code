/**
 * The work consent `codemie proxy connect --claude-otlp` records (flag `--include-personal-subscriptions`, or the
 * answer to the extra question): `--scope project` authorizes the repository root, `--scope user` every folder. Kept
 * apart from `connect-orchestrator.ts`, which owns the multi-target daemon lifecycle.
 */
import chalk from 'chalk';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { renderHint } from '@/utils/hint.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { currentEvidenceIdentity } from '@/agents/core/evidence/hook-identity.js';
import { connectAllFolders, connectFolder } from '@/agents/core/evidence/consent-store.js';
import type { AllowlistScope } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { resolveConsentProject } from './consent-project.js';
import { RESEND_COMMAND } from './analytics-targets.js';
import type { TargetResult } from './connect-orchestrator.js';

/** The label of the consent step in the connect summary. */
export const WORK_CONSENT_LABEL = 'Personal subscription analytics';

/** The command that grants the consent a failed or denied connect left unrecorded. */
function grantCommand(scope: AllowlistScope): string {
  return scope === 'user' ? 'codemie proxy analytics consent grant --all' : 'codemie proxy analytics consent grant';
}

/**
 * Records the work consent for the scope: the all-repositories entry (`user`) or the repository root with its resolved
 * project (`project`). Needs the signed-in identity, so it runs after the daemon is up. A failure is reported in the
 * returned result rather than thrown, with the command that grants the consent afterwards.
 */
export async function recordConnectConsent(scope: AllowlistScope): Promise<TargetResult> {
  try {
    const identity = await currentEvidenceIdentity();
    if (!identity) {
      throw new ConfigurationError('Sign in to CodeMie first (codemie profile login): the consent is tied to your account and backend.');
    }
    if (scope === 'user') {
      await connectAllFolders(identity);
    } else {
      const root = resolveProjectRoot();
      await connectFolder({ ...identity, project: await resolveConsentProject(root) }, root);
    }
    console.log(chalk.green(`✓ Analytics from personal Claude subscriptions will be sent for ${scope === 'user' ? 'any repository' : 'this repository'} (applies to new sessions only).`));
    console.log(chalk.dim(`  Sessions already held for lack of consent: ${RESEND_COMMAND}`));
    return { label: WORK_CONSENT_LABEL, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Failed to record work consent', ...sanitizeLogArgs({ error: message }));
    console.log(chalk.yellow(`  Could not enable analytics from personal Claude subscriptions: ${message}`));
    console.log(`  ${renderHint({ reason: 'the consent was not recorded', command: grantCommand(scope) })}`);
    return { label: WORK_CONSENT_LABEL, ok: false, error: message };
  }
}

/** The line printed after a connect whose consent question was answered Decline: how to grant it later. */
export function printEnableLaterHint(scope: AllowlistScope): void {
  const what = scope === 'user' ? 'in any repository' : 'in this repository';
  const where = scope === 'user' ? 'run' : 'run in the repository';
  console.log(chalk.dim(`  To send analytics from personal Claude subscriptions ${what} later, ${where}: ${grantCommand(scope)} (applies to new sessions only)`));
}
