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
import { AgentRegistry } from '../../../agents/registry.js';

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

  it('calls processOtlpEvent with the parsed input and { ensureOtlpProxy }', async () => {
    const processOtlpEvent = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(AgentRegistry, 'getAnalyticsAgent').mockReturnValue({ processOtlpEvent } as never);

    await createHookCommand().parseAsync(['--agent', 'claude-code-otlp'], { from: 'user' });

    expect(AgentRegistry.getAnalyticsAgent).toHaveBeenCalledWith('claude-code-otlp');
    expect(processOtlpEvent).toHaveBeenCalledTimes(1);
    const [input, deps] = processOtlpEvent.mock.calls[0];
    expect(JSON.parse(input as string)).toMatchObject({ hook_event_name: 'UserPromptSubmit' });
    expect(deps).toEqual({ ensureOtlpProxy });
    expect((deps as { ensureOtlpProxy: unknown }).ensureOtlpProxy).toBe(ensureOtlpProxy);
  });
});
