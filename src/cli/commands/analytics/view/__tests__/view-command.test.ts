/**
 * `codemie analytics view` through commander: what reaches stdout, stderr, files and the exit code.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createViewCommand } from '../view-command.js';
import { loadNativeSessions } from '../../native-loader.js';
import { MetricsDataLoader } from '../../data-loader.js';
import { dispatch, payload, record } from './record-fixture.js';

vi.mock('../../native-loader.js', () => ({ loadNativeSessions: vi.fn() }));
vi.mock('../../data-loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data-loader.js')>()),
  MetricsDataLoader: vi.fn(),
}));

const sessions = [
  record({ sessionId: 'claude-1', startTime: Date.UTC(2026, 10, 10, 9), costUSD: 1 }),
  record({
    sessionId: 'claude-2', startTime: Date.UTC(2026, 10, 12, 9), costUSD: 2,
    dispatches: [
      dispatch({ kind: 'agent', name: 'code-reviewer', id: 'tool-1', agentId: 'agent-1', start: 10 }),
      dispatch({ kind: 'skill', name: 'brainstorming', id: 'tool-2', ownerAgentId: 'agent-1', start: 20 }),
    ],
  }),
  record({ sessionId: 'codex-1', agentName: 'codex', startTime: Date.UTC(2026, 10, 11, 9), costUSD: 4 }),
];

async function run(args: string[], build: () => Command = createViewCommand): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err.push(String(chunk)); return true; });
  process.exitCode = undefined;
  try {
    await build().exitOverride().parseAsync(args, { from: 'user' });
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { stdout: out.join(''), stderr: err.join(''), exitCode };
}

function embeddedPayload(html: string): { meta: { totals: { sessions: number; totalCostUSD: number }; agents: string[] }; sessions: Array<{ sessionId: string }> } {
  const marker = 'window.__ANALYTICS__ = ';
  const start = html.indexOf(marker) + marker.length;
  return JSON.parse(html.slice(start, html.indexOf(';</script>', start)));
}

describe('codemie analytics view', () => {
  let dir: string;
  let input: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemie-view-command-'));
    input = join(dir, 'export.json');
    writeFileSync(input, JSON.stringify(payload(sessions)));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('prints a summary/1 JSON for the filters and exits 0', async () => {
    const { stdout, stderr, exitCode } = await run(['--input', input, '--from', '2026-11-01', '--to', '2026-11-19', '--agent', 'claude']);

    const summary = JSON.parse(stdout);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(summary.schema).toBe('codemie.analytics.summary/1');
    expect(summary.range).toMatchObject({ from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 19, 23, 59, 59, 999), bucket: 'day' });
    expect(summary.filter).toEqual({ agent: 'claude', project: null, branch: null });
    expect(summary.totals).toMatchObject({ sessions: 2, costUSD: 3 });
    expect(summary.agentsUsed.map((a: { agentName: string }) => a.agentName)).toEqual(['claude', 'codex']);

    const file = join(dir, 'out', 'summary.json');
    const written = await run(['--input', input, '--from', '2026-11-01', '--to', '2026-11-19', '--agent', 'claude', '-o', file]);
    expect(written.stdout).toBe('');
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual(summary);

    const empty = await run(['--input', input, '--agent', 'gemini']);
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(empty.stdout).totals.sessions).toBe(0);
  });

  it('prints session/1 with the trace for --session', async () => {
    const { stdout, exitCode } = await run(['--input', input, '--session', 'claude-2']);

    const detail = JSON.parse(stdout);
    expect(exitCode).toBe(0);
    expect(detail.schema).toBe('codemie.analytics.session/1');
    expect(detail.session).toEqual(sessions[1]);
    expect(detail.trace.map((e: { key: string; level: number; parentKey: string | null }) => [e.key, e.level, e.parentKey])).toEqual([
      ['tool-1', 0, null],
      ['tool-2', 1, 'tool-1'],
    ]);
  });

  it('writes the normal HTML report for --export html -o', async () => {
    const file = join(dir, 'report.html');

    const { stdout, exitCode } = await run(['--input', input, '--agent', 'claude', '--export', 'html', '-o', file]);

    const embedded = embeddedPayload(readFileSync(file, 'utf-8'));
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(embedded.sessions.map((s) => s.sessionId)).toEqual(['claude-1', 'claude-2']);
    expect(embedded.meta.totals).toMatchObject({ sessions: 2, totalCostUSD: 3 });
    expect(embedded.meta.agents).toEqual(['claude']);
  });

  it('fails with one line and exit 1 for a missing file, a non-export file, an unknown session id and a bad date', async () => {
    const notExport = join(dir, 'notes.json');
    writeFileSync(notExport, JSON.stringify({ hello: 'world' }));
    const notJson = join(dir, 'README.md');
    writeFileSync(notJson, '# Notes\n');

    for (const args of [
      ['--input', join(dir, 'missing.json')],
      ['--input', notExport],
      ['--input', notJson],
      ['--input', input, '--session', 'nope'],
      ['--input', input, '--from', '2026-13-01'],
      ['--input', input, '--last', 'a week'],
      ['--input', input, '--export', 'csv'],
      ['--input', input, '--export', 'html'],
    ]) {
      const { stdout, stderr, exitCode } = await run(args);

      expect({ args, exitCode }).toEqual({ args, exitCode: 1 });
      expect(stdout).toBe('');
      expect(stderr).toMatch(/^✗ [^\n]+\n$/);
    }
  });

  it('reads the options typed after `codemie analytics view`, also those `analytics` itself defines', async () => {
    // The root program parses without positional options, so commander hands --session, --from,
    // --agent, --export, -o … to `analytics` (which defines them too) instead of to `view`.
    const { createProgram } = await import('../../../../program.js');
    const cli = (args: string[]) => run(['analytics', 'view', '--input', input, ...args], createProgram);

    const detail = JSON.parse((await cli(['--session', 'claude-2'])).stdout);
    expect(detail.schema).toBe('codemie.analytics.session/1');

    const summary = JSON.parse((await cli(['--from', '2026-11-11', '--to', '2026-11-19', '--agent', 'claude', '--compare'])).stdout);
    expect(summary.range.from).toBe(Date.UTC(2026, 10, 11));
    expect(summary.filter.agent).toBe('claude');
    expect(summary.totals.sessions).toBe(1);

    const file = join(dir, 'program.html');
    const html = await cli(['--last', '3650d', '--project', 'garden-planner', '--agent', 'codex', '--export', 'html', '-o', file]);
    expect(html.exitCode).toBe(0);
    expect(embeddedPayload(readFileSync(file, 'utf-8')).sessions.map((s) => s.sessionId)).toEqual(['codex-1']);

    const bad = await cli(['--from', '2026-13-01']);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toMatch(/^✗ Invalid --from date "2026-13-01"[^\n]*\n$/);
  });

  it('never reads agent logs', async () => {
    await run(['--input', input]);
    await run(['--input', input, '--session', 'claude-1']);
    await run(['--input', input, '--export', 'html', '-o', join(dir, 'all.html')]);

    expect(loadNativeSessions).not.toHaveBeenCalled();
    expect(MetricsDataLoader).not.toHaveBeenCalled();
  });
});
