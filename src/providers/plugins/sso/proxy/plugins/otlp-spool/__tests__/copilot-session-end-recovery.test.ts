import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  COPILOT_CLI_OTLP_AGENT,
  RECOVERY_SETTLE_MS,
  recoverMissingSessionEnds,
  resetScheduledForTests,
  scheduleCopilotUsageEnrichment,
} from '../copilot-usage-enrichment.js';
import { appendSpool } from '../spool-io.js';

/**
 * Real spool files and the real transcript reader: a hook batch is appended exactly as the daemon's
 * /v1/analytics/hooks handler does, and the recovery pass is the one the daemon tick runs.
 * The events.jsonl content is synthetic (hand-built lines in Copilot's event shapes).
 */
const SID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';
const T0 = Date.parse('2026-10-20T06:25:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const NOW = T0 + 10 * 60_000;

const identity = { developer_name: 'dev@example.com', codemie_project_name: 'proj', platform: 'copilot-cli', entrypoint: 'managed', git_branch: 'EPMCDME-17840', repo_remote: 'org/repo' };
const hook = (type: string, ms: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ type, session_id: SID, timestamp: at(ms), event_id: `${type}:${ms}`, ...identity, ...extra });

const line = (type: string, ms: number, data: Record<string, unknown>): string => JSON.stringify({ type, timestamp: at(ms), data });
const shutdown = (ms: number): string => line('session.shutdown', ms, {
  modelMetrics: { 'gpt-6-luna': { requests: { count: 1 }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
});
// One hooked call and two runtime-issued `read_agent` calls (no preToolUse hook) in one run.
const runLines = (startMs: number, withShutdownMs?: number): string[] => [
  line('session.start', startMs, { startTime: at(startMs), copilotVersion: '1.0.92' }),
  line('hook.start', startMs + 1, { hookType: 'preToolUse', input: { toolCallId: `hooked-${startMs}` } }),
  line('tool.execution_start', startMs + 2, { toolCallId: `hooked-${startMs}`, toolName: 'view', arguments: {} }),
  line('tool.execution_complete', startMs + 2, { toolCallId: `hooked-${startMs}`, success: true }),
  line('tool.execution_start', startMs + 3, { toolCallId: `ra-1-${startMs}`, toolName: 'read_agent', arguments: {} }),
  line('tool.execution_complete', startMs + 4, { toolCallId: `ra-1-${startMs}`, success: true }),
  line('tool.execution_start', startMs + 5, { toolCallId: `ra-2-${startMs}`, toolName: 'read_agent', arguments: {} }),
  line('tool.execution_complete', startMs + 6, { toolCallId: `ra-2-${startMs}`, success: true }),
  ...(withShutdownMs !== undefined ? [shutdown(withShutdownMs)] : []),
];

let dir: string;
let eventsFile: string;
const saved = { home: process.env.CODEMIE_HOME, copilot: process.env.COPILOT_HOME, userHome: process.env.HOME, userProfile: process.env.USERPROFILE };

async function spool(events: Record<string, unknown>[]): Promise<void> {
  await appendSpool(SID, 'hooks', events.map((e) => JSON.stringify({ agentName: COPILOT_CLI_OTLP_AGENT, hookEvent: JSON.stringify(e) })).join('\n') + '\n');
}

async function spooled(): Promise<Record<string, unknown>[]> {
  let text = '';
  try {
    text = await readFile(join(dir, 'codemie', 'proxy', 'otlp-spool', `${SID}.hooks.ndjson`), 'utf-8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(JSON.parse(l).hookEvent) as Record<string, unknown>);
}

/** Writes the transcript and ages it, as a finished session's file would be. */
async function writeTranscript(lines: string[], ageMs = 60_000): Promise<void> {
  await writeFile(eventsFile, lines.join('\n') + '\n');
  const when = new Date(NOW - ageMs);
  await utimes(eventsFile, when, when);
}

/** Runs the daemon's recovery pass and waits for the enrichment it schedules. */
async function recover(): Promise<void> {
  await recoverMissingSessionEnds([SID], () => NOW);
  await vi.waitFor(async () => {
    const events = await spooled();
    if (events.some((e) => e['type'] === 'agent.session.end') && !events.some((e) => e['type'] === 'agent.session.summary')) throw new Error('enrichment pending');
  });
}

const count = (events: Record<string, unknown>[], type: string): number => events.filter((e) => e['type'] === type).length;
const toolIds = (events: Record<string, unknown>[], type: string): unknown[] => events.filter((e) => e['type'] === type).map((e) => e['tool_use_id']).sort();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cop-end-recovery-'));
  process.env.CODEMIE_HOME = join(dir, 'codemie');
  delete process.env.COPILOT_HOME;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  await mkdir(join(dir, '.copilot', 'session-state', SID), { recursive: true });
  eventsFile = join(dir, '.copilot', 'session-state', SID, 'events.jsonl');
  resetScheduledForTests();
});

afterEach(async () => {
  for (const [key, value] of [['CODEMIE_HOME', saved.home], ['COPILOT_HOME', saved.copilot], ['HOME', saved.userHome], ['USERPROFILE', saved.userProfile]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

describe('recoverMissingSessionEnds', () => {
  it('delivers end, final summary and per-tool events when sessionEnd never arrived', async () => {
    await spool([hook('agent.session.start', 0), hook('agent.tool.start', 1, { tool_name: 'view', tool_use_id: 'hooked-0' })]);
    await writeTranscript(runLines(0, 5_000));

    await recover();

    const events = await spooled();
    expect(count(events, 'agent.session.end')).toBe(1);
    const end = events.find((e) => e['type'] === 'agent.session.end');
    expect(end).toMatchObject({ session_id: SID, timestamp: at(5_000), platform: 'copilot-cli', entrypoint: 'managed', git_branch: 'EPMCDME-17840', repo_remote: 'org/repo' });
    expect(count(events, 'agent.session.summary')).toBe(1);
    expect(events.find((e) => e['type'] === 'agent.session.summary')).toMatchObject({ is_final: true, ended_at: at(5_000), tool_calls: 3 });
    // The two runtime-issued read_agent calls are delivered once each, by identity; the hooked call is not duplicated.
    expect(toolIds(events, 'agent.tool.start').filter((id) => String(id).startsWith('ra-'))).toEqual(['ra-1-0', 'ra-2-0']);
    expect(toolIds(events, 'agent.tool.end')).toEqual(['ra-1-0', 'ra-2-0']);
    expect(events.filter((e) => e['tool_name'] === 'read_agent' && e['type'] === 'agent.tool.start')).toHaveLength(2);
  });

  it('adds nothing on the normal path: a delivered sessionEnd already started the enrichment', async () => {
    await spool([hook('agent.session.start', 0), hook('agent.session.end', 4_000)]);
    await writeTranscript(runLines(0, 5_000));

    await recoverMissingSessionEnds([SID], () => NOW);

    expect(await spooled()).toHaveLength(2);
  });

  it('does not end a live or just-finished session (transcript still moving)', async () => {
    await spool([hook('agent.session.start', 0)]);
    await writeTranscript(runLines(0, 5_000), RECOVERY_SETTLE_MS - 1_000);

    await recoverMissingSessionEnds([SID], () => NOW);

    expect(await spooled()).toHaveLength(1);
  });

  it('stays conservative without shutdown evidence (killed session)', async () => {
    await spool([hook('agent.session.start', 0)]);
    await writeTranscript(runLines(0));

    await recoverMissingSessionEnds([SID], () => NOW);

    expect(await spooled()).toHaveLength(1);
  });

  it('repeated processing and a late real sessionEnd add no second summary, usage row or tool event', async () => {
    await spool([hook('agent.session.start', 0)]);
    await writeTranscript(runLines(0, 5_000));
    await recover();
    const first = await spooled();

    await recoverMissingSessionEnds([SID], () => NOW); // repeated tick
    // The late hook finally lands: spooled by the handler, then schedules the usual enrichment.
    const late = hook('agent.session.end', 4_900);
    await spool([late]);
    scheduleCopilotUsageEnrichment(COPILOT_CLI_OTLP_AGENT, [late]);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const after = await spooled();
    for (const type of ['agent.session.summary', 'agent.usage.request', 'agent.tool.start', 'agent.tool.end']) {
      expect(count(after, type)).toBe(count(first, type));
    }
    expect(count(after, 'agent.session.end')).toBe(2);
  });

  it('a resumed run with the same session id gets its own end; the first run is not re-ended', async () => {
    await spool([hook('agent.session.start', 0)]);
    await writeTranscript(runLines(0, 5_000));
    await recover();

    // Resume: new sessionStart, work appended to the same transcript, aborted again.
    await spool([hook('agent.session.start', 60_000, { source: 'resume' })]);
    await writeTranscript([...runLines(0, 5_000), ...runLines(60_000, 65_000)]);
    await recoverMissingSessionEnds([SID], () => NOW);
    await vi.waitFor(async () => {
      if (count(await spooled(), 'agent.session.summary') < 2) throw new Error('second enrichment pending');
    });

    const events = await spooled();
    expect(events.filter((e) => e['type'] === 'agent.session.end').map((e) => e['timestamp'])).toEqual([at(5_000), at(65_000)]);
    // Second summary covers the whole transcript under its own ended_at.
    expect(events.filter((e) => e['type'] === 'agent.session.summary').map((e) => e['ended_at'])).toEqual([at(5_000), at(65_000)]);
    // The resumed pass re-emits the first run's tools with the same event_id (the backend dedups on it):
    // by event_id each call is exactly one event, 4 read_agent calls in all.
    const starts = events.filter((e) => e['type'] === 'agent.tool.start' && e['tool_name'] === 'read_agent');
    expect(new Set(starts.map((e) => e['event_id'])).size).toBe(4);
    expect(new Set(starts.map((e) => e['tool_use_id']))).toEqual(new Set(['ra-1-0', 'ra-2-0', 'ra-1-60000', 'ra-2-60000']));
  });

  it('does not end a resumed run that is still live: the older shutdown predates its start', async () => {
    await spool([hook('agent.session.start', 0), hook('agent.session.end', 4_000), hook('agent.session.start', 60_000, { source: 'resume' })]);
    await writeTranscript([...runLines(0, 5_000), ...runLines(60_000)]);

    await recoverMissingSessionEnds([SID], () => NOW);

    expect(count(await spooled(), 'agent.session.end')).toBe(1);
  });
});
