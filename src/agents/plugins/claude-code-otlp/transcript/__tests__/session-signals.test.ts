/**
 * Tests for the pure `agent.session.summary` transcript-signal extractors: edit-diff line
 * counts, user turns, compactions, client versions and the session title.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCompactionDoneEvent,
  collectClientVersions,
  collectCompactions,
  collectEditLineStats,
  countTurns,
  latestTitle,
  type Compaction,
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
      toolUseResult: { type: 'create', structuredPatch: [], originalFile: null, content },
    });
    expect(collectEditLineStats([create('a\nb\nc')]).linesAdded).toBe(3);
    expect(collectEditLineStats([create('a\nb\nc\n')]).linesAdded).toBe(3);
    expect(collectEditLineStats([create('')]).linesAdded).toBe(0);
    expect(collectEditLineStats([create('a\nb')]).linesRemoved).toBe(0);
  });

  it('sums a new-file Write and a later Edit of the same session', () => {
    const stats = collectEditLineStats([
      {
        type: 'user',
        toolUseResult: {
          type: 'create',
          structuredPatch: [],
          originalFile: null,
          content: 'one\ntwo\nthree\nfour\nfive\n',
        },
      },
      patchResult(['-old', '+new']),
    ]);
    expect(stats).toEqual({ linesAdded: 6, linesRemoved: 1 });
  });

  it('counts an overwrite (type update) by its patch', () => {
    expect(
      collectEditLineStats([
        {
          type: 'user',
          toolUseResult: { type: 'update', structuredPatch: [{ lines: ['-a', '+b', '+c'] }] },
        },
      ])
    ).toEqual({ linesAdded: 2, linesRemoved: 1 });
  });

  it('counts an overwrite that changed nothing (type update, empty patch) as zero, not by its content', () => {
    expect(
      collectEditLineStats([
        { type: 'user', toolUseResult: { type: 'update', structuredPatch: [], content: 'a\nb\n' } },
      ])
    ).toEqual({ linesAdded: 0, linesRemoved: 0 });
  });

  it('counts a create that carries a non-empty patch by its patch', () => {
    expect(
      collectEditLineStats([
        { type: 'user', toolUseResult: { type: 'create', structuredPatch: [{ lines: ['+a', '+b'] }] } },
      ])
    ).toEqual({ linesAdded: 2, linesRemoved: 0 });
  });

  it('counts a create without a structuredPatch field by its content', () => {
    expect(
      collectEditLineStats([{ type: 'user', toolUseResult: { type: 'create', content: 'a\nb\nc\n' } }])
    ).toEqual({ linesAdded: 3, linesRemoved: 0 });
  });

  it('skips a result of type create that has no string content', () => {
    expect(
      collectEditLineStats([{ type: 'user', toolUseResult: { type: 'create' } }])
    ).toEqual({ linesAdded: null, linesRemoved: null });
    expect(
      collectEditLineStats([{ type: 'user', toolUseResult: { type: 'create', structuredPatch: [] } }])
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

  it('counts typed, pasted and command prompts, not lines Claude Code writes itself or auto prompts', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('typed prompt'),
        user([{ type: 'text', text: 'typed block prompt' }]),
        user('  <pasted_content id="1">pasted</pasted_content>'),
        user('<command-name>/plan</command-name>'),
        user([{ type: 'text', text: '[Request interrupted by user]' }]),
        user('<local-command-stdout>out</local-command-stdout>'),
        user('<local-command-stderr>err</local-command-stderr>'),
        user('<local-command-caveat>Caveat</local-command-caveat>'),
        user('<bash-stdout>out</bash-stdout>'),
        user('<bash-stderr>err</bash-stderr>'),
        user('<bash-input>ls</bash-input>'),
        user('<task-notification><task-id>t1</task-id></task-notification>'),
        user('<agent-message from="worker">Report</agent-message>'),
      ])
    ).toBe(4);
  });

  function caveat(): SignalLine {
    return { type: 'user', isMeta: true, message: { content: '<local-command-caveat>Caveat: local commands</local-command-caveat>' } };
  }

  function wrappedCommand(name: string): SignalLine {
    return {
      type: 'user',
      message: {
        content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`,
      },
    };
  }

  function stdout(text = 'ok'): SignalLine {
    return { type: 'user', message: { content: `<local-command-stdout>${text}</local-command-stdout>` } };
  }

  function localCommandSystemLine(): SignalLine {
    return { type: 'system', subtype: 'local_command' };
  }

  it('excludes a command marked local by a preceding <local-command-caveat> line, regardless of its name, EPMCDME-15582 regression', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('typed prompt'),
        caveat(),
        wrappedCommand('add-dir'), // not in the old denylist — proves the marker, not a name list, drives exclusion
        stdout(),
      ])
    ).toBe(1);
  });

  it('excludes a marked-local command whose follow-up marker is a system line (newer Claude Code versions)', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('typed prompt'),
        caveat(),
        wrappedCommand('permissions'),
        localCommandSystemLine(),
      ])
    ).toBe(1);
  });

  it('counts a command wrapper not preceded by a caveat line as a genuine prompt command', () => {
    expect(countTurns([wrappedCommand('init')])).toBe(1);
  });

  /** The continuation-summary line Claude Code inserts right after a `compact_boundary`. */
  function compactSummary(): SignalLine {
    return { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation...' } };
  }

  function boundary(): SignalLine {
    return { type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-17T00:00:00.000Z' };
  }

  it('still counts /compact even though it is marked local, because a compact_boundary line precedes it, in real transcript order (PR #824 review)', () => {
    // Real Claude Code order: the boundary is written before /compact's own caveat/wrapper/stdout,
    // not after — confirmed against real transcripts (2.1.138-2.1.326); a forward scan never finds it.
    expect(
      countTurns([
        boundary(),
        compactSummary(),
        caveat(),
        wrappedCommand('compact'),
        stdout('Compacted'),
      ])
    ).toBe(1);
  });

  it('does not double-count /compact when Claude Code also records the separately-typed raw text line, the full real shape', () => {
    // Real Claude Code also writes an un-wrapped `/compact` user line before the boundary — already
    // a genuine turn on its own. Rescuing the wrapped replay too would count the same invocation
    // twice; confirmed against real local transcripts on this machine (manual-trigger /compact).
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('/compact'), // the raw typed command, not wrapped — already a genuine turn on its own
        boundary(),
        compactSummary(),
        caveat(),
        wrappedCommand('compact'),
        stdout('Compacted'),
      ])
    ).toBe(1);
  });

  it('still counts /compact via the rescue when there is no separately-typed raw text line before it (the case the rescue exists for)', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('some earlier real prompt'),
        boundary(),
        compactSummary(),
        caveat(),
        wrappedCommand('compact'),
        stdout('Compacted'),
      ])
    ).toBe(2); // the earlier, unrelated prompt + the rescued /compact
  });

  it('does not let a typed /compact line dedup an unrelated later rescue separated by a genuine turn', () => {
    // The raw-text dedup check must only suppress the rescue when the typed line is the *nearest*
    // real turn behind the boundary — an intervening genuine prompt means this boundary belongs to
    // a different, later invocation with no typed line of its own, so the rescue must still apply.
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('/compact'), // an earlier, separate manual compaction (own boundary not shown)
        user('a genuine prompt after resuming'),
        boundary(), // this boundary belongs to the second /compact below, not the typed line above
        compactSummary(),
        caveat(),
        wrappedCommand('compact'),
        stdout('Compacted'),
      ])
    ).toBe(3); // the typed line + the genuine prompt + the rescued second /compact
  });

  it('excludes consecutive marked-local commands, each preceded by its own caveat line', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('typed prompt'),
        caveat(),
        wrappedCommand('exit'),
        stdout('Goodbye!'),
        caveat(),
        wrappedCommand('usage'),
        stdout(),
      ])
    ).toBe(1);
  });

  it('does not treat a prompt that merely mentions the caveat tag mid-text as a marker for the next line', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('what does <local-command-caveat> mean?'),
        wrappedCommand('init'),
      ])
    ).toBe(2);
  });

  it('CR-001: still counts /compact when a self-written stdout line (from an unrelated earlier command) sits between the previous real turn and the compact_boundary line', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('earlier real prompt'),
        stdout('leftover output from an earlier, unrelated local command'),
        boundary(),
        compactSummary(),
        caveat(),
        wrappedCommand('compact'),
        stdout('Compacted'),
      ])
    ).toBe(2);
  });

  /** A bookkeeping line with no `message` field at all (e.g. `file-history-snapshot`, `cost-state`). */
  function bookkeepingLine(): SignalLine {
    return { type: 'file-history-snapshot' };
  }

  it('CR-002: excludes a marked-local command even when a bookkeeping line (no message field) sits between the caveat and the wrapper', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('typed prompt'),
        caveat(),
        bookkeepingLine(),
        wrappedCommand('add-dir'),
        stdout(),
      ])
    ).toBe(1);
  });

  it('CR-003: does not rescue a non-/compact marked-local command via an unrelated preceding compact_boundary', () => {
    expect(
      countTurns([
        boundary(),
        compactSummary(),
        caveat(),
        wrappedCommand('usage'), // not /compact — must stay excluded even though a boundary precedes
        stdout(),
      ])
    ).toBe(0);
  });

  it('CR-004: still counts /compact when an auto-prompt line sits between the previous real turn and the compact_boundary line', () => {
    const autoPrompt = (): SignalLine =>
      ({ type: 'user', message: { content: '<task-notification><task-id>t1</task-id></task-notification>' } });
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('earlier real prompt'),
        autoPrompt(),
        boundary(),
        compactSummary(),
        caveat(),
        wrappedCommand('compact'),
        stdout('Compacted'),
      ])
    ).toBe(2);
  });

  it('round-4 CR-003: a free-text prompt sharing the /compact prefix must not suppress an unrelated /compact rescue', () => {
    // isTypedCompactText is anchored with a word boundary, not a bare startsWith: "/compactify" or
    // other text merely starting with "/compact" is not the typed trigger for this invocation.
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('/compactify the deployment pipeline please'),
        boundary(),
        compactSummary(),
        caveat(),
        wrappedCommand('compact'),
        stdout('Compacted'),
      ])
    ).toBe(2); // the free-text prompt + the rescued, unrelated /compact
  });

  it('round-4 CR-004: a tool_result-only message line between the caveat and its wrapper does not break exclusion', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    const toolResultLine = (): SignalLine => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1' } as unknown] },
    });
    expect(
      countTurns([
        user('typed prompt'),
        caveat(),
        toolResultLine(), // carries a message field, but no text — must not be mistaken for the caveat's neighbor
        wrappedCommand('add-dir'),
        stdout(),
      ])
    ).toBe(1);
  });

  it('round-4 CR-004: an explicit message: null line between the caveat and its wrapper does not break exclusion', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    const nullMessageLine = (): SignalLine => ({ type: 'user', message: null as unknown as { content?: unknown } });
    expect(
      countTurns([
        user('typed prompt'),
        caveat(),
        nullMessageLine(),
        wrappedCommand('add-dir'),
        stdout(),
      ])
    ).toBe(1);
  });

  it('round-4 CR-002: the full 15-Nov regression shape (prompt + /context + /usage + /compact + 2 skills + /init) counts TURNS=5', () => {
    const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
    expect(
      countTurns([
        user('a genuine typed prompt'),
        caveat(),
        wrappedCommand('context'), // marked local, no model call — excluded
        stdout(),
        caveat(),
        wrappedCommand('usage'), // marked local, no model call — excluded
        stdout(),
        boundary(),
        compactSummary(),
        caveat(),
        wrappedCommand('compact'), // marked local, but rescued: calls the model
        stdout('Compacted'),
        wrappedCommand('skill-one'), // skill-backed command, not preceded by a caveat — calls the model
        wrappedCommand('skill-two'),
        wrappedCommand('init'), // calls the model, not preceded by a caveat
      ])
    ).toBe(5);
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

describe('buildCompactionDoneEvent', () => {
  it('builds agent.session.compact.done from a Compaction, using its end as the record timestamp', () => {
    const compaction: Compaction = {
      start: '2026-10-01T00:09:00.000Z',
      end: '2026-10-01T00:10:00.000Z',
      duration_ms: 60_000,
      trigger: 'auto',
      pre_tokens: 1000,
      post_tokens: 300,
      dropped_tokens: 700,
    };

    expect(buildCompactionDoneEvent('sid-1', compaction)).toEqual({
      type: 'agent.session.compact.done',
      session_id: 'sid-1',
      pre_tokens: 1000,
      post_tokens: 300,
      dropped_tokens: 700,
      duration_ms: 60_000,
      timestamp: '2026-10-01T00:10:00.000Z',
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
