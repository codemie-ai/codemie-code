/**
 * Pi metrics processor: the entry kinds that used to be dropped, the per-session
 * named-invocation maps, and re-entrancy.
 *
 * `bashExecution` and `model_change` are written by Pi but had no branch in the delta
 * loop, so a `!command` counted as no tool call at all and a mid-session `/model` switch
 * never reached the aggregator. Both carry privacy constraints that the tests pin:
 * raw shell output must never leave the machine, and `!!` output must not be reported
 * even in aggregate.
 *
 * Re-entrancy is the other half. The incremental-sync timer builds a fresh processor
 * every ~30 s and re-parses each transcript from the top, so anything derived from
 * instance state alone is either multiplied or truncated. The tests here drive a fresh
 * processor per call, the way the timer does.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { PiMetricsProcessor } from '../session/processors/pi.metrics-processor.js';
import type { PiMetricsProcessingContext } from '../session/processors/pi.metrics-processor.js';
import { getSessionMetricsPath } from '../../../core/session/session-config.js';
import type { ParsedSession } from '../../../core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '../../../core/session/BaseProcessor.js';
import type { MetricDelta } from '../../../core/metrics/types.js';
import type { Session } from '../../../core/session/types.js';
import type { AgentMetadata } from '../../../core/types.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sessionRecords = new Map<string, Session>();
vi.mock('@/agents/core/session/SessionStore.js', () => ({
  SessionStore: class {
    async loadSession(id: string): Promise<Session | null> {
      return sessionRecords.get(id) ?? null;
    }
    async saveSession(session: Session): Promise<void> {
      sessionRecords.set(session.sessionId, session);
    }
  },
}));

const SESSION_START = Date.parse('2026-01-01T00:00:00.000Z');
const PI_SESSION_ID = 'pi-session-1';

const metadata = { name: 'pi', metricsConfig: { excludeErrorsFromTools: ['bash'] } } as AgentMetadata;

const context: ProcessingContext = {
  apiBaseUrl: 'http://localhost',
  cookies: '',
  clientType: 'codemie-pi',
  version: '1.0.0',
  dryRun: true,
  gitBranch: 'main',
  agentSessionId: PI_SESSION_ID,
};

/** What the incremental-sync timer passes: a tick is not the run's last word. */
const tickContext: PiMetricsProcessingContext = { ...context, emitUnresolvedToolCalls: false };

let sessionId: string;

function buildSession(entries: Array<Record<string, unknown>>): ParsedSession {
  return {
    sessionId,
    agentName: 'Pi',
    messages: entries as unknown[],
    metadata: {
      projectPath: '/repo',
      createdAt: new Date(SESSION_START).toISOString(),
      agentSessionId: PI_SESSION_ID,
    },
  } as unknown as ParsedSession;
}

/** Give the run a CodeMie session record, which is where activeDurationMs is persisted. */
function seedSessionRecord(): Session {
  const record = {
    sessionId,
    agentName: 'pi',
    startTime: SESSION_START,
    activeDurationMs: 0,
    workingDirectory: '/repo',
  } as unknown as Session;
  sessionRecords.set(sessionId, record);
  return record;
}

function storedActiveDurationMs(): number | undefined {
  return sessionRecords.get(sessionId)?.activeDurationMs;
}

function readDeltas(): MetricDelta[] {
  const path = getSessionMetricsPath(sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MetricDelta);
}

async function run(
  session: ParsedSession,
  processor = new PiMetricsProcessor(metadata),
  processingContext: ProcessingContext = context
): Promise<MetricDelta[]> {
  const result = await processor.process(session, processingContext);
  expect(result.success).toBe(true);
  return readDeltas();
}

/** What the aggregator would see: one name map summed across every persisted delta. */
function totalInvocations(
  field: 'skillInvocations' | 'agentInvocations' | 'commandInvocations'
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const delta of readDeltas()) {
    for (const [name, count] of Object.entries(delta[field] ?? {})) {
      totals[name] = (totals[name] ?? 0) + count;
    }
  }
  return totals;
}

function bashEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(SESSION_START + 1000).toISOString(),
    message: {
      role: 'bashExecution',
      command: 'npm test',
      output: 'PASSWORD=hunter2 leaked into stdout',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: SESSION_START + 1000,
      ...overrides,
    },
  };
}

function userEntry(id: string, text: string, at = SESSION_START + 500): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: text, timestamp: at },
  };
}

function skillBlock(name: string): string {
  return `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\nInstructions.\n</skill>\n\nrun it`;
}

/**
 * `/skill:<name>` typed with no arguments. Pi appends the `<args>` tail only when the
 * invocation carried some, so the user message is the wrapper and nothing else — which
 * leaves no prompt text, and therefore no delta, to hang the skill's name off.
 */
function bareSkillBlock(name: string): string {
  return `<skill name="${name}" location="/skills/${name}/SKILL.md">\nInstructions.\n</skill>`;
}

/** An assistant turn that issues one tool call, as Pi persists it *before* the tool runs. */
function toolCallEntry(
  id: string,
  toolCallId: string,
  toolName: string,
  toolArguments: Record<string, unknown> = { path: '/repo/src/a.ts', content: 'one\ntwo\n' },
  at = SESSION_START + 1500
): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(at).toISOString(),
    message: {
      role: 'assistant',
      timestamp: at,
      model: 'claude-opus-4',
      content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: toolArguments }],
    },
  };
}

function toolResultEntry(
  id: string,
  toolCallId: string,
  toolName: string,
  at = SESSION_START + 90_000
): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(at).toISOString(),
    message: {
      role: 'toolResult',
      toolCallId,
      toolName,
      timestamp: at,
      isError: false,
      content: 'ok',
    },
  };
}

function subagentEntry(id: string, agent: string, at = SESSION_START + 1500): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(at).toISOString(),
    message: {
      role: 'assistant',
      timestamp: at,
      model: 'claude-opus-4',
      content: [{ type: 'toolCall', id: `c-${id}`, name: 'subagent', arguments: { agent } }],
    },
  };
}

beforeEach(() => {
  sessionId = `test-pi-metrics-${Math.random().toString(36).slice(2)}`;
  sessionRecords.clear();
  delete process.env.CODEMIE_MODEL;
});

afterEach(() => {
  rmSync(getSessionMetricsPath(sessionId), { force: true });
});

describe('bashExecution entries', () => {
  it('counts a successful shell escape as one successful bash tool call', async () => {
    const deltas = await run(buildSession([bashEntry('b1')]));

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      recordId: 'b1:bash',
      tools: { bash: 1 },
      toolStatus: { bash: { success: 1, failure: 0 } },
    });
    // No model ran: the user typed the command themselves.
    expect(deltas[0].models).toBeUndefined();
  });

  it('reports a failure without ever carrying the command output', async () => {
    const deltas = await run(buildSession([bashEntry('b1', { exitCode: 1 })]));

    expect(deltas[0].toolStatus).toEqual({ bash: { success: 0, failure: 1 } });
    expect(deltas[0].apiErrorMessage).toBe('Tool failed: bash');
    expect(JSON.stringify(deltas)).not.toContain('hunter2');
  });

  it('treats a cancelled command, which has no exit code, as a failure', async () => {
    const deltas = await run(buildSession([bashEntry('b1', { exitCode: undefined, cancelled: true })]));

    expect(deltas[0].toolStatus).toEqual({ bash: { success: 0, failure: 1 } });
  });

  it('reports nothing at all for a `!!` command the user withheld from the model', async () => {
    const deltas = await run(buildSession([bashEntry('b1', { excludeFromContext: true })]));

    expect(deltas).toEqual([]);
  });

  it('ignores a shell escape that predates the CodeMie run', async () => {
    const stale = bashEntry('b1', { timestamp: SESSION_START - 60_000 });
    const deltas = await run(buildSession([stale]));

    expect(deltas).toEqual([]);
  });
});

describe('model_change entries', () => {
  it('emits the switched-to model so the aggregator can see it', async () => {
    const entry = {
      type: 'model_change',
      id: 'm1',
      parentId: null,
      timestamp: new Date(SESSION_START + 2000).toISOString(),
      provider: 'anthropic',
      modelId: 'claude-opus-4',
    };

    const deltas = await run(buildSession([entry]));

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ recordId: 'm1:model', models: ['claude-opus-4'] });
    expect(deltas[0].tools).toBeUndefined();
  });

  it('ignores a model switch from an earlier run on the same transcript', async () => {
    const entry = {
      type: 'model_change',
      id: 'm1',
      parentId: null,
      timestamp: new Date(SESSION_START - 60_000).toISOString(),
      modelId: 'claude-opus-4',
    };

    expect(await run(buildSession([entry]))).toEqual([]);
  });

  it('does not double-count an entry already seen on another transcript', async () => {
    const entry = {
      type: 'model_change',
      id: 'm1',
      parentId: null,
      timestamp: new Date(SESSION_START + 2000).toISOString(),
      modelId: 'claude-opus-4',
    };
    const processor = new PiMetricsProcessor(metadata);

    await run(buildSession([entry]), processor);
    const deltas = await run(buildSession([entry]), processor);

    expect(deltas).toHaveLength(1);
  });
});

describe('named invocations', () => {
  it('attaches skill and agent maps to the first delta only', async () => {
    const assistant = {
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: new Date(SESSION_START + 1500).toISOString(),
      message: {
        role: 'assistant',
        timestamp: SESSION_START + 1500,
        model: 'claude-opus-4',
        content: [{ type: 'toolCall', id: 'c1', name: 'subagent', arguments: { agent: 'planner' } }],
      },
    };

    const deltas = await run(buildSession([userEntry('u1', skillBlock('review')), assistant]));

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas[0].skillInvocations).toEqual({ review: 1 });
    expect(deltas[0].agentInvocations).toEqual({ planner: 1 });
    expect(deltas.slice(1).every((d) => !d.skillInvocations && !d.agentInvocations)).toBe(true);
  });

  it('strips the skill wrapper from the reported prompt while keeping its name', async () => {
    const deltas = await run(buildSession([userEntry('u1', skillBlock('review'))]));

    expect(deltas[0].userPrompts).toEqual([{ count: 1, text: 'run it' }]);
    expect(deltas[0].skillInvocations).toEqual({ review: 1 });
  });

  it('omits the maps entirely when the run used none of them', async () => {
    const deltas = await run(buildSession([userEntry('u1', 'plain prompt')]));

    expect(deltas[0].skillInvocations).toBeUndefined();
    expect(deltas[0].agentInvocations).toBeUndefined();
    expect(deltas[0].commandInvocations).toBeUndefined();
  });

  it('counts only the entries inside the run window', async () => {
    const deltas = await run(
      buildSession([
        userEntry('u0', skillBlock('stale'), SESSION_START - 60_000),
        userEntry('u1', skillBlock('review')),
      ])
    );

    expect(deltas[0].skillInvocations).toEqual({ review: 1 });
  });
});

describe('run-ledger invocations', () => {
  const ledger = {
    commandInvocations: { review: 2 },
    skillCommandInvocations: { brainstorming: 1 },
  };

  it('merges prompt-template commands, which the transcript cannot carry', async () => {
    const processor = new PiMetricsProcessor(metadata, ledger);
    const deltas = await run(buildSession([userEntry('u1', 'plain prompt')]), processor);

    expect(deltas[0].commandInvocations).toEqual({ review: 2 });
    expect(deltas[0].skillInvocations).toEqual({ brainstorming: 1 });
  });

  it('keeps the larger count rather than summing the two views of one skill call', async () => {
    const processor = new PiMetricsProcessor(metadata, { skillCommandInvocations: { review: 1 } });
    const deltas = await run(buildSession([userEntry('u1', skillBlock('review'))]), processor);

    expect(deltas[0].skillInvocations).toEqual({ review: 1 });
  });

  /**
   * The latch that used to hold this invariant lived in an instance field, so it only
   * ever worked for a caller that reused one processor — which no production caller
   * does. The timer builds a fresh one per tick, so the invariant has to survive that.
   */
  it('attaches the ledger counts once per run, not once per processor', async () => {
    const first = [userEntry('u1', 'first prompt')];
    await run(buildSession(first), new PiMetricsProcessor(metadata, ledger));

    const second = [...first, userEntry('u2', 'second prompt')];
    await run(buildSession(second), new PiMetricsProcessor(metadata, ledger));

    const third = [...second, userEntry('u3', 'third prompt')];
    await run(buildSession(third), new PiMetricsProcessor(metadata, ledger));

    expect(totalInvocations('commandInvocations')).toEqual({ review: 2 });
    expect(totalInvocations('skillInvocations')).toEqual({ brainstorming: 1 });
  });
});

/**
 * A batch can owe invocation counts and still have no delta of its own to carry them.
 *
 * Mid-run that is survivable — the next tick's batch would carry them — but the final
 * flush has no next batch, and a count deferred there is a count lost. Every case below
 * is a *last* batch.
 */
describe('a batch that writes no delta', () => {
  it('still records the skill a bare `/skill:name` invoked', async () => {
    const deltas = await run(buildSession([userEntry('u1', bareSkillBlock('review'))]));

    expect(totalInvocations('skillInvocations')).toEqual({ review: 1 });
    // Timestamped at the window's end, so a record that reports no activity of its own
    // cannot stretch the run's active duration when it is read back.
    expect(deltas.map((delta) => delta.timestamp)).toEqual([SESSION_START + 500]);
  });

  /**
   * The end-of-session flush re-parses a transcript whose every delta is already on disk.
   * A `/review` the user typed after the last tick exists only in the ledger, so this
   * flush is the only chance to report it.
   */
  it('still records a ledger command that arrived after the last tick', async () => {
    const entries = [userEntry('u1', 'plain prompt')];
    await run(buildSession(entries), new PiMetricsProcessor(metadata));

    await run(
      buildSession(entries),
      new PiMetricsProcessor(metadata, { commandInvocations: { review: 1 } })
    );

    expect(totalInvocations('commandInvocations')).toEqual({ review: 1 });
  });

  it('does not write a second carrier when the same batch is re-parsed', async () => {
    const entries = [userEntry('u1', bareSkillBlock('review'))];
    await run(buildSession(entries), new PiMetricsProcessor(metadata));
    await run(buildSession(entries), new PiMetricsProcessor(metadata));

    expect(readDeltas()).toHaveLength(1);
    expect(totalInvocations('skillInvocations')).toEqual({ review: 1 });
  });

  it('numbers a later carrier apart from the one already on disk', async () => {
    const first = [userEntry('u1', bareSkillBlock('review'))];
    await run(buildSession(first), new PiMetricsProcessor(metadata));

    const second = [...first, userEntry('u2', bareSkillBlock('debug'), SESSION_START + 900)];
    await run(buildSession(second), new PiMetricsProcessor(metadata));

    const recordIds = readDeltas().map((delta) => delta.recordId);
    expect(new Set(recordIds).size).toBe(recordIds.length);
    expect(totalInvocations('skillInvocations')).toEqual({ review: 1, debug: 1 });
  });

  it('writes nothing at all when there is no count to carry either', async () => {
    const entries = [userEntry('u1', 'plain prompt')];
    await run(buildSession(entries), new PiMetricsProcessor(metadata));
    await run(buildSession(entries), new PiMetricsProcessor(metadata));

    expect(readDeltas()).toHaveLength(1);
  });
});

/**
 * Everything below drives the processor the way the incremental-sync timer does: a fresh
 * instance per call, re-parsing the whole transcript from the top.
 */
describe('re-entrancy across incremental-sync ticks', () => {
  it('counts a named invocation once however often the transcript is re-parsed', async () => {
    const first = [userEntry('u1', skillBlock('review')), subagentEntry('a1', 'planner')];
    await run(buildSession(first), new PiMetricsProcessor(metadata));

    const second = [...first, userEntry('u2', 'follow up')];
    await run(buildSession(second), new PiMetricsProcessor(metadata));

    const third = [...second, userEntry('u3', 'more')];
    await run(buildSession(third), new PiMetricsProcessor(metadata));

    expect(totalInvocations('skillInvocations')).toEqual({ review: 1 });
    expect(totalInvocations('agentInvocations')).toEqual({ planner: 1 });
  });

  /**
   * One tick hands the same processor every transcript in the ledger, and a transcript an
   * earlier tick already drained writes nothing. Its invocations still have to be counted,
   * or the ledger's own view of the run is compared against a total that is missing them.
   */
  it('keeps counting across a transcript that had nothing new to write', async () => {
    const ledgerOnce = { skillCommandInvocations: { review: 1 } };
    const drained = [userEntry('u1', skillBlock('review'))];
    await run(buildSession(drained), new PiMetricsProcessor(metadata, ledgerOnce));
    expect(totalInvocations('skillInvocations')).toEqual({ review: 1 });

    const processor = new PiMetricsProcessor(metadata, ledgerOnce);
    await run(buildSession(drained), processor);
    await run(buildSession([userEntry('u2', skillBlock('review'))]), processor);

    expect(totalInvocations('skillInvocations')).toEqual({ review: 2 });
  });

  it('still reports an invocation that first appears in a later tick', async () => {
    const first = [userEntry('u1', 'plain prompt')];
    await run(buildSession(first), new PiMetricsProcessor(metadata));

    const second = [...first, userEntry('u2', skillBlock('review'))];
    await run(buildSession(second), new PiMetricsProcessor(metadata));

    expect(totalInvocations('skillInvocations')).toEqual({ review: 1 });
  });

  /**
   * Pi persists the assistant message carrying a toolCall before the tool runs, so a
   * 90 s call is unresolved for three ticks. Emitting it status-less claims the record id
   * the resolved delta would use, and the dedup makes the first writer permanent.
   */
  it('does not finalise a tool call that is still running when a tick fires', async () => {
    const inFlight = [toolCallEntry('a1', 'c1', 'write')];
    expect(await run(buildSession(inFlight), new PiMetricsProcessor(metadata), tickContext)).toEqual(
      []
    );

    const resolved = [...inFlight, toolResultEntry('r1', 'c1', 'write')];
    const deltas = await run(buildSession(resolved), new PiMetricsProcessor(metadata), tickContext);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      recordId: 'a1:c1',
      tools: { write: 1 },
      toolStatus: { write: { success: 1, failure: 0 } },
    });
    expect(deltas[0].fileOperations).toEqual([
      expect.objectContaining({ type: 'write', path: '/repo/src/a.ts' }),
    ]);
  });

  it('still counts a tool call left unresolved at the final flush', async () => {
    const deltas = await run(buildSession([toolCallEntry('a1', 'c1', 'write')]));

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ recordId: 'a1:c1', tools: { write: 1 } });
    expect(deltas[0].toolStatus).toBeUndefined();
  });
});

describe('active duration', () => {
  it('spans the whole run rather than the last tick', async () => {
    seedSessionRecord();

    const first = [userEntry('u1', 'start', SESSION_START), userEntry('u2', 'next', SESSION_START + 1000)];
    await run(buildSession(first), new PiMetricsProcessor(metadata));

    const second = [...first, userEntry('u3', 'much later', SESSION_START + 600_000)];
    await run(buildSession(second), new PiMetricsProcessor(metadata));

    expect(storedActiveDurationMs()).toBe(600_000);
  });

  /**
   * At the end of the session every delta is already on disk, so the final flush writes
   * nothing — and used to return before persisting the duration at all.
   */
  it('persists the full span even on a flush that writes no new deltas', async () => {
    const record = seedSessionRecord();

    const entries = [
      userEntry('u1', 'start', SESSION_START),
      userEntry('u2', 'much later', SESSION_START + 600_000),
    ];
    await run(buildSession(entries), new PiMetricsProcessor(metadata));

    record.activeDurationMs = 42;
    await run(buildSession(entries), new PiMetricsProcessor(metadata));

    expect(storedActiveDurationMs()).toBe(600_000);
  });

  it('spans a tool call from its request to its result', async () => {
    seedSessionRecord();

    await run(
      buildSession([
        toolCallEntry('a1', 'c1', 'write', { path: '/repo/a.ts', content: 'x' }, SESSION_START),
        toolResultEntry('r1', 'c1', 'write', SESSION_START + 90_000),
      ]),
      new PiMetricsProcessor(metadata)
    );

    expect(storedActiveDurationMs()).toBe(90_000);
  });
});
