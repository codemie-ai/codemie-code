import { describe, it, expect, vi, beforeEach } from 'vitest';

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const mkdirMock = vi.fn();
const execMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  mkdir: mkdirMock,
}));

vi.mock('@/utils/exec.js', () => ({
  exec: execMock,
}));

describe('client-version-cache', () => {
  beforeEach(() => {
    vi.resetModules();
    readFileMock.mockReset();
    writeFileMock.mockReset().mockResolvedValue(undefined);
    mkdirMock.mockReset().mockResolvedValue(undefined);
    execMock.mockReset();
    execMock.mockResolvedValue({ code: 0, stdout: '2.1.23 (Claude Code)', stderr: '', signal: null });
  });

  it('cold cache: execs and writes a new cache entry', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'));
    const { resolveClientVersion } = await import('../client-version-cache.js');

    const version = await resolveClientVersion();

    expect(version).toBe('2.1.23');
    expect(execMock).toHaveBeenCalledWith('claude', ['--version']);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it('warm cache within TTL: does not exec', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ version: '2.1.0', resolvedAt: Date.now() }));
    const { resolveClientVersion } = await import('../client-version-cache.js');

    const version = await resolveClientVersion();

    expect(version).toBe('2.1.0');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('stale cache past TTL: re-execs', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    readFileMock.mockResolvedValue(JSON.stringify({ version: '2.0.0', resolvedAt: twoHoursAgo }));
    const { resolveClientVersion } = await import('../client-version-cache.js');

    const version = await resolveClientVersion();

    expect(version).toBe('2.1.23');
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('exec failure: returns empty string and does not write a cache entry', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'));
    execMock.mockRejectedValue(new Error('ENOENT'));
    const { resolveClientVersion } = await import('../client-version-cache.js');

    const version = await resolveClientVersion();

    expect(version).toBe('');
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('corrupt cache file: treated as cold and re-execs', async () => {
    readFileMock.mockResolvedValue('not json');
    const { resolveClientVersion } = await import('../client-version-cache.js');

    const version = await resolveClientVersion();

    expect(version).toBe('2.1.23');
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});
