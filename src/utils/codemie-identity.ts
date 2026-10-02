import type { ProviderProfile, WorkspaceConfig } from '../env/types.js';

/**
 * Providers whose `baseUrl` is itself a CodeMie instance. For these, the CodeMie
 * identity (codeMieUrl/codeMieProject/codeMieIntegration) must belong to the same
 * instance: codeMieUrl selects the stored SSO credentials used for the model
 * catalogue, analytics sync and assistants/skills.
 */
const CODEMIE_BACKED_PROVIDERS: ReadonlySet<string> = new Set(['ai-run-sso', 'bearer-auth']);

function urlOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Make the scope-level CodeMie identity consistent with the profile in use.
 *
 * The identity is stored once per config scope and is shared by all profiles in
 * that scope. When a scope holds profiles for two different CodeMie instances
 * (e.g. two SSO profiles), the shared codeMieUrl can point to the other instance.
 * Then agents load the other instance's model catalogue and credentials while
 * inference goes to the profile's own baseUrl.
 *
 * For CodeMie-backed providers only: if codeMieUrl is on a different host than
 * the profile's baseUrl, derive codeMieUrl from baseUrl and drop codeMieProject
 * and codeMieIntegration, because they belong to the other instance. In all
 * other cases the workspace is returned unchanged.
 */
export function alignIdentityWithProfile<T extends WorkspaceConfig>(
  workspace: T,
  profile: Pick<ProviderProfile, 'provider' | 'baseUrl'>
): T {
  if (!profile.provider || !CODEMIE_BACKED_PROVIDERS.has(profile.provider)) {
    return workspace;
  }
  if (!profile.baseUrl || !workspace.codeMieUrl) {
    return workspace;
  }

  const profileOrigin = urlOrigin(profile.baseUrl);
  if (!profileOrigin || urlOrigin(workspace.codeMieUrl) === profileOrigin) {
    return workspace;
  }

  const result: T = { ...workspace };
  delete result.codeMieProject;
  delete result.codeMieIntegration;
  result.codeMieUrl = profile.baseUrl
    .replace(/\/+$/, '')
    .replace(/\/code-assistant-api$/i, '');
  return result;
}
