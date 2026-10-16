// src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CODEMIE_COMMAND_MARKER,
  CODEMIE_ENV_KEYS,
  CODEMIE_HOOK_TIMEOUT_SECONDS,
  CODEMIE_POST_COMPACT_HOOK_TIMEOUT_SECONDS,
  HOOK_EVENTS,
  SETTINGS_BACKUP_SUFFIX,
  writeClaudeCodeOtlpConfig,
  removeClaudeCodeOtlpConfig,
} from '../claude-code-otlp.js';
import { readState } from '../../daemon-manager.js';
import { CODEMIE_ANALYTICS_PROJECT_FILTER_ENV } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { resolveHomeDir } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { ConfigurationError } from '@/utils/errors.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // `unlink` wrapped (not replaced) so a test can simulate one EPERM-style
  // failure via mockRejectedValueOnce; vi.spyOn can't do this directly —
  // ESM module namespaces aren't spy-able ("module namespace is not
  // configurable").
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

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

/** `eventName` defaults to '' (never `'PostCompact'`) so every existing single-event call site
 *  keeps getting the standard, synchronous entry unchanged. */
function codemieHookGroup(eventName: string = '') {
  const isPostCompact = eventName === 'PostCompact';
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `codemie ${CODEMIE_COMMAND_MARKER}`,
        timeout: isPostCompact ? CODEMIE_POST_COMPACT_HOOK_TIMEOUT_SECONDS : CODEMIE_HOOK_TIMEOUT_SECONDS,
        ...(isPostCompact ? { async: true } : {}),
      },
    ],
  };
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function readRaw(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

describe('claude-code-otlp connector', () => {
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
    vi.resetAllMocks();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  describe('writeClaudeCodeOtlpConfig', () => {
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
          allowlist: [],
        });

        expect(existsSync(join(homeDir, '.claude'))).toBe(true);
        expect(existsSync(expectedPath)).toBe(true);
        expect(existsSync(expectedPath + SETTINGS_BACKUP_SUFFIX)).toBe(false);

        const settings = await readJson(expectedPath);
        expect(settings.env).toEqual({ ...buildExpectedEnv(mockState), [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: '[]' });

        for (const event of HOOK_EVENTS) {
          expect(settings.hooks[event]).toEqual([codemieHookGroup(event)]);
        }
      });

      it('writes every hook entry without an async field, except PostCompact, so Claude Code runs the rest synchronously', async () => {
        await writeClaudeCodeOtlpConfig();

        const settings = await readJson(join(homeDir, '.claude', 'settings.json'));
        for (const event of HOOK_EVENTS) {
          if (event === 'PostCompact') continue;
          expect(settings.hooks[event][0].hooks[0].async).toBeUndefined();
          expect(settings.hooks[event][0].hooks[0].timeout).toBe(CODEMIE_HOOK_TIMEOUT_SECONDS);
        }
      });

      it('writes PostCompact as async with the longer timeout, so it never blocks Claude Code or the user\'s turn', async () => {
        await writeClaudeCodeOtlpConfig();

        const settings = await readJson(join(homeDir, '.claude', 'settings.json'));
        expect(settings.hooks.PostCompact[0].hooks[0].async).toBe(true);
        expect(settings.hooks.PostCompact[0].hooks[0].timeout).toBe(CODEMIE_POST_COMPACT_HOOK_TIMEOUT_SECONDS);
      });

      it('writes to the user-level settings and tracks the project root when scope is "project"', async () => {
        const result = await writeClaudeCodeOtlpConfig({ scope: 'project' });

        const expectedPath = join(homeDir, '.claude', 'settings.json');
        expect(result.path).toBe(expectedPath);
        expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(false);

        const canonicalRoot = await realpath(projectDir);
        expect(result.allowlist).toEqual([canonicalRoot]);
        expect((await readJson(expectedPath)).env[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]).toBe(JSON.stringify([canonicalRoot]));

        const again = await writeClaudeCodeOtlpConfig({ scope: 'project' });
        expect(again.allowlist).toEqual([canonicalRoot]);
      });

      it('resets the allowlist to [] on a user-scope rerun', async () => {
        await writeClaudeCodeOtlpConfig({ scope: 'project' });
        const result = await writeClaudeCodeOtlpConfig({ scope: 'user' });
        expect(result.allowlist).toEqual([]);
      });

      it('aborts before writing when the existing allowlist is invalid, unless forced', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });
        const original = JSON.stringify({ env: { [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: 'not-json' } });
        await writeFile(settingsPath, original);

        await expect(writeClaudeCodeOtlpConfig()).rejects.toBeInstanceOf(ConfigurationError);
        expect(await readRaw(settingsPath)).toBe(original);

        const forced = await writeClaudeCodeOtlpConfig({ force: true });
        expect(forced.allowlist).toEqual([]);
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

      it('rebuilds a missing backup from stripped content (not a raw copy) when settings are already managed', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        // Already managed (has our hook group + our env keys) AND has foreign content,
        // but no backup file exists yet.
        await writeFile(
          settingsPath,
          JSON.stringify(
            {
              theme: 'dark',
              env: { FOO: 'bar', OTEL_LOGS_EXPORTER: 'otlp' },
              hooks: { PreToolUse: [codemieHookGroup(), { matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] },
            },
            null, 2
          )
        );

        const result = await writeClaudeCodeOtlpConfig();

        expect(result.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);
        const backup = await readJson(result.backupPath!);
        expect(backup.theme).toBe('dark');
        expect(backup.env).toEqual({ FOO: 'bar' }); // codemie env keys stripped, not copied
        expect(backup.hooks.PreToolUse).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }]);
      });

      it('CR-003: a foreign value under a managed env key name (via --force) is preserved verbatim in the backup, not stripped', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        // Foreign, unrelated value that happens to reuse one of our managed
        // env var names — requires --force since it conflicts with what this
        // tool would write. No codemie hook group, no backup file yet.
        const original = { env: { OTEL_LOGS_EXPORTER: 'jaeger' } };
        await writeFile(settingsPath, JSON.stringify(original, null, 2));

        const result = await writeClaudeCodeOtlpConfig({ force: true });

        expect(result.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);
        // A value mismatch must NOT be treated as "already managed" — the
        // foreign value is preserved via a raw copy, not stripped out.
        expect(await readJson(result.backupPath!)).toEqual(original);
      });

      it('CR-001: treats env-only management as already-managed, never raw-copying a live bearer token into the backup', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        // Codemie's own ENDPOINT+HEADERS pair present, hooks already stripped by
        // another process. (HEADERS-without-ENDPOINT deliberately not tested
        // here — codemie's write path never produces that state; see the "own
        // unrelated Bearer-auth collector" test below for that guard.)
        await writeFile(
          settingsPath,
          JSON.stringify(
            {
              theme: 'dark',
              env: {
                FOO: 'bar',
                OTEL_EXPORTER_OTLP_ENDPOINT: `${mockState.url}/v1/analytics/otlp`,
                OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${mockState.gatewayKey}`,
              },
            },
            null, 2
          )
        );

        const result = await writeClaudeCodeOtlpConfig();

        expect(result.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);
        const backup = await readJson(result.backupPath!);
        expect(backup).toEqual({ theme: 'dark', env: { FOO: 'bar' } });
      });

      it('refreshes the backup to reflect the latest pre-connect state on reconnect after a disconnect and manual edit', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ env: { STEP: 'A' } }, null, 2));

        await writeClaudeCodeOtlpConfig();     // connect #1: backup snapshots STEP: A
        await removeClaudeCodeOtlpConfig();    // disconnect: leaves { env: { STEP: 'A' } }, backup removed
        await writeFile(settingsPath, JSON.stringify({ env: { STEP: 'B' } }, null, 2)); // manual edit

        const result = await writeClaudeCodeOtlpConfig(); // connect #2

        expect(result.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);
        expect(await readJson(result.backupPath!)).toEqual({ env: { STEP: 'B' } });
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
        expect(merged.env).toEqual({ KEEP_ME: 'yes', ...buildExpectedEnv(mockState), [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: '[]' });
      });

      it('does not require force when existing env values already match the desired codemie values', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'otlp' } }, null, 2));

        const result = await writeClaudeCodeOtlpConfig();

        expect(result.written).toBe(true);
      });

      it('overwrites a malformed (non-array) existing hooks event value when force is true', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: 'not-an-array' } }, null, 2));

        const result = await writeClaudeCodeOtlpConfig({ force: true });

        expect(result.written).toBe(true);
        const merged = await readJson(settingsPath);
        expect(merged.hooks.PreToolUse).toEqual([codemieHookGroup()]);
      });

      it('dedups multiple stale whole-codemie hook groups down to exactly one, preserving foreign groups', async () => {
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
        expect(merged.env).toEqual({ ...buildExpectedEnv(mockState), [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: '[]' });
        for (const event of HOOK_EVENTS) {
          expect(merged.hooks[event]).toEqual([codemieHookGroup(event)]);
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

    describe('regression: hook groups must never lose foreign commands', () => {
      it('preserves a user command that shares a group with the codemie command (codemie command first)', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        const mixedGroup = {
          matcher: '',
          hooks: [
            { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
            { type: 'command', command: 'echo my-own-hook' },
          ],
        };
        await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [mixedGroup] } }, null, 2));

        await writeClaudeCodeOtlpConfig();

        const merged = await readJson(settingsPath);
        expect(merged.hooks.PreToolUse).toEqual([
          { matcher: '', hooks: [{ type: 'command', command: 'echo my-own-hook' }] },
          codemieHookGroup(),
        ]);
      });

      it('preserves a user command that shares a group with the codemie command (codemie command last)', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        const mixedGroup = {
          matcher: '',
          hooks: [
            { type: 'command', command: 'echo my-own-hook' },
            { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
          ],
        };
        await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [mixedGroup] } }, null, 2));

        await writeClaudeCodeOtlpConfig();

        const merged = await readJson(settingsPath);
        expect(merged.hooks.PreToolUse).toEqual([
          { matcher: '', hooks: [{ type: 'command', command: 'echo my-own-hook' }] },
          codemieHookGroup(),
        ]);
      });

      it('preserves multiple foreign commands in the same group, in their original order', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        const mixedGroup = {
          matcher: '',
          hooks: [
            { type: 'command', command: 'echo first' },
            { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
            { type: 'command', command: 'echo second' },
          ],
        };
        await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [mixedGroup] } }, null, 2));

        await writeClaudeCodeOtlpConfig();

        const merged = await readJson(settingsPath);
        expect(merged.hooks.PreToolUse).toEqual([
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'echo first' },
              { type: 'command', command: 'echo second' },
            ],
          },
          codemieHookGroup(),
        ]);
      });

      it('preserves the original matcher on a mixed group that used a non-empty matcher', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        const mixedGroup = {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
            { type: 'command', command: 'echo bash-only-hook' },
          ],
        };
        await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [mixedGroup] } }, null, 2));

        await writeClaudeCodeOtlpConfig();

        const merged = await readJson(settingsPath);
        expect(merged.hooks.PreToolUse).toEqual([
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash-only-hook' }] },
          codemieHookGroup(),
        ]);
      });

      it('is idempotent for a mixed group across repeated runs (no duplication, foreign command still survives)', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        const mixedGroup = {
          matcher: '',
          hooks: [
            { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
            { type: 'command', command: 'echo my-own-hook' },
          ],
        };
        await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [mixedGroup] } }, null, 2));

        await writeClaudeCodeOtlpConfig();
        await writeClaudeCodeOtlpConfig();

        const merged = await readJson(settingsPath);
        expect(merged.hooks.PreToolUse).toEqual([
          { matcher: '', hooks: [{ type: 'command', command: 'echo my-own-hook' }] },
          codemieHookGroup(),
        ]);
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

    it('throws ConfigurationError when an existing hooks event value is not an array, without force, and leaves the file unchanged', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      const original = { hooks: { PreToolUse: 'not-an-array' } };
      const originalRaw = JSON.stringify(original, null, 2);
      await writeFile(settingsPath, originalRaw);

      await expect(writeClaudeCodeOtlpConfig()).rejects.toThrow(ConfigurationError);

      expect(await readRaw(settingsPath)).toBe(originalRaw);
      expect(existsSync(settingsPath + SETTINGS_BACKUP_SUFFIX)).toBe(false);
    });

    it('throws ConfigurationError for a non-array hooks value even under an event name outside HOOK_EVENTS', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      const original = { hooks: { SomeRetiredEvent: 'not-an-array' } };
      const originalRaw = JSON.stringify(original, null, 2);
      await writeFile(settingsPath, originalRaw);

      await expect(writeClaudeCodeOtlpConfig()).rejects.toThrow(ConfigurationError);
      expect(await readRaw(settingsPath)).toBe(originalRaw);
    });
  });

  describe('removeClaudeCodeOtlpConfig', () => {
    describe('happy paths', () => {
      it('returns removed:false and touches nothing when no settings file exists', async () => {
        const result = await removeClaudeCodeOtlpConfig();

        expect(result).toEqual({ mode: "noop", reason: "no Claude Code settings file found", removed: false, path: null });
        expect(existsSync(join(homeDir, '.claude'))).toBe(false);
      });

      it('resolves the project root when scope is "project"', async () => {
        const result = await removeClaudeCodeOtlpConfig({ scope: 'project' });

        expect(result).toEqual({ mode: "noop", reason: "no Claude Code settings file found", removed: false, path: null });
      });

      it('does not require a live proxy daemon', async () => {
        const result = await removeClaudeCodeOtlpConfig();

        expect(result.removed).toBe(false);
        expect(readState).not.toHaveBeenCalled();
      });

      it('strips codemie env keys and codemie-only hook groups, preserving foreign settings', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        await writeFile(
          settingsPath,
          JSON.stringify(
            {
              theme: 'dark',
              env: { FOO: 'bar', OTEL_LOGS_EXPORTER: 'otlp', CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
              hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` }] }] },
            },
            null,
            2
          )
        );

        const result = await removeClaudeCodeOtlpConfig();

        expect(result).toEqual({ mode: "full", removed: true, path: settingsPath });
        const final = await readJson(settingsPath);
        expect(final.theme).toBe('dark');
        expect(final.env).toEqual({ FOO: 'bar' });
        expect(final.hooks).toBeUndefined();
      });

      it('preserves a malformed (non-array) existing hook event value as-is', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });
        await writeFile(
          settingsPath,
          JSON.stringify({ theme: 'x', hooks: { PreToolUse: 'not-an-array' } }, null, 2)
        );

        await removeClaudeCodeOtlpConfig();

        const final = await readJson(settingsPath);
        expect(final.hooks.PreToolUse).toBe('not-an-array');
      });

      it('deletes the settings file without restoring backup content, and removes the backup, when stripping leaves settings fully empty', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        // A backup exists holding an OLD value the user has since removed — it
        // must never come back, even though it's the only backup available.
        await writeFile(backupPath, JSON.stringify({ env: { STEP: 'B' } }, null, 2));

        // Real codemie-owned values (not a generic placeholder): ownership is
        // now checked by VALUE, so a fake 'whatever' would no longer count as ours.
        const codemieOnlyEnv = buildExpectedEnv(mockState);
        await writeFile(
          settingsPath,
          JSON.stringify(
            {
              env: codemieOnlyEnv,
              hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` }] }] },
            },
            null,
            2
          )
        );

        const result = await removeClaudeCodeOtlpConfig();

        expect(result).toEqual({ mode: 'full', removed: true, path: settingsPath });
        expect(existsSync(settingsPath)).toBe(false);
        expect(existsSync(backupPath)).toBe(false);
      });

      it('deletes the settings file when stripping leaves it fully empty and no backup exists', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        // Real codemie-owned values (not a generic placeholder): ownership is
        // now checked by VALUE, so a fake 'whatever' would no longer count as ours.
        const codemieOnlyEnv = buildExpectedEnv(mockState);
        await writeFile(
          settingsPath,
          JSON.stringify(
            {
              env: codemieOnlyEnv,
              hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` }] }] },
            },
            null,
            2
          )
        );

        const result = await removeClaudeCodeOtlpConfig();

        expect(result).toEqual({ mode: "full", removed: true, path: settingsPath });
        expect(existsSync(settingsPath)).toBe(false);
      });

      it('logs a sanitized info message describing the removal', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });
        await writeFile(
          settingsPath,
          JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [codemieHookGroup()] } }, null, 2)
        );

        await removeClaudeCodeOtlpConfig();

        expect(sanitizeLogArgs).toHaveBeenCalledWith(expect.objectContaining({ settingsPath }));
        expect(logger.info).toHaveBeenCalledTimes(1);
      });
    });

    describe('regression: hook groups must never lose foreign commands', () => {
      it('preserves a user command that shares a group with the codemie command when disconnecting', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        const mixedGroup = {
          matcher: '',
          hooks: [
            { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
            { type: 'command', command: 'echo my-own-hook' },
          ],
        };
        await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [mixedGroup] } }, null, 2));

        const result = await removeClaudeCodeOtlpConfig();

        expect(result.removed).toBe(true);
        const final = await readJson(settingsPath);
        expect(final.hooks.PreToolUse).toEqual([
          { matcher: '', hooks: [{ type: 'command', command: 'echo my-own-hook' }] },
        ]);
      });

      it('preserves multiple foreign commands in the same group when disconnecting', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        const mixedGroup = {
          matcher: '',
          hooks: [
            { type: 'command', command: 'echo first' },
            { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
            { type: 'command', command: 'echo second' },
          ],
        };
        await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [mixedGroup] } }, null, 2));

        await removeClaudeCodeOtlpConfig();

        const final = await readJson(settingsPath);
        expect(final.hooks.PreToolUse).toEqual([
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'echo first' },
              { type: 'command', command: 'echo second' },
            ],
          },
        ]);
      });

      it('removes the backup once disconnect succeeds, even when foreign content remains', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        await writeFile(backupPath, JSON.stringify({}, null, 2));

        const mixedGroup = {
          matcher: '',
          hooks: [
            { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
            { type: 'command', command: 'echo my-own-hook' },
          ],
        };
        await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [mixedGroup] } }, null, 2));

        const result = await removeClaudeCodeOtlpConfig();

        expect(result.removed).toBe(true);
        expect(existsSync(backupPath)).toBe(false);
      });
    });

    describe('regression: EPMCDME-15375 — never restore values the user changed/removed after connect', () => {
      it('never restores a value the user removed after the latest connect', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        await writeFile(settingsPath, JSON.stringify({ env: { STEP: 'A' } }, null, 2));
        await writeClaudeCodeOtlpConfig();                                               // connect #1
        await removeClaudeCodeOtlpConfig();                                              // disconnect: leaves STEP:A, backup gone
        await writeFile(settingsPath, JSON.stringify({ env: { STEP: 'B' } }, null, 2));   // manual edit
        await writeClaudeCodeOtlpConfig();                                               // connect #2: backup now snapshots STEP:B

        // User deletes STEP themselves, leaving only codemie's own keys.
        const beforeFinalDisconnect = await readJson(settingsPath);
        delete beforeFinalDisconnect.env.STEP;
        await writeFile(settingsPath, JSON.stringify(beforeFinalDisconnect, null, 2));

        await removeClaudeCodeOtlpConfig();                                              // final disconnect

        expect(existsSync(settingsPath)).toBe(false); // nothing foreign remained -> deleted, not restored
        expect(existsSync(backupPath)).toBe(false);
      });
    });

    describe('regression: ownership is checked by VALUE, not by key presence', () => {
      it('preserves the user\'s own OTEL setup (endpoint, header with a secret) through force-connect + disconnect, even though CLAUDE_CODE_ENABLE_TELEMETRY coincidentally already equals codemie\'s own value', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        // A real pre-existing telemetry setup pointed at the user's own collector.
        // CLAUDE_CODE_ENABLE_TELEMETRY is '1' here too — a value that happens to be
        // identical to codemie's own fixed value, but for an unrelated reason.
        await writeFile(
          settingsPath,
          JSON.stringify(
            {
              env: {
                CLAUDE_CODE_ENABLE_TELEMETRY: '1',
                OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.corp.example',
                OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=USER-SECRET',
                KEEP: '1',
              },
            },
            null,
            2
          )
        );

        await writeClaudeCodeOtlpConfig({ force: true });
        expect(existsSync(backupPath)).toBe(true);
        const backupAfterConnect = await readJson(backupPath);
        expect(backupAfterConnect.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.corp.example');
        expect(backupAfterConnect.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('x-api-key=USER-SECRET');

        await removeClaudeCodeOtlpConfig();

        const final = await readJson(settingsPath);
        expect(final.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.corp.example');
        expect(final.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('x-api-key=USER-SECRET');
        expect(final.env.KEEP).toBe('1');
        expect(existsSync(backupPath)).toBe(false);
      });

      it('keeps a user edit of a codemie-managed env key made directly in the file after connect (AC3), even with no backup involved', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2));
        await writeClaudeCodeOtlpConfig();

        // User points OTEL_LOGS_EXPORTER at their own collector after connecting.
        const afterConnect = await readJson(settingsPath);
        afterConnect.env.OTEL_LOGS_EXPORTER = 'console';
        await writeFile(settingsPath, JSON.stringify(afterConnect, null, 2));

        await removeClaudeCodeOtlpConfig();

        const final = await readJson(settingsPath);
        expect(final.env.OTEL_LOGS_EXPORTER).toBe('console');
        expect(final.theme).toBe('dark');
      });

      it('does not throw when a codemie-managed env key has been nulled out in the JSON', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2));
        await writeClaudeCodeOtlpConfig();

        const afterConnect = await readJson(settingsPath);
        afterConnect.env.OTEL_EXPORTER_OTLP_ENDPOINT = null;
        afterConnect.env.OTEL_EXPORTER_OTLP_HEADERS = null;
        await writeFile(settingsPath, JSON.stringify(afterConnect, null, 2));

        await expect(removeClaudeCodeOtlpConfig()).resolves.not.toThrow();
      });

      it('(finding #4) does not restore a stale codemie header onto a user\'s own unrelated Bearer-auth collector set up after connect', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2));
        await writeClaudeCodeOtlpConfig({ force: true }); // displaces nothing here, just establishes a connected file

        // User repoints BOTH endpoint and header at their own unrelated collector.
        // 'Authorization=Bearer ...' alone is the generic HTTP auth scheme, not
        // something unique to codemie, so this must not be misread as "ours".
        const afterConnect = await readJson(settingsPath);
        afterConnect.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://my-own-collector.example/v1/traces';
        afterConnect.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer MY-OWN-TOKEN';
        await writeFile(settingsPath, JSON.stringify(afterConnect, null, 2));

        await removeClaudeCodeOtlpConfig();

        const final = await readJson(settingsPath);
        expect(final.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://my-own-collector.example/v1/traces');
        expect(final.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer MY-OWN-TOKEN');
      });

      it('(finding #4, CRITICAL regression guard) a foreign Bearer header equal to the DEFAULT, non-secret gateway key, with no matching ENDPOINT, is never treated as codemie-owned', async () => {
        // spawnDaemon's default gatewayKey ('codemie-proxy') is a fixed, non-secret
        // string when none is configured — matching HEADERS against it alone is no
        // stronger than the generic Bearer prefix, so ownership must require the
        // ENDPOINT pairing too.
        // Hooks already carry codemie's marker (so `alreadyManaged` is true via
        // hooks alone and the "already managed" strip-and-rebuild path — not
        // the unrelated "first connect" raw-copy path — is what's actually
        // under test here), while HEADERS alone coincidentally equals the
        // default gateway key, with no matching ENDPOINT alongside it.
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });
        await writeFile(
          settingsPath,
          JSON.stringify(
            {
              theme: 'dark',
              hooks: { PreToolUse: [codemieHookGroup()] },
              env: { FOO: 'bar', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer codemie-proxy' },
            },
            null, 2
          )
        );

        const result = await writeClaudeCodeOtlpConfig({ force: true }); // conflicting HEADERS value requires --force regardless

        const backup = await readJson(result.backupPath!);
        expect(backup).toEqual({ theme: 'dark', env: { FOO: 'bar', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer codemie-proxy' } });
      });
    });

    describe('regression: finding #5 — a malformed hook `--force` displaces is restored like a displaced env value', () => {
      it('restores a malformed Stop hook `--force` dropped at connect, on disconnect, if the user never replaced it', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        await writeFile(
          settingsPath,
          JSON.stringify({ hooks: { Stop: { command: 'my-own-stop.sh' } }, env: { KEEP: '1' } }, null, 2)
        );

        await writeClaudeCodeOtlpConfig({ force: true });
        const afterConnect = await readJson(settingsPath);
        expect(Array.isArray(afterConnect.hooks.Stop)).toBe(true); // malformed value was replaced with our array

        await removeClaudeCodeOtlpConfig();

        const final = await readJson(settingsPath);
        expect(final.hooks?.Stop).toEqual({ command: 'my-own-stop.sh' });
        expect(final.env.KEEP).toBe('1');
      });

      it('does NOT restore a displaced malformed hook if the user replaced that event with their own entry after connect (AC3)', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        await writeFile(
          settingsPath,
          JSON.stringify({ hooks: { Stop: { command: 'my-own-stop.sh' } } }, null, 2)
        );
        await writeClaudeCodeOtlpConfig({ force: true });

        // User replaces the Stop hook with their own valid entry after connecting.
        const afterConnect = await readJson(settingsPath);
        afterConnect.hooks.Stop = [{ matcher: '', hooks: [{ type: 'command', command: 'my-new-own-stop.sh' }] }];
        await writeFile(settingsPath, JSON.stringify(afterConnect, null, 2));

        await removeClaudeCodeOtlpConfig();

        const final = await readJson(settingsPath);
        expect(final.hooks.Stop).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'my-new-own-stop.sh' }] }]);
      });

      it('carries a displaced malformed hook forward into a refreshed backup across a reconnect with no intervening disconnect', async () => {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
        await mkdir(join(homeDir, '.claude'), { recursive: true });

        await writeFile(
          settingsPath,
          JSON.stringify({ hooks: { Stop: { command: 'my-own-stop.sh' } } }, null, 2)
        );
        await writeClaudeCodeOtlpConfig({ force: true }); // connect #1: displaces the malformed hook into the backup

        // Reconnect (e.g. --scope project), no disconnect in between.
        await writeClaudeCodeOtlpConfig({ scope: 'project' });

        const backup = await readJson(backupPath);
        expect(backup.hooks?.Stop).toEqual({ command: 'my-own-stop.sh' });
      });
    });

    describe('nothing codemie-owned to remove', () => {
      async function seedSettings(content: string): Promise<string> {
        const settingsPath = join(homeDir, '.claude', 'settings.json');
        await mkdir(join(homeDir, '.claude'), { recursive: true });
        await writeFile(settingsPath, content);
        return settingsPath;
      }

      it('returns removed:false and leaves a foreign-only file byte-identical without logging', async () => {
        const raw = JSON.stringify(
          {
            theme: 'dark',
            env: { FOO: 'bar' },
            hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
          }
        );
        const settingsPath = await seedSettings(raw);

        const result = await removeClaudeCodeOtlpConfig();

        expect(result).toEqual({ mode: "noop", reason: "no CodeMie entries found", removed: false, path: settingsPath });
        expect(await readRaw(settingsPath)).toBe(raw);
        expect(logger.info).not.toHaveBeenCalled();
      });

      it('does not delete or restore from backup when the file is an empty object', async () => {
        const settingsPath = await seedSettings('{}');
        const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
        await writeFile(backupPath, JSON.stringify({ theme: 'from-backup' }));

        const result = await removeClaudeCodeOtlpConfig();

        expect(result).toEqual({ mode: "noop", reason: "no CodeMie entries found", removed: false, path: settingsPath });
        expect(await readRaw(settingsPath)).toBe('{}');
        expect(existsSync(backupPath)).toBe(true);
      });

      it('reports an "absent" reason for project scope when the allowlist key is not set', async () => {
        const settingsPath = await seedSettings(
          JSON.stringify({ theme: 'dark', env: { OTEL_LOGS_EXPORTER: 'otlp' }, hooks: { Stop: [codemieHookGroup()] } })
        );

        const result = await removeClaudeCodeOtlpConfig({ scope: 'project' });

        expect(result).toEqual({
          mode: 'noop',
          reason: `${CODEMIE_ANALYTICS_PROJECT_FILTER_ENV} is not set`,
          removed: false,
          path: settingsPath,
        });
        expect(result.reason).toBe('CODEMIE_ANALYTICS_PROJECT_FILTER is not set');
      });

      it('returns removed:true when only codemie env keys are present (no hooks)', async () => {
        const settingsPath = await seedSettings(
          JSON.stringify({ theme: 'dark', env: { FOO: 'bar', OTEL_LOGS_EXPORTER: 'otlp' } })
        );

        const result = await removeClaudeCodeOtlpConfig();

        expect(result).toEqual({ mode: "full", removed: true, path: settingsPath });
        const final = await readJson(settingsPath);
        expect(final.env).toEqual({ FOO: 'bar' });
        expect(final.theme).toBe('dark');
      });

      it('returns removed:true when only a codemie hook is present (no env keys)', async () => {
        const settingsPath = await seedSettings(
          JSON.stringify({ theme: 'dark', hooks: { Stop: [codemieHookGroup()] } })
        );

        const result = await removeClaudeCodeOtlpConfig();

        expect(result).toEqual({ mode: "full", removed: true, path: settingsPath });
        const final = await readJson(settingsPath);
        expect(final.hooks).toBeUndefined();
        expect(final.theme).toBe('dark');
      });
    });
  });

  describe('regression: connect + disconnect round-trips', () => {
    it('round-trips back to the original file when connect is followed by disconnect', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      const original = {
        theme: 'dark',
        env: { FOO: 'bar' },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'some-other-tool' }] }],
        },
      };
      await writeFile(settingsPath, JSON.stringify(original, null, 2));

      await writeClaudeCodeOtlpConfig();
      await removeClaudeCodeOtlpConfig();

      const final = await readJson(settingsPath);
      expect(final).toEqual(original);
    });

    it('reproduces the reported bug scenario end-to-end and confirms the foreign command survives connect -> manual edit -> reconnect -> disconnect', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');

      // Step 1: `codemie proxy connect --claude-code-otlp` (fresh install)
      await writeClaudeCodeOtlpConfig();

      // Step 2: user manually adds their own command into the SAME PreToolUse
      // group as codemie's command (exact snippet from the bug report).
      const afterConnect = await readJson(settingsPath);
      afterConnect.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'echo my-own-hook' });
      await writeFile(settingsPath, JSON.stringify(afterConnect, null, 2));

      // Step 3: reconnect
      await writeClaudeCodeOtlpConfig();
      const afterReconnect = await readJson(settingsPath);
      const reconnectCommands = afterReconnect.hooks.PreToolUse.flatMap((g: any) =>
        g.hooks.map((h: any) => h.command)
      );
      expect(reconnectCommands).toContain('echo my-own-hook');

      // Step 4: `codemie proxy disconnect --claude-code-otlp`
      await removeClaudeCodeOtlpConfig();
      const final = await readJson(settingsPath);
      const finalCommands = (final.hooks?.PreToolUse ?? []).flatMap((g: any) =>
        g.hooks.map((h: any) => h.command)
      );

      expect(finalCommands).toContain('echo my-own-hook');
      expect(finalCommands.some((c: string) => c.includes(CODEMIE_COMMAND_MARKER))).toBe(false);
    });
  });

  describe('regression: no orphaned commands if a hook event is no longer managed', () => {
    it('cleans up an orphaned event that contains only a stale codemie command', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      // Simulates an event a PREVIOUS version of this tool managed, that the
      // CURRENT HOOK_EVENTS list no longer includes.
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              SomeRetiredEvent: [
                { matcher: '', hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` }] },
              ],
            },
          },
          null,
          2
        )
      );

      await writeClaudeCodeOtlpConfig();

      const merged = await readJson(settingsPath);
      expect(merged.hooks.SomeRetiredEvent).toBeUndefined();
      for (const event of HOOK_EVENTS) {
        expect(merged.hooks[event]).toEqual([codemieHookGroup(event)]);
      }
    });

    it('preserves a foreign command in an orphaned event while stripping the stale codemie command from it', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              SomeRetiredEvent: [
                {
                  matcher: '',
                  hooks: [
                    { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
                    { type: 'command', command: 'echo still-here' },
                  ],
                },
              ],
            },
          },
          null,
          2
        )
      );

      await writeClaudeCodeOtlpConfig();

      const merged = await readJson(settingsPath);
      expect(merged.hooks.SomeRetiredEvent).toEqual([
        { matcher: '', hooks: [{ type: 'command', command: 'echo still-here' }] },
      ]);
      const stillHasCodemieCommand = merged.hooks.SomeRetiredEvent.some((g: any) =>
        g.hooks.some((h: any) => h.command.includes(CODEMIE_COMMAND_MARKER))
      );
      expect(stillHasCodemieCommand).toBe(false);
    });
  });

  describe('regression: defensive hardening (findings #10, #11)', () => {
    it('(finding #10) a non-string value in the backup file is dropped, never raw-copied into the live settings', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      // Live file: codemie's own hook marker + codemie's own current value for
      // OTEL_LOGS_EXPORTER (so disconnect's ownership gate actually strips it
      // and considers it a candidate for restoration), plus one genuine
      // foreign key.
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: { Stop: [codemieHookGroup()] },
            env: { FOO: 'bar', OTEL_LOGS_EXPORTER: 'otlp' },
          },
          null, 2
        )
      );
      // Backup file corrupted (e.g. hand-edited, or written by an older/foreign
      // tool): a non-string value under a CODEMIE_ENV_KEYS member.
      await writeFile(backupPath, JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 42 } }, null, 2));

      await removeClaudeCodeOtlpConfig();

      const final = await readJson(settingsPath);
      expect(final.env).toEqual({ FOO: 'bar' });
      expect(final.env.OTEL_LOGS_EXPORTER).toBeUndefined();
    });

    it('(finding #11) disconnect succeeds even when removing the stale backup file fails (e.g. EPERM)', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ env: { FOO: 'bar' } }, null, 2));

      await writeClaudeCodeOtlpConfig();
      expect(existsSync(backupPath)).toBe(true);

      vi.mocked(fsPromises.unlink).mockRejectedValueOnce(
        Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' })
      );

      const result = await removeClaudeCodeOtlpConfig();

      expect(fsPromises.unlink).toHaveBeenCalledWith(backupPath);
      expect(result.removed).toBe(true);
      const final = await readJson(settingsPath);
      expect(final.env.FOO).toBe('bar');
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('regression: symmetric ENDPOINT/HEADERS pairing and value-gated allowlist key', () => {
    it('does not treat a foreign ENDPOINT as codemie-owned just because it happens to share our path suffix, when HEADERS does not pair with it', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      // Hooks already carry codemie's marker (alreadyManaged=true via hooks),
      // while the user's own collector coincidentally uses the same
      // '/v1/analytics/otlp' path suffix but a non-Bearer auth scheme.
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: { Stop: [codemieHookGroup()] },
            env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://my-own-collector.example/v1/analytics/otlp', OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=USER-SECRET' },
          },
          null, 2
        )
      );

      const result = await writeClaudeCodeOtlpConfig({ force: true });

      const backup = await readJson(result.backupPath!);
      expect(backup.env).toEqual({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://my-own-collector.example/v1/analytics/otlp',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=USER-SECRET',
      });
    });

    it('preserves an unrelated env var that happens to share the allowlist key name but holds a non-allowlist value', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await mkdir(join(homeDir, '.claude'), { recursive: true });

      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: { Stop: [codemieHookGroup()] },
            env: { [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: 'not-a-json-array-at-all' },
          },
          null, 2
        )
      );

      await removeClaudeCodeOtlpConfig();

      const final = await readJson(settingsPath);
      expect(final.env[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]).toBe('not-a-json-array-at-all');
    });
  });
});
