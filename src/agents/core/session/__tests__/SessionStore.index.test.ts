/**
 * SessionStore external-id index tests
 * @group unit
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { basename, join } from 'path';

const SESSIONS_DIR = '/home/test/.codemie/sessions';

vi.mock('../../../../utils/paths.js', () => ({
  getCodemiePath: vi.fn().mockReturnValue('/home/test/.codemie/sessions'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

function sessionFile(sessionId: string, agentName: string, externalSessionId?: string): string {
  return JSON.stringify({
    sessionId,
    agentName,
    ...(externalSessionId ? { runtimeCheckpoint: { externalSessionId } } : {}),
  });
}

describe('SessionStore.indexSessionsByExternalId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps external ids to session ids for the requested agent in a single scan', async () => {
    const { readdir, readFile } = await import('fs/promises');
    const files: Record<string, string> = {
      'a.json': sessionFile('a', 'claude-desktop', 'local_1'),
      'completed_b.json': sessionFile('b', 'claude-desktop', 'local_2'),
      'c.json': sessionFile('c', 'claude', 'local_3'),
      'd.json': sessionFile('d', 'claude-desktop'),
      'notes.txt': 'ignored',
    };
    vi.mocked(readdir).mockResolvedValue(Object.keys(files) as never);
    vi.mocked(readFile).mockImplementation((async (path: string) =>
      files[basename(path)]) as never);

    const { SessionStore } = await import('../SessionStore.js');
    const index = await new SessionStore().indexSessionsByExternalId('claude-desktop');

    expect(index).toEqual(new Map([['local_1', 'a'], ['local_2', 'b']]));
    expect(readdir).toHaveBeenCalledOnce();
    expect(readFile).not.toHaveBeenCalledWith(join(SESSIONS_DIR, 'notes.txt'), 'utf-8');
  });

  it('skips unreadable session files instead of failing the index', async () => {
    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['broken.json', 'ok.json'] as never);
    vi.mocked(readFile).mockImplementation((async (path: string) => {
      if (path.endsWith('broken.json')) return '{not json';
      return sessionFile('ok', 'claude-desktop', 'local_ok');
    }) as never);

    const { SessionStore } = await import('../SessionStore.js');
    const index = await new SessionStore().indexSessionsByExternalId('claude-desktop');

    expect(index).toEqual(new Map([['local_ok', 'ok']]));
  });

  it('returns an empty index when the sessions directory does not exist', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValueOnce(false);

    const { SessionStore } = await import('../SessionStore.js');
    const index = await new SessionStore().indexSessionsByExternalId('claude-desktop');

    expect(index.size).toBe(0);
  });
});
