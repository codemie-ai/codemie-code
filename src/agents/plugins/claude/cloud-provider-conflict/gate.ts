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
  type ResolveConflictInput,
} from './resolver.js';
import { applySwitch, type SwitchDeps, type SwitchResult } from './switcher.js';
import { logger } from '@/utils/logger.js';

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

const INERT_RESULT = (): SwitchResult => ({ backupDir: null, files: [], changed: [] });
const claudeAgents: readonly string[] = ['claude', 'claude-acp'];

function inert(): GateOutcome {
  return { kind: 'proceed', token: { plan: null, deps: {} } };
}

function stop(reason: StopReason, findings: ConflictFindings): GateOutcome {
  return { kind: 'stop', reason, guidance: stopGuidance(reason, findings) };
}

/** True when the only layers deciding the provider are the inherited shell environment, which cannot be switched. */
function onlyShellEnv(resolution: ConflictResolution): boolean {
  const deciding = resolution.layers.filter((l) => l.inEffect);
  return deciding.length > 0 && deciding.every((l) => l.scope === 'env');
}

export async function detectAndAsk(input: DetectAndAskInput): Promise<GateOutcome> {
  const { flow, canPrompt } = input;
  const provider = input.provider ?? BEDROCK;
  const profileProvider = input.profile?.provider;

  // A Bedrock profile sets its own environment for the process only; with no profile an install has no
  // gateway to route to yet.
  if (profileProvider === provider.name || (flow === 'install' && !input.profile)) return inert();

  if (flow === 'connect-otlp-only') {
    logger.warn(
      `[cloud-provider-conflict] ${provider.displayName} settings in Claude configuration are not checked for this target; if they are enabled, analytics attribution may be unknown.`
    );
    return inert();
  }

  const plan: ResolveConflictInput = {
    provider,
    flow,
    paths: input.paths,
    platform: input.platform,
    env: input.env,
    cwd: input.cwd,
    runners: input.runners,
  };
  const resolution = await resolveProviderConflict(plan);
  const findings: ConflictFindings = { resolution, flow, provider };

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

  if (onlyShellEnv(resolution)) {
    logger.warn(
      `[cloud-provider-conflict] The shell variable ${provider.flag} selects ${provider.displayName}; it is not changed here, and codemie-claude ignores it for its own process.`
    );
    return inert();
  }
  if (!canPrompt) return stop('non-interactive', findings);

  const choice = await askSwitchOrCancel(findings, input.prompt);
  if (choice === 'cancel') return stop('cancel', findings);
  return { kind: 'proceed', token: { plan, deps: input.switchDeps ?? {} } };
}

/** Performs the switch the user consented to. An inert token does nothing and returns an empty result. */
export async function applyConsented(token: ConsentToken): Promise<SwitchResult> {
  if (!token.plan) return INERT_RESULT();
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
