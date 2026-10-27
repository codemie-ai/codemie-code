import { describe, it, expect } from 'vitest';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { readToolCalls } from '../tool-calls.js';

function parsed(messages: unknown[], subagents: unknown[][] = []): ParsedSession {
  return {
    sessionId: 's1',
    agentName: 'claude',
    metadata: {},
    messages,
    subagents: subagents.map((m, i) => ({ agentId: `a${i}`, filePath: `/x/agent-a${i}.jsonl`, messages: m })),
  } as ParsedSession;
}

describe('readToolCalls', () => {
  it('reads Claude tool_use blocks from the main and subagent transcripts', () => {
    const main = [
      { timestamp: '2026-10-01T10:00:00.000Z', message: { content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'toolu_1', name: 'mcp__jira__get', input: { issueKey: 'CAKE-1' } },
      ] } },
      { message: { content: 'plain string content' } },
    ];
    const sub = [{ message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/a' } }] } }];

    expect(readToolCalls('claude', parsed(main, [sub]))).toEqual([
      { id: 'toolu_1', name: 'mcp__jira__get', input: { issueKey: 'CAKE-1' }, ts: Date.parse('2026-10-01T10:00:00.000Z') },
      { id: 'toolu_2', name: 'Read', input: { file_path: '/a' }, ts: null },
    ]);
  });

  it('reads Codex function_call items and decodes their JSON arguments', () => {
    const rows = [
      { type: 'response_item', timestamp: '2026-10-01T10:00:00.000Z', payload: { type: 'function_call', name: 'jira__get_issue', arguments: '{"issue_key":"CAKE-7"}', call_id: 'call_1' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: 'not json' } },
      { type: 'response_item', payload: { type: 'message' } },
    ];
    expect(readToolCalls('codex', parsed(rows))).toEqual([
      { id: 'call_1', name: 'jira__get_issue', input: { issue_key: 'CAKE-7' }, ts: Date.parse('2026-10-01T10:00:00.000Z') },
      { id: null, name: 'exec_command', input: undefined, ts: null },
    ]);
  });

  it('returns nothing for an agent without a reader', () => {
    expect(readToolCalls('gemini', parsed([{ message: { content: [{ type: 'tool_use', name: 'x' }] } }]))).toEqual([]);
  });
});
