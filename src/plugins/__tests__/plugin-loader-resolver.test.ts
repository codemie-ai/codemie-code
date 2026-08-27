/**
 * Unit tests for the plugin loader + resolver.
 *
 * Covers src/plugins/core/plugin-loader.ts (loadPlugin) and
 * src/plugins/core/plugin-resolver.ts (resolvePlugins).
 *
 * These pin the CURRENT observed behavior:
 * - a valid plugin dir (with or without a manifest) is loaded into a LoadedPlugin
 * - components (skills/commands) are discovered and namespaced
 * - enabled/disabled/allowlist filtering is by directory basename
 * - resolvePlugins merges cliDirs / project (.codemie/plugins) / user cache
 *   (~/.codemie/plugins/cache) / settings.dirs, with source-priority dedup
 * - malformed / missing plugins are skipped, not thrown
 *
 * All filesystem state lives under a unique temp dir; CODEMIE_HOME is redirected
 * there so the developer's real ~/.codemie is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadPlugin } from '../core/plugin-loader.js';
import { resolvePlugins } from '../core/plugin-resolver.js';

let baseDir: string;
let homeDir: string;
const envSnapshot: Record<string, string | undefined> = {};

function snapshotEnv(...keys: string[]): void {
  for (const k of keys) envSnapshot[k] = process.env[k];
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Create a plugin directory with a .claude-plugin/plugin.json manifest. */
function makePlugin(dir: string, name: string, extra: Record<string, unknown> = {}): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, ...extra })
  );
  return dir;
}

beforeEach(() => {
  snapshotEnv('CODEMIE_HOME');
  baseDir = mkdtempSync(join(tmpdir(), 'plugin-lr-'));
  homeDir = join(baseDir, 'home');
  // Redirect the CodeMie home so getUserPluginDirs() reads our temp cache, not ~/.codemie.
  process.env.CODEMIE_HOME = homeDir;
});

afterEach(() => {
  restoreEnv();
  rmSync(baseDir, { recursive: true, force: true });
});

describe('loadPlugin', () => {
  it('loads a valid plugin dir into a fully-shaped LoadedPlugin', async () => {
    const dir = makePlugin(join(baseDir, 'myplug'), 'my-plugin', {
      version: '1.0.0',
      description: 'x',
    });

    const plugin = await loadPlugin(dir, 'local', true);

    expect(plugin.manifest.name).toBe('my-plugin');
    expect(plugin.manifest.version).toBe('1.0.0');
    expect(plugin.rootDir).toBe(dir);
    expect(plugin.source).toBe('local');
    expect(plugin.enabled).toBe(true);
    // No component dirs present -> empty arrays and null configs.
    expect(plugin.skills).toEqual([]);
    expect(plugin.commands).toEqual([]);
    expect(plugin.agents).toEqual([]);
    expect(plugin.hooks).toBeNull();
    expect(plugin.mcpServers).toBeNull();
  });

  it('defaults enabled to true when omitted', async () => {
    const dir = makePlugin(join(baseDir, 'defplug'), 'def-plugin');
    const plugin = await loadPlugin(dir, 'user');
    expect(plugin.enabled).toBe(true);
    expect(plugin.source).toBe('user');
  });

  it('derives a kebab-case manifest name from the dir when no manifest exists', async () => {
    const dir = join(baseDir, 'Derived_Name');
    mkdirSync(dir, { recursive: true });

    const plugin = await loadPlugin(dir, 'project', false);

    expect(plugin.manifest.name).toBe('derived-name');
    expect(plugin.enabled).toBe(false);
    expect(plugin.source).toBe('project');
  });

  it('throws when the plugin directory does not exist', async () => {
    await expect(loadPlugin(join(baseDir, 'nope'), 'local')).rejects.toThrow(
      /Plugin directory does not exist/
    );
  });

  it('discovers and namespaces skills and commands', async () => {
    const dir = makePlugin(join(baseDir, 'comp'), 'comp-plugin');
    mkdirSync(join(dir, 'skills', 'greeter'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'greeter', 'SKILL.md'),
      '---\nname: greeter\ndescription: hi\n---\nBody here'
    );
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', 'do-thing.md'), 'command body');

    const plugin = await loadPlugin(dir, 'local', true);

    expect(plugin.skills).toHaveLength(1);
    expect(plugin.skills[0].skillName).toBe('greeter');
    expect(plugin.skills[0].namespacedName).toBe('comp-plugin:greeter');
    expect(plugin.skills[0].content).toBe('Body here');

    expect(plugin.commands).toHaveLength(1);
    expect(plugin.commands[0].commandName).toBe('do-thing');
    expect(plugin.commands[0].namespacedName).toBe('comp-plugin:do-thing');
  });

  it('throws on a malformed manifest (invalid JSON)', async () => {
    const dir = join(baseDir, 'badjson');
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{ not json ');

    await expect(loadPlugin(dir, 'local')).rejects.toThrow(/Invalid JSON/);
  });
});

describe('resolvePlugins', () => {
  it('returns an empty array when nothing is configured', async () => {
    // cwd points at an empty temp dir with no .codemie/plugins, and the user cache is absent.
    const result = await resolvePlugins({ cwd: join(baseDir, 'empty-cwd') });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it('loads plugins from cliDirs', async () => {
    const dir = makePlugin(join(baseDir, 'cliplug'), 'cli-plugin');
    const result = await resolvePlugins({ cliDirs: [dir], cwd: join(baseDir, 'empty-cwd') });

    expect(result).toHaveLength(1);
    expect(result[0].manifest.name).toBe('cli-plugin');
    expect(result[0].source).toBe('local');
    expect(result[0].enabled).toBe(true);
  });

  it('marks a plugin disabled by directory basename via settings.disabled', async () => {
    const dir = makePlugin(join(baseDir, 'alpha'), 'alpha-plugin');
    const result = await resolvePlugins({
      cliDirs: [dir],
      cwd: join(baseDir, 'empty-cwd'),
      settings: { disabled: ['alpha'] },
    });

    // The plugin is still returned, but flagged disabled.
    expect(result).toHaveLength(1);
    expect(result[0].manifest.name).toBe('alpha-plugin');
    expect(result[0].enabled).toBe(false);
  });

  it('enables only allowlisted basenames when settings.enabled is present', async () => {
    const a = makePlugin(join(baseDir, 'alpha'), 'alpha-plugin');
    const b = makePlugin(join(baseDir, 'beta'), 'beta-plugin');

    const result = await resolvePlugins({
      cliDirs: [a, b],
      cwd: join(baseDir, 'empty-cwd'),
      settings: { enabled: ['alpha'] },
    });

    const byName = Object.fromEntries(result.map(p => [p.manifest.name, p.enabled]));
    expect(byName['alpha-plugin']).toBe(true);
    expect(byName['beta-plugin']).toBe(false);
  });

  it('disabled takes precedence over enabled allowlist for the same basename', async () => {
    const dir = makePlugin(join(baseDir, 'gamma'), 'gamma-plugin');
    const result = await resolvePlugins({
      cliDirs: [dir],
      cwd: join(baseDir, 'empty-cwd'),
      settings: { enabled: ['gamma'], disabled: ['gamma'] },
    });

    expect(result).toHaveLength(1);
    expect(result[0].enabled).toBe(false);
  });

  it('discovers project plugins from <cwd>/.codemie/plugins', async () => {
    makePlugin(join(baseDir, 'proj', '.codemie', 'plugins', 'shared'), 'proj-plugin');

    const result = await resolvePlugins({ cwd: join(baseDir, 'proj') });

    expect(result).toHaveLength(1);
    expect(result[0].manifest.name).toBe('proj-plugin');
    expect(result[0].source).toBe('project');
  });

  it('discovers user-cache plugins from CODEMIE_HOME/plugins/cache', async () => {
    makePlugin(join(homeDir, 'plugins', 'cache', 'usercache'), 'user-plugin');

    const result = await resolvePlugins({ cwd: join(baseDir, 'empty-cwd') });

    expect(result).toHaveLength(1);
    expect(result[0].manifest.name).toBe('user-plugin');
    expect(result[0].source).toBe('user');
  });

  it('merges all sources: cli, project, user cache, and settings dirs', async () => {
    const cli = makePlugin(join(baseDir, 'clidir'), 'cli-plugin');
    makePlugin(join(baseDir, 'proj', '.codemie', 'plugins', 'p1'), 'project-plugin');
    makePlugin(join(homeDir, 'plugins', 'cache', 'u1'), 'user-plugin');
    const settingsDir = makePlugin(join(baseDir, 'settingsdir'), 'settings-plugin');

    const result = await resolvePlugins({
      cliDirs: [cli],
      cwd: join(baseDir, 'proj'),
      settings: { dirs: [settingsDir] },
    });

    const bySource = Object.fromEntries(result.map(p => [p.manifest.name, p.source]));
    expect(bySource).toEqual({
      'cli-plugin': 'local',
      'project-plugin': 'project',
      'user-plugin': 'user',
      'settings-plugin': 'local',
    });
    expect(result).toHaveLength(4);
  });

  it('dedupes by plugin name with higher-priority source winning', async () => {
    // Same manifest name "dupe" in both a project dir (priority 300) and a settings dir (priority 100).
    makePlugin(join(baseDir, 'proj', '.codemie', 'plugins', 'shared'), 'dupe', {
      version: 'proj',
    });
    const settingsDir = makePlugin(join(baseDir, 'settingsdir'), 'dupe', {
      version: 'settings',
    });

    const result = await resolvePlugins({
      cwd: join(baseDir, 'proj'),
      settings: { dirs: [settingsDir] },
    });

    const dupes = result.filter(p => p.manifest.name === 'dupe');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].source).toBe('project');
    expect(dupes[0].manifest.version).toBe('proj');
  });

  it('cliDirs win over settings dirs for the same plugin name', async () => {
    const cli = makePlugin(join(baseDir, 'clidir'), 'dupe', { version: 'cli' });
    const settingsDir = makePlugin(join(baseDir, 'settingsdir'), 'dupe', {
      version: 'settings',
    });

    const result = await resolvePlugins({
      cliDirs: [cli],
      cwd: join(baseDir, 'empty-cwd'),
      settings: { dirs: [settingsDir] },
    });

    expect(result).toHaveLength(1);
    expect(result[0].manifest.version).toBe('cli');
  });

  it('skips malformed and invalid plugins while loading valid ones', async () => {
    const bad = join(baseDir, 'badplug');
    mkdirSync(join(bad, '.claude-plugin'), { recursive: true });
    writeFileSync(join(bad, '.claude-plugin', 'plugin.json'), '{ not json ');

    // Non-kebab manifest name is rejected by the parser and skipped.
    const invalidName = makePlugin(join(baseDir, 'invname'), 'Invalid_Name');
    const good = makePlugin(join(baseDir, 'goodplug'), 'good-plugin');

    const result = await resolvePlugins({
      cliDirs: [bad, invalidName, good],
      cwd: join(baseDir, 'empty-cwd'),
    });

    expect(result).toHaveLength(1);
    expect(result[0].manifest.name).toBe('good-plugin');
  });

  it('silently skips a non-existent cliDir', async () => {
    const good = makePlugin(join(baseDir, 'goodplug'), 'good-plugin');
    const result = await resolvePlugins({
      cliDirs: [join(baseDir, 'does-not-exist'), good],
      cwd: join(baseDir, 'empty-cwd'),
    });

    expect(result).toHaveLength(1);
    expect(result[0].manifest.name).toBe('good-plugin');
  });
});
