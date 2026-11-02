import { findNearestConfigDir } from '@/agents/core/event-fields/identity-fields.js';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';

/** The profile fields the hook SSO gate needs to pick the environment to check and sign in to. */
export interface HookAuthProfile {
  provider?: string;
  /** Workspace CodeMie URL (`codeMieUrl`), falling back to the profile `baseUrl`. */
  ssoUrl?: string;
  baseUrl?: string;
}

interface LaunchProfile {
  provider?: unknown;
  baseUrl?: unknown;
  codeMieUrl?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The profile the agent session was launched with, as exported by the launcher in
 * `CODEMIE_PROFILE_CONFIG` (the resolved config, `--profile` already applied).
 * `undefined` when absent, malformed, or carrying neither a provider nor a baseUrl.
 */
function readLaunchProfile(env: NodeJS.ProcessEnv): HookAuthProfile | undefined {
  if (!env.CODEMIE_PROFILE_CONFIG) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(env.CODEMIE_PROFILE_CONFIG) as LaunchProfile | null;
    const provider = asString(parsed?.provider);
    const baseUrl = asString(parsed?.baseUrl);
    if (!provider && !baseUrl) {
      return undefined;
    }
    return { provider, baseUrl, ssoUrl: asString(parsed?.codeMieUrl) ?? baseUrl };
  } catch (error) {
    logger.debug(`[hook-auth-profile] ignoring malformed CODEMIE_PROFILE_CONFIG: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Which profile the hook SSO gate checks.
 *
 * Hooks run in a short-lived child process whose `process.cwd()` follows the agent into whatever
 * subdirectory it moved to. `ConfigLoader.load(cwd)` only reads `<cwd>/.codemie`, so in a subfolder
 * it silently falls back to the global active profile (possibly another environment) and the gate
 * blocks the prompt and opens that environment's login (EPMCDME-16308). So:
 *
 * 1. The launch profile in `CODEMIE_PROFILE_CONFIG` wins: it is what the session actually runs with.
 *    `CODEMIE_BASE_URL` is never read, the proxy rewrites it to a loopback URL.
 * 2. Without it (agent started outside `codemie-<agent>`), load the config from the nearest ancestor
 *    of the project dir (`CLAUDE_PROJECT_DIR`, else `cwd`) that has a local `.codemie` config.
 *
 * Config load failures in step 2 propagate: the caller fails closed.
 */
export async function resolveHookAuthProfile(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<HookAuthProfile> {
  const launchProfile = readLaunchProfile(env);
  if (launchProfile) {
    return launchProfile;
  }

  const configDir = await findNearestConfigDir(env.CLAUDE_PROJECT_DIR?.trim() || cwd);
  const config = await ConfigLoader.load(configDir);
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    ssoUrl: config.codeMieUrl || config.baseUrl,
  };
}
