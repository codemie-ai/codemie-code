/**
 * A CLI claude record that starts on an existing transcript (resume) sends only its own records,
 * prompts and named invocations; invocation counts are per run.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const SESSION_ID = 'run-baseline-session';
const AGENT_SESSION_ID = 'agent-run-baseline';
const START_MS = Date.parse('2026-10-31T12:00:00Z');
const at = (minutes: number) => new Date(START_MS + minutes * 60_000).toISOString();

const userMsg = (uuid: string, text: string, timestamp: string) => ({
  type: 'user', uuid, timestamp, sessionId: AGENT_SESSION_ID, message: { role: 'user', content: text }
});

/** An assistant turn that calls one tool and gets its result. */
function toolTurn(id: string, tool: string, input: Record<string, unknown>, timestamp: string) {
  return [
    {
      type: 'assistant', uuid: id, timestamp, sessionId: AGENT_SESSION_ID,
      message: {
        id: `msg-${id}`, role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id: `tool-${id}`, name: tool, input }],
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    },
    {
      type: 'user', uuid: `res-${id}`, parentUuid: id, timestamp, sessionId: AGENT_SESSION_ID,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${id}`, content: 'ok' }] }
    }
  ];
}

/** An assistant text reply; `model` '<synthetic>' with zero usage is Claude Code's "No response requested." line. */
function textReply(id: string, text: string, timestamp: string, model = 'claude-sonnet-5') {
  return {
    type: 'assistant', uuid: id, timestamp, sessionId: AGENT_SESSION_ID,
    message: {
      id: `msg-${id}`, role: 'assistant', model,
      content: [{ type: 'text', text }],
      usage: model === '<synthetic>' ? { input_tokens: 0, output_tokens: 0 } : { input_tokens: 10, output_tokens: 5 }
    }
  };
}

/** Session A wrote ALPHA + a Skill call; session C (this record, started at START_MS) wrote BRAVO + an Agent call. */
function sharedTranscript() {
  return [
    userMsg('u-alpha', 'ALPHA', at(-60)),
    ...toolTurn('a-alpha', 'Skill', { skill: 'alpha-skill' }, at(-59)),
    userMsg('u-bravo', 'BRAVO', at(1)),
    ...toolTurn('a-bravo', 'Task', { subagent_type: 'bravo-agent' }, at(2)),
  ];
}

function parsed(messages: unknown[], subagents?: unknown[]): ParsedSession {
  return { sessionId: SESSION_ID, agentName: 'claude', agentSessionId: AGENT_SESSION_ID, metadata: {}, messages, subagents } as unknown as ParsedSession;
}

describe('claude run baseline', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;
  const sessionFile = () => join(tempHome, 'sessions', `${SESSION_ID}.json`);
  const stored = () => JSON.parse(readFileSync(sessionFile(), 'utf-8'));
  const deltas = () => {
    const path = join(tempHome, 'sessions', `${SESSION_ID}_metrics.jsonl`);
    return existsSync(path)
      ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
  };

  const conversationTexts = () => {
    const path = join(tempHome, 'sessions', `${SESSION_ID}_conversation.jsonl`);
    return existsSync(path)
      ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
        .flatMap(l => JSON.parse(l).payload.history.map((entry: { message: string }) => entry.message))
      : [];
  };

  const conversationIndices = () => {
    const path = join(tempHome, 'sessions', `${SESSION_ID}_conversation.jsonl`);
    return existsSync(path)
      ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).flatMap(l => JSON.parse(l).historyIndices)
      : [];
  };

  function writeRecord(baselineCutoffMs?: number, extra: Record<string, unknown> = {}) {
    writeFileSync(sessionFile(), JSON.stringify({
      sessionId: SESSION_ID,
      agentName: 'claude',
      provider: 'ai-run-sso',
      startTime: START_MS,
      workingDirectory: '/tmp/work',
      status: 'active',
      activeDurationMs: 0,
      correlation: { status: 'matched', agentSessionId: AGENT_SESSION_ID, retryCount: 0 },
      runtimeCheckpoint: {
        externalSessionId: AGENT_SESSION_ID,
        transcriptPath: '/tmp/transcript.jsonl',
        lastDiscoveredAt: START_MS,
        ...(baselineCutoffMs !== undefined && { baselineCutoffMs })
      },
      ...extra
    }));
  }

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'claude-run-baseline-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore temp-dir cleanup races */
    }
    if (originalCodemieHome !== undefined) process.env.CODEMIE_HOME = originalCodemieHome;
    else delete process.env.CODEMIE_HOME;
  });

  /** One processing run through the shared claude session adapter, as performIncrementalSync does. */
  async function run(messages: unknown[], { finalPass = false, subagents = undefined as unknown[] | undefined } = {}) {
    const { ClaudeSessionAdapter } = await import('../claude.session.js');
    const adapter = new ClaudeSessionAdapter({ name: 'claude', dataPaths: { home: '.claude' } } as never);
    vi.spyOn(adapter, 'parseSessionFile').mockResolvedValue(parsed(messages, subagents));
    return adapter.processSession(
      '/tmp/transcript.jsonl',
      SESSION_ID,
      { agentSessionId: AGENT_SESSION_ID, ...(finalPass && { finalPass }) } as never
    );
  }

  it('a resumed record emits only its own delta, prompt and invocations, and continues the conversation after the old history', async () => {
    writeRecord(START_MS);

    await run(sharedTranscript());

    const out = deltas();
    expect(out.map(d => d.recordId)).toEqual(['a-bravo']);
    expect(out[0].userPrompts).toEqual([{ count: 1, text: 'BRAVO' }]);
    expect(out[0].agentInvocations).toEqual({ 'bravo-agent': 1 });
    expect(out[0].skillInvocations).toBeUndefined();

    const record = stored();
    expect(record.runtimeCheckpoint.baselineCutoffMs).toBeUndefined();
    expect(record.sync.metrics.processedRecordIds).toEqual(expect.arrayContaining(['msg-a-alpha', 'msg-a-bravo']));
    // ALPHA's turn was history index 0 of the shared transcript; this record continues at 1.
    expect(conversationIndices()).toEqual([1, 1]);
  });

  it('a new session (nothing before its start) seeds nothing and emits every delta', async () => {
    writeRecord(START_MS - 24 * 60 * 60_000);

    await run(sharedTranscript());

    expect(deltas().map(d => d.recordId)).toEqual(['a-alpha', 'a-bravo']);
    const record = stored();
    expect(conversationIndices()).toEqual([0, 0, 1, 1]);
    expect(record.runtimeCheckpoint.baselineCutoffMs).toBeUndefined();
  });

  it('the second run does not re-apply the baseline and carries only its own invocations', async () => {
    writeRecord(START_MS);
    const first = sharedTranscript();
    await run(first);

    const second = [
      ...first,
      userMsg('u-3', 'CHARLIE', at(5)),
      ...toolTurn('a-charlie', 'Skill', { skill: 'charlie-skill' }, at(6)),
    ];
    await run(second);

    const out = deltas();
    expect(out.map(d => d.recordId)).toEqual(['a-bravo', 'a-charlie']);
    expect(out[1].skillInvocations).toEqual({ 'charlie-skill': 1 });
    expect(out[1].agentInvocations).toBeUndefined();
    expect(out[1].userPrompts).toEqual([{ count: 1, text: 'CHARLIE' }]);
  });

  it('per-run invocations: run 1 {X:1}, run 2 {Y:1}, run 3 none', async () => {
    writeRecord();
    const run1 = [userMsg('u1', 'one', at(1)), ...toolTurn('t1', 'Skill', { skill: 'X' }, at(2))];
    const run2 = [...run1, userMsg('u2', 'two', at(3)), ...toolTurn('t2', 'Skill', { skill: 'Y' }, at(4))];
    const run3 = [...run2, userMsg('u3', 'three', at(5)), ...toolTurn('t3', 'Bash', { command: 'ls' }, at(6))];

    await run(run1);
    await run(run2);
    await run(run3);

    const out = deltas();
    expect(out.map(d => d.skillInvocations)).toEqual([{ X: 1 }, { Y: 1 }, undefined]);
  });

  describe('a run with a later group still pending', () => {
    const sum = (key: 'skillInvocations' | 'agentInvocations') =>
      deltas().reduce<Record<string, number>>((acc, d) => {
        for (const [name, count] of Object.entries(d[key] ?? {})) acc[name] = (acc[name] ?? 0) + (count as number);
        return acc;
      }, {});

    async function runPendingThenResolved(tool: string, input: Record<string, unknown>) {
      writeRecord();
      const [pending, result] = toolTurn('a2', tool, input, at(4));
      const run1 = [userMsg('u1', 'one', at(1)), ...toolTurn('a1', 'Bash', { command: 'ls' }, at(2)), pending];
      await run(run1);
      await run([...run1, result]);
    }

    it('counts a pending Task invocation once, in the run that emits it', async () => {
      await runPendingThenResolved('Task', { subagent_type: 'X' });

      expect(deltas().map(d => d.recordId)).toEqual(['a1', 'a2']);
      expect(deltas()[0].agentInvocations).toBeUndefined();
      expect(sum('agentInvocations')).toEqual({ X: 1 });
    });

    it('counts a pending Skill invocation once, in the run that emits it', async () => {
      await runPendingThenResolved('Skill', { skill: 'S' });

      expect(sum('skillInvocations')).toEqual({ S: 1 });
    });

    it('attaches a prompt typed after the last emitted group to the run that emits its reply', async () => {
      writeRecord();
      const [pending, result] = toolTurn('a2', 'Bash', { command: 'pwd' }, at(4));
      const run1 = [
        userMsg('u1', 'one', at(1)),
        ...toolTurn('a1', 'Bash', { command: 'ls' }, at(2)),
        userMsg('u2', 'two', at(3)),
        pending
      ];
      await run(run1);
      await run([...run1, result]);

      expect(deltas().map(d => d.userPrompts)).toEqual([[{ count: 1, text: 'one' }], [{ count: 1, text: 'two' }]]);
    });
  });

  describe('a failing baseline step', () => {
    async function runWithFailingSave() {
      const { SessionStore } = await import('@/agents/core/session/SessionStore.js');
      vi.spyOn(SessionStore.prototype, 'saveSession').mockRejectedValueOnce(new Error('disk full'));
      return run(sharedTranscript());
    }

    it('skips the run: no processor runs, the marker stays, and the next run applies the baseline', async () => {
      writeRecord(START_MS);

      await expect(runWithFailingSave()).resolves.toMatchObject({ success: false, totalRecords: 0 });

      expect(deltas()).toEqual([]);
      expect(conversationIndices()).toEqual([]);
      expect(stored().runtimeCheckpoint.baselineCutoffMs).toBe(START_MS);

      await run(sharedTranscript());

      expect(deltas().map(d => d.recordId)).toEqual(['a-bravo']);
    });

    it('keeps the marker on the record, so the next run retries', async () => {
      writeRecord(START_MS);

      await runWithFailingSave();

      expect(stored().runtimeCheckpoint.baselineCutoffMs).toBe(START_MS);
    });

    it('the retried baseline sends nothing written before the cutoff', async () => {
      writeRecord(START_MS);
      await runWithFailingSave();

      await run(sharedTranscript());

      expect(conversationIndices()).toEqual([1, 1]);
      const record = stored();
      expect(record.runtimeCheckpoint.baselineCutoffMs).toBeUndefined();
      expect(record.sync.conversations.lastSyncedHistoryIndex).toBe(1);
    });

    it('a retry keeps a stored conversation pointer that is past the baseline pointer', async () => {
      writeRecord(START_MS, {
        sync: { conversations: { lastSyncedMessageUuid: 'res-a-bravo', lastSyncedHistoryIndex: 2 } }
      });

      await run(sharedTranscript());

      const record = stored();
      expect(record.runtimeCheckpoint.baselineCutoffMs).toBeUndefined();
      expect(record.sync.conversations).toMatchObject({ lastSyncedMessageUuid: 'res-a-bravo', lastSyncedHistoryIndex: 2 });
      expect(conversationIndices().filter((index: number) => index <= 2)).toEqual([]);
    });
  });

  it('a record that cannot be loaded skips the run: no delta, no conversation payload', async () => {
    writeFileSync(sessionFile(), '{ not valid json');

    const result = await run(sharedTranscript());

    expect(result.success).toBe(false);
    expect(result.failedProcessors).toContain('baseline');
    expect(deltas()).toEqual([]);
    expect(conversationIndices()).toEqual([]);
  });

  it('a pre-start group with a chunk stamped after the start stays whole in the baseline', async () => {
    writeRecord(START_MS);
    const secondChunk = textReply('a-alpha-2', 'ALPHA two', at(0.5));
    secondChunk.message.id = 'msg-a-alpha-1';
    const resumed = [
      userMsg('u-alpha', 'ALPHA', at(-60)),
      textReply('a-alpha-1', 'ALPHA one', at(-59)),
      secondChunk,
    ];

    await run(resumed);

    const record = stored();
    expect(record.runtimeCheckpoint.baselineCutoffMs).toBeUndefined();
    expect(record.sync.conversations).toMatchObject({ lastSyncedMessageUuid: 'a-alpha-2', lastSyncedHistoryIndex: 0 });
    expect(record.sync.metrics.processedRecordIds).toContain('msg-a-alpha-1');
    expect(deltas()).toEqual([]);
    expect(conversationIndices()).toEqual([]);

    await run([...resumed, userMsg('u-bravo', 'BRAVO', at(1)), textReply('a-bravo', 'BRAVO', at(2))]);

    expect(deltas().map(d => d.recordId)).toEqual(['a-bravo']);
    expect(conversationIndices()).toEqual([1, 1]);
    expect(conversationTexts()).toEqual(['BRAVO', 'BRAVO']);
  });

  describe('a prompt is counted by the record it was typed in', () => {
    const story = () => userMsg('u-story', 'story', at(-30));

    it('a resumed record skips the synthetic reply written after its start but stamped before it', async () => {
      writeRecord(START_MS);
      const transcript = [
        userMsg('u-alpha', 'ALPHA', at(-60)),
        textReply('a-alpha', 'ALPHA', at(-59)),
        story(),
        { type: 'codemie_session_start', uuid: 'marker', timestamp: new Date(START_MS + 1).toISOString() },
        textReply('a-synthetic', 'No response requested.', new Date(START_MS - 700).toISOString(), '<synthetic>'),
        userMsg('u-bravo', 'BRAVO', at(1)),
        textReply('a-bravo', 'BRAVO', at(2)),
      ];

      await run(transcript);

      const out = deltas();
      expect(out.map(d => d.recordId)).toEqual(['a-bravo']);
      expect(out[0].userPrompts).toEqual([{ count: 1, text: 'BRAVO' }]);
      expect(conversationIndices()).toEqual([2, 2]);
      expect(conversationTexts()).not.toContain('No response requested.');
    });

    it('a resumed record takes no prompt from a line stamped before its start', async () => {
      writeRecord(START_MS);
      const transcript = [
        userMsg('u-alpha', 'ALPHA', at(-60)),
        textReply('a-alpha', 'ALPHA', at(-59)),
        story(),
        userMsg('u-bravo', 'BRAVO', at(1)),
        textReply('a-bravo', 'BRAVO', at(2)),
      ];

      await run(transcript);

      expect(deltas().map(d => d.userPrompts)).toEqual([[{ count: 1, text: 'BRAVO' }]]);
    });

    describe('the trailing prompt with no reply', () => {
      const answered = [userMsg('u-alpha', 'ALPHA', at(-60)), textReply('a-alpha', 'ALPHA', at(-59))];

      it('the final pass writes it once as a prompts-only delta; later passes add nothing', async () => {
        writeRecord();
        await run(answered);
        const trailing = [...answered, story()];

        await run(trailing, { finalPass: true });
        await run(trailing, { finalPass: true });
        await run(trailing);

        const out = deltas();
        expect(out.map(d => d.recordId)).toEqual(['a-alpha', 'u-story:prompts']);
        expect(out[1].userPrompts).toEqual([{ count: 1, text: 'story' }]);
        expect(out[1].models).toBeUndefined();
        expect(out[1].tools).toBeUndefined();
      });

      it('the final pass counts no interrupt marker, meta caveat or local command output', async () => {
        writeRecord();
        await run(answered);

        await run([
          ...answered,
          story(),
          {
            type: 'user', uuid: 'u-interrupt', timestamp: at(-29), sessionId: AGENT_SESSION_ID,
            message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
          },
          {
            type: 'user', uuid: 'u-caveat', isMeta: true, timestamp: at(-28), sessionId: AGENT_SESSION_ID,
            message: { role: 'user', content: '<local-command-caveat>Caveat: local commands</local-command-caveat>' }
          },
          userMsg('u-stdout', '<local-command-stdout>done</local-command-stdout>', at(-27)),
        ], { finalPass: true });

        expect(deltas().map(d => d.userPrompts)).toEqual([[{ count: 1, text: 'ALPHA' }], [{ count: 1, text: 'story' }]]);
      });

      const exitTail = () => [
        {
          type: 'user', uuid: 'u-caveat', isMeta: true, timestamp: at(-29), sessionId: AGENT_SESSION_ID,
          message: { role: 'user', content: '<local-command-caveat>Caveat: local commands</local-command-caveat>' }
        },
        {
          type: 'user', uuid: 'u-exit', parentUuid: 'u-caveat', timestamp: at(-28), sessionId: AGENT_SESSION_ID,
          message: {
            role: 'user',
            content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>'
          }
        },
        userMsg('u-stdout', '<local-command-stdout>Goodbye!</local-command-stdout>', at(-27)),
      ];

      it('the final pass writes no delta for a trailing /exit alone', async () => {
        writeRecord();
        await run(answered);

        await run([...answered, ...exitTail()], { finalPass: true });

        expect(deltas().map(d => d.recordId)).toEqual(['a-alpha']);
      });

      it('the final pass counts a trailing /exit after a prompt on its prompts-only delta, not as a prompt', async () => {
        writeRecord();
        await run(answered);

        await run([...answered, story(), ...exitTail()], { finalPass: true });

        const out = deltas();
        expect(out.map(d => d.recordId)).toEqual(['a-alpha', 'u-stdout:prompts']);
        expect(out[1].userPrompts).toEqual([{ count: 1, text: 'story' }]);
        expect(out[1].commandInvocations).toEqual({ exit: 1 });
      });

      describe('a subagent with a pending Skill call after its last emitted group', () => {
        const subagent = () => ({
          agentId: 'sub-1',
          filePath: '/tmp/subagents/agent-sub-1.jsonl',
          messages: [
            userMsg('s-task', 'Task prompt', at(-58)),
            textReply('s-reply', 'working', at(-57)),
            {
              type: 'assistant', uuid: 's-skill', timestamp: at(-56), sessionId: AGENT_SESSION_ID,
              message: {
                id: 'msg-s-skill', role: 'assistant', model: 'claude-sonnet-5',
                content: [{ type: 'tool_use', id: 'tool-s-skill', name: 'Skill', input: { skill: 'sub-skill' } }],
                usage: { input_tokens: 10, output_tokens: 5 }
              }
            }
          ]
        });

        it('the final pass counts the skill on the subagent delta and takes no prompt from it', async () => {
          writeRecord();

          await run(answered, { finalPass: true, subagents: [subagent()] });

          const out = deltas();
          expect(out.map(d => d.recordId)).toEqual(['a-alpha', 's-reply']);
          expect(out[1].skillInvocations).toEqual({ 'sub-skill': 1 });
          expect(out[1].userPrompts).toBeUndefined();
          expect(out.flatMap(d => d.userPrompts ?? [])).toEqual([{ count: 1, text: 'ALPHA' }]);
        });

        it('a non-final run does not count the pending skill', async () => {
          writeRecord();

          await run(answered, { subagents: [subagent()] });

          const out = deltas();
          expect(out.map(d => d.recordId)).toEqual(['a-alpha', 's-reply']);
          expect(out[1].skillInvocations).toBeUndefined();
        });
      });

      it('the final pass takes no prompt from a subagent with no emitted group', async () => {
        writeRecord();
        await run(answered);
        const subagent = {
          agentId: 'sub-2',
          filePath: '/tmp/subagents/agent-sub-2.jsonl',
          messages: [
            userMsg('s2-task', 'Task prompt', at(-58)),
            {
              type: 'assistant', uuid: 's2-skill', timestamp: at(-57), sessionId: AGENT_SESSION_ID,
              message: {
                id: 'msg-s2', role: 'assistant', model: 'claude-sonnet-5',
                content: [{ type: 'tool_use', id: 'tool-s2', name: 'Bash', input: { command: 'ls' } }],
                usage: { input_tokens: 10, output_tokens: 5 }
              }
            }
          ]
        };

        await run(answered, { finalPass: true, subagents: [subagent] });

        const out = deltas();
        expect(out.map(d => d.recordId)).toEqual(['a-alpha']);
        expect(JSON.stringify(out)).not.toContain('Task prompt');
        expect(stored().sync.metrics.processedRecordIds.filter((id: string) => id.endsWith(':prompts'))).toEqual([]);
      });

      it('a non-final run writes nothing for it', async () => {
        writeRecord();
        await run(answered);

        await run([...answered, story()]);

        expect(deltas().map(d => d.recordId)).toEqual(['a-alpha']);
      });
    });
  });
});
