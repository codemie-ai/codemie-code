import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn() }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn(async () => ({})), getActiveProfileName: vi.fn(async () => null), hasLocalConfig: vi.fn(async () => false) },
}));
vi.mock('@/agents/core/copilot-analytics-gate.js', () => ({
  evaluateCopilotAnalyticsGate: vi.fn(),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';
import { evaluateCopilotAnalyticsGate } from '@/agents/core/copilot-analytics-gate.js';
import { CopilotCliOtlpPlugin } from '../copilot-cli-otlp.plugin.js';

function hookInput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId: 'sid-1',
    cwd: '/repo',
    timestamp: 1700000000000,
    codemieEventName: 'preToolUse',
    ...overrides,
  });
}

describe('CopilotCliOtlpPlugin.isTracked', () => {
  const plugin = new CopilotCliOtlpPlugin();
  const originalSessionId = process.env.CODEMIE_SESSION_ID;

  afterEach(() => {
    if (originalSessionId === undefined) {
      delete process.env.CODEMIE_SESSION_ID;
    } else {
      process.env.CODEMIE_SESSION_ID = originalSessionId;
    }
  });

  it('is never tracked when CODEMIE_SESSION_ID is set, even if the gate would track it', async () => {
    process.env.CODEMIE_SESSION_ID = 'managed-session-1';
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: true });

    const tracked = await (plugin as unknown as { isTracked(input: unknown): Promise<boolean> }).isTracked({
      cwd: '/repo',
    });

    expect(tracked).toBe(false);
    expect(evaluateCopilotAnalyticsGate).not.toHaveBeenCalled();
  });

  it('delegates to evaluateCopilotAnalyticsGate when CODEMIE_SESSION_ID is unset', async () => {
    delete process.env.CODEMIE_SESSION_ID;
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: true });

    const tracked = await (plugin as unknown as { isTracked(input: unknown): Promise<boolean> }).isTracked({
      cwd: '/repo',
    });

    expect(tracked).toBe(true);
    expect(evaluateCopilotAnalyticsGate).toHaveBeenCalledWith('copilot-cli-otlp', '/repo');
  });

  it('is not tracked when the gate returns tracked:false', async () => {
    delete process.env.CODEMIE_SESSION_ID;
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: false, reason: 'analytics-disabled' });

    const tracked = await (plugin as unknown as { isTracked(input: unknown): Promise<boolean> }).isTracked({
      cwd: '/repo',
    });

    expect(tracked).toBe(false);
  });
});

describe('CopilotCliOtlpPlugin block-output shapes', () => {
  const plugin = new CopilotCliOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});
  const forwardOtlpEventsToSpool = vi.fn(async () => true);
  const originalSessionId = process.env.CODEMIE_SESSION_ID;

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
    delete process.env.CODEMIE_SESSION_ID;
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSessionId === undefined) {
      delete process.env.CODEMIE_SESSION_ID;
    } else {
      process.env.CODEMIE_SESSION_ID = originalSessionId;
    }
  });

  it('emits a permissionDecision:deny shape for a blocked preToolUse (SSO auth failure)', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ codemieEventName: 'preToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(captured()).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('CodeMie sign-in required'),
    });
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('emits a modifiedTransformedPrompt shape for a blocked userPromptTransformed (SSO auth failure)', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ codemieEventName: 'userPromptTransformed', prompt: 'hi' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    const output = captured();
    expect(output).toHaveProperty('modifiedTransformedPrompt');
    expect(String(output?.modifiedTransformedPrompt)).toContain('CodeMie sign-in required');
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('forwards normally (no block) when SSO auth succeeds', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: true } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ codemieEventName: 'preToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it('emits a permissionDecision:deny shape for preToolUse on internal error (not an auth-failure message)', async () => {
    vi.mocked(ConfigLoader.load).mockRejectedValueOnce(new Error('disk full'));
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ codemieEventName: 'preToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const output = captured();
    expect(output).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('internal error'),
    });
    expect(String(output?.permissionDecisionReason)).not.toContain('sign-in');
  });

  it('emits a modifiedTransformedPrompt shape for userPromptTransformed on internal error', async () => {
    vi.mocked(ConfigLoader.load).mockRejectedValueOnce(new Error('disk full'));
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ codemieEventName: 'userPromptTransformed', prompt: 'hi' }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    const output = captured();
    expect(output).toHaveProperty('modifiedTransformedPrompt');
    expect(String(output?.modifiedTransformedPrompt)).toContain('CodeMie internal error');
  });

  it('does not emit any block output for a non-enforced event on internal error (logs and swallows)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    ensureOtlpProxy.mockRejectedValueOnce(new Error('daemon start failed'));

    await plugin.processOtlpEvent(hookInput({ codemieEventName: 'postToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('logs an authentication diagnosis for an SSO block, but never for an internal error', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired' } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ codemieEventName: 'preToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining('SSO authentication is invalid (expired)'));

    vi.mocked(logger.error).mockClear();
    vi.mocked(ConfigLoader.load).mockRejectedValueOnce(new Error('disk full'));
    await plugin.processOtlpEvent(hookInput({ codemieEventName: 'preToolUse' }), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const messages = vi.mocked(logger.error).mock.calls.map((call) => String(call[0]));
    expect(messages).toEqual(expect.arrayContaining([expect.stringContaining('hook processing failed: disk full')]));
    expect(messages.some((m) => /authentication|sign-in/i.test(m))).toBe(false);
  });

  it('buildBlock without an authentication failure uses a non-auth log reason', () => {
    const block = (plugin as unknown as {
      buildBlock(event: string, reason: string, auth: boolean): { reason: string };
    }).buildBlock('preToolUse', 'an internal CodeMie error', false);

    expect(block.reason).toBe('CodeMie cannot safely process this event (an internal CodeMie error).');
  });
});

describe('CopilotCliOtlpPlugin error field mapping', () => {
  const plugin = new CopilotCliOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});
  const forwardOtlpEventsToSpool = vi.fn(async (_events: Array<Record<string, unknown>>, _agent: string) => true);
  const originalSessionId = process.env.CODEMIE_SESSION_ID;

  async function forwardedEvent(error: unknown): Promise<Record<string, unknown>> {
    await plugin.processOtlpEvent(hookInput({ codemieEventName: 'errorOccurred', error }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });
    return forwardOtlpEventsToSpool.mock.calls[0][0][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODEMIE_SESSION_ID;
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: true });
  });

  afterEach(() => {
    if (originalSessionId === undefined) {
      delete process.env.CODEMIE_SESSION_ID;
    } else {
      process.env.CODEMIE_SESSION_ID = originalSessionId;
    }
  });

  it('maps an error object to error_message and error_type, never the stack or the legacy keys', async () => {
    const event = await forwardedEvent({ message: 'boom', name: 'TypeError', stack: 'TypeError: boom\n at x' });

    expect(event).toMatchObject({ error_message: 'boom', error_type: 'TypeError' });
    expect(event).not.toHaveProperty('error');
    expect(event).not.toHaveProperty('error_name');
    expect(JSON.stringify(event)).not.toContain('at x');
  });

  it('sends a primitive error string as error_message', async () => {
    const event = await forwardedEvent('plain failure');

    expect(event.error_message).toBe('plain failure');
    expect(event).not.toHaveProperty('error_type');
  });

  it('keeps the 300-character limit on error_message and error_type, masking a secret that straddles the cut', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; // gitleaks:allow
    const event = await forwardedEvent({ message: `${'m'.repeat(280)} ${secret} ${'m'.repeat(700)}`, name: 'n'.repeat(1000) });

    expect(String(event.error_message)).toHaveLength(300);
    expect(String(event.error_type)).toHaveLength(300);
    expect(String(event.error_message)).toContain('[REDACTED]');
    expect(JSON.stringify(event)).not.toContain('ghp_');
  });

  it('omits error_type when the error object has no string name', async () => {
    const event = await forwardedEvent({ message: 'boom', name: 42 });

    expect(event.error_message).toBe('boom');
    expect(event).not.toHaveProperty('error_type');
  });
});

describe('CopilotCliOtlpPlugin free-text field masking', () => {
  const plugin = new CopilotCliOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});
  const forwardOtlpEventsToSpool = vi.fn(async (_events: Array<Record<string, unknown>>, _agent: string) => true);
  const originalSessionId = process.env.CODEMIE_SESSION_ID;
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; // gitleaks:allow

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODEMIE_SESSION_ID;
    vi.mocked(evaluateCopilotAnalyticsGate).mockResolvedValue({ tracked: true });
  });

  afterEach(() => {
    if (originalSessionId === undefined) {
      delete process.env.CODEMIE_SESSION_ID;
    } else {
      process.env.CODEMIE_SESSION_ID = originalSessionId;
    }
  });

  // [native field, forwarded field, hook event it arrives on]
  it.each([
    ['source', 'source', 'sessionStart'],
    ['reason', 'reason', 'agentStop'],
    ['errorContext', 'error_context', 'errorOccurred'],
    ['trigger', 'trigger', 'preCompact'],
    ['title', 'title', 'notification'],
    ['message', 'message', 'notification'],
  ])('masks a secret in %s, forwarded as %s on %s', async (nativeField, forwardedField, eventName) => {
    await plugin.processOtlpEvent(hookInput({ codemieEventName: eventName, [nativeField]: `ask ${secret} now` }), {
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    const event = forwardOtlpEventsToSpool.mock.calls[0][0][0];
    expect(event[forwardedField]).toBe('ask [REDACTED] now');
    expect(JSON.stringify(event)).not.toContain(secret);
  });
});
