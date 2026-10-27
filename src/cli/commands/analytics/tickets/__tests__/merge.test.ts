import { describe, it, expect } from 'vitest';
import { buildSessionTickets, MAX_TICKETS_PER_SESSION, type SessionEvidence, type TicketSource } from '../merge.js';

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
      branches: new Set(['GPT-1-branch']),
      prompts: new Set(['try gpt-4 on node-18', 'Gpt-5']),
    })]]), ALL);

    expect(result.get('s1')).toEqual([{ id: 'GPT-1', sources: { branch: 1 } }]);
  });

  it('drops prompt-only evidence entirely when no tool or branch id exists', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({ prompts: new Set(['CAKE-1']) })]]), ALL);
    expect(result.has('s1')).toBe(false);
  });

  it('ignores disabled sources', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({
      tool: new Map([['CAKE-1', 1]]),
      branches: new Set(['CAKE-2']),
      prompts: new Set(['CAKE-3']),
    })]]), new Set<TicketSource>(['branch']));

    expect(result.get('s1')).toEqual([{ id: 'CAKE-2', sources: { branch: 1 } }]);
  });

  it('corroborates prompts with tool and branch evidence even when only prompts are requested', () => {
    const result = buildSessionTickets(new Map([['s1', evidence({
      tool: new Map([['CAKE-1', 1]]),
      branches: new Set(['NUTLA-5-x']),
      prompts: new Set(['CAKE-2 and NUTLA-6 and ZZZ-9']),
    })]]), new Set<TicketSource>(['prompt']));

    expect(result.get('s1')).toEqual([
      { id: 'CAKE-2', sources: { prompt: 1 } },
      { id: 'NUTLA-6', sources: { prompt: 1 } },
    ]);
  });

  it('orders ids numerically and keeps the lower numbers on a cap tie', () => {
    const tool = new Map<string, number>();
    for (let i = 1; i <= MAX_TICKETS_PER_SESSION + 2; i++) tool.set(`BIG-${i}`, 1);
    const ids = buildSessionTickets(new Map([['s1', evidence({ tool })]]), ALL).get('s1')!.map((t) => t.id);

    expect(ids[0]).toBe('BIG-1');
    expect(ids[ids.length - 1]).toBe(`BIG-${MAX_TICKETS_PER_SESSION}`);
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
