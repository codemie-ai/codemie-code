import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  getSelfPrefixArgs: vi.fn()
}));

import { installGlobal } from '../processes.js';
import { getSelfPrefixArgs } from '../npm-prefix.js';
import { updateCli } from '../cli-updater.js';

describe('updateCli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes the derived --prefix in the manual fallback command on failure', async () => {
    vi.mocked(installGlobal).mockRejectedValue(new Error('EACCES'));
    vi.mocked(getSelfPrefixArgs).mockResolvedValue(['--prefix', 'C:\\FakePrefix']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(updateCli('1.2.3', true)).rejects.toThrow('EACCES');

    const printed = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(printed).toContain('npm install -g @codemieai/code@1.2.3 --prefix C:\\FakePrefix');
  });

  it('omits --prefix from the manual fallback command when no derived prefix applies', async () => {
    vi.mocked(installGlobal).mockRejectedValue(new Error('EACCES'));
    vi.mocked(getSelfPrefixArgs).mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(updateCli('1.2.3', true)).rejects.toThrow('EACCES');

    const printed = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(printed).toContain('npm install -g @codemieai/code@1.2.3');
    expect(printed).not.toContain('--prefix');
  });
});
