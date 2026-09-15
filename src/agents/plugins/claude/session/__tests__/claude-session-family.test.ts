import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudePluginMetadata } from '../../claude.plugin.js';
import { ClaudeSessionAdapter } from '../../claude.session.js';

interface FixtureMessage {
  type: string;
  uuid: string;
  sessionId: string;
  timestamp: string;
  message?: {
    id?: string;
    role: 'user' | 'assistant';
    content: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  subtype?: string;
  taskId?: string;
  status?: string;
}

function jsonl(records: FixtureMessage[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n';
}

describe('ClaudeSessionAdapter family evidence', () => {
  let tempDir: string;
  let adapter: ClaudeSessionAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-session-family-'));
    adapter = new ClaudeSessionAdapter(ClaudePluginMetadata);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('preserves exact flat child and grandchild relationship metadata', async () => {
    const sessionId = 'root-session';
    const sessionFile = join(tempDir, `${sessionId}.jsonl`);
    const subagentsDir = join(tempDir, sessionId, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(sessionFile, jsonl([{
      type: 'user', uuid: 'root-1', sessionId, timestamp: '2026-09-15T08:00:00.000Z',
      message: { role: 'user', content: '[sanitized]' },
    }]));

    await writeFile(join(subagentsDir, 'agent-child.jsonl'), jsonl([{
      type: 'assistant', uuid: 'child-1', sessionId, timestamp: '2026-09-15T08:00:01.000Z',
      message: { id: 'child-response', role: 'assistant', content: '[sanitized]', usage: { input_tokens: 5, output_tokens: 3 } },
    }]));
    await writeFile(join(subagentsDir, 'agent-child.meta.json'), JSON.stringify({
      agentType: 'worker', toolUseId: 'tool-root-child', parentAgentId: 'root', spawnDepth: 1,
      requestShape: 'background', requestNonInteractive: true,
    }));

    await writeFile(join(subagentsDir, 'agent-grandchild.jsonl'), jsonl([{
      type: 'assistant', uuid: 'grandchild-1', sessionId, timestamp: '2026-09-15T08:00:02.000Z',
      message: { id: 'grandchild-response', role: 'assistant', content: '[sanitized]', usage: { input_tokens: 7, output_tokens: 4 } },
    }]));
    await writeFile(join(subagentsDir, 'agent-grandchild.meta.json'), JSON.stringify({
      agentType: 'reviewer', toolUseId: 'tool-child-grandchild', parentAgentId: 'child', spawnDepth: 2,
      requestShape: 'background', requestNonInteractive: false,
    }));

    const parsed = await adapter.parseSessionFile(sessionFile, sessionId);

    expect(parsed.subagents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'child', toolUseId: 'tool-root-child', parentAgentId: 'root', spawnDepth: 1,
        requestShape: 'background', requestNonInteractive: true,
      }),
      expect.objectContaining({
        agentId: 'grandchild', toolUseId: 'tool-child-grandchild', parentAgentId: 'child', spawnDepth: 2,
        requestShape: 'background', requestNonInteractive: false,
      }),
    ]));
  });

  it('keeps readable usage and protocol rows when sibling metadata or transcript is damaged', async () => {
    const sessionId = 'damaged-family';
    const sessionFile = join(tempDir, `${sessionId}.jsonl`);
    const subagentsDir = join(tempDir, sessionId, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(sessionFile, jsonl([{
      type: 'user', uuid: 'root-1', sessionId, timestamp: '2026-09-15T09:00:00.000Z',
      message: { role: 'user', content: '[sanitized]' },
    }]));

    const retainedUsage: FixtureMessage = {
      type: 'assistant', uuid: 'duplicate-row', sessionId, timestamp: '2026-09-15T09:00:02.000Z',
      message: { id: 'retained-response', role: 'assistant', content: '[sanitized]', usage: { input_tokens: 13, output_tokens: 8 } },
    };
    const protocolRow: FixtureMessage = {
      type: 'system', subtype: 'task-notification', uuid: 'protocol-row', sessionId,
      timestamp: '2026-09-15T09:00:03.000Z', taskId: 'child-task', status: 'completed',
    };
    await writeFile(join(subagentsDir, 'agent-readable.jsonl'), jsonl([
      { ...retainedUsage, timestamp: '2026-09-15T09:00:01.000Z', message: { ...retainedUsage.message!, usage: { input_tokens: 1, output_tokens: 1 } } },
      retainedUsage,
      protocolRow,
    ]));
    await writeFile(join(subagentsDir, 'agent-readable.meta.json'), '{ malformed metadata');

    await writeFile(join(subagentsDir, 'agent-no-meta.jsonl'), jsonl([{
      type: 'assistant', uuid: 'metadata-free', sessionId, timestamp: '2026-09-15T09:00:04.000Z',
      message: { id: 'metadata-free-response', role: 'assistant', content: '[sanitized]', usage: { input_tokens: 2, output_tokens: 1 } },
    }]));
    await writeFile(join(subagentsDir, 'agent-damaged.jsonl'), '{ damaged transcript');

    const parsed = await adapter.parseSessionFile(sessionFile, sessionId);
    const readable = parsed.subagents?.find(subagent => subagent.agentId === 'readable');

    expect(parsed.subagents?.map(subagent => subagent.agentId).sort()).toEqual(['no-meta', 'readable']);
    expect(readable?.messages).toHaveLength(2);
    expect(readable?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.objectContaining({ usage: { input_tokens: 13, output_tokens: 8 } }) }),
      expect.objectContaining({ type: 'system', subtype: 'task-notification', taskId: 'child-task', status: 'completed' }),
    ]));
  });
});
