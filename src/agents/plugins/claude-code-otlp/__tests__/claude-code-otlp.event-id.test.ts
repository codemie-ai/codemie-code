import { describe, it, expect } from 'vitest';
import { buildClaudeEventId } from '../claude-code-otlp.event-id.js';

/** The built event supplies type/session; the payload is the record before enrichment. */
const event = (type: string, sessionId = 's1') => ({ type, session_id: sessionId });

describe('buildClaudeEventId', () => {
  it('builds <type>:<session_id>:<discriminator>', () => {
    expect(buildClaudeEventId(event('agent.session.env'), { provider: 'anthropic' }, 't')).toMatch(
      /^agent\.session\.env:s1:env:[0-9a-f]{64}$/
    );
  });

  it('keys agent.session.env by its snapshot content, independent of the hook time', () => {
    const payload = { provider: 'anthropic', configured_model: 'm', mcp_servers: ['a', 'b'] };

    const first = buildClaudeEventId(event('agent.session.env'), payload, 't1');
    const second = buildClaudeEventId(event('agent.session.env'), payload, 't2');
    const changed = buildClaudeEventId(event('agent.session.env'), { ...payload, configured_model: 'other' }, 't1');

    expect(first).toBe(second);
    expect(first).not.toBe(changed);
  });

  it('ignores the envelope fields (type, session_id) in the env snapshot hash', () => {
    const fields = { provider: 'anthropic' };

    expect(
      buildClaudeEventId(event('agent.session.env'), { type: 'agent.session.env', session_id: 's1', ...fields }, 't')
    ).toBe(buildClaudeEventId(event('agent.session.env'), fields, 't'));
  });

  it('keys agent.git.snapshot by git_head_end, falling back to the content hash without one', () => {
    expect(buildClaudeEventId(event('agent.git.snapshot'), { git_head_end: 'abc123' }, 't')).toBe(
      'agent.git.snapshot:s1:git-snapshot:abc123'
    );
    expect(buildClaudeEventId(event('agent.git.snapshot'), { git_head_end: '' }, 't')).toMatch(
      /^agent\.git\.snapshot:s1:[0-9a-f]{64}$/
    );
  });

  it('keys agent.usage.request by request_id (message_id fallback) plus model', () => {
    expect(
      buildClaudeEventId(event('agent.usage.request'), { request_id: 'req-1', message_id: 'msg-1', model: 'm' }, 't')
    ).toBe('agent.usage.request:s1:usage:req-1:m');
    expect(
      buildClaudeEventId(event('agent.usage.request'), { request_id: '', message_id: 'msg-1', model: 'm' }, 't')
    ).toBe('agent.usage.request:s1:usage:msg-1:m');
  });

  it('keys agent.subagent.usage by agent_id, falling back to the content hash without one', () => {
    expect(buildClaudeEventId(event('agent.subagent.usage'), { agent_id: 'a1' }, 't')).toBe(
      'agent.subagent.usage:s1:subagent-usage:a1'
    );
    expect(buildClaudeEventId(event('agent.subagent.usage'), { agent_id: '' }, 't')).toMatch(
      /^agent\.subagent\.usage:s1:[0-9a-f]{64}$/
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
