/**
 * VS Code Claude Code extension connector tests
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { ConfigurationError } from '@/utils/errors.js';
import {
  getVsCodeClaudeCodeSettingsPath,
  moveVsCodeClaudeCodeToNamedKey,
  readVsCodeClaudeCodeGateway,
  removeVsCodeClaudeCodeConfigAtPath,
  writeVsCodeClaudeCodeConfigAtPath,
} from '../vscode-claude-code.js';
import * as vscodeModule from '../vscode.js';

describe('writeVsCodeClaudeCodeConfigAtPath', () => {
  let testDir: string;
  let productDir: string;
  let configPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'codemie-vscode-claude-code-'));
    productDir = join(testDir, 'Code');
    configPath = join(productDir, 'User', 'settings.json');
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
  }

  it('creates settings.json (and the User dir) from scratch when neither exists', async () => {
    const result = await writeVsCodeClaudeCodeConfigAtPath(
      configPath,
      'http://127.0.0.1:4001',
      'gw-key-abc123'
    );

    expect(result).toEqual({ written: true, path: configPath });

    const settings = await readSettings();
    expect(settings['claudeCode.disableLoginPrompt']).toBe(true);
    expect(settings['claudeCode.environmentVariables']).toEqual([
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'gw-key-abc123.vscode-claude-code' },
    ]);
  });

  it('preserves unrelated existing top-level keys and env var entries', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          'editor.fontSize': 14,
          'claudeCode.environmentVariables': [{ name: 'MY_CUSTOM_VAR', value: 'keep-me' }],
        },
        null,
        2
      )
    );

    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key-abc123');

    const settings = await readSettings();
    expect(settings['editor.fontSize']).toBe(14);
    expect(settings['claudeCode.disableLoginPrompt']).toBe(true);
    expect(settings['claudeCode.environmentVariables']).toEqual([
      { name: 'MY_CUSTOM_VAR', value: 'keep-me' },
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'gw-key-abc123.vscode-claude-code' },
    ]);
  });

  it('upserts the managed env vars in place on a second call, without duplicating entries', async () => {
    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key-abc123');
    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:5002', 'gw-key-xyz789');

    const settings = await readSettings();
    const envVars = settings['claudeCode.environmentVariables'] as Array<{
      name: string;
      value: string;
    }>;

    expect(envVars).toHaveLength(2);
    expect(envVars).toEqual([
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:5002' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'gw-key-xyz789.vscode-claude-code' },
    ]);
  });

  it('replaces a malformed (non-array) existing environmentVariables value instead of crashing', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ 'claudeCode.environmentVariables': 'not-an-array' }, null, 2)
    );

    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key-abc123');

    const settings = await readSettings();
    expect(settings['claudeCode.environmentVariables']).toEqual([
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'gw-key-abc123.vscode-claude-code' },
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('drops malformed (non-object) array entries instead of throwing', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          'claudeCode.environmentVariables': [null, { name: 'MY_CUSTOM_VAR', value: 'keep-me' }],
        },
        null,
        2
      )
    );

    await expect(
      writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key-abc123')
    ).resolves.toEqual({ written: true, path: configPath });

    const settings = await readSettings();
    expect(settings['claudeCode.environmentVariables']).toEqual([
      { name: 'MY_CUSTOM_VAR', value: 'keep-me' },
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'gw-key-abc123.vscode-claude-code' },
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('de-duplicates a pre-existing duplicate managed entry instead of leaving a stale copy', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          'claudeCode.environmentVariables': [
            { name: 'ANTHROPIC_BASE_URL', value: 'http://stale-old-value:9999' },
            { name: 'MY_CUSTOM_VAR', value: 'keep-me' },
            { name: 'ANTHROPIC_BASE_URL', value: 'http://stale-duplicate:8888' },
          ],
        },
        null,
        2
      )
    );

    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key-abc123');

    const settings = await readSettings();
    const envVars = settings['claudeCode.environmentVariables'] as Array<{
      name: string;
      value: string;
    }>;
    const baseUrlEntries = envVars.filter(entry => entry.name === 'ANTHROPIC_BASE_URL');

    expect(baseUrlEntries).toEqual([{ name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' }]);
    expect(envVars).toContainEqual({ name: 'MY_CUSTOM_VAR', value: 'keep-me' });
  });

  it('rejects invalid existing JSON with ConfigurationError and leaves the file unchanged', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    const invalidContent = '{ not valid json';
    await writeFile(configPath, invalidContent);

    await expect(
      writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key-abc123')
    ).rejects.toThrow(ConfigurationError);

    const rawAfter = await readFile(configPath, 'utf-8');
    expect(rawAfter).toBe(invalidContent);
  });

  const SETTINGS_WITH_COMMENTS = `{
  // keep this comment
  "editor.fontSize": 14,
  "claudeCode.environmentVariables": [
    { "name": "OTHER", "value": "1" },
  ],
}
`;

  it('writes managed keys into a settings.json with comments and trailing commas', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    await writeFile(configPath, SETTINGS_WITH_COMMENTS);

    const result = await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');
    expect(result).toEqual({ written: true, path: configPath });

    const rawAfter = await readFile(configPath, 'utf-8');
    expect(rawAfter).toContain('// keep this comment');
    expect(rawAfter).toContain('"editor.fontSize": 14');
    expect(rawAfter).toContain('"OTHER"');
    expect(rawAfter).toContain('ANTHROPIC_BASE_URL');
    expect(rawAfter).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  const SETTINGS_WITH_TAB_INDENTATION = '{\n\t"editor.fontSize": 14\n}\n';

  it('inserts new managed keys using the file\'s own indentation, not jsonc-parser\'s unformatted default (CR-006)', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    await writeFile(configPath, SETTINGS_WITH_TAB_INDENTATION);

    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

    const rawAfter = await readFile(configPath, 'utf-8');
    expect(rawAfter).toContain('\n\t"claudeCode.disableLoginPrompt": true');
    expect(rawAfter).not.toMatch(/,"claudeCode\.disableLoginPrompt"/);
  });

  const SETTINGS_WITH_TWO_SPACE_INDENTATION = '{\n  "editor.fontSize": 14\n}\n';

  it('inserts new managed keys on their own indented line for a 2-space-indented file (CR-006)', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    await writeFile(configPath, SETTINGS_WITH_TWO_SPACE_INDENTATION);

    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key');

    const rawAfter = await readFile(configPath, 'utf-8');
    expect(rawAfter).toContain('\n  "claudeCode.disableLoginPrompt": true');
  });

  it('rejects a genuinely unparseable settings.json with a specific reason and leaves it untouched', async () => {
    await mkdir(join(productDir, 'User'), { recursive: true });
    const unbalanced = '{ "claudeCode.disableLoginPrompt": true';
    await writeFile(configPath, unbalanced);

    await expect(
      writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', 'gw-key')
    ).rejects.toThrow(ConfigurationError);

    const rawAfter = await readFile(configPath, 'utf-8');
    expect(rawAfter).toBe(unbalanced);
  });

  it('never logs the raw gateway key value', async () => {
    const gatewayKey = 'super-secret-gateway-key-value-0123456789';
    await writeVsCodeClaudeCodeConfigAtPath(configPath, 'http://127.0.0.1:4001', gatewayKey);

    const allLoggedArgs = [
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
    ].flat();

    for (const arg of allLoggedArgs) {
      const serialized = JSON.stringify(arg);
      expect(serialized ?? '').not.toContain(gatewayKey);
    }
  });
});

describe('getVsCodeClaudeCodeSettingsPath', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'codemie-vscode-claude-code-path-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('throws ConfigurationError when the VS Code product directory does not exist', () => {
    const missingDir = join(testDir, 'does-not-exist');
    vi.spyOn(vscodeModule, 'getVsCodeProductDir').mockReturnValue(missingDir);

    expect(() => getVsCodeClaudeCodeSettingsPath(false)).toThrow(ConfigurationError);
  });

  it('resolves to <productDir>/User/settings.json when the product directory exists', () => {
    vi.spyOn(vscodeModule, 'getVsCodeProductDir').mockReturnValue(testDir);

    expect(getVsCodeClaudeCodeSettingsPath(false)).toBe(join(testDir, 'User', 'settings.json'));
  });
});

describe('readVsCodeClaudeCodeGateway', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codemie-vscode-claude-code-reader-'));
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME']) vi.stubEnv(name, home);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function settingsPath(insiders = false): string {
    return join(vscodeModule.getVsCodeProductDir(insiders), 'User', 'settings.json');
  }

  async function writeRaw(text: string, insiders = false): Promise<void> {
    await mkdir(join(vscodeModule.getVsCodeProductDir(insiders), 'User'), { recursive: true });
    await writeFile(settingsPath(insiders), text);
  }

  it('reads back the port and the named key its writer wrote, and nothing after the disconnect', async () => {
    await writeVsCodeClaudeCodeConfigAtPath(settingsPath(), 'http://127.0.0.1:52311', 'codemie-proxy');

    expect(await readVsCodeClaudeCodeGateway('codemie-proxy')).toEqual({ port: 52311, key: 'vscode-claude-code' });

    await removeVsCodeClaudeCodeConfigAtPath(settingsPath());
    expect(await readVsCodeClaudeCodeGateway('codemie-proxy')).toBeNull();
    expect(await readFile(settingsPath(), 'utf-8')).not.toContain('codemie-proxy');
  });

  it('writes the custom key of a restarted daemon with the name appended, and one key on a second connect', async () => {
    await writeVsCodeClaudeCodeConfigAtPath(settingsPath(), 'http://127.0.0.1:4001', 'k');
    await writeVsCodeClaudeCodeConfigAtPath(settingsPath(), 'http://127.0.0.1:4001', 'k');

    const settings = JSON.parse(await readFile(settingsPath(), 'utf-8')) as Record<string, unknown>;
    expect(settings['claudeCode.environmentVariables']).toEqual([
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'k.vscode-claude-code' },
    ]);
  });

  it('rewrites a config holding the shared key to the named one', async () => {
    await writeRaw(JSON.stringify({ 'claudeCode.environmentVariables': [
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'codemie-proxy' },
    ] }));
    expect(await readVsCodeClaudeCodeGateway('codemie-proxy')).toEqual({ port: 4001, key: 'shared' });

    await writeVsCodeClaudeCodeConfigAtPath(settingsPath(), 'http://127.0.0.1:4001', 'codemie-proxy');

    expect(await readVsCodeClaudeCodeGateway('codemie-proxy')).toEqual({ port: 4001, key: 'vscode-claude-code' });
  });

  it('reads another key as refused', async () => {
    await writeVsCodeClaudeCodeConfigAtPath(settingsPath(), 'http://127.0.0.1:4001', 'other-daemon-key');

    expect(await readVsCodeClaudeCodeGateway('codemie-proxy')).toEqual({ port: 4001, key: 'refused' });
  });

  it('reads settings with comments and trailing commas, the Insiders file on its own', async () => {
    await writeRaw([
      '{',
      '  // set by codemie proxy connect',
      '  "claudeCode.environmentVariables": [',
      '    { "name": "ANTHROPIC_BASE_URL", "value": "http://127.0.0.1:4002" },',
      '    { "name": "ANTHROPIC_AUTH_TOKEN", "value": "codemie-proxy.vscode-claude-code" },',
      '  ],',
      '}',
    ].join('\n'), true);

    expect(await readVsCodeClaudeCodeGateway('codemie-proxy', true)).toEqual({ port: 4002, key: 'vscode-claude-code' });
    expect(await readVsCodeClaudeCodeGateway('codemie-proxy', false)).toBeNull();
  });

  it.each([
    ['a missing product directory', async () => undefined],
    ['an unparsable file', async () => writeRaw('{ "claudeCode.environmentVariables": [')],
    ['a non-loopback URL', async () => writeRaw(JSON.stringify({ 'claudeCode.environmentVariables': [
      { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.com:4001' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: 'codemie-proxy.vscode-claude-code' },
    ] }))],
  ])('returns null for %s', async (_case, arrange) => {
    await arrange();

    await expect(readVsCodeClaudeCodeGateway('codemie-proxy')).resolves.toBeNull();
  });
});


describe('moveVsCodeClaudeCodeToNamedKey', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codemie-vscode-claude-code-move-'));
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME']) vi.stubEnv(name, home);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function settingsPath(insiders = false): string {
    return join(vscodeModule.getVsCodeProductDir(insiders), 'User', 'settings.json');
  }

  /** Settings as an older connect left them, with the user's own comment and entry beside the managed ones. */
  function olderConnectSettings(token: string, port = 4001): string {
    return [
      '{',
      '\t// my editor settings',
      '\t"editor.fontSize": 13,',
      '\t"claudeCode.disableLoginPrompt": true,',
      '\t"claudeCode.environmentVariables": [',
      '\t\t{ "name": "MY_VAR", "value": "mine" },',
      `\t\t{ "name": "ANTHROPIC_BASE_URL", "value": "http://127.0.0.1:${port}" },`,
      `\t\t{ "name": "ANTHROPIC_AUTH_TOKEN", "value": "${token}" },`,
      '\t],',
      '}',
      '',
    ].join('\n');
  }

  async function writeRaw(text: string, insiders = false): Promise<void> {
    await mkdir(join(vscodeModule.getVsCodeProductDir(insiders), 'User'), { recursive: true });
    await writeFile(settingsPath(insiders), text);
  }

  it.each([
    ['the stable settings, the default key', false, 'codemie-proxy'],
    ['the Insiders settings, the default key', true, 'codemie-proxy'],
    ['the stable settings, a daemon with its own key', false, 'k-7f3a'],
  ])('moves %s from the shared key to the named key, and nothing else', async (_case, insiders, key) => {
    await writeRaw(olderConnectSettings(key), insiders);

    expect(await moveVsCodeClaudeCodeToNamedKey(key, 4001, insiders)).toBe('moved');

    expect(await readFile(settingsPath(insiders), 'utf-8')).toBe(olderConnectSettings(`${key}.vscode-claude-code`));
    expect(await readVsCodeClaudeCodeGateway(key, insiders)).toEqual({ port: 4001, key: 'vscode-claude-code' });
  });

  it.each([
    ['the named key', 'codemie-proxy.vscode-claude-code'],
    ['another daemon\'s key', 'other-key'],
  ])('leaves the bytes of settings holding %s', async (_case, token) => {
    await writeRaw(olderConnectSettings(token));

    expect(await moveVsCodeClaudeCodeToNamedKey('codemie-proxy', 4001)).toBe('unchanged');

    expect(await readFile(settingsPath(), 'utf-8')).toBe(olderConnectSettings(token));
  });

  it('leaves the bytes of settings holding the shared key on another loopback port than the daemon\'s', async () => {
    await writeRaw(olderConnectSettings('codemie-proxy', 4002));

    expect(await moveVsCodeClaudeCodeToNamedKey('codemie-proxy', 4001)).toBe('unchanged');

    expect(await readFile(settingsPath(), 'utf-8')).toBe(olderConnectSettings('codemie-proxy', 4002));
  });

  it('writes nothing when there is no settings file', async () => {
    expect(await moveVsCodeClaudeCodeToNamedKey('codemie-proxy', 4001)).toBe('unchanged');
  });

  it('leaves a settings file that is a symbolic link, the link and its target', async () => {
    const target = join(home, 'dotfiles-settings.json');
    await writeFile(target, olderConnectSettings('codemie-proxy'));
    await mkdir(join(vscodeModule.getVsCodeProductDir(false), 'User'), { recursive: true });
    await symlink(target, settingsPath());

    expect(await moveVsCodeClaudeCodeToNamedKey('codemie-proxy', 4001)).toBe('left');

    expect((await lstat(settingsPath())).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe(olderConnectSettings('codemie-proxy'));
  });
});
