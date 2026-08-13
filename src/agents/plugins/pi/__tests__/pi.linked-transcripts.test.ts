/**
 * Transcripts Pi keeps OUTSIDE the file being parsed.
 *
 * The adapter links exactly ONE kind: the nested sub-agent runs Pi stores under a directory
 * named after the transcript. That is identity — a directory Pi named after this file — and
 * the only place a delegated agent's tokens exist.
 *
 * It deliberately does NOT link the `/fork` continuations that carry the rest of the same
 * conversation into a sibling file. Folding one in is only sound where the matching decision to
 * suppress the folded file is taken (analytics' `loadNativeSessions`); taken here it also ran on
 * the TRACKED path, where each run already knows its own transcripts from the run ledger — and
 * billed a later run's entire spend to an earlier run's session. The billing test at the bottom
 * of this file is that regression.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiSessionAdapter, PI_SUBAGENT_RUN } from '../pi.session.js';
import { PiPluginMetadata } from '../pi.plugin.js';
import { enrichCosts, type EnricherDeps } from '@/cli/commands/analytics/cost/cost-enricher.js';
import type { RawSessionData } from '@/cli/commands/analytics/data-loader.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let sessionDir: string;

function header(id: string, parentSession?: string): Record<string, unknown> {
  return {
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-08-07T08:15:37.327Z',
    cwd: '/repo',
    ...(parentSession && { parentSession }),
  };
}

function assistant(id: string, totalTokens = 2): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-08-07T08:15:40.000Z',
    message: {
      role: 'assistant',
      content: [],
      model: 'kimi-k2.7-code',
      usage: { input: totalTokens, output: 0, totalTokens },
      timestamp: 1,
    },
  };
}

/** Write a top-level transcript and return its path. */
function transcript(name: string, lines: Record<string, unknown>[]): string {
  const path = join(sessionDir, `${name}.jsonl`);
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return path;
}

/** Write `<transcript-without-.jsonl>/<agentId>/<run>/session.jsonl`, the layout Pi uses. */
function subagentRun(transcriptPath: string, agentId: string, run: string, lines: Record<string, unknown>[]): string {
  const dir = join(transcriptPath.slice(0, -'.jsonl'.length), agentId, run);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return path;
}

function parse(filePath: string) {
  return new PiSessionAdapter(PiPluginMetadata).parseSessionFile(filePath, 'sid');
}

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'pi-linked-'));
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe('parseSessionFile — nested sub-agent runs', () => {
  it('attaches every run under the transcript directory', async () => {
    const parent = transcript('parent', [header('parent'), assistant('a1')]);
    subagentRun(parent, 'c1480b93', 'run-0', [header('sub-1'), assistant('s1')]);
    subagentRun(parent, '9dc4f8a4', 'run-0', [header('sub-2'), assistant('s2')]);

    const parsed = await parse(parent);

    expect(parsed.subagents?.map((s) => s.agentId)).toEqual(['9dc4f8a4/run-0', 'c1480b93/run-0']);
    expect(parsed.subagents?.every((s) => s.agentType === PI_SUBAGENT_RUN)).toBe(true);
    expect(parsed.subagents?.[0].messages).toHaveLength(2);
  });

  it('carries no toolUseId, so cost enrichment folds the spend in without re-allocating it', async () => {
    // enrichDispatchCosts keys on toolUseId; a session-level transcript must not look like
    // the allocation of one dispatch.
    const parent = transcript('parent', [header('parent')]);
    subagentRun(parent, 'agent', 'run-0', [header('sub'), assistant('s1')]);

    const [run] = (await parse(parent)).subagents ?? [];
    expect(run).toBeDefined();
    expect(run.toolUseId).toBeUndefined();
  });

  it('ignores an agent directory with no session.jsonl in it', async () => {
    const parent = transcript('parent', [header('parent')]);
    mkdirSync(join(sessionDir, 'parent', 'abandoned', 'run-0'), { recursive: true });

    expect((await parse(parent)).subagents).toBeUndefined();
  });

  it('leaves subagents unset for a transcript that dispatched nothing', async () => {
    expect((await parse(transcript('solo', [header('solo')]))).subagents).toBeUndefined();
  });
});

describe('parseSessionFile — forked continuations are NOT linked', () => {
  it('links no sibling that names this transcript as its fork source', async () => {
    const root = transcript('root', [header('root'), assistant('a1')]);
    transcript('fork-a', [header('fork-a', root), assistant('a1'), assistant('a2')]);
    transcript('fork-b', [header('fork-b', root), assistant('a1'), assistant('a3')]);

    expect((await parse(root)).subagents).toBeUndefined();
  });

  it('keeps a continuation\'s own sub-agent runs out of the source transcript', async () => {
    // They belong to the continuation's parse. Reaching for them here would drag the
    // continuation's spend into whoever parses the source, on every path.
    const root = transcript('root', [header('root')]);
    const fork = transcript('fork', [header('fork', root)]);
    subagentRun(fork, 'agent', 'run-0', [header('sub'), assistant('s1')]);

    expect((await parse(root)).subagents).toBeUndefined();
    expect((await parse(fork)).subagents?.map((s) => s.agentType)).toEqual([PI_SUBAGENT_RUN]);
  });

  it('reports the source transcript the header names, so analytics can collapse the family', async () => {
    const root = transcript('root', [header('root')]);
    const fork = transcript('fork', [header('fork', root)]);

    expect((await parse(fork)).metadata).toMatchObject({ parentSession: root });
    expect((await parse(root)).metadata).not.toHaveProperty('parentSession');
  });
});

/**
 * The reason the fold cannot live in the adapter.
 *
 * `codemie pi --fork <id>` is a second MANAGED run: the ledger correlates it to its own CodeMie
 * session and the cost enricher re-parses that transcript through this adapter. The enricher
 * walks sessions in `startTime` order against a shared `seen` set, so anything the adapter
 * attaches to the EARLIER session's transcript is consumed by the earlier session — and the
 * later run reports as free, on the earlier run's date and branch.
 */
describe('tracked-path billing', () => {
  function trackedSession(sessionId: string, agentSessionFile: string, startTime: number): RawSessionData {
    return {
      sessionId,
      agentSessionFile,
      startEvent: {
        recordId: sessionId,
        type: 'session_start',
        timestamp: startTime,
        codeMieSessionId: sessionId,
        agentName: 'pi',
        syncStatus: 'synced',
        data: { provider: 'native', workingDirectory: '/repo', startTime },
      },
      deltas: [],
    };
  }

  it('bills a --fork run\'s spend to its own session, not to the run it forked from', async () => {
    const run1 = transcript('run1', [header('run1'), assistant('a1', 10)]);
    // `/fork` replays the source VERBATIM (ids included) and then adds the new run's own turns.
    const run2 = transcript('run2', [header('run2', run1), assistant('a1', 10), assistant('a2', 1000)]);

    const adapter = new PiSessionAdapter(PiPluginMetadata);
    const deps: EnricherDeps = {
      resolveAgentName: () => 'pi',
      loadAgentSessionFile: async (raw) => raw.agentSessionFile ?? null,
      parseNative: (_agent, filePath, sessionId) => adapter.parseSessionFile(filePath, sessionId),
    };

    const { index } = await enrichCosts(
      [trackedSession('S1', run1, 1_000), trackedSession('S2', run2, 2_000)],
      deps
    );

    expect(index.get('S1')?.tokens.total).toBe(10);
    expect(index.get('S2')?.tokens.total).toBe(1000);
  });
});
