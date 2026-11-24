import { describe, it, expect } from 'vitest';
import { buildUnhookedToolEvents } from '../copilot-cli-otlp.unhooked-tools.js';
import { buildDeferredUsageEvents, summarizeSlice } from '../copilot-cli-otlp.usage.js';
import type { CopilotEvent } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const at = (ms: number): string => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();

const ev = (type: string, data: Record<string, unknown>, ms: number, extra: Partial<CopilotEvent> = {}): CopilotEvent =>
  ({ type, timestamp: at(ms), data, ...extra }) as CopilotEvent;

const hookedPre = (toolCallId: string, ms: number): CopilotEvent =>
  ev('hook.start', { hookType: 'preToolUse', input: { toolCallId } }, ms);
const start = (toolCallId: string, toolName: string, args: unknown, ms: number, extra: Partial<CopilotEvent> = {}): CopilotEvent =>
  ev('tool.execution_start', { toolCallId, toolName, arguments: args }, ms, extra);
const complete = (toolCallId: string, ms: number, data: Record<string, unknown> = { success: true }): CopilotEvent =>
  ev('tool.execution_complete', { toolCallId, ...data }, ms);

describe('buildUnhookedToolEvents', () => {
  it('emits start and end events only for calls without a preToolUse hook', () => {
    const events = [
      hookedPre('hooked-1', 1),
      start('hooked-1', 'view', { path: '/repo/a.ts' }, 2),
      complete('hooked-1', 3),
      start('runtime-1', 'read_agent', { agent_id: 'agent-0' }, 4),
      complete('runtime-1', 5, { success: true, result: { content: 'agent output' } }),
    ];

    const out = buildUnhookedToolEvents(SID, events);

    expect(out.map((e) => [e['type'], e['tool_use_id']])).toEqual([
      ['agent.tool.start', 'runtime-1'],
      ['agent.tool.end', 'runtime-1'],
    ]);
    expect(out[0]).toMatchObject({ session_id: SID, tool_name: 'read_agent', timestamp: at(4) });
    expect(out[1]).toMatchObject({ tool_response: 'agent output', timestamp: at(5) });
  });

  it('recognises hooked calls from a batched preToolUse input as well', () => {
    const events = [
      ev('hook.start', { hookType: 'preToolUse', input: { toolCalls: [{ id: 'b1' }, { id: 'b2' }] } }, 1),
      start('b1', 'view', {}, 2),
      start('b2', 'bash', {}, 3),
      start('runtime-1', 'read_powershell', { shellId: '1' }, 4),
    ];

    expect(buildUnhookedToolEvents(SID, events).map((e) => e['tool_use_id'])).toEqual(['runtime-1']);
  });

  it('turns a failed completion into an agent.tool.error with its message', () => {
    const events = [
      hookedPre('hooked-1', 1),
      start('runtime-1', 'read_powershell', {}, 2),
      complete('runtime-1', 3, { success: false, error: { message: 'shell is gone' } }),
    ];

    const out = buildUnhookedToolEvents(SID, events);

    expect(out.map((e) => e['type'])).toEqual(['agent.tool.start', 'agent.tool.error']);
    expect(out[1]).toMatchObject({ tool_use_id: 'runtime-1', error_message: 'shell is gone' });
  });

  it('emits only the start for a call that has not completed yet', () => {
    const events = [hookedPre('hooked-1', 1), start('runtime-1', 'read_agent', {}, 2)];

    expect(buildUnhookedToolEvents(SID, events).map((e) => e['type'])).toEqual(['agent.tool.start']);
  });

  it('builds nothing when the transcript shows no tool hook at all', () => {
    const events = [start('c1', 'view', {}, 1), complete('c1', 2)];

    expect(buildUnhookedToolEvents(SID, events)).toEqual([]);
  });

  it('gives every event a stable id that differs per type and per call and survives a repeated pass', () => {
    const events = [
      hookedPre('hooked-1', 1),
      start('r1', 'read_agent', {}, 2),
      complete('r1', 3),
      start('r2', 'read_agent', {}, 4),
      complete('r2', 5),
    ];

    const first = buildUnhookedToolEvents(SID, events).map((e) => e['event_id']);
    const second = buildUnhookedToolEvents(SID, events).map((e) => e['event_id']);

    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(4);
  });

  it('carries the sub-agent id only when the transcript event has one', () => {
    const events = [
      hookedPre('hooked-1', 1),
      start('r1', 'read_agent', {}, 2, { agentId: 'agent-0001' }),
      start('r2', 'read_agent', {}, 3),
    ];

    const out = buildUnhookedToolEvents(SID, events);

    expect(out[0]).toMatchObject({ agent_id: 'agent-0001' });
    expect(out[1]).not.toHaveProperty('agent_id');
  });

  it('cuts long tool input to the hook path\'s field limit', () => {
    const events = [
      hookedPre('hooked-1', 1),
      start('r1', 'bash', { command: `echo ${'x'.repeat(1000)}` }, 2),
    ];

    const [startEvent] = buildUnhookedToolEvents(SID, events);

    expect(String(startEvent['tool_input']).length).toBeLessThanOrEqual(300);
  });
});

describe('Copilot final pass with hook-less tool calls', () => {
  const transcript = [
    ev('session.start', { sessionId: SID, startTime: at(0) }, 0),
    hookedPre('t1', 1),
    start('t1', 'view', { path: '/repo/a.ts' }, 2),
    complete('t1', 3),
    start('t2', 'read_agent', {}, 4),
    complete('t2', 5),
    ev('session.shutdown', { modelMetrics: {} }, 6),
  ];

  it('adds the backfilled tool events so Session Detail matches the summary tool_calls', () => {
    const wire = buildDeferredUsageEvents({ session_id: SID }, transcript);

    const toolStarts = wire.filter((e) => e['type'] === 'agent.tool.start');
    const summary = wire.find((e) => e['type'] === 'agent.session.summary');
    expect(toolStarts.map((e) => e['tool_use_id'])).toEqual(['t2']);
    expect(summary).toMatchObject({ tool_calls: 2 });
  });

  it('builds no tool events from a tail-only transcript', () => {
    const wire = buildDeferredUsageEvents({ session_id: SID }, transcript, '', { truncated: true });

    expect(wire.some((e) => String(e['type']).startsWith('agent.tool.'))).toBe(false);
  });
});

describe('Copilot summary turns', () => {
  const user = (text: string, ms: number, source?: string): CopilotEvent =>
    ev('user.message', { content: text, ...(source ? { source } : {}) }, ms);

  it('counts only the user\'s own prompts, not the ones injected for sub-agents', () => {
    const events = [
      user('review my branch', 1),
      user('Review the current branch changes', 2, `agent-${SID}`),
      user('Perform a security-focused review', 3, `agent-${SID}`),
      user('thanks', 4),
    ];

    expect(summarizeSlice(SID, events, 'full').counters.turns).toBe(2);
  });

  it('counts a message whose source is not a sub-agent marker', () => {
    const events = [user('hello', 1, 'user'), user('again', 2)];

    expect(summarizeSlice(SID, events, 'full').counters.turns).toBe(2);
  });

  it('does not record a slash command typed into a sub-agent prompt', () => {
    const events = [user('/review now', 1, `agent-${SID}`)];

    expect(summarizeSlice(SID, events, 'full').details.commands).toEqual([]);
  });

  it('applies the same rule to the incremental slices, so merged turns stay equal to the user prompts', () => {
    const first = summarizeSlice(SID, [user('a', 1), user('sub', 2, `agent-${SID}`)], 'incremental');
    const second = summarizeSlice(SID, [user('b', 3), user('sub', 4, `agent-${SID}`)], 'incremental');

    expect(first.counters.turns + second.counters.turns).toBe(2);
  });
});
