/**
 * Claude Code analytics (connected with `--claude-otlp`) steps of `codemie proxy connect`:
 * the consent gate that runs before anything is started or written, and the
 * settings writer that runs once the shared daemon is up. Kept apart from
 * `connect-orchestrator.ts`, which owns the multi-target daemon lifecycle.
 */
import chalk from 'chalk';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { CODEMIE_USER_PROMPT_HOOK_STATUS_MESSAGE, writeClaudeCodeOtlpConfig } from './connectors/claude-code-otlp.js';
import type { AllowlistScope } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { readAllowlistState } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { resolveRepositoryName } from '@/utils/processes.js';
import { buildAnalyticsDetailLines, promptAnalyticsConfirmation } from './prompts/analytics-confirmation.js';
import { resolveConsentProject } from './consent-project.js';
import type { TargetResult } from './connect-orchestrator.js';

/** Profile and CodeMie URL shown to the user, resolved once by the caller. */
export interface ClaudeCodeOtlpDisplay {
  profile: string;
  codeMieUrl?: string;
  /** Labels of the Claude clients this run routes through the proxy. */
  routedClients?: string[];
}

/** The label of the Claude Code analytics target in the connect summary. */
export const CLAUDE_CODE_OTLP_LABEL = 'Claude Code Analytics';

/** Inputs for {@link runClaudeCodeOtlp}. */
export interface ClaudeCodeOtlpRunOptions {
  overwrite?: boolean;
  scope?: AllowlistScope;
  keepProjectList?: boolean;
}

/**
 * Write the Claude Code analytics settings and print the success line.
 * Failures are reported in the returned result rather than thrown, so one failing
 * target does not stop the others.
 */
export async function runClaudeCodeOtlp(options: ClaudeCodeOtlpRunOptions): Promise<TargetResult> {
  const label = CLAUDE_CODE_OTLP_LABEL;
  try {
    await writeClaudeCodeOtlpConfig({
      promptStatus: CODEMIE_USER_PROMPT_HOOK_STATUS_MESSAGE,
      overwrite: options.overwrite,
      scope: options.scope,
      keepProjectList: options.keepProjectList,
    });
    console.log(chalk.green(`✓ Claude Code Analytics configured successfully`));
    return { label, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Failed to configure Claude Code analytics', ...sanitizeLogArgs({ error: message }));
    console.log(chalk.yellow(`  Could not configure Claude Code analytics: ${message}`));
    return { label, ok: false, error: message };
  }
}

/** What the user agreed to: `workConsent` records the work consent; `deniedQuestion` is a Decline to the consent question. */
export interface ClaudeCodeOtlpAgreement {
  workConsent: boolean;
  deniedQuestion: boolean;
}

/**
 * Guards the Claude Code analytics write. The invalid-allowlist check runs on
 * every path; the prompt is skipped only for `--yes`, which counts as consent.
 * Returns `false` when the user declined (a decline must leave the allowlist, settings
 * and any running daemon untouched), else what they agreed to. `display` feeds the prompt
 * header, or the same URL and project lines printed in place of the prompt for `--yes`.
 *
 * With `includePersonalSubscriptions` the work consent is part of the agreement and no question is asked; in
 * project scope its project must resolve (a `ConfigurationError` otherwise, before anything is touched). Without
 * it an interactive run asks the question first, unless project scope has no project to ask about.
 */
export async function confirmClaudeCodeOtlp(
  scope: AllowlistScope,
  overwrite: boolean,
  yes: boolean,
  display: ClaudeCodeOtlpDisplay,
  includePersonalSubscriptions = false,
): Promise<false | ClaudeCodeOtlpAgreement> {
  const allowlist = await readAllowlistState();
  if (allowlist.kind === 'invalid' && !overwrite) {
    throw new ConfigurationError(
      'Claude Code settings contain an invalid CODEMIE_ANALYTICS_PROJECT_FILTER value. ' +
      'Fix it manually or re-run with --overwrite to discard it.'
    );
  }

  const repositoryName = scope === 'project' ? await resolveRepositoryName(resolveProjectRoot()) : undefined;

  if (includePersonalSubscriptions && scope === 'project') {
    await resolveConsentProject(resolveProjectRoot());
  }

  if (yes) {
    // The caller already printed `Using profile:`; the prompt that carries these lines is skipped.
    for (const line of buildAnalyticsDetailLines({ codeMieUrl: display.codeMieUrl, repositoryName })) {
      console.log(line);
    }
    return { workConsent: includePersonalSubscriptions, deniedQuestion: false };
  }

  const askConsent = !includePersonalSubscriptions && (await canAskWorkConsent(scope));
  const confirmation = await promptAnalyticsConfirmation({
    profile: display.profile,
    codeMieUrl: display.codeMieUrl,
    allowlist,
    repositoryName,
    routedClients: display.routedClients,
    ...(askConsent && { workConsentQuestion: { scope } }),
  });

  if (confirmation === 'cancel') return false;
  return {
    workConsent: includePersonalSubscriptions || confirmation === 'enable-with-consent',
    deniedQuestion: askConsent && confirmation === 'enable',
  };
}

/**
 * Whether the consent question can be put: always for every folder, for this repository only when its project resolves.
 * A `ConfigurationError` is the expected "no usable project" answer; any other failure (config or filesystem) is logged
 * and also skips the question, so the connect itself keeps working.
 */
async function canAskWorkConsent(scope: AllowlistScope): Promise<boolean> {
  if (scope === 'user') return true;
  try {
    await resolveConsentProject(resolveProjectRoot());
    return true;
  } catch (error) {
    if (!(error instanceof ConfigurationError)) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug('[proxy] Could not resolve the consent project; skipping the work-consent question', ...sanitizeLogArgs({ error: message }));
    }
    return false;
  }
}
