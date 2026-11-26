import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { SyncSchedulerRegisterError, SyncSchedulerUnsupportedError } from '@/utils/errors.js';
import type { ExecResult, exec as realExec } from '@/utils/exec.js';
import { getCodemiePath } from '@/utils/paths.js';

import { createScheduler, type SchedulerDeps, type SchedulerFs } from '../index.js';
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME, type JobCommand } from '../generators.js';

const CMD: JobCommand = {
  node: '/usr/local/bin/node',
  entry: '/home/dev/.codemie/bin/codemie.js',
  args: ['analytics', 'sync', 'run', '--scheduled']
};

interface FakeCall {
  command: string;
  args: string[];
}

function fakeExec(responses: Array<ExecResult | Error>): { exec: typeof realExec; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const exec = (async (command: string, args: string[] = []) => {
    calls.push({ command, args });
    const response = responses[calls.length - 1] ?? { code: 0, stdout: '', stderr: '' };
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }) as unknown as typeof realExec;
  return { exec, calls };
}

type FakeFs = SchedulerFs & {
  writes: { path: string; data: string | Buffer }[];
  removed: string[];
  mkdirs: string[];
};

/** `present` lists the files that exist: `rm` of anything else rejects with ENOENT, as the
 * real `fs.rm` does without `force`. */
function fakeFs(present: string[] = []): FakeFs {
  const writes: { path: string; data: string | Buffer }[] = [];
  const removed: string[] = [];
  const mkdirs: string[] = [];
  const existing = new Set(present);
  return {
    writes,
    removed,
    mkdirs,
    async mkdir(path: string) {
      mkdirs.push(path);
      return undefined;
    },
    async writeFile(path: string, data: string | Buffer) {
      writes.push({ path, data });
      existing.add(path);
    },
    async exists(path: string) {
      return existing.has(path);
    },
    async rm(path: string) {
      if (!existing.has(path)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      existing.delete(path);
      removed.push(path);
    }
  };
}

function baseDeps(
  platform: NodeJS.Platform,
  exec: typeof realExec,
  fs: SchedulerFs
): SchedulerDeps {
  return {
    platform,
    exec,
    homedir: () => '/home/dev',
    uid: () => 501,
    username: () => 'dev',
    sleep: async () => undefined,
    fs
  };
}

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const FAIL: ExecResult = { code: 1, stdout: '', stderr: 'boom' };

const PLIST_PATH = join('/home/dev', 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const UNIT_DIR = join('/home/dev', '.config', 'systemd', 'user');
const SERVICE_PATH = join(UNIT_DIR, `${SYSTEMD_UNIT_NAME}.service`);
const TIMER_PATH = join(UNIT_DIR, `${SYSTEMD_UNIT_NAME}.timer`);

describe('preflight', () => {
  it('throws SyncSchedulerUnsupportedError for an unsupported platform, calling exec nothing', async () => {
    const { exec, calls } = fakeExec([]);
    const scheduler = createScheduler(baseDeps('freebsd' as NodeJS.Platform, exec, fakeFs()), SYSTEMD_UNIT_NAME);

    await expect(scheduler.preflight()).rejects.toThrow(SyncSchedulerUnsupportedError);
    expect(calls).toHaveLength(0);
  });

  it('passes on darwin without calling exec', async () => {
    const { exec, calls } = fakeExec([]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fakeFs()), LAUNCHD_LABEL);

    await expect(scheduler.preflight()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('passes on win32 without calling exec', async () => {
    const { exec, calls } = fakeExec([]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()), WINDOWS_TASK_NAME);

    await expect(scheduler.preflight()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('on linux, checks systemctl --user and passes when it succeeds', async () => {
    const { exec, calls } = fakeExec([OK]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);

    await expect(scheduler.preflight()).resolves.toBeUndefined();
    expect(calls).toEqual([{ command: 'systemctl', args: ['--user', 'show-environment'] }]);
  });

  it('on linux, fails when systemctl --user errors and calls nothing else', async () => {
    const { exec, calls } = fakeExec([FAIL]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);

    await expect(scheduler.preflight()).rejects.toThrow(SyncSchedulerUnsupportedError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ command: 'systemctl', args: ['--user', 'show-environment'] });
  });

  it('on linux, fails when systemctl --user is unreachable (exec rejects) and calls nothing else', async () => {
    const { exec, calls } = fakeExec([new Error('ENOENT')]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);

    await expect(scheduler.preflight()).rejects.toThrow(SyncSchedulerUnsupportedError);
    expect(calls).toHaveLength(1);
  });
});

describe('register on darwin', () => {
  it('writes the plist then runs bootout before bootstrap', async () => {
    const { exec, calls } = fakeExec([FAIL, OK]); // bootout tolerates "not loaded" (non-zero)
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('darwin', exec, fs), LAUNCHD_LABEL);

    const result = await scheduler.register(CMD, '07:05');

    expect(result).toEqual({});
    const plistPath = join('/home/dev', 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    expect(fs.writes.map((w) => w.path)).toContain(plistPath);

    expect(calls).toEqual([
      { command: 'launchctl', args: ['bootout', `gui/501/${LAUNCHD_LABEL}`] },
      { command: 'launchctl', args: ['bootstrap', 'gui/501', plistPath] }
    ]);
  });

  it('throws SyncSchedulerRegisterError when bootstrap fails twice', async () => {
    const { exec, calls } = fakeExec([FAIL, FAIL, FAIL]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fakeFs()), LAUNCHD_LABEL);

    await expect(scheduler.register(CMD, '07:05')).rejects.toThrow(SyncSchedulerRegisterError);
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toHaveLength(2);
  });

  it('retries bootstrap once after the asynchronous bootout (error 5) and succeeds', async () => {
    const busy: ExecResult = { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
    const { exec, calls } = fakeExec([OK, busy, OK]);
    const sleeps: number[] = [];
    const deps = { ...baseDeps('darwin', exec, fakeFs()), sleep: async (ms: number) => void sleeps.push(ms) };
    const scheduler = createScheduler(deps, LAUNCHD_LABEL);

    await expect(scheduler.register(CMD, '07:05')).resolves.toEqual({});
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it('points launchd stdout/stderr at its own log, not the run log, and creates the logs dir', async () => {
    const { exec } = fakeExec([OK, OK]);
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('darwin', exec, fs), LAUNCHD_LABEL);

    await scheduler.register(CMD, '07:05');

    const plist = String(fs.writes.find((w) => w.path === PLIST_PATH)?.data);
    const launchdLog = getCodemiePath('logs', 'analytics-sync.launchd.log');
    expect(plist).toContain(`<string>${launchdLog}</string>`);
    expect(plist).not.toContain(`<string>${getCodemiePath('logs', 'analytics-sync.log')}</string>`);
    expect(fs.mkdirs).toContain(getCodemiePath('logs'));
  });
});

describe('register on linux', () => {
  it('writes service+timer, then daemon-reload, enable --now, loginctl enable-linger', async () => {
    const { exec, calls } = fakeExec([OK, OK, OK]);
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('linux', exec, fs), SYSTEMD_UNIT_NAME);

    const result = await scheduler.register(CMD, '07:05');

    expect(result).toEqual({});
    const unitDir = join('/home/dev', '.config', 'systemd', 'user');
    expect(fs.writes.map((w) => w.path)).toEqual(
      expect.arrayContaining([
        join(unitDir, `${SYSTEMD_UNIT_NAME}.service`),
        join(unitDir, `${SYSTEMD_UNIT_NAME}.timer`)
      ])
    );

    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', `${SYSTEMD_UNIT_NAME}.timer`] },
      { command: 'loginctl', args: ['enable-linger', 'dev'] }
    ]);
  });

  it('returns a lingerWarning (not a throw) when loginctl enable-linger fails', async () => {
    const { exec } = fakeExec([OK, OK, FAIL]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);

    const result = await scheduler.register(CMD, '07:05');

    expect(result.lingerWarning).toBeDefined();
  });

  it('returns a lingerWarning when loginctl enable-linger rejects outright', async () => {
    const { exec } = fakeExec([OK, OK, new Error('loginctl not found')]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);

    const result = await scheduler.register(CMD, '07:05');

    expect(result.lingerWarning).toBeDefined();
  });

  it('throws SyncSchedulerRegisterError when daemon-reload fails, without calling enable --now', async () => {
    const { exec, calls } = fakeExec([FAIL]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);

    await expect(scheduler.register(CMD, '07:05')).rejects.toThrow(SyncSchedulerRegisterError);
    expect(calls).toHaveLength(1);
  });

  it('throws SyncSchedulerRegisterError when enable --now fails', async () => {
    const { exec } = fakeExec([OK, FAIL]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);

    await expect(scheduler.register(CMD, '07:05')).rejects.toThrow(SyncSchedulerRegisterError);
  });
});

describe('register on win32', () => {
  it('writes the task XML as a Buffer, then runs /Delete /F before /Create /XML', async () => {
    const { exec, calls } = fakeExec([FAIL, OK]); // delete tolerates "task not found"
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('win32', exec, fs), WINDOWS_TASK_NAME);

    const result = await scheduler.register(CMD, '07:05');

    expect(result).toEqual({});
    expect(fs.writes).toHaveLength(1);
    expect(Buffer.isBuffer(fs.writes[0].data)).toBe(true);

    expect(calls[0]).toEqual({ command: 'schtasks', args: ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME] });
    expect(calls[1].command).toBe('schtasks');
    expect(calls[1].args[0]).toBe('/Create');
    expect(calls[1].args).toContain('/XML');
    expect(calls[1].args).toContain(WINDOWS_TASK_NAME);
  });

  it('throws SyncSchedulerRegisterError when /Create /XML fails', async () => {
    const { exec } = fakeExec([FAIL, FAIL]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()), WINDOWS_TASK_NAME);

    await expect(scheduler.register(CMD, '07:05')).rejects.toThrow(SyncSchedulerRegisterError);
  });
});

describe('query', () => {
  it('darwin: maps a successful launchctl print to enabled', async () => {
    const { exec } = fakeExec([OK]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fakeFs()), LAUNCHD_LABEL);
    await expect(scheduler.query()).resolves.toBe('enabled');
  });

  it('darwin: maps a not-listed job (print rejects) to disabled', async () => {
    const { exec } = fakeExec([new Error('Could not find service')]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fakeFs()), LAUNCHD_LABEL);
    await expect(scheduler.query()).resolves.toBe('disabled');
  });

  it('linux: maps is-enabled stdout "enabled" to enabled', async () => {
    const { exec } = fakeExec([{ code: 0, stdout: 'enabled', stderr: '' }]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);
    await expect(scheduler.query()).resolves.toBe('enabled');
  });

  it('linux: maps is-enabled stdout "disabled" to disabled', async () => {
    const { exec } = fakeExec([{ code: 1, stdout: 'disabled', stderr: '' }]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);
    await expect(scheduler.query()).resolves.toBe('disabled');
  });

  it('win32: maps a schtasks "Status: Disabled" line to disabled', async () => {
    const { exec } = fakeExec([{ code: 0, stdout: 'TaskName: X\r\nStatus:               Disabled\r\n', stderr: '' }]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()), WINDOWS_TASK_NAME);
    await expect(scheduler.query()).resolves.toBe('disabled');
  });

  it('win32: maps a schtasks "Status: Ready" line to enabled', async () => {
    const { exec } = fakeExec([{ code: 0, stdout: 'TaskName: X\r\nStatus:               Ready\r\n', stderr: '' }]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()), WINDOWS_TASK_NAME);
    await expect(scheduler.query()).resolves.toBe('enabled');
  });

  it('win32: maps schtasks failure (task not found) to disabled', async () => {
    const { exec } = fakeExec([new Error('ERROR: The system cannot find the file specified.')]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()), WINDOWS_TASK_NAME);
    await expect(scheduler.query()).resolves.toBe('disabled');
  });
});

describe('unregister', () => {
  it('darwin: boots the job out and removes the plist, returning true', async () => {
    const { exec, calls } = fakeExec([OK]);
    const fs = fakeFs([PLIST_PATH]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fs), LAUNCHD_LABEL);

    const removed = await scheduler.unregister();

    expect(removed).toBe(true);
    expect(calls).toEqual([{ command: 'launchctl', args: ['bootout', `gui/501/${LAUNCHD_LABEL}`] }]);
    expect(fs.removed).toContain(PLIST_PATH);
  });

  it('darwin: removes a plist that is not loaded and still reports it removed', async () => {
    const { exec } = fakeExec([FAIL]);
    const fs = fakeFs([PLIST_PATH]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fs), LAUNCHD_LABEL);

    await expect(scheduler.unregister()).resolves.toBe(true);
    expect(fs.removed).toContain(PLIST_PATH);
  });

  it('darwin: returns false and tolerates absence when nothing was registered', async () => {
    const { exec } = fakeExec([new Error('not found')]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fakeFs()), LAUNCHD_LABEL);

    await expect(scheduler.unregister()).resolves.toBe(false);
  });

  it('linux: disables a timer that is already disabled, removes both units and reloads systemd', async () => {
    const { exec, calls } = fakeExec([OK, OK]);
    const fs = fakeFs([SERVICE_PATH, TIMER_PATH]);
    const scheduler = createScheduler(baseDeps('linux', exec, fs), SYSTEMD_UNIT_NAME);

    const removed = await scheduler.unregister();

    expect(removed).toBe(true);
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'disable', '--now', `${SYSTEMD_UNIT_NAME}.timer`] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] }
    ]);
    expect(fs.removed).toEqual(expect.arrayContaining([SERVICE_PATH, TIMER_PATH]));
  });

  it('linux: returns false when no unit exists', async () => {
    const { exec } = fakeExec([FAIL]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()), SYSTEMD_UNIT_NAME);

    await expect(scheduler.unregister()).resolves.toBe(false);
  });

  it('win32: deletes a task disabled outside the CLI and reports it removed', async () => {
    const { exec, calls } = fakeExec([OK]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()), WINDOWS_TASK_NAME);

    const removed = await scheduler.unregister();

    expect(removed).toBe(true);
    expect(calls).toEqual([{ command: 'schtasks', args: ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME] }]);
  });

  it('win32: returns false when no task exists', async () => {
    const { exec } = fakeExec([FAIL]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()), WINDOWS_TASK_NAME);

    await expect(scheduler.unregister()).resolves.toBe(false);
  });
});

describe('custom task names', () => {
  const NAME = 'my-custom-task';
  const customPlist = join('/home/dev', 'Library', 'LaunchAgents', `${NAME}.plist`);
  const customService = join(UNIT_DIR, `${NAME}.service`);
  const customTimer = join(UNIT_DIR, `${NAME}.timer`);

  it('darwin: register writes <name>.plist with that label and bootstraps gui/<uid>/<name>', async () => {
    const { exec, calls } = fakeExec([FAIL, OK]);
    const fs = fakeFs();

    await createScheduler(baseDeps('darwin', exec, fs), NAME).register(CMD, '07:05');

    expect(String(fs.writes.find((w) => w.path === customPlist)?.data)).toContain(`<key>Label</key>\n    <string>${NAME}</string>`);
    expect(fs.writes.map((w) => w.path)).not.toContain(PLIST_PATH);
    expect(calls).toEqual([
      { command: 'launchctl', args: ['bootout', `gui/501/${NAME}`] },
      { command: 'launchctl', args: ['bootstrap', 'gui/501', customPlist] }
    ]);
  });

  it('darwin: unregister and query target the custom name only', async () => {
    const { exec, calls } = fakeExec([OK, OK]);
    const fs = fakeFs([customPlist, PLIST_PATH]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fs), NAME);

    await expect(scheduler.unregister()).resolves.toBe(true);
    await expect(scheduler.query()).resolves.toBe('enabled');

    expect(calls).toEqual([
      { command: 'launchctl', args: ['bootout', `gui/501/${NAME}`] },
      { command: 'launchctl', args: ['print', `gui/501/${NAME}`] }
    ]);
    expect(fs.removed).toEqual([customPlist]);
  });

  it('linux: register writes <name>.service/.timer and enables <name>.timer', async () => {
    const { exec, calls } = fakeExec([OK, OK, OK]);
    const fs = fakeFs();

    await createScheduler(baseDeps('linux', exec, fs), NAME).register(CMD, '07:05');

    expect(fs.writes.map((w) => w.path)).toEqual([customService, customTimer]);
    expect(calls[1]).toEqual({ command: 'systemctl', args: ['--user', 'enable', '--now', `${NAME}.timer`] });
  });

  it('linux: unregister disables <name>.timer and removes only its unit files', async () => {
    const { exec, calls } = fakeExec([OK, OK]);
    const fs = fakeFs([customService, customTimer, SERVICE_PATH, TIMER_PATH]);

    await expect(createScheduler(baseDeps('linux', exec, fs), NAME).unregister()).resolves.toBe(true);

    expect(calls[0]).toEqual({ command: 'systemctl', args: ['--user', 'disable', '--now', `${NAME}.timer`] });
    expect(fs.removed).toEqual(expect.arrayContaining([customService, customTimer]));
    expect(fs.removed).not.toContain(SERVICE_PATH);
  });

  it('linux: query asks is-enabled for <name>.timer', async () => {
    const { exec, calls } = fakeExec([{ code: 0, stdout: 'enabled', stderr: '' }]);

    await createScheduler(baseDeps('linux', exec, fakeFs()), NAME).query();

    expect(calls).toEqual([{ command: 'systemctl', args: ['--user', 'is-enabled', `${NAME}.timer`] }]);
  });

  it('win32: register, unregister and query pass the name to schtasks /TN', async () => {
    const taskName = 'My Custom Task';
    const { exec, calls } = fakeExec([FAIL, OK, OK, { code: 0, stdout: 'Status: Ready', stderr: '' }]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()), taskName);

    await scheduler.register(CMD, '07:05');
    await scheduler.unregister();
    await scheduler.query();

    expect(calls[0]).toEqual({ command: 'schtasks', args: ['/Delete', '/F', '/TN', taskName] });
    expect(calls[1].args).toEqual(expect.arrayContaining(['/Create', '/TN', taskName]));
    expect(calls[2]).toEqual({ command: 'schtasks', args: ['/Delete', '/F', '/TN', taskName] });
    expect(calls[3]).toEqual({ command: 'schtasks', args: ['/Query', '/TN', taskName, '/FO', 'LIST', '/V'] });
  });
});

describe('exists', () => {
  const NAME = 'my-custom-task';
  const customPlist = join('/home/dev', 'Library', 'LaunchAgents', `${NAME}.plist`);
  const customService = join(UNIT_DIR, `${NAME}.service`);
  const customTimer = join(UNIT_DIR, `${NAME}.timer`);

  describe('darwin', () => {
    it('is present when launchctl print succeeds', async () => {
      const { exec, calls } = fakeExec([OK]);
      await expect(createScheduler(baseDeps('darwin', exec, fakeFs()), NAME).exists()).resolves.toBe('present');
      expect(calls).toEqual([{ command: 'launchctl', args: ['print', `gui/501/${NAME}`] }]);
    });

    it('is present when only the plist file is left (not loaded)', async () => {
      const { exec } = fakeExec([FAIL]);
      await expect(createScheduler(baseDeps('darwin', exec, fakeFs([customPlist])), NAME).exists()).resolves.toBe('present');
    });

    it('is absent when neither the job nor the plist exists', async () => {
      const { exec } = fakeExec([FAIL]);
      await expect(createScheduler(baseDeps('darwin', exec, fakeFs()), NAME).exists()).resolves.toBe('absent');
    });

    it('is unknown when the probe throws', async () => {
      const { exec } = fakeExec([new Error('launchctl missing')]);
      await expect(createScheduler(baseDeps('darwin', exec, fakeFs()), NAME).exists()).resolves.toBe('unknown');
    });
  });

  describe('linux', () => {
    it.each([[customService], [customTimer]])('is present when %s exists, without calling systemctl', async (file) => {
      const { exec, calls } = fakeExec([]);
      await expect(createScheduler(baseDeps('linux', exec, fakeFs([file])), NAME).exists()).resolves.toBe('present');
      expect(calls).toHaveLength(0);
    });

    it('is present when is-enabled exits 0', async () => {
      const { exec } = fakeExec([{ code: 0, stdout: 'enabled', stderr: '' }]);
      await expect(createScheduler(baseDeps('linux', exec, fakeFs()), NAME).exists()).resolves.toBe('present');
    });

    it('is present for a known non-enabled state such as masked', async () => {
      const { exec } = fakeExec([{ code: 1, stdout: 'masked\n', stderr: '' }]);
      await expect(createScheduler(baseDeps('linux', exec, fakeFs()), NAME).exists()).resolves.toBe('present');
    });

    it('is absent when systemd says the unit file does not exist', async () => {
      const { exec } = fakeExec([{ code: 1, stdout: '', stderr: `Failed to get unit file state for ${NAME}.timer: No such file or directory` }]);
      await expect(createScheduler(baseDeps('linux', exec, fakeFs()), NAME).exists()).resolves.toBe('absent');
    });

    it('is unknown when the failure is not a not-found message', async () => {
      const { exec } = fakeExec([{ code: 1, stdout: '', stderr: 'Failed to connect to bus' }]);
      await expect(createScheduler(baseDeps('linux', exec, fakeFs()), NAME).exists()).resolves.toBe('unknown');
    });

    it('is unknown when the probe throws', async () => {
      const { exec } = fakeExec([new Error('spawn systemctl ENOENT')]);
      await expect(createScheduler(baseDeps('linux', exec, fakeFs()), NAME).exists()).resolves.toBe('unknown');
    });
  });

  describe('win32', () => {
    const listing = (...names: string[]): ExecResult => ({
      code: 0,
      stdout: names.map((n) => `"\\${n.replace(/"/g, '""')}","N/A","Ready"`).join('\r\n') + '\r\n',
      stderr: ''
    });

    it('is present when the task is in the CSV listing, case-insensitively', async () => {
      const { exec, calls } = fakeExec([listing('Other', 'MY CUSTOM TASK')]);
      await expect(createScheduler(baseDeps('win32', exec, fakeFs()), 'My Custom Task').exists()).resolves.toBe('present');
      expect(calls).toEqual([{ command: 'schtasks', args: ['/Query', '/FO', 'CSV', '/NH'] }]);
    });

    it('matches names holding quotes through CSV unescaping', async () => {
      const { exec } = fakeExec([listing('say "hi"')]);
      await expect(createScheduler(baseDeps('win32', exec, fakeFs()), 'say "hi"').exists()).resolves.toBe('present');
    });

    it('is absent when only other tasks are listed, including a longer name with the same prefix', async () => {
      const { exec } = fakeExec([listing('My Custom Task 2', 'Other')]);
      await expect(createScheduler(baseDeps('win32', exec, fakeFs()), 'My Custom Task').exists()).resolves.toBe('absent');
    });

    it('is absent for an empty listing', async () => {
      const { exec } = fakeExec([{ code: 0, stdout: '', stderr: '' }]);
      await expect(createScheduler(baseDeps('win32', exec, fakeFs()), 'My Custom Task').exists()).resolves.toBe('absent');
    });

    it('is unknown when schtasks exits non-zero', async () => {
      const { exec } = fakeExec([FAIL]);
      await expect(createScheduler(baseDeps('win32', exec, fakeFs()), 'My Custom Task').exists()).resolves.toBe('unknown');
    });

    it('is unknown when the probe throws', async () => {
      const { exec } = fakeExec([new Error('spawn schtasks ENOENT')]);
      await expect(createScheduler(baseDeps('win32', exec, fakeFs()), 'My Custom Task').exists()).resolves.toBe('unknown');
    });
  });

  it('is unknown on an unsupported platform', async () => {
    const { exec } = fakeExec([]);
    await expect(createScheduler(baseDeps('freebsd' as NodeJS.Platform, exec, fakeFs()), NAME).exists()).resolves.toBe('unknown');
  });
});
