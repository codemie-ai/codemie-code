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
 * and re-clones. Any leftover rebase state is cleared before a refresh. The branch a
 * refresh expects is the configured `branch`, or — when unset — the remote's current
 * default (`ls-remote --symref origin HEAD`); a copy whose checked-out branch differs (an
 * earlier install used another `--git-branch`, or the remote default moved) is re-cloned.
 * After a fresh clone the branch is the copy's own `HEAD` (`symbolic-ref --short HEAD`).
 * Every positional value reaches git after `--` or behind a fixed prefix (`origin/`,
 * `HEAD:`, `refs/heads/`), so none can be parsed as an option.
 *
 * `deliver`/`testPush` write under the target's slug folder, stage only that folder
 * (`git add --`), skip the commit entirely when nothing changed (`git diff --cached
 * --quiet` exits 0), and otherwise commit with `-c user.email=<email> -c user.name=<email>`
 * (so the shared working copy never depends on a locally configured git identity), with
 * commit signing off, hooks disabled and `--no-verify`, so the unattended job never blocks
 * on a signing prompt or a user's global hook, before pushing (also `--no-verify`). A push
 * rejected as a non-fast-forward (`gitCause === 'rejected'`) is retried by fetching and
 * replaying this run's one commit onto `origin/<branch>` (`rebase --onto origin/<branch>
 * HEAD~1`, which needs no merge base, so a depth-1 fetch is enough), up to
 * {@link MAX_PUSH_ATTEMPTS} push calls total; a rebase that fails is aborted before the
 * error is rethrown. Any other push failure (auth, protected branch, …) is rethrown
 * immediately. No
 * token is ever requested or stored — `repoUrl` is whatever Task 1's settings validation
 * already accepted.
 */

import { mkdir, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { SyncGitError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { getCodemiePath, isPathWithinDirectory } from '@/utils/paths.js';

import { emailSlug } from '../../report/report-generator.js';
import type { GitSettings, SyncReport } from '../types.js';
import type { GitRunner } from './git-client.js';

/** Total push attempts (first try + retries) before a rejected push gives up. */
export const MAX_PUSH_ATTEMPTS = 3;

const CHECK_FILE_NAME = '.codemie-sync-check';

/** Rebase state directories git leaves behind when a rebase stops mid-way. */
const REBASE_STATE_DIRS = ['rebase-merge', 'rebase-apply'];

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

    const absFolder = this.absoluteFolder(relFolder);
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

    const absFolder = this.absoluteFolder(relFolder);
    await mkdir(absFolder, { recursive: true });
    await writeFile(join(absFolder, CHECK_FILE_NAME), new Date().toISOString());

    await this.commitAndPush(branch, relFolder, 'analytics sync: connectivity check');
  }

  private slugFolder(): string {
    const slug = emailSlug(this.email.toLowerCase());
    return this.git.path ? `${this.git.path}/${slug}` : slug;
  }

  /** `relFolder` resolved under the working copy. Settings validation already rejects an
   * escaping path; this is the last guard before anything is written to disk. */
  private absoluteFolder(relFolder: string): string {
    const absFolder = join(this.dir, ...relFolder.split('/'));
    if (!isPathWithinDirectory(this.dir, absFolder)) {
      throw new SyncGitError(`Refusing to write outside the working copy: ${relFolder}`, 'other');
    }
    return absFolder;
  }

  /** `-c` options for a git call that creates commits: the sync identity, no signing, and a
   * hooks path that does not exist, so the unattended job never prompts or runs a hook. */
  private unattendedConfig(): string[] {
    return [
      '-c',
      `user.email=${this.email}`,
      '-c',
      `user.name=${this.email}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${join(this.dir, '.git', 'codemie-sync-no-hooks')}`,
    ];
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
      '--',
      this.git.repoUrl,
      this.dir,
    ];
    await this.run(args, { network: true });

    return this.resolveBranch();
  }

  /** Refreshes an existing copy onto the expected branch. Throws (so the caller re-clones)
   * when the copy is checked out on any other branch. */
  private async refreshWorkingCopy(): Promise<string> {
    const branch = this.git.branch ?? (await this.remoteDefaultBranch());
    const current = await this.currentBranch();
    if (current !== branch) {
      throw new SyncGitError(`working copy is on ${current}, expected ${branch}`, 'other');
    }

    await this.clearRebaseState();
    await this.run(['fetch', '--depth', '1', 'origin', trackingRefspec(branch)], {
      cwd: this.dir,
      network: true,
    });
    await this.run(['reset', '--hard', `origin/${branch}`], { cwd: this.dir });
    await this.run(['clean', '-fdx'], { cwd: this.dir });

    return branch;
  }

  /** The remote's current default branch, from `ls-remote --symref origin HEAD`. */
  private async remoteDefaultBranch(): Promise<string> {
    const output = await this.run(['ls-remote', '--symref', 'origin', 'HEAD'], {
      cwd: this.dir,
      network: true,
    });
    const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output);
    if (match === null) {
      throw new SyncGitError('could not resolve the remote default branch', 'other');
    }
    return match[1];
  }

  private async currentBranch(): Promise<string> {
    return this.run(['symbolic-ref', '--short', 'HEAD'], { cwd: this.dir });
  }

  /** `branch` is already configured -> use it as-is. Otherwise the freshly cloned copy's own
   * current branch, which the clone set to the remote's default. */
  private async resolveBranch(): Promise<string> {
    if (this.git.branch) {
      return this.git.branch;
    }
    return this.currentBranch();
  }

  /** Removes the state a stopped rebase leaves in `.git`, which `reset --hard` and
   * `clean -fdx` do not clear, so a later rebase never fails with "already in progress". */
  private async clearRebaseState(): Promise<void> {
    await Promise.all(
      REBASE_STATE_DIRS.map((name) => rm(join(this.dir, '.git', name), { recursive: true, force: true }))
    );
  }

  private async commitAndPush(branch: string, relFolder: string, message: string): Promise<void> {
    await this.run(['add', '--', relFolder], { cwd: this.dir });

    if (!(await this.hasStagedChanges(relFolder))) {
      logger.debug(`[sync:git] nothing to commit for ${relFolder}`);
      return;
    }

    await this.run([...this.unattendedConfig(), 'commit', '--no-verify', '-m', message], { cwd: this.dir });

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
        await this.run(['push', '--no-verify', 'origin', `HEAD:${branch}`], { cwd: this.dir, network: true });
        return;
      } catch (err) {
        const isRejected = err instanceof SyncGitError && err.gitCause === 'rejected';
        if (!isRejected || attempt === MAX_PUSH_ATTEMPTS) {
          throw err;
        }

        await this.run(['fetch', '--depth', '1', 'origin', trackingRefspec(branch)], {
          cwd: this.dir,
          network: true,
        });
        await this.rebaseOntoRemote(branch);
      }
    }
  }

  /** Replays this run's single commit onto `origin/<branch>`. `--onto ... HEAD~1` needs no
   * merge base, so it works after a depth-1 fetch however many commits landed upstream. A
   * failed rebase is aborted (best effort) so the copy is never left mid-rebase. */
  private async rebaseOntoRemote(branch: string): Promise<void> {
    try {
      await this.run([...this.unattendedConfig(), 'rebase', '--onto', `origin/${branch}`, 'HEAD~1'], {
        cwd: this.dir,
      });
    } catch (err) {
      await this.run(['rebase', '--abort'], { cwd: this.dir }).catch(() => undefined);
      throw err;
    }
  }
}

/** Fetch refspec that updates `origin/<branch>` explicitly, even in a single-branch clone
 * made for another branch. Starts with `+`, so git never reads it as an option. */
function trackingRefspec(branch: string): string {
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}
