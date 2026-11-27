/**
 * claude-acp wrapper lifecycle: a session record at start, line metrics from the located
 * transcripts at exit. Isolated: temp CODEMIE_HOME, temp CLAUDE_CONFIG_DIR, temp cwd; the hook
 * pipeline (which sends metrics) is mocked.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, utimesSync, existsSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const hook = vi.hoisted(() => ({ processEvent: vi.fn() }));
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() }));

vi.mock('@/utils/logger.js', () => ({ logger: log }));
vi.mock('@/cli/commands/hook.js', () => ({ processEvent: hook.processEvent }));
vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: hook.processEvent }));

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-fixture.jsonl');
const SESSION_ID = '00000000-0000-4000-8000-0000000000d4';
// The fixture's own timestamps are around 2026-11-26; the record starts before them
const RECORD_START = Date.parse('2026-11-26T00:00:00Z');

let root: string;
let cwd: string;
let projectDir: string;
const previous = { codemie: process.env.CODEMIE_HOME, config: process.env.CLAUDE_CONFIG_DIR, session: process.env.CODEMIE_SESSION_ID };

const { ClaudeAcpPluginMetadata } = await import('../claude-acp.plugin.js');
const { ClaudePluginMetadata } = await import('../claude.plugin.js');

function writeRecord(): void {
  writeFileSync(join(root, 'codemie', 'sessions', `${SESSION_ID}.json`), JSON.stringify({
    sessionId: SESSION_ID, agentName: 'claude-acp', provider: 'ai-run-sso', startTime: RECORD_START,
    workingDirectory: cwd, status: 'active', activeDurationMs: 0,
    correlation: { status: 'pending', retryCount: 0 },
  }));
}

function placeTranscript(name: string, source = FIXTURE, mtimeMs = Date.now()): string {
  const path = join(projectDir, name);
  copyFileSync(source, path);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

function lineTotals(): { added: number; removed: number } {
  const path = join(root, 'codemie', 'sessions', `${SESSION_ID}_metrics.jsonl`);
  const deltas = existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const ops = deltas.flatMap((d) => d.fileOperations ?? []) as Array<{ linesAdded?: number; linesRemoved?: number }>;
  return {
    added: ops.reduce((s, o) => s + (o.linesAdded ?? 0), 0),
    removed: ops.reduce((s, o) => s + (o.linesRemoved ?? 0), 0),
  };
}

const env = () => ({ CODEMIE_SESSION_ID: SESSION_ID, CODEMIE_AGENT: 'claude-acp' } as NodeJS.ProcessEnv);

beforeEach(() => {
  vi.clearAllMocks();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-acp-life-')));
  cwd = join(root, 'work');
  mkdirSync(cwd);
  process.env.CODEMIE_HOME = join(root, 'codemie');
  mkdirSync(join(root, 'codemie', 'sessions'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  projectDir = join(root, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  writeRecord();
});

afterEach(() => {
  for (const [key, value] of [['CODEMIE_HOME', previous.codemie], ['CLAUDE_CONFIG_DIR', previous.config], ['CODEMIE_SESSION_ID', previous.session]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('claude-acp lifecycle', () => {
  it('plain claude has no wrapper lifecycle; claude-acp keeps beforeRun and adds start/end', () => {
    expect(ClaudePluginMetadata.lifecycle?.onSessionStart).toBeUndefined();
    expect(ClaudePluginMetadata.lifecycle?.onSessionEnd).toBeUndefined();
    expect(ClaudeAcpPluginMetadata.lifecycle?.beforeRun).toBe(ClaudePluginMetadata.lifecycle?.beforeRun);
    expect(ClaudeAcpPluginMetadata.lifecycle?.onSessionStart).toBeTypeOf('function');
    expect(ClaudeAcpPluginMetadata.lifecycle?.onSessionEnd).toBeTypeOf('function');
  });

  it('start sends SessionStart through the hook pipeline with the claude-acp agent', async () => {
    rmSync(join(root, 'codemie', 'sessions', `${SESSION_ID}.json`));
    await ClaudeAcpPluginMetadata.lifecycle!.onSessionStart!(SESSION_ID, env());
    expect(hook.processEvent).toHaveBeenCalledTimes(1);
    const [event, config] = hook.processEvent.mock.calls[0];
    expect(event).toMatchObject({ hook_event_name: 'SessionStart', session_id: SESSION_ID, transcript_path: '' });
    expect(config).toMatchObject({ agentName: 'claude-acp', sessionId: SESSION_ID });
  });

  it('end records 7 added / 2 removed lines from the located transcript and then sends SessionEnd', async () => {
    placeTranscript('acp.jsonl');
    await ClaudeAcpPluginMetadata.lifecycle!.onSessionEnd!(0, env());

    expect(lineTotals()).toEqual({ added: 7, removed: 2 });
    const stored = JSON.parse(readFileSync(join(root, 'codemie', 'sessions', `${SESSION_ID}.json`), 'utf-8'));
    expect(stored.correlation.agentSessionFile).toBe(join(projectDir, 'acp.jsonl'));
    expect(hook.processEvent.mock.calls.map(([event]) => event.hook_event_name)).toEqual(['SessionEnd']);
  });

  it('no transcript: warns, does not throw, and still ends the record', async () => {
    await expect(ClaudeAcpPluginMetadata.lifecycle!.onSessionEnd!(0, env())).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    expect(lineTotals()).toEqual({ added: 0, removed: 0 });
    expect(hook.processEvent.mock.calls.map(([event]) => event.hook_event_name)).toEqual(['SessionEnd']);
  });

  it('two distinct transcripts of the run are summed once each, with no double count on a repeat', async () => {
    const second = join(root, 'second.jsonl');
    writeFileSync(second, readFileSync(FIXTURE, 'utf-8').replace(/uuid-/g, 'uuid-b-').replace(/msg_bdrk_/g, 'msg_bdrk_b').replace(/toolu_bdrk_/g, 'toolu_bdrk_b'));
    placeTranscript('one.jsonl', FIXTURE, Date.now() - 60_000);
    placeTranscript('two.jsonl', second, Date.now());
    await ClaudeAcpPluginMetadata.lifecycle!.onSessionEnd!(0, env());
    expect(lineTotals()).toEqual({ added: 14, removed: 4 });
    await ClaudeAcpPluginMetadata.lifecycle!.onSessionEnd!(0, env());
    expect(lineTotals()).toEqual({ added: 14, removed: 4 });
  });
});
