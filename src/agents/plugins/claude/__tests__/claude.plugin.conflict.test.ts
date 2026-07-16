/**
 * Tests for Claude Plugin beforeRun conflict detection — warns when
 * ~/.claude/settings.json ANTHROPIC_BASE_URL would override the profile value.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig } from '../../../core/types.js';

vi.mock('fs/promises');
vi.mock('fs');

vi.mock('../statusline-installer.js', () => ({
  installStatusline: vi.fn(),
}));

vi.mock('../settings-conflict.js', () => ({
  detectSettingsConflict: vi.fn(),
}));

vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getCodemieHome: vi.fn(() => '/home/testuser/.codemie'),
  getCodemiePath: vi.fn((...parts: string[]) => `/home/testuser/.codemie/${parts.join('/')}`),
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setProfileName: vi.fn(),
    setSessionId: vi.fn(),
  },
}));

vi.mock('../../../../utils/security.js', () => ({
  sanitizeLogArgs: vi.fn((...args: unknown[]) => args),
}));

type HookEnv = NodeJS.ProcessEnv;
type BeforeRunFn = (env: HookEnv, config: AgentConfig) => Promise<HookEnv>;

describe('Claude Plugin – settings conflict detection in beforeRun', () => {
  let beforeRun: BeforeRunFn;
  let conflictMod: { detectSettingsConflict: ReturnType<typeof vi.fn> };
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const mockConfig: AgentConfig = {};

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await import('../claude.plugin.js');
    beforeRun = mod.ClaudePluginMetadata.lifecycle!.beforeRun!;

    conflictMod = (await import('../settings-conflict.js')) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a chalk warning to stderr when detectSettingsConflict returns ConflictInfo', async () => {
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://other-proxy.example.com',
      profileUrl: 'https://ai-proxy.lab.epam.com',
    });

    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await beforeRun(env, mockConfig);

    const calls = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? ''));
    const warningCall = calls.find(s => s.includes('⚠️') || s.includes('ANTHROPIC_BASE_URL'));
    expect(warningCall).toBeDefined();

    const allOutput = calls.join('\n');
    expect(allOutput).toContain('https://other-proxy.example.com');
    expect(allOutput).toContain('https://ai-proxy.lab.epam.com');
  });

  it('emits warning showing "(not set)" when profileUrl is undefined', async () => {
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://other-proxy.example.com',
      profileUrl: undefined,
    });

    const env: HookEnv = {};
    await beforeRun(env, mockConfig);

    const allOutput = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('not set');
    expect(allOutput).toContain('https://other-proxy.example.com');
  });

  it('does not emit any conflict warning when detectSettingsConflict returns null', async () => {
    conflictMod.detectSettingsConflict.mockResolvedValue(null);

    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await beforeRun(env, mockConfig);

    const conflictCalls = consoleErrorSpy.mock.calls.filter(c =>
      String(c[0] ?? '').includes('⚠️') || String(c[0] ?? '').includes('settings.json')
    );
    expect(conflictCalls).toHaveLength(0);
  });
});
