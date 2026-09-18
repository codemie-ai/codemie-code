import { describe, expect, it } from 'vitest';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { buildClaudeTraceIndex } from '../claude-trace.js';
import { enrichCosts } from '../cost-enricher.js';
import { extractDispatchEvents } from '../dispatch-extractor.js';
import { extractClaudeUsageRecords } from '../usage-readers.js';

const base = Date.parse('2026-09-15T00:00:00Z');
const at = (ms: number): string => new Date(base + ms).toISOString();
const invoke = (id: string, ms: number, name = 'Agent') => ({ timestamp: at(ms), message: {
  role: 'assistant', content: [{ type: 'tool_use', id, name, input: { subagent_type: 'worker', skill: 'review' } }],
} });
const result = (id: string, ms: number, toolUseResult = {}, extra = {}) => ({ timestamp: at(ms), toolUseResult, message: {
  role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...extra }],
} });
const usage = (id: string, tokens: number) => ({ timestamp: at(20), requestId: `req-${id}`, message: {
  id, role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: tokens },
} });
const notice = (taskId: string, ms: number, status = 'completed', toolUseId?: string) => ({
  type: 'system', subtype: 'task-notification', timestamp: at(ms), taskId, toolUseId, status,
});
const child = (agentId: string, toolUseId: string, parentAgentId: string, messages: unknown[]) => ({
  agentId, toolUseId, parentAgentId, filePath: `/sanitized/${agentId}.jsonl`, messages,
});
const family = (messages: unknown[], subagents: NonNullable<ParsedSession['subagents']> = []): ParsedSession => ({
  sessionId: 'root', agentName: 'claude', metadata: {}, messages, subagents,
});
async function costOf(parsed: ParsedSession) {
  const { index } = await enrichCosts([{ sessionId: 'root', deltas: [] }], {
    resolveAgentName: () => 'claude', loadAgentSessionFile: async () => '/sanitized/root.jsonl', parseNative: async () => parsed,
  });
  return index.get('root')!;
}

describe('Claude review regressions', () => {
  it.each([false, true])('CR-003/012 assigns inherited tools and responses independently of discovery order (%s)', async (reverse) => {
    const parentRows = [invoke('nested', 10), usage('parent', 10)];
    const descendants = [child('parent', 'launch', 'root', parentRows), child('descendant', 'nested', 'parent', [
      ...parentRows, usage('parent', 12), usage('child', 3),
    ])];
    const parsed = family([invoke('launch', 0)], reverse ? descendants.reverse() : descendants);
    expect(buildClaudeTraceIndex(parsed).toolOwners.get('nested')).toBe('parent');
    expect(extractClaudeUsageRecords(parsed).map(({ key, ownerAgentId, usage: tokens }) => [key, ownerAgentId, tokens.total])).toEqual([
      ['parent::req-parent', 'parent', 12], ['child::req-child', 'descendant', 3],
    ]);
    const cost = await costOf(parsed);
    expect(cost.dispatches?.find((event) => event.id === 'launch')).toMatchObject({ tokens: { total: 12 }, inclusiveTokens: { total: 15 }, attributionStatus: 'exact' });
    expect(cost.dispatches?.find((event) => event.id === 'nested')).toMatchObject({ ownerAgentId: 'parent', parentId: 'launch', tokens: { total: 3 }, attributionStatus: 'exact' });
  });

  it.each([false, true])('CR-004 invalidates every duplicate transcript claimant (%s)', async (reverse) => {
    const descendants = [child('a', 'launch', 'root', [usage('a', 2)]), child('b', 'launch', 'root', [usage('b', 3)])];
    const parsed = family([invoke('launch', 0)], reverse ? descendants.reverse() : descendants);
    const index = buildClaudeTraceIndex(parsed);
    expect([...index.agents.values()].map((agent) => agent.relationshipStatus)).toEqual(['conflict', 'conflict']);
    expect(index.childAgentsByOwner.get('root') ?? []).toEqual([]);
    const cost = await costOf(parsed);
    expect(cost.dispatches?.[0]).toMatchObject({ relationshipStatus: 'conflict', attributionStatus: 'ambiguous' });
    expect(cost.dispatches?.[0].tokens).toBeUndefined();
    expect(cost.unlinkedTokens?.total).toBe(5);
  });

  it('CR-005 collects authoritative terminal notifications from nested owners', () => {
    const parsed = family([invoke('launch', 0)], [
      child('parent', 'launch', 'root', [invoke('nested', 10), result('nested', 12, { isAsync: true, agentId: 'descendant' }), notice('descendant', 90, 'failed'), notice('descendant', 95, 'failed')]),
      child('descendant', 'nested', 'parent', [usage('child', 3)]),
    ]);
    expect(extractDispatchEvents(parsed).find((event) => event.id === 'nested')).toMatchObject({ status: 'failed', completedAt: base + 90, elapsedMs: 80 });
  });

  it.each([false, true])('CR-006 rejects contradictory acknowledgement and tool identities (%s)', async (reverse) => {
    const descendants = [child('a', 'tool-a', 'root', [usage('a', 2)]), child('b', 'tool-b', 'root', [usage('b', 3)])];
    const cost = await costOf(family([invoke('tool-a', 0), result('tool-a', 1, { isAsync: true, agentId: 'b' }), invoke('tool-b', 2)], reverse ? descendants.reverse() : descendants));
    expect(cost.dispatches?.map((event) => event.attributionStatus)).toEqual(['ambiguous', 'ambiguous']);
    expect(cost.dispatches?.map((event) => event.tokens)).toEqual([undefined, undefined]);
    expect(cost.unlinkedTokens?.total).toBe(5);
  });

  it.each([{ agentId: 'missing' }, { agentId: 'missing', taskId: 'task-17' }])('CR-007 resolves task identity without child files: %j', (identity) => {
    const parsed = family([invoke('launch', 0), result('launch', 10, { isAsync: true, ...identity }), notice(identity.taskId ?? identity.agentId, 70)]);
    expect(extractDispatchEvents(parsed)[0]).toMatchObject({ status: 'completed', completedAt: base + 70, elapsedMs: 70 });
  });

  it('CR-007 rejects a notification whose tool identity contradicts its task identity', () => {
    const parsed = family([invoke('a', 0), result('a', 10, { isAsync: true, agentId: 'agent-a' }), invoke('b', 1), result('b', 11, { isAsync: true, agentId: 'agent-b' }), notice('agent-b', 70, 'completed', 'a')]);
    expect(extractDispatchEvents(parsed).map((event) => event.completedAt)).toEqual([undefined, undefined]);
  });

  it.each([undefined, 'invalid'])('CR-009 retains incomplete-extraction fallback for omitted timestamps (%s)', async (timestamp) => {
    const cost = await costOf(family([{ ...invoke('launch', 0), timestamp }]));
    expect(cost.dispatchesComplete).toBe(false);
  });

  it.each([undefined, 'invalid'])('CR-009 marks untimed native commands incomplete (%s)', async (timestamp) => {
    const cost = await costOf(family([{ uuid: 'untimed', timestamp, message: { role: 'user', content: '<command-name>/review</command-name><command-message>review</command-message>' } }]));
    expect(cost.dispatchesComplete).toBe(false);
  });

  it.each([false, true])('CR-003 leaves tools replayed across unrelated owners ambiguous (%s)', async (reverse) => {
    const descendants = [child('a', 'launch-a', 'root', [invoke('shared', 5)]), child('b', 'launch-b', 'root', [invoke('shared', 5)]), child('c', 'shared', '', [usage('c', 3)])];
    const cost = await costOf(family([invoke('launch-a', 0), invoke('launch-b', 1)], reverse ? descendants.reverse() : descendants));
    expect(cost.dispatches?.find((event) => event.id === 'shared')).toMatchObject({ relationshipStatus: 'conflict', attributionStatus: 'ambiguous' });
    expect(cost.dispatches?.find((event) => event.id === 'shared')?.ownerAgentId).toBeUndefined();
  });

  it('CR-010 deduplicates command UUIDs while retaining separate identical commands', () => {
    const command = (uuid: string) => ({ uuid, timestamp: at(5), message: { role: 'user', content: '<command-name>/review</command-name><command-message>review</command-message>' } });
    const parsed = family([invoke('launch', 0), command('original')], [child('parent', 'launch', 'root', [command('original'), command('new-invocation')])]);
    const commands = extractDispatchEvents(parsed).filter((event) => event.kind === 'command');
    expect(commands).toHaveLength(2);
    expect(commands.map((event) => event.ownerAgentId).sort()).toEqual(['parent', 'root']);
    expect(new Set(commands.map((event) => event.id)).size).toBe(2);
  });

  it.each([{ is_error: true }, { isError: true }, { status: 'failed' }])('CR-011 preserves synchronous failure and terminal timing: %j', (extra) => {
    for (const name of ['Agent', 'Task', 'Skill']) {
      const events = extractDispatchEvents(family([invoke('failed', 0, name), result('failed', 40, {}, extra)]));
      expect(events[0]).toMatchObject({ status: 'failed', completedAt: base + 40, elapsedMs: 40, durationMs: 40 });
    }
  });

  it('CR-012 retains ambiguous sibling replay once without inventing its owner', async () => {
    const parsed = family([invoke('a', 0), invoke('b', 1)], [child('a', 'a', 'root', [usage('shared', 2)]), child('b', 'b', 'root', [usage('shared', 3)])]);
    expect(extractClaudeUsageRecords(parsed)[0]).toMatchObject({ usage: { total: 3 } });
    expect(extractClaudeUsageRecords(parsed)[0].ownerAgentId).toBeUndefined();
    expect((await costOf(parsed)).unlinkedTokens?.total).toBe(3);
  });

  it('CR-012 does not let already excluded replay make fresh allocations ambiguous', async () => {
    const parsed = family([invoke('a', 0), invoke('b', 1)], [child('a', 'a', 'root', [usage('shared', 3), usage('fresh-a', 5)]), child('b', 'b', 'root', [usage('shared', 3), usage('fresh-b', 7)])]);
    const { index } = await enrichCosts([{ sessionId: 'earlier', deltas: [] }, { sessionId: 'root', deltas: [] }], {
      resolveAgentName: () => 'claude', loadAgentSessionFile: async () => '/sanitized/root.jsonl',
      parseNative: async (_agent, _file, id) => id === 'earlier' ? { ...family([usage('shared', 3)]), sessionId: 'earlier' } : parsed,
    });
    expect(index.get('root')?.dispatches?.map((event) => [event.attributionStatus, event.tokens?.total])).toEqual([['exact', 5], ['exact', 7]]);
    expect(index.get('root')?.tokens.total).toBe(12);
  });
});
