/** Multi-session DB parsing requires an exact source ID, independent of output ID. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeSession } from '../opencode-message-types.js';

const mocks = vi.hoisted(() => ({ db: vi.fn(), sessions: vi.fn(), messages: vi.fn(), parts: vi.fn(), available: vi.fn() }));
vi.mock('../../../../utils/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../opencode.paths.js', () => ({ getOpenCodeDbPath: mocks.db, getOpenCodeSessionsPath: vi.fn(() => null) }));
vi.mock('../opencode.sqlite-reader.js', () => ({
  isSqliteAvailable: mocks.available, readSessionsFromDb: mocks.sessions,
  readMessagesFromDb: mocks.messages, readAllPartsForSessionFromDb: mocks.parts,
}));

const { OpenCodeSessionAdapter } = await import('../opencode.session.js');
const metadata = { name: 'opencode', displayName: 'OpenCode', description: 'test', cliCommand: '/actual/opencode', dataPaths: { home: '.opencode' } };
const rows: OpenCodeSession[] = [{ id: 'ses_requested', directory: '/requested', time: { created: 1 } }];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.mockResolvedValue('/fixture/sessions.db');
  mocks.sessions.mockResolvedValue(rows);
  mocks.messages.mockResolvedValue([]);
  mocks.parts.mockResolvedValue({});
  mocks.available.mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('OpenCodeSessionAdapter source selection', () => {
  it('looks up an old explicit source independently of lifecycle/output identity', async () => {
    const parsed = await new OpenCodeSessionAdapter(metadata).parseSessionFile('/fixture/sessions.db', 'output-uuid', 'ses_requested');
    expect(mocks.sessions).toHaveBeenCalledWith('/fixture/sessions.db', { sessionId: 'ses_requested' });
    expect(mocks.messages).toHaveBeenCalledWith('/fixture/sessions.db', 'ses_requested');
    expect(parsed.sessionId).toBe('output-uuid');
    expect(parsed.metadata).toMatchObject({ openCodeSessionId: 'ses_requested' });
  });

  it('does not fall back to another conversation after a missing explicit source match', async () => {
    mocks.sessions.mockResolvedValue([{ id: 'ses_other', directory: process.cwd(), time: { created: Date.now() } }]);
    await expect(new OpenCodeSessionAdapter(metadata).parseSessionFile('/fixture/sessions.db', 'output-uuid', 'ses_missing'))
      .rejects.toThrow('not found in SQLite');
    expect(mocks.messages).not.toHaveBeenCalled();
  });

  it('never interprets an explicit non-prefixed source as permission to select the newest row', async () => {
    await expect(new OpenCodeSessionAdapter(metadata).parseSessionFile('/fixture/sessions.db', 'output-uuid', 'other-uuid'))
      .rejects.toThrow('not found in SQLite');
    expect(mocks.sessions).toHaveBeenCalledWith('/fixture/sessions.db', { sessionId: 'other-uuid' });
  });

  it('retains age-bounded heuristic lookup only for callers without an explicit source', async () => {
    mocks.sessions.mockResolvedValue([{ id: 'ses_current', directory: process.cwd(), time: { created: Date.now() } }]);
    await new OpenCodeSessionAdapter(metadata).parseSessionFile('/fixture/sessions.db', 'output-uuid');
    expect(mocks.sessions).toHaveBeenCalledWith('/fixture/sessions.db', { maxAgeDays: 1 });
  });

  it('uses the adapter metadata command and child path context during discovery', async () => {
    const env = { XDG_DATA_HOME: '/child-data' };
    const adapter = new OpenCodeSessionAdapter(metadata, { env });
    await adapter.discoverSessions({ cwd: '/requested', maxAgeDays: 30 });
    expect(mocks.db).toHaveBeenCalledWith({ command: metadata.cliCommand, env });
    expect(mocks.sessions).toHaveBeenCalledWith('/fixture/sessions.db', { cwd: '/requested', maxAgeDays: 30, limit: undefined });
  });

  it('routes an extensionless selected database to SQLite rather than JSON', async () => {
    mocks.db.mockResolvedValue('/fixture/extensionless');
    const parsed = await new OpenCodeSessionAdapter(metadata).parseSessionFile('/fixture/extensionless', 'output-uuid', 'ses_requested');
    expect(parsed.metadata).toMatchObject({ storageType: 'sqlite', openCodeSessionId: 'ses_requested' });
  });

  it('passes the per-run environment and explicit file root to legacy fallback discovery', async () => {
    mocks.available.mockResolvedValue(false);
    const { getOpenCodeSessionsPath } = await import('../opencode.paths.js');
    const env = { XDG_DATA_HOME: '/child-data' };
    await new OpenCodeSessionAdapter(metadata, { env, dataDir: '/intentional-root' }).discoverSessions();
    const [receivedEnv, dataDir] = vi.mocked(getOpenCodeSessionsPath).mock.calls[0];
    expect(receivedEnv?.XDG_DATA_HOME).toBe('/child-data');
    expect(dataDir).toBe('/intentional-root');
    expect(mocks.sessions).not.toHaveBeenCalled();
  });
});
