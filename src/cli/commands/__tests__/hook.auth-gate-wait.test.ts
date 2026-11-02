/**
 * The UserPromptSubmit auth gate waits for a gate-started sign-in only for agents whose hook can
 * hold the prompt (claude, gemini); every other path keeps blocking with manual-resume text.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({
  ensureCodeMieSsoAuth: vi.fn(),
  ensureCodeMieSsoAuthOrWait: vi.fn(),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    close: vi.fn(),
    setAgentName: vi.fn(),
    setSessionId: vi.fn(),
    setProfileName: vi.fn(),
  },
}));
vi.mock('@/agents/core/session/SessionStore.js', () => ({
  SessionStore: vi.fn(function () {
    return { startActivityTracking: vi.fn(), loadSession: vi.fn(async () => null) };
  }),
}));

import { processEvent } from '../hook.js';
import { ensureCodeMieSsoAuth, ensureCodeMieSsoAuthOrWait } from '@/providers/plugins/sso/sso.auth-gate.js';
import type { BaseHookEvent } from '@/agents/core/types.js';

const promptEvent = (hookEventName = 'UserPromptSubmit'): BaseHookEvent =>
  ({ session_id: 'agent-session-1234', hook_event_name: hookEventName, transcript_path: '/tmp/t.jsonl' }) as BaseHookEvent;

const blocked = {
  ok: false as const,
  reason: 'no valid CodeMie SSO credentials found',
  loginOutcome: 'started' as const,
};

describe('UserPromptSubmit auth gate wait', () => {
  const originalEnv = { ...process.env };
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CODEMIE_SESSION_ID = 'codemie-session-1234';
    process.env.CODEMIE_PROVIDER = 'ai-run-sso';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  const stderr = (): string => stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');

  it.each([
    ['claude', 'UserPromptSubmit'],
    ['gemini', 'BeforeAgent'],
  ])('%s waits via the wrapper and an ok result lets the prompt through', async (agent, eventName) => {
    process.env.CODEMIE_AGENT = agent;
    vi.mocked(ensureCodeMieSsoAuthOrWait).mockResolvedValue({ ok: true });

    await processEvent(promptEvent(eventName));

    expect(ensureCodeMieSsoAuthOrWait).toHaveBeenCalledTimes(1);
    expect(ensureCodeMieSsoAuth).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalledWith(2);
  });

  it('blocks with the child error and re-send text when the wait fails', async () => {
    process.env.CODEMIE_AGENT = 'claude';
    vi.mocked(ensureCodeMieSsoAuthOrWait).mockResolvedValue({
      ...blocked,
      waitResult: { status: 'failed', error: 'Authentication cancelled by user' },
    });

    await processEvent(promptEvent());

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stderr()).toContain('Authentication cancelled by user');
    expect(stderr()).toContain('re-send your prompt');
  });

  it.each([['kimi'], ['opencode'], ['codemie-code']])('%s does not wait and tells the user to re-send', async (agent) => {
    process.env.CODEMIE_AGENT = agent;
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue(blocked);

    await processEvent(promptEvent());

    expect(ensureCodeMieSsoAuthOrWait).not.toHaveBeenCalled();
    expect(ensureCodeMieSsoAuth).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stderr()).toContain('re-send your prompt');
  });

  it('programmatic mode throws without waiting', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue(blocked);

    await expect(
      processEvent(promptEvent(), {
        agentName: 'claude',
        sessionId: 'codemie-session-1234',
        provider: 'ai-run-sso',
      } as never)
    ).rejects.toThrow('re-send your prompt');
    expect(ensureCodeMieSsoAuthOrWait).not.toHaveBeenCalled();
  });
});
