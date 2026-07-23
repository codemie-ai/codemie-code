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

// BaseAgentAdapter transitively imports providers/index.ts which auto-registers all provider
// plugins on load. At least one provider (SSO) attempts network I/O during registration,
// causing a 30-second timeout in CI/WSL environments. Mock the class entirely — the test
// only exercises ClaudePluginMetadata.lifecycle.beforeRun, which is a plain object property
// and never touches the class hierarchy at runtime.
vi.mock('../../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class {
    constructor() {}
  },
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

  it('does not throw when detectSettingsConflict rejects, calls logger.warn instead', async () => {
    conflictMod.detectSettingsConflict.mockRejectedValue(new Error('os.homedir() failed'));

    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await expect(beforeRun(env, mockConfig)).resolves.not.toThrow();

    const loggerMod = await import('../../../../utils/logger.js');
    expect(loggerMod.logger.warn).toHaveBeenCalledWith(
      '[Claude] Failed to check for ANTHROPIC_BASE_URL settings conflict',
      expect.anything()
    );
  });

  it('shows "(not set)" when profileUrl is empty string', async () => {
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://other-proxy.example.com',
      profileUrl: '',
    });

    const env: HookEnv = {};
    await beforeRun(env, mockConfig);

    const allOutput = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('not set');
    expect(allOutput).not.toMatch(/Profile URL\s+│\s+\n/);
  });

  it('strips C0 control characters from URL values to prevent terminal injection', async () => {
    // A \r in the URL value would move the cursor to column 0 and allow the subsequent
    // text to overwrite the displayed line (terminal injection). safeUrl() strips \r so
    // the raw bytes cannot manipulate the terminal, even though the remaining text is still
    // included in the displayed URL value.
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://malicious.example.com\r  FORGED LINE',
      profileUrl: 'https://ai-proxy.lab.epam.com\x1b[2K',
    });

    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await beforeRun(env, mockConfig);

    const allOutput = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).not.toContain('\r');
    expect(allOutput).not.toContain('\x1b[2K');
  });

  it('strips single-byte C1 CSI (\\x9b) sequences to prevent terminal injection via C1 form', async () => {
    // \x9b is the single-byte form of ESC[ (CSI) used in 8-bit terminal emulators.
    // A URL containing \x9b31mFORGED\x9bm would render as colored "FORGED" if \x9b is not stripped.
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://proxy/\x9b31mFORGED\x9bm',
      profileUrl: 'https://ai-proxy.lab.epam.com',
    });

    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await beforeRun(env, mockConfig);

    const allOutput = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).not.toContain('\x9b');
    expect(allOutput).not.toContain('31mFORGED');
  });

  it('strips DCS payload (\\x1bP...\\x07) — ansi-regex only strips the 2-byte introducer, leaving payload text', async () => {
    // strip-ansi matches \x1bP as a 2-char CSI (P falls in A-P final-byte range) and strips
    // only those two bytes; the payload and BEL (\x07, C0-stripped) are left. An attacker
    // can inject arbitrary readable text inline: \x1bPINJECTED\x07 → "INJECTED".
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://proxy/\x1bPINJECTED\x07',
      profileUrl: 'https://ai-proxy.lab.epam.com',
    });
    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await beforeRun(env, mockConfig);

    const allOutput = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).not.toContain('INJECTED');
  });

  it('strips URL userinfo (@-trick) and prepends [credentials removed]', async () => {
    // https://user@evil.com — RFC 3986 userinfo: "user" is the credential, "evil.com" is the
    // actual host. Displaying the raw string lets the user see "user" as the apparent hostname.
    // The fix parses the URL, removes userinfo, and flags it with [credentials removed].
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://trusted.epam.com@evil.com/path',
      profileUrl: 'https://ai-proxy.lab.epam.com',
    });
    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await beforeRun(env, mockConfig);

    const allOutput = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allOutput).toContain('[credentials removed]');
    expect(allOutput).toContain('evil.com');
    expect(allOutput).not.toContain('trusted.epam.com@');
  });

  it('strips CSI sequences atomically so bracket residue does not appear in output', async () => {
    // If the regex alternation consumes \x1b via the C0 alternative first, the bracket
    // sequence ([31mFORGED[0m) leaks as visible text. The CSI alternative must be tried
    // first so the entire escape sequence is consumed in one match.
    conflictMod.detectSettingsConflict.mockResolvedValue({
      settingsUrl: 'https://proxy/\x1b[31mFORGED\x1b[0m',
      profileUrl: 'https://ai-proxy.lab.epam.com',
    });

    const env: HookEnv = { ANTHROPIC_BASE_URL: 'https://ai-proxy.lab.epam.com' };
    await beforeRun(env, mockConfig);

    const allOutput = consoleErrorSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    // chalk adds its own \x1b codes; check only that the injected residue sequences are gone
    expect(allOutput).not.toContain('[31m');
    expect(allOutput).not.toContain('[0m');
  });
});
