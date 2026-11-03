/**
 * End-to-end (in-process, real SessionsSource/aggregator/cost/report writer) check of
 * `analytics --agent copilot-cli --last 24h --export json` over mixed-agent fixtures:
 * managed-only isolation, rolling 24h UTC window, token/model totals, zero-turn retention
 * and the report JSON shape the Analytics Collector consumes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigLoader } from '../../../../utils/config.js';

vi.mock('../../../utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let codemieHome: string;
let copilotHome: string;
let outDir: string;
const saved = { codemie: process.env.CODEMIE_HOME, copilot: process.env.COPILOT_HOME };

function nativeSession(id: string, startMs: number, opts: { turns: number; tokens: boolean }): string {
  const dir = join(copilotHome, 'session-state', id);
  mkdirSync(dir, { recursive: true });
  const at = (ms: number) => new Date(ms).toISOString();
  writeFileSync(join(dir, 'workspace.yaml'), `id: ${id}\ncwd: /work/app\ngit_root: /work/app\nbranch: main\ncreated_at: ${at(startMs)}\nupdated_at: ${at(startMs + 1000)}\n`);
  const events: unknown[] = [{ type: 'session.start', timestamp: at(startMs), data: { sessionId: id, copilotVersion: '1.0.103', startTime: at(startMs), context: { cwd: '/work/app', gitRoot: '/work/app', branch: 'main' } } }];
  for (let i = 0; i < opts.turns; i++) {
    events.push({ type: 'user.message', timestamp: at(startMs + 1000 + i * 2000), data: { text: 'hi' } });
    events.push({ type: 'assistant.message', timestamp: at(startMs + 2000 + i * 2000), data: { model: 'gpt-5.4', outputTokens: 25 } });
  }
  if (opts.tokens) {
    events.push({ type: 'session.shutdown', timestamp: at(startMs + 60_000), data: { shutdownType: 'routine', totalPremiumRequests: 1, modelMetrics: { 'gpt-5.4': { requests: { count: 1, cost: 1 }, usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 } } } } });
  }
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function record(id: string, agentName: string, startMs: number, opts: { turns: number; nativeFile?: string; model?: string }): void {
  const dir = join(codemieHome, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `completed_${id}.json`), JSON.stringify({
    sessionId: id, agentName, provider: 'ai-run-sso', project: 'p', workingDirectory: '/work/app', startTime: startMs,
    endTime: startMs + 60_000, status: 'completed',
    ...(opts.nativeFile && { correlation: { status: 'matched', agentSessionId: id, agentSessionFile: opts.nativeFile, retryCount: 0 } }),
  }));
  const rows = Array.from({ length: opts.turns }, (_, i) => JSON.stringify({
    recordId: `${id}-turn-${i}`, sessionId: id, agentSessionId: id, timestamp: startMs + 2000 + i * 2000, gitBranch: 'main',
    tools: {}, models: [opts.model ?? 'gpt-5.4'], syncStatus: 'synced', syncAttempts: 0,
  }));
  if (rows.length > 0) writeFileSync(join(dir, `completed_${id}_metrics.jsonl`), rows.join('\n') + '\n');
}

interface Report { meta: { agents: string[]; periodStart: string; periodEnd: string; rangeLabel: string; totals: Record<string, number> }; sessions: Array<Record<string, any>> }

async function report(agent: string): Promise<Report> {
  const { runAnalytics } = await import('../index.js');
  const { SessionsSource } = await import('../sources/sessions-source.js');
  const out = join(outDir, `${agent}.json`);
  await runAnalytics({ agent, last: '24h', export: 'json', output: out } as never, new SessionsSource());
  return JSON.parse(readFileSync(out, 'utf-8')) as Report;
}

beforeEach(() => {
  codemieHome = mkdtempSync(join(tmpdir(), 'copilot-rep-codemie-'));
  copilotHome = mkdtempSync(join(tmpdir(), 'copilot-rep-home-'));
  outDir = mkdtempSync(join(tmpdir(), 'copilot-rep-out-'));
  process.env.CODEMIE_HOME = codemieHome;
  process.env.COPILOT_HOME = copilotHome;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(ConfigLoader, 'loadMultiProviderConfig').mockResolvedValue({ userEmail: 'dev@example.com' } as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);

  const nat = nativeSession('cm-full', NOW - 2 * HOUR, { turns: 2, tokens: true });
  record('cm-full', 'copilot-cli', NOW - 2 * HOUR, { turns: 2, nativeFile: nat });
  // Zero real turns, but the correlated transcript carries cost: retained with 0 turns.
  const zero = nativeSession('cm-zero', NOW - 3 * HOUR, { turns: 0, tokens: true });
  record('cm-zero', 'copilot-cli', NOW - 3 * HOUR, { turns: 0, nativeFile: zero });
  // Managed, no native transcript (failed launch), but with a recorded turn.
  record('cm-nonative', 'copilot-cli', NOW - 4 * HOUR, { turns: 1 });
  // Rolling-window boundary: exactly 24h ago is inside, 1 ms earlier is outside.
  record('cm-edge-in', 'copilot-cli', NOW - DAY, { turns: 1 });
  record('cm-edge-out', 'copilot-cli', NOW - DAY - 1, { turns: 1 });
  record('claude-1', 'claude', NOW - HOUR, { turns: 1, model: 'claude-sonnet-4-5' });
  // Standalone Copilot session: native transcript only, never claimed by a CodeMie record.
  nativeSession('standalone-1', NOW - HOUR, { turns: 3, tokens: true });
  // Sidecar and malformed files must not break filtering.
  writeFileSync(join(codemieHome, 'sessions', 'abc-codemie-marker.json'), JSON.stringify({ codemieSessionId: 'cm-full' }));
  writeFileSync(join(codemieHome, 'sessions', 'broken.json'), '{not json');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [key, value] of [['CODEMIE_HOME', saved.codemie], ['COPILOT_HOME', saved.copilot]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [codemieHome, copilotHome, outDir]) rmSync(d, { recursive: true, force: true });
});

describe('analytics --agent copilot-cli --last 24h --export json', () => {
  it('contains only managed copilot-cli sessions inside the rolling UTC window', async () => {
    const r = await report('copilot-cli');

    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual(['cm-edge-in', 'cm-full', 'cm-nonative', 'cm-zero']);
    expect(new Set(r.sessions.map((s) => s.agentName))).toEqual(new Set(['copilot-cli']));
    expect(r.meta.agents).toEqual(['copilot-cli']);
    expect(r.meta.periodStart).toBe('2026-10-23T12:00:00.000Z');
    expect(r.meta.periodEnd).toBe('2026-10-24T12:00:00.000Z');
    expect(r.meta.rangeLabel).toBe('24h');
  });

  it('reports correct turns, model and token totals, and keeps a zero-turn session at 0 turns', async () => {
    const r = await report('copilot-cli');
    const by = (id: string) => r.sessions.find((s) => s.sessionId === id)!;

    expect(by('cm-full').turns).toBe(2);
    expect(by('cm-full').models).toEqual(['gpt-5.4']);
    expect(by('cm-full').durationMs).toBe(60_000);
    expect(by('cm-full').tokens).toMatchObject({ input: 800, output: 50, cacheRead: 200, total: 1050 });
    expect(by('cm-zero').turns).toBe(0);
    expect(by('cm-zero').tokens.total).toBe(1050);
    expect(by('cm-nonative').turns).toBe(1);
    expect(r.meta.totals.sessions).toBe(4);
  });

  it('keeps the report shape the Collector consumes', async () => {
    const r = await report('copilot-cli');

    expect(Object.keys(r).sort()).toEqual(['meta', 'sessions']);
    expect(r.meta.totals).toEqual(expect.objectContaining({ sessions: expect.any(Number), durationMs: expect.any(Number), turns: expect.any(Number), totalCostUSD: expect.any(Number) }));
    for (const s of r.sessions) {
      expect(s).toEqual(expect.objectContaining({
        sessionId: expect.any(String), agentName: expect.any(String), startTime: expect.any(Number), durationMs: expect.any(Number),
        turns: expect.any(Number), models: expect.any(Array), tokens: expect.objectContaining({ input: expect.any(Number), output: expect.any(Number), total: expect.any(Number) }),
        costUSD: expect.any(Number),
      }));
    }
  });

  it('leaves Claude output unchanged by the Copilot data', async () => {
    const r = await report('claude');

    expect(r.sessions.map((s) => s.sessionId)).toEqual(['claude-1']);
    expect(r.meta.agents).toEqual(['claude']);
  });
});
