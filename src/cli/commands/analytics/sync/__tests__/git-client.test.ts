import { describe, expect, it, vi } from 'vitest';

import { SyncGitError, type GitFailureCause } from '@/utils/errors.js';
import type { ExecResult } from '@/utils/exec.js';
import {
  classifyGitError,
  createGitRunner,
  gitEnv,
  gitHint,
  LOCAL_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
} from '../targets/git-client.js';

function ok(stdout = ''): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(stderr: string, code = 1): ExecResult {
  return { code, stdout: '', stderr };
}

describe('gitEnv', () => {
  it('sets the prompt-free defaults with a plain ssh wrapper when nothing is configured', () => {
    const env = gitEnv({});

    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GCM_INTERACTIVE).toBe('never');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
  });

  it('keeps an existing GIT_SSH_COMMAND and appends BatchMode', () => {
    const env = gitEnv({ GIT_SSH_COMMAND: 'ssh -i k' });

    expect(env.GIT_SSH_COMMAND).toBe('ssh -i k -o BatchMode=yes');
  });

  it('does not duplicate BatchMode when already present', () => {
    const env = gitEnv({ GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -i k' });

    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes -i k');
  });

  it('uses a configured core.sshCommand as the base when the env var is unset', () => {
    const env = gitEnv({}, 'ssh -i configured');

    expect(env.GIT_SSH_COMMAND).toBe('ssh -i configured -o BatchMode=yes');
  });
});

describe('classifyGitError', () => {
  it.each([
    ['Authentication failed for \'https://example.invalid/repo.git\'', 'auth'],
    ['Host key verification failed.', 'host-key'],
    ['fatal: Could not resolve host: example.invalid', 'unreachable'],
    [' ! [rejected]        main -> main (fetch first)', 'rejected'],
    ['remote: error: GH006: Protected branch update failed', 'protected'],
  ] as const)('classifies %s as %s', (stderr, cause) => {
    expect(classifyGitError(stderr)).toBe(cause);
  });

  it('classifies a protected-branch rejection as protected, not rejected', () => {
    const stderr =
      ' ! [remote rejected] main -> main (protected branch hook declined)';
    expect(classifyGitError(stderr)).toBe('protected');
  });

  it('classifies an unrecognized stderr as other', () => {
    expect(classifyGitError('something unexpected happened')).toBe('other');
  });
});

describe('gitHint', () => {
  const causes: GitFailureCause[] = [
    'auth',
    'host-key',
    'unreachable',
    'rejected',
    'protected',
    'timeout',
    'other',
  ];

  it.each(causes)('returns a non-empty hint for %s', (cause) => {
    expect(gitHint(cause).length).toBeGreaterThan(0);
  });

  it('tells the user to trust the host once for host-key', () => {
    expect(gitHint('host-key')).toMatch(/ssh -T/);
  });
});

describe('createGitRunner', () => {
  it('runs a local (non-network) call with the local timeout', async () => {
    const fakeExec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'config') return fail('', 1);
      return ok('abc');
    });
    const runner = createGitRunner(fakeExec as never);

    await runner(['rev-parse', 'HEAD'], {});

    const call = fakeExec.mock.calls.find(([, args]) => args[0] === 'rev-parse');
    expect(call?.[2]?.timeout).toBe(LOCAL_TIMEOUT_MS);
  });

  it('runs a network call with the network timeout', async () => {
    const fakeExec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'config') return fail('', 1);
      return ok('');
    });
    const runner = createGitRunner(fakeExec as never);

    await runner(['fetch', 'origin'], { network: true });

    const call = fakeExec.mock.calls.find(([, args]) => args[0] === 'fetch');
    expect(call?.[2]?.timeout).toBe(NETWORK_TIMEOUT_MS);
  });

  it('reads core.sshCommand via git config when GIT_SSH_COMMAND is unset', async () => {
    const fakeExec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'config') return ok('ssh -i configured');
      return ok('');
    });
    const runner = createGitRunner(fakeExec as never);

    await runner(['fetch', 'origin'], { network: true });

    const call = fakeExec.mock.calls.find(([, args]) => args[0] === 'fetch');
    expect(call?.[2]?.env?.GIT_SSH_COMMAND).toBe('ssh -i configured -o BatchMode=yes');
  });

  it('resolves trimmed stdout on exit code 0', async () => {
    const fakeExec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'config') return fail('', 1);
      return ok('  hello  ');
    });
    const runner = createGitRunner(fakeExec as never);

    await expect(runner(['status'], {})).resolves.toBe('hello');
  });

  it('throws SyncGitError with the classified cause on a non-zero exit', async () => {
    const fakeExec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'config') return fail('', 1);
      return fail("Authentication failed for 'https://example.invalid/repo.git'");
    });
    const runner = createGitRunner(fakeExec as never);

    await expect(runner(['fetch'], { network: true })).rejects.toSatisfy(
      (err: unknown) => err instanceof SyncGitError && err.gitCause === 'auth'
    );
  });

  it('redacts secrets from the thrown error message', async () => {
    const fakeExec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'config') return fail('', 1);
      return fail(
        'remote: https://u:supersecrettoken@example.invalid/repo.git Authentication failed'
      );
    });
    const runner = createGitRunner(fakeExec as never);

    await expect(runner(['fetch'], { network: true })).rejects.toSatisfy((err: unknown) => {
      return err instanceof SyncGitError && !err.message.includes('supersecrettoken');
    });
  });

  it('maps an exec timeout rejection to the timeout cause', async () => {
    const fakeExec = vi.fn(async (_cmd: string, args: string[], options?: { timeout?: number }) => {
      if (args[0] === 'config') return fail('', 1);
      throw new Error(`Command timed out after ${options?.timeout}ms`);
    });
    const runner = createGitRunner(fakeExec as never);

    await expect(runner(['fetch'], { network: true })).rejects.toSatisfy(
      (err: unknown) => err instanceof SyncGitError && err.gitCause === 'timeout'
    );
  });
});
