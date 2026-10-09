/**
 * Tests for the pure `agent.session.summary` transcript-signal extractors: edit-diff line
 * counts, user turns, compactions, client versions and the session title.
 */

import { describe, it, expect } from 'vitest';
import {
  collectClientVersions,
  collectCompactions,
  collectEditLineStats,
  countTurns,
  latestTitle,
  type SignalLine,
} from '../session-signals.js';

function patchResult(...hunkLines: string[][]): SignalLine {
  return {
    type: 'user',
    toolUseResult: { structuredPatch: hunkLines.map((lines) => ({ lines })) },
  };
}

function boundary(timestamp: string, compactMetadata: SignalLine['compactMetadata']): SignalLine {
  return { type: 'system', subtype: 'compact_boundary', timestamp, compactMetadata };
}

describe('collectEditLineStats', () => {
  it('returns null for both counts when no result reports a diff', () => {
    expect(collectEditLineStats([])).toEqual({ linesAdded: null, linesRemoved: null });
    expect(
      collectEditLineStats([
        { type: 'user', message: { content: 'hello' } },
        { type: 'user', toolUseResult: 'plain string result' },
        { type: 'user', toolUseResult: { stdout: 'x' } },
      ])
    ).toEqual({ linesAdded: null, linesRemoved: null });
  });

  it('counts + and - lines of a structuredPatch and ignores context lines', () => {
    expect(collectEditLineStats([patchResult([' ctx', '-old', '+new1', '+new2', ' ctx'])])).toEqual({
      linesAdded: 2,
      linesRemoved: 1,
    });
  });

  it('sums every hunk of a patch and every result in the transcript', () => {
    const stats = collectEditLineStats([
      patchResult(['-a', '+b'], ['+c']),
      patchResult(['-d']),
    ]);
    expect(stats).toEqual({ linesAdded: 2, linesRemoved: 2 });
  });

  it('reports 0 (not null) once a diff was measured that changed nothing on one side', () => {
    expect(collectEditLineStats([patchResult(['+only added'])])).toEqual({
      linesAdded: 1,
      linesRemoved: 0,
    });
  });

  it('counts the lines of a created file, without counting a trailing newline as a line', () => {
    const create = (content: string): SignalLine => ({
      type: 'user',
      toolUseResult: { type: 'create', content },
    });
    expect(collectEditLineStats([create('a\nb\nc')]).linesAdded).toBe(3);
    expect(collectEditLineStats([create('a\nb\nc\n')]).linesAdded).toBe(3);
    expect(collectEditLineStats([create('')]).linesAdded).toBe(0);
    expect(collectEditLineStats([create('a\nb')]).linesRemoved).toBe(0);
  });

  it('skips a result of type create that has no string content', () => {
    expect(
      collectEditLineStats([{ type: 'user', toolUseResult: { type: 'create' } }])
    ).toEqual({ linesAdded: null, linesRemoved: null });
  });

  it('tolerates malformed hunks', () => {
    const line: SignalLine = {
      type: 'user',
      toolUseResult: { structuredPatch: [null, {}, { lines: 'nope' }, { lines: [1, '+ok'] }] },
    };
    expect(collectEditLineStats([line])).toEqual({ linesAdded: 1, linesRemoved: 0 });
  });
});

describe('countTurns', () => {
  it('counts string-content and text-block user prompts', () => {
    expect(
      countTurns([
        { type: 'user', message: { content: 'plain prompt' } },
        { type: 'user', message: { content: [{ type: 'text', text: 'block prompt' }] } },
      ])
    ).toBe(2);
  });

  it('does not count tool_result-only user lines', () => {
    expect(
      countTurns([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }])
    ).toBe(0);
  });

  it('does not count meta, sidechain or compaction-summary lines', () => {
    const content = 'text';
    expect(
      countTurns([
        { type: 'user', isMeta: true, message: { content } },
        { type: 'user', isSidechain: true, message: { content } },
        { type: 'user', isCompactSummary: true, message: { content } },
      ])
    ).toBe(0);
  });

  it('does not count assistant or system lines', () => {
    expect(
      countTurns([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
        { type: 'system' },
      ])
    ).toBe(0);
  });

  it('returns 0 for no lines', () => {
    expect(countTurns([])).toBe(0);
  });
});

describe('collectCompactions', () => {
  it('maps a compact_boundary line to the contract element shape', () => {
    const [compaction] = collectCompactions([
      boundary('2026-10-01T00:10:00.000Z', {
        trigger: 'auto',
        preTokens: 1000,
        postTokens: 300,
        durationMs: 60_000,
      }),
    ]);

    expect(compaction).toEqual({
      start: '2026-10-01T00:09:00.000Z',
      end: '2026-10-01T00:10:00.000Z',
      duration_ms: 60_000,
      trigger: 'auto',
      pre_tokens: 1000,
      post_tokens: 300,
      dropped_tokens: 700,
    });
  });

  it('returns one element per boundary, in transcript order', () => {
    const compactions = collectCompactions([
      boundary('2026-10-01T00:10:00.000Z', { trigger: 'auto', preTokens: 1 }),
      { type: 'user', message: { content: 'prompt' } },
      boundary('2026-10-01T00:20:00.000Z', { trigger: 'manual', preTokens: 2 }),
    ]);
    expect(compactions.map((c) => c.trigger)).toEqual(['auto', 'manual']);
  });

  it('ignores system lines of other subtypes and non-system lines', () => {
    expect(
      collectCompactions([
        { type: 'system', subtype: 'local_command' },
        { type: 'user', subtype: 'compact_boundary' },
        { type: 'user', isCompactSummary: true },
      ])
    ).toEqual([]);
  });

  it('uses null for unreported numbers and derives nothing from them', () => {
    const [compaction] = collectCompactions([boundary('2026-10-01T00:10:00.000Z', { trigger: 'auto' })]);
    expect(compaction).toMatchObject({
      start: null,
      duration_ms: null,
      pre_tokens: null,
      post_tokens: null,
      dropped_tokens: null,
    });
  });

  it('leaves dropped_tokens null when post exceeds pre', () => {
    const [compaction] = collectCompactions([
      boundary('2026-10-01T00:10:00.000Z', { preTokens: 100, postTokens: 300, durationMs: 1000 }),
    ]);
    expect(compaction.dropped_tokens).toBeNull();
    expect(compaction.pre_tokens).toBe(100);
    expect(compaction.post_tokens).toBe(300);
  });

  it('leaves start null for an unparseable timestamp and keeps end as given', () => {
    const [compaction] = collectCompactions([boundary('not-a-date', { durationMs: 1000 })]);
    expect(compaction.start).toBeNull();
    expect(compaction.end).toBe('not-a-date');
  });

  it('uses an empty end and null start when the boundary line has no timestamp', () => {
    const [compaction] = collectCompactions([
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { durationMs: 1000 } },
    ]);
    expect(compaction.end).toBe('');
    expect(compaction.start).toBeNull();
  });

  it('rejects negative and non-numeric metadata values', () => {
    const [compaction] = collectCompactions([
      boundary('2026-10-01T00:10:00.000Z', {
        preTokens: -5,
        postTokens: '10',
        durationMs: Number.NaN,
        trigger: 3,
      }),
    ]);
    expect(compaction).toMatchObject({
      start: null,
      duration_ms: null,
      pre_tokens: null,
      post_tokens: null,
      dropped_tokens: null,
      trigger: '',
    });
  });
});

describe('collectClientVersions', () => {
  it('returns distinct versions in order of first appearance', () => {
    expect(
      collectClientVersions([
        { version: '2.1.283' },
        { version: '2.1.284' },
        { version: '2.1.283' },
      ])
    ).toEqual(['2.1.283', '2.1.284']);
  });

  it('skips lines without a usable version', () => {
    expect(collectClientVersions([{}, { version: '' }, { version: 5 as unknown as string }])).toEqual([]);
  });
});

describe('latestTitle', () => {
  it('returns the latest ai-title', () => {
    expect(
      latestTitle([
        { type: 'ai-title', aiTitle: 'First' },
        { type: 'user' },
        { type: 'ai-title', aiTitle: 'Second' },
      ])
    ).toBe('Second');
  });

  it('skips blank titles and falls back to an earlier one', () => {
    expect(
      latestTitle([
        { type: 'ai-title', aiTitle: 'Earlier' },
        { type: 'ai-title', aiTitle: '   ' },
      ])
    ).toBe('Earlier');
  });

  it('trims and cuts the title to 200 characters', () => {
    const title = latestTitle([{ type: 'ai-title', aiTitle: `  ${'x'.repeat(250)}  ` }]);
    expect(title).toBe('x'.repeat(200));
  });

  it('ignores aiTitle on lines of other types and returns "" when there is none', () => {
    expect(latestTitle([{ type: 'user', aiTitle: 'not a title' }])).toBe('');
    expect(latestTitle([])).toBe('');
  });
});
