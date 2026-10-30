import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn(async () => ({})), getActiveProfileName: vi.fn(async () => null), hasLocalConfig: vi.fn(async () => false) },
}));
vi.mock('@/agents/core/copilot-connector-scope.js', () => ({
  isCopilotProjectTracked: vi.fn(async () => true),
  readCopilotConnectorScope: vi.fn(async () => ({ kind: 'ok', value: { enabled: true, scope: 'user' } })),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

process.env.CODEMIE_HOME = mkdtempSync(join(tmpdir(), 'cop-otlp-tools-'));
process.env.COPILOT_HOME = join(process.env.CODEMIE_HOME, 'copilot');

import { CopilotCliOtlpPlugin } from '../copilot-cli-otlp.plugin.js';
import { buildDeferredUsageEvents } from '../copilot-cli-otlp.usage.js';
import type { CopilotEvent } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('Copilot CLI tool metrics: 3 calls, 2 succeed, 1 fails', () => {
  const plugin = new CopilotCliOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});
  const forward = vi.fn(async (_events: Array<Record<string, unknown>>, _agent: string) => true);
  const originalSessionId = process.env.CODEMIE_SESSION_ID;

  const send = (codemieEventName: string, extra: Record<string, unknown>): Promise<void> =>
    plugin.processOtlpEvent(
      JSON.stringify({ sessionId: SID, cwd: '/repo', timestamp: 1700000000000, codemieEventName, ...extra }),
      { ensureOtlpProxy, forwardOtlpEventsToSpool: forward }
    );
  const forwarded = (): Array<Record<string, unknown>> => forward.mock.calls.flatMap((call) => call[0]);

  beforeEach(() => {
    forward.mockClear();
    delete process.env.CODEMIE_SESSION_ID;
  });

  afterEach(() => {
    if (originalSessionId === undefined) delete process.env.CODEMIE_SESSION_ID;
    else process.env.CODEMIE_SESSION_ID = originalSessionId;
  });

  it('emits start/end/error events with names and results through the hooks', async () => {
    const calls = [
      { id: 'c1', name: 'view', args: { path: '/repo/a.ts' } },
      { id: 'c2', name: 'bash', args: { command: 'ls' } },
      { id: 'c3', name: 'bash', args: { command: 'false' } },
    ];
    await send('preToolUse', { toolCalls: calls });
    await send('postToolUse', { toolName: 'view', toolArgs: { path: '/repo/a.ts' }, toolResult: { resultType: 'success', textResultForLlm: 'file body' } });
    await send('postToolUse', { toolName: 'bash', toolArgs: { command: 'ls' }, toolResult: { resultType: 'success', textResultForLlm: 'a.ts' } });
    await send('postToolUseFailure', { toolName: 'bash', toolArgs: { command: 'false' }, error: 'exit code 1' });

    const events = forwarded();
    const byType = (type: string) => events.filter((e) => e.type === type);
    expect(byType('agent.tool.start').map((e) => e.tool_name)).toEqual(['view', 'bash', 'bash']);
    expect(byType('agent.tool.end').map((e) => [e.tool_name, e.tool_response])).toEqual([
      ['view', 'file body'],
      ['bash', 'a.ts'],
    ]);
    const failures = byType('agent.tool.error');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ tool_name: 'bash', error_message: 'exit code 1' });
    expect(byType('agent.tool.end').map((e) => e.tool_use_id)).toEqual(['c1', 'c2']);
    expect(failures[0].tool_use_id).toBe('c3');
  });

  it('reports tool_calls, tool_errors and per-tool counts in the session summary', () => {
    const ev = (type: string, data: Record<string, unknown>, at: number): CopilotEvent =>
      ({ type, timestamp: new Date(1700000000000 + at).toISOString(), data }) as CopilotEvent;
    const transcript = [
      ev('session.start', { sessionId: SID, startTime: new Date(1700000000000).toISOString() }, 0),
      ev('tool.execution_start', { toolCallId: 'c1', toolName: 'view', arguments: { path: '/repo/a.ts' } }, 1),
      ev('tool.execution_complete', { toolCallId: 'c1', success: true }, 2),
      ev('tool.execution_start', { toolCallId: 'c2', toolName: 'bash', arguments: { command: 'ls' } }, 3),
      ev('tool.execution_complete', { toolCallId: 'c2', success: true }, 4),
      ev('tool.execution_start', { toolCallId: 'c3', toolName: 'bash', arguments: { command: 'false' } }, 5),
      ev('tool.execution_complete', { toolCallId: 'c3', success: false, error: { message: 'exit code 1' } }, 6),
    ];

    const summary = buildDeferredUsageEvents({ session_id: SID }, transcript).find((e) => e.type === 'agent.session.summary');

    expect(summary).toMatchObject({
      tool_calls: 3,
      tool_errors: 1,
      tools: { view: { calls: 1, errors: 0 }, bash: { calls: 2, errors: 1 } },
    });
  });
});

describe('Copilot CLI slash commands through the hook', () => {
  const plugin = new CopilotCliOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});
  const forward = vi.fn(async (_events: Array<Record<string, unknown>>, _agent: string) => true);

  const prompt = async (extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
    forward.mockClear();
    await plugin.processOtlpEvent(
      JSON.stringify({ sessionId: SID, cwd: '/repo', timestamp: 1700000000000, codemieEventName: 'userPromptTransformed', ...extra }),
      { ensureOtlpProxy, forwardOtlpEventsToSpool: forward }
    );
    return forward.mock.calls[0][0][0];
  };

  it('sets command_name and shows the command as the prompt for an internal slash instruction', async () => {
    const event = await prompt({
      prompt: '/review',
      transformedPrompt: 'The user has requested a review via the /review command. Use the task tool.',
    });

    expect(event.command_name).toBe('review');
    expect(event.prompt).toBe('/review');
  });

  it('sets no command_name for a plain prompt or a path-like prompt', async () => {
    expect(await prompt({ prompt: 'explain this function' })).not.toHaveProperty('command_name');
    expect(await prompt({ prompt: '/tmp is full' })).not.toHaveProperty('command_name');
  });
});
