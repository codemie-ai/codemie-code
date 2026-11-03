/**
 * Integration coverage for the git delivery target (`GitTarget`,
 * `src/cli/commands/analytics/sync/targets/git-target.ts`) against real local bare
 * repositories (`file://` URLs) — the plain `git` behaviour (shallow clones, rejected
 * pushes, rebase retries) that a fake `GitRunner` can't prove on its own.
 *
 * Covers AC5 (two-member rebase: member B pushes first, member A's `deliver` rebases onto
 * the new tip and succeeds without touching B's file), git-path nesting under the
 * configured `path`, and resolving the default branch when `branch` is left unset.
 *
 * `GIT_ALLOW_PROTOCOL=file` is set here (test setup only, never in production code) in
 * case the local git install restricts the `file://` transport by default.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitRunner, type GitRunner } from '@/cli/commands/analytics/sync/targets/git-client.js';
import { GitTarget } from '@/cli/commands/analytics/sync/targets/git-target.js';
import type { GitSettings, SyncReport } from '@/cli/commands/analytics/sync/types.js';

process.env.GIT_ALLOW_PROTOCOL = 'file';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function report(owner: string): SyncReport {
  return {
    fileName: `codemie-analytics-${owner}-example-com-2026-11-03.report.json`,
    bytes: Buffer.from(JSON.stringify({ owner }), 'utf-8'),
  };
}

/** Wraps a real `GitRunner` so that the first call to `git push` runs `onFirstPush` (and
 * awaits it) before letting the real push proceed — used to deterministically land another
 * member's push in between this target's fetch/reset and its own push attempt. */
function raceOnFirstPush(run: GitRunner, onFirstPush: () => Promise<void>): GitRunner {
  let triggered = false;
  return async (args, opts) => {
    if (!triggered && args[0] === 'push') {
      triggered = true;
      await onFirstPush();
    }
    return run(args, opts);
  };
}

describe('GitTarget integration (local bare repos)', () => {
  let root: string;
  let bareDir: string;
  let repoUrl: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'analytics-sync-git-target-'));
    bareDir = join(root, 'bare.git');
    git(['init', '--bare', '-b', 'main', bareDir], root);

    // Seed an initial commit so the bare repo has a real default branch to clone.
    const seedDir = join(root, 'seed');
    git(['clone', bareDir, seedDir], root);
    writeSeedFile(seedDir);
    git(['add', '-A'], seedDir);
    git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-m', 'seed'], seedDir);
    git(['push', 'origin', 'HEAD:main'], seedDir);

    repoUrl = `file://${bareDir}`;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSeedFile(seedDir: string): void {
    writeFileSync(join(seedDir, 'README.md'), 'seed');
  }

  function cloneForVerification(): string {
    const verifyDir = join(root, 'verify');
    git(['clone', '--depth', '1', bareDir, verifyDir], root);
    return verifyDir;
  }

  it('AC5: when member B pushes first, member A rebases and succeeds without touching B\'s file; A lands on the default branch', async () => {
    const run = createGitRunner();

    const bDir = join(root, 'b-work');
    const settings: GitSettings = { repoUrl };
    const targetB = new GitTarget(settings, 'bob@example.com', run, bDir);
    const reportB = report('bob');

    const aDir = join(root, 'a-work');
    const raceRun = raceOnFirstPush(run, () => targetB.deliver(reportB));
    let aPushCalls = 0;
    let aRebaseCalls = 0;
    const countingRun: GitRunner = async (args, opts) => {
      if (args[0] === 'push') aPushCalls += 1;
      if (args[0] === 'rebase') aRebaseCalls += 1;
      return raceRun(args, opts);
    };
    const targetA = new GitTarget(settings, 'alice@example.com', countingRun, aDir);
    const reportA = report('alice');

    await targetA.deliver(reportA);

    // Proves the rebase-retry path actually ran (B's push really did land in between A's
    // fetch/reset and A's own push), not just that the end state happens to look right.
    expect(aPushCalls).toBe(2);
    expect(aRebaseCalls).toBe(1);

    const verifyDir = cloneForVerification();

    const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: verifyDir })
      .toString()
      .trim();
    expect(branch).toBe('main');

    const aliceContent = readFileSync(
      join(verifyDir, 'alice-example-com', reportA.fileName),
      'utf-8'
    );
    expect(JSON.parse(aliceContent)).toEqual({ owner: 'alice' });

    const bobContent = readFileSync(join(verifyDir, 'bob-example-com', reportB.fileName), 'utf-8');
    expect(JSON.parse(bobContent)).toEqual({ owner: 'bob' });
  }, 30_000);

  it('nests the slug folder under the configured git path on the resolved default branch', async () => {
    const run = createGitRunner();
    const settings: GitSettings = { repoUrl, path: 'team/reports' };
    const workDir = join(root, 'carol-work');
    const target = new GitTarget(settings, 'carol@example.com', run, workDir);
    const carolReport = report('carol');

    await target.deliver(carolReport);

    const verifyDir = cloneForVerification();
    const content = readFileSync(
      join(verifyDir, 'team', 'reports', 'carol-example-com', carolReport.fileName),
      'utf-8'
    );
    expect(JSON.parse(content)).toEqual({ owner: 'carol' });
  }, 30_000);
});
