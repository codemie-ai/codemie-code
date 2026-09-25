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
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('prints all four target flags when no target is selected', async () => {
    const { disconnectTargets } = await import('../disconnect-orchestrator.js');

    await disconnectTargets({ targets: {} });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--claude-desktop'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--vscode'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--vscode-claude-code'));
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
