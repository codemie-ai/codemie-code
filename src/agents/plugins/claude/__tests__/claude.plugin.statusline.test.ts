/**
 * Tests for Claude Plugin statusline lifecycle hooks (--status flag).
 *
 * The --status flag is a thin alias for `installStatusline()` (the same function
 * `codemie install statusline` uses) — it must not duplicate deploy/settings logic.
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
type AfterRunFn = (exitCode: number, env: HookEnv) => Promise<void>;

describe('Claude Plugin – statusline lifecycle hooks', () => {
  let beforeRun: BeforeRunFn;
  let afterRun: AfterRunFn;
  let installerMod: { installStatusline: ReturnType<typeof vi.fn> };
  let fsp: typeof import('fs/promises');
  let fsMod: typeof import('fs');
  let loggerMod: { logger: Record<string, ReturnType<typeof vi.fn>> };

  const mockConfig: AgentConfig = {};

  beforeEach(async () => {
    vi.resetModules(); // Reset module cache → resets statuslineManagedThisSession to false
    vi.resetAllMocks();

    const mod = await import('../claude.plugin.js');
    beforeRun = mod.ClaudePluginMetadata.lifecycle!.beforeRun!;
    afterRun = mod.ClaudePluginMetadata.lifecycle!.afterRun!;

    installerMod = (await import('../statusline-installer.js')) as any;
    fsp = await import('fs/promises');
    fsMod = await import('fs');
    loggerMod = (await import('../../../../utils/logger.js')) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('beforeRun', () => {
    it('should not call installStatusline when CODEMIE_STATUS is not set', async () => {
      const env: HookEnv = { CODEMIE_PROFILE_NAME: 'default' };
      const result = await beforeRun(env, mockConfig);

      expect(result).toBe(env);
      expect(installerMod.installStatusline).not.toHaveBeenCalled();
    });

    it('should call installStatusline and mark the session managed when not already configured', async () => {
      installerMod.installStatusline.mockResolvedValue({
        scriptPath: '/home/testuser/claude/codemie-budget-status.js',
        alreadyConfigured: false,
      });

      const env: HookEnv = { CODEMIE_STATUS: '1' };
      const result = await beforeRun(env, mockConfig);

      expect(result).toBe(env);
      expect(installerMod.installStatusline).toHaveBeenCalledTimes(1);

      // Session-managed → afterRun must clean up settings.json.
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(
        JSON.stringify({ statusLine: { type: 'command', command: 'node "x"' }, theme: 'dark' }) as any
      );
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      await afterRun(0, {});

      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.statusLine).toBeUndefined();
      expect(written.theme).toBe('dark');
    });

    it('should NOT mark the session managed when a persistent install already existed', async () => {
      installerMod.installStatusline.mockResolvedValue({
        scriptPath: '/home/testuser/claude/codemie-budget-status.js',
        alreadyConfigured: true,
      });

      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      await afterRun(0, {}); // must be a no-op — persistent `codemie install statusline` config must survive

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('should log a warning and not throw when installStatusline fails', async () => {
      installerMod.installStatusline.mockRejectedValue(new Error('disk full'));

      const env: HookEnv = { CODEMIE_STATUS: '1' };
      const result = await beforeRun(env, mockConfig);

      expect(result).toBe(env);
      expect(loggerMod.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to configure statusline'),
        expect.anything(),
      );
    });
  });

  describe('afterRun', () => {
    it('should not touch files when statusline was not managed in this session', async () => {
      await afterRun(0, {});

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('should reset the module-level flag so a second afterRun call is a no-op', async () => {
      installerMod.installStatusline.mockResolvedValue({ scriptPath: '/x/y.js', alreadyConfigured: false });
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ statusLine: {} }) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await afterRun(0, {});
      vi.resetAllMocks();

      await afterRun(0, {});

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('should log a sanitized warning when settings cleanup fails', async () => {
      installerMod.installStatusline.mockResolvedValue({ scriptPath: '/x/y.js', alreadyConfigured: false });
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{ bad json' as any);

      await afterRun(0, {});

      expect(loggerMod.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up statusLine'),
        expect.anything(),
      );
    });

    it('should skip cleanup when settings.json does not exist', async () => {
      installerMod.installStatusline.mockResolvedValue({ scriptPath: '/x/y.js', alreadyConfigured: false });
      await beforeRun({ CODEMIE_STATUS: '1' }, mockConfig);
      vi.resetAllMocks();

      vi.mocked(fsMod.existsSync).mockReturnValue(false);

      await afterRun(0, {});

      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });
  });
});
