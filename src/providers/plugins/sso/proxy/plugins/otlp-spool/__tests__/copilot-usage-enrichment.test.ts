import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/utils/logger.js';

import {
  COPILOT_CLI_OTLP_AGENT,
  MAX_WAIT_MS,
  POLL_INTERVAL_MS,
  enrichSessionUsage,
  resetScheduledForTests,
  scheduleCopilotUsageEnrichment,
} from '../copilot-usage-enrichment.js';

const SID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';
const END_MS = 1792477566318;

// The lifecycle event the hook already built: carries every resolved identity/project field.
const sessionEnd = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'agent.session.end',
  session_id: SID,
  timestamp: new Date(END_MS).toISOString(),
  user_email: '',
  developer_name: 'dev@example.com',
  identity_source: 'git',
  codemie_project_name: 'github_copilot_analytics',
  codemie_cli_version: '0.15.9',
  git_branch: 'EPMCDME-16018',
  repo_remote: 'org/repo',
  story_id: 'EPMCDME-16018',
  story_source: 'branch',
  platform: 'copilot-cli',
  client_version: '',
  cwd: 'Projects/repo',
  schema_version: 2,
  event_id: 'hook-event-id',
  ...extra,
});

// Real session.shutdown of a Copilot 1.0.83 session (OpenAI convention: inputTokens = whole prompt).
const shutdownLine = (atMs: number): string =>
  JSON.stringify({
    type: 'session.shutdown',
    timestamp: new Date(atMs).toISOString(),
    data: {
      totalPremiumRequests: 1,
      modelMetrics: {
        'gpt-6-luna': {
          requests: { count: 2 },
          usage: { inputTokens: 58303, outputTokens: 67, cacheReadTokens: 29102, cacheWriteTokens: 29195, reasoningTokens: 0 },
        },
      },
    },
  });
const startLine = JSON.stringify({ type: 'session.start', timestamp: '2026-10-20T06:25:51.670Z', data: { startTime: '2026-10-20T06:25:51.670Z' } });

let dir: string;
let eventsFile: string;
const savedEnv = { home: process.env.CODEMIE_HOME, copilot: process.env.COPILOT_HOME };

async function spooled(): Promise<Record<string, unknown>[]> {
  let text = '';
  try {
    text = await readFile(join(dir, 'codemie', 'proxy', 'otlp-spool', `${SID}.hooks.ndjson`), 'utf-8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(JSON.parse(l).hookEvent) as Record<string, unknown>);
}

/** A fake clock: every sleep advances time, so bounded loops finish instantly. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, now: () => t };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cop-enrich-'));
  process.env.CODEMIE_HOME = join(dir, 'codemie');
  process.env.COPILOT_HOME = join(dir, 'copilot');
  await mkdir(join(dir, 'copilot', 'session-state', SID), { recursive: true });
  eventsFile = join(dir, 'copilot', 'session-state', SID, 'events.jsonl');
  resetScheduledForTests();
  vi.mocked(logger.warn).mockClear();
});

afterEach(async () => {
  process.env.CODEMIE_HOME = savedEnv.home;
  process.env.COPILOT_HOME = savedEnv.copilot;
  if (savedEnv.home === undefined) delete process.env.CODEMIE_HOME;
  if (savedEnv.copilot === undefined) delete process.env.COPILOT_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe('enrichSessionUsage', () => {
  it('emits a usage request per model and a summary once session.shutdown is there', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 1200)}\n`);
    const clock = fakeClock();

    expect(await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now)).toBe('enriched');

    const events = await spooled();
    expect(events.map((e) => e.type)).toEqual(['agent.usage.request', 'agent.session.summary']);
    // 58303 prompt = 6 fresh + 29102 cache read + 29195 cache write; nothing dropped or doubled.
    expect(events[0]).toMatchObject({
      session_id: SID,
      model: 'gpt-6-luna',
      input_tokens: 6,
      output_tokens: 67,
      cache_read_tokens: 29102,
      cache_creation_5m_tokens: 29195,
    });
    expect(events[1]).toMatchObject({ is_final: true, primary_model: 'gpt-6-luna', started_at: '2026-10-20T06:25:51.670Z' });
  });

  it('carries the lifecycle event identity: same user, project, repo, branch and platform', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 1200)}\n`);
    const clock = fakeClock();
    await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now);
    for (const e of await spooled()) {
      expect(e).toMatchObject({
        codemie_project_name: 'github_copilot_analytics',
        git_branch: 'EPMCDME-16018',
        repo_remote: 'org/repo',
        platform: 'copilot-cli',
        developer_name: 'dev@example.com',
      });
      expect(e.event_id).not.toBe('hook-event-id');
    }
  });

  it('retries while session.shutdown is temporarily absent, then emits when it lands', async () => {
    await writeFile(eventsFile, `${startLine}\n`);
    let polls = 0;
    const sleep = async (ms: number): Promise<void> => {
      polls += 1;
      clock.sleeps.push(ms);
      if (polls === 3) await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 1200)}\n`);
    };
    const clock = fakeClock();

    expect(await enrichSessionUsage(sessionEnd(), sleep, clock.now)).toBe('enriched');
    expect(polls).toBe(3);
    expect(clock.sleeps.every((ms) => ms === POLL_INTERVAL_MS)).toBe(true);
  });

  it('stops after the bounded wait when session.shutdown never appears', async () => {
    await writeFile(eventsFile, `${startLine}\n`);
    const clock = fakeClock();

    expect(await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now)).toBe('timeout');

    expect(clock.sleeps.length).toBeLessThanOrEqual(Math.ceil(MAX_WAIT_MS / POLL_INTERVAL_MS) + 1);
    expect(await spooled()).toEqual([]);
  });

  it('ignores a shutdown older than the sessionEnd (resumed session) and times out', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS - 60_000)}\n`);
    const clock = fakeClock();
    expect(await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now)).toBe('timeout');
    expect(await spooled()).toEqual([]);
  });

  it('does not emit twice: a second run over the same session adds nothing', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 1200)}\n`);
    const clock = fakeClock();
    expect(await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now)).toBe('enriched');
    expect(await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now)).toBe('duplicate');
    expect((await spooled()).filter((e) => e.type === 'agent.usage.request')).toHaveLength(1);
  });

  it('uses stable event ids so a re-sent batch is deduplicated by the backend', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 1200)}\n`);
    const clock = fakeClock();
    await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now);
    const first = (await spooled()).map((e) => e.event_id);
    await rm(join(dir, 'codemie'), { recursive: true, force: true });
    await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now);
    expect((await spooled()).map((e) => e.event_id)).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('emits nothing when the shutdown carries no model usage', async () => {
    await writeFile(eventsFile, `${startLine}\n${JSON.stringify({ type: 'session.shutdown', timestamp: new Date(END_MS + 1200).toISOString(), data: {} })}\n`);
    const clock = fakeClock();
    expect(await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now)).toBe('no-usage');
    expect(await spooled()).toEqual([]);
  });

  it('enriches a resumed session again: usage from an earlier sessionEnd does not count as a duplicate', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 1200)}\n`);
    const clock = fakeClock();
    expect(await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now)).toBe('enriched');

    const resumedEndMs = END_MS + 3_600_000;
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 1200)}\n${shutdownLine(resumedEndMs + 1200)}\n`);
    const resumed = sessionEnd({ timestamp: new Date(resumedEndMs).toISOString() });

    expect(await enrichSessionUsage(resumed, clock.sleep, clock.now)).toBe('enriched');
  });

  it('rejects an unsafe session id before any filesystem read or spool append', async () => {
    const decoyDir = join(dir, 'decoy');
    await mkdir(decoyDir, { recursive: true });
    await writeFile(join(decoyDir, 'events.jsonl'), `${startLine}\n${shutdownLine(END_MS + 1200)}\n`);
    const clock = fakeClock();

    const outcome = await enrichSessionUsage(sessionEnd({ session_id: '../../decoy' }), clock.sleep, clock.now);

    expect(outcome).toBe('error');
    expect(clock.sleeps).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unsafe session id'));
    expect(existsSync(join(dir, 'codemie', 'decoy.hooks.ndjson'))).toBe(false);
  });

  it('reports a spool failure as an error (logged above debug), not as a timeout', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 1200)}\n`);
    // A regular file where the spool directory must be makes the append fail.
    await mkdir(join(dir, 'codemie'), { recursive: true });
    await writeFile(join(dir, 'codemie', 'proxy'), 'not a directory');
    const clock = fakeClock();

    expect(await enrichSessionUsage(sessionEnd(), clock.sleep, clock.now)).toBe('error');
    expect(logger.warn).toHaveBeenCalledWith('[otlp-ingest] copilot usage enrichment error', expect.anything());
  });
});

describe('scheduleCopilotUsageEnrichment', () => {
  it('schedules once for a Copilot session end, even if the batch is delivered twice', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 50)}\n`);
    scheduleCopilotUsageEnrichment(COPILOT_CLI_OTLP_AGENT, [sessionEnd()]);
    scheduleCopilotUsageEnrichment(COPILOT_CLI_OTLP_AGENT, [sessionEnd()]);
    await vi.waitFor(async () => expect((await spooled()).length).toBe(2));
    await new Promise((r) => setTimeout(r, 100));
    expect((await spooled()).filter((e) => e.type === 'agent.usage.request')).toHaveLength(1);
  });

  it('retries a later delivery of the same sessionEnd after a non-final outcome', async () => {
    const noUsage = `${startLine}\n${JSON.stringify({ type: 'session.shutdown', timestamp: new Date(END_MS + 50).toISOString(), data: {} })}\n`;
    await writeFile(eventsFile, noUsage);
    scheduleCopilotUsageEnrichment(COPILOT_CLI_OTLP_AGENT, [sessionEnd()]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await spooled()).toEqual([]);

    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 50)}\n`);
    scheduleCopilotUsageEnrichment(COPILOT_CLI_OTLP_AGENT, [sessionEnd()]);

    await vi.waitFor(async () => expect((await spooled()).length).toBe(2));
  });

  it('does not schedule an unsafe session id', async () => {
    const decoyDir = join(dir, 'decoy');
    await mkdir(decoyDir, { recursive: true });
    await writeFile(join(decoyDir, 'events.jsonl'), `${startLine}\n${shutdownLine(END_MS + 50)}\n`);

    scheduleCopilotUsageEnrichment(COPILOT_CLI_OTLP_AGENT, [sessionEnd({ session_id: '../../decoy' })]);
    await new Promise((r) => setTimeout(r, 100));

    expect(existsSync(join(dir, 'codemie', 'decoy.hooks.ndjson'))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips null and non-object elements without throwing, still scheduling the valid ones', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 50)}\n`);
    const batch = [null, 'x', 42, sessionEnd()] as unknown as Record<string, unknown>[];

    expect(() => scheduleCopilotUsageEnrichment(COPILOT_CLI_OTLP_AGENT, batch)).not.toThrow();

    await vi.waitFor(async () => expect((await spooled()).length).toBe(2));
  });

  it('ignores other lifecycle events of a Copilot session', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 50)}\n`);
    scheduleCopilotUsageEnrichment(COPILOT_CLI_OTLP_AGENT, [sessionEnd({ type: 'agent.prompt.submit' })]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await spooled()).toEqual([]);
  });

  it('never touches Claude Code batches, even one carrying a session end', async () => {
    await writeFile(eventsFile, `${startLine}\n${shutdownLine(END_MS + 50)}\n`);
    scheduleCopilotUsageEnrichment('claude-code-otlp', [sessionEnd()]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await spooled()).toEqual([]);
  });
});
