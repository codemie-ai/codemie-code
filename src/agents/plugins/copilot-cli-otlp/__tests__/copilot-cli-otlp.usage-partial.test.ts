import { describe, it, expect } from 'vitest';
import { buildUsageRows } from '../copilot-cli-otlp.request-usage.js';
import { buildToolEvent, extractEndCall } from '../copilot-cli-otlp.tool-payload.js';
import type { CopilotEvent } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';
import type { CopilotCliHookInput } from '../copilot-cli-otlp.types.js';

const SID = '11111111-1111-4111-8111-111111111111';

const message = (id: string, output: number): CopilotEvent =>
  ({ type: 'assistant.message', timestamp: '2026-11-01T10:00:00.000Z', data: { messageId: id, model: 'gpt-5', outputTokens: output } }) as CopilotEvent;

const shutdown = (count: number): CopilotEvent =>
  ({
    type: 'session.shutdown',
    timestamp: '2026-11-01T10:05:00.000Z',
    data: { modelMetrics: { 'gpt-5': { requests: { count }, usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 100 } } } },
  }) as CopilotEvent;

describe('usage_partial on agent.usage.request rows', () => {
  it('flags every Tier B row of an incremental slice, which carries no totals', () => {
    const { rows } = buildUsageRows(SID, [message('m1', 10), message('m2', 20)], 'incremental');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r['usage_partial'] === true)).toBe(true);
  });

  it('flags Tier B rows of a segment that has no shutdown (killed session)', () => {
    const { rows } = buildUsageRows(SID, [message('m1', 10), message('m2', 20)], 'full');
    expect(rows.every((r) => r['usage_partial'] === true)).toBe(true);
  });

  it('flags only rows without totals once the shutdown closed the segment', () => {
    const { rows, partial } = buildUsageRows(SID, [message('m1', 10), message('m2', 20), shutdown(2)], 'full');
    expect(partial).toBe(false);
    const byId = Object.fromEntries(rows.map((r) => [String(r['request_id']), r]));
    expect(byId['m2']['usage_partial']).toBeUndefined();
    expect(Number(byId['m2']['input_tokens']) + Number(byId['m2']['cache_read_tokens'])).toBeGreaterThan(0);
    expect(byId['m1']['usage_partial']).toBeUndefined();
  });

  it('flags rows whose shutdown totals could not be attributed to messages', () => {
    const { rows, partial } = buildUsageRows(SID, [message('m1', 10), message('m2', 20), shutdown(7)], 'full');
    expect(partial).toBe(true);
    expect(rows.every((r) => r['usage_partial'] === true)).toBe(true);
  });

  it('leaves Tier A rows unflagged', () => {
    const record = {
      type: 'session.usage_record',
      timestamp: '2026-11-01T10:00:00.000Z',
      data: { usage: { apiCallId: 'call-1', model: 'gpt-5', inputTokens: 10, outputTokens: 5 } },
    } as CopilotEvent;
    const { rows } = buildUsageRows(SID, [record], 'incremental');
    expect(rows).toHaveLength(1);
    expect(rows[0]['usage_partial']).toBeUndefined();
  });
});

describe('buildToolEvent failure handling', () => {
  const hook = (overrides: Partial<CopilotCliHookInput>): CopilotCliHookInput =>
    ({ sessionId: SID, cwd: '/repo', codemieEventName: 'postToolUse', toolName: 'bash', toolArgs: {}, ...overrides }) as CopilotCliHookInput;
  const base = { session_id: SID, type: 'agent.tool.end' };

  it.each(['denied', 'rejected', 'failure'])('reports resultType %s as agent.tool.error', (resultType) => {
    const input = hook({ toolResult: { resultType, textResultForLlm: 'x' } } as Partial<CopilotCliHookInput>);
    const event = buildToolEvent(base, 'bash', {}, { toolUseId: 't1', end: extractEndCall(input) });
    expect(event['type']).toBe('agent.tool.error');
  });

  it('keeps agent.tool.end for a successful call', () => {
    const input = hook({ toolResult: { resultType: 'success', textResultForLlm: 'ok' } } as Partial<CopilotCliHookInput>);
    const event = buildToolEvent(base, 'bash', {}, { toolUseId: 't1', end: extractEndCall(input) });
    expect(event['type']).toBe('agent.tool.end');
  });

  it('drops the hook error text for a credential file', () => {
    const input = hook({ codemieEventName: 'postToolUseFailure', toolName: 'edit', toolArgs: { path: '/home/u/.env' }, error: 'API_KEY=abc' } as Partial<CopilotCliHookInput>);
    const event = buildToolEvent(
      { ...base, error_message: 'API_KEY=abc', error_context: 'ctx' },
      'edit',
      { path: '/home/u/.env' },
      { toolUseId: 't1', end: extractEndCall(input) }
    );
    expect(event['error_message']).toBeUndefined();
    expect(event['error_context']).toBeUndefined();
    expect(event['tool_input']).toEqual({ path: '/home/u/.env' });
  });
});
