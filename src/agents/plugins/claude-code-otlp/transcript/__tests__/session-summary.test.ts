/**
 * Tests for the `agent.session.summary` builder: `updateBranchCounts`, `primaryModel`,
 * `branchDominant`, and `buildSessionSummaryEvent`.
 */

import { describe, it, expect } from 'vitest';
import {
  updateBranchCounts,
  primaryModel,
  branchDominant,
  buildSessionSummaryEvent,
  type SessionSummaryAccumulator,
} from '../session-summary.js';
import type { NamedInvocationCounts } from '@/agents/plugins/claude/session/claude-named-invocations.js';

function emptyAccumulator(): SessionSummaryAccumulator {
  return {
    models: {},
    toolCalls: {},
    toolResults: 0,
    filesEdited: new Set<string>(),
    filesWritten: new Set<string>(),
    compactionCount: 0,
  };
}

function emptyNamed(): NamedInvocationCounts {
  return { skillInvocations: {}, agentInvocations: {}, commandInvocations: {} };
}

describe('branchDominant', () => {
  it('resolves the highest-count branch (mid-session branch-switch scenario)', () => {
    expect(branchDominant({ main: 3, feature: 7 })).toBe('feature');
  });

  it('returns "" for an empty map', () => {
    expect(branchDominant({})).toBe('');
  });
});

describe('primaryModel', () => {
  it('returns the highest-count model key', () => {
    expect(primaryModel({ 'claude-sonnet-4-5': 2, 'claude-opus-4-1': 9 })).toBe('claude-opus-4-1');
  });

  it('returns "" for an empty map', () => {
    expect(primaryModel({})).toBe('');
  });
});

describe('updateBranchCounts', () => {
  it('mutates the passed-in counts object in place, bumping the named branch by 1 each call', () => {
    const counts: Record<string, number> = {};

    updateBranchCounts(counts, 'main');
    expect(counts.main).toBe(1);

    updateBranchCounts(counts, 'main');
    expect(counts.main).toBe(2);
  });

  it('skips incrementing when branch is falsy/empty', () => {
    const counts: Record<string, number> = {};

    updateBranchCounts(counts, '');

    expect(counts['']).toBeUndefined();
    expect(Object.keys(counts)).toHaveLength(0);
  });
});

describe('buildSessionSummaryEvent', () => {
  it('sets is_final from phase and always carries started_at/ended_at', () => {
    const incremental = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:30:00.000Z'
    );

    expect(incremental.type).toBe('agent.session.summary');
    expect(incremental.session_id).toBe('session-1');
    expect(incremental.is_final).toBe(false);
    expect(incremental.started_at).toBe('2026-10-01T00:00:00.000Z');
    expect(incremental.ended_at).toBe('2026-10-01T00:30:00.000Z');

    const final = buildSessionSummaryEvent(
      'session-1',
      'final',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(final.is_final).toBe(true);
  });

  it('computes duration_ms from started_at/ended_at, and null when either is missing', () => {
    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );
    expect(event.duration_ms).toBe(3_600_000);
    expect(event.ended_at).toBe('2026-10-01T01:00:00.000Z');

    const noEndedAt = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      ''
    );
    expect(noEndedAt.duration_ms).toBeNull();
    expect(noEndedAt.ended_at).toBeNull();
  });

  it('sets the envelope timestamp to ended_at, so the forwarder has a real one to prefer', () => {
    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );
    expect(event.timestamp).toBe('2026-10-01T01:00:00.000Z');

    const noEndedAt = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      ''
    );
    expect(noEndedAt.timestamp).toBeUndefined();
  });

  it('reports acc.toolCalls verbatim as tools, plus tool_calls/tool_errors/tool_results totals', () => {
    const acc = emptyAccumulator();
    acc.toolCalls = {
      Read: { calls: 5, errors: 0 },
      Edit: { calls: 3, errors: 1 },
    };
    acc.toolResults = 8;

    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.tools).toEqual({
      Read: { calls: 5, errors: 0 },
      Edit: { calls: 3, errors: 1 },
    });
    expect(event.tool_calls).toBe(8);
    expect(event.tool_errors).toBe(1);
    expect(event.tool_results).toBe(8);
  });

  it('derives skills, agents and primary_command from a constructed NamedInvocationCounts', () => {
    const named: NamedInvocationCounts = {
      skillInvocations: { 'codemie:msgraph': 2, brainstorming: 1 },
      agentInvocations: { Explore: 2 },
      commandInvocations: { init: 1, deploy: 4 },
    };

    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      emptyAccumulator(),
      named,
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.skills).toEqual({ 'codemie:msgraph': 2, brainstorming: 1 });
    expect(event.agents).toEqual({ Explore: 2 });
    expect(event.primary_command).toBe('deploy');
    expect(event.commands).toEqual(Object.keys(named.commandInvocations));
  });

  it('reports models as an array with the primary model first', () => {
    const acc = emptyAccumulator();
    acc.models = { 'claude-sonnet-4-5': 2, 'claude-opus-4-1': 9 };

    const event = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      ''
    );

    expect(event.models).toEqual(['claude-opus-4-1', 'claude-sonnet-4-5']);
    expect(event.primary_model).toBe('claude-opus-4-1');
  });

  it('reports lines_* as null and files_changed/written/edited as counts', () => {
    const acc = emptyAccumulator();
    acc.filesEdited = new Set(['b.ts']);
    acc.filesWritten = new Set(['a.ts']);
    acc.compactionCount = 2;

    const branchCounts = { main: 3, feature: 7 };

    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      acc,
      emptyNamed(),
      branchCounts,
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.lines_added).toBeNull();
    expect(event.lines_removed).toBeNull();
    expect(event.files_changed).toBe(2);
    expect(event.files_written).toBe(1);
    expect(event.files_edited).toBe(1);
    expect(event.compaction_count).toBe(2);
    expect(event.branch_counts).toBe(branchCounts);
    expect(event.branch_dominant).toBe('feature');
  });

  it('counts a file touched by both Edit and Write once in files_changed', () => {
    const acc = emptyAccumulator();
    acc.filesEdited = new Set(['a.ts']);
    acc.filesWritten = new Set(['a.ts']);

    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.files_changed).toBe(1);
    expect(event.files_written).toBe(1);
    expect(event.files_edited).toBe(1);
  });

  it('emits title as a literal empty string (no identified source)', () => {
    const event = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      ''
    );

    expect(event.title).toBe('');
  });

  it('does not include an apiCalls/api_calls field (left to the caller/orchestrator to merge)', () => {
    const event = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      ''
    );

    expect('api_calls' in event).toBe(false);
  });
});
