import { userInfo } from 'node:os';
import type { SSOCredentials, JWTCredentials } from '@/providers/core/types.js';
import { isSSOCredentials, isJWTCredentials } from '@/providers/core/types.js';

export type IdentitySource = 'jwt' | 'git' | 'codemie_cli' | 'os' | '';

export interface ResolvedIdentity {
  developerName: string;
  identitySource: IdentitySource;
}

/**
 * Decode a JWT's payload segment without verifying its signature. Analytics
 * identity resolution only reads claims already trusted by the caller
 * (the token backing the active session) — it never performs auth. Returns
 * `{}` for a malformed/non-JWT string instead of throwing.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

/**
 * Tier 1 — jwt: pull `email` straight off the JWT credential's claims, or off
 * the SSO session's `codemie_access_token` cookie claims (`email`, falling
 * back to `preferred_username`).
 */
function resolveJwtIdentity(credentials: SSOCredentials | JWTCredentials): string {
  if (isJWTCredentials(credentials)) {
    const claims = decodeJwtClaims(credentials.token);
    if (typeof claims['email'] === 'string' && claims['email']) return claims['email'];
  }
  if (isSSOCredentials(credentials)) {
    const accessToken = credentials.cookies['codemie_access_token'];
    if (accessToken) {
      const claims = decodeJwtClaims(accessToken);
      const email = claims['email'] ?? claims['preferred_username'];
      if (typeof email === 'string' && email) return email;
    }
  }
  return '';
}

/**
 * Tier 2 — git: `git config user.email`, falling back to `git config
 * user.name` when the repo has no email configured. A non-git directory (or
 * any exec failure) resolves to `''` so the chain falls through — never
 * throws.
 */
async function resolveGitIdentity(cwd: string): Promise<string> {
  if (!cwd) return '';
  try {
    const { exec } = await import('@/utils/exec.js');
    const emailResult = await exec('git', ['config', 'user.email'], { cwd });
    if (emailResult.code === 0 && emailResult.stdout.trim()) {
      return emailResult.stdout.trim();
    }
    const nameResult = await exec('git', ['config', 'user.name'], { cwd });
    if (nameResult.code === 0 && nameResult.stdout.trim()) {
      return nameResult.stdout.trim();
    }
  } catch {
    /* best-effort */
  }
  return '';
}

/**
 * Tier 3 — codemie_cli: the `userEmail` persisted on the global CodeMie CLI
 * config (set via `ConfigLoader.saveUserEmail()`). `userEmail` lives on
 * `MultiProviderConfig`, not on the merged `CodeMieConfigOptions` that
 * `ConfigLoader.load()` returns, so this reads the multi-provider config
 * directly via `loadMultiProviderConfig()` — a global lookup, hence no `cwd`
 * dependency. Any load failure (missing/unreadable/malformed config)
 * resolves to `''`.
 */
async function resolveCodemieCliIdentity(): Promise<string> {
  try {
    const { ConfigLoader } = await import('@/utils/config.js');
    const config = await ConfigLoader.loadMultiProviderConfig();
    if (config.userEmail) return config.userEmail;
  } catch {
    /* best-effort */
  }
  return '';
}

/**
 * Tier 4 — os: the OS-reported username for the daemon process. Practically
 * never empty, but guarded anyway since some sandboxed environments can make
 * `os.userInfo()` throw.
 */
function resolveOsIdentity(): string {
  try {
    return userInfo().username || '';
  } catch {
    return '';
  }
}

/**
 * Resolve a developer identity for analytics stamping, trying each tier in
 * order and returning the first non-empty result:
 *
 *   jwt -> git -> codemie_cli -> os
 *
 * Never throws — every tier swallows its own failures internally.
 */
export async function resolveIdentity(
  credentials: SSOCredentials | JWTCredentials,
  cwd: string
): Promise<ResolvedIdentity> {
  try {
    const jwtIdentity = resolveJwtIdentity(credentials);
    if (jwtIdentity) return { developerName: jwtIdentity, identitySource: 'jwt' };

    const gitIdentity = await resolveGitIdentity(cwd);
    if (gitIdentity) return { developerName: gitIdentity, identitySource: 'git' };

    const cliIdentity = await resolveCodemieCliIdentity();
    if (cliIdentity) return { developerName: cliIdentity, identitySource: 'codemie_cli' };

    const osIdentity = resolveOsIdentity();
    if (osIdentity) return { developerName: osIdentity, identitySource: 'os' };

    return { developerName: '', identitySource: '' };
  } catch {
    return { developerName: '', identitySource: '' };
  }
}
