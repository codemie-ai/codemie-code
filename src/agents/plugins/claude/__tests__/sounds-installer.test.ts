/**
 * Tests for audio player detection in the sounds installer (`codemie install claude --sounds`).
 *
 * Reproduces EPMCDME-16959: on Debian/WSL `command` is a shell builtin with no binary, so
 * `exec('command', ['-v', player])` (shell: false) always fails with ENOENT even when the
 * player is installed.
 *
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@/utils/paths.js', () => ({
  getCodemiePath: vi.fn((...parts: string[]) => ['/home/testuser/.codemie', ...parts].join('/')),
}));

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('@/utils/exec.js', () => ({ exec: vi.fn() }));
vi.mock('@/utils/processes.js', () => ({ commandExists: vi.fn() }));

describe('sounds-installer audio player detection', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let commandExistsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    execMock = vi.mocked((await import('@/utils/exec.js')).exec) as unknown as ReturnType<typeof vi.fn>;
    commandExistsMock = vi.mocked((await import('@/utils/processes.js')).commandExists) as unknown as ReturnType<typeof vi.fn>;

    // Linux/Debian behaviour: `command` is a shell builtin, spawn without a shell -> ENOENT
    execMock.mockImplementation(async (command: string) => {
      if (command === 'command') {
        throw new Error('Failed to execute command: spawn command ENOENT');
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    // `which aplay` succeeds: the player is installed and on PATH
    commandExistsMock.mockImplementation(async (name: string) => name === 'aplay');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should find an installed player when `command` has no binary (Linux/WSL-Debian)', async () => {
    const { installSounds } = await import('../sounds-installer.js');

    const result = await installSounds();

    expect(result).toBe('success');
  });

  it('should return null when no player is installed', async () => {
    commandExistsMock.mockResolvedValue(false);
    const { installSounds } = await import('../sounds-installer.js');

    const result = await installSounds();

    expect(result).toBeNull();
  });

  it('should check afplay first (macOS preference order)', async () => {
    commandExistsMock.mockResolvedValue(true);
    const { installSounds } = await import('../sounds-installer.js');

    const result = await installSounds();

    expect(result).toBe('success');
    expect(commandExistsMock.mock.calls[0][0]).toBe('afplay');
  });
});
