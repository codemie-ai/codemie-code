import path from 'node:path';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { getCurrentCliVersion } from '@/utils/cli-updater.js';
import type { OtlpHookContext } from '../OtlpAgentAdapter.js';
import { resolveHookCredentials } from '../hook-credentials.js';
import { pinProjectName, readPinnedProjectName } from '../session-project-pin.js';
import type { EvidenceRecord } from '../evidence/record-store.js';
import { launchMode } from '../evidence/routing.js';
import type { CodeMieConfigOptions } from '@/env/types.js';
import {
  resolveCodemieCliEmail,
  resolveEmailFromCredentials,
  resolveGitEmail,
  resolveIdentity,
  resolveOsUser,
} from '../identity-resolver.js';

/** Identity, project and version fields, resolved from the hook's cwd and the stored SSO credentials. Common to every event. */
export interface IdentityFields {
  user_email: string;
  developer_name: string;
  identity_source: string;
  codemie_project_name: string;
  codemie_cli_version: string;
}

/** Opt-in: the raw per-source identity candidates, which the backend ranks itself. */
export interface IdentityCandidateFields {
  git_email: string;
  codemie_cli_email: string;
  os_user: string;
}

/**
 * Identity, project and CLI version for the hook's cwd. Credentials are the SSO ones the
 * daemon will use (see `resolveHookCredentials`); without them identity falls through to
 * the git, codemie_cli and os tiers. Each of the three is resolved independently, so a failed
 * lookup yields that field's empty value only, never a dropped event and never a wider blank-out.
 */
export async function resolveIdentityFields(
  { cwd, sessionId }: OtlpHookContext,
  record?: EvidenceRecord
): Promise<IdentityFields> {
  const [identityResult, projectName, version] = await Promise.all([
    resolveIdentityTier(cwd),
    resolveProjectName(cwd, sessionId, record),
    getCurrentCliVersion().catch(() => null),
  ]);
  return {
    ...identityResult,
    codemie_project_name: projectName,
    codemie_cli_version: version ?? '',
  };
}

async function resolveIdentityTier(
  cwd: string
): Promise<Pick<IdentityFields, 'user_email' | 'developer_name' | 'identity_source'>> {
  try {
    const credentials = await resolveHookCredentials();
    const identity = await resolveIdentity(credentials, cwd);
    return {
      user_email: resolveEmailFromCredentials(credentials),
      developer_name: identity.developerName,
      identity_source: identity.identitySource,
    };
  } catch (error) {
    logger.debug(`[event-fields] identity resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return { user_email: '', developer_name: '', identity_source: '' };
  }
}

/**
 * In a managed launch `CODEMIE_PROJECT` (exported by the launcher into the agent's own process
 * env, the same source `Session.project` uses) wins when present, since it is set once for the
 * whole session and cannot drift as the hook's `cwd` moves, and is never pinned against. A native
 * session has no launcher, so the configured project wins and a shell `CODEMIE_PROJECT` is only
 * the fallback (see configuredOrShellProject).
 *
 * Otherwise, with a `sessionId`, the first hook's resolution — the nearest `.codemie` found
 * by walking up from `CLAUDE_PROJECT_DIR` toward the filesystem root, or the global active
 * profile — is pinned for the rest of the session (`session-project-pin.ts`), so a later
 * `codemie profile switch` or a `cwd` move into a directory with a different `.codemie`
 * cannot change what this session reports (it would otherwise look like a second,
 * conflicting project and drop the rest of the session's analytics). Without a `sessionId`
 * (an adapter that doesn't supply one), or without `CLAUDE_PROJECT_DIR` (a tool other than
 * Claude Code), resolution falls back to the hook's own `cwd`, unwalked and unpinned, as before.
 */
async function resolveProjectName(
  cwd: string,
  sessionId: string | undefined,
  record?: EvidenceRecord
): Promise<string> {
  // A stamped session's durable record is the single source: event project, spool binding and
  // headers must agree, so env/pin/config are never consulted again (nor is a pin written).
  if (record) {
    return record.project ?? '';
  }
  return resolveSessionProject(cwd, sessionId);
}

/** The env/pin/config resolution, used for unstamped sessions and once to seed a new record. */
export async function resolveSessionProject(cwd: string, sessionId: string | undefined): Promise<string> {
  const envProject = process.env['CODEMIE_PROJECT']?.trim();
  if (envProject && launchMode(process.env) === 'managed') {
    return envProject;
  }

  const pinned = sessionId ? await readPinnedProjectName(sessionId) : undefined;
  if (pinned) {
    return pinned;
  }

  const resolved = await configuredOrShellProject(await loadHookConfig(cwd));
  return sessionId ? pinProjectName(sessionId, resolved) : resolved;
}

/**
 * A native session follows the managed launcher's policy: the configured project wins; a shell
 * `CODEMIE_PROJECT` is only the fallback for a profile without one, and never for `own`/`none` profiles.
 */
async function configuredOrShellProject(hook: Awaited<ReturnType<typeof loadHookConfig>>): Promise<string> {
  const configured = hook?.config.codeMieProject;
  if (configured) return configured;
  const shell = process.env['CODEMIE_PROJECT']?.trim();
  if (!shell) return '';
  if (hook) {
    const { state } = await ConfigLoader.resolveProfileIdentity(hook.configDir, hook.config.name).catch(() => ({ state: undefined }));
    if (state === 'own' || state === 'none') return '';
  }
  return shell;
}

/** The profile config the hook resolves for `cwd` (same walk as the project lookup); undefined on failure. */
export async function loadHookConfig(
  cwd: string,
  opts: { fromCwd?: boolean; profile?: string } = {}
): Promise<{ config: CodeMieConfigOptions; configDir: string } | undefined> {
  // `fromCwd`: walk up from the hook's own cwd instead of the session's fixed project dir (used to notice a folder change).
  const start = opts.fromCwd ? cwd : process.env['CLAUDE_PROJECT_DIR']?.trim();
  try {
    const configDir = start ? await findNearestConfigDir(start) : cwd;
    // A managed launch exports the profile it was started with (`--profile X` included); it, not the
    // globally active profile, selects hook config, routing proof and project. Native has no such export.
    const launched = launchMode(process.env) === 'managed' ? process.env['CODEMIE_PROFILE_NAME']?.trim() : undefined;
    const profileName = opts.profile || launched || (await ConfigLoader.getActiveProfileName(configDir));
    const config = await ConfigLoader.load(configDir, profileName ? { name: profileName } : undefined);
    return { config, configDir };
  } catch {
    return undefined;
  }
}

/** The project the hook's current cwd resolves to, ignoring the session pin: `CODEMIE_PROJECT` wins, else the config found from cwd. */
export async function resolveProjectAtCwd(cwd: string, profile?: string): Promise<string> {
  const envProject = process.env['CODEMIE_PROJECT']?.trim();
  if (envProject && launchMode(process.env) === 'managed') return envProject;
  return configuredOrShellProject(await loadHookConfig(cwd, { fromCwd: true, profile }));
}

/** Walks up from `startDir` to the nearest ancestor with a local `.codemie` config; `startDir` itself if none has one. */
export async function findNearestConfigDir(startDir: string): Promise<string> {
  let dir = startDir;
  for (;;) {
    if (await ConfigLoader.hasLocalConfig(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return startDir;
    }
    dir = parent;
  }
}

/**
 * Each identity source on its own, with no ranking and no `user.name` fallback for git,
 * so `git_email` is always a real email. Never throws.
 */
export async function resolveIdentityCandidateFields({ cwd }: OtlpHookContext): Promise<IdentityCandidateFields> {
  try {
    const [gitEmail, codemieCliEmail] = await Promise.all([resolveGitEmail(cwd), resolveCodemieCliEmail()]);
    return { git_email: gitEmail, codemie_cli_email: codemieCliEmail, os_user: resolveOsUser() };
  } catch (error) {
    logger.debug(`[event-fields] identity candidate resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return { git_email: '', codemie_cli_email: '', os_user: '' };
  }
}
