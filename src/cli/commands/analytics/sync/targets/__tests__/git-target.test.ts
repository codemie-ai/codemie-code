import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncGitError, type GitFailureCause } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';

import type { GitSettings, SyncReport } from '../../types.js';
import type { GitRunner } from '../git-client.js';
import { GitTarget, MAX_PUSH_ATTEMPTS, gitMarkerPath, gitWorkingCopyPath } from '../git-target.js';

interface RunCall {
  args: string[];
  /** `args` without the leading `-c <key=value>` pairs: the git subcommand and its own args. */
  sub: string[];
  opts: { cwd?: string; network?: boolean };
}

function stripConfig(args: string[]): string[] {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args.slice(i);
}

type Handler = (call: RunCall, callIndex: number) => string | Promise<string>;

function createFakeRunner(handler: Handler): { run: GitRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: GitRunner = async (args, opts) => {
    const call: RunCall = { args, sub: stripConfig(args), opts };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { run, calls };
}

function rejectedError(): SyncGitError {
  return new SyncGitError(' ! [rejected] main -> main (fetch first)', 'rejected');
}

function errorWith(cause: GitFailureCause): SyncGitError {
  return new SyncGitError(`git failed: ${cause}`, cause);
}

const REPO_URL = 'https://example.invalid/team/repo.git';
const EMAIL = 'Jane@Example.com';
const SLUG = 'jane-example-com'; // emailSlug(email.toLowerCase())

function report(fileName = 'codemie-analytics-jane-example-com-2026-11-03.report.json'): SyncReport {
  return { fileName, bytes: Buffer.from('{"ok":true}', 'utf-8') };
}

describe('gitWorkingCopyPath / gitMarkerPath', () => {
  it('resolves under the codemie home directory', () => {
    expect(gitWorkingCopyPath()).toBe(getCodemiePath('analytics-sync-repo'));
    expect(gitMarkerPath()).toBe(getCodemiePath('analytics-last-sent-git'));
  });
});

describe('MAX_PUSH_ATTEMPTS', () => {
  it('is 3', () => {
    expect(MAX_PUSH_ATTEMPTS).toBe(3);
  });
});

describe('GitTarget', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'git-target-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const gitSettings: GitSettings = { repoUrl: REPO_URL };

  it('clones fresh, resolves the default branch, and pushes a new report', async () => {
    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') {
        throw new Error('fatal: not a git repository');
      }
      if (cmd === 'clone') {
        return '';
      }
      if (cmd === 'symbolic-ref') {
        return 'main';
      }
      if (cmd === 'add') {
        return '';
      }
      if (cmd === 'diff') {
        throw errorWith('other'); // exit 1: staged changes present
      }
      if (cmd === 'commit') {
        return '';
      }
      if (cmd === 'push') {
        return '';
      }
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.deliver(report());

    expect(calls[0].args).toEqual(['remote', 'get-url', 'origin']);
    expect(calls[1].args).toEqual(['clone', '--depth', '1', '--', REPO_URL, dir]);
    expect(calls[1].opts.network).toBe(true);
    expect(calls[2].args).toEqual(['symbolic-ref', '--short', 'HEAD']);
    expect(calls[3].args).toEqual(['add', '--', SLUG]);
    expect(calls[4].args).toEqual(['diff', '--cached', '--quiet', '--', SLUG]);
    const commitCall = calls[5];
    expect(commitCall.args).toEqual([
      '-c',
      `user.email=${EMAIL}`,
      '-c',
      `user.name=${EMAIL}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${join(dir, '.git', 'codemie-sync-no-hooks')}`,
      'commit',
      '--no-verify',
      '-m',
      `analytics sync: ${SLUG}/${report().fileName}`,
    ]);
    expect(calls[6].args).toEqual(['push', '--no-verify', 'origin', 'HEAD:main']);
    expect(calls[6].opts.network).toBe(true);
    expect(calls).toHaveLength(7);

    const written = await readFile(join(dir, SLUG, report().fileName), 'utf-8');
    expect(written).toBe('{"ok":true}');
  });

  it('nests the slug folder under the configured git path and uses the explicit branch', async () => {
    const settings: GitSettings = { repoUrl: REPO_URL, branch: 'develop', path: 'team/reports' };
    const relFolder = `team/reports/${SLUG}`;

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(settings, EMAIL, run, dir);
    await target.deliver(report());

    expect(calls[1].args).toEqual(['clone', '--depth', '1', '--branch', 'develop', '--', REPO_URL, dir]);
    expect(calls.some((c) => c.sub[0] === 'symbolic-ref')).toBe(false);
    expect(calls[2].args).toEqual(['add', '--', relFolder]);
    expect(calls[5].args).toEqual(['push', '--no-verify', 'origin', 'HEAD:develop']);

    const written = await readFile(join(dir, 'team', 'reports', SLUG, report().fileName), 'utf-8');
    expect(written).toBe('{"ok":true}');
  });

  it('refreshes an existing valid working copy via fetch + reset + clean', async () => {
    await mkdir(dir, { recursive: true });

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') return REPO_URL;
      if (cmd === 'ls-remote') return 'ref: refs/heads/main\tHEAD\n0123abcd\tHEAD';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'fetch') return '';
      if (cmd === 'reset') return '';
      if (cmd === 'clean') return '';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.deliver(report());

    expect(calls[0].args).toEqual(['remote', 'get-url', 'origin']);
    expect(calls[1].args).toEqual(['ls-remote', '--symref', 'origin', 'HEAD']);
    expect(calls[1].opts.network).toBe(true);
    expect(calls[2].args).toEqual(['symbolic-ref', '--short', 'HEAD']);
    expect(calls[3].args).toEqual(['fetch', '--depth', '1', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    expect(calls[3].opts.network).toBe(true);
    expect(calls[4].args).toEqual(['reset', '--hard', 'origin/main']);
    expect(calls[5].args).toEqual(['clean', '-fdx']);
    expect(calls.some((c) => c.sub[0] === 'clone')).toBe(false);
  });

  it('treats "nothing to commit" as delivered: no commit and no push', async () => {
    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') return ''; // exit 0: nothing staged
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await expect(target.deliver(report())).resolves.toBeUndefined();

    expect(calls.some((c) => c.sub[0] === 'commit')).toBe(false);
    expect(calls.some((c) => c.sub[0] === 'push')).toBe(false);
  });

  it('removes and re-clones when an existing copy has a mismatched remote', async () => {
    await mkdir(join(dir, 'stale-marker'), { recursive: true });

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') return 'https://example.invalid/other/repo.git';
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.deliver(report());

    expect(calls.some((c) => c.sub[0] === 'fetch')).toBe(false);
    expect(calls[1].args[0]).toBe('clone');
  });

  it('removes and re-clones when refreshing an existing copy fails (dirty/corrupt)', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'leftover.txt'), 'stale');

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') return REPO_URL;
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'fetch') throw errorWith('other');
      if (cmd === 'clone') return '';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.deliver(report());

    const cloneIndex = calls.findIndex((c) => c.sub[0] === 'clone');
    expect(cloneIndex).toBeGreaterThan(-1);
    expect(calls.some((c) => c.sub[0] === 'reset')).toBe(false);
    await expect(readFile(join(dir, 'leftover.txt'), 'utf-8')).rejects.toThrow();
  });

  it('on a rejected push: fetches, rebases onto origin/<branch>, and retries', async () => {
    let pushCalls = 0;

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') {
        pushCalls += 1;
        if (pushCalls === 1) throw rejectedError();
        return '';
      }
      if (cmd === 'fetch') return '';
      if (cmd === 'rebase') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.deliver(report());

    expect(pushCalls).toBe(2);
    expect(calls.some((c) => c.sub[0] === 'fetch')).toBe(true);
    expect(calls.some((c) => c.sub.join(' ') === 'rebase --onto origin/main HEAD~1')).toBe(true);
    expect(calls.some((c) => c.sub.join(' ') === 'fetch --depth 1 origin +refs/heads/main:refs/remotes/origin/main')).toBe(true);
  });

  it('throws SyncGitError(rejected) after exactly MAX_PUSH_ATTEMPTS push calls', async () => {
    let pushCalls = 0;

    const { run } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') {
        pushCalls += 1;
        throw rejectedError();
      }
      if (cmd === 'fetch') return '';
      if (cmd === 'rebase') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);

    await expect(target.deliver(report())).rejects.toMatchObject({
      name: 'SyncGitError',
      gitCause: 'rejected',
    });
    expect(pushCalls).toBe(MAX_PUSH_ATTEMPTS);
  });

  it('rethrows a non-rejected push failure immediately, without retrying', async () => {
    let pushCalls = 0;

    const { run } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') {
        pushCalls += 1;
        throw errorWith('auth');
      }
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);

    await expect(target.deliver(report())).rejects.toMatchObject({
      name: 'SyncGitError',
      gitCause: 'auth',
    });
    expect(pushCalls).toBe(1);
  });

  it('testPush commits and pushes a .codemie-sync-check placeholder', async () => {
    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.testPush();

    expect(calls.some((c) => c.sub[0] === 'add' && c.sub[2] === SLUG)).toBe(true);
    expect(calls.some((c) => c.sub[0] === 'push')).toBe(true);

    const written = await readFile(join(dir, SLUG, '.codemie-sync-check'), 'utf-8');
    expect(() => new Date(written).toISOString()).not.toThrow();
    expect(new Date(written).toISOString()).toBe(written);
  });
  it('re-clones when the copy is on another branch than the remote default and no branch is configured (CR-011)', async () => {
    await mkdir(dir, { recursive: true });

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') return REPO_URL;
      if (cmd === 'ls-remote') return 'ref: refs/heads/main\tHEAD\n0123abcd\tHEAD';
      if (cmd === 'symbolic-ref') return calls.some((c) => c.sub[0] === 'clone') ? 'main' : 'old-branch';
      if (cmd === 'clone') return '';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.deliver(report());

    expect(calls.some((c) => c.sub[0] === 'fetch')).toBe(false);
    expect(calls.some((c) => c.sub[0] === 'clone')).toBe(true);
    expect(calls.find((c) => c.sub[0] === 'push')?.args).toEqual(['push', '--no-verify', 'origin', 'HEAD:main']);
  });

  it('re-clones when the copy is on another branch than the configured one (CR-011)', async () => {
    await mkdir(dir, { recursive: true });

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') return REPO_URL;
      if (cmd === 'symbolic-ref') return 'develop';
      if (cmd === 'clone') return '';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget({ repoUrl: REPO_URL, branch: 'main' }, EMAIL, run, dir);
    await target.deliver(report());

    expect(calls.some((c) => c.sub[0] === 'fetch')).toBe(false);
    expect(calls.find((c) => c.sub[0] === 'clone')?.args).toEqual([
      'clone', '--depth', '1', '--branch', 'main', '--', REPO_URL, dir,
    ]);
  });

  it('a failed retry rebase is aborted and the error rethrown (CR-013)', async () => {
    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === 'commit') return '';
      if (cmd === 'push') throw rejectedError();
      if (cmd === 'fetch') return '';
      if (cmd === 'rebase' && call.sub[1] === '--abort') return '';
      if (cmd === 'rebase') throw new SyncGitError('CONFLICT (add/add): Merge conflict', 'other');
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);

    await expect(target.deliver(report())).rejects.toThrow(/CONFLICT/);
    const rebaseIndex = calls.findIndex((c) => c.sub[0] === 'rebase' && c.sub[1] === '--onto');
    expect(calls[rebaseIndex + 1].sub).toEqual(['rebase', '--abort']);
    const rebaseCall = calls[rebaseIndex];
    expect(rebaseCall.args).toContain('commit.gpgsign=false');
    expect(rebaseCall.args).toContain(`user.email=${EMAIL}`);
  });

  it('clears a leftover in-progress rebase before refreshing the copy (CR-013)', async () => {
    await mkdir(join(dir, '.git', 'rebase-merge'), { recursive: true });
    await mkdir(join(dir, '.git', 'rebase-apply'), { recursive: true });

    const { run } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') return REPO_URL;
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'fetch') return '';
      if (cmd === 'reset') return '';
      if (cmd === 'clean') return '';
      if (cmd === 'add') return '';
      if (cmd === 'diff') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget({ repoUrl: REPO_URL, branch: 'main' }, EMAIL, run, dir);
    await target.deliver(report());

    await expect(readdir(join(dir, '.git'))).resolves.toEqual([]);
  });

  it('refuses to write outside the working copy for an escaping path (CR-005)', async () => {
    const { run } = createFakeRunner((call) => {
      const [cmd] = call.sub;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget({ repoUrl: REPO_URL, path: '../../escape' }, EMAIL, run, join(dir, 'a', 'b'));

    await expect(target.deliver(report())).rejects.toThrow(/outside the working copy/);
    await expect(readdir(dir)).resolves.toEqual(['a']);
  });
});
