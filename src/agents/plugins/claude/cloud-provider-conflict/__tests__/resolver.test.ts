import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@/utils/logger.js';
import type { CommandRunner } from '@/agents/core/claude-settings.js';
import { BEDROCK } from '../provider.js';
import {
  resolveProviderConflict,
  type ConflictFlow,
  type ConflictPaths,
  type ConflictResolution,
  type ConflictRunners,
} from '../resolver.js';

const SECRET = 'SECRET-VALUE-9f3a';
const BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-5-v1:0';
const ON = { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: SECRET } };

describe('resolveProviderConflict', () => {
  let root: string;
  const abs = (rel: string): string => join(root, rel);
  const put = (rel: string, body: unknown): string => {
    const file = abs(rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  };

  const basePaths = (extra: ConflictPaths = {}): ConflictPaths => ({
    userSettings: abs('user/settings.json'),
    projectSettings: abs('proj/.claude/settings.json'),
    projectLocalSettings: abs('proj/.claude/settings.local.json'),
    managedFiles: [abs('managed/managed-settings.json')],
    managedDropInDirs: [abs('managed/managed-settings.d')],
    ...extra,
  });

  const resolve = (
    flow: ConflictFlow,
    over: { paths?: ConflictPaths; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; runners?: ConflictRunners } = {}
  ): Promise<ConflictResolution> =>
    resolveProviderConflict({
      provider: BEDROCK,
      flow,
      paths: basePaths(over.paths),
      platform: over.platform ?? 'linux',
      env: over.env ?? {},
      cwd: abs('proj'),
      runners: over.runners,
    });

  const layerAt = (r: ConflictResolution, suffix: string) =>
    r.layers.find((l) => l.path.replaceAll('\\', '/').endsWith(suffix));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conflict-resolver-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  describe('verdict per source', () => {
    it('is none when no source exists', async () => {
      const r = await resolve('claude-agent');
      expect(r.verdict).toBe('none');
      expect(r.layers.every((l) => !l.inEffect)).toBe(true);
    });

    it.each([
      ['user', 'user/settings.json', 'user', 'claude-agent'],
      ['project-local', 'proj/.claude/settings.local.json', 'project-local', 'claude-agent'],
      ['project', 'proj/.claude/settings.json', 'project', 'install'],
    ])('detects Bedrock in the %s layer as an editable conflict', async (_n, rel, scope, flow) => {
      put(rel, ON);
      const r = await resolve(flow as ConflictFlow);
      expect(r.verdict).toBe('conflict-editable');
      const layer = r.layers.find((l) => l.path === abs(rel));
      expect(layer).toMatchObject({ scope, editable: true, state: 'ok', inEffect: true, setsFlag: true });
      expect(layer?.keyNames).toEqual(expect.arrayContaining(['env.CLAUDE_CODE_USE_BEDROCK', 'env.AWS_REGION']));
    });

    it('detects a managed settings file and a managed drop-in as a managed (not editable) conflict', async () => {
      put('managed/managed-settings.json', ON);
      let r = await resolve('claude-agent');
      expect(r.verdict).toBe('conflict-managed');
      expect(layerAt(r, 'managed-settings.json')).toMatchObject({ scope: 'managed', editable: false, inEffect: true });

      rmSync(abs('managed/managed-settings.json'));
      put('managed/managed-settings.d/10-a.json', ON);
      r = await resolve('claude-agent');
      expect(r.verdict).toBe('conflict-managed');
      expect(layerAt(r, '10-a.json')).toMatchObject({ scope: 'managed', editable: false, inEffect: true });
    });

    it('derives the drop-in directory beside each managed file when none is given', async () => {
      put('managed/managed-settings.d/10-a.json', ON);
      const r = await resolve('claude-agent', { paths: { managedDropInDirs: undefined } });
      expect(r.verdict).toBe('conflict-managed');
      expect(layerAt(r, '10-a.json')).toMatchObject({ scope: 'managed', editable: false, inEffect: true });
    });

    it('detects a macOS managed plist through the injected runner, only on darwin', async () => {
      const plutil: CommandRunner = async () => ({ code: 0, stdout: JSON.stringify(ON), stderr: '' });
      const runners: ConflictRunners = { plutil, plistExists: () => true };
      const r = await resolve('claude-agent', { platform: 'darwin', runners, paths: { managedPlists: [abs('x.plist')] } });
      expect(r.verdict).toBe('conflict-managed');
      expect(layerAt(r, 'x.plist')).toMatchObject({ scope: 'managed', editable: false, inEffect: true });

      const linux = await resolve('claude-agent', { platform: 'linux', runners, paths: { managedPlists: [abs('x.plist')] } });
      expect(linux.verdict).toBe('none');
    });

    it('reads the per-user plist above the device-level one, both as managed', async () => {
      const userPlist = abs('Managed Preferences/alice/com.anthropic.claudecode.plist');
      const devicePlist = abs('Managed Preferences/com.anthropic.claudecode.plist');
      const plutil: CommandRunner = async (_cmd, args) => ({
        code: 0,
        stdout: JSON.stringify(args[args.length - 1] === userPlist ? ON : { env: { CLAUDE_CODE_USE_BEDROCK: '0' } }),
        stderr: '',
      });
      const paths = { managedPlists: [userPlist, devicePlist] };
      const r = await resolve('claude-agent', { platform: 'darwin', runners: { plutil, plistExists: () => true }, paths });
      expect(r.verdict).toBe('conflict-managed');
      expect(layerAt(r, 'alice/com.anthropic.claudecode.plist')).toMatchObject({ scope: 'managed', editable: false, inEffect: true });
      expect(r.layers.findIndex((l) => l.path === userPlist)).toBeLessThan(r.layers.findIndex((l) => l.path === devicePlist));

      // Only the per-user plist exists: it is still read.
      const onlyUser = await resolve('claude-agent', {
        platform: 'darwin',
        runners: { plutil, plistExists: (file) => file === userPlist },
        paths,
      });
      expect(onlyUser.verdict).toBe('conflict-managed');
    });

    it('detects shell env as a non-file, non-editable layer for claude-agent only', async () => {
      const env = { CLAUDE_CODE_USE_BEDROCK: 'true' };
      const r = await resolve('claude-agent', { env });
      expect(r.verdict).toBe('conflict-editable');
      expect(r.layers.find((l) => l.scope === 'env')).toMatchObject({ editable: false, inEffect: true, keyNames: ['CLAUDE_CODE_USE_BEDROCK'] });
      // An install only warns about the shell variable (the gate does that): it is not in the chain at all.
      const install = await resolve('install', { env });
      expect(install.verdict).toBe('none');
      expect(install.layers.some((l) => l.scope === 'env')).toBe(false);
      expect((await resolve('install', { env: { CLAUDE_CODE_USE_BEDROCK: 'maybe' } })).verdict).toBe('none');
      expect((await resolve('connect-desktop', { env })).verdict).toBe('none');
      expect((await resolve('connect-vscode', { env })).verdict).toBe('none');
    });

    it('detects a Desktop applied config with inferenceProvider bedrock, and gateway/absent as none', async () => {
      const applied = put('desktop/applied.json', { inferenceProvider: 'bedrock', inferenceBedrockRegion: SECRET });
      const r = await resolve('connect-desktop', { paths: { desktopApplied: applied } });
      expect(r.verdict).toBe('conflict-editable');
      expect(layerAt(r, 'applied.json')).toMatchObject({ scope: 'desktop-applied', editable: true, inEffect: true });
      expect(layerAt(r, 'applied.json')?.keyNames).toEqual(expect.arrayContaining(['inferenceProvider', 'inferenceBedrockRegion']));

      put('desktop/applied.json', { inferenceProvider: 'gateway' });
      expect((await resolve('connect-desktop', { paths: { desktopApplied: applied } })).verdict).toBe('none');
      expect((await resolve('connect-desktop', { paths: { desktopApplied: abs('desktop/none.json') } })).verdict).toBe('none');
    });

    it('skips an unparseable Desktop applied file, which the connect writer replaces', async () => {
      const applied = put('desktop/applied.json', '{not json');
      const r = await resolve('connect-desktop', { paths: { desktopApplied: applied } });
      expect(r.verdict).toBe('none');
      expect(r.unknownReason).toBeUndefined();
      expect(layerAt(r, 'applied.json')).toMatchObject({ scope: 'desktop-applied', state: 'malformed', inEffect: false });
    });

    it('treats a Desktop managed settings file turning Bedrock on as a managed conflict', async () => {
      const managed = put('desktop/managed.json', { inferenceProvider: 'bedrock' });
      const r = await resolve('connect-desktop', { paths: { desktopManaged: managed } });
      expect(r.verdict).toBe('conflict-managed');
      expect(layerAt(r, 'managed.json')).toMatchObject({ scope: 'desktop-managed', editable: false, inEffect: true });
      expect((await resolve('connect-desktop', { paths: { desktopManaged: null } })).verdict).toBe('none');
    });

    it('does not read project layers for connect flows', async () => {
      put('proj/.claude/settings.local.json', ON);
      put('proj/.claude/settings.json', ON);
      expect((await resolve('connect-desktop')).verdict).toBe('none');
      expect((await resolve('connect-vscode')).verdict).toBe('none');
      expect((await resolve('connect-desktop')).layers.map((l) => l.scope)).not.toContain('project');
    });

    it('reads user settings and managed sources for the connect flows', async () => {
      put('user/settings.json', ON);
      expect((await resolve('connect-desktop')).verdict).toBe('conflict-editable');
      expect((await resolve('connect-vscode')).verdict).toBe('conflict-editable');
    });

    it('connect-otlp-only reads nothing and returns none', async () => {
      put('user/settings.json', ON);
      const r = await resolve('connect-otlp-only');
      expect(r.verdict).toBe('none');
      expect(r.layers).toEqual([]);
    });
  });

  describe('precedence', () => {
    it('lets the highest layer defining the flag decide: managed off beats a user on', async () => {
      put('managed/managed-settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
      put('user/settings.json', ON);
      expect((await resolve('claude-agent')).verdict).toBe('none');
    });

    it('orders managed > local > project > user > env', async () => {
      put('user/settings.json', ON);
      put('proj/.claude/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: 'false' } });
      expect((await resolve('claude-agent')).verdict).toBe('none');

      put('proj/.claude/settings.local.json', ON);
      const r = await resolve('claude-agent');
      expect(r.verdict).toBe('conflict-editable');
      expect(layerAt(r, 'settings.local.json')?.inEffect).toBe(true);
      expect(layerAt(r, 'user/settings.json')?.inEffect).toBe(false);

      // process env is the lowest layer: a user "off" beats a shell "on"
      rmSync(abs('proj/.claude'), { recursive: true });
      put('user/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
      expect((await resolve('claude-agent', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } })).verdict).toBe('none');
    });

    it('lets a later drop-in override an earlier one, and a drop-in override the base managed file', async () => {
      put('managed/managed-settings.json', ON);
      put('managed/managed-settings.d/10-a.json', ON);
      put('managed/managed-settings.d/20-b.json', { env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
      expect((await resolve('claude-agent')).verdict).toBe('none');
    });

    it('handles the split-layer case: flag in one layer, Bedrock model id in another', async () => {
      put('user/settings.json', { model: BEDROCK_MODEL, availableModels: [BEDROCK_MODEL, 'sonnet'], env: { ANTHROPIC_MODEL: 'sonnet' } });
      put('proj/.claude/settings.local.json', ON);
      const r = await resolve('claude-agent');
      expect(r.verdict).toBe('conflict-editable');
      const local = layerAt(r, 'settings.local.json');
      const user = layerAt(r, 'user/settings.json');
      expect(local).toMatchObject({ setsFlag: true, bedrockModelKeys: [] });
      expect(user).toMatchObject({ setsFlag: false, inEffect: false });
      expect(user?.bedrockModelKeys).toEqual(['model', 'availableModels']);
    });
  });

  describe('absent versus cannot tell', () => {
    it('gives none when there is no plist and no managed files, and starts no command on Windows', async () => {
      const darwin = await resolve('claude-agent', { platform: 'darwin', runners: { plistExists: () => false, plutil: async () => { throw new Error('must not run'); } } });
      expect(darwin.verdict).toBe('none');

      const win = await resolve('claude-agent', { platform: 'win32', runners: { plutil: async () => { throw new Error('must not run'); } } });
      expect(win.verdict).toBe('none');
      expect(win.unknownReason).toBeUndefined();

      expect((await resolve('claude-agent', { platform: 'linux' })).verdict).toBe('none');
    });

    it('gives unknown for an existing plist that cannot be read, but not when a higher layer already decides', async () => {
      const bad: ConflictRunners = { plistExists: () => true, plutil: async () => ({ code: 1, stdout: '', stderr: 'x' }) };
      const r = await resolve('claude-agent', { platform: 'darwin', runners: bad, paths: { managedPlists: [abs('x.plist')] } });
      expect(r.verdict).toBe('unknown');
      expect(r.unknownReason).toContain(abs('x.plist'));
    });

    it.each([
      ['an array root', '[1]'],
      ['a null root', 'null'],
      ['a null env', '{"env": null}'],
      ['a string env', '{"env": "CLAUDE_CODE_USE_BEDROCK=1"}'],
      ['an array env', '{"env": ["CLAUDE_CODE_USE_BEDROCK"]}'],
    ])('skips a settings file with %s as malformed, with a warning, never a stop', async (_n, body) => {
      const file = put('user/settings.json', body);
      const r = await resolve('claude-agent');
      expect(r.verdict).toBe('none');
      expect(r.unknownReason).toBeUndefined();
      expect(layerAt(r, 'user/settings.json')).toMatchObject({ state: 'malformed', inEffect: false, setsFlag: false });
      expect(r.warnings).toEqual([expect.stringContaining(file)]);
    });

    it('still gives unknown for a decisive file that cannot be read at all (a directory)', async () => {
      const dir = abs('user/settings.json');
      mkdirSync(dir, { recursive: true });
      const r = await resolve('claude-agent');
      expect(r.verdict).toBe('unknown');
      expect(r.unknownReason).toContain(dir);
      expect(r.unknownReason).toContain(BEDROCK.flag);
    });

    it('reports a malformed file once when user and project settings are the same file', async () => {
      const file = put('user/settings.json', '{ broken');
      const r = await resolve('claude-agent', { paths: { projectSettings: file } });
      expect(r.warnings).toHaveLength(1);
    });

    it('ignores a malformed layer below a layer that already decides', async () => {
      put('proj/.claude/settings.local.json', ON);
      put('user/settings.json', '[1]');
      expect((await resolve('claude-agent')).verdict).toBe('conflict-editable');
      put('proj/.claude/settings.local.json', { env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
      expect((await resolve('claude-agent')).verdict).toBe('none');
    });

    it('gives unknown for an unknown flag spelling, naming the file and key, never the value', async () => {
      const file = put('user/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: SECRET } });
      const r = await resolve('claude-agent');
      expect(r.verdict).toBe('unknown');
      expect(r.unknownReason).toContain(file);
      expect(r.unknownReason).toContain('CLAUDE_CODE_USE_BEDROCK');
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it('treats a non-scalar flag value as unknown', async () => {
      put('user/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: { a: 1 } } });
      expect((await resolve('claude-agent')).verdict).toBe('unknown');
    });

    it('accepts boolean and number flag values', async () => {
      put('user/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: true } });
      expect((await resolve('claude-agent')).verdict).toBe('conflict-editable');
      put('user/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: 0 } });
      expect((await resolve('claude-agent')).verdict).toBe('none');
    });

    it('skips a malformed Claude Code file with a warning about analytics attribution, and keeps going', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const notice = vi.spyOn(logger, 'notice').mockImplementation(() => undefined);
      const file = put('proj/.claude/settings.local.json', `{ "env": { "CLAUDE_CODE_USE_BEDROCK": "${SECRET}" `);
      put('user/settings.json', ON);
      const r = await resolve('claude-agent');
      expect(r.verdict).toBe('conflict-editable');
      expect(layerAt(r, 'settings.local.json')).toMatchObject({ state: 'malformed', inEffect: false });
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain(file);
      expect(r.warnings[0]).toMatch(/analytics attribution/i);
      // The resolver only returns the warning; the gate shows it, so a re-resolve never repeats it.
      expect(warn).not.toHaveBeenCalled();
      expect(notice).not.toHaveBeenCalled();
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it.skipIf(process.platform === 'win32')('neutralises control characters in the unknown reason and the malformed warning', async () => {
      const evil = put('user/\u001b[31mevil\u0007.json', { env: { CLAUDE_CODE_USE_BEDROCK: 'maybe' } });
      const bad = put('proj/.claude/\u001b[32mbad\u0007.json', '{ broken');
      const r = await resolve('claude-agent', { paths: { userSettings: evil, projectSettings: bad } });
      // eslint-disable-next-line no-control-regex
      const control = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
      expect(r.verdict).toBe('unknown');
      expect(r.unknownReason).not.toMatch(control);
      expect(r.unknownReason).toContain('evil');
      expect(r.warnings.length).toBeGreaterThan(0);
      for (const w of r.warnings) expect(w).not.toMatch(control);
    });

    it('leaks no setting value in layers, unknownReason or warnings', async () => {
      put('user/settings.json', { model: SECRET, env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: BEDROCK_MODEL, AWS_SECRET_ACCESS_KEY: SECRET } });
      put('proj/.claude/settings.json', '{ broken ' + SECRET);
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const r = await resolve('claude-agent');
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(JSON.stringify(r)).not.toContain(BEDROCK_MODEL);
      expect(JSON.stringify(debug.mock.calls)).not.toContain(SECRET);
      expect(debug).toHaveBeenCalled();
    });
  });

  describe('VS Code claudeCode.environmentVariables', () => {
    const entries = (...e: Array<{ name?: unknown; value?: unknown } | unknown>) => ({ 'claudeCode.environmentVariables': e });
    const vs = (rel: string, body: unknown): string => put(rel, body);

    it('reads JSONC (comments, trailing comma) and detects a Bedrock entry as an editable conflict', async () => {
      const file = vs(
        'vscode/settings.json',
        `{
  // a comment
  /* block */
  "editor.fontSize": 12,
  "claudeCode.environmentVariables": [
    { "name": "CLAUDE_CODE_USE_BEDROCK", "value": "1" },
    { "name": "AWS_REGION", "value": "${SECRET}" },
  ],
}`
      );
      const r = await resolve('connect-vscode', { paths: { vscodeSettings: [file] } });
      expect(r.verdict).toBe('conflict-editable');
      expect(r.warnings).toEqual([]);
      const layer = layerAt(r, 'vscode/settings.json');
      expect(layer).toMatchObject({ scope: 'vscode', editable: true, state: 'ok', inEffect: true, setsFlag: true });
      expect(layer?.keyNames).toEqual(expect.arrayContaining(['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION']));
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it('treats a genuine JSONC parse error or a non-object root as unknown naming the file', async () => {
      const bad = vs('vscode/bad.json', '{ "claudeCode.environmentVariables": [ { "name": ');
      let r = await resolve('connect-vscode', { paths: { vscodeSettings: [bad] } });
      expect(r.verdict).toBe('unknown');
      expect(r.unknownReason).toContain(bad);

      const arr = vs('vscode/arr.json', '[1, 2]');
      r = await resolve('connect-vscode', { paths: { vscodeSettings: [arr] } });
      expect(r.verdict).toBe('unknown');
      expect(r.unknownReason).toContain(arr);
    });

    it('treats an empty, absent or key-less file as absent', async () => {
      const empty = vs('vscode/empty.json', '   \n');
      const none = vs('vscode/none.json', { 'editor.fontSize': 12 });
      const r = await resolve('connect-vscode', { paths: { vscodeSettings: [empty, abs('vscode/missing.json'), none] } });
      expect(r.verdict).toBe('none');
    });

    it('does not detect the flag as a top-level object key, and takes the last entry with the name', async () => {
      const objKey = vs('vscode/obj.json', { 'claudeCode.environmentVariables': { CLAUDE_CODE_USE_BEDROCK: '1' } });
      expect((await resolve('connect-vscode', { paths: { vscodeSettings: [objKey] } })).verdict).toBe('none');

      const last = vs('vscode/last.json', entries(
        { name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
        'junk',
        null,
        { name: 'CLAUDE_CODE_USE_BEDROCK', value: '0' }
      ));
      expect((await resolve('connect-vscode', { paths: { vscodeSettings: [last] } })).verdict).toBe('none');
    });

    it('ignores non-object entries and counts a non-array value as no entries', async () => {
      const junk = vs('vscode/junk.json', entries('CLAUDE_CODE_USE_BEDROCK', 1, [1]));
      expect((await resolve('connect-vscode', { paths: { vscodeSettings: [junk] } })).verdict).toBe('none');
      const str = vs('vscode/str.json', { 'claudeCode.environmentVariables': 'CLAUDE_CODE_USE_BEDROCK=1' });
      expect((await resolve('connect-vscode', { paths: { vscodeSettings: [str] } })).verdict).toBe('none');
    });

    it('treats an unknown flag spelling in an entry as unknown', async () => {
      const f = vs('vscode/spell.json', entries({ name: 'CLAUDE_CODE_USE_BEDROCK', value: 'maybe' }));
      const r = await resolve('connect-vscode', { paths: { vscodeSettings: [f] } });
      expect(r.verdict).toBe('unknown');
      expect(r.unknownReason).toContain(f);
    });

    it('resolves the Desktop and VS Code targets of one connect run together, listing both', async () => {
      const applied = put('desktop/applied.json', { inferenceProvider: 'bedrock' });
      const f = vs('vscode/settings.json', entries({ name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' }));
      const r = await resolve('connect-desktop', { paths: { desktopApplied: applied, vscodeSettings: [f] } });
      expect(r.verdict).toBe('conflict-editable');
      expect(layerAt(r, 'applied.json')).toMatchObject({ scope: 'desktop-applied', inEffect: true });
      expect(layerAt(r, 'vscode/settings.json')).toMatchObject({ scope: 'vscode', inEffect: true });

      // Either target alone decides the run: a clean Desktop does not hide a Bedrock VS Code entry.
      put('desktop/applied.json', { inferenceProvider: 'gateway' });
      expect((await resolve('connect-desktop', { paths: { desktopApplied: applied, vscodeSettings: [f] } })).verdict).toBe('conflict-editable');
    });

    it('ranks below every Claude settings layer: a user off overrides a Bedrock entry, and the entry decides otherwise', async () => {
      const f = vs('vscode/settings.json', entries({ name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' }));
      put('user/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
      const off = await resolve('connect-vscode', { paths: { vscodeSettings: [f] } });
      expect(off.verdict).toBe('none');
      expect(layerAt(off, 'vscode/settings.json')?.inEffect).toBe(false);

      rmSync(abs('user/settings.json'));
      put('user/settings.json', { env: { UNRELATED: '1' } });
      expect((await resolve('connect-vscode', { paths: { vscodeSettings: [f] } })).verdict).toBe('conflict-editable');
    });

    it('reads stable and Insiders files, each its own source', async () => {
      const stable = vs('vscode/stable.json', { 'editor.fontSize': 12 });
      const insiders = vs('vscode/insiders.json', entries({ name: 'CLAUDE_CODE_USE_BEDROCK', value: 'true' }));
      const r = await resolve('connect-vscode', { paths: { vscodeSettings: [stable, insiders] } });
      expect(r.verdict).toBe('conflict-editable');
      expect(layerAt(r, 'stable.json')?.inEffect).toBe(false);
      expect(layerAt(r, 'insiders.json')?.inEffect).toBe(true);

      // an "off" in the stable edition does not hide Bedrock in the Insiders edition
      const off = vs('vscode/stable.json', entries({ name: 'CLAUDE_CODE_USE_BEDROCK', value: '0' }));
      expect((await resolve('connect-vscode', { paths: { vscodeSettings: [off, insiders] } })).verdict).toBe('conflict-editable');
    });

    it('lists Bedrock model entries by entry name only', async () => {
      const f = vs('vscode/m.json', entries(
        { name: 'ANTHROPIC_MODEL', value: BEDROCK_MODEL },
        { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: 'sonnet' }
      ));
      const layer = layerAt(await resolve('connect-vscode', { paths: { vscodeSettings: [f] } }), 'm.json');
      expect(layer?.bedrockModelKeys).toEqual(['ANTHROPIC_MODEL']);
      expect(JSON.stringify(layer)).not.toContain(BEDROCK_MODEL);
    });

    it('does not read VS Code settings for claude-agent or install', async () => {
      const f = vs('vscode/settings.json', entries({ name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' }));
      expect((await resolve('claude-agent', { paths: { vscodeSettings: [f] } })).verdict).toBe('none');
    });
  });

  describe('model keys and verdict priority', () => {
    it('reports Bedrock-id model keys by name for env, top-level and list keys, and ignores other values', async () => {
      put('user/settings.json', {
        model: BEDROCK_MODEL,
        availableModels: ['sonnet', 'arn:aws:bedrock:us-east-1:1:inference-profile/x'],
        env: { ANTHROPIC_MODEL: 'anthropic.claude-3-5-sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL: 42 },
      });
      const layer = layerAt(await resolve('claude-agent'), 'user/settings.json');
      expect(layer?.bedrockModelKeys).toEqual(['env.ANTHROPIC_MODEL', 'model', 'availableModels']);
      expect(layer?.keyNames).toEqual(expect.arrayContaining(layer?.bedrockModelKeys ?? []));
    });

    it('lists AWS keys only for a layer that sets the flag on, and no flag that is set off', async () => {
      put('user/settings.json', { env: { AWS_REGION: 'x', CLAUDE_CODE_USE_BEDROCK: '0' } });
      expect(layerAt(await resolve('claude-agent'), 'user/settings.json')?.keyNames).toEqual([]);
    });

    it('does not list an off flag in another layer while Bedrock is on, so the guidance never says to remove it', async () => {
      put('user/settings.json', ON);
      const env = { CLAUDE_CODE_USE_BEDROCK: '0' };
      const agent = await resolve('claude-agent', { env });
      expect(agent.verdict).toBe('conflict-editable');
      expect(agent.layers.find((l) => l.scope === 'env')?.keyNames).toEqual([]);

      const applied = put('desktop/applied.json', { inferenceProvider: 'gateway' });
      const desktop = await resolve('connect-desktop', { paths: { desktopApplied: applied } });
      expect(desktop.verdict).toBe('conflict-editable');
      expect(layerAt(desktop, 'applied.json')).toMatchObject({ flag: 'off', keyNames: [] });

      const vscode = put('vscode/settings.json', {
        'claudeCode.environmentVariables': [{ name: 'CLAUDE_CODE_USE_BEDROCK', value: '0' }],
      });
      const vs = await resolve('connect-vscode', { paths: { vscodeSettings: [vscode] } });
      expect(vs.verdict).toBe('conflict-editable');
      expect(layerAt(vs, 'vscode/settings.json')).toMatchObject({ flag: 'off', keyNames: [] });
    });

    it('ranks managed-on over unknown over editable-on', async () => {
      put('user/settings.json', ON);
      const applied = put('desktop/applied.json', { inferenceProvider: 'bedrock' });
      const managed = put('desktop/managed.json', '{bad');
      let r = await resolve('connect-desktop', { paths: { desktopApplied: applied, desktopManaged: managed } });
      expect(r.verdict).toBe('unknown');

      put('desktop/managed.json', { inferenceProvider: 'bedrock' });
      r = await resolve('connect-desktop', { paths: { desktopApplied: applied, desktopManaged: managed } });
      expect(r.verdict).toBe('conflict-managed');
    });

    it('does not modify any file it reads', async () => {
      const file = put('user/settings.json', ON);
      const before = readFileSync(file, 'utf-8');
      const mtime = statSync(file).mtimeMs;
      await resolve('claude-agent');
      expect(readFileSync(file, 'utf-8')).toBe(before);
      expect(statSync(file).mtimeMs).toBe(mtime);
    });
  });

  describe('layering', () => {
    it('imports nothing from a cli/ path in any module of the family', () => {
      const dir = fileURLToPath(new URL('..', import.meta.url));
      const sources = readdirSync(dir).filter((n) => n.endsWith('.ts'));
      expect(sources.length).toBeGreaterThan(0);
      for (const name of sources) {
        const text = readFileSync(join(dir, name), 'utf-8');
        expect(text, name).not.toMatch(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\/cli\//);
        expect(text, name).not.toMatch(/process\.exit/);
      }
    });
  });
});
