import { BackendPolicy } from '@/agents/core/collection-policy.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPolicy } from '@/cli/commands/shared/analytics-collection/local-policy.js';
const backendPolicy = new BackendPolicy();

vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn() }));
vi.mock('@/agents/core/hook-auth-profile.js', () => ({ resolveHookAuthProfile: vi.fn(async () => ({})) }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn(async () => ({})), getActiveProfileName: vi.fn(async () => null), hasLocalConfig: vi.fn(async () => false) },
}));
vi.mock('@/agents/core/copilot-connector-scope.js', async (importOriginal) => ({
  getCopilotConnectorsConfigPath: (await importOriginal<typeof import('@/agents/core/copilot-connector-scope.js')>()).getCopilotConnectorsConfigPath,
  isCopilotProjectTracked: vi.fn(),
  readCopilotConnectorScope: vi.fn(async () => ({ kind: 'ok', value: { enabled: true, scope: 'user' } })),
}));
vi.mock('@/agents/core/copilot-analytics-preferences.js', () => ({
  readCopilotAnalyticsPreferences: vi.fn(),
  isCopilotAnalyticsProjectExcluded: vi.fn(),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { resolveHookAuthProfile } from '@/agents/core/hook-auth-profile.js';
import { isCopilotProjectTracked, readCopilotConnectorScope } from '@/agents/core/copilot-connector-scope.js';
import {
  isCopilotAnalyticsProjectExcluded,
  readCopilotAnalyticsPreferences,
} from '@/agents/core/copilot-analytics-preferences.js';
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
    vi.mocked(readCopilotAnalyticsPreferences).mockResolvedValue({
      kind: 'ok',
      value: { enabled: true, excludedProjects: [] },
    });
    vi.mocked(isCopilotAnalyticsProjectExcluded).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a permissionDecision:deny shape for a blocked PreToolUse (SSO auth failure)', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(captured()).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('CodeMie SSO authentication'),
    });
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('states the expiry is expected and does not claim a browser opened on cooldown', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired', loginOutcome: 'cooldown' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), {
      policy: backendPolicy,
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    const stopReason = String(captured()?.stopReason);
    expect(stopReason).toContain('this is expected');
    expect(stopReason).toContain('re-send your prompt');
    expect(stopReason).not.toContain('opened automatically');
  });

  it('does not call the auth invalid when a sign-in finished moments ago', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({
      ok: false,
      reason: 'rejected',
      loginOutcome: 'signed-in-recently',
    } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), {
      policy: backendPolicy,
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    const stopReason = String(captured()?.stopReason);
    expect(stopReason).toContain('A sign-in finished moments ago');
    expect(stopReason).not.toContain('authentication is invalid');
  });

  it('emits a continue:false shape for a blocked SessionStart (SSO auth failure)', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: false, reason: 'expired' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'SessionStart' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

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
      policy: backendPolicy,
      ensureOtlpProxy,
      forwardOtlpEventsToSpool,
    });

    expect(captured()).toEqual({
      continue: false,
      stopReason: expect.stringContaining('CodeMie SSO authentication'),
    });
  });

  it('checks SSO against the session profile, not the config resolved from the current directory', async () => {
    const sessionProfile = {
      provider: 'ai-run-sso',
      ssoUrl: 'https://prod.example',
      baseUrl: 'https://prod.example/code-assistant-api',
    };
    vi.mocked(resolveHookAuthProfile).mockResolvedValueOnce(sessionProfile);
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: true } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(ensureCodeMieSsoAuth).toHaveBeenCalledWith(sessionProfile);
    // The hook must resolve the profile itself, with no cwd/env arguments that could bypass the launch profile.
    expect(resolveHookAuthProfile).toHaveBeenCalledWith();
    logSpy.mockRestore();
  });

  it('forwards normally (no block) when SSO auth succeeds', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: true } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
  });

  it('emits a permissionDecision:deny shape for PreToolUse on internal error (not an auth-failure message)', async () => {
    vi.mocked(resolveHookAuthProfile).mockRejectedValueOnce(new Error('disk full'));
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

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

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'Stop' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('untracked + corrupt connector scope: emits a block for an enforced event even though the hook is untracked', async () => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'corrupt' } as never);
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'SessionStart' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(captured()).toEqual({
      continue: false,
      stopReason: expect.stringContaining('corrupt'),
    });
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  describe('a corrupt scope file: the reason comes from the policy', () => {
    const ENFORCED = ['SessionStart', 'UserPromptSubmit', 'PreToolUse'] as const;
    const PATHS = ['untracked', 'tracked'] as const;
    let home: string;

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'copilot-chat-scope-'));
      vi.stubEnv('CODEMIE_HOME', home);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    });

    /** `untracked` — the gate reads the corrupt file; `tracked` — the gate passed and `evaluate` reads it. */
    function corruptScope(path: (typeof PATHS)[number]): void {
      if (path === 'tracked') {
        vi.mocked(readCopilotConnectorScope)
          .mockResolvedValueOnce({ kind: 'ok', value: { enabled: true, scope: 'user' } } as never)
          .mockResolvedValue({ kind: 'corrupt' } as never);
      } else {
        vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'corrupt' } as never);
      }
    }

    function reasonOf(output: Record<string, unknown> | undefined): string {
      return String(output?.permissionDecisionReason ?? output?.stopReason);
    }

    const PATH_EVENTS = PATHS.flatMap((path) => ENFORCED.map((event) => [path, event] as const));

    it.each(PATH_EVENTS)('local policy, %s path, %s: names the scope file and the install, no reconnect', async (path, event) => {
      corruptScope(path);
      const { captured } = log();

      await plugin.processOtlpEvent(hookInput({ hook_event_name: event, prompt: 'hi' }), {
        policy: new LocalPolicy(true),
        ensureOtlpProxy,
        forwardOtlpEventsToSpool,
      });

      const reason = reasonOf(captured());
      expect(reason).toBe(
        `CodeMie cannot safely process this event (connector scope configuration is corrupt; fix or delete ${join(home, 'copilot-connectors.json')} and run \`codemie analytics sync install\`). Fix the issue, then re-send your prompt.`
      );
      expect(reason).not.toContain('reconnect');
    });

    it.each(PATH_EVENTS)('backend policy, %s path, %s: today\'s reconnect reason', async (path, event) => {
      corruptScope(path);
      const { captured } = log();

      await plugin.processOtlpEvent(hookInput({ hook_event_name: event, prompt: 'hi' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

      expect(reasonOf(captured())).toBe(
        'CodeMie cannot safely process this event (connector scope configuration is corrupt; repair it and reconnect). Fix the issue, then re-send your prompt.'
      );
    });
  });

  it('untracked + corrupt connector scope: does nothing for a non-enforced event', async () => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'corrupt' } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'Stop' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('untracked + disabled connector scope: does nothing, even for an enforced event', async () => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: { enabled: false } } as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('untracked + missing identity (no session_id): emits a block for an enforced event', async () => {
    const { captured } = log();

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'UserPromptSubmit', session_id: undefined, prompt: 'hi' }), {
      policy: backendPolicy,
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
      policy: backendPolicy,
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

    await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(logSpy).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  describe('analytics preferences gate', () => {
    // CR-002: opting out of analytics must never stop the user's Copilot Chat. A block here means
    // `continue:false` (SessionStart/UserPromptSubmit) or `permissionDecision:deny` (PreToolUse).
    type OptOut = 'disabled' | 'excluded' | 'corrupt-preferences';
    const OPT_OUTS: OptOut[] = ['disabled', 'excluded', 'corrupt-preferences'];

    function applyOptOut(kind: OptOut): void {
      if (kind === 'disabled') {
        vi.mocked(readCopilotAnalyticsPreferences).mockResolvedValue({
          kind: 'ok',
          value: { enabled: false, excludedProjects: [] },
        });
      } else if (kind === 'excluded') {
        vi.mocked(isCopilotAnalyticsProjectExcluded).mockResolvedValue(true);
      } else {
        vi.mocked(readCopilotAnalyticsPreferences).mockResolvedValue({ kind: 'corrupt' });
      }
    }

    describe.each(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const)(
      '%s while analytics is opted out',
      (eventName) => {
        it.each(OPT_OUTS)('%s: emits nothing, never blocks, forwards nothing, never touches the daemon', async (kind) => {
          applyOptOut(kind);
          const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

          await plugin.processOtlpEvent(hookInput({ hook_event_name: eventName, prompt: 'hi' }), {
            policy: backendPolicy,
            ensureOtlpProxy,
            forwardOtlpEventsToSpool,
          });

          expect(logSpy).not.toHaveBeenCalled();
          expect(ensureOtlpProxy).not.toHaveBeenCalled();
          expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
        });
      }
    );

    it.each(OPT_OUTS)('%s stays silent even when the connector scope is corrupt (no scope block for an opted-out user)', async (kind) => {
      applyOptOut(kind);
      vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'corrupt' } as never);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await plugin.processOtlpEvent(hookInput({ hook_event_name: 'SessionStart' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

      expect(logSpy).not.toHaveBeenCalled();
    });

    it.each(OPT_OUTS)('%s stays silent even when the session identity is missing (no identity block for an opted-out user)', async (kind) => {
      applyOptOut(kind);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await plugin.processOtlpEvent(hookInput({ hook_event_name: 'UserPromptSubmit', session_id: undefined, prompt: 'hi' }), {
        policy: backendPolicy,
        ensureOtlpProxy,
        forwardOtlpEventsToSpool,
      });

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('stays silent for an opted-out user when the connector is not connected (scope disabled)', async () => {
      applyOptOut('disabled');
      vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: { enabled: false } } as never);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('analytics enabled and project not excluded: forwards normally, no block (default / absent preferences)', async () => {
      vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: true } as never);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await plugin.processOtlpEvent(hookInput({ hook_event_name: 'PreToolUse' }), { policy: backendPolicy, ensureOtlpProxy, forwardOtlpEventsToSpool });

      expect(logSpy).not.toHaveBeenCalled();
      expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
    });

    it('missing identity still reports the identity message when analytics is enabled (existing behavior preserved)', async () => {
      const { captured } = log();

      await plugin.processOtlpEvent(hookInput({ hook_event_name: 'UserPromptSubmit', session_id: undefined, prompt: 'hi' }), {
        policy: backendPolicy,
        ensureOtlpProxy,
        forwardOtlpEventsToSpool,
      });

      expect(captured()).toEqual({
        continue: false,
        stopReason: expect.stringContaining('identity or working directory is missing'),
      });
    });
  });

  describe('byFilter of an untracked hook', () => {
    async function untracked(raw: string): Promise<{ sessionId: string | undefined; byFilter: boolean } | undefined> {
      let seen: { sessionId: string | undefined; byFilter: boolean } | undefined;
      class RecordingPolicy extends BackendPolicy {
        override async onUntracked(sessionId: string | undefined, byFilter: boolean): Promise<void> {
          seen = { sessionId, byFilter };
        }
      }
      await plugin.processOtlpEvent(raw, { policy: new RecordingPolicy(), ensureOtlpProxy, forwardOtlpEventsToSpool });
      return seen;
    }

    it('a folder outside a project scope is the filter, under the hook\'s session id', async () => {
      vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'project' } } as never);
      vi.mocked(isCopilotProjectTracked).mockResolvedValue(false);

      await expect(untracked(hookInput({ hook_event_name: 'Stop', session_id: 'sid-7' }))).resolves.toEqual({
        sessionId: 'sid-7',
        byFilter: true,
      });
    });

    it('analytics disabled is the filter', async () => {
      vi.mocked(readCopilotAnalyticsPreferences).mockResolvedValue({ kind: 'ok', value: { enabled: false, excludedProjects: [] } });

      await expect(untracked(hookInput({ hook_event_name: 'Stop' }))).resolves.toMatchObject({ byFilter: true });
    });

    it('a hook with no cwd under a project scope is not the filter', async () => {
      vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'project' } } as never);
      vi.mocked(isCopilotProjectTracked).mockResolvedValue(false);

      await expect(untracked(hookInput({ hook_event_name: 'Stop', cwd: undefined }))).resolves.toMatchObject({ byFilter: false });
    });

    it('a hook with no session_id in an excluded project is not the filter', async () => {
      vi.mocked(isCopilotAnalyticsProjectExcluded).mockResolvedValue(true);

      await expect(untracked(hookInput({ hook_event_name: 'Stop', session_id: undefined }))).resolves.toEqual({
        sessionId: undefined,
        byFilter: false,
      });
    });

    it('a corrupt preferences file is not the filter', async () => {
      vi.mocked(readCopilotAnalyticsPreferences).mockResolvedValue({ kind: 'corrupt' });

      await expect(untracked(hookInput({ hook_event_name: 'Stop' }))).resolves.toMatchObject({ byFilter: false });
    });
  });
});
