import { afterEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/processes.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/processes.js')>(
    '../../../../utils/processes.js'
  );
  return { ...actual, exec: execMock };
});

import { KimiPlugin } from '../kimi.plugin.js';

describe('KimiPlugin.getVersion on Windows', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('runs the PATH fallback through a shell, where an npm install is a .cmd shim', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    execMock.mockResolvedValue({ code: 0, stdout: 'kimi, version 2.1.1\n', stderr: '' });

    await expect(new KimiPlugin().getVersion()).resolves.toBe('2.1.1');
    expect(execMock).toHaveBeenCalledWith('kimi', ['--version'], expect.objectContaining({ shell: true }));
  });
});
