/**
 * CodexSessionAdapter.locateTranscript over real rollouts (codex 0.125.0 and 0.128.0-alpha.1)
 * in a `~/.codex/sessions/YYYY/MM/DD/` layout: the run's whole window is searched, not the
 * last day's newest rollouts, and a rollout started at or after the window's end is not the run's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Session } from '../../../core/session/types.js';

const fakeHome = vi.hoisted(() => ({ path: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => fakeHome.path;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const { CodexSessionAdapter } = await import('../codex.session.js');
const { CodexPluginMetadata } = await import('../codex.plugin.js');
const { findRolloutForRun } = await import('../codex.correlation.js');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ROLLOUTS = [
  {
    version: '0.125.0',
    file: 'rollout-2026-05-11T11-26-55-019e1625-789d-76c0-80ab-3724b5ddb799.jsonl',
    cwd: '/Users/Sample_User/repos/codemie-ai/codemie-code',
    started: Date.parse('2026-05-11T08:26:55.042Z'),
    lastWrite: Date.parse('2026-05-11T08:44:58.544Z'),
  },
  {
    version: '0.128.0-alpha.1',
    file: 'rollout-2026-05-11T13-28-45-019e1695-0522-7c83-8b39-0dd379793f80.jsonl',
    cwd: '/Users/Sample_User/naya',
    started: Date.parse('2026-05-11T10:28:45.482Z'),
    lastWrite: Date.parse('2026-05-11T11:48:14.988Z'),
  },
];

let root: string;
let dayDir: string;
const previousCodemieHome = process.env.CODEMIE_HOME;
const previousCodexHome = process.env.CODEX_HOME;

function record(rollout: (typeof ROLLOUTS)[number]): Session {
  return {
    sessionId: '00000000-0000-4000-8000-00000000c0de',
    agentName: 'codex',
    provider: 'ai-run-sso',
    startTime: rollout.started - 3_000,
    workingDirectory: rollout.cwd,
    status: 'active',
    activeDurationMs: 0,
    correlation: { status: 'pending', retryCount: 0 },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-locate-'));
  fakeHome.path = root;
  delete process.env.CODEX_HOME;
  process.env.CODEMIE_HOME = join(root, '.codemie');
  mkdirSync(join(root, '.codemie', 'sessions'), { recursive: true });
  dayDir = join(root, '.codex', 'sessions', '2026', '05', '11');
  mkdirSync(dayDir, { recursive: true });
  for (const rollout of ROLLOUTS) {
    const path = join(dayDir, rollout.file);
    copyFileSync(join(FIXTURES, rollout.file), path);
    utimesSync(path, new Date(rollout.lastWrite), new Date(rollout.lastWrite));
  }
});

afterEach(() => {
  if (previousCodemieHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousCodemieHome;
  if (previousCodexHome !== undefined) process.env.CODEX_HOME = previousCodexHome;
  rmSync(root, { recursive: true, force: true });
});

describe('codex locateTranscript on real rollouts', () => {
  it.each(ROLLOUTS)('finds the $version rollout of a run months old', async (rollout) => {
    const adapter = new CodexSessionAdapter(CodexPluginMetadata);

    expect(await adapter.locateTranscript(record(rollout))).toEqual([join(dayDir, rollout.file)]);
  });

  it.each(ROLLOUTS)('a $version rollout started at the window end belongs to the later run', async (rollout) => {
    const adapter = new CodexSessionAdapter(CodexPluginMetadata);
    const run = { sessionId: 'run-a', startedAt: rollout.started - 3_000, cwd: rollout.cwd };

    expect(await findRolloutForRun(adapter, { ...run, window: { until: rollout.started } })).toBeUndefined();
    expect((await findRolloutForRun(adapter, { ...run, window: { until: rollout.started + 1 } }))?.filePath)
      .toBe(join(dayDir, rollout.file));
  });

  it('an unlinked record whose own rollout is gone does not take the rollout of a later codex run in its directory', async () => {
    const adapter = new CodexSessionAdapter(CodexPluginMetadata);
    const [rollout] = ROLLOUTS;
    const later = { ...record(rollout), sessionId: '00000000-0000-4000-8000-00000000beef' };
    writeFileSync(join(root, '.codemie', 'sessions', `${later.sessionId}.json`), JSON.stringify(later));
    const earlier = { ...record(rollout), startTime: rollout.started - 60 * 60_000 };

    expect(await adapter.locateTranscript(earlier)).toEqual([]);
  });
});
