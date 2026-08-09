/**
 * Native (unmanaged) Pi session synthesis.
 *
 * Pi's v3 JSONL is neither Claude- nor Codex-shaped: every line is an
 * `{ type, id, parentId, timestamp, message }` envelope, tool results have their own
 * `toolResult` role, and the working directory lives in the file's `session` header rather
 * than on each message. These tests pin the shape a bare `pi` run must be translated into.
 */

import { describe, it, expect } from 'vitest';
import { synthesizeRawSession, synthesizePiRawSession, loadNativeSessions, type NativeLoaderDeps } from '../native-loader.js';
import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';
import type { SessionDescriptor } from '../../../../agents/core/session/discovery-types.js';
import { PI_FORKED_CONTINUATION, PI_SUBAGENT_RUN } from '../../../../agents/plugins/pi/pi.session.js';

const descriptor: SessionDescriptor = {
  sessionId: '019fdb4a-c16f-70fa-bb4b-07bd16c46cc1',
  filePath: '/sessions/2026-08-07T08-15-37-327Z_019fdb4a.jsonl',
  projectPath: '/decoded/hint',
  createdAt: 1_000,
  updatedAt: 2_000,
  agentName: 'pi',
};

function entry(type: string, id: string, timestamp: string, rest: Record<string, unknown> = {}): unknown {
  return { type, id, parentId: null, timestamp, ...rest };
}

/** Pi writes an ISO timestamp on the envelope and the same instant as epoch ms on the message. */
function userEntry(id: string, timestamp: string, text: string): unknown {
  return entry('message', id, timestamp, { message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(timestamp) } });
}

function assistantEntry(id: string, timestamp: string, model: string, extra: Record<string, unknown> = {}): unknown {
  return entry('message', id, timestamp, { message: { role: 'assistant', content: [], model, timestamp: Date.parse(timestamp), ...extra } });
}

/** The adapter reads projectPath from the transcript's own `session` header. */
function piParsed(messages: unknown[], metadata: Record<string, unknown> = { projectPath: '/repo' }): ParsedSession {
  return { sessionId: descriptor.sessionId, agentName: 'Pi', metadata, messages } as ParsedSession;
}

const conversation = piParsed([
  entry('session', 'hdr', '2026-08-07T08:15:37.327Z', { version: 3, cwd: '/repo' }),
  userEntry('u1', '2026-08-07T08:15:40.000Z', 'add pi support'),
  assistantEntry('a1', '2026-08-07T08:15:45.000Z', 'kimi-k2.7-code'),
  entry('message', 't1', '2026-08-07T08:15:50.000Z', {
    message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [], isError: false, timestamp: Date.parse('2026-08-07T08:15:50.000Z') },
  }),
  assistantEntry('a2', '2026-08-07T08:16:00.000Z', 'kimi-k2.7-code'),
  userEntry('u2', '2026-08-07T08:20:00.000Z', 'now ship it'),
  assistantEntry('a3', '2026-08-07T08:20:10.000Z', 'claude-opus-4-6'),
]);

describe('synthesizePiRawSession', () => {
  it('maps a Pi v3 transcript into RawSessionData', () => {
    const raw = synthesizePiRawSession('pi', descriptor, conversation);

    expect(raw.sessionId).toBe(descriptor.sessionId);
    expect(raw.agentSessionFile).toBe(descriptor.filePath); // lets the cost enricher price it
    expect(raw.startEvent!.agentName).toBe('pi');
    expect(raw.startEvent!.data.provider).toBe('native');
    // Header cwd beats the descriptor hint: `--session <path>` can run Pi elsewhere.
    expect(raw.startEvent!.data.workingDirectory).toBe('/repo');
  });

  it('counts user prompts as turns, not assistant messages', () => {
    // Pi gives tool results their own role, so a `user` message is always a real prompt.
    // Counting the 3 assistant messages instead would inflate a 2-prompt session by 50%.
    const raw = synthesizePiRawSession('pi', descriptor, conversation);
    expect(raw.deltas).toHaveLength(2);
    expect(raw.endEvent!.data.totalTurns).toBe(2);
  });

  it('spans the session from the earliest to the latest message timestamp', () => {
    const raw = synthesizePiRawSession('pi', descriptor, conversation);
    const start = Date.parse('2026-08-07T08:15:37.327Z'); // the `session` header line
    const end = Date.parse('2026-08-07T08:20:10.000Z');
    expect(raw.startEvent!.data.startTime).toBe(start);
    expect(raw.endEvent!.data.endTime).toBe(end);
    expect(raw.endEvent!.data.duration).toBe(end - start);
  });

  it('collects every assistant model so the report gets a real distribution', () => {
    const raw = synthesizePiRawSession('pi', descriptor, conversation);
    expect(raw.deltas[0].models).toEqual(['kimi-k2.7-code', 'kimi-k2.7-code', 'claude-opus-4-6']);
  });

  it('prefers responseModel over the requested model', () => {
    const raw = synthesizePiRawSession(
      'pi',
      descriptor,
      piParsed([assistantEntry('a1', '2026-08-07T08:15:45.000Z', 'auto', { responseModel: 'claude-opus-4-6' })])
    );
    expect(raw.deltas[0].models).toEqual(['claude-opus-4-6']);
  });

  it('titles the session from the first user prompt', () => {
    const raw = synthesizePiRawSession('pi', descriptor, conversation);
    expect(raw.deltas[0].userPrompts).toEqual([{ count: 1, text: 'add pi support' }]);
  });

  it('strips Pi\'s injected <skill> block so it cannot become the title', () => {
    const skillPrompt = '<skill name="brainstorming" location="/repo/.pi/git/skills/brainstorming">\nInstructions here.\n</skill>\n\nreview the analytics readers';
    const raw = synthesizePiRawSession('pi', descriptor, piParsed([userEntry('u1', '2026-08-07T08:15:40.000Z', skillPrompt)]));
    expect(raw.deltas[0].userPrompts).toEqual([{ count: 1, text: 'review the analytics readers' }]);
  });

  it('skips a user message that is nothing but a skill block', () => {
    const wrapperOnly = '<skill name="using-superpowers" location="/repo/.pi/git/skills/using-superpowers">\nbody\n</skill>';
    const raw = synthesizePiRawSession(
      'pi',
      descriptor,
      piParsed([userEntry('u1', '2026-08-07T08:15:40.000Z', wrapperOnly), userEntry('u2', '2026-08-07T08:15:41.000Z', 'the real prompt')])
    );
    expect(raw.deltas[0].userPrompts).toEqual([{ count: 1, text: 'the real prompt' }]);
  });

  it('never treats a toolResult as a prompt or a turn', () => {
    const toolOnly = piParsed([
      entry('message', 't1', '2026-08-07T08:15:50.000Z', {
        message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: false, timestamp: Date.parse('2026-08-07T08:15:50.000Z') },
      }),
    ]);
    const raw = synthesizePiRawSession('pi', descriptor, toolOnly);
    expect(raw.deltas[0].userPrompts).toBeUndefined();
    expect(raw.endEvent!.data.totalTurns).toBe(1); // floored, never zero
  });

  it('falls back to the descriptor when the transcript carries nothing usable', () => {
    const raw = synthesizePiRawSession('pi', descriptor, piParsed([], {}));
    expect(raw.startEvent!.data.workingDirectory).toBe('/decoded/hint');
    expect(raw.startEvent!.data.startTime).toBe(1_000);
    expect(raw.endEvent!.data.endTime).toBe(2_000);
    expect(raw.deltas).toHaveLength(1);
  });

  it('carries parsed.metrics through when the adapter supplies it', () => {
    // The Pi adapter does not populate parsed.metrics today; this pins the seam so tool and
    // file-operation charts light up for native runs the moment it starts to.
    const withMetrics = {
      ...conversation,
      metrics: { tools: { read: 3 }, toolStatus: { read: { success: 3, failure: 0 } }, commandInvocations: { compact: 1 } },
    } as ParsedSession;
    const raw = synthesizePiRawSession('pi', descriptor, withMetrics);
    expect(raw.deltas[0].tools).toEqual({ read: 3 });
    expect(raw.deltas[0].commandInvocations).toEqual({ compact: 1 });
  });

  it('defaults tools to an empty object rather than throwing when metrics are absent', () => {
    expect(synthesizePiRawSession('pi', descriptor, conversation).deltas[0].tools).toEqual({});
  });

  it('reports no git branch, because Pi records none anywhere in a v3 transcript', () => {
    // Characterization, not a bug: the v3 header carries id/timestamp/cwd/parentSession only,
    // and no entry carries a branch either. Native Pi sessions therefore bucket under
    // "Unknown" and `--branch <x>` filters all of them out. Stamping the cwd's CURRENT branch
    // would be a fabrication — it would label a session recorded weeks ago with today's branch.
    expect(synthesizePiRawSession('pi', descriptor, conversation).deltas[0].gitBranch).toBeUndefined();
  });
});

describe('synthesizePiRawSession — forked continuations', () => {
  /** `/fork` replays the prior conversation VERBATIM, entry ids included, into a new file. */
  function forkOf(base: unknown[], added: unknown[]): ParsedSession {
    return {
      ...conversation,
      subagents: [{ agentId: 'fork-1', filePath: '/sessions/fork-1.jsonl', agentType: PI_FORKED_CONTINUATION, messages: [...base, ...added] }],
    } as ParsedSession;
  }

  const replayed = conversation.messages;

  it('counts a replayed prompt once, not once per fork', () => {
    // Without entry-id dedup a 2-prompt conversation forked once reports 4 turns; on the real
    // 12-file corpus that is 121 turns for 21 real prompts.
    const raw = synthesizePiRawSession('pi', descriptor, forkOf(replayed, [userEntry('u3', '2026-08-07T08:30:00.000Z', 'and again')]));

    expect(raw.endEvent!.data.totalTurns).toBe(3);
    expect(raw.deltas).toHaveLength(3);
  });

  it('extends the session to the continuation instead of restarting the clock', () => {
    const raw = synthesizePiRawSession('pi', descriptor, forkOf(replayed, [userEntry('u3', '2026-08-07T08:30:00.000Z', 'and again')]));

    expect(raw.startEvent!.data.startTime).toBe(Date.parse('2026-08-07T08:15:37.327Z'));
    expect(raw.endEvent!.data.endTime).toBe(Date.parse('2026-08-07T08:30:00.000Z'));
  });

  it('counts a replayed assistant model once and adds the continuation\'s own', () => {
    const raw = synthesizePiRawSession('pi', descriptor, forkOf(replayed, [assistantEntry('a4', '2026-08-07T08:30:05.000Z', 'claude-opus-4-6')]));

    expect(raw.deltas[0].models).toEqual(['kimi-k2.7-code', 'kimi-k2.7-code', 'claude-opus-4-6', 'claude-opus-4-6']);
  });

  it('ignores nested sub-agent runs — their prompts are dispatches, not user turns', () => {
    const withSubagent = {
      ...conversation,
      subagents: [{ agentId: 'c1480b93/run-0', filePath: '/sessions/root/c1480b93/run-0/session.jsonl', agentType: PI_SUBAGENT_RUN, messages: [userEntry('s1', '2026-08-07T08:16:00.000Z', 'Task: review this')] }],
    } as ParsedSession;

    expect(synthesizePiRawSession('pi', descriptor, withSubagent).endEvent!.data.totalTurns).toBe(2);
  });
});

describe('synthesizeRawSession — pi dispatch', () => {
  it('routes pi to the Pi reader instead of the Claude-shaped fallback', () => {
    // The Claude path reads `m.message.model` off every entry and counts assistant messages;
    // on Pi's envelopes that yields the wrong turn count and no prompt at all.
    const raw = synthesizeRawSession('pi', descriptor, conversation);
    expect(raw.endEvent!.data.totalTurns).toBe(2);
    expect(raw.deltas[0].userPrompts).toEqual([{ count: 1, text: 'add pi support' }]);
  });
});

describe('loadNativeSessions — pi', () => {
  function deps(overrides: Partial<NativeLoaderDeps> = {}): NativeLoaderDeps {
    return {
      trackedLogPaths: () => new Set<string>(),
      discover: async () => [{ agentName: 'pi', descriptor }],
      parse: async () => conversation,
      realPath: (p) => p,
      hasOwnershipMarker: () => false,
      ...overrides,
    };
  }

  it('tags an unmanaged pi run native-external so it is distinguishable from a managed one', () => {
    // A CodeMie-launched run writes an ownership sidecar for every transcript it produced
    // (pi.plugin.ts correlateRunToSession), which is what hasOwnershipMarker reads back.
    return loadNativeSessions(undefined, deps()).then((out) => {
      expect(out).toHaveLength(1);
      expect(out[0].startEvent!.data.provider).toBe('native-external');
    });
  });

  it('leaves a CodeMie-managed pi transcript tagged native', async () => {
    const out = await loadNativeSessions(undefined, deps({ hasOwnershipMarker: () => true }));
    expect(out[0].startEvent!.data.provider).toBe('native');
  });

  it('skips a pi transcript already correlated to a tracked CodeMie session', async () => {
    const out = await loadNativeSessions(undefined, deps({ trackedLogPaths: () => new Set([descriptor.filePath]) }));
    expect(out).toHaveLength(0);
  });

  it('drops a transcript the adapter could not parse', async () => {
    const out = await loadNativeSessions(undefined, deps({ parse: async () => null }));
    expect(out).toHaveLength(0);
  });
});

describe('loadNativeSessions — pi fork families', () => {
  const rootPath = '/sessions/root.jsonl';
  const forkPath = '/sessions/fork.jsonl';

  function familyDeps(parentSession: string, overrides: Partial<NativeLoaderDeps> = {}): NativeLoaderDeps {
    const root: SessionDescriptor = { ...descriptor, sessionId: 'root', filePath: rootPath };
    const fork: SessionDescriptor = { ...descriptor, sessionId: 'fork', filePath: forkPath };
    return {
      trackedLogPaths: () => new Set<string>(),
      discover: async () => [
        { agentName: 'pi', descriptor: root },
        { agentName: 'pi', descriptor: fork },
      ],
      parse: async (_agent, filePath) =>
        filePath === forkPath
          ? ({ ...conversation, metadata: { projectPath: '/repo', parentSession } } as ParsedSession)
          : conversation,
      realPath: (p) => p,
      hasOwnershipMarker: () => false,
      ...overrides,
    };
  }

  it('emits one session for a fork family, not one per transcript', async () => {
    // The fork replays the whole prior conversation, so counting it as its own session
    // reports one conversation many times over — 12 files for 2 conversations on the real
    // corpus, with every derived per-session metric wrong by the same factor.
    const out = await loadNativeSessions(undefined, familyDeps(rootPath));

    expect(out.map((s) => s.sessionId)).toEqual(['root']);
  });

  it('keeps a continuation whose source is not in the listing, so its spend is never lost', async () => {
    // The source fell outside the discovery window: there is no session for this fork to be
    // counted inside, and dropping it would delete its tokens from the report entirely.
    const out = await loadNativeSessions(undefined, familyDeps('/sessions/archived-elsewhere.jsonl'));

    expect(out.map((s) => s.sessionId)).toEqual(['root', 'fork']);
  });

  it('matches the source through symlinks the way the tracked-path dedup does', async () => {
    const out = await loadNativeSessions(
      undefined,
      familyDeps('/symlinked/root.jsonl', { realPath: (p) => (p === '/symlinked/root.jsonl' ? rootPath : p) })
    );

    expect(out.map((s) => s.sessionId)).toEqual(['root']);
  });
});
