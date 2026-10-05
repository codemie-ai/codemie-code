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
    linesAdded: 0,
    linesRemoved: 0,
    filesChanged: new Set<string>(),
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
  it('omits ended_at entirely for phase "incremental"', () => {
    const event = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      undefined
    );

    expect('ended_at' in event).toBe(false);
    expect(Object.keys(event)).not.toContain('ended_at');
    expect(event.type).toBe('agent.session.summary');
    expect(event.session_id).toBe('session-1');
    expect(event.phase).toBe('incremental');
    expect(event.started_at).toBe('2026-10-01T00:00:00.000Z');
  });

  it('includes ended_at for phase "final"', () => {
    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect('ended_at' in event).toBe(true);
    expect(event.ended_at).toBe('2026-10-01T01:00:00.000Z');
    expect(event.phase).toBe('final');
  });

  it('flattens acc.toolCalls {calls, errors} shape into separate tool_calls/tool_errors maps', () => {
    const acc = emptyAccumulator();
    acc.toolCalls = {
      Read: { calls: 5, errors: 0 },
      Edit: { calls: 3, errors: 1 },
    };

    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.tool_calls).toEqual({ Read: 5, Edit: 3 });
    expect(event.tool_errors).toEqual({ Read: 0, Edit: 1 });
  });

  it('derives skills_used and primary_command from a constructed NamedInvocationCounts', () => {
    const named: NamedInvocationCounts = {
      skillInvocations: { 'codemie:msgraph': 2, brainstorming: 1 },
      agentInvocations: {},
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

    expect(event.skills_used).toEqual({ 'codemie:msgraph': 2, brainstorming: 1 });
    expect(event.primary_command).toBe('deploy');
    expect(event.commands_in_order).toEqual(Object.keys(named.commandInvocations));
  });

  it('reports models_used as the full count map and primary_model as the max key', () => {
    const acc = emptyAccumulator();
    acc.models = { 'claude-sonnet-4-5': 2, 'claude-opus-4-1': 9 };

    const event = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      undefined
    );

    expect(event.models_used).toEqual({ 'claude-sonnet-4-5': 2, 'claude-opus-4-1': 9 });
    expect(event.primary_model).toBe('claude-opus-4-1');
  });

  it('reports lines/files/compaction fields and branch_counts/branch_dominant, converting Sets to arrays', () => {
    const acc = emptyAccumulator();
    acc.linesAdded = 42;
    acc.linesRemoved = 7;
    acc.filesChanged = new Set(['a.ts', 'b.ts']);
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

    expect(event.lines_added).toBe(42);
    expect(event.lines_removed).toBe(7);
    expect(event.files_changed).toEqual(['a.ts', 'b.ts']);
    expect(event.files_written).toEqual(['a.ts']);
    expect(event.compaction_count).toBe(2);
    expect(event.branch_counts).toBe(branchCounts);
    expect(event.branch_dominant).toBe('feature');
  });

  it('emits title as a literal empty string (no identified source, per Open risks)', () => {
    const event = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      undefined
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
      undefined
    );

    expect('api_calls' in event).toBe(false);
  });
});
