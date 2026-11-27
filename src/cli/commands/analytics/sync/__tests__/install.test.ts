import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncGitError, SyncIdentityMissingError, SyncSchedulerUnsupportedError } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';

import { runInstall } from '../install.js';
import type { InstallDeps } from '../install.js';
import { defaultSchedulerName } from '../scheduler/index.js';
import type { RegisterResult, Scheduler } from '../scheduler/index.js';
import { gitHint } from '../targets/git-client.js';
import type { InstallOptions } from '../types.js';
import type { InstallPlan, InstallStep } from '../../../shared/analytics-collection/types.js';

const FAKE_WEBHOOK = 'https://hooks.example.invalid/abc?sig=SUPERSECRET123';
const FAKE_GIT_REPO = 'https://example.invalid/team/repo.git';

function makeScheduler(overrides: Partial<Scheduler> = {}): Scheduler {
  return {
    preflight: vi.fn(async () => {}),
    register: vi.fn(async (): Promise<RegisterResult> => ({})),
    unregister: vi.fn(async () => false),
    query: vi.fn(async () => 'disabled' as const),
    exists: vi.fn(async () => 'absent' as const),
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
    schedulerFor: () => scheduler,
    writeSettings,
    deleteSettings,
    readSettingsRaw: async () => null,
    restoreSettingsRaw,
    resolveIdentity: async () => 'dev@example.com',
    isTTY: false,
    promptEmail,
    promptTaskName: async () => '',
    confirmOverwrite: async () => false,
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
    plan: { steps: () => [], settingsExtras: () => ({}), conclude: () => ({ summary: [] }) },
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
    expect(output).toContain(`previous settings and daily job (${defaultSchedulerName(process.platform)} at 05:30 local) were restored`);
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
    expect(printed.join('\n')).toContain('Daily delivery may be stopped on this machine until install succeeds.');
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

/** Name-aware scheduler stub: one scheduler per job name, created on first use. */
function makeNamedSchedulers(configure: Record<string, Partial<Scheduler>> = {}): {
  schedulerFor: (name: string) => Scheduler;
  byName: Map<string, Scheduler>;
} {
  const byName = new Map<string, Scheduler>();
  const schedulerFor = (name: string): Scheduler => {
    let scheduler = byName.get(name);
    if (scheduler === undefined) {
      scheduler = makeScheduler(configure[name]);
      byName.set(name, scheduler);
    }
    return scheduler;
  };
  return { schedulerFor, byName };
}

const CUSTOM_NAME = 'my-custom-task';
const OLD_CUSTOM_NAME = 'old-custom-task';
const DEFAULT_NAME = defaultSchedulerName(process.platform);

function expectNothingChanged(harness: Harness, byName: Map<string, Scheduler>): void {
  expect(harness.writeSettings).not.toHaveBeenCalled();
  expect(harness.deleteSettings).not.toHaveBeenCalled();
  expect(harness.restoreSettingsRaw).not.toHaveBeenCalled();
  for (const scheduler of byName.values()) {
    expect(scheduler.unregister).not.toHaveBeenCalled();
    expect(scheduler.register).not.toHaveBeenCalled();
  }
}

describe('runInstall — overwrite guard for --task-name', () => {
  it('refuses without --force, prints the warning and changes nothing when a foreign task exists', async () => {
    const { schedulerFor, byName } = makeNamedSchedulers({ [CUSTOM_NAME]: { exists: vi.fn(async () => 'present' as const) } });
    const harness = makeDeps({ schedulerFor });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME }, harness.deps);

    expect(code).toBe(1);
    const output = harness.printed.join('\n');
    expect(output).toContain(`The following task already exists and will be deleted and overwritten by this one: ${CUSTOM_NAME}`);
    expect(output).toContain('Re-run with --force');
    expectNothingChanged(harness, byName);
  });

  it('refuses without --force when the presence check is unknown', async () => {
    const { schedulerFor, byName } = makeNamedSchedulers({ [CUSTOM_NAME]: { exists: vi.fn(async () => 'unknown' as const) } });
    const harness = makeDeps({ schedulerFor });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME }, harness.deps);

    expect(code).toBe(1);
    expect(harness.printed.join('\n')).toContain(`Could not check whether a scheduler task named "${CUSTOM_NAME}" already exists`);
    expectNothingChanged(harness, byName);
  });

  it('treats a throwing presence check like unknown', async () => {
    const { schedulerFor, byName } = makeNamedSchedulers({
      [CUSTOM_NAME]: {
        exists: vi.fn(async () => {
          throw new Error('probe failed');
        })
      }
    });
    const harness = makeDeps({ schedulerFor });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME }, harness.deps);

    expect(code).toBe(1);
    expectNothingChanged(harness, byName);
  });

  it('goes ahead with --force, still printing the warning, and saves the custom name', async () => {
    const { schedulerFor, byName } = makeNamedSchedulers({ [CUSTOM_NAME]: { exists: vi.fn(async () => 'present' as const) } });
    const harness = makeDeps({ schedulerFor });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME, force: true }, harness.deps);

    expect(code).toBe(0);
    expect(harness.printed.join('\n')).toContain('will be deleted and overwritten');
    expect(harness.writeSettings).toHaveBeenCalledWith(expect.objectContaining({ taskName: CUSTOM_NAME }));
    expect(byName.get(CUSTOM_NAME)?.register).toHaveBeenCalledTimes(1);
  });

  it('proceeds silently when no task with that name exists', async () => {
    const { schedulerFor, byName } = makeNamedSchedulers();
    const harness = makeDeps({ schedulerFor });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME }, harness.deps);

    expect(code).toBe(0);
    expect(harness.printed.join('\n')).not.toContain('overwritten');
    expect(byName.get(CUSTOM_NAME)?.register).toHaveBeenCalledTimes(1);
  });

  it('does not ask when --task-name is given on a terminal: the flag needs --force', async () => {
    const confirmOverwrite = vi.fn(async () => true);
    const { schedulerFor, byName } = makeNamedSchedulers({ [CUSTOM_NAME]: { exists: vi.fn(async () => 'present' as const) } });
    const harness = makeDeps({ schedulerFor, isTTY: true, confirmOverwrite });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME }, harness.deps);

    expect(code).toBe(1);
    expect(confirmOverwrite).not.toHaveBeenCalled();
    expectNothingChanged(harness, byName);
  });

  it('overwrites a foreign task when a name typed at the prompt is confirmed', async () => {
    const confirmOverwrite = vi.fn(async () => true);
    const { schedulerFor, byName } = makeNamedSchedulers({ [CUSTOM_NAME]: { exists: vi.fn(async () => 'present' as const) } });
    const harness = makeDeps({ schedulerFor, isTTY: true, promptTaskName: async () => CUSTOM_NAME, confirmOverwrite });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(0);
    expect(confirmOverwrite).toHaveBeenCalledWith(CUSTOM_NAME);
    expect(byName.get(CUSTOM_NAME)?.register).toHaveBeenCalledTimes(1);
  });

  it('cancels and changes nothing when the prompted overwrite is declined', async () => {
    const confirmOverwrite = vi.fn(async () => false);
    const { schedulerFor, byName } = makeNamedSchedulers({ [CUSTOM_NAME]: { exists: vi.fn(async () => 'present' as const) } });
    const harness = makeDeps({ schedulerFor, isTTY: true, promptTaskName: async () => CUSTOM_NAME, confirmOverwrite });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(1);
    expect(confirmOverwrite).toHaveBeenCalledTimes(1);
    expect(harness.printed.join('\n')).toContain('Install cancelled');
    expectNothingChanged(harness, byName);
  });

  it('skips the presence check when the name equals the saved name', async () => {
    const exists = vi.fn(async () => 'present' as const);
    const { schedulerFor, byName } = makeNamedSchedulers({ [CUSTOM_NAME]: { exists } });
    const harness = makeDeps({
      schedulerFor,
      readSettingsRaw: async () => JSON.stringify({ webhookUrl: 'https://old.example.invalid/x', taskName: CUSTOM_NAME })
    });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME }, harness.deps);

    expect(code).toBe(0);
    expect(exists).not.toHaveBeenCalled();
    expect(harness.printed.join('\n')).not.toContain('overwritten');
    expect(byName.get(CUSTOM_NAME)?.register).toHaveBeenCalledTimes(1);
  });

  it('still checks presence when the saved name differs from the chosen one', async () => {
    const exists = vi.fn(async () => 'present' as const);
    const { schedulerFor, byName } = makeNamedSchedulers({ [CUSTOM_NAME]: { exists } });
    const harness = makeDeps({
      schedulerFor,
      readSettingsRaw: async () => JSON.stringify({ webhookUrl: 'https://old.example.invalid/x', taskName: OLD_CUSTOM_NAME })
    });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME }, harness.deps);

    expect(code).toBe(1);
    expect(exists).toHaveBeenCalledTimes(1);
    expectNothingChanged(harness, byName);
  });

  it('rejects an invalid --task-name before touching anything', async () => {
    const { schedulerFor, byName } = makeNamedSchedulers();
    const harness = makeDeps({ schedulerFor });

    const code = await runInstall({ ...VALID_OPTS, taskName: '../evil' }, harness.deps);

    expect(code).toBe(1);
    expect(harness.printed.join('\n')).toContain('Install failed');
    expectNothingChanged(harness, byName);
  });
});

describe('runInstall — default name is not saved', () => {
  it('does not store taskName or check presence when --task-name equals the platform default', async () => {
    const exists = vi.fn(async () => 'present' as const);
    const { schedulerFor, byName } = makeNamedSchedulers({ [DEFAULT_NAME]: { exists } });
    const harness = makeDeps({ schedulerFor });

    const code = await runInstall({ ...VALID_OPTS, taskName: DEFAULT_NAME }, harness.deps);

    expect(code).toBe(0);
    expect(exists).not.toHaveBeenCalled();
    const written = harness.writeSettings.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('taskName');
    expect(byName.get(DEFAULT_NAME)?.register).toHaveBeenCalledTimes(1);
  });

  it('keeps the default and stores no name when the prompt answer is empty', async () => {
    const promptTaskName = vi.fn(async () => '');
    const { schedulerFor } = makeNamedSchedulers();
    const harness = makeDeps({ schedulerFor, isTTY: true, promptTaskName });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(0);
    expect(promptTaskName).toHaveBeenCalledWith(DEFAULT_NAME);
    expect(harness.writeSettings.mock.calls[0]?.[0] as Record<string, unknown>).not.toHaveProperty('taskName');
  });

  it('never prompts when --task-name is given', async () => {
    const promptTaskName = vi.fn(async () => '');
    const { schedulerFor } = makeNamedSchedulers();
    const harness = makeDeps({ schedulerFor, isTTY: true, promptTaskName });

    await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME }, harness.deps);

    expect(promptTaskName).not.toHaveBeenCalled();
  });
});

describe('runInstall — replacing and restoring jobs under saved names', () => {
  const previousRaw = JSON.stringify({
    webhookUrl: 'https://old.example.invalid/x?sig=OLD',
    at: '05:30',
    taskName: OLD_CUSTOM_NAME
  });
  const enabled = { query: vi.fn(async () => 'enabled' as const) };

  it('unregisters both owned names before registering the new name', async () => {
    const calls: string[] = [];
    const track = (name: string): Partial<Scheduler> => ({
      query: vi.fn(async () => 'enabled' as const),
      unregister: vi.fn(async () => {
        calls.push(`unregister:${name}`);
        return true;
      }),
      register: vi.fn(async (): Promise<RegisterResult> => {
        calls.push(`register:${name}`);
        return {};
      })
    });
    const { schedulerFor } = makeNamedSchedulers({
      [OLD_CUSTOM_NAME]: track(OLD_CUSTOM_NAME),
      [DEFAULT_NAME]: track(DEFAULT_NAME),
      [CUSTOM_NAME]: track(CUSTOM_NAME)
    });
    const harness = makeDeps({ schedulerFor, readSettingsRaw: async () => previousRaw });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME, force: true }, harness.deps);

    expect(code).toBe(0);
    expect(calls).toEqual([`unregister:${OLD_CUSTOM_NAME}`, `unregister:${DEFAULT_NAME}`, `register:${CUSTOM_NAME}`]);
  });

  it('re-registers every previously enabled job under its own name and schedule when registration fails', async () => {
    const { schedulerFor, byName } = makeNamedSchedulers({
      [OLD_CUSTOM_NAME]: { ...enabled },
      [DEFAULT_NAME]: { ...enabled },
      [CUSTOM_NAME]: {
        register: vi.fn(async () => {
          throw new Error('launchctl bootstrap failed: boom');
        })
      }
    });
    const harness = makeDeps({ schedulerFor, readSettingsRaw: async () => previousRaw });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME, force: true }, harness.deps);

    expect(code).toBe(1);
    expect(byName.get(CUSTOM_NAME)?.unregister).toHaveBeenCalledTimes(1); // rollback of the new name
    expect(harness.restoreSettingsRaw).toHaveBeenCalledWith(previousRaw);
    expect(byName.get(OLD_CUSTOM_NAME)?.register).toHaveBeenCalledWith(expect.anything(), '05:30');
    expect(byName.get(DEFAULT_NAME)?.register).toHaveBeenCalledWith(expect.anything(), '05:30');
    const output = harness.printed.join('\n');
    expect(output).toContain(`${OLD_CUSTOM_NAME} at 05:30 local`);
    expect(output).toContain(`${DEFAULT_NAME} at 05:30 local`);
  });

  it('restores only the jobs that were enabled', async () => {
    const { schedulerFor, byName } = makeNamedSchedulers({
      [OLD_CUSTOM_NAME]: { ...enabled },
      [CUSTOM_NAME]: {
        register: vi.fn(async () => {
          throw new Error('boom');
        })
      }
    });
    const harness = makeDeps({ schedulerFor, readSettingsRaw: async () => previousRaw });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME, force: true }, harness.deps);

    expect(code).toBe(1);
    expect(byName.get(OLD_CUSTOM_NAME)?.register).toHaveBeenCalledTimes(1);
    expect(byName.get(DEFAULT_NAME)?.register).not.toHaveBeenCalled();
  });

  it('ignores an invalid saved name: only the default name is owned and touched', async () => {
    const { schedulerFor, byName } = makeNamedSchedulers();
    const harness = makeDeps({
      schedulerFor,
      readSettingsRaw: async () => JSON.stringify({ webhookUrl: 'https://old.example.invalid/x', taskName: '../../etc/evil' })
    });

    const code = await runInstall({ ...VALID_OPTS, taskName: CUSTOM_NAME }, harness.deps);

    expect(code).toBe(0);
    expect([...byName.keys()].sort()).toEqual([CUSTOM_NAME, DEFAULT_NAME].sort());
  });
});

describe('runInstall — install plan', () => {
  const previousRaw = JSON.stringify({ webhookUrl: 'https://old.example.invalid/x?sig=OLD', at: '04:30' });

  /** A step that records its apply and undo in `events`; `onApply` runs inside its apply. */
  function recordingStep(name: string, events: string[], onApply?: () => void, undoError?: Error): InstallStep {
    return {
      name,
      apply: async () => {
        events.push(`apply:${name}`);
        onApply?.();
        return { name, state: 'done' };
      },
      undo: async () => {
        events.push(`undo:${name}`);
        if (undoError) throw undoError;
      },
    };
  }

  function plan(steps: InstallStep[], conclude: InstallPlan['conclude'] = () => ({ summary: ['  Mode:             test'] })): InstallPlan {
    return {
      steps: () => steps,
      settingsExtras: (job) => ({ local: true, localJob: { node: job.node, entry: job.entry } }),
      conclude,
    };
  }

  it('runs the steps before the job is replaced, writes the plan\'s extras and prints its summary', async () => {
    const events: string[] = [];
    const scheduler = makeScheduler({
      register: vi.fn(async (): Promise<RegisterResult> => {
        events.push('register');
        return {};
      }),
    });
    const harness = makeDeps({ scheduler, plan: plan([recordingStep('a', events), recordingStep('b', events)]) });
    harness.writeSettings.mockImplementation(async () => {
      events.push('write');
    });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(0);
    expect(events).toEqual(['apply:a', 'apply:b', 'write', 'register']);
    expect(harness.writeSettings).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: FAKE_WEBHOOK,
      local: true,
      localJob: { node: '/usr/bin/node', entry: '/home/dev/.codemie/bin/codemie.js' },
    }));
    expect(harness.printed).toContain('  Mode:             test');
  });

  it('a failure the plan concludes undoes the applied steps in reverse, registers nothing and exits 1', async () => {
    const events: string[] = [];
    const harness = makeDeps({
      plan: plan([recordingStep('a', events), recordingStep('b', events)], () => ({ summary: [], failure: 'No supported client could be set up.' })),
    });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(1);
    expect(events).toEqual(['apply:a', 'apply:b', 'undo:b', 'undo:a']);
    expect(harness.scheduler.register).not.toHaveBeenCalled();
    expect(harness.writeSettings).not.toHaveBeenCalled();
    expect(harness.printed).toContain('No supported client could be set up.');
  });

  it('a plan that stands down undoes its steps in reverse, saves none of its extras, prints its summary and exits 0', async () => {
    const events: string[] = [];
    const scheduler = makeScheduler({
      register: vi.fn(async (): Promise<RegisterResult> => {
        events.push('register');
        return {};
      }),
    });
    const harness = makeDeps({
      scheduler,
      plan: plan([recordingStep('a', events), recordingStep('b', events)], () => ({ summary: ['  Local mode:       not turned on'], standDown: { undoFailed: 'the stub plan could not be undone' } })),
    });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(0);
    expect(events).toEqual(['apply:a', 'apply:b', 'undo:b', 'undo:a', 'register']);
    expect(harness.writeSettings).toHaveBeenCalledWith(expect.objectContaining({ webhookUrl: FAKE_WEBHOOK }));
    for (const [written] of harness.writeSettings.mock.calls) {
      expect(written).not.toHaveProperty('local');
      expect(written).not.toHaveProperty('localJob');
    }
    expect(harness.printed).toContain('  Local mode:       not turned on');
  });

  it('a plan that stands down with an undo that throws fails: both lines printed, nothing registered or written, exit 1', async () => {
    const events: string[] = [];
    const harness = makeDeps({
      plan: plan(
        [recordingStep('a', events), recordingStep('b', events, undefined, new Error('settings locked'))],
        () => ({ summary: ['  Local mode:       not turned on'], standDown: { undoFailed: 'the stub plan could not be undone' } })
      ),
    });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(1);
    expect(events).toEqual(['apply:a', 'apply:b', 'undo:b', 'undo:a']);
    expect(harness.printed).toContain('Could not undo "b": settings locked');
    expect(harness.printed).toContain('Install failed: the stub plan could not be undone');
    expect(harness.scheduler.register).not.toHaveBeenCalled();
    expect(harness.writeSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['settings there before: restored', previousRaw],
    ['no settings before: deleted', null],
  ])('a plan that stands down whose register throws fails and puts back the install of before (%s)', async (_name, before) => {
    const events: string[] = [];
    const register = vi.fn(async (): Promise<RegisterResult> => {
      throw new Error('launchctl bootstrap failed: boom');
    });
    const harness = makeDeps({
      scheduler: makeScheduler({ register }),
      readSettingsRaw: async () => before,
      plan: plan([recordingStep('a', events)], () => ({ summary: ['  Local mode:       not turned on'], standDown: { undoFailed: 'the stub plan could not be undone' } })),
    });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(1);
    expect(events).toEqual(['apply:a', 'undo:a']);
    expect(harness.printed).toContain('Install failed: launchctl bootstrap failed: boom');
    if (before === null) {
      expect(harness.deleteSettings).toHaveBeenCalled();
      expect(harness.restoreSettingsRaw).not.toHaveBeenCalled();
    } else {
      expect(harness.restoreSettingsRaw).toHaveBeenCalledWith(previousRaw);
    }
  });

  it('a register that throws undoes the steps in reverse and restores the settings and the job of before the run', async () => {
    const events: string[] = [];
    let stored = previousRaw;
    const register = vi.fn(async (): Promise<RegisterResult> => ({}))
      .mockRejectedValueOnce(new Error('launchctl bootstrap failed: boom'));
    const scheduler = makeScheduler({ register, query: vi.fn(async () => 'enabled' as const) });
    // The first step writes the settings of this install, as the local mode's does.
    const step = recordingStep('settings', events, () => {
      stored = JSON.stringify({ webhookUrl: FAKE_WEBHOOK, at: '03:00', local: true });
    });
    const harness = makeDeps({ scheduler, readSettingsRaw: async () => stored, plan: plan([step, recordingStep('daemon', events)]) });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(1);
    expect(events).toEqual(['apply:settings', 'apply:daemon', 'undo:daemon', 'undo:settings']);
    expect(harness.restoreSettingsRaw).toHaveBeenCalledWith(previousRaw);
    expect(register).toHaveBeenLastCalledWith(expect.anything(), '04:30');
  });

  it('an undo that throws is printed and the earlier steps are still undone', async () => {
    const events: string[] = [];
    const harness = makeDeps({
      plan: plan(
        [recordingStep('a', events), recordingStep('b', events, undefined, new Error('settings locked'))],
        () => ({ summary: [], failure: 'stop' })
      ),
    });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(code).toBe(1);
    expect(events).toEqual(['apply:a', 'apply:b', 'undo:b', 'undo:a']);
    expect(harness.printed).toContain('Could not undo "b": settings locked');
  });
});

describe('runInstall — over a settings file that is not JSON', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'install-corrupt-'));
    vi.stubEnv('CODEMIE_HOME', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await (await import('@/utils/logger.js')).logger.close();
    await rm(home, { recursive: true, force: true });
  });

  it('completes and writes the new settings', async () => {
    await writeFile(join(home, 'analytics-sync.json'), '{not json');
    const store = await import('../config-store.js');
    const previous = await store.loadSyncSettings().catch(() => null);
    const harness = makeDeps({
      readSettingsRaw: () => store.readSyncSettingsRaw(),
      writeSettings: (settings) => store.writeSyncSettings(settings),
      restoreSettingsRaw: (raw) => store.restoreSyncSettingsRaw(raw),
    });

    const code = await runInstall(VALID_OPTS, harness.deps);

    expect(previous).toBeNull();
    expect(code).toBe(0);
    expect(await store.loadSyncSettings()).toMatchObject({ webhookUrl: FAKE_WEBHOOK });
  });
});
