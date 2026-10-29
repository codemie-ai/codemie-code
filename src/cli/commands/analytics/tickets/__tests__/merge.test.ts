import { describe, it, expect } from 'vitest';
import { buildTicketReport, MAX_TICKETS_PER_SESSION, type SessionEvidence, type TicketSource } from '../merge.js';

const buildSessionTickets = (evidence: Map<string, SessionEvidence>, sources: ReadonlySet<TicketSource>) => buildTicketReport(evidence, sources).tickets;

const ALL: ReadonlySet<TicketSource> = new Set(['tool', 'branch', 'prompt']);

function evidence(over: Partial<SessionEvidence> = {}): SessionEvidence {
  return { tool: new Map(), branches: new Set(), prompts: new Set(), ...over };
}

describe('buildSessionTickets', () => {
  it('reports per-source counts without ranking, ordered by id', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({
      tool: new Map([['CAKE-807', 3]]),
      branches: new Set(['feature/CAKE-807-login', 'fix/CAKE-801']),
      prompts: new Set(['continue CAKE-807', 'and CAKE-807 again']),
    })]]), ALL);

    expect(result.get('s1')).toEqual([
      { id: 'CAKE-801', sources: { branch: 1 } },
      { id: 'CAKE-807', sources: { tool: 3, branch: 1, prompt: 2 } },
    ]);
  });

  it('keeps a prompt id only when its prefix is corroborated by a tool or branch id anywhere in the report', () => {
    const result = buildSessionTickets(new Map([
      ['s1', evidence({ tool: new Map([['CAKE-807', 1]]) })],
      ['s2', evidence({ prompts: new Set(['look at CAKE-812 and UTF-8, SHA-256, ACME-1']) })],
    ]), ALL);

    expect(result.get('s2')).toEqual([{ id: 'CAKE-812', sources: { prompt: 1 } }]);
  });

  it('matches prompts case-sensitively, so lower-case model and runtime names never count', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({
      tool: new Map([['GPT-1', 1]]),
      prompts: new Set(['try gpt-4 on node-18', 'Gpt-5']),
    })]]), ALL);

    expect(result.get('s1')).toEqual([{ id: 'GPT-1', sources: { tool: 1 } }]);
  });

  it('keeps branch and prompt ids only when a tool call confirms their project key', () => {
    // The real-log case: a library version in a branch (react-17) must not become a ticket, nor
    // confirm the same string pasted into another session's prompt.
    const result = buildSessionTickets(new Map([
      ['s1', evidence({ tool: new Map([['NUTLA-1', 1]]), branches: new Set(['feature/NUTLA-996-x', 'chore/react-17-upgrade', 'fix/modal-19']) })],
      ['s2', evidence({ branches: new Set(['NUTLA-1004-y']), prompts: new Set(['see REACT-17 and NUTLA-1005']) })],
    ]), ALL);

    expect(result.get('s1')).toEqual([
      { id: 'NUTLA-1', sources: { tool: 1 } },
      { id: 'NUTLA-996', sources: { branch: 1 } },
    ]);
    expect(result.get('s2')).toEqual([
      { id: 'NUTLA-1004', sources: { branch: 1 } },
      { id: 'NUTLA-1005', sources: { prompt: 1 } },
    ]);
  });

  it('drops prompt ids whose number runs on into a version or a letter, like branch ids', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({ tool: new Map([['ABC-1', 1]]), prompts: new Set(['ABC-7.1 and ABC-6x but ABC-8, ABC-9.']) })]]), new Set<TicketSource>(['prompt']));
    // ABC-9 ends the sentence: a full stop alone is not a version.
    expect(result.get('s1')!.map((t) => t.id)).toEqual(['ABC-8', 'ABC-9']);
  });

  it('keeps an id that ends a sentence, but not one running into a version', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({
      tool: new Map([['ABC-1', 1]]),
      prompts: new Set(['Fix ABC-22.', 'Then ABC-23. Next', 'ABC-24, ABC-25! (ABC-26)', 'not ABC-7.1, ABC-8.x or ABC-9.0']),
      branches: new Set(['chore/abc-30.hotfix', 'fix/ABC-31']),
    })]]), ALL);

    expect(result.get('s1')!.map((t) => t.id)).toEqual(['ABC-1', 'ABC-22', 'ABC-23', 'ABC-24', 'ABC-25', 'ABC-26', 'ABC-31']);
  });

  it('keeps both ids when a full stop joins them', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({ tool: new Map([['ABC-9', 1]]), prompts: new Set(['see ABC-1.ABC-2 but not ABC-3.1']) })]]), new Set<TicketSource>(['prompt']));
    expect(result.get('s1')!.map((t) => t.id)).toEqual(['ABC-1', 'ABC-2']);
  });

  it('keeps no branch or prompt ids when the report has no tool-call ids at all', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({ branches: new Set(['feature/CAKE-807']), prompts: new Set(['CAKE-808']) })]]), ALL);
    expect(result.has('s1')).toBe(false);
  });

  it('drops prompt-only evidence entirely when no tool or branch id exists', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({ prompts: new Set(['CAKE-1']) })]]), ALL);
    expect(result.has('s1')).toBe(false);
  });

  it('ignores bot dependency branches and version-like branch matches', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({
      tool: new Map([['CAKE-1', 1]]),
      branches: new Set(['dependabot/npm_and_yarn/lodash-4.17.21', 'renovate/node-20.x', 'chore/bump-vite-5.2', 'feature/CAKE-9-x']),
      prompts: new Set(['LODASH-1 and NODE-2 and CAKE-10']),
    })]]), ALL);

    expect(result.get('s1')).toEqual([
      { id: 'CAKE-1', sources: { tool: 1 } },
      { id: 'CAKE-9', sources: { branch: 1 } },
      { id: 'CAKE-10', sources: { prompt: 1 } },
    ]);
  });

  it('ignores a branch match whose number runs on into a letter', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({
      tool: new Map([['BUG-1', 1], ['ABC-1', 1], ['CAKE-1', 1], ['NUTLA-1', 1], ['OPS-1', 1]]),
      branches: new Set(['claude/fix-login-bug-011CUabc', 'hotfix/abc-12x', 'feature/CAKE-807-login', 'NUTLA-996', 'nutla-5/sub', 'fix/OPS-7_cleanup']),
    })]]), new Set<TicketSource>(['branch']));

    expect(result.get('s1')!.map((t) => t.id)).toEqual(['CAKE-807', 'NUTLA-5', 'NUTLA-996', 'OPS-7']);
  });

  it('ignores disabled sources', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({
      tool: new Map([['CAKE-1', 1]]),
      branches: new Set(['CAKE-2']),
      prompts: new Set(['CAKE-3']),
    })]]), new Set<TicketSource>(['branch']));

    expect(result.get('s1')).toEqual([{ id: 'CAKE-2', sources: { branch: 1 } }]);
  });

  it('confirms prompts with tool evidence even when only prompts are requested, never with branches', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({
      tool: new Map([['CAKE-1', 1]]),
      branches: new Set(['NUTLA-5-x']),
      prompts: new Set(['CAKE-2 and NUTLA-6 and ZZZ-9']),
    })]]), new Set<TicketSource>(['prompt']));

    expect(result.get('s1')).toEqual([{ id: 'CAKE-2', sources: { prompt: 1 } }]);
  });

  it('orders ids numerically and keeps the lower numbers on a cap tie', () => {
    const tool = new Map<string, number>();
    for (let i = 1; i <= MAX_TICKETS_PER_SESSION + 2; i++) tool.set(`BIG-${i}`, 1);
    const ids = buildSessionTickets(new Map([['s1', evidence({ tool })]]), ALL).get('s1')!.map((t) => t.id);

    expect(ids[0]).toBe('BIG-1');
    expect(ids[ids.length - 1]).toBe(`BIG-${MAX_TICKETS_PER_SESSION}`);
  });

  it('reports which sessions were cut at the cap, and only those', () => {
    const full = new Map<string, number>();
    for (let i = 1; i <= MAX_TICKETS_PER_SESSION + 1; i++) full.set(`T-${i}`, 1);
    const exact = new Map<string, number>();
    for (let i = 1; i <= MAX_TICKETS_PER_SESSION; i++) exact.set(`T-${i}`, 1);
    const { tickets, truncated } = buildTicketReport(new Map([['over', evidence({ tool: full })], ['at', evidence({ tool: exact })]]), ALL);

    expect(tickets.get('over')).toHaveLength(MAX_TICKETS_PER_SESSION);
    expect([...truncated]).toEqual(['over']);
  });

  it('caps a session at the most-evidenced ids', () => {
    const tool = new Map<string, number>();
    for (let i = 1; i <= MAX_TICKETS_PER_SESSION + 5; i++) tool.set(`T-${i}`, i);
    const tickets = buildSessionTickets(new Map([['s1', evidence({ tool })]]), ALL).get('s1')!;

    expect(tickets).toHaveLength(MAX_TICKETS_PER_SESSION);
    expect(tickets.map((t) => t.id)).not.toContain('T-1');
    expect(tickets.map((t) => t.id)).toContain(`T-${MAX_TICKETS_PER_SESSION + 5}`);
  });
});
