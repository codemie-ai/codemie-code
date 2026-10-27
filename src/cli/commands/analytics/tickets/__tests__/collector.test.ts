import { describe, it, expect } from 'vitest';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { RawSessionData } from '../../data-loader.js';
import type { ParsedSessionView } from '../../cost/cost-enricher.js';
import { TicketCollector } from '../collector.js';
import type { TicketSource } from '../merge.js';

const ALL = new Set<TicketSource>(['tool', 'branch', 'prompt']);
const JIRA = ['mcp__*jira*'];
const T0 = Date.parse('2026-10-01T10:00:00.000Z');

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function jiraCall(id: string, key: string, offsetMs: number): unknown {
  return { timestamp: at(offsetMs), message: { content: [{ type: 'tool_use', id, name: 'mcp__claude_ai_Atlassian__getJiraIssue', input: { issueIdOrKey: key } }] } };
}

function view(sessionId: string, messages: unknown[], extra: Partial<ParsedSessionView> = {}, subagents: unknown[][] = []): ParsedSessionView {
  const parsed = {
    sessionId, agentName: 'claude', metadata: {}, messages,
    subagents: subagents.map((m, i) => ({ agentId: `a${i}`, filePath: `/x/${i}.jsonl`, messages: m })),
  } as ParsedSession;
  return { sessionId, agentName: 'claude', parsed, startTime: T0, windowEnd: undefined, ...extra };
}

describe('TicketCollector', () => {
  it('attributes a tool call replayed into a resumed session once, to the earlier session', () => {
    const collector = new TicketCollector({ sources: ALL, toolGlobs: JIRA });
    const original = jiraCall('toolu_1', 'CAKE-807', 0);
    // Enricher order: earliest session first.
    collector.observe(view('s1', [original]));
    collector.observe(view('s2', [original, jiraCall('toolu_2', 'CAKE-900', 60_000)]));

    const tickets = collector.build();
    expect(tickets.get('s1')).toEqual([{ id: 'CAKE-807', sources: { tool: 1 } }]);
    expect(tickets.get('s2')).toEqual([{ id: 'CAKE-900', sources: { tool: 1 } }]);
  });

  it('drops calls after the session window and counts subagent calls for the parent', () => {
    const collector = new TicketCollector({ sources: ALL, toolGlobs: JIRA });
    collector.observe(view('s1', [jiraCall('toolu_1', 'CAKE-1', 0), jiraCall('toolu_late', 'CAKE-2', 120_000)], { windowEnd: T0 + 60_000 }, [
      [jiraCall('toolu_sub', 'CAKE-3', 30_000)],
    ]));

    expect(collector.build().get('s1')).toEqual([
      { id: 'CAKE-1', sources: { tool: 1 } },
      { id: 'CAKE-3', sources: { tool: 1 } },
    ]);
  });

  it('ignores tools outside the configured patterns', () => {
    const collector = new TicketCollector({ sources: ALL, toolGlobs: ['mcp__*rally*'] });
    collector.observe(view('s1', [jiraCall('toolu_1', 'CAKE-1', 0)]));
    expect(collector.build().has('s1')).toBe(false);
  });

  it('reads every native prompt and branch, and drops rows replayed into a later session', () => {
    const collector = new TicketCollector({ sources: ALL, toolGlobs: JIRA });
    const prompt = { type: 'user', uuid: 'u1', timestamp: at(0), gitBranch: 'feature/CAKE-807', message: { role: 'user', content: 'start CAKE-807' } };
    const later = { type: 'user', uuid: 'u2', timestamp: at(1000), gitBranch: 'feature/CAKE-807', message: { role: 'user', content: [{ type: 'text', text: 'now CAKE-808' }] } };
    collector.observe(view('s1', [prompt, later]));
    collector.observe(view('s2', [prompt]));

    const tickets = collector.build();
    expect(tickets.get('s1')).toEqual([
      { id: 'CAKE-807', sources: { branch: 1, prompt: 1 } },
      { id: 'CAKE-808', sources: { prompt: 1 } },
    ]);
    // s2's only row is a replay of s1's: neither its prompt nor its branch counts for s2.
    expect(tickets.has('s2')).toBe(false);
  });

  it('drops the branch of a replayed row but keeps the branch of the resumed session', () => {
    const collector = new TicketCollector({ sources: ALL, toolGlobs: JIRA });
    const original = { type: 'user', uuid: 'u1', timestamp: at(0), gitBranch: 'ops/OPS-3', message: { role: 'user', content: 'hi' } };
    collector.observe(view('s1', [original]));
    collector.observe(view('s2', [original, { type: 'assistant', uuid: 'u9', timestamp: at(5000), gitBranch: 'ops/OPS-4' }]));

    expect(collector.build().get('s2')).toEqual([{ id: 'OPS-4', sources: { branch: 1 } }]);
  });

  it('drops Codex prompts replayed with their original timestamp', () => {
    const collector = new TicketCollector({ sources: ALL, toolGlobs: JIRA });
    const prompt = { type: 'event_msg', timestamp: at(0), payload: { type: 'user_message', message: 'work on CAKE-7' } };
    const codexView = (sessionId: string, messages: unknown[]): ParsedSessionView => ({ ...view(sessionId, messages), agentName: 'codex' });
    collector.observe(codexView('s1', [prompt, { type: 'response_item', payload: { type: 'function_call', name: 'mcp__jira__get', arguments: '{"issueKey":"CAKE-7"}', call_id: 'c1' } }]));
    collector.observe(codexView('s2', [prompt, { type: 'event_msg', timestamp: at(9000), payload: { type: 'user_message', message: 'now CAKE-8' } }]));

    const tickets = collector.build();
    expect(tickets.get('s1')).toEqual([{ id: 'CAKE-7', sources: { tool: 1, prompt: 1 } }]);
    expect(tickets.get('s2')).toEqual([{ id: 'CAKE-8', sources: { prompt: 1 } }]);
  });

  it('skips the deltas native-loader synthesizes from the same native log', () => {
    const collector = new TicketCollector({ sources: ALL, toolGlobs: JIRA });
    collector.observe(view('s2', [jiraCall('toolu_1', 'CAKE-1', 0)]));
    collector.addDeltas([{
      sessionId: 's2',
      deltas: [{ recordId: 's2-native', gitBranch: 'CAKE-50-old', userPrompts: [{ count: 1, text: 'replayed CAKE-51' }] }],
    }] as unknown as RawSessionData[]);

    expect(collector.build().get('s2')).toEqual([{ id: 'CAKE-1', sources: { tool: 1 } }]);
  });

  it('finds prompt tickets with the prompt source alone, corroborated by evidence it does not emit', () => {
    const collector = new TicketCollector({ sources: new Set<TicketSource>(['prompt']), toolGlobs: JIRA });
    collector.observe(view('s1', [jiraCall('toolu_1', 'CAKE-1', 0), { type: 'user', uuid: 'u1', message: { role: 'user', content: 'see CAKE-2' } }]));

    expect(collector.build().get('s1')).toEqual([{ id: 'CAKE-2', sources: { prompt: 1 } }]);
  });

  it('adds tracked prompts and branches from deltas without double counting the same text', () => {
    const collector = new TicketCollector({ sources: ALL, toolGlobs: JIRA });
    collector.observe(view('s1', [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix CAKE-5' } }]));
    collector.addDeltas([{
      sessionId: 's1',
      deltas: [
        { gitBranch: 'CAKE-5-fix', userPrompts: [{ count: 1, text: 'fix CAKE-5' }] },
        { gitBranch: 'CAKE-5-fix', userPrompts: [{ count: 1, text: 'also CAKE-5' }] },
      ],
    }] as unknown as RawSessionData[]);

    expect(collector.build().get('s1')).toEqual([{ id: 'CAKE-5', sources: { branch: 1, prompt: 2 } }]);
  });

  it('reads nothing from prompts when the prompt source is off', () => {
    const collector = new TicketCollector({ sources: new Set<TicketSource>(['tool', 'branch']), toolGlobs: JIRA });
    collector.observe(view('s1', [jiraCall('toolu_1', 'CAKE-1', 0), { type: 'user', message: { role: 'user', content: 'CAKE-2' } }]));
    collector.addDeltas([{ sessionId: 's1', deltas: [{ userPrompts: [{ count: 1, text: 'CAKE-3' }] }] }] as unknown as RawSessionData[]);

    expect(collector.build().get('s1')).toEqual([{ id: 'CAKE-1', sources: { tool: 1 } }]);
  });
});
