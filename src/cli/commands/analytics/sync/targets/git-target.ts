/**
 * Git delivery target for `codemie analytics sync`.
 *
 * Pushes the analytics export as a JSON file into a team-owned git repository, under
 * `<git-path>/<lowercased email slug>/` only — never anywhere else in the repo, and the
 * working copy is never force-pushed. Member identity isolation (each developer only ever
 * writes inside their own slug folder) means one member's push can never race another's:
 * a concurrent push from a different slug folder can still trigger a rebase retry (a
 * fast-forward is still required), but it never conflicts on content.
 *
 * `ensureWorkingCopy` keeps one shallow working copy at {@link gitWorkingCopyPath} (or the
 * `dir` constructor override, used by tests): a fresh `clone --depth 1` when no valid copy
 * exists yet, or a `fetch --depth 1` + `reset --hard` + `clean -fdx` refresh of an existing
 * one. A working copy is "valid" when `remote get-url origin` matches the configured
 * `repoUrl`; anything else (missing directory, corrupt git state, mismatched remote, or a
 * failed fetch/reset) removes the directory (`fs.rm` recursive+force, not a shell `rm -rf`)
 * and re-clones. When `branch` is unset, the default branch is resolved from the working
 * copy's own `HEAD` (`symbolic-ref --short HEAD`) right after a fresh clone, or from the
 * existing copy's current branch on the refresh path — the copy was cloned onto the
 * remote's default branch originally, so its current branch name is still that default.
 *
 * `deliver`/`testPush` write under the target's slug folder, stage only that folder
 * (`git add --`), skip the commit entirely when nothing changed (`git diff --cached
 * --quiet` exits 0), and otherwise commit with `-c user.email=<email> -c user.name=<email>`
 * (so the shared working copy never depends on a locally configured git identity) before
 * pushing. A push rejected as a non-fast-forward (`gitCause === 'rejected'`) is retried by
 * fetching and rebasing onto `origin/<branch>`, up to {@link MAX_PUSH_ATTEMPTS} push calls
 * total; any other push failure (auth, protected branch, …) is rethrown immediately. No
 * token is ever requested or stored — `repoUrl` is whatever Task 1's settings validation
 * already accepted.
 */

import { mkdir, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { SyncGitError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath } from '@/utils/paths.js';

import { emailSlug } from '../../report/report-generator.js';
import type { GitSettings, SyncReport } from '../types.js';
import type { GitRunner } from './git-client.js';

/** Total push attempts (first try + retries) before a rejected push gives up. */
export const MAX_PUSH_ATTEMPTS = 3;

const CHECK_FILE_NAME = '.codemie-sync-check';

/** Absolute path to the one shared shallow working copy `codemie analytics sync` keeps for
 * the git target. */
export function gitWorkingCopyPath(): string {
  return getCodemiePath('analytics-sync-repo');
}

/** Absolute path to the git target's own "last sent" marker (kept separate from the
 * webhook target's `analytics-last-sent`). */
export function gitMarkerPath(): string {
  return getCodemiePath('analytics-last-sent-git');
}

/** Pushes one analytics export into a team git repository, under the caller's own slug
 * folder. One instance per sync run (settings/email/runner don't change mid-run); the
 * working copy on disk persists across runs. */
export class GitTarget {
  readonly id = 'git';

  constructor(
    private readonly git: GitSettings,
    private readonly email: string,
    private readonly run: GitRunner,
    private readonly dir: string = gitWorkingCopyPath()
  ) {}

  /** Commits and pushes `<git-path>/<slug>/<report.fileName>`. */
  async deliver(report: SyncReport): Promise<void> {
    const branch = await this.ensureWorkingCopy();
    const relFolder = this.slugFolder();

    const absFolder = join(this.dir, ...relFolder.split('/'));
    await mkdir(absFolder, { recursive: true });
    await writeFile(join(absFolder, report.fileName), report.bytes);

    await this.commitAndPush(branch, relFolder, `analytics sync: ${relFolder}/${report.fileName}`);
  }

  /** Commits and pushes `<git-path>/<slug>/.codemie-sync-check`, used by `install` to prove
   * push access. The placeholder's content is an ISO timestamp so a repeated check always
   * has something to commit. */
  async testPush(): Promise<void> {
    const branch = await this.ensureWorkingCopy();
    const relFolder = this.slugFolder();

    const absFolder = join(this.dir, ...relFolder.split('/'));
    await mkdir(absFolder, { recursive: true });
    await writeFile(join(absFolder, CHECK_FILE_NAME), new Date().toISOString());

    await this.commitAndPush(branch, relFolder, 'analytics sync: connectivity check');
  }

  private slugFolder(): string {
    const slug = emailSlug(this.email.toLowerCase());
    return this.git.path ? `${this.git.path}/${slug}` : slug;
  }

  /** Ensures a valid, up-to-date working copy exists at `this.dir` and returns the branch
   * it is (now) on. */
  private async ensureWorkingCopy(): Promise<string> {
    if (await this.hasValidRemote()) {
      try {
        return await this.refreshWorkingCopy();
      } catch (err) {
        logger.debug(
          `[sync:git] working copy at ${this.dir} failed to refresh, re-cloning: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    await rm(this.dir, { recursive: true, force: true });
    return this.cloneWorkingCopy();
  }

  private async hasValidRemote(): Promise<boolean> {
    try {
      const url = await this.run(['remote', 'get-url', 'origin'], { cwd: this.dir });
      return url === this.git.repoUrl;
    } catch {
      return false;
    }
  }

  private async cloneWorkingCopy(): Promise<string> {
    await mkdir(dirname(this.dir), { recursive: true });

    const args = [
      'clone',
      '--depth',
      '1',
      ...(this.git.branch ? ['--branch', this.git.branch] : []),
      this.git.repoUrl,
      this.dir,
    ];
    await this.run(args, { network: true });

    return this.resolveBranch();
  }

  private async refreshWorkingCopy(): Promise<string> {
    const branch = await this.resolveBranch();

    await this.run(['fetch', '--depth', '1', 'origin', branch], { cwd: this.dir, network: true });
    await this.run(['reset', '--hard', `origin/${branch}`], { cwd: this.dir });
    await this.run(['clean', '-fdx'], { cwd: this.dir });

    return branch;
  }

  /** `branch` is already configured -> use it as-is. Otherwise resolve the working copy's
   * own current branch (set to the remote's default by the clone that created it). */
  private async resolveBranch(): Promise<string> {
    if (this.git.branch) {
      return this.git.branch;
    }
    return this.run(['symbolic-ref', '--short', 'HEAD'], { cwd: this.dir });
  }

  private async commitAndPush(branch: string, relFolder: string, message: string): Promise<void> {
    await this.run(['add', '--', relFolder], { cwd: this.dir });

    if (!(await this.hasStagedChanges(relFolder))) {
      logger.debug(`[sync:git] nothing to commit for ${relFolder}`);
      return;
    }

    await this.run(
      ['-c', `user.email=${this.email}`, '-c', `user.name=${this.email}`, 'commit', '-m', message],
      { cwd: this.dir }
    );

    await this.push(branch);
  }

  /** `git diff --cached --quiet` exits 0 when nothing is staged, non-zero (classified as a
   * `SyncGitError`) when something is — a local, network-free check, so any thrown error is
   * treated as "there are staged changes" rather than re-thrown. */
  private async hasStagedChanges(relFolder: string): Promise<boolean> {
    try {
      await this.run(['diff', '--cached', '--quiet', '--', relFolder], { cwd: this.dir });
      return false;
    } catch {
      return true;
    }
  }

  private async push(branch: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
      try {
        await this.run(['push', 'origin', `HEAD:${branch}`], { cwd: this.dir, network: true });
        return;
      } catch (err) {
        const isRejected = err instanceof SyncGitError && err.gitCause === 'rejected';
        if (!isRejected || attempt === MAX_PUSH_ATTEMPTS) {
          throw err;
        }

        await this.run(['fetch', '--depth', '1', 'origin', branch], { cwd: this.dir, network: true });
        await this.run(['rebase', `origin/${branch}`], { cwd: this.dir });
      }
    }
  }
}
