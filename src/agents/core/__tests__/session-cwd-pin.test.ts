/**
 * Session-to-directory mapping that lets the proxy daemon resolve project-scoped analytics settings.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('session-cwd-pin', () => {
  let home: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env['CODEMIE_HOME'];
    home = mkdtempSync(join(tmpdir(), 'cwd-pin-'));
    process.env['CODEMIE_HOME'] = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['CODEMIE_HOME'];
    else process.env['CODEMIE_HOME'] = saved;
    rmSync(home, { recursive: true, force: true });
  });

  const load = () => import('../session-cwd-pin.js');
  const pinDir = () => join(home, 'otlp-session-project');

  it('returns nothing for an unknown session or an empty id', async () => {
    const { readSessionCwds } = await load();
    expect(await readSessionCwds('nope')).toEqual([]);
    expect(await readSessionCwds('')).toEqual([]);
  });

  it('records a cwd once and keeps distinct cwds of the same session', async () => {
    const { recordSessionCwd, readSessionCwds } = await load();
    await recordSessionCwd('s1', '/work/a');
    await recordSessionCwd('s1', '/work/a');
    await recordSessionCwd('s1', '/work/b');
    expect(await readSessionCwds('s1')).toEqual(['/work/a', '/work/b']);
    expect(await readSessionCwds('s2')).toEqual([]);
  });

  it('ignores a relative or empty cwd', async () => {
    const { recordSessionCwd, readSessionCwds } = await load();
    await recordSessionCwd('s1', 'relative/dir');
    await recordSessionCwd('s1', '');
    expect(await readSessionCwds('s1')).toEqual([]);
  });

  it('hashes the session id so it cannot escape the pin directory', async () => {
    const { recordSessionCwd } = await load();
    await recordSessionCwd('../../evil', '/work/a');
    expect(readdirSync(pinDir()).every((name) => /^[0-9a-f]{64}\.cwd\.json$/.test(name))).toBe(true);
  });

  it('reads nothing from a corrupt or expired file and never throws', async () => {
    const { readSessionCwds, recordSessionCwd } = await load();
    await recordSessionCwd('s1', '/work/a');
    const [file] = readdirSync(pinDir());
    writeFileSync(join(pinDir(), file), '{not json');
    expect(await readSessionCwds('s1')).toEqual([]);
    writeFileSync(join(pinDir(), file), JSON.stringify({ cwds: ['/work/a'], pinnedAt: Date.now() - 25 * 60 * 60 * 1000 }));
    expect(await readSessionCwds('s1')).toEqual([]);
  });

  it('a write failure is swallowed', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(pinDir(), 'a file where the directory should be');
    const { recordSessionCwd } = await load();
    await expect(recordSessionCwd('s1', '/work/a')).resolves.toBeUndefined();
  });
});
