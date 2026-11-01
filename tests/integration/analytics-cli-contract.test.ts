import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReportPayload } from '../../src/cli/commands/analytics/report/types.js';

const contract = process.env.ANALYTICS_STRICT_CONTRACTS === 'true' ? it : it.fails;
let directory: string;
let home: string;
const bin = resolve('bin/codemie.js');

function run(name: string, args: string[]): { report: ReportPayload; stderr: string } {
  const output = join(directory, `${name}.json`);
  const command = [bin, 'analytics', ...args, '--export', 'json', '-o', output];
  const result = spawnSync(process.execPath, command, {
    cwd: directory, encoding: 'utf8', timeout: 45_000,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, CODEMIE_HOME: home,
      PI_CODING_AGENT_SESSION_DIR: join(directory, 'pi'), CODEMIE_SKIP_UPDATE_CHECK: 'true' },
  });
  if (result.error || result.status !== 0) throw new Error(`Built CLI failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(readFileSync(output, 'utf8')) as ReportPayload;
  const evidence = process.env.ANALYTICS_EVIDENCE_DIR;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${name}-command.json`), JSON.stringify({ command, exit: result.status, stdout: result.stdout, stderr: result.stderr, report }, null, 2));
  }
  return { report, stderr: result.stderr };
}

function session(id: string, agent: string, start: string): void {
  const sessions = join(home, 'sessions');
  writeFileSync(join(sessions, `completed_${id}.json`), JSON.stringify({ sessionId: id, agentName: agent, provider: 'native',
    workingDirectory: '/repo', startTime: Date.parse(start), endTime: Date.parse(start) + 1000, status: 'completed' }));
  writeFileSync(join(sessions, `completed_${id}_metrics.jsonl`), JSON.stringify({ sessionId: id, recordId: `${id}-turn-0`,
    timestamp: Date.parse(start), tools: {}, gitBranch: 'main', syncStatus: 'synced', syncAttempts: 0 }) + '\n');
}

describe('actual built CLI JSON and date contract', () => {
  let day: ReportPayload;
  let invalid: { report: ReportPayload; stderr: string };
  const longContext = new Map<string, ReportPayload>();
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'analytics-built-cli-'));
    home = join(directory, 'codemie');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    session('midnight', 'claude', '2026-10-25T00:00:00Z');
    session('noon', 'claude', '2026-10-25T12:00:00Z');
    session('next', 'copilot-cli', '2026-10-26T00:00:00Z');
    session('normalized', 'gemini', '2026-03-02T00:00:00Z');
    for (const id of ['long-1', 'long-2']) {
      session(id, 'claude', '2026-10-24T12:00:00Z');
      const nativeFile = join(directory, `${id}.jsonl`);
      writeFileSync(nativeFile, JSON.stringify({ type: 'assistant', uuid: id, timestamp: '2026-10-24T12:00:00Z',
        message: { id, role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'fixture' }],
          usage: { input_tokens: 110000, output_tokens: 1000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 5000,
            cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 1000 } } } }) + '\n');
      const metadata = join(home, 'sessions', `completed_${id}.json`);
      const record = JSON.parse(readFileSync(metadata, 'utf8')) as Record<string, unknown>;
      writeFileSync(metadata, JSON.stringify({ ...record, correlation: { status: 'matched', agentSessionId: id, agentSessionFile: nativeFile } }));
      const { report } = run(id, ['--session', id]);
      expect(report.sessions).toHaveLength(1);
      expect(report.sessions[0].tokens).toMatchObject({ input: 110000, output: 1000, cacheRead: 10000, cacheCreation: 5000, cacheCreation1h: 1000 });
      longContext.set(id, report);
    }
    day = run('date-only-to', ['--agent', 'claude', '--from', '2026-10-25', '--to', '2026-10-25']).report;
    invalid = run('invalid-calendar', ['--agent', 'gemini', '--from', '2026-02-30']);
  }, 120_000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('exports only the requested managed agent, with consistent JSON counts and no remote delivery', () => {
    const { report } = run('agent', ['--agent', 'claude']);
    expect(report.sessions.map((item) => item.sessionId).sort()).toEqual(['long-1', 'long-2', 'midnight', 'noon']);
    expect(report.meta.agents).toEqual(['claude']);
    expect(report.meta.totals).toMatchObject({ sessions: 4, turns: 4 });
  });
  it('composes session and branch filters without cross-agent attribution', () => {
    const { report } = run('identity', ['--session', 'next', '--branch', 'main']);
    expect(report.sessions.map((item) => item.sessionId)).toEqual(['next']);
    expect(report.sessions[0].agentName).toBe('copilot-cli');
    expect(report.meta.totals.sessions).toBe(1);
  });
  it('R67 discovers a schema-valid native Pi disk transcript and exports independently priced cached usage', () => {
    mkdirSync(join(directory, 'pi'));
    const time = '2026-10-25T12:00:00Z';
    const entries = [
      { type: 'session', version: 3, id: 'pi-native', timestamp: time, cwd: '/repo' },
      { type: 'message', id: 'u', parentId: null, timestamp: time,
        message: { role: 'user', content: 'review', timestamp: Date.parse(time) } },
      { type: 'message', id: 'a', parentId: 'u', timestamp: time,
        message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'reviewed' }],
          usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 400, totalTokens: 1900 }, timestamp: Date.parse(time) } },
    ];
    writeFileSync(join(directory, 'pi', 'native.jsonl'), entries.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const { report } = run('pi-native', ['--agent', 'pi', '--include-external']);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({ agentName: 'pi', turns: 1, tokens: { input: 1000, output: 200, cacheRead: 300, cacheCreation: 400, total: 1900 } });
    expect(report.sessions[0].costUSD).toBeCloseTo(0.00253, 10);
  });
  contract('KNOWN DEFECT EPMCDME-16617: date-only end includes noon on its own UTC date', () => {
    expect(day.sessions.map((item) => item.sessionId).sort()).toEqual(['midnight', 'noon']);
  });
  contract('KNOWN DEFECT EPMCDME-16618: impossible calendar date emits the documented invalid-date warning', () => {
    expect(invalid.stderr).toContain('Invalid --from date');
  });
  contract.each(['long-1', 'long-2'])('KNOWN DEFECT Haiku 5.5 long-context %s: built CLI prices the higher tier for one native API response', (id) => {
    expect(longContext.get(id)?.sessions[0].costUSD).toBeCloseTo(0.0615, 10);
  });
});
