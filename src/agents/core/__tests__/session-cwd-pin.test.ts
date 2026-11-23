/**
 * Session-to-directory mapping that lets the proxy daemon resolve project-scoped analytics settings.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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
    expect(readdirSync(pinDir()).every((name) => /^[0-9a-f]{64}\.cwd$/.test(name))).toBe(true);
  });

  const onlyEntryFile = () => {
    const dir = join(pinDir(), readdirSync(pinDir())[0]);
    return join(dir, readdirSync(dir)[0]);
  };

  it('reads nothing from a corrupt file and never throws', async () => {
    const { readSessionCwds, recordSessionCwd } = await load();
    await recordSessionCwd('s1', '/work/a');
    writeFileSync(onlyEntryFile(), '{not json');
    expect(await readSessionCwds('s1')).toEqual([]);
  });

  it('ignores an expired entry and deletes it (and the emptied directory) on read', async () => {
    const { readSessionCwds, recordSessionCwd } = await load();
    await recordSessionCwd('s1', '/work/a');
    writeFileSync(onlyEntryFile(), JSON.stringify({ cwd: '/work/a', pinnedAt: Date.now() - 25 * 60 * 60 * 1000 }));
    expect(await readSessionCwds('s1')).toEqual([]);
    expect(readdirSync(pinDir())).toEqual([]);
  });

  it('leaves the session project pin files untouched', async () => {
    const { recordSessionCwd, readSessionCwds } = await load();
    mkdirSync(pinDir(), { recursive: true });
    const legacy = join(pinDir(), `${'a'.repeat(64)}.json`);
    writeFileSync(legacy, JSON.stringify({ project: 'p', pinnedAt: 1 }));
    await recordSessionCwd('s1', '/work/a');
    await readSessionCwds('s1');
    expect(readFileSync(legacy, 'utf-8')).toContain('"project":"p"');
  });

  it('refreshes an entry older than the refresh threshold, so a long session keeps its mapping past the TTL', async () => {
    const { recordSessionCwd, readSessionCwds } = await load();
    await recordSessionCwd('s1', '/work/a');
    const file = onlyEntryFile();
    const stale = Date.now() - 23 * 60 * 60 * 1000;
    writeFileSync(file, JSON.stringify({ cwd: '/work/a', pinnedAt: stale }));
    await recordSessionCwd('s1', '/work/a');
    expect(JSON.parse(readFileSync(file, 'utf-8')).pinnedAt).toBeGreaterThan(stale + 22 * 60 * 60 * 1000);
    expect(await readSessionCwds('s1')).toEqual(['/work/a']);
  });

  it('does not rewrite a recent entry on every hook', async () => {
    const { recordSessionCwd } = await load();
    await recordSessionCwd('s1', '/work/a');
    const file = onlyEntryFile();
    const recent = Date.now() - 5 * 60 * 1000;
    writeFileSync(file, JSON.stringify({ cwd: '/work/a', pinnedAt: recent }));
    await recordSessionCwd('s1', '/work/a');
    expect(JSON.parse(readFileSync(file, 'utf-8')).pinnedAt).toBe(recent);
  });

  it('keeps every cwd of concurrent first hooks', async () => {
    const { recordSessionCwd, readSessionCwds } = await load();
    const cwds = ['/w/a', '/w/b', '/w/c', '/w/d', '/w/e'];
    await Promise.all(cwds.map((cwd) => recordSessionCwd('s1', cwd)));
    expect((await readSessionCwds('s1')).sort()).toEqual(cwds);
  });

  it('at the cap keeps the recorded cwds, warns once with no path, and flags overflow for protective resolution', async () => {
    const { recordSessionCwd, readSessionCwds, hasSessionCwdOverflow } = await load();
    const { logger } = await import('@/utils/logger.js');
    const first = Array.from({ length: 8 }, (_, i) => `/w/${i}`);
    for (const cwd of first) await recordSessionCwd('s1', cwd);
    expect(await hasSessionCwdOverflow('s1')).toBe(false);
    await recordSessionCwd('s1', '/secret/ninth');
    await recordSessionCwd('s1', '/secret/tenth');
    expect((await readSessionCwds('s1')).sort()).toEqual([...first].sort());
    expect(await hasSessionCwdOverflow('s1')).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('secret');
    expect(await hasSessionCwdOverflow('s2')).toBe(false);
  });

  it('a write failure is swallowed', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(pinDir(), 'a file where the directory should be');
    const { recordSessionCwd } = await load();
    await expect(recordSessionCwd('s1', '/work/a')).resolves.toBeUndefined();
  });
});
