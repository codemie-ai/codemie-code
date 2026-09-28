/**
 * Tests for the statusline installer (`codemie install statusline` / `codemie uninstall statusline`).
 *
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

vi.mock('fs/promises');
vi.mock('fs');

// statusline-installer.ts imports these via the `@/` alias, so mock that exact
// specifier (not a relative path) to guarantee the resolver targets the same module.
vi.mock('@/utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getDirname: vi.fn(() => '/fake/dist/plugins/claude'),
}));

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/utils/security.js', () => ({
  sanitizeLogArgs: vi.fn((...args: unknown[]) => args),
}));

describe('statusline-installer', () => {
  // Derived paths go through path.join in production, so compute expected values the same
  // way to get the correct separator on each OS (backslashes on Windows).
  const CLAUDE_HOME = '/home/testuser/claude';
  const SCRIPT_PATH = join(CLAUDE_HOME, 'codemie-budget-status.js');
  const LEGACY_SCRIPT_PATH = join(CLAUDE_HOME, 'codemie-statusline.mjs');
  const SETTINGS_PATH = join(CLAUDE_HOME, 'settings.json');

  let fsp: typeof import('fs/promises');
  let fsMod: typeof import('fs');

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    fsp = await import('fs/promises');
    fsMod = await import('fs');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Path-aware rather than call-ordered. installStatusline reads several files (the statusline
  // source, the deployed rate card, settings.json); queueing mockResolvedValueOnce by call index
  // silently feeds the wrong content to the wrong read as soon as that set changes.
  const mockReads = ({ settings }: { settings: string }) =>
    vi.mocked(fsp.readFile).mockImplementation((async (filePath: string) => {
      const p = String(filePath);
      if (p.endsWith('settings.json')) return settings;
      if (p.endsWith('pricing.json')) return '{}';
      return '#!/usr/bin/env node\n// statusline';
    }) as never);

  describe('installStatusline', () => {
    it('deploys the bundled script and reports alreadyConfigured=false when settings.json has no statusLine yet', async () => {
      mockReads({ settings: JSON.stringify({ theme: 'dark' }) });
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      const result = await installStatusline();

      expect(result.alreadyConfigured).toBe(false);
      expect(result.scriptPath).toBe(SCRIPT_PATH);

      expect(fsp.readFile).toHaveBeenCalledWith(
        expect.stringContaining('statusline.bundle.mjs'),
        'utf-8'
      );

      const scriptWrite = vi.mocked(fsp.writeFile).mock.calls.find(([p]) => p === SCRIPT_PATH);
      expect(scriptWrite).toBeDefined();

      const settingsWrite = vi.mocked(fsp.writeFile).mock.calls.find(([p]) => p === SETTINGS_PATH);
      expect(settingsWrite).toBeDefined();
      const written = JSON.parse(settingsWrite![1] as string);
      expect(written.statusLine.type).toBe('command');
      expect(written.statusLine.refreshInterval).toBe(3);
    });

    it('reports alreadyConfigured=true (and still refreshes settings) when statusLine already exists', async () => {
      mockReads({ settings: JSON.stringify({ statusLine: { type: 'command', command: 'node "/old.js"' } }) });
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      const result = await installStatusline();

      expect(result.alreadyConfigured).toBe(true);
    });

    it('creates ~/.claude when it does not exist', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce('// script' as any);
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(false);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      await installStatusline();

      expect(fsp.mkdir).toHaveBeenCalledWith(CLAUDE_HOME, { recursive: true });
    });

    it('throws ConfigurationError and does not overwrite malformed settings.json', async () => {
      mockReads({ settings: '{ bad json' });
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      await expect(installStatusline()).rejects.toThrow('Could not parse ~/.claude/settings.json');
    });
  });

  describe('uninstallStatusline', () => {
    it('removes the script and the statusLine settings entry', async () => {
      vi.mocked(fsMod.existsSync).mockImplementation((p: any) =>
        p === SCRIPT_PATH || p === SETTINGS_PATH
      );
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({ statusLine: {}, theme: 'dark' }) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const { uninstallStatusline } = await import('../statusline-installer.js');
      await uninstallStatusline();

      expect(fsp.rm).toHaveBeenCalledWith(SCRIPT_PATH);
      expect(fsp.rm).not.toHaveBeenCalledWith(expect.stringContaining('routing-headers.mjs'));
      expect(fsp.rm).not.toHaveBeenCalledWith(expect.stringContaining('bedrock-pricing.mjs'));
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.statusLine).toBeUndefined();
      expect(written.theme).toBe('dark');
    });

    it('also removes the legacy codemie-statusline.mjs artifact if present', async () => {
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({}) as any);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const { uninstallStatusline } = await import('../statusline-installer.js');
      await uninstallStatusline();

      expect(fsp.rm).toHaveBeenCalledWith(LEGACY_SCRIPT_PATH);
    });

    it('skips removal when neither script exists', async () => {
      vi.mocked(fsMod.existsSync).mockReturnValue(false);

      const { uninstallStatusline } = await import('../statusline-installer.js');
      await uninstallStatusline();

      expect(fsp.rm).not.toHaveBeenCalled();
    });
  });

  describe('isStatuslineInstalled', () => {
    it('returns true when the script file exists', async () => {
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      const { isStatuslineInstalled } = await import('../statusline-installer.js');
      expect(isStatuslineInstalled()).toBe(true);
    });

    it('returns false when the script file does not exist', async () => {
      vi.mocked(fsMod.existsSync).mockReturnValue(false);
      const { isStatuslineInstalled } = await import('../statusline-installer.js');
      expect(isStatuslineInstalled()).toBe(false);
    });
  });
});
