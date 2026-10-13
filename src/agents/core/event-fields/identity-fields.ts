import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { getCurrentCliVersion } from '@/utils/cli-updater.js';
import type { OtlpHookContext } from '../OtlpAgentAdapter.js';
import { resolveHookCredentials } from '../hook-credentials.js';
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
 * the git, codemie_cli and os tiers. A failed lookup yields empty fields, never a dropped event.
 */
export async function resolveIdentityFields({ cwd }: OtlpHookContext): Promise<IdentityFields> {
  const empty: IdentityFields = {
    user_email: '',
    developer_name: '',
    identity_source: '',
    codemie_project_name: '',
    codemie_cli_version: '',
  };
  try {
    const credentials = await resolveHookCredentials();
    const [identity, projectName, version] = await Promise.all([
      resolveIdentity(credentials, cwd),
      resolveProjectName(cwd),
      getCurrentCliVersion(),
    ]);
    return {
      user_email: resolveEmailFromCredentials(credentials),
      developer_name: identity.developerName,
      identity_source: identity.identitySource,
      codemie_project_name: projectName,
      codemie_cli_version: version ?? '',
    };
  } catch (error) {
    logger.debug(`[event-fields] identity field resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
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

async function resolveProjectName(cwd: string): Promise<string> {
  try {
    const profileName = await ConfigLoader.getActiveProfileName(cwd);
    const config = await ConfigLoader.load(cwd, profileName ? { name: profileName } : undefined);
    return config.codeMieProject ?? '';
  } catch {
    return '';
  }
}
