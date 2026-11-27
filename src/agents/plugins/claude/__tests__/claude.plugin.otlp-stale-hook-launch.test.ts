/**
 * Launch-level regression coverage: a Claude launch must repair CodeMie's own OTLP hook commands
 * in `~/.claude/settings.json` when the CodeMie CLI they point at has been removed (for example
 * after moving from an npm-installed CLI to CodeMie Connect).
 *
 * Exercises the real `ClaudePluginMetadata.lifecycle.beforeRun` against a temp HOME holding a
 * CodeMie-connected `settings.json` (the real connection check decides it is connected). Only
 * three seams are faked: the home directory, the `codemie` PATH lookup (so "the current CLI" is a
 * file this test owns), and the OTLP daemon cold start (it would spawn a real proxy daemon).
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const homeDirRef = vi.hoisted(() => ({ current: '' }));
const getCommandPathMock = vi.hoisted(() => vi.fn());
const ensureOtlpProxyMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/paths.js', async (importOriginal) => {
  const { join: joinPath } = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/utils/paths.js')>()),
    resolveHomeDir: (relativePath = '') => joinPath(homeDirRef.current, relativePath),
  };
});

vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  getCommandPath: getCommandPathMock,
}));

vi.mock('../../../../cli/commands/proxy/otlp-cold-start.js', () => ({
  ensureOtlpProxy: ensureOtlpProxyMock,
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    notice: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    status: vi.fn(),
  },
}));

const OTLP_MARKER = 'hook --agent claude-code-otlp';
const OTLP_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const;

const toForwardSlash = (p: string): string => p.replace(/\\/g, '/');

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface Settings {
  env: Record<string, string>;
  hooks: Record<string, Array<{ matcher?: string; hooks: HookCommand[] }>>;
  [key: string]: unknown;
}

function buildSettings(cliPath: string, userHookCommand: string): Settings {
  const hooks: Settings['hooks'] = {};
  for (const event of OTLP_EVENTS) {
    hooks[event] = [
      { hooks: [{ type: 'command', command: `${cliPath} ${OTLP_MARKER} --event ${event}`, timeout: 30 }] },
    ];
  }
  // A group that mixes a CodeMie hook with the user's own hook, plus a user-only group.
  hooks.PreToolUse = [
    {
      matcher: '*',
      hooks: [
        { type: 'command', command: userHookCommand },
        { type: 'command', command: `${cliPath} ${OTLP_MARKER} --event PreToolUse`, timeout: 30 },
      ],
    },
  ];
  hooks.Notification = [{ hooks: [{ type: 'command', command: `${userHookCommand} --notify` }] }];
  return {
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:47123/v1/analytics/otlp',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer regression-gateway-key',
    },
    hooks,
    permissions: { allow: ['Bash(ls:*)'] },
  };
}

function codemieCommands(settings: Settings): string[] {
  return Object.values(settings.hooks)
    .flatMap((groups) => groups.flatMap((group) => group.hooks))
    .map((hook) => hook.command)
    .filter((command) => command.includes(OTLP_MARKER));
}

describe('Claude launch — stale CodeMie CLI path in OTLP hooks of ~/.claude/settings.json', () => {
  let sandbox: string;
  let settingsPath: string;
  let currentCli: string;
  let removedCli: string;
  const userHookCommand = '/usr/local/bin/my-own-audit-hook.sh';

  async function launchClaude(): Promise<void> {
    const { ClaudePluginMetadata } = await import('../claude.plugin.js');
    // CODEMIE_PROVIDER=anthropic-subscription skips the live CodeMie model catalog lookups.
    const env: NodeJS.ProcessEnv = { CODEMIE_PROVIDER: 'anthropic-subscription' };
    await ClaudePluginMetadata.lifecycle?.beforeRun?.call(
      { metadata: { name: 'claude' } } as never,
      env as never,
      {} as never
    );
  }

  async function readSettings(): Promise<Settings> {
    return JSON.parse(await readFile(settingsPath, 'utf-8')) as Settings;
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'codemie-stale-otlp-hook-'));
    homeDirRef.current = join(sandbox, 'home');
    settingsPath = join(homeDirRef.current, '.claude', 'settings.json');

    // The CLI the user runs now (CodeMie Connect's bundled CLI) — a file that exists.
    const connectBin = join(sandbox, 'codemie-connect', 'bin');
    await mkdir(connectBin, { recursive: true });
    currentCli = join(connectBin, process.platform === 'win32' ? 'codemie.cmd' : 'codemie');
    await writeFile(currentCli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    getCommandPathMock.mockResolvedValue(currentCli);

    // The npm-prefix CLI the hooks were written with — uninstalled, so it no longer exists.
    removedCli = toForwardSlash(join(sandbox, 'npm-prefix', 'codemie'));

    // The one-time hook-localization migration already ran while the old path was still valid.
    await mkdir(join(homeDirRef.current, '.codemie'), { recursive: true });
    await writeFile(
      join(homeDirRef.current, '.codemie', 'migrations.json'),
      JSON.stringify({ applied: [{ id: '011-localize-otlp-hook-commands', appliedAt: '2026-11-01T00:00:00.000Z' }] })
    );

    ensureOtlpProxyMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(sandbox, { recursive: true, force: true });
  });

  it('rewrites OTLP hook commands that point at a removed CLI to the current CLI on launch', async () => {
    await mkdir(join(homeDirRef.current, '.claude'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(buildSettings(removedCli, userHookCommand), null, 2));

    const before = codemieCommands(await readSettings());
    expect(before.length > 0 && !existsSync(removedCli) && before.every((c) => c.startsWith(`${removedCli} `))).toBe(true); // repro:precondition

    await launchClaude();

    const after = codemieCommands(await readSettings());
    const expectedPrefix = `${toForwardSlash(currentCli)} ${OTLP_MARKER}`;
    expect(after.filter((command) => !command.startsWith(expectedPrefix))).toEqual([]); // repro:symptom
  });

  it('keeps the user’s own hooks and unrelated settings when the stale CodeMie hooks are repaired', async () => {
    await mkdir(join(homeDirRef.current, '.claude'), { recursive: true });
    const seeded = buildSettings(removedCli, userHookCommand);
    await writeFile(settingsPath, JSON.stringify(seeded, null, 2));

    await launchClaude();

    const after = await readSettings();
    expect(after.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: userHookCommand });
    expect(after.hooks.Notification).toEqual(seeded.hooks.Notification);
    expect(after.permissions).toEqual(seeded.permissions);
    expect(after.env).toEqual(seeded.env);
  });

  it('does not rewrite settings.json when every OTLP hook already points at the current CLI', async () => {
    await mkdir(join(homeDirRef.current, '.claude'), { recursive: true });
    const content = JSON.stringify(buildSettings(toForwardSlash(currentCli), userHookCommand), null, 2);
    await writeFile(settingsPath, content);
    const mtimeBefore = (await stat(settingsPath)).mtimeMs;

    await launchClaude();

    expect(await readFile(settingsPath, 'utf-8')).toBe(content);
    expect((await stat(settingsPath)).mtimeMs).toBe(mtimeBefore);
  });
});
