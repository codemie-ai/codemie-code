/**
 * Tests for the Claude plugin's pre-spawn OTLP endpoint refresh (EPMCDME-16647 QA fix).
 *
 * `beforeRun` must refresh `~/.claude/settings.json`'s OTLP endpoint via the existing
 * `ensureOtlpProxy(this.metadata.name)` primitive before Claude Code's own process starts,
 * not only during its `SessionStart` hook — but only when CodeMie already owns that
 * endpoint (an unconnected launch must never start the proxy daemon as a side effect),
 * and a failure there must never block the launch. `this.metadata.name` (not the OTLP
 * adapter's own 'claude-code-otlp' name) must be passed through so a claude-acp launch
 * is attributed as 'claude-acp', not 'claude'.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs/promises');
vi.mock('fs');

const isClaudeCodeOtlpConnectedMock = vi.hoisted(() => vi.fn());
const ensureOtlpProxyMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../cli/commands/proxy/connectors/claude-code-otlp-endpoint.js', () => ({
  isClaudeCodeOtlpConnected: isClaudeCodeOtlpConnectedMock,
}));

vi.mock('../../../../cli/commands/proxy/otlp-cold-start.js', () => ({
  ensureOtlpProxy: ensureOtlpProxyMock,
}));

import { ClaudePluginMetadata } from '../claude.plugin.js';

describe('ClaudePluginMetadata.lifecycle.beforeRun — pre-spawn OTLP endpoint refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Mirrors the real call shape: lifecycle-helpers.ts's executeBeforeRun() does
  // `hook.call(context, env, config)`, binding `this` to the launching adapter
  // instance — never to ClaudePluginMetadata.lifecycle itself.
  async function runBeforeRun(
    env: Record<string, string> = {},
    agentName: string = 'claude'
  ): Promise<Record<string, string>> {
    await ClaudePluginMetadata.lifecycle?.beforeRun?.call(
      { metadata: { name: agentName } } as never,
      env as never,
      {} as never
    );
    return env;
  }

  it('refreshes the OTLP endpoint before spawn when already connected', async () => {
    isClaudeCodeOtlpConnectedMock.mockResolvedValue(true);
    ensureOtlpProxyMock.mockResolvedValue(undefined);

    await runBeforeRun();

    expect(ensureOtlpProxyMock).toHaveBeenCalledTimes(1);
    expect(ensureOtlpProxyMock).toHaveBeenCalledWith('claude');
  });

  it('attributes a claude-acp launch as claude-acp, not claude-code-otlp or claude', async () => {
    isClaudeCodeOtlpConnectedMock.mockResolvedValue(true);
    ensureOtlpProxyMock.mockResolvedValue(undefined);

    await runBeforeRun({}, 'claude-acp');

    expect(ensureOtlpProxyMock).toHaveBeenCalledWith('claude-acp');
  });

  it('never starts the proxy daemon when not connected', async () => {
    isClaudeCodeOtlpConnectedMock.mockResolvedValue(false);

    await runBeforeRun();

    expect(ensureOtlpProxyMock).not.toHaveBeenCalled();
  });

  it('does not throw and still returns the env when the refresh fails', async () => {
    isClaudeCodeOtlpConnectedMock.mockResolvedValue(true);
    ensureOtlpProxyMock.mockRejectedValue(new Error('daemon failed to start'));

    const env = await runBeforeRun({ FOO: 'bar' });

    expect(env.FOO).toBe('bar');
  });

  it('does not stall the launch when the refresh never settles', async () => {
    vi.useFakeTimers();
    try {
      isClaudeCodeOtlpConnectedMock.mockResolvedValue(true);
      ensureOtlpProxyMock.mockImplementation(() => new Promise(() => {})); // never settles

      const pending = runBeforeRun({ FOO: 'bar' });
      await vi.advanceTimersByTimeAsync(10_000);
      const env = await pending;

      expect(env.FOO).toBe('bar');
    } finally {
      vi.useRealTimers();
    }
  });
});
