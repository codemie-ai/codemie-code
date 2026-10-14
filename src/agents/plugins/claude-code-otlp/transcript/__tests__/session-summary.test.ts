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
import type { Compaction } from '../session-signals.js';

function emptyAccumulator(): SessionSummaryAccumulator {
  return {
    models: {},
    toolCalls: {},
    toolResults: 0,
    filesEdited: new Set<string>(),
    filesWritten: new Set<string>(),
    linesAdded: null,
    linesRemoved: null,
    turns: 0,
    compactions: [],
    clientVersions: [],
    commandsInOrder: [],
    title: '',
    lastGitBranch: '',
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

  it('breaks a tie in favour of the later branch', () => {
    expect(branchDominant({ main: 2, feature: 2 })).toBe('feature');
    expect(branchDominant({ main: 2, feature: 2, hotfix: 1 })).toBe('feature');
  });
});

describe('primaryModel', () => {
  it('returns the highest-count model key', () => {
    expect(primaryModel({ 'claude-sonnet-4-5': 2, 'claude-opus-4-1': 9 })).toBe('claude-opus-4-1');
  });

  it('returns "" for an empty map', () => {
    expect(primaryModel({})).toBe('');
  });

  it('breaks a tie in favour of the first model', () => {
    expect(primaryModel({ 'claude-sonnet-4-5': 3, 'claude-opus-4-1': 3 })).toBe('claude-sonnet-4-5');
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

  it('derives skills and agents from a constructed NamedInvocationCounts', () => {
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
  });

  it('reports commands in call order with repeats, and the first one as primary_command', () => {
    const acc = emptyAccumulator();
    acc.commandsInOrder = ['init', 'deploy', 'deploy', 'init', 'deploy'];

    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.commands).toEqual(['init', 'deploy', 'deploy', 'init', 'deploy']);
    // 'deploy' is the most frequent, but the contract's primary_command is the first.
    expect(event.primary_command).toBe('init');
  });

  it('reports an empty commands array and an empty primary_command when no command was run', () => {
    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.commands).toEqual([]);
    expect(event.primary_command).toBe('');
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

  it('reports files_changed/written/edited as counts and the branch fields from branchCounts', () => {
    const acc = emptyAccumulator();
    acc.filesEdited = new Set(['b.ts']);
    acc.filesWritten = new Set(['a.ts']);

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

    expect(event.files_changed).toBe(2);
    expect(event.files_written).toBe(1);
    expect(event.files_edited).toBe(1);
    expect(event.branch_counts).toBe(branchCounts);
    expect(event.branch_dominant).toBe('feature');
  });

  it('reports lines_* as null while unmeasured (never 0), and as the accumulated counts otherwise', () => {
    const unmeasured = buildSessionSummaryEvent(
      'session-1',
      'final',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );
    expect(unmeasured.lines_added).toBeNull();
    expect(unmeasured.lines_removed).toBeNull();

    const acc = emptyAccumulator();
    acc.linesAdded = 120;
    acc.linesRemoved = 0;
    const measured = buildSessionSummaryEvent(
      'session-1',
      'final',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );
    expect(measured.lines_added).toBe(120);
    expect(measured.lines_removed).toBe(0);
  });

  it('derives compaction_count, compaction_pre_tokens and compactions from acc.compactions', () => {
    const compactions: Compaction[] = [
      {
        start: '2026-10-01T00:09:00.000Z',
        end: '2026-10-01T00:10:00.000Z',
        duration_ms: 60_000,
        trigger: 'auto',
        pre_tokens: 1000,
        post_tokens: 300,
        dropped_tokens: 700,
      },
      {
        start: null,
        end: '2026-10-01T00:20:00.000Z',
        duration_ms: null,
        trigger: 'manual',
        pre_tokens: 500,
        post_tokens: null,
        dropped_tokens: null,
      },
    ];
    const acc = emptyAccumulator();
    acc.compactions = compactions;

    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.compaction_count).toBe(2);
    expect(event.compaction_pre_tokens).toBe(1500);
    expect(event.compactions).toEqual(compactions);
  });

  it('reports no compactions as a zero count, a zero sum and an empty array', () => {
    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.compaction_count).toBe(0);
    expect(event.compaction_pre_tokens).toBe(0);
    expect(event.compactions).toEqual([]);
  });

  it('passes turns, client_versions and git_branch from the accumulator', () => {
    const acc = emptyAccumulator();
    acc.turns = 7;
    acc.clientVersions = ['2.1.283', '2.1.284'];
    acc.lastGitBranch = 'feature/ABC-123';

    const event = buildSessionSummaryEvent(
      'session-1',
      'final',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z'
    );

    expect(event.turns).toBe(7);
    expect(event.client_versions).toEqual(['2.1.283', '2.1.284']);
    expect(event.git_branch).toBe('feature/ABC-123');
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

  it('emits title as an empty string when the accumulator has none, and the accumulator title otherwise', () => {
    const none = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      emptyAccumulator(),
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      ''
    );
    expect(none.title).toBe('');

    const acc = emptyAccumulator();
    acc.title = 'Review preflight plan';
    const titled = buildSessionSummaryEvent(
      'session-1',
      'incremental',
      acc,
      emptyNamed(),
      {},
      '2026-10-01T00:00:00.000Z',
      ''
    );
    expect(titled.title).toBe('Review preflight plan');
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
