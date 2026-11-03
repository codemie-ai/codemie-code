/**
 * The hook command delegates analytics agents to processOtlpEvent and hands it
 * the ensureOtlpProxy callback.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('../proxy/connect-orchestrator.js', () => ({ ensureOtlpProxy: vi.fn() }));

const readAnalyticsCookieAuth = vi.hoisted(() => vi.fn());
const metricsSenderOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const sendSessionStart = vi.hoisted(() => vi.fn());
const sendSessionEnd = vi.hoisted(() => vi.fn());

vi.mock('@/providers/plugins/sso/session/cookie-auth.js', () => ({ readAnalyticsCookieAuth }));
vi.mock('@/providers/plugins/sso/index.js', () => ({
  MetricsSender: vi.fn(function (this: Record<string, unknown>, options: Record<string, unknown>) {
    metricsSenderOptions.push(options);
    this.sendSessionStart = sendSessionStart;
    this.sendSessionEnd = sendSessionEnd;
  }),
}));

import { writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHookCommand, processEvent } from '../hook.js';
import type { HookProcessingConfig } from '../hook.js';
import { getSessionPath } from '@/agents/core/session/session-config.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import type { BaseHookEvent } from '@/agents/core/types.js';
import { ensureOtlpProxy } from '../proxy/connect-orchestrator.js';
import { forwardOtlpEventsToSpool } from '@/agents/plugins/utils.js';
import { AgentRegistry } from '../../../agents/registry.js';
import { OtlpAgentAdapter } from '@/agents/core/OtlpAgentAdapter.js';
import type { ForwardDecision, OtlpHookContext } from '@/agents/core/OtlpAgentAdapter.js';

class TrackedNoopAdapter extends OtlpAgentAdapter<{ cwd: string }> {
  readonly name = 'fake-tracked';
  protected parseHookInput(raw: string) {
    return JSON.parse(raw) as { cwd: string };
  }
  protected extractHookContext(input: { cwd: string }): OtlpHookContext {
    return { cwd: input.cwd };
  }
  protected async isTracked(): Promise<boolean> {
    return true;
  }
  protected async evaluate(): Promise<ForwardDecision> {
    return { decision: 'forward', payload: [] };
  }
  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return {};
  }
  protected resolveEventType(): string {
    return 'fake.event';
  }
}

describe('hook command analytics wiring', () => {
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: '/w/a' })]),
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('calls processOtlpEvent with the parsed input and { ensureOtlpProxy, forwardOtlpEventsToSpool }', async () => {
    const processOtlpEvent = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(AgentRegistry, 'getAnalyticsAgent').mockReturnValue({ processOtlpEvent } as never);

    await createHookCommand().parseAsync(['--agent', 'claude-code-otlp'], { from: 'user' });

    expect(AgentRegistry.getAnalyticsAgent).toHaveBeenCalledWith('claude-code-otlp');
    expect(processOtlpEvent).toHaveBeenCalledTimes(1);
    const [input, deps] = processOtlpEvent.mock.calls[0];
    expect(JSON.parse(input as string)).toMatchObject({ hook_event_name: 'UserPromptSubmit' });
    expect(deps).toEqual({ ensureOtlpProxy, forwardOtlpEventsToSpool });
    expect((deps as { ensureOtlpProxy: unknown }).ensureOtlpProxy).toBe(ensureOtlpProxy);
  });

  it('keeps process.exitCode at 0 when ensureOtlpProxy rejects (daemon start failure)', async () => {
    vi.mocked(ensureOtlpProxy).mockRejectedValueOnce(new Error('Daemon failed to start within 5 seconds'));
    vi.spyOn(AgentRegistry, 'getAnalyticsAgent').mockReturnValue(new TrackedNoopAdapter());

    await createHookCommand().parseAsync(['--agent', 'claude-code-otlp'], { from: 'user' });

    expect(process.exitCode).toBe(0);
  });
});

describe('hook command stored-credentials wiring', () => {
  const superseded = vi.fn().mockResolvedValue(false);
  const TMP = join(tmpdir(), `codemie-hook-wiring-${process.pid}`);
  let codemieHome: string;
  let previousHome: string | undefined;
  const baseConfig = {
    agentName: 'claude',
    provider: 'ai-run-sso',
    ssoUrl: 'https://sso.example.invalid',
    syncApiUrl: 'https://api.example.invalid',
    env: { SOME_ENV: 'x' } as NodeJS.ProcessEnv,
  };
  const providerArgs = { provider: 'ai-run-sso' };

  beforeEach(() => {
    vi.clearAllMocks();
    metricsSenderOptions.length = 0;
    previousHome = process.env.CODEMIE_HOME;
    codemieHome = mkdtempSync(join(tmpdir(), 'codemie-hook-wiring-home-'));
    process.env.CODEMIE_HOME = codemieHome;
    mkdirSync(TMP, { recursive: true });
    mkdirSync(getCodemiePath('sessions'), { recursive: true });
    readAnalyticsCookieAuth.mockResolvedValue({ cookies: 'a=1; b=2', credentialsSuperseded: superseded });
  });

  afterEach(async () => {
    rmSync(TMP, { recursive: true, force: true });
    if (previousHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = previousHome;
    }
    // The logger keeps its log file open under the temp home; Windows cannot remove the folder until it is released.
    await logger.close();
    rmSync(codemieHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.restoreAllMocks();
  });

  async function runSessionStart(sessionId: string, config: Partial<HookProcessingConfig> = {}): Promise<void> {
    const transcript = join(TMP, `${sessionId}.jsonl`);
    writeFileSync(transcript, '{"type":"user"}\n');
    rmSync(getSessionPath(sessionId), { force: true });
    const event = {
      session_id: `agent-${sessionId}`,
      hook_event_name: 'SessionStart',
      transcript_path: transcript,
      permission_mode: 'default',
      cwd: process.cwd(),
      source: 'startup',
    } as unknown as BaseHookEvent;
    await processEvent(event, { ...baseConfig, sessionId, ...config });
  }

  async function runSessionEnd(sessionId: string, config: Partial<HookProcessingConfig> = {}): Promise<void> {
    rmSync(getSessionPath(sessionId), { force: true });
    writeFileSync(
      getSessionPath(sessionId),
      JSON.stringify({
        sessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now() - 1000,
        workingDirectory: process.cwd(),
        status: 'active',
        activeDurationMs: 0,
        correlation: { status: 'matched', agentSessionId: `agent-${sessionId}`, agentSessionFile: join(TMP, 'x.jsonl'), retryCount: 0 },
      })
    );
    const event = {
      session_id: `agent-${sessionId}`,
      hook_event_name: 'SessionEnd',
      transcript_path: join(TMP, 'x.jsonl'),
      permission_mode: 'default',
      cwd: process.cwd(),
      reason: 'exit',
    } as unknown as BaseHookEvent;
    await processEvent(event, { ...baseConfig, sessionId, ...config });
  }

  async function runStop(sessionId: string, config: Partial<HookProcessingConfig> = {}): Promise<Record<string, unknown>> {
    const processSession = vi.fn().mockResolvedValue({ success: true, totalRecords: 0, failedProcessors: [], processors: {} });
    vi.spyOn(AgentRegistry, 'getAgent').mockReturnValue({ getSessionAdapter: () => ({ processSession }) } as never);
    const event = {
      session_id: `agent-${sessionId}`,
      hook_event_name: 'Stop',
      transcript_path: join(TMP, 'x.jsonl'),
      permission_mode: 'default',
      cwd: process.cwd(),
    } as unknown as BaseHookEvent;
    await processEvent(event, { ...baseConfig, sessionId, apiBaseUrl: 'https://api.example.invalid', ...config });
    expect(processSession).toHaveBeenCalled();
    return processSession.mock.calls[0][2] as Record<string, unknown>;
  }

  it('sync context takes cookies and the superseded callback from the helper', async () => {
    const context = await runStop('wiring-sync');

    expect(readAnalyticsCookieAuth).toHaveBeenCalledWith(baseConfig.ssoUrl, baseConfig.env, providerArgs);
    expect(context.cookies).toBe('a=1; b=2');
    expect(context.credentialsSuperseded).toBe(superseded);
  });

  it('sync context with preset cookies reads nothing and carries no callback', async () => {
    const context = await runStop('wiring-sync-preset', { cookies: 'preset=1' });

    expect(readAnalyticsCookieAuth).not.toHaveBeenCalled();
    expect(context.cookies).toBe('preset=1');
    expect(context.credentialsSuperseded).toBeUndefined();
  });

  it('sync context with an API key carries no callback', async () => {
    const context = await runStop('wiring-sync-apikey', { apiKey: 'local-key' });

    expect(context.apiKey).toBe('local-key');
    expect(context.credentialsSuperseded).toBeUndefined();
  });

  it('sync context stays empty when the helper finds nothing', async () => {
    readAnalyticsCookieAuth.mockResolvedValue({ cookies: '', credentialsSuperseded: superseded });

    const context = await runStop('wiring-sync-empty');

    expect(context.cookies).toBe('');
  });

  it('SessionStart sender takes cookies and the callback from the helper', async () => {
    await runSessionStart('wiring-start');

    expect(readAnalyticsCookieAuth).toHaveBeenCalledWith(baseConfig.ssoUrl, baseConfig.env, providerArgs);
    expect(metricsSenderOptions).toHaveLength(1);
    expect(metricsSenderOptions[0]).toMatchObject({ cookies: 'a=1; b=2', credentialsSuperseded: superseded });
    expect(sendSessionStart).toHaveBeenCalledTimes(1);
  });

  it('SessionStart with preset cookies uses them and carries no callback', async () => {
    await runSessionStart('wiring-start-preset', { cookies: 'preset=1' });

    expect(readAnalyticsCookieAuth).not.toHaveBeenCalled();
    expect(metricsSenderOptions[0]).toMatchObject({ cookies: 'preset=1' });
    expect(metricsSenderOptions[0].credentialsSuperseded).toBeUndefined();
  });

  it('SessionStart sends nothing when the helper finds no cookies', async () => {
    readAnalyticsCookieAuth.mockResolvedValue({ cookies: '', credentialsSuperseded: superseded });

    await runSessionStart('wiring-start-empty');

    expect(metricsSenderOptions).toHaveLength(0);
    expect(sendSessionStart).not.toHaveBeenCalled();
  });

  it('SessionEnd sender takes cookies and the callback from the helper', async () => {
    await runSessionEnd('wiring-end');

    expect(readAnalyticsCookieAuth).toHaveBeenCalledWith(baseConfig.ssoUrl, baseConfig.env, providerArgs);
    expect(metricsSenderOptions).toHaveLength(1);
    expect(metricsSenderOptions[0]).toMatchObject({ cookies: 'a=1; b=2', credentialsSuperseded: superseded });
    expect(sendSessionEnd).toHaveBeenCalledTimes(1);
  });

  it('SessionEnd with preset cookies uses them and carries no callback', async () => {
    await runSessionEnd('wiring-end-preset', { cookies: 'preset=1' });

    expect(metricsSenderOptions[0]).toMatchObject({ cookies: 'preset=1' });
    expect(metricsSenderOptions[0].credentialsSuperseded).toBeUndefined();
  });

  it('SessionEnd sends nothing when the helper finds no cookies', async () => {
    readAnalyticsCookieAuth.mockResolvedValue({ cookies: '', credentialsSuperseded: superseded });

    await runSessionEnd('wiring-end-empty');

    expect(metricsSenderOptions).toHaveLength(0);
    expect(sendSessionEnd).not.toHaveBeenCalled();
  });
});
