/**
 * Tests for Claude Plugin statusline lifecycle hooks (--status flag)
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig } from '../../../core/types.js';

// --- Module mocks (hoisted before imports) ---

vi.mock('fs/promises');
vi.mock('fs');

vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getDirname: vi.fn(() => '/fake/dist/plugins/claude'),
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

// ---

type HookEnv = NodeJS.ProcessEnv;
type BeforeRunFn = (env: HookEnv, config: AgentConfig) => Promise<HookEnv>;
type AfterRunFn = (exitCode: number, env: HookEnv) => Promise<void>;

describe('Claude Plugin – statusline lifecycle hooks', () => {
  let beforeRun: BeforeRunFn;
  let afterRun: AfterRunFn;
  let fsp: typeof import('fs/promises');
  let fsMod: typeof import('fs');
  let loggerMod: { logger: Record<string, ReturnType<typeof vi.fn>> };

  const mockConfig: AgentConfig = {};
  // Predictable paths based on mocked resolveHomeDir('.claude') and join
  const CLAUDE_HOME = '/home/testuser/claude';
  const SCRIPT_DEST = `${CLAUDE_HOME}/codemie-statusline.mjs`;
  const SETTINGS_PATH = `${CLAUDE_HOME}/settings.json`;
  const SCRIPT_SRC = '/fake/dist/plugins/claude/plugin/codemie-statusline.mjs';

  beforeEach(async () => {
    vi.resetModules(); // Reset module cache → resets statuslineManagedThisSession to false
    vi.resetAllMocks(); // Reset mock implementations and call counts

    // Re-import after reset to get fresh module instances
    const mod = await import('../claude.plugin.js');
    beforeRun = mod.ClaudePluginMetadata.lifecycle!.beforeRun!;
    afterRun = mod.ClaudePluginMetadata.lifecycle!.afterRun!;

    fsp = await import('fs/promises');
    fsMod = await import('fs');
    loggerMod = (await import('../../../../utils/logger.js')) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // beforeRun
  // ---------------------------------------------------------------------------

  describe('beforeRun', () => {
    it('should not touch files when CODEMIE_STATUS is not set', async () => {
      const env: HookEnv = { CODEMIE_PROFILE_NAME: 'default' };
      const result = await beforeRun(env, mockConfig);

      expect(result).toBe(env);
      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('should deploy script and inject statusLine when CODEMIE_STATUS=1 and no settings.json', async () => {
      // Script source read → dummy content
      vi.mocked(fsp.readFile).mockResolvedValueOnce('#!/usr/bin/env node\n// statusline' as any);
      // claudeHome exists, settings.json does not
      vi.mocked(fsMod.existsSync)
        .mockReturnValueOnce(true)   // claudeHome exists
        .mockReturnValueOnce(false); // settings.json absent
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const env: HookEnv = { CODEMIE_STATUS: '1' };
      const result = await beforeRun(env, mockConfig);

      expect(result).toBe(env);
      // Script written to ~/.claude/codemie-statusline.mjs
      expect(fsp.writeFile).toHaveBeenCalledWith(SCRIPT_DEST, expect.any(String), 'utf-8');
      // settings.json written with statusLine
      const settingsWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
        ([p]) => p === SETTINGS_PATH
      );
      expect(settingsWriteCall).toBeDefined();
      const written = JSON.parse(settingsWriteCall![1] as string);
      expect(written.statusLine).toBeDefined();
      expect(written.statusLine.type).toBe('command');
    });

    it('should read the script from the compiled plugin directory', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// content' as any);
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);

      expect(fsp.readFile).toHaveBeenCalledWith(SCRIPT_SRC, 'utf-8');
    });

    it('should quote the script path in the command to handle spaces in home dir', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// content' as any);
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);

      const settingsWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
        ([p]) => p === SETTINGS_PATH
      );
      const written = JSON.parse(settingsWriteCall![1] as string);
      // Command must wrap the path in double quotes: node "/path/to/script.mjs"
      expect(written.statusLine.command).toMatch(/^node ".*"$/);
      expect(written.statusLine.command).toContain(SCRIPT_DEST);
    });

    it('should not re-inject statusLine if it already exists in settings.json', async () => {
      const existingSettings = { statusLine: { type: 'command', command: 'node "/existing/script.mjs"' }, theme: 'dark' };
      vi.mocked(fsp.readFile)
        .mockResolvedValueOnce('// content' as any)          // script source
        .mockResolvedValueOnce(JSON.stringify(existingSettings) as any); // settings.json
      vi.mocked(fsMod.existsSync).mockReturnValue(true); // both paths exist
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);

      // writeFile called once for the script, NOT for settings.json
      const settingsWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
        ([p]) => p === SETTINGS_PATH
      );
      expect(settingsWriteCall).toBeUndefined();
    });

    it('should return env early and not overwrite settings.json when it contains malformed JSON', async () => {
      vi.mocked(fsp.readFile)
        .mockResolvedValueOnce('// content' as any) // script source
        .mockResolvedValueOnce('{ invalid: json' as any); // corrupt settings.json
      vi.mocked(fsMod.existsSync).mockReturnValue(true); // both paths exist
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const env: HookEnv = { CODEMIE_STATUS: '1' };
      const result = await beforeRun(env, mockConfig);

      expect(result).toBe(env);
      // settings.json must NOT be written
      const settingsWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
        ([p]) => p === SETTINGS_PATH
      );
      expect(settingsWriteCall).toBeUndefined();
      // Warning must be logged
      expect(loggerMod.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not parse settings.json'),
        expect.anything(),
      );
    });

    it('should create ~/.claude directory when it does not exist', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// content' as any);
      vi.mocked(fsMod.existsSync)
        .mockReturnValueOnce(false)  // claudeHome does NOT exist
        .mockReturnValueOnce(false); // settings.json absent
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);

      expect(fsp.mkdir).toHaveBeenCalledWith(CLAUDE_HOME, { recursive: true });
    });

    it('should not set CODEMIE_STATUS_MANAGED env var (uses module-level flag instead)', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// content' as any);
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const env: HookEnv = { CODEMIE_STATUS: '1' };
      await beforeRun(env, mockConfig);

      // The env object must not contain any managed/internal tracking keys
      expect(Object.keys(env)).not.toContain('CODEMIE_STATUS_MANAGED');
      expect(Object.keys(env)).not.toContain('CODEMIE_STATUSLINE_MANAGED');
    });
  });

  // ---------------------------------------------------------------------------
  // afterRun
  // ---------------------------------------------------------------------------

  describe('afterRun', () => {
    it('should not touch files when statusline was not managed in this session', async () => {
      // Do NOT call beforeRun → statuslineManagedThisSession stays false
      await afterRun(0, {});

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('should remove statusLine from settings.json after a managed session', async () => {
      // --- Set up the flag via beforeRun ---
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// script' as any);
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      // --- afterRun ---
      const existingSettings = { statusLine: { type: 'command', command: 'node "/x/y.mjs"' }, theme: 'dark' };
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify(existingSettings) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      await afterRun(0, {});

      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.statusLine).toBeUndefined();
      // Other settings are preserved
      expect(written.theme).toBe('dark');
    });

    it('should reset the module-level flag so a second afterRun call is a no-op', async () => {
      // Set the flag via beforeRun
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// script' as any);
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      // First afterRun – performs cleanup
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ statusLine: {} }) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await afterRun(0, {});
      vi.resetAllMocks();

      // Second afterRun – must be a no-op (flag already reset)
      await afterRun(0, {});

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('should log a sanitized warning when settings cleanup fails', async () => {
      // Set the flag via beforeRun
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// script' as any);
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      // afterRun encounters malformed settings.json
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{ bad json' as any);

      await afterRun(0, {});

      expect(loggerMod.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up statusLine'),
        expect.anything(),
      );
    });

    it('should skip cleanup when settings.json does not exist', async () => {
      // Set the flag via beforeRun
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// script' as any);
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      // settings.json does not exist at cleanup time
      vi.mocked(fsMod.existsSync).mockReturnValue(false);

      await afterRun(0, {});

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });
  });
});
