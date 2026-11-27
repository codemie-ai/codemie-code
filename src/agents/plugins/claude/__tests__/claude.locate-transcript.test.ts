/**
 * ClaudeSessionAdapter.locateTranscript finds a record's transcripts in the projects directory of
 * the record's working directory, bounded by the run window and never taking another record's file.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../../../core/session/types.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const { ClaudeSessionAdapter } = await import('../claude.session.js');
const { ClaudePluginMetadata } = await import('../claude.plugin.js');

const RUN_START = Date.parse('2026-11-01T12:00:00Z');
const minute = (m: number) => RUN_START + m * 60_000;

let root: string;
let cwd: string;
let projectDir: string;
const previous = { codemie: process.env.CODEMIE_HOME, config: process.env.CLAUDE_CONFIG_DIR };

function transcript(name: string, mtimeMs: number, firstEventMs?: number): string {
  const path = join(projectDir, name);
  writeFileSync(path, firstEventMs === undefined ? '{}\n' : `{"timestamp":"${new Date(firstEventMs).toISOString()}"}\n`);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

function record(extra: Partial<Session> = {}): Session {
  return {
    sessionId: '00000000-0000-4000-8000-0000000000a1',
    agentName: 'claude-acp',
    provider: 'ai-run-sso',
    startTime: RUN_START,
    workingDirectory: cwd,
    status: 'active',
    activeDurationMs: 0,
    correlation: { status: 'pending', retryCount: 0 },
    ...extra,
  };
}

function saveRecord(session: Session): void {
  writeFileSync(join(root, 'codemie', 'sessions', `${session.sessionId}.json`), JSON.stringify(session));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-locate-')));
  cwd = join(root, 'work.space');
  mkdirSync(cwd);
  process.env.CODEMIE_HOME = join(root, 'codemie');
  mkdirSync(join(root, 'codemie', 'sessions'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  projectDir = join(root, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  if (previous.codemie === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = previous.codemie;
  if (previous.config === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.config;
  rmSync(root, { recursive: true, force: true });
});

const adapter = () => new ClaudeSessionAdapter(ClaudePluginMetadata);

describe('ClaudeSessionAdapter.locateTranscript', () => {
  it('returns [] for a cwd with no projects directory', async () => {
    expect(await adapter().locateTranscript(record({ workingDirectory: join(root, 'unknown') }))).toEqual([]);
  });

  it('excludes a file last written before the run start', async () => {
    transcript('old.jsonl', minute(-30));
    expect(await adapter().locateTranscript(record())).toEqual([]);
  });

  it('excludes a file at or after the next record start in the same directory', async () => {
    saveRecord(record({ sessionId: '00000000-0000-4000-8000-0000000000b2', startTime: minute(10) }));
    const inside = transcript('inside.jsonl', minute(5));
    transcript('later.jsonl', minute(10));
    expect(await adapter().locateTranscript(record())).toEqual([inside]);
  });

  it('windows by the first event time, not the last write', async () => {
    transcript('resumed.jsonl', minute(5), minute(-30));
    const spanning = transcript('spanning.jsonl', minute(20), minute(5));
    saveRecord(record({ sessionId: '00000000-0000-4000-8000-0000000000b2', startTime: minute(10) }));
    expect(await adapter().locateTranscript(record())).toEqual([spanning]);
  });

  it('excludes a file another record already names', async () => {
    const claimed = transcript('claimed.jsonl', minute(2));
    const free = transcript('free.jsonl', minute(3));
    saveRecord(record({
      sessionId: '00000000-0000-4000-8000-0000000000c3',
      agentName: 'claude',
      startTime: minute(-60),
      status: 'completed',
      correlation: { status: 'matched', retryCount: 0, agentSessionFile: claimed },
    }));
    expect(await adapter().locateTranscript(record())).toEqual([free]);
  });

  it('returns two valid files in time order', async () => {
    const second = transcript('b.jsonl', minute(8));
    const first = transcript('a.jsonl', minute(4));
    expect(await adapter().locateTranscript(record())).toEqual([first, second]);
  });

  it('honours CLAUDE_CONFIG_DIR and ignores non-jsonl files', async () => {
    const file = transcript('x.jsonl', minute(3));
    writeFileSync(join(projectDir, 'notes.txt'), 'x');
    expect(await adapter().locateTranscript(record())).toEqual([file]);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'elsewhere');
    expect(await adapter().locateTranscript(record())).toEqual([]);
  });
});
