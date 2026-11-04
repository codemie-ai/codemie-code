/**
 * Launch-time CodeMie identity policy (EPMCDME-15411).
 *
 * One place decides what a launch does with a global profile that has no
 * project of its own (`unowned`): prompt once in a terminal, else warn once on
 * stderr and continue with the shared project. It also exports the binding
 * state and clears inherited identity for `own`/`none` profiles. Called by the
 * agent launcher, `proxy connect/start/restart` and the hook cold start.
 */
import chalk from 'chalk';
import type { CodeMieConfigOptions } from '@/env/types.js';
import { IDENTITY_KEYS } from '@/env/types.js';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';
import {
  PROJECT_BINDING_ENV,
  sanitizeDisplayText,
  type ProjectBindingState,
} from '@/utils/project-binding.js';
import { ProviderName } from '@/providers/core/types.js';
import { ProviderRegistry } from '@/providers/core/registry.js';

/** Identity env vars an `own`/`none` launch must only take from its own resolved config. */
export const INHERITED_IDENTITY_ENV = [
  'CODEMIE_PROJECT',
  'CODEMIE_URL',
  'CODEMIE_INTEGRATION_ID',
  'CODEMIE_INTEGRATION_ALIAS',
  'CODEMIE_SYNC_API_URL',
] as const;

export type LaunchSurface = 'agent' | 'proxy' | 'hook';

export interface LaunchIdentityOptions {
  workingDir: string;
  /** Whether a prompt may be shown (see canPromptForProject()). */
  canPrompt: boolean;
  surface: LaunchSurface;
  /** Bearer token for a JWT profile's project list (never stored or logged). */
  jwtToken?: string;
}

export interface LaunchIdentity {
  state: ProjectBindingState;
  /** Global profile the identity belongs to. */
  profileName?: string;
  /** An unowned profile is still unowned after the prompt (or none was possible): warn once. */
  needsWarning: boolean;
  surface: LaunchSurface;
  isJwt: boolean;
}

/** Seams for tests. */
export interface LaunchIdentityDeps {
  prompt?: typeof import('@/providers/core/launch-project-prompt.js').promptProfileProject;
  resolveAuth?: typeof import('@/providers/core/codemie-auth-helpers.js').resolveProjectListAuth;
  writeStderr?: (text: string) => void;
}

function writeStderrSafely(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // EPIPE (closed stderr in a shortcut launcher) must never fail the launch.
  }
}

function isJwtProfile(config: CodeMieConfigOptions): boolean {
  return config.provider === ProviderName.BEARER_AUTH || config.authMethod === 'jwt';
}

/**
 * Decide the launch identity. For an `unowned` profile with a terminal, ask once
 * and save the pick to this profile only (updating `config` in place); Ctrl-C at
 * the prompt exits 130 before anything is saved.
 */
export async function resolveLaunchIdentity(
  config: CodeMieConfigOptions,
  options: LaunchIdentityOptions,
  deps: LaunchIdentityDeps = {}
): Promise<LaunchIdentity> {
  const resolution = await ConfigLoader.resolveProfileIdentity(options.workingDir, config.name);
  const base = {
    profileName: resolution.profileName,
    surface: options.surface,
    isJwt: isJwtProfile(config),
  };
  if (resolution.state !== 'unowned') {
    return { ...base, state: resolution.state, needsWarning: false };
  }

  if (options.canPrompt && options.surface === 'agent' && resolution.profileName) {
    const outcome = await promptForUnowned(config, resolution.profileName, resolution.shared.codeMieProject, options, deps);
    if (outcome) return { ...base, state: outcome, needsWarning: false };
  }
  return { ...base, state: 'unowned', needsWarning: true };
}

async function promptForUnowned(
  config: CodeMieConfigOptions,
  profileName: string,
  sharedProject: string | undefined,
  options: LaunchIdentityOptions,
  deps: LaunchIdentityDeps
): Promise<ProjectBindingState | undefined> {
  const resolveAuth = deps.resolveAuth
    ?? (await import('@/providers/core/codemie-auth-helpers.js')).resolveProjectListAuth;
  const prompt = deps.prompt
    ?? (await import('@/providers/core/launch-project-prompt.js')).promptProfileProject;

  let auth;
  try {
    auth = await resolveAuth({
      provider: config.provider,
      baseUrl: config.baseUrl,
      codeMieUrl: config.codeMieUrl,
      jwtToken: options.jwtToken,
    });
  } catch (error) {
    logger.debug('[launch-identity] no credentials for the project list', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (!auth) return undefined;

  const template = config.provider ? ProviderRegistry.getProvider(config.provider) : undefined;
  const outcome = await prompt({
    profileName,
    sharedProject,
    auth,
    canStayOff: template?.customProperties?.canStayOffCodeMie === true,
    requiresIntegration: template?.customProperties?.requiresIntegration === true,
  });

  if (outcome.kind === 'unavailable') return undefined;

  if (outcome.kind === 'off') {
    if (!(await ConfigLoader.saveProfileIdentity(profileName, null))) return undefined;
    for (const key of IDENTITY_KEYS) delete (config as Record<string, unknown>)[key];
    refreshProfileConfigEnv(config);
    console.log(chalk.green(`✓ Profile "${sanitizeDisplayText(profileName)}" stays off CodeMie\n`));
    return 'none';
  }

  const saved = await ConfigLoader.saveProfileIdentity(profileName, {
    codeMieUrl: config.codeMieUrl,
    codeMieProject: outcome.project,
    codeMieIntegration: outcome.integration,
  });
  if (!saved) return undefined;
  config.codeMieProject = outcome.project;
  if (outcome.integration) config.codeMieIntegration = outcome.integration;
  else delete config.codeMieIntegration;
  refreshProfileConfigEnv(config);
  console.log(chalk.green(
    `✓ Project "${sanitizeDisplayText(outcome.project)}" saved for profile "${sanitizeDisplayText(profileName)}"\n`
  ));
  return 'own';
}

/** Keep an already-exported CODEMIE_PROFILE_CONFIG in step with an in-memory identity change. */
function refreshProfileConfigEnv(config: CodeMieConfigOptions): void {
  if (process.env.CODEMIE_PROFILE_CONFIG) {
    process.env.CODEMIE_PROFILE_CONFIG = JSON.stringify(config);
  }
}

/** The one stderr warning for an unowned launch that could not prompt. */
export function unownedWarningText(profileName: string | undefined, project: string | undefined, isJwt: boolean): string {
  const name = sanitizeDisplayText(profileName ?? 'default');
  const used = project ? `"${sanitizeDisplayText(project)}" (last saved by setup, possibly for another profile)` : 'none';
  const fix = isJwt
    ? 'run `codemie setup` with your token available'
    : 'launch this profile once in a terminal, or run `codemie setup`';
  return `⚠️  CodeMie profile "${name}" has no project of its own; this session uses project ${used}. To fix: ${fix}.\n`;
}

/**
 * Apply the decided identity to the launch environment, after the provider
 * environment is built: export the binding (output-only, overwritten every
 * launch), remove inherited identity for `own`/`none`, and warn for `unowned`.
 */
export function finalizeLaunchIdentity(
  launch: LaunchIdentity,
  providerEnv: Record<string, string>,
  deps: Pick<LaunchIdentityDeps, 'writeStderr'> = {},
  env: NodeJS.ProcessEnv = process.env
): void {
  delete env[PROJECT_BINDING_ENV];
  providerEnv[PROJECT_BINDING_ENV] = launch.state;

  if (launch.state === 'own' || launch.state === 'none') {
    for (const key of INHERITED_IDENTITY_ENV) {
      if (!(key in providerEnv)) delete env[key];
    }
  }

  if (!launch.needsWarning) return;
  const project = providerEnv.CODEMIE_PROJECT || env.CODEMIE_PROJECT || undefined;
  const text = unownedWarningText(launch.profileName, project, launch.isJwt);
  if (launch.surface === 'hook') {
    logger.warn(text.trim());
    return;
  }
  (deps.writeStderr ?? writeStderrSafely)(chalk.yellow(text));
}

/**
 * Daemon paths (`proxy connect/start/restart`, hook cold start): never prompt;
 * an unowned profile writes the warning (stderr for proxy, log only for hook).
 * Returns the binding state, or undefined when it cannot be resolved.
 */
export async function reportDaemonProfileIdentity(
  config: CodeMieConfigOptions,
  surface: 'proxy' | 'hook',
  workingDir: string = process.cwd(),
  deps: Pick<LaunchIdentityDeps, 'writeStderr'> = {}
): Promise<ProjectBindingState | undefined> {
  try {
    const launch = await resolveLaunchIdentity(config, { workingDir, canPrompt: false, surface });
    // A throwaway env: the daemon gets its project from `config`, not from this process.
    finalizeLaunchIdentity(launch, config.codeMieProject ? { CODEMIE_PROJECT: config.codeMieProject } : {}, deps, {});
    return launch.state;
  } catch (error) {
    logger.debug('[launch-identity] daemon profile identity unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
