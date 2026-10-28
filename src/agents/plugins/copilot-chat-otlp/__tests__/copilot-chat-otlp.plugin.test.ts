import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn() }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn(async () => ({})), getActiveProfileName: vi.fn(async () => null), hasLocalConfig: vi.fn(async () => false) },
}));
vi.mock('@/agents/core/copilot-connector-scope.js', () => ({
  isCopilotProjectTracked: vi.fn(),
  readCopilotConnectorScope: vi.fn(async () => ({ kind: 'ok', value: { enabled: true, scope: 'user' } })),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { ConfigLoader } from '@/utils/config.js';
import { isCopilotProjectTracked, readCopilotConnectorScope } from '@/agents/core/copilot-connector-scope.js';
import { CopilotChatOtlpPlugin } from '../copilot-chat-otlp.plugin.js';

function hookInput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    timestamp: '2026-01-02T03:04:05.000Z',
    session_id: 'sid-1',
    cwd: '/repo',
    ...overrides,
  });
}

describe('CopilotChatOtlpPlugin', () => {
  const plugin = new CopilotChatOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});
  const forwardOtlpEventsToSpool = vi.fn(async () => true);

  function log(): { captured(): Record<string, unknown> | undefined } {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    return {
      captured: () => {
        const raw = spy.mock.calls[0]?.[0];
        return typeof raw === 'string' ? JSON.parse(raw) : undefined;
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'user' } } as never);
    vi.mocked(isCopilotProjectTracked).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a permissionDecision:deny shape for a blocked PreToolUse (SSO auth failure)', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(captured()).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('CodeMie SSO authentication'),
    });
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('emits a continue:false shape for a blocked SessionStart (SSO auth failure)', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'SessionStart' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(captured()).toEqual({
      continue: false,
      stopReason: expect.stringContaining('CodeMie SSO authentication'),
    });
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('emits a continue:false shape for a blocked UserPromptSubmit (SSO auth failure)', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    expect(captured()).toEqual({
      continue: false,
      stopReason: expect.stringContaining('CodeMie SSO authentication'),
    });
  });

  it('forwards normally (no block) when SSO auth succeeds', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: true } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
  });

  it('emits a permissionDecision:deny shape for PreToolUse on internal error (not an auth-failure message)', async () => {
    vi.mocked(ConfigLoader.load).mockRejectedValueOnce(new Error('disk full'));
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const output = captured();
    expect(output).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('internal CodeMie error'),
    });
    expect(String(output?.permissionDecisionReason)).not.toContain('sign-in');
  });

  it('does not emit any block output for a non-enforced event on internal error (logs and swallows)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    ensureOtlpProxy.mockRejectedValueOnce(new Error('daemon start failed'));

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'Stop' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('untracked + corrupt connector scope: emits a block for an enforced event even though the hook is untracked', async () => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'corrupt' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'SessionStart' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(captured()).toEqual({
      continue: false,
      stopReason: expect.stringContaining('corrupt'),
    });
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('untracked + corrupt connector scope: does nothing for a non-enforced event', async () => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'corrupt' } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'Stop' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('untracked + disabled connector scope: does nothing, even for an enforced event', async () => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: { enabled: false } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('untracked + missing identity (no session_id): emits a block for an enforced event', async () => {
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'UserPromptSubmit', session_id: undefined, prompt: 'hi' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    expect(captured()).toEqual({
      continue: false,
      stopReason: expect.stringContaining('identity or working directory is missing'),
    });
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('untracked + missing identity (unsafe session_id): emits a block for an enforced event', async () => {
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse', session_id: '../escape' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    expect(captured()).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('identity or working directory is missing'),
    });
  });

  it('evaluate: forwards an empty payload when the connector scope is disabled but the hook somehow reaches evaluate', async () => {
    vi.mocked(isCopilotProjectTracked).mockResolvedValue(true);
    vi.mocked(readCopilotConnectorScope)
      .mockResolvedValueOnce({ kind: 'ok', value: { enabled: true, scope: 'user' } } as never)
      .mockResolvedValueOnce({ kind: 'ok', value: { enabled: false } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });
});
