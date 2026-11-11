/**
 * Tests for the guided wizard's git step group (plan EPMCDME-17123 task 4):
 * `askGitDetails`/`testGitCheck` in `../git-step.ts`.
 *
 * `GitTarget`, `createGitRunner` and `resolveSyncIdentity` are mocked — no real network call
 * and no real git subprocess ever runs. `mkdtemp` is mocked to hand back a fixed fake path
 * (no real temp directory is ever created), so `rm`'s `force: true` cleanup is a safe no-op
 * even though nothing exists on disk at that path; this keeps the suite from ever leaving a
 * stray directory behind, including on a thrown/failing test push.
 */

import { rm } from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncConfigError, SyncGitError, SyncIdentityMissingError } from '@/utils/errors.js';

import type { BootstrapDeps, BootstrapPrompter } from '../types.js';
import type { GitSettings } from '../../types.js';

const FAKE_TMP_DIR = '/tmp/codemie-sync-bootstrap-fake';

// `mkdtemp` and `rm` are both mocked: no real temp directory is ever created, so there is
// nothing to leave behind even if a test fails before reaching its own assertions.
const mkdtempMock = vi.hoisted(() => vi.fn());
const rmMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, mkdtemp: mkdtempMock, rm: rmMock };
});

const testPushMock = vi.hoisted(() => vi.fn());
const gitTargetCtorMock = vi.hoisted(() => vi.fn());
vi.mock('../../targets/git-target.js', () => ({
  GitTarget: class {
    constructor(...args: unknown[]) {
      gitTargetCtorMock(...args);
    }
    testPush = testPushMock;
  }
}));

const createGitRunnerMock = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock('../../targets/git-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../targets/git-client.js')>('../../targets/git-client.js');
  return { ...actual, createGitRunner: createGitRunnerMock };
});

const resolveSyncIdentityMock = vi.hoisted(() => vi.fn());
vi.mock('../../identity.js', async () => {
  const actual = await vi.importActual<typeof import('../../identity.js')>('../../identity.js');
  return { ...actual, resolveSyncIdentity: resolveSyncIdentityMock };
});

import { askGitDetails, testGitCheck } from '../git-step.js';

const GIT: GitSettings = { repoUrl: 'git@example.com:team/repo.git' };

function createScriptedPrompt(script: { input?: string[]; select?: string[] }): BootstrapPrompter {
  const input = [...(script.input ?? [])];
  const select = [...(script.select ?? [])];
  return {
    input: vi.fn(async (message: string) => {
      if (input.length === 0) throw new Error(`scripted prompter ran out of input answers at: ${message}`);
      return input.shift() as string;
    }),
    confirm: vi.fn(async () => {
      throw new Error('confirm not expected in these tests');
    }),
    select: vi.fn(async (message: string) => {
      if (select.length === 0) throw new Error(`scripted prompter ran out of select answers at: ${message}`);
      return select.shift() as string;
    })
  };
}

function createDeps(prompt: BootstrapPrompter, overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    isTTY: true,
    cwd: '/tmp',
    now: () => new Date('2026-11-11T00:00:00.000Z'),
    cliVersion: async () => '0.1.0',
    out: vi.fn(),
    err: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    openUrl: vi.fn().mockResolvedValue(undefined),
    prompt,
    statePath: '/tmp/state.json',
    ...overrides
  };
}

function errLines(deps: BootstrapDeps): string[] {
  return (deps.err as ReturnType<typeof vi.fn>).mock.calls.map(([line]: [string]) => line);
}

describe('askGitDetails', () => {
  it('rejects a credential-bearing repo URL without echoing it and re-asks', async () => {
    const deps = createDeps(
      createScriptedPrompt({
        input: ['https://secrettoken123@github.com/team/repo.git', 'git@github.com:team/repo.git', '', '']
      })
    );

    const result = await askGitDetails(deps);

    expect(result).toEqual({ repoUrl: 'git@github.com:team/repo.git' });
    const lines = errLines(deps);
    expect(lines.some((l) => l.includes('secrettoken123'))).toBe(false);
    expect(lines.some((l) => l.includes('must not embed credentials'))).toBe(true);
  });

  it('rejects an invalid branch and re-asks, leaving branch/path undefined on blank input', async () => {
    const deps = createDeps(
      createScriptedPrompt({
        input: ['git@github.com:team/repo.git', '-bad-branch', '', '']
      })
    );

    const result = await askGitDetails(deps);

    expect(result).toEqual({ repoUrl: 'git@github.com:team/repo.git' });
    expect(errLines(deps).some((l) => l.includes('not a valid branch name'))).toBe(true);
  });

  it('keeps a valid branch and path when given', async () => {
    const deps = createDeps(
      createScriptedPrompt({
        input: ['git@github.com:team/repo.git', 'main', 'reports/analytics']
      })
    );

    const result = await askGitDetails(deps);

    expect(result).toEqual({
      repoUrl: 'git@github.com:team/repo.git',
      branch: 'main',
      path: 'reports/analytics'
    });
  });

  it('passes saved values through as each prompt\'s default', async () => {
    // The scripted prompter returns exactly what is queued regardless of `def` (it does not
    // simulate inquirer's "blank input accepts the shown default" behavior) — this test
    // instead confirms `askGitDetails` forwards each saved value as the `def` argument.
    const deps = createDeps(
      createScriptedPrompt({ input: ['git@github.com:team/repo.git', 'main', 'p'] })
    );

    const result = await askGitDetails(deps, { repoUrl: 'git@github.com:team/repo.git', branch: 'main', path: 'p' });

    expect(result).toEqual({ repoUrl: 'git@github.com:team/repo.git', branch: 'main', path: 'p' });
    expect(deps.prompt.input).toHaveBeenNthCalledWith(1, expect.any(String), 'git@github.com:team/repo.git');
    expect(deps.prompt.input).toHaveBeenNthCalledWith(2, expect.any(String), 'main');
    expect(deps.prompt.input).toHaveBeenNthCalledWith(3, expect.any(String), 'p');
  });
});

describe('testGitCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdtempMock.mockResolvedValue(FAKE_TMP_DIR);
    rmMock.mockResolvedValue(undefined);
  });

  it('creates a temp dir distinct from the shared working copy and removes it on success', async () => {
    testPushMock.mockResolvedValue(undefined);
    const deps = createDeps(createScriptedPrompt({}));

    const outcome = await testGitCheck(deps, GIT, 'dev@example.com');

    expect(outcome).toBe('passed');
    expect(mkdtempMock).toHaveBeenCalledTimes(1);
    const [tmpPrefix] = mkdtempMock.mock.calls[0] as [string];
    expect(tmpPrefix).not.toContain('analytics-sync-repo');
    expect(gitTargetCtorMock).toHaveBeenCalledWith(GIT, 'dev@example.com', expect.anything(), FAKE_TMP_DIR);
    expect(rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });

  it('creates and removes the temp dir on failure too (skip outcome)', async () => {
    testPushMock.mockRejectedValue(new SyncGitError('boom', 'auth'));
    const deps = createDeps(createScriptedPrompt({ select: ['skip'] }));

    const outcome = await testGitCheck(deps, GIT, 'dev@example.com');

    expect(outcome).toBe('skipped');
    expect(mkdtempMock).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
    expect(errLines(deps).some((l) => l.includes('authentication'))).toBe(true);
  });

  it('retries internally on "Try again" without creating a second temp dir', async () => {
    testPushMock.mockRejectedValueOnce(new SyncGitError('boom', 'other')).mockResolvedValueOnce(undefined);
    const deps = createDeps(createScriptedPrompt({ select: ['retry'] }));

    const outcome = await testGitCheck(deps, GIT, 'dev@example.com');

    expect(outcome).toBe('passed');
    expect(mkdtempMock).toHaveBeenCalledTimes(1);
    expect(testPushMock).toHaveBeenCalledTimes(2);
  });

  it('returns "retry" (ask for different details) on that choice', async () => {
    testPushMock.mockRejectedValue(new SyncGitError('boom', 'protected'));
    const deps = createDeps(createScriptedPrompt({ select: ['details'] }));

    const outcome = await testGitCheck(deps, GIT, 'dev@example.com');

    expect(outcome).toBe('retry');
    expect(rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });

  it('removes the temp dir even when testPush throws a non-SyncGitError', async () => {
    testPushMock.mockRejectedValue(new Error('unexpected'));
    const deps = createDeps(createScriptedPrompt({ select: ['skip'] }));

    await testGitCheck(deps, GIT, 'dev@example.com');

    expect(rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });

  it('uses the given email without resolving identity when one is passed', async () => {
    testPushMock.mockResolvedValue(undefined);
    const deps = createDeps(createScriptedPrompt({}));

    await testGitCheck(deps, GIT, 'explicit@example.com');

    expect(resolveSyncIdentityMock).not.toHaveBeenCalled();
    expect(gitTargetCtorMock).toHaveBeenCalledWith(GIT, 'explicit@example.com', expect.anything(), FAKE_TMP_DIR);
  });

  it('resolves identity when no email is given, and uses it', async () => {
    resolveSyncIdentityMock.mockResolvedValue('resolved@example.com');
    testPushMock.mockResolvedValue(undefined);
    const deps = createDeps(createScriptedPrompt({}));

    await testGitCheck(deps, GIT, undefined);

    expect(resolveSyncIdentityMock).toHaveBeenCalledTimes(1);
    expect(gitTargetCtorMock).toHaveBeenCalledWith(GIT, 'resolved@example.com', expect.anything(), FAKE_TMP_DIR);
  });

  it('in guided (TTY) mode, prompts (unsaved) for an email on SyncIdentityMissingError', async () => {
    resolveSyncIdentityMock.mockRejectedValue(new SyncIdentityMissingError());
    testPushMock.mockResolvedValue(undefined);
    const deps = createDeps(createScriptedPrompt({ input: ['not-an-email', 'prompted@example.com'] }), {
      isTTY: true
    });

    const outcome = await testGitCheck(deps, GIT, undefined);

    expect(outcome).toBe('passed');
    expect(gitTargetCtorMock).toHaveBeenCalledWith(GIT, 'prompted@example.com', expect.anything(), FAKE_TMP_DIR);
    // The invalid attempt is retried, never echoed back as an accepted value.
    expect(errLines(deps).some((l) => l.includes('not-an-email'))).toBe(false);
  });

  it('propagates SyncIdentityMissingError unchanged when not a TTY (no fallback prompt)', async () => {
    resolveSyncIdentityMock.mockRejectedValue(new SyncIdentityMissingError());
    const deps = createDeps(createScriptedPrompt({}), { isTTY: false });

    await expect(testGitCheck(deps, GIT, undefined)).rejects.toBeInstanceOf(SyncIdentityMissingError);
    expect(deps.prompt.input).not.toHaveBeenCalled();
    // Email resolution fails before any temp dir is created, so none needs removing.
    expect(mkdtempMock).not.toHaveBeenCalled();
  });

  it('propagates a non-identity error from resolveSyncIdentity unchanged', async () => {
    const err = new SyncConfigError('unexpected');
    resolveSyncIdentityMock.mockRejectedValue(err);
    const deps = createDeps(createScriptedPrompt({}), { isTTY: true });

    await expect(testGitCheck(deps, GIT, undefined)).rejects.toBe(err);
  });
});
