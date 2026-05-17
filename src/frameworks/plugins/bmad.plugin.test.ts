/**
 * BMAD framework plugin tests
 * @group unit
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/processes.js', () => ({
  exec: vi.fn(),
  listGlobal: vi.fn(),
  npxRun: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('BmadPlugin', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('initializes the SDLC preset headlessly by default', async () => {
    const { npxRun } = await import('../../utils/processes.js');
    const { BmadPlugin } = await import('./bmad.plugin.js');

    vi.mocked(npxRun).mockResolvedValue();

    const plugin = new BmadPlugin();
    await plugin.init('claude', { cwd: '/repo/app' });

    expect(npxRun).toHaveBeenCalledWith(
      'bmad-method',
      [
        'install',
        '--yes',
        '--directory',
        '/repo/app',
        '--modules',
        'bmm,tea',
        '--tools',
        'claude-code',
        '--set',
        'core.output_folder=_bmad-output',
      ],
      { cwd: '/repo/app', timeout: 300000, interactive: false }
    );
  });

  it('supports a minimal BMM-only preset', async () => {
    const { npxRun } = await import('../../utils/processes.js');
    const { BmadPlugin } = await import('./bmad.plugin.js');

    vi.mocked(npxRun).mockResolvedValue();

    const plugin = new BmadPlugin();
    await plugin.init('claude', { cwd: '/repo/app', preset: 'minimal' });

    expect(npxRun).toHaveBeenCalledWith(
      'bmad-method',
      expect.arrayContaining(['--modules', 'bmm']),
      expect.objectContaining({ interactive: false })
    );
  });

  it('uses the next package channel when requested', async () => {
    const { npxRun } = await import('../../utils/processes.js');
    const { BmadPlugin } = await import('./bmad.plugin.js');

    vi.mocked(npxRun).mockResolvedValue();

    const plugin = new BmadPlugin();
    await plugin.init('claude', { cwd: '/repo/app', bmadChannel: 'next' });

    expect(npxRun).toHaveBeenCalledWith(
      'bmad-method@next',
      expect.any(Array),
      expect.objectContaining({ interactive: false })
    );
  });

  it('preserves the upstream interactive installer when requested', async () => {
    const { npxRun } = await import('../../utils/processes.js');
    const { BmadPlugin } = await import('./bmad.plugin.js');

    vi.mocked(npxRun).mockResolvedValue();

    const plugin = new BmadPlugin();
    await plugin.init('claude', { cwd: '/repo/app', preset: 'interactive' });

    expect(npxRun).toHaveBeenCalledWith(
      'bmad-method',
      ['install'],
      { cwd: '/repo/app', timeout: 300000, interactive: true }
    );
  });

  it('falls back to interactive install when the BMAD tool mapping is unknown', async () => {
    const { npxRun } = await import('../../utils/processes.js');
    const { BmadPlugin } = await import('./bmad.plugin.js');

    vi.mocked(npxRun).mockResolvedValue();

    const plugin = new BmadPlugin();
    await plugin.init('unknown-agent', { cwd: '/repo/app' });

    expect(npxRun).toHaveBeenCalledWith(
      'bmad-method',
      ['install'],
      { cwd: '/repo/app', timeout: 300000, interactive: true }
    );
  });
});
