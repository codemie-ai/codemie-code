/**
 * `proxy disconnect` orchestration.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

describe('disconnectTargets', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.doUnmock('../connectors/codex-desktop.js');
    vi.doUnmock('../connectors/claude-code-otlp.js');
    vi.clearAllMocks();
  });

  it('prints the target list when no target is selected', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: {} });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--codex-desktop'));
  });

  it('reports the removal for the Codex desktop target', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockResolvedValue({
        removed: true, usedBackup: false, configPath: '/home/u/.codex/config.toml',
      }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Codex Desktop disconnected'));
  });

  it('notes the backup fallback when removal had to restore it', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockResolvedValue({
        removed: true, usedBackup: true, configPath: '/home/u/.codex/config.toml',
      }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Restored the backup'));
  });

  it('reports a clean no-op when nothing was connected', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockResolvedValue({
        removed: false, usedBackup: false, configPath: null,
      }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to disconnect'));
  });

  describe('Claude Code OTLP target', () => {
    const settingsPath = '/home/u/.claude/settings.json';

    it('reports the removal', async () => {
      const remove = vi.fn().mockResolvedValue({ removed: true, path: settingsPath });
      vi.doMock('../connectors/claude-code-otlp.js', () => ({ removeClaudeCodeOtlpConfig: remove }));
      const { disconnectTargets } = await import('../disconnect-orchestrator.js');

      await disconnectTargets({ targets: { claudeCodeOtlp: true }, scope: 'project' });

      expect(remove).toHaveBeenCalledWith({ scope: 'project' });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Claude Code OTLP disconnected'));
    });

    it('does not print a restored-backup warning (claude-code-otlp never restores backup content)', async () => {
      vi.doMock('../connectors/claude-code-otlp.js', () => ({
        removeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({ removed: true, path: settingsPath, mode: 'full' }),
      }));
      const { disconnectTargets } = await import('../disconnect-orchestrator.js');

      await disconnectTargets({ targets: { claudeCodeOtlp: true } });

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Claude Code OTLP disconnected'));
      expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Restored the pre-connect backup'));
    });

    it('reports a clean no-op when nothing codemie-owned was found', async () => {
      vi.doMock('../connectors/claude-code-otlp.js', () => ({
        removeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({ removed: false, path: settingsPath }),
      }));
      const { disconnectTargets } = await import('../disconnect-orchestrator.js');

      await disconnectTargets({ targets: { claudeCodeOtlp: true } });

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to disconnect'));
      expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('disconnected ('));
    });

    it('lists the remaining tracked projects when only an allowlist entry was removed', async () => {
      vi.doMock('../connectors/claude-code-otlp.js', () => ({
        removeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({
          removed: true, path: settingsPath, mode: 'entry-removed',
          allowlist: ['/work/a', '/work/b'],
        }),
      }));
      const { disconnectTargets } = await import('../disconnect-orchestrator.js');

      await disconnectTargets({ targets: { claudeCodeOtlp: true }, scope: 'project' });

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Project removed from Claude Code OTLP tracking'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('/work/a'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('/work/b'));
      expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Claude Code OTLP disconnected'));
    });

    it('reports a full disconnect for mode "full"', async () => {
      vi.doMock('../connectors/claude-code-otlp.js', () => ({
        removeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({
          removed: true, path: settingsPath, mode: 'full',
        }),
      }));
      const { disconnectTargets } = await import('../disconnect-orchestrator.js');

      await disconnectTargets({ targets: { claudeCodeOtlp: true } });

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Claude Code OTLP disconnected'));
      expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Still tracked'));
    });

    it('includes the reason in the no-op message for mode "noop"', async () => {
      vi.doMock('../connectors/claude-code-otlp.js', () => ({
        removeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({
          removed: false, path: settingsPath, mode: 'noop',
          reason: 'CODEMIE_ANALYTICS_PROJECT_FILTER is not set',
        }),
      }));
      const { disconnectTargets } = await import('../disconnect-orchestrator.js');

      await disconnectTargets({ targets: { claudeCodeOtlp: true }, scope: 'project' });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('nothing to disconnect (CODEMIE_ANALYTICS_PROJECT_FILTER is not set)')
      );
    });
  });

  it('sets a failing exit code when removal throws', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockRejectedValue(new Error('permission denied')),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(process.exitCode).toBe(1);
  });
});

describe('disconnectTargets — the analytics aggregates', () => {
  const CLAUDE = { claudeDesktop: true, vscodeClaudeCode: true, claudeCodeOtlp: true };
  let home: string;
  let printed: string[];
  let removers: Record<'desktop' | 'vscode' | 'claudeCode', ReturnType<typeof vi.fn>>;

  /**
   * The removers mocked; each client of `found` is on this machine and each of `configured` reads connected, under a
   * home of the test's own and a mocked PATH lookup.
   */
  async function machine(
    found: Array<'desktop' | 'vscode' | 'claude'>,
    configured: Array<'desktop' | 'desktopProxy' | 'claudeCode'> = [],
  ): Promise<void> {
    if (found.includes('desktop')) await mkdir(join(home, 'Applications', 'Claude.app'), { recursive: true });
    vi.doMock('@/telemetry/clients/claude-desktop/claude-desktop.paths.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js')>()),
      getClaudeDesktopAppCandidates: () => [join(home, 'Applications', 'Claude.app')],
    }));
    vi.doMock('@/utils/processes.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/utils/processes.js')>()),
      getCommandPath: async (command: string) => (command === 'claude' && found.includes('claude') ? '/usr/bin/claude' : null),
    }));
    if (found.includes('vscode')) {
      const { getVsCodeProductDir } = await import('../connectors/vscode.js');
      await mkdir(getVsCodeProductDir(false), { recursive: true });
    }
    removers = {
      desktop: vi.fn().mockResolvedValue({ removed: true, configPath: '/desktop/config.json', deletedConfigFile: true }),
      vscode: vi.fn().mockResolvedValue({ removed: true, path: '/vscode/settings.json' }),
      claudeCode: vi.fn().mockResolvedValue({ removed: true, path: '/home/u/.claude/settings.json', mode: 'full' }),
    };
    vi.doMock('../connectors/desktop.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../connectors/desktop.js')>();
      return {
        ...actual,
        removeDesktopConfig: removers.desktop,
        readDesktopGateway: configured.includes('desktopProxy') ? async () => ({ port: 4001 }) : actual.readDesktopGateway,
      };
    });
    vi.doMock('@/telemetry/clients/claude-desktop/claude-desktop.gateway.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/telemetry/clients/claude-desktop/claude-desktop.gateway.js')>()),
      readDesktopGatewayConfig: async () => (configured.includes('desktop') ? { port: 4010, apiKey: 'another-tool' } : null),
    }));
    vi.doMock('../connectors/vscode-claude-code.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../connectors/vscode-claude-code.js')>()),
      removeVsCodeClaudeCodeConfig: removers.vscode,
    }));
    vi.doMock('../connectors/claude-code-otlp.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../connectors/claude-code-otlp.js')>()),
      removeClaudeCodeOtlpConfig: removers.claudeCode,
      hasClaudeCodeOtlpHooks: async () => configured.includes('claudeCode'),
    }));
  }

  beforeEach(async () => {
    vi.resetModules();
    process.exitCode = 0;
    home = await mkdtemp(join(tmpdir(), 'disconnect-aggregate-home-'));
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) vi.stubEnv(name, home);
    vi.stubEnv('CODEMIE_HOME', join(home, '.codemie'));
    printed = [];
    const capture = (message: unknown) => { printed.push(String(message)); };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const path of [
      '@/telemetry/clients/claude-desktop/claude-desktop.paths.js', '@/utils/processes.js', '../connectors/desktop.js',
      '@/telemetry/clients/claude-desktop/claude-desktop.gateway.js',
      '../connectors/vscode-claude-code.js', '../connectors/claude-code-otlp.js',
    ]) vi.doUnmock(path);
    process.exitCode = 0;
    // Windows can briefly hold a handle (the logger) on a file under the temp home.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('--claude-otlp, every member found: the three removers as by the three flags', async () => {
    await machine(['desktop', 'vscode', 'claude']);
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: CLAUDE, aggregates: ['claude-otlp'] });

    expect(removers.desktop).toHaveBeenCalled();
    expect(removers.vscode).toHaveBeenCalledWith(false);
    expect(removers.claudeCode).toHaveBeenCalledWith({ scope: undefined });
    expect(process.exitCode).toBe(0);
  });

  it('the extension neither found nor configured: skipped with no line and no exit code', async () => {
    await machine(['desktop', 'claude']);
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: CLAUDE, aggregates: ['claude-otlp'] });

    expect(removers.vscode).not.toHaveBeenCalled();
    expect(printed.some((line) => line.includes('VS Code Claude Code'))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('Claude Code not found but configured: its remover runs', async () => {
    await machine([], ['claudeCode']);
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: CLAUDE, aggregates: ['claude-otlp'] });

    expect(removers.claudeCode).toHaveBeenCalled();
  });

  it('Claude Desktop not found, its applied config a loopback gateway with a key this proxy does not accept: skipped', async () => {
    await machine([], ['desktop']);
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: CLAUDE, aggregates: ['claude-otlp'] });

    expect(removers.desktop).not.toHaveBeenCalled();
    expect(printed.some((line) => line.includes('Claude Desktop'))).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('Claude Desktop not found, its applied config pointed at this proxy: its remover runs', async () => {
    await machine([], ['desktopProxy']);
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: CLAUDE, aggregates: ['claude-otlp'] });

    expect(removers.desktop).toHaveBeenCalled();
  });

  it('--copilot-otlp, Copilot CLI not found and its record corrupt: its remover not called, no exit code', async () => {
    await machine([]);
    vi.stubEnv('CODEMIE_COPILOT_BIN', '');
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    const recordPath = getCopilotConnectorsConfigPath();
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify({ version: 1, connectors: { 'copilot-cli-otlp': { enabled: 'yes' } } }));
    const removeCli = vi.fn().mockResolvedValue({ removed: true, hookFilePath: '/copilot/hooks.json' });
    vi.doMock('../connectors/copilot-cli-otlp.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../connectors/copilot-cli-otlp.js')>()),
      removeCopilotCliOtlpConfig: removeCli,
    }));
    const { readCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    try {
      expect(await readCopilotConnectorScope('copilot-cli-otlp')).toEqual({ kind: 'corrupt' });
      await disconnectTargets({ targets: { copilotChatOtlp: true, copilotCliOtlp: true }, aggregates: ['copilot-otlp'] });
    } finally {
      vi.doUnmock('../connectors/copilot-cli-otlp.js');
    }

    expect(removeCli).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('scope project: Desktop and the extension left connected, Claude Code removed for the project', async () => {
    await machine(['desktop', 'vscode', 'claude']);
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: CLAUDE, aggregates: ['claude-otlp'], scope: 'project' });

    expect(removers.desktop).not.toHaveBeenCalled();
    expect(removers.vscode).not.toHaveBeenCalled();
    expect(removers.claudeCode).toHaveBeenCalledWith({ scope: 'project' });
  });

  it('nothing left to disconnect: one line, no exit code', async () => {
    await machine([]);
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: CLAUDE, aggregates: ['claude-otlp'] });

    expect(printed).toEqual(['Nothing to disconnect. See: codemie proxy status']);
    expect(process.exitCode).toBe(0);
  });

  it('--vscode-claude-code by its own flag, its remover throwing: the failure line and exit code 1', async () => {
    await machine([]);
    removers.vscode.mockRejectedValue(new Error('VS Code user data directory not found'));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { vscodeClaudeCode: true } });

    expect(printed.some((line) => line.includes('✗ VS Code Claude Code — VS Code user data directory not found'))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('bare disconnect lists the two aggregates', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: {} });

    expect(printed.join('\n')).toContain('--claude-otlp');
    expect(printed.join('\n')).toContain('--copilot-otlp');
    const lines = printed.join('\n').split('\n');
    expect(lines).toContain('  --claude-otlp          Every Claude client (analytics, and the proxy route of Claude Desktop and the extension)');
    expect(lines).toContain('  --copilot-otlp         Every Copilot client (Copilot Chat and Copilot CLI analytics)');
    expect(lines).toContain('  codemie proxy disconnect --claude-otlp');
  });
});
