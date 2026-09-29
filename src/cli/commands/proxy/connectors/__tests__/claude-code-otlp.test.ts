import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CODEMIE_COMMAND_MARKER,
  CODEMIE_ENV_KEYS,
  HOOK_EVENTS,
  SETTINGS_BACKUP_SUFFIX,
  writeClaudeCodeOtlpConfig,
} from '../claude-code-otlp.js';
import { readState } from '../../daemon-manager.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { resolveHomeDir } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { ConfigurationError } from '@/utils/errors.js';

vi.mock('../../daemon-manager.js', () => ({
  readState: vi.fn(),
}));

vi.mock('@/utils/project-root.js', () => ({
  resolveProjectRoot: vi.fn(),
}));

vi.mock('@/utils/paths.js', () => ({
  resolveHomeDir: vi.fn(),
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/utils/security.js', () => ({
  // Mirrors real usage: `logger.info(msg, ...sanitizeLogArgs(obj))`
  sanitizeLogArgs: vi.fn((obj: unknown) => [obj]),
}));

const mockState = { url: 'http://127.0.0.1:41999', gatewayKey: 'test-gateway-key-123' };

function buildExpectedEnv(state: { url: string; gatewayKey: string }) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: `${state.url}/v1/analytics/otlp`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${state.gatewayKey}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_LOG_TOOL_DETAILS: '1',
  };
}

function codemieHookGroup() {
  return {
    matcher: '',
    hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` }],
  };
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function readRaw(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

describe('writeClaudeCodeOtlpConfig', () => {
  let projectDir: string;
  let homeDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'codemie-otlp-project-'));
    homeDir = await mkdtemp(join(tmpdir(), 'codemie-otlp-home-'));

    vi.mocked(resolveProjectRoot).mockReturnValue(projectDir);
    vi.mocked(resolveHomeDir).mockReturnValue(homeDir);
    vi.mocked(readState).mockResolvedValue(mockState as any);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  describe('happy paths', () => {
    it('creates settings.json with hooks and env when none exists (default scope = home)', async () => {
      const result = await writeClaudeCodeOtlpConfig();

      const expectedPath = join(homeDir, '.claude', 'settings.json');
      expect(result).toEqual({
        written: true,
        path: expectedPath,
        backupPath: null,
        hookEvents: HOOK_EVENTS.length,
        envVars: CODEMIE_ENV_KEYS.length,
      });

      expect(existsSync(join(homeDir, '.claude'))).toBe(true);
      expect(existsSync(expectedPath)).toBe(true);
      expect(existsSync(expectedPath + SETTINGS_BACKUP_SUFFIX)).toBe(false);

      const settings = await readJson(expectedPath);
      expect(settings.env).toEqual(buildExpectedEnv(mockState));

      for (const event of HOOK_EVENTS) {
        expect(settings.hooks[event]).toEqual([codemieHookGroup()]);
      }
    });

    it('writes to project root when scope is "project"', async () => {
      const result = await writeClaudeCodeOtlpConfig({ scope: 'project' });

      const expectedPath = join(projectDir, '.claude', 'settings.json');
      expect(result.path).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
      expect(existsSync(join(homeDir, '.claude', 'settings.json'))).toBe(false);
    });

    it('writes to home dir when scope is "user"', async () => {
      const result = await writeClaudeCodeOtlpConfig({ scope: 'user' });

      expect(result.path).toBe(join(homeDir, '.claude', 'settings.json'));
    });

    it('preserves foreign settings/hooks and creates a backup on first write', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      const original = {
        theme: 'dark',
        env: { FOO: 'bar' },
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'some-other-tool' }] },
          ],
        },
      };
      await writeFile(settingsPath, JSON.stringify(original, null, 2));

      const result = await writeClaudeCodeOtlpConfig();

      expect(result.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(await readJson(result.backupPath!)).toEqual(original);

      const merged = await readJson(settingsPath);
      expect(merged.theme).toBe('dark');
      expect(merged.env).toEqual(expect.objectContaining({ FOO: 'bar', ...buildExpectedEnv(mockState) }));
      expect(merged.hooks.PreToolUse).toEqual([
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'some-other-tool' }] },
        codemieHookGroup(),
      ]);
      expect(merged.hooks.SessionStart).toEqual([codemieHookGroup()]);
    });

    it('is idempotent for a fresh install: rerunning does not create a backup or duplicate hooks', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');

      const first = await writeClaudeCodeOtlpConfig();
      expect(first.backupPath).toBeNull();

      const afterFirst = await readJson(settingsPath);

      const second = await writeClaudeCodeOtlpConfig();
      const afterSecond = await readJson(settingsPath);

      expect(second.backupPath).toBeNull();
      expect(existsSync(settingsPath + SETTINGS_BACKUP_SUFFIX)).toBe(false);
      expect(afterSecond).toEqual(afterFirst);
      for (const event of HOOK_EVENTS) {
        expect(afterSecond.hooks[event]).toHaveLength(1);
      }
    });

    it('rerunning on a pre-existing foreign file keeps the original backup untouched and avoids duplicate hooks', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      const original = {
        env: { FOO: 'bar' },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'some-other-tool' }] }],
        },
      };
      await writeFile(settingsPath, JSON.stringify(original, null, 2));

      const first = await writeClaudeCodeOtlpConfig();
      expect(first.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);

      const second = await writeClaudeCodeOtlpConfig();
      expect(second.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);

      // Backup must still reflect the ORIGINAL foreign file, not the merged output.
      expect(await readJson(second.backupPath!)).toEqual(original);

      const merged = await readJson(settingsPath);
      expect(merged.hooks.PreToolUse).toEqual([
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'some-other-tool' }] },
        codemieHookGroup(),
      ]);
      for (const event of HOOK_EVENTS) {
        expect(merged.hooks[event]).toHaveLength(event === 'PreToolUse' ? 2 : 1);
      }
    });

    it('overwrites a single conflicting env value when force is true', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://conflicting.example.com' } }, null, 2)
      );

      const result = await writeClaudeCodeOtlpConfig({ force: true });

      expect(result.written).toBe(true);
      const merged = await readJson(settingsPath);
      expect(merged.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`${mockState.url}/v1/analytics/otlp`);
    });

    it('overwrites every conflicting codemie env key when force is true, leaving unrelated env vars alone', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      const conflictingEnv = CODEMIE_ENV_KEYS.reduce<Record<string, string>>((acc, key) => {
        acc[key] = `conflicting-${key}`;
        return acc;
      }, {});
      await writeFile(
        settingsPath,
        JSON.stringify({ env: { ...conflictingEnv, KEEP_ME: 'yes' } }, null, 2)
      );

      const result = await writeClaudeCodeOtlpConfig({ force: true });

      expect(result.written).toBe(true);
      const merged = await readJson(settingsPath);
      expect(merged.env).toEqual({ KEEP_ME: 'yes', ...buildExpectedEnv(mockState) });
    });

    it('does not require force when existing env values already match the desired codemie values', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'otlp' } }, null, 2));

      const result = await writeClaudeCodeOtlpConfig();

      expect(result.written).toBe(true);
    });

    it('treats a malformed (non-array) existing hook event value as empty instead of crashing', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: 'not-an-array' } }, null, 2));

      const result = await writeClaudeCodeOtlpConfig();

      expect(result.written).toBe(true);
      const merged = await readJson(settingsPath);
      expect(merged.hooks.PreToolUse).toEqual([codemieHookGroup()]);
    });

    it('dedups multiple stale codemie-marked hook entries down to exactly one, preserving foreign entries', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      const staleCodemieEntryA = {
        matcher: '',
        hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER} --old-flag` }],
      };
      const staleCodemieEntryB = {
        matcher: 'x',
        hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` }],
      };
      const foreignEntry = { matcher: 'Bash', hooks: [{ type: 'command', command: 'unrelated-tool' }] };

      await writeFile(
        settingsPath,
        JSON.stringify(
          { hooks: { SessionStart: [foreignEntry, staleCodemieEntryA, staleCodemieEntryB] } },
          null,
          2
        )
      );

      await writeClaudeCodeOtlpConfig();

      const merged = await readJson(settingsPath);
      expect(merged.hooks.SessionStart).toEqual([foreignEntry, codemieHookGroup()]);
    });

    it('backs up a pre-existing minimal ("{}") settings file, unlike a genuinely missing file', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      await writeFile(settingsPath, '{}');

      const result = await writeClaudeCodeOtlpConfig();

      expect(result.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);
      expect(await readRaw(result.backupPath!)).toBe('{}');
    });

    it('backs up a pre-existing empty-string settings file', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      await writeFile(settingsPath, '');

      const result = await writeClaudeCodeOtlpConfig();

      expect(result.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);
      expect(await readRaw(result.backupPath!)).toBe('');

      const merged = await readJson(settingsPath);
      expect(merged.env).toEqual(buildExpectedEnv(mockState));
      for (const event of HOOK_EVENTS) {
        expect(merged.hooks[event]).toEqual([codemieHookGroup()]);
      }
    });

    it('logs a sanitized info message describing the write', async () => {
      const result = await writeClaudeCodeOtlpConfig();

      expect(sanitizeLogArgs).toHaveBeenCalledWith(
        expect.objectContaining({
          settingsPath: result.path,
          backupPath: result.backupPath,
          hookEvents: HOOK_EVENTS.length,
          envVars: CODEMIE_ENV_KEYS.length,
        })
      );
      expect(logger.info).toHaveBeenCalledTimes(1);
    });
  });

  describe('error paths (regression guardrails)', () => {
    it('throws ConfigurationError when there is no live proxy daemon, and touches nothing on disk', async () => {
      vi.mocked(readState).mockResolvedValueOnce(null as any);

      await expect(writeClaudeCodeOtlpConfig()).rejects.toThrow(ConfigurationError);
      expect(existsSync(join(homeDir, '.claude'))).toBe(false);
    });

    it('throws ConfigurationError on invalid JSON in the existing settings file and leaves it unchanged', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      const invalidContent = '{ not valid json';
      await writeFile(settingsPath, invalidContent);

      await expect(writeClaudeCodeOtlpConfig()).rejects.toThrow(ConfigurationError);

      expect(await readRaw(settingsPath)).toBe(invalidContent);
      expect(existsSync(settingsPath + SETTINGS_BACKUP_SUFFIX)).toBe(false);
    });

    it('throws ConfigurationError when the existing settings JSON is not an object', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      const arrayContent = '[1, 2, 3]';
      await writeFile(settingsPath, arrayContent);

      await expect(writeClaudeCodeOtlpConfig()).rejects.toThrow(ConfigurationError);

      expect(await readRaw(settingsPath)).toBe(arrayContent);
      expect(existsSync(settingsPath + SETTINGS_BACKUP_SUFFIX)).toBe(false);
    });

    it('throws ConfigurationError on a conflicting env value without force, and does not modify the file or create a backup', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      const original = { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://conflicting.example.com' } };
      const originalRaw = JSON.stringify(original, null, 2);
      await writeFile(settingsPath, originalRaw);

      await expect(writeClaudeCodeOtlpConfig()).rejects.toThrow(ConfigurationError);

      expect(await readRaw(settingsPath)).toBe(originalRaw);
      expect(existsSync(settingsPath + SETTINGS_BACKUP_SUFFIX)).toBe(false);
    });
  });
});
