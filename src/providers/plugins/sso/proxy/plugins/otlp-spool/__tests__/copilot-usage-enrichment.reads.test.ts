import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.transcript.js')>();
  return { ...actual, readTranscriptFromAsync: vi.fn(actual.readTranscriptFromAsync) };
});

import { readTranscriptFromAsync } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.transcript.js';
import { enrichSessionUsage, resetScheduledForTests } from '../copilot-usage-enrichment.js';

const SID = 'c73ecba6-c21a-415d-b40f-cb0cdb416155';
const END_MS = 1792477566318;
const startLine = JSON.stringify({ type: 'session.start', timestamp: '2026-10-20T06:25:51.670Z', data: { startTime: '2026-10-20T06:25:51.670Z' } });
const shutdownLine = JSON.stringify({
  type: 'session.shutdown',
  timestamp: new Date(END_MS + 1000).toISOString(),
  data: { modelMetrics: { 'gpt-6-luna': { requests: { count: 1 }, usage: { inputTokens: 10, outputTokens: 5 } } } },
});

let dir: string;
let eventsFile: string;
const saved = { home: process.env.CODEMIE_HOME, copilot: process.env.COPILOT_HOME, userHome: process.env.HOME, userProfile: process.env.USERPROFILE };

const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cop-enrich-reads-'));
  process.env.CODEMIE_HOME = join(dir, 'codemie');
  delete process.env.COPILOT_HOME;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  await mkdir(join(dir, '.copilot', 'session-state', SID), { recursive: true });
  eventsFile = join(dir, '.copilot', 'session-state', SID, 'events.jsonl');
  resetScheduledForTests();
  vi.mocked(readTranscriptFromAsync).mockClear();
});

afterEach(async () => {
  restore('CODEMIE_HOME', saved.home);
  restore('COPILOT_HOME', saved.copilot);
  restore('HOME', saved.userHome);
  restore('USERPROFILE', saved.userProfile);
  await rm(dir, { recursive: true, force: true });
});

const template = (): Record<string, unknown> => ({
  type: 'agent.session.end', session_id: SID, timestamp: new Date(END_MS).toISOString(), platform: 'copilot-cli',
});

describe('enrichSessionUsage transcript reads', () => {
  it('parses the transcript once while its size and mtime do not change', async () => {
    await writeFile(eventsFile, `${startLine}\n`);
    let t = 0;

    expect(await enrichSessionUsage(template(), async (ms) => { t += ms; }, () => t)).toBe('timeout');

    expect(vi.mocked(readTranscriptFromAsync)).toHaveBeenCalledTimes(1);
  });

  it('reads again when the file changes between polls', async () => {
    await writeFile(eventsFile, `${startLine}\n`);
    let t = 0;
    let appended = false;
    const sleep = async (ms: number): Promise<void> => {
      t += ms;
      if (!appended) {
        appended = true;
        await appendFile(eventsFile, `${shutdownLine}\n`);
      }
    };

    expect(await enrichSessionUsage(template(), sleep, () => t)).toBe('enriched');
    expect(vi.mocked(readTranscriptFromAsync)).toHaveBeenCalledTimes(2);
  });
});
