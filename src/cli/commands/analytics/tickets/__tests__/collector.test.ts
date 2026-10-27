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

  it('reads every native prompt and branch, and dedupes prompts replayed by row uuid', () => {
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
    expect(tickets.get('s2')).toEqual([{ id: 'CAKE-807', sources: { branch: 1 } }]);
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
