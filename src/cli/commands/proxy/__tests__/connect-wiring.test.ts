/**
 * Unified `proxy connect` command wiring tests (Task 4).
 * The orchestrator is mocked here so these tests assert only the CLI surface:
 * target-flag mapping, the deprecated-alias notices, and option exposure.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../connect-orchestrator.js', () => ({
  connectTargets: vi.fn().mockResolvedValue(undefined),
  // Symbols index.ts imports for other proxy subcommands (unused by these tests).
  DEFAULT_DAEMON_PORT: 4001,
  daemonMatchesRequest: vi.fn(),
  verifySsoCredentials: vi.fn(),
  printProxyError: vi.fn(),
}));

describe('proxy connect — unified command and deprecated aliases', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('unified connect maps target flags to a ConnectTargets set', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(
      ['connect', '--claude-desktop', '--vscode', '--vscode-claude-code'],
      { from: 'user' }
    );

    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: { claudeDesktop: true, vscode: true, vscodeClaudeCode: true },
      })
    );
  });

  it('deprecated `connect desktop` prints a notice and delegates to { claudeDesktop: true }', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['connect', 'desktop'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('codemie proxy connect --claude-desktop')
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({ targets: { claudeDesktop: true } })
    );
  });

  it('deprecated `connect vscode` prints a notice and delegates to { vscode: true }', async () => {
    const { connectTargets } = await import('../connect-orchestrator.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['connect', 'vscode'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('codemie proxy connect --vscode')
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
    expect(connectTargets).toHaveBeenCalledWith(
      expect.objectContaining({ targets: { vscode: true } })
    );
  });

  it('the unified connect command exposes --vscode-claude-code but the aliases do not', async () => {
    const { createProxyCommand } = await import('../index.js');
    const proxy = createProxyCommand();
    const connect = proxy.commands.find((c) => c.name() === 'connect');
    expect(connect).toBeDefined();

    const hasFlag = (cmd: typeof connect): boolean =>
      Boolean(cmd?.options.some((o) => o.long === '--vscode-claude-code'));

    expect(hasFlag(connect)).toBe(true);

    const desktop = connect?.commands.find((c) => c.name() === 'desktop');
    const vscode = connect?.commands.find((c) => c.name() === 'vscode');
    expect(desktop).toBeDefined();
    expect(vscode).toBeDefined();
    expect(hasFlag(desktop)).toBe(false);
    expect(hasFlag(vscode)).toBe(false);
  });
});
