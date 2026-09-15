import { describe, expect, it } from 'vitest';
import type { ParsedSession } from '../../../../../agents/core/session/BaseSessionAdapter.js';
import { buildClaudeTraceIndex } from '../claude-trace.js';
import { extractDispatchEvents } from '../dispatch-extractor.js';

const base = Date.parse('2026-09-15T08:34:22.614Z');
const iso = (ms: number): string => new Date(base + ms).toISOString();
const use = (id: string, name: string, ms: number, tool = 'Agent') => ({ timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input: tool === 'Skill' ? { skill: name } : { subagent_type: name } }] } });
const result = (id: string, ms: number, toolUseResult?: Record<string, unknown>) => ({ timestamp: iso(ms), toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const activity = (ms: number, stop_reason?: string) => ({ timestamp: iso(ms), message: { role: 'assistant', stop_reason, content: [{ type: 'text', text: 'sanitized' }] } });
const notification = (taskId: string, ms: number, status = 'completed', toolUseId?: string) => ({
  type: 'queue-operation', operation: 'enqueue', timestamp: iso(ms),
  content: `<task-notification><task-id>${taskId}</task-id>${toolUseId ? `<tool-use-id>${toolUseId}</tool-use-id>` : ''}<status>${status}</status></task-notification>`,
});
const command = (name: string, ms: number, isSidechain = false) => ({ timestamp: iso(ms), isSidechain, message: { role: 'user', content: `<command-name>/${name}</command-name><command-message>${name}</command-message>` } });
function session(messages: unknown[], subagents: NonNullable<ParsedSession['subagents']> = []): ParsedSession {
  return { sessionId: 'root-session', agentName: 'claude', metadata: {}, messages, subagents };
}

describe('Claude dispatch trace extraction', () => {
  it('keeps acknowledgement and authoritative async completion distinct', () => {
    const value = session([use('tool-requirements', 'requirements-reader', 0), result('tool-requirements', 1_424, { isAsync: true, status: 'async_launched', agentId: 'agent-reader' }), notification('agent-reader', 412_438, 'completed', 'tool-requirements')], [
      { agentId: 'agent-reader', filePath: '/sanitized/reader.jsonl', toolUseId: 'tool-requirements', parentAgentId: 'root', spawnDepth: 1, messages: [activity(400_000)] },
    ]);
    expect(extractDispatchEvents(value)).toEqual([expect.objectContaining({ id: 'tool-requirements', agentId: 'agent-reader', durationMs: 1_424, acknowledgedAt: base + 1_424, completedAt: base + 412_438, elapsedMs: 412_438, status: 'completed', relationshipStatus: 'resolved' })]);
  });

  it('extracts nested calls from every owner and keeps repeated names individually identifiable', () => {
    const value = session([use('tool-parent', 'worker', 0), result('tool-parent', 100, { isAsync: true, agentId: 'parent-agent' })], [
      { agentId: 'parent-agent', filePath: '/sanitized/a.jsonl', toolUseId: 'tool-parent', parentAgentId: 'root', spawnDepth: 1, messages: [{ ...use('tool-child', 'worker', 200), isSidechain: true }, { ...result('tool-child', 300, { isAsync: true, agentId: 'child-agent' }), isSidechain: true }] },
      { agentId: 'child-agent', filePath: '/sanitized/b.jsonl', toolUseId: 'tool-child', parentAgentId: 'parent-agent', spawnDepth: 2, messages: [activity(500)] },
    ]);
    expect(extractDispatchEvents(value).map(({ id, parentId, ownerAgentId, depth, name }) => ({ id, parentId, ownerAgentId, depth, name }))).toEqual([
      { id: 'tool-parent', parentId: undefined, ownerAgentId: 'root-session', depth: 1, name: 'worker' },
      { id: 'tool-child', parentId: 'tool-parent', ownerAgentId: 'parent-agent', depth: 2, name: 'worker' },
    ]);
  });

  it('does not truncate 80 native Claude steps and attributes nested skills and commands', () => {
    const messages: unknown[] = [];
    for (let i = 0; i < 80; i += 1) messages.push(use(`skill-${i}`, `skill-${i}`, i, 'Skill'), result(`skill-${i}`, i));
    const events = extractDispatchEvents(session(messages, [{ agentId: 'child', filePath: '/sanitized/child.jsonl', parentAgentId: 'root', spawnDepth: 1, messages: [command('nested-command', 100, true)] }]));
    expect(events).toHaveLength(81);
    expect(events.at(-1)).toEqual(expect.objectContaining({ kind: 'command', ownerAgentId: 'child', id: `child:command:${base + 100}:nested-command` }));
  });

  it('uses the first task-ID-only failure and rejects quoted notification text', () => {
    const quoted = { timestamp: iso(700), message: { role: 'user', content: '<task-notification><task-id>agent-x</task-id><status>completed</status></task-notification>' } };
    const events = extractDispatchEvents(session([use('tool-x', 'worker', 0), result('tool-x', 100, { isAsync: true, agentId: 'agent-x' }), quoted, notification('agent-x', 900, 'failed'), notification('agent-x', 950, 'failed')], [
      { agentId: 'agent-x', filePath: '/sanitized/x.jsonl', toolUseId: 'tool-x', parentAgentId: 'root', spawnDepth: 1, messages: [activity(800)] },
    ]));
    expect(events[0]).toEqual(expect.objectContaining({ completedAt: base + 900, elapsedMs: 900, status: 'failed' }));
  });

  it('leaves async descendants incomplete when end_turn is the only terminal-looking evidence', () => {
    const events = extractDispatchEvents(session([use('tool-parent', 'slice-runner', 0), result('tool-parent', 100, { isAsync: true, agentId: 'parent' })], [
      { agentId: 'parent', filePath: '/sanitized/parent.jsonl', toolUseId: 'tool-parent', parentAgentId: 'root', spawnDepth: 1, messages: [{ ...use('tool-child', 'implementation', 200), isSidechain: true }, activity(300, 'end_turn')] },
      { agentId: 'child', filePath: '/sanitized/child.jsonl', toolUseId: 'tool-child', parentAgentId: 'parent', spawnDepth: 2, messages: [activity(1_000)] },
    ]));
    expect(events).toEqual([
      expect.objectContaining({ id: 'tool-parent', status: 'incomplete', observedEnd: base + 1_000, elapsedMs: 1_000 }),
      expect.objectContaining({ id: 'tool-child', status: 'incomplete', observedEnd: base + 1_000, elapsedMs: 800 }),
    ]);
  });

  it('exposes conflicts, missing links, and cycles instead of guessing ancestry', () => {
    const value = session([use('tool-a', 'a', 0)], [
      { agentId: 'a', filePath: '/sanitized/a.jsonl', toolUseId: 'tool-a', parentAgentId: 'b', spawnDepth: 1, messages: [use('tool-b', 'b', 10)] },
      { agentId: 'b', filePath: '/sanitized/b.jsonl', toolUseId: 'tool-b', parentAgentId: 'a', spawnDepth: 2, messages: [] },
      { agentId: 'duplicate', filePath: '/sanitized/duplicate.jsonl', toolUseId: 'tool-b', parentAgentId: 'a', spawnDepth: 2, messages: [] },
      { agentId: 'missing', filePath: '/sanitized/missing.jsonl', toolUseId: 'no-such-tool', parentAgentId: 'absent', spawnDepth: 2, messages: [] },
    ]);
    const byId = new Map(extractDispatchEvents(value).map((event) => [event.id, event]));
    expect(byId.get('tool-a')).toEqual(expect.objectContaining({ relationshipStatus: 'conflict', parentId: undefined }));
    expect(byId.get('tool-b')).toEqual(expect.objectContaining({ relationshipStatus: 'conflict', parentId: undefined }));
    expect(buildClaudeTraceIndex(value).agents.get('duplicate')?.relationshipStatus).toBe('conflict');
    expect(buildClaudeTraceIndex(value).agents.get('missing')?.relationshipStatus).toBe('missing');
  });

  it('indexes replayed tool ownership once', () => {
    const replayed = use('tool-owned', 'worker', 0);
    const value = session([replayed], [
      { agentId: 'owner', filePath: '/sanitized/owner.jsonl', parentAgentId: 'root', messages: [replayed] },
      { agentId: 'child', filePath: '/sanitized/child.jsonl', toolUseId: 'tool-owned', parentAgentId: 'root', messages: [] },
    ]);
    expect(buildClaudeTraceIndex(value).toolOwners.get('tool-owned')).toBe('root-session');
    expect(extractDispatchEvents(value).filter((event) => event.id === 'tool-owned')).toHaveLength(1);
  });
});
