import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
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
  opts: { cwd?: string; network?: boolean };
}

type Handler = (call: RunCall, callIndex: number) => string | Promise<string>;

function createFakeRunner(handler: Handler): { run: GitRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: GitRunner = async (args, opts) => {
    const call: RunCall = { args, opts };
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
      const [cmd] = call.args;
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
      if (cmd === '-c') {
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
    expect(calls[1].args).toEqual(['clone', '--depth', '1', REPO_URL, dir]);
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
      'commit',
      '-m',
      `analytics sync: ${SLUG}/${report().fileName}`,
    ]);
    expect(calls[6].args).toEqual(['push', 'origin', 'HEAD:main']);
    expect(calls[6].opts.network).toBe(true);
    expect(calls).toHaveLength(7);

    const written = await readFile(join(dir, SLUG, report().fileName), 'utf-8');
    expect(written).toBe('{"ok":true}');
  });

  it('nests the slug folder under the configured git path and uses the explicit branch', async () => {
    const settings: GitSettings = { repoUrl: REPO_URL, branch: 'develop', path: 'team/reports' };
    const relFolder = `team/reports/${SLUG}`;

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.args;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === '-c') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(settings, EMAIL, run, dir);
    await target.deliver(report());

    expect(calls[1].args).toEqual(['clone', '--depth', '1', '--branch', 'develop', REPO_URL, dir]);
    expect(calls.some((c) => c.args[0] === 'symbolic-ref')).toBe(false);
    expect(calls[2].args).toEqual(['add', '--', relFolder]);
    expect(calls[5].args).toEqual(['push', 'origin', 'HEAD:develop']);

    const written = await readFile(join(dir, 'team', 'reports', SLUG, report().fileName), 'utf-8');
    expect(written).toBe('{"ok":true}');
  });

  it('refreshes an existing valid working copy via fetch + reset + clean', async () => {
    await mkdir(dir, { recursive: true });

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.args;
      if (cmd === 'remote') return REPO_URL;
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'fetch') return '';
      if (cmd === 'reset') return '';
      if (cmd === 'clean') return '';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === '-c') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.deliver(report());

    expect(calls[0].args).toEqual(['remote', 'get-url', 'origin']);
    expect(calls[1].args).toEqual(['symbolic-ref', '--short', 'HEAD']);
    expect(calls[2].args).toEqual(['fetch', '--depth', '1', 'origin', 'main']);
    expect(calls[2].opts.network).toBe(true);
    expect(calls[3].args).toEqual(['reset', '--hard', 'origin/main']);
    expect(calls[4].args).toEqual(['clean', '-fdx']);
    expect(calls.some((c) => c.args[0] === 'clone')).toBe(false);
  });

  it('treats "nothing to commit" as delivered: no commit and no push', async () => {
    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.args;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') return ''; // exit 0: nothing staged
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await expect(target.deliver(report())).resolves.toBeUndefined();

    expect(calls.some((c) => c.args[0] === '-c')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('removes and re-clones when an existing copy has a mismatched remote', async () => {
    await mkdir(join(dir, 'stale-marker'), { recursive: true });

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.args;
      if (cmd === 'remote') return 'https://example.invalid/other/repo.git';
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === '-c') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.deliver(report());

    expect(calls.some((c) => c.args[0] === 'fetch')).toBe(false);
    expect(calls[1].args[0]).toBe('clone');
  });

  it('removes and re-clones when refreshing an existing copy fails (dirty/corrupt)', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'leftover.txt'), 'stale');

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.args;
      if (cmd === 'remote') return REPO_URL;
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'fetch') throw errorWith('other');
      if (cmd === 'clone') return '';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === '-c') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.deliver(report());

    const cloneIndex = calls.findIndex((c) => c.args[0] === 'clone');
    expect(cloneIndex).toBeGreaterThan(-1);
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false);
    await expect(readFile(join(dir, 'leftover.txt'), 'utf-8')).rejects.toThrow();
  });

  it('on a rejected push: fetches, rebases onto origin/<branch>, and retries', async () => {
    let pushCalls = 0;

    const { run, calls } = createFakeRunner((call) => {
      const [cmd] = call.args;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === '-c') return '';
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
    expect(calls.some((c) => c.args[0] === 'fetch')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'rebase' && c.args[1] === 'origin/main')).toBe(true);
  });

  it('throws SyncGitError(rejected) after exactly MAX_PUSH_ATTEMPTS push calls', async () => {
    let pushCalls = 0;

    const { run } = createFakeRunner((call) => {
      const [cmd] = call.args;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === '-c') return '';
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
      const [cmd] = call.args;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === '-c') return '';
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
      const [cmd] = call.args;
      if (cmd === 'remote') throw new Error('not a repo');
      if (cmd === 'clone') return '';
      if (cmd === 'symbolic-ref') return 'main';
      if (cmd === 'add') return '';
      if (cmd === 'diff') throw errorWith('other');
      if (cmd === '-c') return '';
      if (cmd === 'push') return '';
      throw new Error(`unexpected git call: ${call.args.join(' ')}`);
    });

    const target = new GitTarget(gitSettings, EMAIL, run, dir);
    await target.testPush();

    expect(calls.some((c) => c.args[0] === 'add' && c.args[2] === SLUG)).toBe(true);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);

    const written = await readFile(join(dir, SLUG, '.codemie-sync-check'), 'utf-8');
    expect(() => new Date(written).toISOString()).not.toThrow();
    expect(new Date(written).toISOString()).toBe(written);
  });
});
