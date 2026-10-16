/** Manual metrics uses exact source IDs for SQLite and preserves legacy fallback. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  storage: vi.fn(), db: vi.fn(), sessions: vi.fn(), discover: vi.fn(), parse: vi.fn(),
  process: vi.fn(), exists: vi.fn(), readdir: vi.fn(),
}));
vi.mock('@/utils/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../../agents/plugins/opencode/opencode.paths.js', () => ({
  getOpenCodeStoragePath: mocks.storage, getOpenCodeDbPath: mocks.db,
}));
vi.mock('../../../agents/plugins/opencode/opencode.sqlite-reader.js', () => ({ readSessionsFromDb: mocks.sessions }));
vi.mock('../../../agents/plugins/opencode/opencode.plugin.js', () => ({ OpenCodePluginMetadata: { name: 'opencode' } }));
vi.mock('../../../agents/plugins/opencode/opencode.session.js', () => ({
  OpenCodeSessionAdapter: class {
    discoverSessions = mocks.discover;
    parseSessionFile = mocks.parse;
  },
}));
vi.mock('../../../agents/plugins/opencode/session/processors/opencode.metrics-processor.js', () => ({
  OpenCodeMetricsProcessor: class { process = mocks.process; },
}));
vi.mock('fs', () => ({
  existsSync: mocks.exists, readdirSync: mocks.readdir, statSync: () => ({ isDirectory: () => true }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.storage.mockReturnValue(null);
  mocks.db.mockResolvedValue('/fixture/sessions.db');
  mocks.sessions.mockResolvedValue([{ id: 'ses_selected' }]);
  mocks.discover.mockResolvedValue([]);
  mocks.parse.mockResolvedValue({ sessionId: 'ses_selected', messages: [], metadata: {} });
  mocks.process.mockResolvedValue({ success: true, metadata: { deltasWritten: 2 } });
  mocks.exists.mockReturnValue(true);
  mocks.readdir.mockReturnValue(['project']);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
});
afterEach(() => { vi.restoreAllMocks(); });

async function run(args: string[]): Promise<void> {
  const { createOpencodeMetricsCommand } = await import('../opencode-metrics.js');
  await createOpencodeMetricsCommand().parseAsync(args, { from: 'user' });
}

describe('opencode-metrics', () => {
  it('processes a database-only installation without requiring storage/', async () => {
    await run(['--session', 'ses_selected', '--verbose']);
    expect(mocks.sessions).toHaveBeenCalledWith('/fixture/sessions.db', { sessionId: 'ses_selected' });
    expect(mocks.parse).toHaveBeenCalledWith('/fixture/sessions.db', 'ses_selected', 'ses_selected');
    expect(mocks.process).toHaveBeenCalledOnce();
    expect(mocks.readdir).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('processes each discovery descriptor by its own ID even when every path is the same DB', async () => {
    mocks.discover.mockResolvedValue([
      { sessionId: 'ses_first', filePath: '/fixture/sessions.db' },
      { sessionId: 'ses_second', filePath: '/fixture/sessions.db' },
    ]);
    await run(['--discover']);
    expect(mocks.discover).toHaveBeenCalledWith({ maxAgeDays: 30 });
    expect(mocks.parse.mock.calls).toEqual([
      ['/fixture/sessions.db', 'ses_first', 'ses_first'],
      ['/fixture/sessions.db', 'ses_second', 'ses_second'],
    ]);
  });

  it('falls back to a legacy file only after a successful missing-match DB query', async () => {
    mocks.storage.mockReturnValue('/legacy/storage');
    mocks.sessions.mockResolvedValue([]);
    await run(['--session', 'ses_legacy']);
    expect(mocks.parse).toHaveBeenCalledWith(join('/legacy/storage', 'session', 'project', 'ses_legacy.json'),
      'ses_legacy', 'ses_legacy');
  });

  it('does not substitute a legacy file when reading the database fails', async () => {
    mocks.storage.mockReturnValue('/legacy/storage');
    mocks.sessions.mockRejectedValue(new Error('database failure'));
    await expect(run(['--session', 'ses_selected'])).rejects.toThrow('exit 1');
    expect(mocks.readdir).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('database failure'));
  });

  it('fails a missing exact match instead of parsing some other SQLite session', async () => {
    mocks.sessions.mockResolvedValue([]);
    await expect(run(['--session', 'ses_absent'])).rejects.toThrow('exit 1');
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it('keeps legacy JSON processing when no database exists', async () => {
    mocks.db.mockResolvedValue(null);
    mocks.storage.mockReturnValue('/legacy/storage');
    await run(['--session', 'ses_legacy']);
    expect(mocks.sessions).not.toHaveBeenCalled();
    expect(mocks.parse).toHaveBeenCalledWith(join('/legacy/storage', 'session', 'project', 'ses_legacy.json'),
      'ses_legacy', 'ses_legacy');
  });

  it('fails clearly when neither storage nor a database is available', async () => {
    mocks.db.mockResolvedValue(null);
    await expect(run(['--discover'])).rejects.toThrow('exit 1');
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('OpenCode storage not found'));
  });

  it('accepts extensionless DB descriptors and prints usage when no mode is selected', async () => {
    mocks.db.mockResolvedValue('/fixture/extensionless');
    await run([]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Use --session'));
    expect(mocks.parse).not.toHaveBeenCalled();
  });
});
