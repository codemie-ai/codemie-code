/**
 * The hook command delegates analytics agents to processOtlpEvent and hands it
 * the ensureOtlpProxy callback.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('../proxy/connect-orchestrator.js', () => ({ ensureOtlpProxy: vi.fn() }));

import { createHookCommand } from '../hook.js';
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
