/**
 * Developer identity resolution for `codemie analytics sync`.
 *
 * Mirrors the `codemie_cli` and `git` tiers of
 * `src/agents/core/identity-resolver.ts` (config email first, then
 * `git config --global user.email`), but resolves the email only — no `user.name`
 * fallback — and throws `SyncIdentityMissingError` when neither source
 * yields one, instead of falling through to an OS-username tier.
 */

import { SyncIdentityMissingError } from '@/utils/errors.js';

/**
 * Email shape accepted by the `install` command's interactive prompt. Moved here (from
 * `cli/commands/analytics/index.ts`) so the install runner can validate the prompted value
 * without importing the CLI command module.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SyncIdentityDeps {
  loadUserEmail(): Promise<string | undefined>;
  gitEmail(): Promise<string | undefined>;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the developer email used to identify this machine's sync uploads.
 *
 * Tries `deps.loadUserEmail()` first, then `deps.gitEmail()`. Both are
 * expected to be best-effort (resolving to `undefined` rather than
 * rejecting), but a rejection here would still propagate — only
 * `realIdentityDeps` below guarantees the best-effort contract for the
 * real dependencies.
 */
export async function resolveSyncIdentity(deps: SyncIdentityDeps): Promise<string> {
  const configEmail = nonEmpty(await deps.loadUserEmail());
  if (configEmail) {
    return configEmail;
  }

  const gitEmail = nonEmpty(await deps.gitEmail());
  if (gitEmail) {
    return gitEmail;
  }

  throw new SyncIdentityMissingError();
}

/**
 * Real dependencies for `resolveSyncIdentity`: the persisted CodeMie CLI
 * config email, then the global `git config --global user.email`. The global
 * scope (not the process cwd's repo-local email) keeps install, run from the
 * developer's shell, and the scheduled job — which has no working directory —
 * resolving the same email. Each is best-effort — any failure (missing/unreadable config, no git,
 * non-git directory) resolves to `undefined` rather than throwing.
 */
export const realIdentityDeps: SyncIdentityDeps = {
  async loadUserEmail(): Promise<string | undefined> {
    try {
      const { ConfigLoader } = await import('@/utils/config.js');
      const config = await ConfigLoader.loadMultiProviderConfig();
      return config.userEmail;
    } catch {
      return undefined;
    }
  },
  async gitEmail(): Promise<string | undefined> {
    try {
      const { exec } = await import('@/utils/exec.js');
      const result = await exec('git', ['config', '--global', 'user.email']);
      if (result.code === 0) {
        return result.stdout;
      }
      return undefined;
    } catch {
      return undefined;
    }
  },
};
