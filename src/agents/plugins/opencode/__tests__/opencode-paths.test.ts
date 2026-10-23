/** Runtime path resolution stays aligned with the selected binary and child env. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

vi.mock('../../../../utils/logger.js', () => ({ logger: { debug: vi.fn() } }));
vi.mock('../../../../utils/exec.js', () => ({ exec: vi.fn() }));

const { exec } = await import('../../../../utils/exec.js');
const probe = vi.mocked(exec);
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let root: string;

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'opencode-path-context-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_700_000_000_000);
  for (const name of ['OPENCODE_DB', 'OPENCODE_STORAGE_PATH', 'XDG_DATA_HOME', 'CODEMIE_OPENCODE_BIN',
    'OPENCODE_DISABLE_CHANNEL_DB', 'CODEMIE_OPENCODE_RESOLVED_CONFIG_VERSION']) vi.stubEnv(name, undefined);
  probe.mockResolvedValue({ code: 0, stdout: join(root, 'reported.db'), stderr: '' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveOpenCodeDbPath', () => {
  it('honors the selected binary and child environment without changing the parent', async () => {
    vi.stubEnv('XDG_DATA_HOME', join(root, 'parent'));
    const env = { XDG_DATA_HOME: join(root, 'child'), CODEMIE_OPENCODE_BIN: join(root, 'alternate') };
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    expect(await resolveOpenCodeDbPath(undefined, { env })).toBe(join(root, 'reported.db'));
    expect(probe).toHaveBeenCalledWith(env.CODEMIE_OPENCODE_BIN, ['debug', 'paths', 'db'],
      expect.objectContaining({ timeout: 3000, env: expect.objectContaining(env) }));
    expect(process.env.XDG_DATA_HOME).toBe(join(root, 'parent'));
  });

  it('prefers the actual metadata command over a different environment binary', async () => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    const command = join(root, 'built-in');
    await resolveOpenCodeDbPath(undefined, { command, env: { CODEMIE_OPENCODE_BIN: 'other-opencode' } });
    expect(probe.mock.calls[0][0]).toBe(command);
  });

  it('does not inject fallback directories or replace explicitly unset child roots', async () => {
    vi.stubEnv('XDG_DATA_HOME', join(root, 'parent'));
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    await resolveOpenCodeDbPath(join(root, 'legacy'), { env: { XDG_DATA_HOME: undefined } });
    const env = probe.mock.calls[0][2]!.env!;
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(env.OPENCODE_STORAGE_PATH).toBeUndefined();
  });

  it('lets the binary resolve a relative DB under its actual root, not a legacy directory', async () => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    const actual = join(root, 'actual', 'nested', 'sessions');
    probe.mockResolvedValue({ code: 0, stdout: actual, stderr: '' });
    expect(await resolveOpenCodeDbPath(join(root, 'legacy'), { env: { OPENCODE_DB: 'nested/sessions' } })).toBe(actual);
    expect(probe.mock.calls[0][2]!.env!.OPENCODE_DB).toBe('nested/sessions');
  });

  it('returns an absolute override without invoking another binary', async () => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    const db = join(root, 'absolute', '..', 'override');
    expect(await resolveOpenCodeDbPath(undefined, { env: { OPENCODE_DB: db } })).toBe(resolve(db));
    expect(probe).not.toHaveBeenCalled();
  });

  it('preserves :memory: and excludes it from external file analytics', async () => {
    const paths = await import('../opencode.paths.js');
    const context = { env: { OPENCODE_DB: ':memory:' } };
    expect(await paths.resolveOpenCodeDbPath(undefined, context)).toBe(':memory:');
    expect(await paths.getOpenCodeDbPath(context)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('also excludes :memory: reported by the selected binary', async () => {
    probe.mockResolvedValue({ code: 0, stdout: ':memory:', stderr: '' });
    expect(await (await import('../opencode.paths.js')).getOpenCodeDbPath()).toBeNull();
  });

  it.each(['', 'relative.db', `${join('/unexpected', 'a.db')}\n${join('/unexpected', 'b.db')}`])(
    'rejects an invalid path report %j and uses the explicit fallback', async stdout => {
      probe.mockResolvedValue({ code: 0, stdout, stderr: '' });
      const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
      expect(await resolveOpenCodeDbPath(root)).toBe(join(root, 'opencode.db'));
    },
  );

  it('does not trust a valid-looking path from a failed command', async () => {
    probe.mockResolvedValue({ code: 1, stdout: join(root, 'wrong.db'), stderr: 'unsupported' });
    expect(await (await import('../opencode.paths.js')).resolveOpenCodeDbPath(root)).toBe(join(root, 'opencode.db'));
  });

  it('handles a thrown probe and resolves a relative override in the explicit fallback root', async () => {
    probe.mockRejectedValue(new Error('timeout'));
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    expect(await resolveOpenCodeDbPath(root, { env: { OPENCODE_DB: 'nested/data' } }))
      .toBe(join(root, 'nested', 'data'));
  });

  it('never probes an unrelated opencode when no metadata binary is configured', async () => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    expect(await resolveOpenCodeDbPath(root, { command: null })).toBe(join(root, 'opencode.db'));
    expect(probe).not.toHaveBeenCalled();
  });

  it('quotes Windows executable paths consistently with the launcher', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    const command = join(root, 'Program Files (Org)', 'opencode.cmd');
    await resolveOpenCodeDbPath(root, { command });
    expect(probe).toHaveBeenCalledWith(`"${command}"`, ['debug', 'paths', 'db'],
      expect.objectContaining({ shell: true }));
  });

  it('caches a successful report for five minutes, then picks up a new channel path', async () => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    await resolveOpenCodeDbPath(root);
    probe.mockResolvedValue({ code: 0, stdout: join(root, 'new-channel.db'), stderr: '' });
    vi.setSystemTime(1_700_000_000_000 + 299_999);
    expect(await resolveOpenCodeDbPath(root)).toBe(join(root, 'reported.db'));
    expect(probe).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_700_000_000_000 + 300_001);
    expect(await resolveOpenCodeDbPath(root)).toBe(join(root, 'new-channel.db'));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('retries a failed report after thirty seconds rather than pinning the fallback', async () => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    probe.mockRejectedValueOnce(new Error('temporarily unavailable'));
    expect(await resolveOpenCodeDbPath(root)).toBe(join(root, 'opencode.db'));
    vi.setSystemTime(1_700_000_000_000 + 29_999);
    expect(await resolveOpenCodeDbPath(root)).toBe(join(root, 'opencode.db'));
    expect(probe).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_700_000_000_000 + 30_001);
    expect(await resolveOpenCodeDbPath(root)).toBe(join(root, 'reported.db'));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each(['PATH', 'Path', 'HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'OPENCODE_STORAGE_PATH',
    'OPENCODE_DB', 'OPENCODE_DISABLE_CHANNEL_DB'])('does not reuse a report after %s changes', async key => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    await resolveOpenCodeDbPath(root, { env: { [key]: 'first' } });
    probe.mockResolvedValue({ code: 0, stdout: join(root, 'second.db'), stderr: '' });
    expect(await resolveOpenCodeDbPath(root, { env: { [key]: 'second' } })).toBe(join(root, 'second.db'));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('isolates cached reports by binary and intentional fallback directory', async () => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    await resolveOpenCodeDbPath(root, { command: 'first' });
    await resolveOpenCodeDbPath(root, { command: 'second' });
    await resolveOpenCodeDbPath(join(root, 'other'), { command: 'second' });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('does not include rotating credentials in the path cache identity', async () => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    await resolveOpenCodeDbPath(root, { env: { CODEMIE_JWT_TOKEN: 'fixture-one' } });
    await resolveOpenCodeDbPath(root, { env: { CODEMIE_JWT_TOKEN: 'fixture-two' } });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('bounds cache growth when callers repeatedly change the command', async () => {
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    for (let index = 0; index < 33; index++) await resolveOpenCodeDbPath(root, { command: `binary-${index}` });
    await resolveOpenCodeDbPath(root, { command: 'binary-0' });
    expect(probe).toHaveBeenCalledTimes(34);
  });
});

describe('fallbacks and file-backed discovery', () => {
  it.each(['linux', 'darwin', 'win32'])('uses child environment values for legacy file paths on %s', async value => {
    Object.defineProperty(process, 'platform', { ...platform, value });
    const { getOpenCodeStoragePath } = await import('../opencode.paths.js');
    const env = { HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, 'appdata') };
    const storage = value === 'darwin'
      ? join(root, 'Library', 'Application Support', 'opencode', 'storage')
      : value === 'win32'
        ? join(env.LOCALAPPDATA, 'opencode', 'storage')
        : join(root, '.local', 'share', 'opencode', 'storage');
    mkdirSync(storage, { recursive: true });
    expect(getOpenCodeStoragePath(env)).toBe(storage);
  });

  it('honors a custom legacy storage override instead of ambient defaults', async () => {
    const { getOpenCodeStoragePath } = await import('../opencode.paths.js');
    const custom = join(root, 'custom-storage');
    mkdirSync(custom, { recursive: true });
    expect(getOpenCodeStoragePath({ OPENCODE_STORAGE_PATH: custom })).toBe(custom);
  });

  it('discovers legacy sessions from the child XDG root without an explicit dataDir', async () => {
    const { getOpenCodeStoragePath, getOpenCodeSessionsPath } = await import('../opencode.paths.js');
    const env = { XDG_DATA_HOME: join(root, 'child-xdg') };
    const storage = join(env.XDG_DATA_HOME, 'opencode', 'storage');
    mkdirSync(join(storage, 'session'), { recursive: true });
    expect(getOpenCodeStoragePath(env)).toBe(storage);
    expect(getOpenCodeSessionsPath(env)).toBe(join(storage, 'session'));
  });

  it.each(['darwin', 'win32'])('uses universal XDG defaults for known v2 on %s', async value => {
    Object.defineProperty(process, 'platform', { ...platform, value });
    probe.mockRejectedValue(new Error('unsupported'));
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    expect(await resolveOpenCodeDbPath(undefined, { env: {
      HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, 'appdata'),
      CODEMIE_OPENCODE_RESOLVED_CONFIG_VERSION: 'v2',
    } })).toBe(join(root, '.local', 'share', 'opencode', 'opencode.db'));
  });

  it('preserves legacy macOS defaults for v1 fallback', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    expect(await resolveOpenCodeDbPath(undefined, { command: null, env: { HOME: root } }))
      .toBe(join(root, 'Library', 'Application Support', 'opencode', 'opencode.db'));
  });

  it('uses the child LOCALAPPDATA for a legacy Windows fallback', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const { resolveOpenCodeDbPath } = await import('../opencode.paths.js');
    expect(await resolveOpenCodeDbPath(undefined, { command: null, env: { LOCALAPPDATA: root, USERPROFILE: root } }))
      .toBe(join(root, 'opencode', 'opencode.db'));
  });

  it('returns a custom database without a .db extension only when the file exists', async () => {
    const { getOpenCodeDbPath } = await import('../opencode.paths.js');
    const db = join(root, 'extensionless');
    const context = { env: { OPENCODE_DB: db } };
    expect(await getOpenCodeDbPath(context)).toBeNull();
    writeFileSync(db, 'fixture');
    expect(await getOpenCodeDbPath(context)).toBe(db);
  });

  it('keeps explicit legacy/file data roots separate from ambient storage', async () => {
    const { getOpenCodeSessionsPath, getOpenCodeDataDir } = await import('../opencode.paths.js');
    const dataDir = join(root, 'legacy-root');
    const sessions = join(dataDir, 'storage', 'session');
    mkdirSync(sessions, { recursive: true });
    expect(getOpenCodeSessionsPath({}, dataDir)).toBe(sessions);
    expect(getOpenCodeDataDir({ OPENCODE_STORAGE_PATH: join(dataDir, 'storage') })).toBe(dataDir);
  });

  it('detects a SQLite-only explicit layout without requiring storage directories', async () => {
    const { detectStorageLayout } = await import('../opencode.paths.js');
    const db = join(root, 'layout.db');
    writeFileSync(db, 'fixture');
    expect(await detectStorageLayout(join(dirname(db), 'absent-storage'), { env: { OPENCODE_DB: db } }))
      .toMatchObject({ layout: 'sqlite', dbPath: db });
  });
});
