import { describe, expect, it, vi } from 'vitest';

import { SyncGitError, SyncIdentityMissingError, SyncSchedulerUnsupportedError } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';

import { runInstall } from '../install.js';
import type { InstallDeps } from '../install.js';
import type { RegisterResult, Scheduler } from '../scheduler/index.js';
import { gitHint } from '../targets/git-client.js';
import type { InstallOptions } from '../types.js';

const FAKE_WEBHOOK = 'https://hooks.example.invalid/abc?sig=SUPERSECRET123';
const FAKE_GIT_REPO = 'https://example.invalid/team/repo.git';

function makeScheduler(overrides: Partial<Scheduler> = {}): Scheduler {
  return {
    preflight: vi.fn(async () => {}),
    register: vi.fn(async (): Promise<RegisterResult> => ({})),
    unregister: vi.fn(async () => false),
    query: vi.fn(async () => 'disabled' as const),
    ...overrides,
  };
}

interface Harness {
  deps: InstallDeps;
  printed: string[];
  scheduler: Scheduler;
  writeSettings: ReturnType<typeof vi.fn>;
  deleteSettings: ReturnType<typeof vi.fn>;
  restoreSettingsRaw: ReturnType<typeof vi.fn>;
  saveUserEmail: ReturnType<typeof vi.fn>;
  promptEmail: ReturnType<typeof vi.fn>;
  testGitPush: ReturnType<typeof vi.fn>;
  removeWorkingCopy: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<InstallDeps> & { scheduler?: Scheduler } = {}): Harness {
  const printed: string[] = [];
  const scheduler = overrides.scheduler ?? makeScheduler();
  const writeSettings = vi.fn(async () => {});
  const deleteSettings = vi.fn(async () => true);
  const restoreSettingsRaw = vi.fn(async () => {});
  const saveUserEmail = vi.fn(async () => {});
  const promptEmail = vi.fn(async () => 'dev@example.com');
  const testGitPush = vi.fn(async () => {});
  const removeWorkingCopy = vi.fn(async () => {});

  const deps: InstallDeps = {
    scheduler,
    writeSettings,
    deleteSettings,
    readSettingsRaw: async () => null,
    restoreSettingsRaw,
    resolveIdentity: async () => 'dev@example.com',
    isTTY: false,
    promptEmail,
    saveUserEmail,
    collectorDirExists: () => false,
    resolveJobCommand: async () => ({
      node: '/usr/bin/node',
      entry: '/home/dev/.codemie/bin/codemie.js',
      args: ['analytics', 'sync', 'run', '--scheduled'],
    }),
    testGitPush,
    removeWorkingCopy,
    print: (line: string): void => {
      printed.push(line);
    },
    ...overrides,
  };

  return { deps, printed, scheduler, writeSettings, deleteSettings, restoreSettingsRaw, saveUserEmail, promptEmail, testGitPush, removeWorkingCopy };
}

const VALID_OPTS: InstallOptions = { webhook: FAKE_WEBHOOK };
const VALID_GIT_OPTS: InstallOptions = { gitRepo: FAKE_GIT_REPO };

describe('runInstall', () => {
  it('fails before any scheduler call on a bad option', async () => {
    const { deps, scheduler, writeSettings } = makeDeps();

    const code = await runInstall({}, deps);

    expect(code).toBe(1);
    expect(scheduler.preflight).not.toHaveBeenCalled();
    expect(scheduler.register).not.toHaveBeenCalled();
    expect(writeSettings).not.toHaveBeenCalled();
  });

  it('writes nothing when the platform is unsupported', async () => {
    const scheduler = makeScheduler({
      preflight: vi.fn(async () => {
        throw new SyncSchedulerUnsupportedError('codemie analytics sync install is not supported on platform "freebsd".');
      }),
    });
    const { deps, writeSettings, deleteSettings } = makeDeps({ scheduler });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(1);
    expect(scheduler.register).not.toHaveBeenCalled();
    expect(writeSettings).not.toHaveBeenCalled();
    expect(deleteSettings).not.toHaveBeenCalled();
  });

  it('fails with instructions and registers nothing when no email and no TTY', async () => {
    const { deps, scheduler, writeSettings, promptEmail, printed } = makeDeps({
      resolveIdentity: async () => {
        throw new SyncIdentityMissingError();
      },
      isTTY: false,
    });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(1);
    expect(promptEmail).not.toHaveBeenCalled();
    expect(scheduler.register).not.toHaveBeenCalled();
    expect(writeSettings).not.toHaveBeenCalled();
    expect(printed.join('\n')).toMatch(/email/i);
  });

  it('prompts for email, validates and saves it, then registers when TTY and no email configured', async () => {
    const { deps, scheduler, writeSettings, promptEmail, saveUserEmail } = makeDeps({
      resolveIdentity: async () => {
        throw new SyncIdentityMissingError();
      },
      isTTY: true,
    });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(0);
    expect(promptEmail).toHaveBeenCalledTimes(1);
    expect(saveUserEmail).toHaveBeenCalledWith('dev@example.com');
    expect(scheduler.register).toHaveBeenCalledTimes(1);
    expect(writeSettings).toHaveBeenCalledTimes(1);
  });

  it('deletes the just-written settings and exits 1 when register throws', async () => {
    const scheduler = makeScheduler({
      register: vi.fn(async () => {
        throw new Error('launchctl bootstrap failed: boom');
      }),
    });
    const { deps, writeSettings, deleteSettings } = makeDeps({ scheduler });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(1);
    expect(writeSettings).toHaveBeenCalledTimes(1);
    expect(deleteSettings).toHaveBeenCalledTimes(1);
  });

  it('restores the previous settings and re-registers the previous job when register throws', async () => {
    const previousRaw = JSON.stringify({ webhookUrl: 'https://old.example.invalid/x?sig=OLD', at: '05:30' });
    const register = vi
      .fn<Scheduler['register']>()
      .mockRejectedValueOnce(new Error('schtasks /Create failed: access denied'))
      .mockResolvedValueOnce({});
    const scheduler = makeScheduler({ register, query: vi.fn(async () => 'enabled' as const) });
    const { deps, deleteSettings, restoreSettingsRaw, printed } = makeDeps({
      scheduler,
      readSettingsRaw: async () => previousRaw,
    });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(1);
    expect(restoreSettingsRaw).toHaveBeenCalledWith(previousRaw);
    expect(deleteSettings).not.toHaveBeenCalled();
    expect(register).toHaveBeenLastCalledWith(expect.anything(), '05:30');
    const output = printed.join('\n');
    expect(output).toContain('Install failed: schtasks /Create failed: access denied');
    expect(output).toContain('previous settings and daily job (05:30 local) were restored');
  });

  it('says delivery is stopped when the previous job cannot be registered again', async () => {
    const scheduler = makeScheduler({
      register: vi.fn(async () => {
        throw new Error('systemctl --user enable --now failed: boom');
      }),
      query: vi.fn(async () => 'enabled' as const),
    });
    const { deps, restoreSettingsRaw, printed } = makeDeps({
      scheduler,
      readSettingsRaw: async () => JSON.stringify({ webhookUrl: 'https://old.example.invalid/x' }),
    });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(1);
    expect(restoreSettingsRaw).toHaveBeenCalledTimes(1);
    expect(printed.join('\n')).toContain('Daily delivery is stopped on this machine until install succeeds.');
  });

  it('restores the previous settings and also the job when writing the new settings fails', async () => {
    const scheduler = makeScheduler({ query: vi.fn(async () => 'enabled' as const) });
    const previousRaw = JSON.stringify({ webhookUrl: 'https://old.example.invalid/x' });
    const { deps, restoreSettingsRaw } = makeDeps({
      scheduler,
      readSettingsRaw: async () => previousRaw,
      writeSettings: vi.fn(async () => {
        throw new Error('EACCES: permission denied');
      }),
    });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(1);
    expect(restoreSettingsRaw).toHaveBeenCalledWith(previousRaw);
    expect(scheduler.register).toHaveBeenCalledWith(expect.anything(), '03:00');
  });

  it('removes the half-registered job files when register throws', async () => {
    const scheduler = makeScheduler({
      register: vi.fn(async () => {
        throw new Error('systemctl --user enable --now failed: boom');
      }),
    });
    const { deps } = makeDeps({ scheduler });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(1);
    // Once before register (replace any old job), once in the rollback.
    expect(scheduler.unregister).toHaveBeenCalledTimes(2);
  });

  it('reports the register error even when the rollback itself fails', async () => {
    const scheduler = makeScheduler({
      register: vi.fn(async () => {
        throw new Error('launchctl bootstrap failed: boom');
      }),
    });
    const { deps, printed } = makeDeps({
      scheduler,
      deleteSettings: vi.fn(async () => {
        throw new Error('EACCES: settings');
      }),
    });

    await expect(runInstall(VALID_OPTS, deps)).resolves.toBe(1);
    expect(printed.join('\n')).toContain('launchctl bootstrap failed: boom');
  });

  it('fails with a redacted message and registers nothing when writing settings fails', async () => {
    const { deps, scheduler, printed } = makeDeps({
      writeSettings: vi.fn(async () => {
        throw new Error('ENOSPC writing settings for https://hooks.example.invalid/abc?sig=SUPERSECRET123');
      }),
    });

    await expect(runInstall(VALID_OPTS, deps)).resolves.toBe(1);
    expect(scheduler.register).not.toHaveBeenCalled();
    const output = printed.join('\n');
    expect(output).toMatch(/Install failed/);
    expect(output).not.toContain('SUPERSECRET123');
  });

  it('fails without writing settings when removing the previous job throws', async () => {
    const scheduler = makeScheduler({
      unregister: vi.fn(async () => {
        throw new Error('EACCES: LaunchAgents');
      }),
    });
    const { deps, writeSettings, printed } = makeDeps({ scheduler });

    await expect(runInstall(VALID_OPTS, deps)).resolves.toBe(1);
    expect(writeSettings).not.toHaveBeenCalled();
    expect(printed.join('\n')).toMatch(/Install failed: EACCES: LaunchAgents/);
  });

  it('says the standalone collector job was taken over and its folder can be deleted, without touching the marker', async () => {
    const { deps, printed } = makeDeps({ collectorDirExists: () => true });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).toMatch(/taken over/i);
    expect(output).toMatch(/can be deleted/i);
    expect(output).toContain(getCodemiePath('codemie-onboarding'));
  });

  it('prints a summary with defaults, the webhook host only, email, and the run/status hints, and masks the signature', async () => {
    const { deps, printed } = makeDeps();

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).toContain('03:00');
    expect(output).toContain('7 days (default)');
    expect(output).toContain('never');
    expect(output).toContain('hooks.example.invalid');
    expect(output).toContain('dev@example.com');
    expect(output).toContain('sync run');
    expect(output).toContain('sync status');
    expect(output).not.toContain('sig=');
    expect(output).not.toContain('SUPERSECRET123');
  });

  it('prints the explicit lookback (not "default") when --lookback-days is given', async () => {
    const { deps, printed } = makeDeps();

    const code = await runInstall({ webhook: FAKE_WEBHOOK, lookbackDays: '14' }, deps);

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).toContain('14 days');
    expect(output).not.toContain('14 days (default)');
  });

  it('prints the linger warning when register reports one', async () => {
    const scheduler = makeScheduler({
      register: vi.fn(async (): Promise<RegisterResult> => ({ lingerWarning: 'loginctl enable-linger failed: boom' })),
    });
    const { deps, printed } = makeDeps({ scheduler });

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(0);
    expect(printed.join('\n')).toMatch(/loginctl enable-linger failed/);
  });
});

describe('runInstall — git target test push', () => {
  it('test-pushes the git target with the resolved email before touching the scheduler, then registers', async () => {
    const { deps, scheduler, testGitPush, writeSettings } = makeDeps();

    const code = await runInstall(VALID_GIT_OPTS, deps);

    expect(code).toBe(0);
    expect(testGitPush).toHaveBeenCalledTimes(1);
    expect(testGitPush).toHaveBeenCalledWith({ repoUrl: FAKE_GIT_REPO }, 'dev@example.com');
    expect(scheduler.unregister).toHaveBeenCalled();
    expect(writeSettings).toHaveBeenCalledTimes(1);
    expect(scheduler.register).toHaveBeenCalledTimes(1);
  });

  it('fails with the auth hint, removes the working copy, and registers nothing when the test push rejects with an auth SyncGitError', async () => {
    const testGitPush = vi.fn(async () => {
      throw new SyncGitError('Authentication failed for repo', 'auth');
    });
    const { deps, scheduler, writeSettings, removeWorkingCopy, printed } = makeDeps({ testGitPush });

    const code = await runInstall(VALID_GIT_OPTS, deps);

    expect(code).toBe(1);
    const output = printed.join('\n');
    expect(output).toContain(gitHint('auth'));
    expect(scheduler.unregister).not.toHaveBeenCalled();
    expect(writeSettings).not.toHaveBeenCalled();
    expect(scheduler.register).not.toHaveBeenCalled();
    expect(removeWorkingCopy).toHaveBeenCalledTimes(1);
    expect(testGitPush).toHaveBeenCalledTimes(1);
  });

  it('never calls testGitPush or removeWorkingCopy for a webhook-only install', async () => {
    const { deps, testGitPush, removeWorkingCopy } = makeDeps();

    const code = await runInstall(VALID_OPTS, deps);

    expect(code).toBe(0);
    expect(testGitPush).not.toHaveBeenCalled();
    expect(removeWorkingCopy).not.toHaveBeenCalled();
  });

  it('prints the redacted repository, branch and path in the summary on a successful git install', async () => {
    const { deps, printed } = makeDeps();

    const code = await runInstall({ gitRepo: FAKE_GIT_REPO, gitBranch: 'reports', gitPath: 'analytics' }, deps);

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).toContain('Repository:');
    expect(output).toContain(FAKE_GIT_REPO);
    expect(output).toContain('reports');
    expect(output).toContain('analytics');
  });
});
