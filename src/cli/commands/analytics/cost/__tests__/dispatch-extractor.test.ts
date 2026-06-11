/**
 * Dispatch-timeline extractor unit tests (pure, no fs).
 */

import { describe, it, expect } from 'vitest';
import { extractDispatchEvents } from '../dispatch-extractor.js';
import { MAX_DISPATCHES } from '../types.js';

function parsed(messages: unknown[]): never {
  return { sessionId: 's', agentName: 'claude', metadata: {}, messages } as never;
}
const agentUse = (id: string, sub: string, at: string) => ({
  timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: sub } }] },
});
const taskUse = (id: string, sub: string, at: string) => ({
  timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type: sub } }] },
});
const skillUse = (id: string, skill: string, at: string) => ({
  timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] },
});
const result = (id: string, at: string) => ({
  timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const commandMsg = (cmd: string, at: string) => ({
  timestamp: at, message: { role: 'user', content: `<command-name>/${cmd}</command-name>\n<command-message>${cmd}</command-message>\n<command-args></command-args>` },
});

describe('extractDispatchEvents', () => {
  it('pairs an Agent tool_use with its tool_result and computes duration', () => {
    const ev = extractDispatchEvents(parsed([
      agentUse('a1', 'tech-analyst', '2026-06-08T10:00:00Z'),
      result('a1', '2026-06-08T10:02:30Z'),
    ]));
    expect(ev).toEqual([{ kind: 'agent', name: 'tech-analyst', start: Date.parse('2026-06-08T10:00:00Z'), durationMs: 150000 }]);
  });

  it('handles Task (standard Claude Code), Skill (0s), and command point events; sorts by start', () => {
    const ev = extractDispatchEvents(parsed([
      commandMsg('sdlc-task', '2026-06-08T10:00:00Z'),
      taskUse('t1', 'Explore', '2026-06-08T10:00:05Z'),
      skillUse('s1', 'superpowers:brainstorming', '2026-06-08T10:01:00Z'),
      result('s1', '2026-06-08T10:01:00Z'),
      result('t1', '2026-06-08T10:00:35Z'),
    ]));
    expect(ev.map((e) => [e.kind, e.name, e.durationMs])).toEqual([
      ['command', 'sdlc-task', 0],
      ['agent', 'Explore', 30000],
      ['skill', 'superpowers:brainstorming', 0],
    ]);
  });

  it('ignores sidechain (sub-agent) tool_uses to avoid overlapping/nested bars', () => {
    const side = { ...agentUse('x1', 'nested', '2026-06-08T10:00:10Z'), isSidechain: true };
    const ev = extractDispatchEvents(parsed([
      agentUse('a1', 'parent', '2026-06-08T10:00:00Z'),
      side,
      result('a1', '2026-06-08T10:05:00Z'),
    ]));
    expect(ev.map((e) => e.name)).toEqual(['parent']);
  });

  it('emits an unmatched dispatch (no tool_result) as a 0-duration marker', () => {
    const ev = extractDispatchEvents(parsed([agentUse('a1', 'orphan', '2026-06-08T10:00:00Z')]));
    expect(ev).toEqual([{ kind: 'agent', name: 'orphan', start: Date.parse('2026-06-08T10:00:00Z'), durationMs: 0 }]);
  });

  it('caps at MAX_DISPATCHES', () => {
    const msgs: unknown[] = [];
    for (let i = 0; i < MAX_DISPATCHES + 20; i++) {
      const at = new Date(Date.parse('2026-06-08T10:00:00Z') + i * 1000).toISOString();
      msgs.push(agentUse('a' + i, 'x', at), result('a' + i, at));
    }
    expect(extractDispatchEvents(parsed(msgs)).length).toBe(MAX_DISPATCHES);
  });

  it('returns [] when there are no dispatches', () => {
    expect(extractDispatchEvents(parsed([{ timestamp: '2026-06-08T10:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }]))).toEqual([]);
  });
});
