/**
 * Pi / omp dispatch timeline, per-dispatch cost and root/linked/unlinked allocation,
 * end to end through the real adapter and cost enricher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PiSessionAdapter } from '../pi.session.js';
import { PiPluginMetadata } from '../pi.plugin.js';
import { extractPiDispatchEvents } from '../session/pi-dispatch-extractor.js';
import { extractPiFileOperations } from '../session/pi-file-operations.js';
import { enrichCosts, type EnricherDeps } from '@/cli/commands/analytics/cost/cost-enricher.js';
import type { RawSessionData } from '@/cli/commands/analytics/data-loader.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dir: string;

const header = (id: string): Record<string, unknown> => ({
  type: 'session', version: 3, id, timestamp: '2026-08-07T08:00:00.000Z', cwd: '/repo',
});

function assistant(id: string, tokens: number, ts = '2026-08-07T08:00:01.000Z'): Record<string, unknown> {
  return {
    type: 'message', id, parentId: null, timestamp: ts,
    message: { role: 'assistant', content: [], model: 'kimi-k2.7-code', usage: { input: tokens, output: 0, totalTokens: tokens }, timestamp: Date.parse(ts) },
  };
}

function call(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'message', id, parentId: null, timestamp: '2026-08-07T08:00:02.000Z',
    message: { role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: `call-${id}`, name, arguments: args }] },
  };
}

function result(id: string, name: string, details: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'message', id: `r-${id}`, parentId: null, timestamp: '2026-08-07T08:00:09.000Z',
    message: { role: 'toolResult', toolCallId: `call-${id}`, toolName: name, content: [], isError: false, details, timestamp: 1 },
  };
}

function write(rel: string, lines: Record<string, unknown>[]): string {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return path;
}

async function enrich(file: string) {
  const adapter = new PiSessionAdapter(PiPluginMetadata);
  const deps: EnricherDeps = {
    resolveAgentName: () => 'pi',
    loadAgentSessionFile: async (raw) => raw.agentSessionFile ?? null,
    parseNative: (_agent, filePath, sessionId) => adapter.parseSessionFile(filePath, sessionId),
  };
  const raw: RawSessionData = {
    sessionId: 'S', agentSessionFile: file, deltas: [],
    startEvent: {
      recordId: 'S', type: 'session_start', timestamp: 1, codeMieSessionId: 'S', agentName: 'pi', syncStatus: 'synced',
      data: { provider: 'native', workingDirectory: '/repo', startTime: 1 },
    },
  };
  const { index } = await enrichCosts([raw], deps);
  return index.get('S');
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi-dispatch-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('omp task dispatches', () => {
  function ompSession(): string {
    const root = write('root.jsonl', [
      header('root'), assistant('a1', 10),
      call('t1', 'task', { tasks: [{ agent: 'explore' }] }),
      result('t1', 'task', { progress: [{ id: 'A', agent: 'explore' }] }),
    ]);
    write('root/A.jsonl', [header('A'), assistant('c1', 100, '2026-08-07T08:00:03.000Z'), assistant('c2', 1, '2026-08-07T08:00:07.000Z')]);
    write('root/A/A.B.jsonl', [header('A.B'), assistant('g1', 1000)]);
    write('root/Z.jsonl', [header('Z'), assistant('z1', 7)]);
    return root;
  }

  it('extracts one agent event per progress entry, keyed and timed by its child transcript', async () => {
    const parsed = await new PiSessionAdapter(PiPluginMetadata).parseSessionFile(ompSession(), 'S');
    const [event] = extractPiDispatchEvents(parsed).filter((e) => e.kind === 'agent');
    expect(event).toMatchObject({ name: 'explore', _taskId: 'A', id: 'call-t1:A', durationMs: 7000 });
  });

  it('walks nested child transcripts recursively', async () => {
    const parsed = await new PiSessionAdapter(PiPluginMetadata).parseSessionFile(ompSession(), 'S');
    expect(parsed.subagents?.map((s) => s.agentId).sort()).toEqual(['A', 'A/A.B', 'Z']);
  });

  it('folds grandchild spend into the dispatch and splits root / linked / unlinked', async () => {
    const cost = await enrich(ompSession());
    const dispatch = cost?.dispatches?.find((d) => d.kind === 'agent');
    expect(dispatch?.tokens?.input).toBe(1101);
    expect(cost?.rootOwnTokens?.input).toBe(10);
    expect(cost?.unlinkedTokens?.input).toBe(7);
    expect(cost?.unlinkedAgentIds).toEqual(['Z']);
  });
});

describe('plain-Pi subagent dispatches', () => {
  it('links a <agent>/run-N transcript to its subagent dispatch', async () => {
    const root = write('root.jsonl', [
      header('root'), assistant('a1', 10),
      call('s1', 'subagent', { agent: 'reviewer', task: 'review' }),
      result('s1', 'subagent', {}),
    ]);
    write('root/abc123/run-0/session.jsonl', [header('sub'), assistant('s1', 50)]);

    const cost = await enrich(root);
    expect(cost?.dispatches?.find((d) => d.kind === 'agent')?.tokens?.input).toBe(50);
    expect(cost?.unlinkedTokens?.input ?? 0).toBe(0);
    expect(cost?.unlinkedAgentIds ?? []).toEqual([]);
  });
});

describe('extractPiFileOperations (omp)', () => {
  it('uses perFileResults over the top-level diff and maps op delete', () => {
    const ops = extractPiFileOperations('edit', {}, {
      diff: '+x\n+y',
      perFileResults: [{ path: 'a.ts', diff: '+1\n-2' }, { path: 'b.ts', op: 'delete' }],
    }, { cwd: '/repo' });
    expect(ops.map((o) => [o.type, o.linesAdded, o.linesRemoved])).toEqual([
      ['edit', 1, 1],
      ['delete', undefined, undefined],
    ]);
  });

  it('drops internal URIs', () => {
    expect(extractPiFileOperations('read', { path: 'agent://x' }, undefined, { cwd: '/repo' })).toEqual([]);
    expect(extractPiFileOperations('write', { path: 'local://n.md', content: 'a' }, undefined, { cwd: '/repo' })).toEqual([]);
  });

  it('counts write lines without the trailing newline, like the shared countContentLines', () => {
    const lines = (content: string): number | undefined =>
      extractPiFileOperations('write', { path: 'a.ts', content }, undefined, { cwd: '/repo' })[0].linesAdded;
    expect(lines('one\ntwo\n')).toBe(2);
    expect(lines('one\ntwo')).toBe(2);
    expect(lines('one\n\n')).toBe(2);
  });
});
