import { describe, it, expect } from 'vitest';
import { groupHookRecords } from '../hook-records.js';

/** A spool line as the daemon stores it: the envelope around the wire event built at hook time. */
function spoolLine(wireEvent: Record<string, unknown>): string {
  return JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(wireEvent) });
}

describe('groupHookRecords', () => {
  it('forwards each raw wire event byte for byte, newline-delimited', () => {
    const first = { type: 'agent.prompt.submit', session_id: 's1', timestamp: '2026-01-01T00:00:00.000Z', zeta: 1, alpha: { b: 2 } };
    const second = { type: 'agent.tool.end', session_id: 's1' };

    const result = groupHookRecords([spoolLine(first), spoolLine(second)], 'A', false);

    expect(result.groups).toEqual([
      { project: 'A', ndjson: `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, containsSessionEnd: false },
    ]);
    expect(result.malformed).toBe(0);
  });

  it('does not synthesize or change any field', () => {
    const bare = { session_id: 's1', hook_event_name: 'SessionEnd' };

    const result = groupHookRecords([spoolLine(bare)], 'A', false);

    expect(JSON.parse(result.groups[0].ndjson.trim())).toEqual(bare);
  });

  it('counts and skips malformed lines, keeping the good ones', () => {
    const good = { type: 'agent.tool.end', session_id: 's1' };
    const badEnvelope = 'not json';
    const badRaw = JSON.stringify({ agentName: 'x', hookEvent: 'not json' });
    const noHookEvent = JSON.stringify({ agentName: 'x' });

    const result = groupHookRecords([badEnvelope, spoolLine(good), badRaw, noHookEvent], 'A', false);

    expect(result.malformed).toBe(3);
    expect(result.groups.map((g) => g.ndjson)).toEqual([`${JSON.stringify(good)}\n`]);
  });

  it('returns no group when nothing is usable', () => {
    expect(groupHookRecords(['nope'], 'A', false)).toEqual({
      groups: [],
      malformed: 1,
      unsendable: 0,
      unsendableSessionEnd: false,
    });
  });

  it('detects a session end from the wire type, not from hook_event_name', () => {
    const endOf = (event: Record<string, unknown>): boolean =>
      groupHookRecords([spoolLine(event)], 'A', false).groups[0].containsSessionEnd;

    expect(endOf({ type: 'agent.session.end', session_id: 's1' })).toBe(true);
    expect(endOf({ type: 'agent.session.stop', hook_event_name: 'SessionEnd' })).toBe(false);
    expect(endOf({ hook_event_name: 'SessionEnd' })).toBe(false);
  });

  it('groups by lowercased top-level name in first-appearance order, keeping file order and bytes', () => {
    const events = [
      { type: 't', n: 1, codemie_project_name: 'b' },
      { type: 't', n: 2, codemie_project_name: 'A' },
      { type: 't', n: 3, codemie_project_name: 'B' },
      { type: 't', n: 4 },
      { type: 't', n: 5, codemie_project_name: 'a' },
    ];

    const result = groupHookRecords(events.map(spoolLine), 'A', false);

    expect(result.groups).toEqual([
      { project: 'b', ndjson: `${JSON.stringify(events[0])}\n${JSON.stringify(events[2])}\n`, containsSessionEnd: false },
      {
        project: 'A',
        ndjson: `${JSON.stringify(events[1])}\n${JSON.stringify(events[3])}\n${JSON.stringify(events[4])}\n`,
        containsSessionEnd: false,
      },
    ]);
    expect(result.unsendable).toBe(0);
  });

  it('uses the bound spelling for the bound group even when an event spells it differently first', () => {
    const result = groupHookRecords([spoolLine({ codemie_project_name: 'proj a' })], 'Proj A', false);

    expect(result.groups.map((g) => g.project)).toEqual(['Proj A']);
  });

  it('puts blank, non-string and raw-only names into the bound group', () => {
    const events = [
      { type: 't', codemie_project_name: '  ' },
      { type: 't', codemie_project_name: 7 },
      { type: 't', raw: { codemie_project_name: 'B' } },
    ];

    const result = groupHookRecords(events.map(spoolLine), 'A', false);

    expect(result.groups).toEqual([
      { project: 'A', ndjson: `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, containsSessionEnd: false },
    ]);
  });

  it('yields one group headed by the bound project for a filtered batch', () => {
    const events = [{ codemie_project_name: 'a' }, { codemie_project_name: 'B' }];

    const result = groupHookRecords(events.map(spoolLine), 'A', true);

    expect(result.groups).toEqual([
      { project: 'A', ndjson: `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, containsSessionEnd: false },
    ]);
  });

  it('drops a group whose name cannot be sent as a header and counts it', () => {
    const events = [{ codemie_project_name: 'Café' }, { codemie_project_name: 'A' }];

    const result = groupHookRecords(events.map(spoolLine), 'A', false);

    expect(result.groups.map((g) => g.project)).toEqual(['A']);
    expect(result.unsendable).toBe(1);
    expect(result.unsendableSessionEnd).toBe(false);
  });

  it('flags the session end per group, and separately for an unsent group', () => {
    const result = groupHookRecords(
      [
        'nope',
        spoolLine({ type: 'agent.session.end', codemie_project_name: 'B' }),
        spoolLine({ type: 'agent.session.end', codemie_project_name: 'Café' }),
        spoolLine({ type: 't' }),
      ],
      'A',
      false
    );

    expect(result.groups.map((g) => [g.project, g.containsSessionEnd])).toEqual([
      ['B', true],
      ['A', false],
    ]);
    expect(result.unsendableSessionEnd).toBe(true);
    expect(result.malformed).toBe(1);
  });
});
