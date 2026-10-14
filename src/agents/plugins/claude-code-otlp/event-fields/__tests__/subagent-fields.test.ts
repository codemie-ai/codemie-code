import { describe, it, expect } from 'vitest';
import { resolveSubagentStopFields } from '../subagent-fields.js';
import type { SubagentFile } from '../../transcript/subagent-usage.js';

describe('resolveSubagentStopFields', () => {
  it('picks description/tool_use_id/spawn_depth/worktree straight off the file, and started_at/duration_ms off the derived agent.subagent.usage event', () => {
    const file: SubagentFile = {
      agentId: 'a1',
      filePath: '/tmp/agent-a1.jsonl',
      toolUseId: 'tool-a1',
      spawnDepth: 2,
      description: 'Review the diff',
      cwd: '/repo/worktrees/feature',
    };
    const derivedEvents = [
      { type: 'agent.usage.request', request_id: 'r1' },
      { type: 'agent.subagent.usage', started_at: '2026-10-01T00:00:00.000Z', duration_ms: 1500 },
    ];

    expect(resolveSubagentStopFields(file, derivedEvents)).toEqual({
      description: 'Review the diff',
      tool_use_id: 'tool-a1',
      workflow_run: '',
      spawn_depth: 2,
      worktree: '/repo/worktrees/feature',
      started_at: '2026-10-01T00:00:00.000Z',
      duration_ms: 1500,
    });
  });

  it('defaults started_at/duration_ms when no agent.subagent.usage event was derived (empty/missing transcript)', () => {
    const file: SubagentFile = { agentId: 'a1', filePath: '/tmp/agent-a1.jsonl' };

    expect(resolveSubagentStopFields(file, [{ type: 'agent.usage.request' }])).toEqual({
      description: '',
      tool_use_id: '',
      workflow_run: '',
      spawn_depth: 0,
      worktree: '',
      started_at: '',
      duration_ms: 0,
    });
  });

  it('never fabricates workflow_run — always empty, regardless of what the derived event carries', () => {
    const file: SubagentFile = { agentId: 'a1', filePath: '/tmp/agent-a1.jsonl' };
    const derivedEvents = [{ type: 'agent.subagent.usage', workflow_run: 'should-be-ignored' }];

    expect(resolveSubagentStopFields(file, derivedEvents).workflow_run).toBe('');
  });
});
