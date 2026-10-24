import { describe, it, expect } from 'vitest';
import { buildClaudeEventId } from '../claude-code-otlp.event-id.js';

/** The built event supplies type/session; the payload is the record before enrichment. */
const event = (type: string, sessionId = 's1') => ({ type, session_id: sessionId });

describe('buildClaudeEventId', () => {
  it('builds <type>:<session_id>:<discriminator>', () => {
    expect(buildClaudeEventId(event('agent.session.env'), { provider: 'anthropic' }, 't')).toMatch(
      /^agent\.session\.env:s1:[0-9a-f]{64}$/
    );
  });

  it('content-hashes agent.session.env with the hook time, so a later snapshot is not deduped as stale', () => {
    const snapshot = { provider: 'anthropic', configured_model: 'm' };

    const first = buildClaudeEventId(event('agent.session.env'), snapshot, 't1');
    // An exact resend (same built record) keeps its id; a new occurrence gets a fresh one, so the
    // backend stores it and keeps the latest value by timestamp.
    expect(buildClaudeEventId(event('agent.session.env'), snapshot, 't1')).toBe(first);
    expect(buildClaudeEventId(event('agent.session.env'), snapshot, 't2')).not.toBe(first);
  });

  it('gives a newer version of every growing record a new id (usage.request, subagent.usage, session.env)', () => {
    const usageBefore = {
      request_id: 'req_a',
      model: 'claude-sonnet-4-5-20250929',
      output_tokens: 10,
      timestamp: '2026-10-01T00:00:00.000Z',
    };
    const subagentBefore = { agent_id: 'a1', api_calls: 1, ended_at: '2026-10-01T00:00:00.000Z' };
    const envBefore = { configured_model: 'opus' };

    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['agent.usage.request', usageBefore, { ...usageBefore, output_tokens: 40 }],
      ['agent.subagent.usage', subagentBefore, { ...subagentBefore, api_calls: 2, ended_at: '2026-10-01T00:05:00.000Z' }],
      ['agent.session.env', envBefore, { configured_model: 'sonnet' }],
    ];

    for (const [type, before, after] of cases) {
      const beforeId = buildClaudeEventId(event(type), before, 't');
      // An exact resend of the earlier record still reuses its id...
      expect(buildClaudeEventId(event(type), before, 't')).toBe(beforeId);
      // ...while a newer version must be stored as a new record.
      expect(buildClaudeEventId(event(type), after, 't')).not.toBe(beforeId);
    }
  });

  it('keys agent.git.snapshot by git_head_end, falling back to the content hash without one', () => {
    expect(buildClaudeEventId(event('agent.git.snapshot'), { git_head_end: 'abc123' }, 't')).toBe(
      'agent.git.snapshot:s1:git-snapshot:abc123'
    );
    expect(buildClaudeEventId(event('agent.git.snapshot'), { git_head_end: '' }, 't')).toMatch(
      /^agent\.git\.snapshot:s1:[0-9a-f]{64}$/
    );
  });

  it('keys agent.session.summary by phase and ended_at', () => {
    const timestamp = '2026-10-01T00:00:00.000Z';

    expect(buildClaudeEventId(event('agent.session.summary'), { is_final: true, timestamp }, 't')).toBe(
      `agent.session.summary:s1:summary:final:${timestamp}`
    );
    expect(buildClaudeEventId(event('agent.session.summary'), { is_final: false, timestamp }, 't')).toBe(
      `agent.session.summary:s1:summary:incremental:${timestamp}`
    );
  });

  it('keys agent.session.compact.done by its boundary timestamp', () => {
    expect(
      buildClaudeEventId(event('agent.session.compact.done'), { timestamp: '2026-10-01T00:10:00.000Z' }, 't')
    ).toBe('agent.session.compact.done:s1:compact-done:2026-10-01T00:10:00.000Z');
  });

  it('content-hashes a native hook event: same payload + timestamp matches, a new hook time does not', () => {
    const payload = { tool_name: 'Read', tool_use_id: 'tu-1' };

    const first = buildClaudeEventId(event('agent.tool.start'), payload, 't1');
    expect(first).toMatch(/^agent\.tool\.start:s1:[0-9a-f]{64}$/);
    expect(buildClaudeEventId(event('agent.tool.start'), payload, 't1')).toBe(first);
    expect(buildClaudeEventId(event('agent.tool.start'), payload, 't2')).not.toBe(first);
  });

  it('content-hashes an event type without a template', () => {
    expect(buildClaudeEventId(event('agent.event'), { a: 1 }, 't')).toMatch(/^agent\.event:s1:[0-9a-f]{64}$/);
  });
});
