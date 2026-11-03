import { describe, it, expect, vi, beforeEach } from 'vitest';

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const mkdirMock = vi.fn();
const unlinkMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  mkdir: mkdirMock,
  unlink: unlinkMock,
}));

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('session-project-pin', () => {
  beforeEach(() => {
    vi.resetModules();
    readFileMock.mockReset();
    writeFileMock.mockReset().mockResolvedValue(undefined);
    mkdirMock.mockReset().mockResolvedValue(undefined);
    unlinkMock.mockReset().mockResolvedValue(undefined);
  });

  describe('readPinnedProjectName', () => {
    it('returns undefined for an empty sessionId without touching the filesystem', async () => {
      const { readPinnedProjectName } = await import('../session-project-pin.js');
      expect(await readPinnedProjectName('')).toBeUndefined();
      expect(readFileMock).not.toHaveBeenCalled();
    });

    it('returns the pinned project within TTL', async () => {
      readFileMock.mockResolvedValue(JSON.stringify({ project: 'proj-a', pinnedAt: Date.now() }));
      const { readPinnedProjectName } = await import('../session-project-pin.js');
      expect(await readPinnedProjectName('s1')).toBe('proj-a');
    });

    it('treats a missing pin file as unpinned', async () => {
      readFileMock.mockRejectedValue(new Error('ENOENT'));
      const { readPinnedProjectName } = await import('../session-project-pin.js');
      expect(await readPinnedProjectName('s1')).toBeUndefined();
    });

    it('treats a corrupt pin file as unpinned', async () => {
      readFileMock.mockResolvedValue('not json');
      const { readPinnedProjectName } = await import('../session-project-pin.js');
      expect(await readPinnedProjectName('s1')).toBeUndefined();
    });

    it('expires and deletes a pin past the TTL', async () => {
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      readFileMock.mockResolvedValue(JSON.stringify({ project: 'proj-a', pinnedAt: twoDaysAgo }));
      const { readPinnedProjectName } = await import('../session-project-pin.js');
      expect(await readPinnedProjectName('s1')).toBeUndefined();
      expect(unlinkMock).toHaveBeenCalledTimes(1);
    });

    it('hashes the sessionId into the file path, never embedding it raw', async () => {
      readFileMock.mockRejectedValue(new Error('ENOENT'));
      const { readPinnedProjectName } = await import('../session-project-pin.js');
      await readPinnedProjectName('../../etc/passwd');
      const [calledPath] = readFileMock.mock.calls[0] as [string];
      expect(calledPath).not.toContain('..');
      expect(calledPath).toMatch(/[0-9a-f]{64}\.json$/);
    });
  });

  describe('pinProjectName', () => {
    it('returns the project unchanged for a blank sessionId or project, without touching the filesystem', async () => {
      const { pinProjectName } = await import('../session-project-pin.js');
      expect(await pinProjectName('', 'proj-a')).toBe('proj-a');
      expect(await pinProjectName('s1', '')).toBe('');
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('writes an exclusive pin and returns the pinned project when nothing else got there first', async () => {
      const { pinProjectName } = await import('../session-project-pin.js');
      const result = await pinProjectName('s1', 'proj-a');
      expect(result).toBe('proj-a');
      expect(writeFileMock).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('proj-a'), { flag: 'wx' });
    });

    it("on a lost race (EEXIST), returns the winner's already-pinned project instead of its own", async () => {
      const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      writeFileMock.mockRejectedValue(eexist);
      readFileMock.mockResolvedValue(JSON.stringify({ project: 'winner-project', pinnedAt: Date.now() }));
      const { pinProjectName } = await import('../session-project-pin.js');
      expect(await pinProjectName('s1', 'proj-a')).toBe('winner-project');
    });

    it('falls back to its own value if the write fails for a reason other than EEXIST', async () => {
      writeFileMock.mockRejectedValue(new Error('EACCES'));
      const { pinProjectName } = await import('../session-project-pin.js');
      expect(await pinProjectName('s1', 'proj-a')).toBe('proj-a');
    });
  });
});
