import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('../paths.js', () => ({
  getCodemiePath: vi.fn(() => '/tmp/.codemie')
}));

vi.mock('../processes.js', () => ({
  installGlobal: vi.fn(),
  getLatestVersion: vi.fn()
}));

vi.mock('../npm-prefix.js', () => ({
  getNpmPrefixArgs: vi.fn()
}));

import { installGlobal, getLatestVersion } from '../processes.js';
import { getNpmPrefixArgs } from '../npm-prefix.js';
import { updateCli, isCodemieConnectInstall, checkAndPromptForUpdate } from '../cli-updater.js';

describe('updateCli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes the derived --prefix in the manual fallback command on failure', async () => {
    vi.mocked(installGlobal).mockRejectedValue(new Error('EACCES'));
    vi.mocked(getNpmPrefixArgs).mockResolvedValue(['--prefix', 'C:\\Users\\John Doe\\npm-prefix']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(updateCli('1.2.3', true)).rejects.toThrow('EACCES');

    const printed = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(printed).toContain('npm install -g @codemieai/code@1.2.3 --prefix "C:\\Users\\John Doe\\npm-prefix"');
  });

  it('omits --prefix from the manual fallback command when no derived prefix applies', async () => {
    vi.mocked(installGlobal).mockRejectedValue(new Error('EACCES'));
    vi.mocked(getNpmPrefixArgs).mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(updateCli('1.2.3', true)).rejects.toThrow('EACCES');

    const printed = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(printed).toContain('npm install -g @codemieai/code@1.2.3');
    expect(printed).not.toContain('--prefix');
  });
});

describe('CodeMie Connect install detection', () => {
  const originalAutoUpdate = process.env.CODEMIE_AUTO_UPDATE;

  function setMarker(present: boolean): void {
    vi.spyOn(fs, 'access').mockImplementation(async (target) => {
      if (String(target).endsWith('codemie-connect.json') && present) return;
      throw new Error('ENOENT');
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAutoUpdate === undefined) {
      delete process.env.CODEMIE_AUTO_UPDATE;
    } else {
      process.env.CODEMIE_AUTO_UPDATE = originalAutoUpdate;
    }
  });

  it('isCodemieConnectInstall is true when the marker exists', async () => {
    setMarker(true);
    await expect(isCodemieConnectInstall()).resolves.toBe(true);
  });

  it('isCodemieConnectInstall is false when the marker is absent', async () => {
    setMarker(false);
    await expect(isCodemieConnectInstall()).resolves.toBe(false);
  });

  it.each(['true', 'false'])(
    'checkAndPromptForUpdate does nothing in Connect (CODEMIE_AUTO_UPDATE=%s)',
    async (value) => {
      process.env.CODEMIE_AUTO_UPDATE = value;
      setMarker(true);
      const writeSpy = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
      const readSpy = vi.spyOn(fs, 'readFile');

      await expect(checkAndPromptForUpdate()).resolves.toBeUndefined();

      expect(getLatestVersion).not.toHaveBeenCalled();
      expect(installGlobal).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
    }
  );

  it('checkAndPromptForUpdate still checks for updates without the marker', async () => {
    setMarker(false);
    vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(((target: string, ...rest: unknown[]) => {
      if (String(target).endsWith('.last-update-check')) return Promise.reject(new Error('ENOENT'));
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as unknown as typeof fs.readFile);
    vi.mocked(getLatestVersion).mockResolvedValue('0.0.1');

    await checkAndPromptForUpdate();

    expect(getLatestVersion).toHaveBeenCalled();
  });
});
