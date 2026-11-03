import { describe, it, expect } from 'vitest';
import { resolveSubagentStopFields } from '../subagent-fields.js';
import type { SubagentFile } from '../../transcript/subagent-usage.js';

describe('resolveSubagentStopFields', () => {
  it('picks description/tool_use_id/spawn_depth/worktree off the file, and started_at/duration_ms off the derived agent.subagent.usage event', () => {
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
      spawn_depth: 2,
      worktree: 'worktrees/feature',
      started_at: '2026-10-01T00:00:00.000Z',
      duration_ms: 1500,
    });
  });

  it('omits spawn_depth/started_at/duration_ms when unknown, rather than defaulting them to 0/empty', () => {
    const file: SubagentFile = { agentId: 'a1', filePath: '/tmp/agent-a1.jsonl' };

    expect(resolveSubagentStopFields(file, [{ type: 'agent.usage.request' }])).toEqual({
      description: '',
      tool_use_id: '',
      worktree: '',
    });
  });
});
