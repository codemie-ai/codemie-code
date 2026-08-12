/**
 * Claude Desktop session discovery tests
 * @group unit
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'path';

vi.mock('../claude-desktop.paths.js', () => ({
  getClaudeDesktopLocalSessionsRoot: vi.fn().mockReturnValue('/desktop/local-agent-mode-sessions'),
  getClaudeDesktopCodeSessionsRoot: vi.fn().mockReturnValue('/desktop/claude-code-sessions'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

function directoryEntry(name: string): unknown {
  return { name, isDirectory: () => true, isFile: () => false };
}

function fileEntry(name: string): unknown {
  return { name, isDirectory: () => false, isFile: () => true };
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

const LOCAL_ROOT = '/desktop/local-agent-mode-sessions';
const CODE_ROOT = '/desktop/claude-code-sessions';

describe('discoverClaudeDesktopSessions — traversal resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Before Linux support this code was unreachable there. On Linux the
  // sessions tree lives under ~/.config with no per-app container, so a
  // root-owned leftover directory or a session directory deleted mid-walk is
  // routine. An unhandled rejection here propagates through
  // DesktopTelemetryRuntime.start() and kills the whole proxy daemon, taking
  // inference down with telemetry.
  it.each([
    ['an unreadable subdirectory', 'EACCES'],
    ['a subdirectory deleted mid-walk', 'ENOENT'],
  ])('skips %s instead of rejecting', async (_label, code) => {
    const { readdir } = await import('fs/promises');
    vi.mocked(readdir).mockImplementation((async (dir: string) => {
      if (dir === LOCAL_ROOT) return [directoryEntry('broken')] as never;
      if (dir === join(LOCAL_ROOT, 'broken')) throw errnoError(code);
      return [] as never;
    }) as unknown as typeof readdir);

    const { discoverClaudeDesktopSessions } = await import('../claude-desktop.discovery.js');
    await expect(discoverClaudeDesktopSessions(0)).resolves.toEqual([]);
  });

  it('keeps sessions found in readable siblings of an unreadable subdirectory', async () => {
    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockImplementation((async (dir: string) => {
      if (dir === LOCAL_ROOT) return [directoryEntry('broken'), directoryEntry('ok')] as never;
      if (dir === join(LOCAL_ROOT, 'broken')) throw errnoError('EACCES');
      if (dir === join(LOCAL_ROOT, 'ok')) return [fileEntry('local_abc.json')] as never;
      return [] as never;
    }) as unknown as typeof readdir);
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        // discoverClaudeDesktopSessions skips ids without the local_ prefix.
        sessionId: 'local_abc',
        cliSessionId: 'cli-abc',
        cwd: '/repo',
        createdAt: 1,
        lastActivityAt: 2,
      })
    );

    const { discoverClaudeDesktopSessions } = await import('../claude-desktop.discovery.js');
    const sessions = await discoverClaudeDesktopSessions(0);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agentSessionId).toBe('cli-abc');
  });

  it('survives an unreadable sessions root itself', async () => {
    const { readdir } = await import('fs/promises');
    vi.mocked(readdir).mockImplementation((async (dir: string) => {
      if (dir === LOCAL_ROOT || dir === CODE_ROOT) throw errnoError('EACCES');
      return [] as never;
    }) as unknown as typeof readdir);

    const { discoverClaudeDesktopSessions } = await import('../claude-desktop.discovery.js');
    await expect(discoverClaudeDesktopSessions(0)).resolves.toEqual([]);
  });
});
