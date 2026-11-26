/**
 * Recovery-to-delivery: the daemon tick's own steps over real spool files — recovery of a missing
 * sessionEnd, then `processSessionTick` through the real forwarder — with a local fetch standing in
 * for the analytics API. events.jsonl is synthetic (hand-built lines in Copilot's event shapes).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SSOCredentials } from '../../../../../../core/types.js';
import { readSessionState, updateSessionState } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.state.js';

vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({
  readState: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' }),
}));
vi.mock('../auth-state.js', () => ({ areCredentialsStale: vi.fn().mockReturnValue(false) }));

import { COPILOT_CLI_OTLP_AGENT, lateSessionEndSkip, recoverMissingSessionEnds, resetScheduledForTests } from '../copilot-usage-enrichment.js';
import { appendSpool } from '../spool-io.js';
import { getPluginRegistry, registerCorePlugins } from '../../index.js';
import { listHookRecords } from '../copilot-usage-spool.js';
import type { PluginContext } from '../../types.js';
import { processSessionTick } from '../tick-processor.js';
import { readStatus, writeStatus } from '../session-status.js';

const SID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';
const T0 = Date.parse('2026-10-20T06:25:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const NOW = T0 + 10 * 60_000;
const credentials = { cookies: {}, apiUrl: 'https://api.example.com' } as unknown as SSOCredentials;

const identity = { developer_name: 'dev@example.com', codemie_project_name: 'proj', platform: 'copilot-cli', entrypoint: 'managed' };
const hook = (type: string, ms: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ type, session_id: SID, timestamp: at(ms), event_id: `${type}:${ms}`, ...identity, ...extra });
const line = (type: string, ms: number, data: Record<string, unknown>): string => JSON.stringify({ type, timestamp: at(ms), data });

const transcript = [
  line('session.start', 0, { startTime: at(0), copilotVersion: '1.0.92' }),
  line('hook.start', 1, { hookType: 'preToolUse', input: { toolCallId: 'hooked-1' } }),
  line('tool.execution_start', 2, { toolCallId: 'hooked-1', toolName: 'view', arguments: {} }),
  line('tool.execution_complete', 3, { toolCallId: 'hooked-1', success: true }),
  line('tool.execution_start', 4, { toolCallId: 'ra-1', toolName: 'read_agent', arguments: {} }),
  line('tool.execution_complete', 5, { toolCallId: 'ra-1', success: true }),
  line('tool.execution_start', 6, { toolCallId: 'ra-2', toolName: 'read_agent', arguments: {} }),
  line('tool.execution_complete', 7, { toolCallId: 'ra-2', success: true }),
  line('session.shutdown', 5_000, { modelMetrics: { 'gpt-6-luna': { requests: { count: 1 }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } } }),
];

let dir: string;
const saved = { home: process.env.CODEMIE_HOME, copilot: process.env.COPILOT_HOME, userHome: process.env.HOME, userProfile: process.env.USERPROFILE };
const fetchMock = vi.fn();

async function spoolHook(...events: Record<string, unknown>[]): Promise<void> {
  await appendSpool(SID, 'hooks', events.map((e) => JSON.stringify({ agentName: COPILOT_CLI_OTLP_AGENT, hookEvent: JSON.stringify(e) })).join('\n') + '\n');
}

/** Every request the local collector saw, with the status it answered (the first `failFirst` get a 500). */
const sent: { url: string; body: string; status: number }[] = [];
let failFirst = 0;

/** The wire events the API accepted (a 2xx response), in order. */
function accepted(): Record<string, unknown>[] {
  return sent.filter((s) => s.status < 300).flatMap((s) => s.body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
}
const ofType = (events: Record<string, unknown>[], type: string): Record<string, unknown>[] => events.filter((e) => e['type'] === type);

/** The failed send's persisted backoff runs out (the tick's own clock, moved instead of waited for). */
async function elapseBackoff(): Promise<void> {
  const status = await readStatus(SID);
  for (const rec of Object.values(status?.delivery ?? {})) rec.nextAt = 0;
  if (status) await writeStatus(SID, status);
}

async function tick(): Promise<void> {
  await recoverMissingSessionEnds([SID], () => NOW);
  await new Promise((resolve) => setTimeout(resolve, 300)); // the scheduled enrichment appends to the spool
  await processSessionTick(SID, credentials);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cop-end-delivery-'));
  process.env.CODEMIE_HOME = join(dir, 'codemie');
  delete process.env.COPILOT_HOME;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  await mkdir(join(dir, 'codemie', 'proxy', 'otlp-spool'), { recursive: true });
  // A pre-upgrade (legacy) session: sent without an evidence record, as the tick-processor tests do.
  await writeFile(join(dir, 'codemie', 'proxy', 'otlp-spool', 'epoch.json'), JSON.stringify({ v: 1, created: Date.now() + 3_600_000 }));
  await mkdir(join(dir, '.copilot', 'session-state', SID), { recursive: true });
  const events = join(dir, '.copilot', 'session-state', SID, 'events.jsonl');
  await writeFile(events, transcript.join('\n') + '\n');
  await utimes(events, new Date(NOW - 60_000), new Date(NOW - 60_000));
  resetScheduledForTests();
  process.env.OTLP_SEND_MAX_ATTEMPTS = '1'; // the hooks-only gate waits this many ticks for OTEL data
  sent.length = 0;
  failFirst = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init: { body: string }) => {
    const status = sent.length < failFirst ? 500 : 200;
    sent.push({ url: String(url), body: String(init.body), status });
    return new Response('{}', { status });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.OTLP_SEND_MAX_ATTEMPTS;
  for (const [key, value] of [['CODEMIE_HOME', saved.home], ['COPILOT_HOME', saved.copilot], ['HOME', saved.userHome], ['USERPROFILE', saved.userProfile]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

describe('tick: recovered session end reaches the analytics API', () => {
  it('recovers a completed run from the tick of the registered OTLP interceptor', async () => {
    await spoolHook(hook('agent.session.start', 0), hook('agent.session.start', 10_000, { source: 'resume' }));
    const file = join(dir, '.copilot', 'session-state', SID, 'events.jsonl');
    await writeFile(file, [...transcript, line('session.resume', 10_000, {}), line('tool.execution_start', 11_000, {
      toolCallId: 'resumed-tool', toolName: 'read_agent', arguments: {},
    })].join('\n') + '\n');
    await utimes(file, new Date(NOW - 60_000), new Date(NOW - 60_000));
    const sessionStateRoot = join(dir, '.copilot', 'session-state');
    expect(await updateSessionState(SID, { sessionStateRoot })).toBe(true);

    registerCorePlugins();
    const plugin = getPluginRegistry().getAll().find((item) => item.id === '@codemie/otlp');
    expect(plugin).toBeDefined();
    const interceptor = await plugin!.createInterceptor({ credentials } as PluginContext);
    await (interceptor as unknown as { tick(): Promise<void> }).tick();

    await vi.waitFor(async () => {
      const records = await listHookRecords(SID);
      expect(ofType(records, 'agent.session.end').map((row) => row['timestamp'])).toEqual([at(5_000)]);
      expect(ofType(records, 'agent.session.summary').map((row) => [row['ended_at'], row['tool_calls']])).toEqual([[at(5_000), 3]]);
      expect(ofType(records, 'agent.tool.start').map((row) => row['tool_use_id']).sort()).toEqual(['ra-1', 'ra-2']);
    });
    expect(readSessionState(SID).sessionStateRoot).toBe(sessionStateRoot);
    await (interceptor as unknown as { tick(): Promise<void> }).tick();
    expect(ofType(accepted(), 'agent.session.end').map((row) => row['timestamp'])).toEqual([at(5_000)]);
    expect((await readStatus(SID))?.endedAt).toBeUndefined();
  });

  it('delivers one end, one final summary and each hook-less read_agent once, also after a failed send, a repeat tick and a late hook', async () => {
    await spoolHook(hook('agent.session.start', 0), hook('agent.tool.start', 1, { tool_name: 'view', tool_use_id: 'hooked-1' }));
    failFirst = 1;

    await tick(); // recovery and enrichment; the hooks-only gate waits one tick for OTEL data
    await tick(); // first send fails (500)
    await elapseBackoff();
    await tick(); // retried send succeeds; recovery sees the end and the summary: adds nothing
    // The late native sessionEnd: appended the way the hook-ingest handler does, skipped as the run is already ended.
    const late = hook('agent.session.end', 4_900);
    await appendSpool(SID, 'hooks', JSON.stringify({ agentName: COPILOT_CLI_OTLP_AGENT, hookEvent: JSON.stringify(late) }) + '\n', undefined, { skipIf: lateSessionEndSkip(COPILOT_CLI_OTLP_AGENT, SID, [late]) });
    await tick();

    expect(sent.map((s) => s.status)).toEqual([500, 200, ...sent.slice(2).map((s) => s.status)]);
    expect(sent[0].url).toBe('https://api.example.com/v1/analytics/cli-analytics/event-hooks');
    const delivered = accepted();
    expect(ofType(delivered, 'agent.session.end').map((e) => e['timestamp'])).toEqual([at(5_000)]);

    expect(ofType(delivered, 'agent.session.summary').map((e) => [e['is_final'], e['ended_at'], e['tool_calls']])).toEqual([[true, at(5_000), 3]]);
    expect(ofType(delivered, 'agent.tool.start').filter((e) => e['tool_name'] === 'read_agent').map((e) => e['tool_use_id']).sort()).toEqual(['ra-1', 'ra-2']);
    expect(ofType(delivered, 'agent.tool.end').map((e) => e['tool_use_id']).sort()).toEqual(['ra-1', 'ra-2']);
    const ids = delivered.map((e) => e['event_id']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
