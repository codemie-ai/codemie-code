/**
 * Gate for the cloud-provider settings conflict.
 *
 * `detectAndAsk` resolves the conflict for one flow and returns either "proceed" with an opaque token or
 * "stop" with a reason and guidance text. It never ends the process and never prints guidance: the caller
 * decides how to show it and how to exit. `applyConsented` performs the switch the user agreed to (and is a
 * no-op for every other token), so callers can always call it unconditionally. Setting values never leave
 * this module; text carries paths and key names only.
 */
import { BEDROCK, type CloudProviderDescriptor } from './provider.js';
import { askSwitchOrCancel, stopGuidance, type ConflictFindings, type StopReason, type SwitchPromptDeps } from './prompt.js';
import {
  resolveProviderConflict,
  type ConflictFlow,
  type ConflictPaths,
  type ConflictResolution,
  type ConflictRunners,
  type ConflictScope,
  type ResolveConflictInput,
} from './resolver.js';
import { applySwitch, emptySwitchResult, type SwitchDeps, type SwitchResult } from './switcher.js';
import { flagState } from '@/agents/core/evidence/routing.js';
import { logger } from '@/utils/logger.js';
import { sanitizeDisplayText } from '@/utils/project-binding.js';

/**
 * Opaque to callers: hand it back to `applyConsented`. A consent token carries the resolve input the user
 * was asked about; every other proceed outcome carries an inert token (`plan: null`).
 */
export interface ConsentToken {
  readonly plan: ResolveConflictInput | null;
  readonly deps: SwitchDeps;
}

export type GateOutcome =
  | { kind: 'proceed'; token: ConsentToken }
  | { kind: 'stop'; reason: StopReason; guidance: string };

/** The part of a profile the gate reads. */
export interface GateProfile {
  provider?: string;
}

export interface DetectAndAskInput {
  flow: ConflictFlow;
  /** False for ACP, `--task`, no TTY, `CODEMIE_NO_PROMPTS`, `--silent` or a scripted install. */
  canPrompt: boolean;
  profile?: GateProfile | null;
  paths?: ConflictPaths;
  provider?: CloudProviderDescriptor;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runners?: ConflictRunners;
  /** Test seam for the question. */
  prompt?: SwitchPromptDeps;
  /** Test seam for the switch (backup folder, output). */
  switchDeps?: SwitchDeps;
}

const claudeAgents: readonly string[] = ['claude', 'claude-acp'];

function inert(): GateOutcome {
  return { kind: 'proceed', token: { plan: null, deps: {} } };
}

function stop(reason: StopReason, findings: ConflictFindings): GateOutcome {
  return { kind: 'stop', reason, guidance: stopGuidance(reason, findings) };
}

function shellFlagMessage(provider: CloudProviderDescriptor): string {
  return `The shell variable ${provider.flag} is set and can select ${provider.displayName} for Claude started outside codemie-claude; it is not changed here, and codemie-claude ignores it for its own process.`;
}

/**
 * An install only warns about the shell variable: it cannot change the shell, and codemie-claude drops the
 * variable from its own process anyway. Any value but an explicit off (including an unfamiliar spelling) warns.
 */
function warnShellFlag(provider: CloudProviderDescriptor, env: NodeJS.ProcessEnv): void {
  const raw = env[provider.flag];
  if (typeof raw === 'string' && raw !== '' && flagState(raw) !== 'off') logger.notice(shellFlagMessage(provider));
}

/** True when every layer deciding the provider has the given scope. */
function onlyDecidedBy(resolution: ConflictResolution, scope: ConflictScope): boolean {
  const deciding = resolution.layers.filter((l) => l.inEffect);
  return deciding.length > 0 && deciding.every((l) => l.scope === scope);
}

/** Outcomes decided before anything is read: a Bedrock profile, an install without a profile, analytics only. */
function outcomeBeforeReading(input: DetectAndAskInput, provider: CloudProviderDescriptor): GateOutcome | null {
  // A Bedrock profile sets its own environment for the process only; with no profile an install has no
  // gateway to route to yet.
  if (input.profile?.provider === provider.name || (input.flow === 'install' && !input.profile)) return inert();
  if (input.flow === 'connect-otlp-only') {
    logger.notice(
      `${provider.displayName} settings in Claude configuration are not checked for this target; if they are enabled, analytics attribution may be unknown.`
    );
    return inert();
  }
  return null;
}

/**
 * What a resolution decides without a question: proceed or stop. Null means the user is asked. `consent` is
 * the token a yes would give; it is handed back unasked when only the Desktop applied config selects the
 * provider, because the connect writer replaces that file's provider keys anyway: the switch only backs it up.
 */
function outcomeWithoutAsking(findings: ConflictFindings, canPrompt: boolean, consent: ConsentToken): GateOutcome | null {
  const { resolution, provider } = findings;
  switch (resolution.verdict) {
    case 'none':
      return inert();
    case 'conflict-managed':
      return stop('managed', findings);
    case 'unknown':
      return stop('unknown', findings);
    case 'conflict-editable':
      break;
  }
  if (onlyDecidedBy(resolution, 'env')) {
    logger.notice(shellFlagMessage(provider));
    return inert();
  }
  if (onlyDecidedBy(resolution, 'desktop-applied')) {
    for (const layer of resolution.layers.filter((l) => l.inEffect)) {
      logger.notice(
        `${sanitizeDisplayText(layer.path)} sets Claude Desktop to ${provider.displayName}; this connect backs it up and switches it to the CodeMie gateway.`
      );
    }
    return { kind: 'proceed', token: consent };
  }
  return canPrompt ? null : stop('non-interactive', findings);
}

/**
 * Resolves the cloud-provider settings for one flow and, when editable settings select the provider and a
 * question may be asked, asks whether to back up and switch. Changes nothing: a `proceed` token is applied
 * later with `applyConsented`. Warnings (malformed files, the shell variable) are shown on stderr.
 *
 * @param input - The flow, whether a question may be asked, the profile, and test seams
 * @returns `proceed` with a token for `applyConsented`, or `stop` with the reason and guidance to print
 */
export async function detectAndAsk(input: DetectAndAskInput): Promise<GateOutcome> {
  const provider = input.provider ?? BEDROCK;
  const early = outcomeBeforeReading(input, provider);
  if (early) return early;
  if (input.flow === 'install') warnShellFlag(provider, input.env ?? process.env);

  const plan: ResolveConflictInput = {
    provider,
    flow: input.flow,
    paths: input.paths,
    platform: input.platform,
    env: input.env,
    cwd: input.cwd,
    runners: input.runners,
  };
  const resolution = await resolveProviderConflict(plan);
  for (const warning of resolution.warnings) logger.notice(warning);
  const findings: ConflictFindings = { resolution, flow: input.flow, provider };
  const consent: ConsentToken = { plan, deps: input.switchDeps ?? {} };
  const decided = outcomeWithoutAsking(findings, input.canPrompt, consent);
  if (decided) return decided;

  const choice = await askSwitchOrCancel(findings, input.prompt);
  if (choice === 'cancel') return stop('cancel', findings);
  return { kind: 'proceed', token: consent };
}

/**
 * Performs the switch the user consented to. An inert token does nothing and returns an empty result.
 *
 * @throws {SwitchBlockedError} When the state changed to managed policy or cannot be told since the question
 * @throws {SwitchFailedError} When the backup or a write fails; its `backupDir` names the folder to recover from
 */
export async function applyConsented(token: ConsentToken): Promise<SwitchResult> {
  if (!token.plan) return emptySwitchResult();
  return applySwitch(token.plan, token.deps);
}

/**
 * Removes an inherited Bedrock flag from the environment the codemie-claude process is about to use, so
 * Claude Code is not switched to Bedrock by the user's shell. Touches only the given env object (the
 * process itself, never the user's shell). Returns true when a present key was deleted.
 */
export function dropInheritedBedrockFlag(options: {
  agent: string;
  provider?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const { agent, provider, env = process.env } = options;
  if (!claudeAgents.includes(agent) || provider === BEDROCK.name) return false;
  if (!(BEDROCK.flag in env)) return false;
  delete env[BEDROCK.flag];
  return true;
}
