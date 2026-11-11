/**
 * The guided wizard's git step group: repo/branch/path entry and a temporary-copy test
 * push, used when a lead chooses the git delivery target (plan EPMCDME-17123 task 5 wires
 * this into the guided flow; this module is not yet imported by anything).
 *
 * `askGitDetails` prompts for the three `GitSettings` fields, retrying the repo URL via
 * `askValidated` on `validateGitRepoUrl`'s `SyncConfigError` (a credential-bearing or
 * option-injecting value is rejected and re-asked — the rejection message never echoes the
 * raw value, so a token or password never reaches the terminal). Branch and path are left
 * `undefined` on blank input, so `install`'s own defaults (the remote's default branch, the
 * repo root) apply.
 *
 * `testGitCheck` resolves the report email via `resolveSyncIdentity`, falling back to an
 * unsaved guided-mode prompt only when that throws `SyncIdentityMissingError` and a terminal
 * is attached; a non-interactive caller gets the same error back. It then test-pushes
 * against a fresh `fs.mkdtemp`-based temporary working copy — never the shared one at
 * `gitWorkingCopyPath()` — passed as `GitTarget`'s `dir` override, and always removes that
 * directory in a `finally`, on both success and failure.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { SyncConfigError, SyncGitError, SyncIdentityMissingError } from '@/utils/errors.js';

import { validateGitBranch, validateGitPath, validateGitRepoUrl } from '../config-store.js';
import { EMAIL_REGEX, realIdentityDeps, resolveSyncIdentity } from '../identity.js';
import { errorMessage } from '../redact.js';
import { createGitRunner, gitHint } from '../targets/git-client.js';
import { GitTarget } from '../targets/git-target.js';
import type { GitSettings } from '../types.js';
import { askValidated } from './guided-support.js';
import type { BootstrapDeps } from './types.js';

/** Prefix for the temporary working copy `testGitCheck` test-pushes into. */
const TEMP_DIR_PREFIX = 'codemie-sync-bootstrap-';

/** Previously saved repo/branch/path, offered as each prompt's default. */
export interface GitDetailsSaved {
  repoUrl?: string;
  branch?: string;
  path?: string;
}

export type GitDetails = GitSettings;

/** `value` as a prompt default only when it passes `validate` and is not blank: a saved
 * value that fails (a hand-edited, credential-bearing URL above all) is never shown. */
function safeDefault(value: string | undefined, validate: (raw: string) => unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return validate(value) === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Prompts for the git repo URL (required, retried on an invalid/credential-bearing value),
 * then branch and path (each optional — blank leaves them `undefined`). A saved answer that
 * no longer validates is not offered back as a default.
 */
export async function askGitDetails(deps: BootstrapDeps, saved?: GitDetailsSaved): Promise<GitDetails> {
  const repoUrl = await askValidated(
    deps,
    'Git repository URL (SSH or HTTPS, no embedded credentials)',
    (raw) => {
      const value = validateGitRepoUrl(raw);
      if (value === undefined) {
        throw new SyncConfigError('A git repository URL is required.');
      }
      return value;
    },
    safeDefault(saved?.repoUrl, validateGitRepoUrl)
  );

  const branch = await askValidated(
    deps,
    "Branch (leave blank for the repository's default)",
    (raw) => (raw.trim() === '' ? undefined : validateGitBranch(raw)),
    safeDefault(saved?.branch, validateGitBranch)
  );

  const path = await askValidated(
    deps,
    'Path within the repository (leave blank for the repository root)',
    (raw) => validateGitPath(raw),
    safeDefault(saved?.path, validateGitPath)
  );

  return {
    repoUrl,
    ...(branch !== undefined && { branch }),
    ...(path !== undefined && { path })
  };
}

/**
 * Resolves the email `testGitCheck` pushes a commit as: `email` when already known,
 * otherwise `resolveSyncIdentity(realIdentityDeps)`. When that throws
 * `SyncIdentityMissingError` and a terminal is attached, prompts for one (never saved) via
 * `askValidated`, validated against `EMAIL_REGEX`; the retry message never echoes the typed
 * value. Any other failure, or the same failure with no TTY, propagates — never a credential
 * prompt.
 */
async function resolveTestEmail(deps: BootstrapDeps, email: string | undefined): Promise<string> {
  if (email !== undefined) {
    return email;
  }

  try {
    return await resolveSyncIdentity(realIdentityDeps);
  } catch (err) {
    if (!(err instanceof SyncIdentityMissingError) || !deps.isTTY) {
      throw err;
    }

    return askValidated(deps, 'Email address for analytics reports (not saved)', (raw) => {
      const trimmed = raw.trim();
      if (!EMAIL_REGEX.test(trimmed)) {
        throw new SyncConfigError('Enter a valid email address, e.g. name@example.com.');
      }
      return trimmed;
    });
  }
}

/**
 * Test-pushes `git` into a fresh temporary working copy (never `gitWorkingCopyPath()`),
 * always removed in a `finally` on both success and failure. On failure, prints the
 * redacted cause plus `gitHint(err.gitCause)` for a `SyncGitError`, then offers Try again
 * (loops, re-pushing into the same temp copy) / Enter different repository details (returns
 * `'retry'`, so the caller re-asks `askGitDetails`) / Skip the test (returns `'skipped'`).
 */
export async function testGitCheck(
  deps: BootstrapDeps,
  git: GitSettings,
  email: string | undefined
): Promise<'passed' | 'skipped' | 'retry'> {
  const resolvedEmail = await resolveTestEmail(deps, email);
  const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));

  try {
    const target = new GitTarget(git, resolvedEmail, createGitRunner(), dir);

    for (;;) {
      deps.err('Pushing a test file…');
      try {
        await target.testPush();
      } catch (err) {
        deps.err(`Git test push failed: ${errorMessage(err)}`);
        if (err instanceof SyncGitError) {
          deps.err(gitHint(err.gitCause));
        }

        const choice = await deps.prompt.select(
          'What now?',
          [
            { value: 'retry', name: 'Try again' },
            { value: 'details', name: 'Enter different repository details' },
            { value: 'skip', name: 'Skip the test' }
          ],
          'retry'
        );
        if (choice === 'retry') {
          continue;
        }
        if (choice === 'details') {
          return 'retry';
        }
        return 'skipped';
      }

      deps.err('Git push succeeded: push access to the repository is confirmed.');
      return 'passed';
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
