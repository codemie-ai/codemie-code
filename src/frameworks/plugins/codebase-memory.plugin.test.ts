/**
 * Codebase Memory framework plugin tests
 * @group unit
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/processes.js', () => ({
  commandExists: vi.fn(),
  exec: vi.fn(),
}));

describe('CodebaseMemoryPlugin', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('installs the graph visualization UI variant on Unix-like platforms', async () => {
    const { exec } = await import('../../utils/processes.js');
    const { CodebaseMemoryPlugin } = await import('./codebase-memory.plugin.js');

    vi.mocked(exec).mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    const plugin = new CodebaseMemoryPlugin();
    await plugin.install();

    expect(exec).toHaveBeenCalledWith(
      'bash',
      [
        '-c',
        'curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --ui',
      ],
      { timeout: 300000 }
    );
  });

  it('initializes agent config, enables auto indexing, and indexes the current repository', async () => {
    const { commandExists, exec } = await import('../../utils/processes.js');
    const { CodebaseMemoryPlugin } = await import('./codebase-memory.plugin.js');

    vi.mocked(commandExists).mockResolvedValue(true);
    vi.mocked(exec).mockImplementation(async (_command, args) => {
      if (args[0] === '--help') {
        return { code: 0, stdout: 'Usage: codebase-memory-mcp --ui=true', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const plugin = new CodebaseMemoryPlugin();
    await plugin.init('codex', { cwd: '/repo/app' });

    expect(exec).toHaveBeenCalledWith('codebase-memory-mcp', ['install', '-y'], {
      cwd: '/repo/app',
      timeout: 120000,
    });
    expect(exec).toHaveBeenCalledWith(
      'codebase-memory-mcp',
      ['config', 'set', 'auto_index', 'true'],
      { cwd: '/repo/app', timeout: 30000 }
    );
    expect(exec).toHaveBeenCalledWith(
      'codebase-memory-mcp',
      ['cli', 'index_repository', '{"repo_path":"/repo/app"}'],
      { cwd: '/repo/app', timeout: 300000 }
    );
  });

  it('does not treat a binary without UI flags as installed', async () => {
    const { commandExists, exec } = await import('../../utils/processes.js');
    const { CodebaseMemoryPlugin } = await import('./codebase-memory.plugin.js');

    vi.mocked(commandExists).mockResolvedValue(true);
    vi.mocked(exec).mockImplementation(async (_command, args) => {
      if (args[0] === '--help') {
        return { code: 0, stdout: 'Usage: codebase-memory-mcp', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const plugin = new CodebaseMemoryPlugin();

    await expect(plugin.isInstalled()).resolves.toBe(false);
  });
});
