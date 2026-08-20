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
  const CLAUDE_HOME = '/home/testuser/claude';
  const SCRIPT_PATH = join(CLAUDE_HOME, 'codemie-budget-status.js');
  const LEGACY_SCRIPT_PATH = join(CLAUDE_HOME, 'codemie-statusline.mjs');
  const SETTINGS_PATH = join(CLAUDE_HOME, 'settings.json');

  let fsp: typeof import('fs/promises');
  let fsMod: typeof import('fs');

  const realReadFile = async (p: string) => {
    const { readFile } = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    return readFile(p, 'utf-8');
  };

  const mockScriptSources = (settings?: string) =>
    vi.mocked(fsp.readFile).mockImplementation((async (p: string) => {
      const path = String(p).split('\\').join('/');
      if (path.includes('plugin/statusline.mjs')) {
        return realReadFile('src/agents/plugins/claude/plugin/statusline.mjs');
      }
      if (path.includes('plugin/transcript-cost.mjs')) {
        return realReadFile('src/agents/plugins/claude/plugin/transcript-cost.mjs');
      }
      if (settings !== undefined) return settings;
      throw new Error('ENOENT');
    }) as never);

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    fsp = await import('fs/promises');
    fsMod = await import('fs');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('installStatusline', () => {
    it('deploys the script and reports alreadyConfigured=false when settings.json has no statusLine yet', async () => {
      mockScriptSources(JSON.stringify({ theme: 'dark' }));
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      const result = await installStatusline();

      expect(result.alreadyConfigured).toBe(false);
      expect(result.scriptPath).toBe(SCRIPT_PATH);

      const settingsWrite = vi.mocked(fsp.writeFile).mock.calls.find(([p]) => p === SETTINGS_PATH);
      expect(settingsWrite).toBeDefined();
      const written = JSON.parse(settingsWrite![1] as string);
      expect(written.statusLine.type).toBe('command');
      expect(written.statusLine.refreshInterval).toBe(60);
    });

    it('reports alreadyConfigured=true (and still refreshes settings) when statusLine already exists', async () => {
      mockScriptSources(JSON.stringify({ statusLine: { type: 'command', command: 'node "/old.js"' } }));
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      const result = await installStatusline();

      expect(result.alreadyConfigured).toBe(true);
    });

    it('generates a self-contained script with no package imports', async () => {
      mockScriptSources(JSON.stringify({}));
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      await installStatusline();

      const scriptWrite = vi.mocked(fsp.writeFile).mock.calls.find(([p]) => p === SCRIPT_PATH);
      const script = scriptWrite![1] as string;
      expect(script).not.toContain("from './transcript-cost.mjs'");
      expect(script).not.toContain('__CODEMIE_TRANSCRIPT_COST_IMPORT__');
      expect(script).not.toContain("from 'module'");
      expect(script.startsWith('#!')).toBe(true);
    });

    it('prices a transcript with the rates it is given', async () => {
      mockScriptSources(JSON.stringify({}));
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      await installStatusline();
      const script = vi.mocked(fsp.writeFile).mock.calls.find(([p]) => p === SCRIPT_PATH)![1] as string;

      const dataUrl = `data:text/javascript;base64,${Buffer.from(
        script.replace('function transcriptCostUSD', 'export function transcriptCostUSD')
      ).toString('base64')}`;
      const { transcriptCostUSD } = await import(/* @vite-ignore */ dataUrl);

      const usage = { input_tokens: 1_000_000, output_tokens: 0 };
      const line = JSON.stringify({ requestId: 'r1', message: { id: 'm1', model: 'claude-sonnet-4-5', usage } });
      const prices = { 'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75, cacheWrite1h: 6 } };
      expect(transcriptCostUSD([line, line].join('\n'), prices)).toBeCloseTo(3, 6);
    });

    it('fails loudly when a source is missing its substitution marker', async () => {
      mockScriptSources(JSON.stringify({}));
      vi.mocked(fsp.readFile).mockImplementationOnce((async () => '#!/usr/bin/env node') as never);
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      await expect(installStatusline()).rejects.toThrow(/missing its/);
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('refuses to inline transcript-cost.mjs if it grows an import', async () => {
      mockScriptSources(JSON.stringify({}));
      vi.mocked(fsp.readFile).mockImplementation((async (p: string) => {
        const path = String(p).split('\\').join('/');
        if (path.includes('plugin/transcript-cost.mjs')) return "import x from 'y';\nexport function f() {}";
        if (path.includes('plugin/statusline.mjs')) {
          return realReadFile('src/agents/plugins/claude/plugin/statusline.mjs');
        }
        return JSON.stringify({});
      }) as never);
      vi.mocked(fsMod.existsSync).mockReturnValue(true);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      await expect(installStatusline()).rejects.toThrow(/must have no imports/);
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('creates ~/.claude when it does not exist', async () => {
      mockScriptSources();
      vi.mocked(fsMod.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(false);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.chmod).mockResolvedValue(undefined);

      const { installStatusline } = await import('../statusline-installer.js');
      await installStatusline();

      expect(fsp.mkdir).toHaveBeenCalledWith(CLAUDE_HOME, { recursive: true });
    });

    it('throws ConfigurationError and does not overwrite malformed settings.json', async () => {
      mockScriptSources('{ bad json');
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
