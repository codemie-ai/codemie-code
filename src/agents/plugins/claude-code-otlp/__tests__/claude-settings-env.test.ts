import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  managedSettingsPaths,
  readClaudeSettingsEnv,
  readManagedDropIns,
  readSettingsLayer,
  settingsLayerPaths,
} from '../event-fields/claude-settings-env.js';

describe('claude settings env layers (CR-006)', () => {
  let root: string;
  const put = (rel: string, body: string) => {
    const file = join(root, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
  };
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    CLAUDE_CONFIG_DIR: join(root, 'user'),
    CLAUDE_PROJECT_DIR: join(root, 'proj'),
    ...extra,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-settings-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('follows CLAUDE_PROJECT_DIR (not a subdirectory cwd) and CLAUDE_CONFIG_DIR, later layers winning', async () => {
    put('user/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'user', A: 'u' } }));
    put('proj/.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'project' } }));
    put('proj/.claude/settings.local.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'local' } }));
    // The decoy layers a cwd/home-keyed lookup would have used.
    put('proj/sub/.claude/settings.local.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'cwd-decoy' } }));

    const r = await readClaudeSettingsEnv(join(root, 'proj', 'sub'), env(), 'linux');

    expect(r.env).toMatchObject({ ANTHROPIC_BASE_URL: 'local', A: 'u' });
    expect(r.complete).toBe(true);
  });

  it('falls back to the hook cwd without CLAUDE_PROJECT_DIR', async () => {
    put('proj/.claude/settings.json', JSON.stringify({ env: { B: '1' } }));
    const r = await readClaudeSettingsEnv(join(root, 'proj'), { CLAUDE_CONFIG_DIR: join(root, 'user') }, 'linux');
    expect(r).toEqual({ env: { B: '1' }, complete: true });
  });

  it('absent files (and no env block) are no override; complete stays true', async () => {
    put('proj/.claude/settings.json', JSON.stringify({ permissions: {} }));
    expect(await readClaudeSettingsEnv(root, env(), 'linux')).toEqual({ env: {}, complete: true });
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['non-object JSON', '[1]'],
    ['non-object env block', JSON.stringify({ env: 'ANTHROPIC_BASE_URL=x' })],
    ['array env block', JSON.stringify({ env: [] })],
  ])('%s is unknown (incomplete), never "no override"', async (_n, body) => {
    put('proj/.claude/settings.local.json', body);
    put('proj/.claude/settings.json', JSON.stringify({ env: { KEEP: 'y' } }));
    const r = await readClaudeSettingsEnv(root, env(), 'linux');
    expect(r.complete).toBe(false);
    expect(r.env).toMatchObject({ KEEP: 'y' });
  });

  it('an unreadable path that is not "missing" (a directory) is incomplete', async () => {
    mkdirSync(join(root, 'proj', '.claude', 'settings.json'), { recursive: true });
    expect((await readClaudeSettingsEnv(root, env(), 'linux')).complete).toBe(false);
  });

  it('uses only the managed settings file of the running platform', () => {
    expect(managedSettingsPaths('linux')).toEqual(['/etc/claude-code/managed-settings.json']);
    expect(managedSettingsPaths('darwin')).toEqual(['/Library/Application Support/ClaudeCode/managed-settings.json']);
    const win = managedSettingsPaths('win32');
    expect(win[0]).toBe('C:/Program Files/ClaudeCode/managed-settings.json');
    expect(settingsLayerPaths('/c', {}, 'linux').slice(-1)).toEqual(managedSettingsPaths('linux'));
    expect(settingsLayerPaths('/c', {}, 'win32').slice(-win.length)).toEqual(win);
  });

  describe('readSettingsLayer', () => {
    it('reports ok with the parsed object', async () => {
      put('a.json', JSON.stringify({ env: { X: '1' } }));
      const r = await readSettingsLayer(join(root, 'a.json'));
      expect(r).toEqual({ path: join(root, 'a.json'), state: 'ok', parsed: { env: { X: '1' } } });
    });

    it('reports absent for a missing file and for a path below a regular file', async () => {
      put('plain', 'x');
      expect((await readSettingsLayer(join(root, 'missing.json'))).state).toBe('absent');
      expect((await readSettingsLayer(join(root, 'plain', 'child.json'))).state).toBe('absent');
    });

    it('reports malformed for invalid JSON, with no parsed value', async () => {
      put('bad.json', '{nope');
      const r = await readSettingsLayer(join(root, 'bad.json'));
      expect(r.state).toBe('malformed');
      expect(r.parsed).toBeUndefined();
    });

    it.each([['an array root', '[1]'], ['a scalar root', '"s"'], ['a null root', 'null']])(
      'reports unreadable for %s',
      async (_n, body) => {
        put('odd.json', body);
        const r = await readSettingsLayer(join(root, 'odd.json'));
        expect(r.state).toBe('unreadable');
        expect(r.parsed).toBeUndefined();
      }
    );

    it('reports unreadable (not absent, not malformed) when the path is a directory', async () => {
      mkdirSync(join(root, 'dir.json'), { recursive: true });
      expect((await readSettingsLayer(join(root, 'dir.json'))).state).toBe('unreadable');
    });
  });

  describe('readManagedDropIns', () => {
    it('reads managed-settings.d/*.json in name order, ignoring other entries', async () => {
      put('managed/managed-settings.d/20-b.json', JSON.stringify({ n: 'b' }));
      put('managed/managed-settings.d/10-a.json', JSON.stringify({ n: 'a' }));
      put('managed/managed-settings.d/30-c.json', '{nope');
      put('managed/managed-settings.d/readme.txt', 'ignored');
      mkdirSync(join(root, 'managed', 'managed-settings.d', 'sub.json'), { recursive: true });

      const results = await readManagedDropIns('linux', [join(root, 'managed', 'managed-settings.d')]);

      expect(results.map((r) => [r.path.split(/[\\/]/).pop(), r.state])).toEqual([
        ['10-a.json', 'ok'],
        ['20-b.json', 'ok'],
        ['30-c.json', 'malformed'],
        ['sub.json', 'unreadable'],
      ]);
      expect(results[0].parsed).toEqual({ n: 'a' });
    });

    it('returns an empty list when the drop-in directory is absent or is not a directory', async () => {
      put('plain', 'x');
      expect(await readManagedDropIns('linux', [join(root, 'nope', 'managed-settings.d')])).toEqual([]);
      expect(await readManagedDropIns('linux', [join(root, 'plain')])).toEqual([]);
    });

    it('defaults to the managed-settings.d directory next to each managed-settings.json of the platform', async () => {
      // Real system locations are not asserted on; the default only needs to be derivable and not throw.
      expect(Array.isArray(await readManagedDropIns('linux'))).toBe(true);
    });
  });

  it('readClaudeSettingsEnv does not fold managed-settings.d drop-ins into its four layers', async () => {
    put('proj/.claude/settings.json', JSON.stringify({ env: { KEEP: 'y' } }));
    const r = await readClaudeSettingsEnv(root, env(), 'linux');
    expect(r).toEqual({ env: { KEEP: 'y' }, complete: true });
  });
});
