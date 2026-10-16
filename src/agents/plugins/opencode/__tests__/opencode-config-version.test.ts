/**
 * Tests for the OpenCode config-schema version probe.
 *
 * The probe result selects the config schema beforeRun emits (v1:
 * `provider` + `npm` + `options`; v2: `providers` + `package` + `settings`),
 * so every behaviour guarded here is load-bearing for agent startup:
 * an unbounded or Windows-broken probe silently degrades to v1, and a
 * probe failure must never block the launch.
 *
 * `resolveOpenCodeConfigVersion` is imported directly; `exec` (the version
 * probe) and `getCommandPath` (the Windows `.cmd`-shim resolution) are
 * mocked, everything else is real.
 *
 * The cache is TTL-bounded (second-audit F2): a successful probe is trusted
 * for 5 minutes, a failed probe's v1 fallback for 30 seconds, so a
 * long-lived process picks up an installed/upgraded binary without a
 * restart and a failed probe is retried soon — both guarded below with
 * faked time (1 minute: within the success TTL, past the failure TTL;
 * 10 minutes: past both).
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';

vi.mock('../../../../utils/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/exec.js')>()),
  exec: vi.fn(),
}));
vi.mock('../../../../utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/processes.js')>()),
  getCommandPath: vi.fn(),
}));

const { exec } = await import('../../../../utils/exec.js');
const { getCommandPath } = await import('../../../../utils/processes.js');
const { resolveOpenCodeConfigVersion, resetOpenCodeConfigVersionCache, OpenCodePluginMetadata } = await import(
  '../opencode.plugin.js'
);

const mockedExec = vi.mocked(exec);
const mockedGetCommandPath = vi.mocked(getCommandPath);

const ORIGINAL_OVERRIDE = process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
const ORIGINAL_COMMAND = OpenCodePluginMetadata.cliCommand;
const { logger } = await import('../../../../utils/logger.js');

beforeEach(() => {
  resetOpenCodeConfigVersionCache();
  delete process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
  vi.clearAllMocks();
  mockedGetCommandPath.mockResolvedValue('/usr/local/bin/opencode');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  OpenCodePluginMetadata.cliCommand = ORIGINAL_COMMAND;
  if (ORIGINAL_OVERRIDE === undefined) {
    delete process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
  } else {
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = ORIGINAL_OVERRIDE;
  }
});

describe('resolveOpenCodeConfigVersion', () => {
  it('honours CODEMIE_OPENCODE_CONFIG_VERSION=2 without probing', async () => {
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '2';

    await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('honours CODEMIE_OPENCODE_CONFIG_VERSION=1 without probing', async () => {
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '1';

    await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('resolves v2 for a 2.x binary via the resolved path with a bounded probe', async () => {
    mockedExec.mockResolvedValue({ code: 0, stdout: 'opencode 2.0.1', stderr: '' });

    await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');

    expect(mockedGetCommandPath).toHaveBeenCalledWith('opencode');
    expect(mockedExec).toHaveBeenCalledWith(
      '/usr/local/bin/opencode',
      ['--version'],
      { timeout: 3000, shell: os.platform() === 'win32' }
    );
  });

  it('resolves v1 for a 1.x binary', async () => {
    mockedExec.mockResolvedValue({ code: 0, stdout: '1.18.34', stderr: '' });

    await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');
  });

  describe('F5-9 version response validation', () => {
    it.each([
      ['2.0.28', 'v2'],
      ['opencode 2.0.28', 'v2'],
      ['OpenCode-ai v2.0.28-beta.1+build.42', 'v2'],
      [' v2.0.28\n', 'v2'],
      ['3.1.0', 'v2'],
      ['opencode v1.19.0-rc.1+build.7', 'v1'],
    ])('accepts a complete response %j as %s', async (stdout, version) => {
      mockedExec.mockResolvedValue({ code: 0, stdout, stderr: '' });
      await expect(resolveOpenCodeConfigVersion()).resolves.toBe(version);
    });

    it.each(['', ' \n', '2', '2.0', '2.0.28 extra', 'error: 2.0.28', 'opencode 2.0.28\nwarning', '2.0.28-'])(
      'negative-caches invalid response %j for only 30 seconds', async stdout => {
        vi.useFakeTimers();
        const start = Date.now();
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        mockedExec.mockResolvedValueOnce({ code: 0, stdout, stderr: 'secret-stderr' });
        mockedExec.mockResolvedValue({ code: 0, stdout: '2.0.28', stderr: '' });

        await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');
        vi.setSystemTime(start + 29_999);
        await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');
        expect(mockedExec).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('did not report a valid version'));
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-stderr');
        if (stdout.trim()) expect(JSON.stringify(warn.mock.calls)).not.toContain(stdout.trim());

        vi.setSystemTime(start + 30_000);
        await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');
        expect(mockedExec).toHaveBeenCalledTimes(2);
      },
    );

    it.each([1, 2, -1])('rejects exit %s even with a valid version and retries after the failure TTL', async code => {
      vi.useFakeTimers();
      const start = Date.now();
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      mockedExec.mockResolvedValueOnce({ code, stdout: '2.0.28', stderr: 'private diagnostic' });
      mockedExec.mockResolvedValue({ code: 0, stdout: '2.0.29', stderr: '' });
      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`exited with code ${code}`));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('2.0.28');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private diagnostic');
      vi.setSystemTime(start + 30_000);
      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');
    });
  });

  describe('F5-9 executable quoting', () => {
    it.each([
      ['C:\\Program Files\\OpenCode\\opencode.cmd', '"C:\\Program Files\\OpenCode\\opencode.cmd"'],
      ['C:\\tools&(local)\\opencode.cmd', '"C:\\tools&(local)\\opencode.cmd"'],
      ['C:\\tools\\opencode.cmd', 'C:\\tools\\opencode.cmd'],
      ['"C:\\Program Files\\OpenCode\\opencode.cmd"', '"C:\\Program Files\\OpenCode\\opencode.cmd"'],
    ])('quotes Windows command %s for both resolved and metadata fallback paths', async (command, expected) => {
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      OpenCodePluginMetadata.cliCommand = command;
      mockedExec.mockResolvedValue({ code: 0, stdout: '2.0.28', stderr: '' });
      for (const resolved of [command, null]) {
        resetOpenCodeConfigVersionCache();
        mockedGetCommandPath.mockResolvedValue(resolved);
        await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');
        expect(mockedExec).toHaveBeenLastCalledWith(expected, ['--version'], { timeout: 3000, shell: true });
      }
    });

    it('keeps POSIX executables unquoted and shell-free', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      mockedGetCommandPath.mockResolvedValue('/opt/OpenCode (local)/opencode');
      mockedExec.mockResolvedValue({ code: 0, stdout: '2.0.28', stderr: '' });
      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');
      expect(mockedExec).toHaveBeenCalledWith('/opt/OpenCode (local)/opencode', ['--version'], { timeout: 3000, shell: false });
    });
  });

  it('falls back to v1 when the probe fails', async () => {
    mockedExec.mockRejectedValue(new Error('spawn opencode ENOENT'));

    await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');
  });

  it('falls back to the bare command name when path resolution misses', async () => {
    mockedGetCommandPath.mockResolvedValue(null);
    mockedExec.mockResolvedValue({ code: 0, stdout: 'opencode 2.3.0', stderr: '' });

    await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');
    expect(mockedExec).toHaveBeenCalledWith(
      'opencode',
      ['--version'],
      expect.objectContaining({ timeout: 3000 })
    );
  });

  it('probes once per process until the cache is reset', async () => {
    mockedExec.mockResolvedValue({ code: 0, stdout: '1.18.34', stderr: '' });

    await resolveOpenCodeConfigVersion();
    await resolveOpenCodeConfigVersion();
    expect(mockedExec).toHaveBeenCalledTimes(1);

    resetOpenCodeConfigVersionCache();
    await resolveOpenCodeConfigVersion();
    expect(mockedExec).toHaveBeenCalledTimes(2);
  });

  describe('TTL-bounded cache (second-audit F2)', () => {
    it('does not re-probe a successful result within the success TTL', async () => {
      vi.useFakeTimers();
      mockedExec.mockResolvedValue({ code: 0, stdout: 'opencode 2.0.1', stderr: '' });

      await resolveOpenCodeConfigVersion();

      // A minute later the 5-minute success TTL is still fresh — no re-probe.
      vi.setSystemTime(Date.now() + 60_000);
      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');
      expect(mockedExec).toHaveBeenCalledTimes(1);
    });

    it('picks up a newly upgraded binary once the success TTL expires', async () => {
      vi.useFakeTimers();
      mockedExec.mockResolvedValueOnce({ code: 0, stdout: '1.18.34', stderr: '' });
      mockedExec.mockResolvedValue({ code: 0, stdout: 'opencode 2.0.1', stderr: '' });

      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');

      // 10 minutes later the success TTL has expired — the upgrade is probed again.
      vi.setSystemTime(Date.now() + 10 * 60_000);
      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');
      expect(mockedExec).toHaveBeenCalledTimes(2);
    });

    it('serves a failed probe fallback from the negative cache without re-probing', async () => {
      vi.useFakeTimers();
      mockedExec.mockRejectedValue(new Error('spawn opencode ENOENT'));

      // Repeated calls within one launch (reasoningEffort gate, beforeRun,
      // v2 branches) must not each re-spend the 3s probe timeout.
      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');
      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');
      expect(mockedExec).toHaveBeenCalledTimes(1);
    });

    it('retries a failed probe once the shorter failure TTL expires', async () => {
      vi.useFakeTimers();
      mockedExec.mockRejectedValueOnce(new Error('spawn opencode ENOENT'));
      mockedExec.mockResolvedValue({ code: 0, stdout: 'opencode 2.0.1', stderr: '' });

      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v1');

      // A minute is past the 30-second failure TTL (but inside the success
      // TTL) — the retry happens and observes the newly installed binary.
      vi.setSystemTime(Date.now() + 60_000);
      await expect(resolveOpenCodeConfigVersion()).resolves.toBe('v2');
      expect(mockedExec).toHaveBeenCalledTimes(2);
    });
  });
});
