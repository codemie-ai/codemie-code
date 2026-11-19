import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));

vi.mock('../../../../utils/processes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/processes.js')>();
  return { ...actual, exec: mockExec, commandExists: vi.fn(() => Promise.resolve(true)) };
});

import { VERSION_PROBE_OPTIONS } from '../../../../utils/exec.js';

describe('CopilotCliPlugin.getVersion', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  async function plugin() {
    const { CopilotCliPlugin } = await import('../copilot-cli.plugin.js');
    return new CopilotCliPlugin();
  }

  it('passes VERSION_PROBE_OPTIONS to exec', async () => {
    mockExec.mockResolvedValue({ code: 0, stdout: 'copilot 1.2.3', stderr: '' });
    const p = await plugin();
    await p.getVersion();
    expect(mockExec).toHaveBeenCalledWith(expect.any(String), ['--version'], VERSION_PROBE_OPTIONS);
  });

  it('parses a semver from the output', async () => {
    mockExec.mockResolvedValue({ code: 0, stdout: 'copilot 1.2.3', stderr: '' });
    expect(await (await plugin()).getVersion()).toBe('1.2.3');
  });

  it('falls back to trimmed stdout for non-version output', async () => {
    mockExec.mockResolvedValue({ code: 0, stdout: '  nightly  ', stderr: '' });
    expect(await (await plugin()).getVersion()).toBe('nightly');
  });

  it('returns null when the probe times out', async () => {
    mockExec.mockRejectedValue(new Error('Command timed out after 5000ms'));
    expect(await (await plugin()).getVersion()).toBeNull();
  });
});
