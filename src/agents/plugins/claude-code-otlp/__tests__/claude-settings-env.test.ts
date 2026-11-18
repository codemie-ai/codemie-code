import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedSettingsPaths, readClaudeSettingsEnv, readClaudeSettingsLayers, settingsLayerPaths } from '../event-fields/claude-settings-env.js';

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

  it('readClaudeSettingsLayers reports every layer, lowest to highest, with its path and state', async () => {
    put('user/settings.json', JSON.stringify({ promptCacheTtl: '1h', env: { A: 'u' } }));
    put('proj/.claude/settings.local.json', '{nope');

    const layers = await readClaudeSettingsLayers(root, env(), 'linux');

    expect(layers.map((l) => l.path)).toEqual(settingsLayerPaths(root, env(), 'linux'));
    expect(layers.length).toBeGreaterThanOrEqual(4);
    expect(layers[0]).toEqual({
      path: join(root, 'user', 'settings.json'),
      state: 'ok',
      settings: { promptCacheTtl: '1h', env: { A: 'u' } },
    });
    expect(layers[1]).toEqual({ path: join(root, 'proj', '.claude', 'settings.json'), state: 'absent' });
    expect(layers[2]).toEqual({ path: join(root, 'proj', '.claude', 'settings.local.json'), state: 'unreadable' });
  });

  it('uses only the managed settings file of the running platform', () => {
    expect(managedSettingsPaths('linux')).toEqual(['/etc/claude-code/managed-settings.json']);
    expect(managedSettingsPaths('darwin')).toEqual(['/Library/Application Support/ClaudeCode/managed-settings.json']);
    const win = managedSettingsPaths('win32');
    expect(win[0]).toBe('C:/Program Files/ClaudeCode/managed-settings.json');
    expect(settingsLayerPaths('/c', {}, 'linux').slice(-1)).toEqual(managedSettingsPaths('linux'));
    expect(settingsLayerPaths('/c', {}, 'win32').slice(-win.length)).toEqual(win);
  });
});
