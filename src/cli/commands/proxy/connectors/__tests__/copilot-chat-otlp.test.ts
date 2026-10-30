/**
 * Copilot Chat hooks-only connector tests (temp CODEMIE_HOME / VS Code product dir)
 * @group unit
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/utils/logger.js';
import { ConfigurationError } from '@/utils/errors.js';
import { canonicalizePath } from '@/agents/core/project-allowlist.js';
import { getCopilotConnectorsConfigPath } from '@/agents/core/copilot-connector-scope.js';

const mocks = vi.hoisted(() => ({ productDir: '', projectRoot: '', home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home || actual.homedir() };
});

vi.mock('../vscode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vscode.js')>()),
  getVsCodeProductDir: () => mocks.productDir,
}));

vi.mock('@/utils/project-root.js', () => ({
  resolveProjectRoot: () => mocks.projectRoot,
}));

import {
  getCopilotChatHookFilePath,
  getVsCodeChatSettingsPath,
  removeCopilotChatOtlpConfig,
  writeCopilotChatOtlpConfig,
} from '../copilot-chat-otlp.js';

const HOOK_LOCATIONS_KEY = 'chat.hookFilesLocations';

describe('copilot-chat-otlp connector', () => {
  let testDir: string;
  let originalCodemieHome: string | undefined;
  let projectA: string;
  let projectB: string;

  async function readSettingsRaw(): Promise<string> {
    return readFile(getVsCodeChatSettingsPath(), 'utf-8');
  }

  async function writeSettingsRaw(content: string): Promise<void> {
    await mkdir(join(mocks.productDir, 'User'), { recursive: true });
    await writeFile(getVsCodeChatSettingsPath(), content, 'utf-8');
  }

  async function readScopeRecord(): Promise<unknown> {
    const file = JSON.parse(await readFile(getCopilotConnectorsConfigPath(), 'utf-8')) as {
      connectors: Record<string, unknown>;
    };
    return file.connectors['copilot-chat-otlp'];
  }

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'codemie-copilot-chat-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = join(testDir, 'codemie-home');
    mocks.productDir = join(testDir, 'Code');
    projectA = join(testDir, 'project-a');
    projectB = join(testDir, 'project-b');
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    mocks.projectRoot = projectA;
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalCodemieHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = originalCodemieHome;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  describe('user scope', () => {
    it('writes the hook file, registers it in settings and records a user-scope connector', async () => {
      await writeSettingsRaw(JSON.stringify({ 'editor.fontSize': 14 }, null, 2));

      const result = await writeCopilotChatOtlpConfig({ scope: 'user' });

      expect(result.allowlist).toEqual([]);
      expect(result.hookFilePath).toBe(getCopilotChatHookFilePath());
      const hookFile = JSON.parse(await readFile(result.hookFilePath, 'utf-8')) as {
        hooks: Record<string, Array<Record<string, unknown>>>;
      };
      expect(Object.keys(hookFile)).toEqual(['hooks']);
      expect(Object.keys(hookFile.hooks)).toHaveLength(result.hookEvents);
      for (const entries of Object.values(hookFile.hooks)) {
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ type: 'command', command: expect.stringContaining('hook --agent') });
        expect(entries[0]).not.toHaveProperty('hooks');
      }

      const settings = JSON.parse(await readSettingsRaw()) as Record<string, unknown>;
      expect(settings['editor.fontSize']).toBe(14);
      expect(settings[HOOK_LOCATIONS_KEY]).toEqual({ [result.hookFilePath]: true });
      expect(await readScopeRecord()).toEqual({ enabled: true, scope: 'user' });
    });

    it('keys the hook file home-relative (VS Code rejects absolute paths) and drops the legacy absolute key', async () => {
      mocks.home = join(testDir, 'home');
      process.env.CODEMIE_HOME = join(mocks.home, '.codemie');
      try {
        const legacyKey = getCopilotChatHookFilePath();
        await writeSettingsRaw(JSON.stringify({ [HOOK_LOCATIONS_KEY]: { [legacyKey]: true, '/other/hooks.json': true } }));

        await writeCopilotChatOtlpConfig();

        const relativeKey = '/.codemie/hooks/copilot-chat-hooks.json';
        const settings = JSON.parse(await readSettingsRaw()) as Record<string, unknown>;
        expect(settings[HOOK_LOCATIONS_KEY]).toEqual({ '/other/hooks.json': true, [relativeKey]: true });

        const result = await removeCopilotChatOtlpConfig();
        expect(result.mode).toBe('full');
        const after = JSON.parse(await readSettingsRaw()) as Record<string, unknown>;
        expect(after[HOOK_LOCATIONS_KEY]).toEqual({ '/other/hooks.json': true });
      } finally {
        mocks.home = '';
      }
    });

    it('creates settings.json when none exists', async () => {
      const result = await writeCopilotChatOtlpConfig();

      const settings = JSON.parse(await readSettingsRaw()) as Record<string, unknown>;
      expect(settings[HOOK_LOCATIONS_KEY]).toEqual({ [result.hookFilePath]: true });
    });

    it('preserves other hook file locations and does not duplicate its own on reconnect', async () => {
      await writeSettingsRaw(JSON.stringify({ [HOOK_LOCATIONS_KEY]: { '/other/hooks.json': true } }));

      const { hookFilePath } = await writeCopilotChatOtlpConfig();
      await writeCopilotChatOtlpConfig();

      const settings = JSON.parse(await readSettingsRaw()) as Record<string, unknown>;
      expect(settings[HOOK_LOCATIONS_KEY]).toEqual({ '/other/hooks.json': true, [hookFilePath]: true });
    });

    it('migrates a legacy array value to the object form, keeping other entries', async () => {
      await writeSettingsRaw(JSON.stringify({ [HOOK_LOCATIONS_KEY]: ['/other/hooks.json'] }));

      const { hookFilePath } = await writeCopilotChatOtlpConfig();

      const settings = JSON.parse(await readSettingsRaw()) as Record<string, unknown>;
      expect(settings[HOOK_LOCATIONS_KEY]).toEqual({ '/other/hooks.json': true, [hookFilePath]: true });
    });

    it('full disconnect removes only its own location, the hook file and disables the connector', async () => {
      await writeSettingsRaw(JSON.stringify({ [HOOK_LOCATIONS_KEY]: { '/other/hooks.json': true } }));
      const { hookFilePath } = await writeCopilotChatOtlpConfig();

      const result = await removeCopilotChatOtlpConfig();

      expect(result).toMatchObject({ removed: true, mode: 'full' });
      expect(existsSync(hookFilePath)).toBe(false);
      const settings = JSON.parse(await readSettingsRaw()) as Record<string, unknown>;
      expect(settings[HOOK_LOCATIONS_KEY]).toEqual({ '/other/hooks.json': true });
      expect(await readScopeRecord()).toEqual({ enabled: false });
    });
  });

  describe('project scope', () => {
    it('tracks each connected project root', async () => {
      const first = await writeCopilotChatOtlpConfig({ scope: 'project' });
      mocks.projectRoot = projectB;
      const second = await writeCopilotChatOtlpConfig({ scope: 'project' });

      expect(first.allowlist).toEqual([await canonicalizePath(projectA)]);
      expect(second.allowlist).toEqual([await canonicalizePath(projectA), await canonicalizePath(projectB)]);
    });

    it('removing one of several projects keeps the hook file and settings untouched', async () => {
      await writeCopilotChatOtlpConfig({ scope: 'project' });
      mocks.projectRoot = projectB;
      const { hookFilePath } = await writeCopilotChatOtlpConfig({ scope: 'project' });
      const settingsBefore = await readSettingsRaw();

      const result = await removeCopilotChatOtlpConfig({ scope: 'project' });

      expect(result).toMatchObject({ removed: true, mode: 'entry-removed' });
      expect(result.allowlist).toEqual([await canonicalizePath(projectA)]);
      expect(existsSync(hookFilePath)).toBe(true);
      expect(await readSettingsRaw()).toBe(settingsBefore);
    });

    it('removing the last tracked project performs a full removal', async () => {
      const { hookFilePath } = await writeCopilotChatOtlpConfig({ scope: 'project' });

      const result = await removeCopilotChatOtlpConfig({ scope: 'project' });

      expect(result).toMatchObject({ removed: true, mode: 'full' });
      expect(existsSync(hookFilePath)).toBe(false);
      const settings = JSON.parse(await readSettingsRaw()) as Record<string, unknown>;
      expect(settings[HOOK_LOCATIONS_KEY]).toBeUndefined();
      expect(await readScopeRecord()).toEqual({ enabled: false });
    });

    it('is a no-op when the current project is not tracked', async () => {
      await writeCopilotChatOtlpConfig({ scope: 'project' });
      mocks.projectRoot = projectB;

      const result = await removeCopilotChatOtlpConfig({ scope: 'project' });

      expect(result).toMatchObject({ removed: false, mode: 'noop', reason: 'current project is not tracked' });
    });

    it('is a no-op when the connector is user-scoped', async () => {
      await writeCopilotChatOtlpConfig({ scope: 'user' });

      const result = await removeCopilotChatOtlpConfig({ scope: 'project' });

      expect(result).toMatchObject({ removed: false, mode: 'noop' });
    });
  });

  describe('refuses to change settings it cannot safely edit', () => {
    it('leaves settings byte-identical and writes nothing when chat.useHooks is false', async () => {
      const original = '{\n\t// keep my comment\n\t"chat.useHooks": false,\n}\n';
      await writeSettingsRaw(original);

      await expect(writeCopilotChatOtlpConfig()).rejects.toBeInstanceOf(ConfigurationError);

      expect(await readSettingsRaw()).toBe(original);
      expect(existsSync(getCopilotChatHookFilePath())).toBe(false);
      expect(existsSync(getCopilotConnectorsConfigPath())).toBe(false);
    });

    it('rejects a non-object chat.hookFilesLocations on connect without changing it', async () => {
      const original = JSON.stringify({ [HOOK_LOCATIONS_KEY]: '/some/dir' }, null, 2);
      await writeSettingsRaw(original);

      await expect(writeCopilotChatOtlpConfig()).rejects.toThrow(/not an object/);

      expect(await readSettingsRaw()).toBe(original);
      expect(existsSync(getCopilotChatHookFilePath())).toBe(false);
    });

    it('rejects a non-object chat.hookFilesLocations on disconnect without changing it', async () => {
      const original = JSON.stringify({ [HOOK_LOCATIONS_KEY]: '/some/dir' }, null, 2);
      await writeSettingsRaw(original);

      await expect(removeCopilotChatOtlpConfig()).rejects.toBeInstanceOf(ConfigurationError);

      expect(await readSettingsRaw()).toBe(original);
    });

    it('rejects unparsable settings without changing them', async () => {
      const original = '{ "editor.fontSize": ';
      await writeSettingsRaw(original);

      await expect(writeCopilotChatOtlpConfig()).rejects.toBeInstanceOf(ConfigurationError);

      expect(await readSettingsRaw()).toBe(original);
    });
  });

  it('disconnect with no settings file is a noop and disables the connector', async () => {
    const result = await removeCopilotChatOtlpConfig();

    expect(result).toMatchObject({ removed: false, mode: 'noop' });
    expect(await readScopeRecord()).toEqual({ enabled: false });
  });
});
