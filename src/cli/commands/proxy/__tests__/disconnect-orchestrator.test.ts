/**
 * `proxy disconnect` orchestration.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('disconnectTargets', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.exitCode = undefined;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.doUnmock('../connectors/codex-desktop.js');
    vi.doUnmock('../connectors/desktop.js');
    vi.doUnmock('../connectors/vscode.js');
    vi.doUnmock('../connectors/vscode-claude-code.js');
    vi.doUnmock('../connectors/claude-code-otlp.js');
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('prints all target flags when no target is selected', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: {} });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--claude-desktop'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--vscode'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--vscode-claude-code'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--codex-desktop'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--claude-code-otlp'));
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

  it('notes the backup fallback when Codex removal had to restore it', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockResolvedValue({
        removed: true, usedBackup: true, configPath: '/home/u/.codex/config.toml',
      }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Restored the backup'));
  });

  it('reports a clean no-op when Codex desktop had nothing to disconnect', async () => {
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
      const remove = vi.fn().mockResolvedValue({ removed: true, usedBackup: false, path: settingsPath });
      vi.doMock('../connectors/claude-code-otlp.js', () => ({ removeClaudeCodeOtlpConfig: remove }));
      const { disconnectTargets } = await import('../disconnect-orchestrator.js');

      await disconnectTargets({ targets: { claudeCodeOtlp: true }, scope: 'project' });

      expect(remove).toHaveBeenCalledWith({ scope: 'project' });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Claude Code OTLP disconnected'));
    });

    it('warns when the backup was restored', async () => {
      vi.doMock('../connectors/claude-code-otlp.js', () => ({
        removeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({ removed: true, usedBackup: true, path: settingsPath }),
      }));
      const { disconnectTargets } = await import('../disconnect-orchestrator.js');

      await disconnectTargets({ targets: { claudeCodeOtlp: true } });

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Restored the pre-connect backup'));
    });

    it('reports a clean no-op when nothing codemie-owned was found', async () => {
      vi.doMock('../connectors/claude-code-otlp.js', () => ({
        removeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({ removed: false, usedBackup: false, path: settingsPath }),
      }));
      const { disconnectTargets } = await import('../disconnect-orchestrator.js');

      await disconnectTargets({ targets: { claudeCodeOtlp: true } });

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to disconnect'));
      expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('disconnected ('));
    });

    it('lists the remaining tracked projects when only an allowlist entry was removed', async () => {
      vi.doMock('../connectors/claude-code-otlp.js', () => ({
        removeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({
          removed: true, usedBackup: false, path: settingsPath, mode: 'entry-removed',
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
          removed: true, usedBackup: false, path: settingsPath, mode: 'full',
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
          removed: false, usedBackup: false, path: settingsPath, mode: 'noop',
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

  it('sets a failing exit code when Codex removal throws', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockRejectedValue(new Error('permission denied')),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(process.exitCode).toBe(1);
  });

  it('reports ✓ disconnected for Claude Desktop on removed: true', async () => {
    vi.doMock('../connectors/desktop.js', () => ({
      removeDesktopConfig: vi.fn().mockResolvedValue({ removed: true, configPath: '/x/config.json' }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { claudeDesktop: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Claude Desktop disconnected'));
  });

  it('reports a dim no-op line for Claude Desktop on removed: false', async () => {
    vi.doMock('../connectors/desktop.js', () => ({
      removeDesktopConfig: vi.fn().mockResolvedValue({ removed: false, configPath: null }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { claudeDesktop: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to disconnect'));
  });

  it('reports ✓ disconnected for VS Code Copilot Chat on removed: true', async () => {
    vi.doMock('../connectors/vscode.js', () => ({
      removeVsCodeLanguageModelsConfig: vi.fn().mockResolvedValue({ removed: true }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { vscode: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('VS Code'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('disconnected'));
  });

  it('reports a dim no-op line for VS Code Copilot Chat on removed: false', async () => {
    vi.doMock('../connectors/vscode.js', () => ({
      removeVsCodeLanguageModelsConfig: vi.fn().mockResolvedValue({ removed: false }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { vscode: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to disconnect'));
  });

  it('reports ✓ disconnected for VS Code Claude Code on removed: true', async () => {
    vi.doMock('../connectors/vscode-claude-code.js', () => ({
      removeVsCodeClaudeCodeConfig: vi.fn().mockResolvedValue({ removed: true }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { vscodeClaudeCode: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Claude Code'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('disconnected'));
  });

  it('reports a dim no-op line for VS Code Claude Code on removed: false', async () => {
    vi.doMock('../connectors/vscode-claude-code.js', () => ({
      removeVsCodeClaudeCodeConfig: vi.fn().mockResolvedValue({ removed: false }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { vscodeClaudeCode: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to disconnect'));
  });

  it('runs independent targets, one throwing does not block the other from reporting', async () => {
    vi.doMock('../connectors/desktop.js', () => ({
      removeDesktopConfig: vi.fn().mockRejectedValue(new Error('disk full')),
    }));
    vi.doMock('../connectors/vscode.js', () => ({
      removeVsCodeLanguageModelsConfig: vi.fn().mockResolvedValue({ removed: true }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { claudeDesktop: true, vscode: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('VS Code'));
    expect(process.exitCode).toBe(1);
  });

  it('still fires the existing Codex backup-fallback message unchanged', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => ({
      removeCodexDesktopConfig: vi.fn().mockResolvedValue({
        removed: true, usedBackup: true, configPath: '/home/u/.codex/config.toml',
      }),
    }));
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: { codexDesktop: true } });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Restored the backup'));
  });
});
