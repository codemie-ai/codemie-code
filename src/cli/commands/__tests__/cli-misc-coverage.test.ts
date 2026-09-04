/**
 * cli-misc coverage — pins today's behavior for a handful of small CLI surfaces:
 *
 *  - analytics/exporter.ts       JSON + CSV export round-trip, incl. CSV escaping & headers
 *  - assistants/chat/conversationIdSafety.ts   path-traversal guard regex
 *  - assistants/chat/historyPersister.ts       JSONL turn append (temp home, index continuity)
 *  - commands/list.ts            agent + framework listing output (registry/frameworks mocked)
 *  - commands/update.ts          update path calls npm install -g --force (spawn mocked, never run)
 *
 * All external systems are mocked: no network, no real npm/spawn, no writes to the
 * developer's real ~/.codemie (a unique temp CODEMIE_HOME is used for the persister).
 * Expected values were captured by probing the real compiled code first.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Shared mocks (hoisted so vi.mock factories can reference them safely).
// ---------------------------------------------------------------------------

// logger — silence & avoid any real log-file writes under CODEMIE_HOME.
vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// AgentRegistry — configured per-test.
const registryMock = vi.hoisted(() => ({
  getManageableAgents: vi.fn(),
  getInstalledAgents: vi.fn(),
  getAgent: vi.fn(),
}));
vi.mock('@/agents/registry.js', () => ({ AgentRegistry: registryMock }));

// FrameworkRegistry (dynamically imported by list.ts).
const frameworksMock = vi.hoisted(() => ({ getAllFrameworks: vi.fn(() => []) }));
vi.mock('@/frameworks/index.js', () => ({ FrameworkRegistry: frameworksMock }));

// npm process helpers — spread the real module, override only the two the
// update flow touches so we never spawn a real `npm install`.
const npmMock = vi.hoisted(() => ({
  getLatestVersion: vi.fn(),
  installGlobal: vi.fn(async () => {}),
}));
vi.mock('@/utils/processes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/processes.js')>();
  return { ...actual, getLatestVersion: npmMock.getLatestVersion, installGlobal: npmMock.installGlobal };
});

// restoreCliBinLink — no-op (would otherwise touch the filesystem).
vi.mock('@/utils/cli-bin.js', () => ({ restoreCliBinLink: vi.fn(async () => {}) }));

// ora spinner — chainable no-op.
const spinner = {
  start: vi.fn(() => spinner),
  succeed: vi.fn(() => spinner),
  warn: vi.fn(() => spinner),
  fail: vi.fn(() => spinner),
  stop: vi.fn(() => spinner),
  info: vi.fn(() => spinner),
};
vi.mock('ora', () => ({ default: vi.fn(() => spinner) }));

import { AnalyticsExporter } from '../analytics/exporter.js';
import { isValidConversationId } from '../assistants/chat/conversationIdSafety.js';
import { appendConversationTurn } from '../assistants/chat/historyPersister.js';
import { getSessionConversationPath } from '@/agents/core/session/session-config.js';
import { createListCommand } from '../list.js';
import { createUpdateCommand } from '../update.js';
import type { RootAnalytics } from '../analytics/types.js';

// ---------------------------------------------------------------------------
// Console capture helper.
// ---------------------------------------------------------------------------
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
function captured(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// ===========================================================================
// AnalyticsExporter
// ===========================================================================
describe('AnalyticsExporter', () => {
  /** Minimal RootAnalytics with two sessions; one carries a comma and a quote. */
  function fixture(): RootAnalytics {
    return {
      projects: [
        {
          projectPath: '/repo/a',
          branches: [
            {
              branchName: 'main',
              sessions: [
                {
                  sessionId: 's1',
                  agentName: 'claude',
                  provider: 'ai-run-sso',
                  startTime: 1704067200000, // 2024-01-01T00:00:00.000Z
                  duration: 65000,
                  totalTurns: 3,
                  models: [{ model: 'sonnet', calls: 2, percentage: 100 }],
                  files: [
                    { linesAdded: 10, linesRemoved: 4, netLinesChanged: 6 },
                    { linesAdded: 5, linesRemoved: 1, netLinesChanged: 4 },
                  ],
                } as never,
                {
                  sessionId: 's2,x', // comma → must be quoted
                  agentName: 'co"de', // quote → must be doubled & quoted
                  provider: 'ai-run-sso',
                  startTime: 1704067200000,
                  duration: 500,
                  totalTurns: 0,
                  models: [],
                  files: [],
                } as never,
              ],
            } as never,
          ],
        } as never,
      ],
    } as unknown as RootAnalytics;
  }

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exporter-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exportJSON writes pretty-printed JSON that round-trips exactly', () => {
    const analytics = fixture();
    const out = join(dir, 'out.json');
    AnalyticsExporter.exportJSON(analytics, out);

    const text = readFileSync(out, 'utf-8');
    // 2-space indentation
    expect(text).toContain('\n  "projects"');
    // Deep-equal round trip
    expect(JSON.parse(text)).toEqual(analytics);
    // Success line printed
    expect(captured()).toContain(`Exported to: ${out}`);
  });

  it('exportCSV produces exact header + rows with correct escaping', () => {
    const out = join(dir, 'out.csv');
    AnalyticsExporter.exportCSV(fixture(), out);

    const text = readFileSync(out, 'utf-8');
    const lines = text.split('\n');

    expect(lines[0]).toBe(
      'Session ID,Agent,Provider,Project,Branch,Start Time,Duration (s),Active Duration (s),Turns,Primary Model,Files Modified,Lines Added,Lines Removed,Net Lines,Cost (USD)'
    );
    // Session 1: duration 65000ms -> 65s, no activeDurationMs/cost -> blank, 2 files, added 15, removed 5, net 10, model 'sonnet'
    expect(lines[1]).toBe(
      's1,claude,ai-run-sso,/repo/a,main,2024-01-01T00:00:00.000Z,65,,3,sonnet,2,15,5,10,'
    );
    // Session 2: comma field quoted, quote field doubled+quoted, no model -> N/A, zeros
    expect(lines[2]).toBe(
      '"s2,x","co""de",ai-run-sso,/repo/a,main,2024-01-01T00:00:00.000Z,0,,0,N/A,0,0,0,0,'
    );
    expect(lines).toHaveLength(3);
  });

  it('exportCSV of an empty analytics still emits the header only', () => {
    const out = join(dir, 'empty.csv');
    AnalyticsExporter.exportCSV({ projects: [] } as unknown as RootAnalytics, out);
    const text = readFileSync(out, 'utf-8');
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('Session ID,Agent,Provider');
  });

  it('exportJSON rethrows and logs when the path is not writable', () => {
    const badPath = join(dir, 'no-such-dir', 'x.json');
    expect(() => AnalyticsExporter.exportJSON(fixture(), badPath)).toThrow();
    expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('Failed to export JSON');
  });

  it('getDefaultOutputPath composes cwd + dated filename per format', () => {
    const j = AnalyticsExporter.getDefaultOutputPath('json', '/x');
    const c = AnalyticsExporter.getDefaultOutputPath('csv', '/x');
    // join() uses '\' on Windows; normalize separators before matching.
    expect(j.replace(/\\/g, '/')).toMatch(/^\/x\/codemie-analytics-\d{4}-\d{2}-\d{2}\.json$/);
    expect(c.replace(/\\/g, '/')).toMatch(/^\/x\/codemie-analytics-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

// ===========================================================================
// conversationIdSafety
// ===========================================================================
describe('isValidConversationId', () => {
  it('accepts letters, digits, hyphen, underscore (1..128 chars)', () => {
    expect(isValidConversationId('abc-123')).toBe(true);
    expect(isValidConversationId('UUID_1-2')).toBe(true);
    expect(isValidConversationId('a')).toBe(true);
    expect(isValidConversationId('a'.repeat(128))).toBe(true);
  });

  it('rejects empty, over-length, and path-control payloads', () => {
    expect(isValidConversationId('')).toBe(false);
    expect(isValidConversationId('a'.repeat(129))).toBe(false);
    expect(isValidConversationId('../etc')).toBe(false);
    expect(isValidConversationId('a/b')).toBe(false);
    expect(isValidConversationId('a\0b')).toBe(false);
    expect(isValidConversationId('has space')).toBe(false);
    expect(isValidConversationId('x.y')).toBe(false);
  });
});

// ===========================================================================
// historyPersister.appendConversationTurn
// ===========================================================================
describe('appendConversationTurn', () => {
  let home: string;
  const prevHome = process.env.CODEMIE_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ch-'));
    process.env.CODEMIE_HOME = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = prevHome;
  });

  function readRecords(id: string): Array<Record<string, unknown>> {
    const p = getSessionConversationPath(id);
    return readFileSync(p, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('writes one turn record with the expected payload shape', async () => {
    await appendConversationTurn('conv1', 'hello', 'hi there', ['a.txt']);

    const records = readRecords('conv1');
    expect(records).toHaveLength(1);
    const r = records[0] as never as {
      payloadId: string;
      historyIndices: number[];
      messageCount: number;
      status: string;
      isTurnContinuation: boolean;
      payload: { conversationId: string; history: Array<Record<string, unknown>> };
    };
    expect(r.payloadId).toBe('cli-conv1-0');
    expect(r.historyIndices).toEqual([0, 1]);
    expect(r.messageCount).toBe(2);
    expect(r.status).toBe('success');
    expect(r.isTurnContinuation).toBe(false);
    expect(r.payload.conversationId).toBe('conv1');

    const [user, assistant] = r.payload.history;
    expect(user).toMatchObject({
      role: 'User',
      message: 'hello',
      message_raw: 'hello',
      history_index: 0,
      file_names: ['a.txt'],
    });
    expect(assistant).toMatchObject({
      role: 'Assistant',
      message: 'hi there',
      history_index: 1,
      file_names: [],
    });
  });

  it('continues history_index across successive appends (0,1 then 2,3)', async () => {
    await appendConversationTurn('conv1', 'first', 'a1');
    await appendConversationTurn('conv1', 'second', 'a2');

    const records = readRecords('conv1');
    expect(records).toHaveLength(2);
    expect((records[0] as never as { historyIndices: number[] }).historyIndices).toEqual([0, 1]);
    expect((records[1] as never as { historyIndices: number[] }).historyIndices).toEqual([2, 3]);
    expect((records[1] as never as { payloadId: string }).payloadId).toBe('cli-conv1-2');
  });

  it('defaults file_names to [] when omitted', async () => {
    await appendConversationTurn('conv2', 'q', 'a');
    const r = readRecords('conv2')[0] as never as {
      payload: { history: Array<{ file_names: string[] }> };
    };
    expect(r.payload.history[0].file_names).toEqual([]);
  });

  it('refuses to write and does not throw for an invalid (traversal) id', async () => {
    await expect(appendConversationTurn('../evil', 'x', 'y')).resolves.toBeUndefined();
    // No file created for the sanitized path target.
    expect(() => readRecords('../evil')).toThrow();
  });
});

// ===========================================================================
// createListCommand
// ===========================================================================
describe('createListCommand', () => {
  function fakeAgent(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      name: 'gemini',
      displayName: 'Gemini CLI',
      description: 'Google Gemini agent',
      metadata: { isBuiltIn: false, npmPackage: '@google/gemini-cli' },
      isInstalled: vi.fn(async () => true),
      getVersion: vi.fn(async () => '1.2.3'),
      ...over,
    };
  }

  it('lists manageable agents with status and version', async () => {
    registryMock.getManageableAgents.mockReturnValue([fakeAgent()]);
    frameworksMock.getAllFrameworks.mockReturnValue([]);

    const cmd = createListCommand();
    await cmd.parseAsync([], { from: 'user' });

    const out = captured();
    expect(out).toContain('Available Agents');
    expect(out).toContain('Gemini CLI');
    expect(out).toContain('installed');
    expect(out).toContain('1.2.3');
    expect(out).toContain('Next Steps');
    expect(registryMock.getManageableAgents).toHaveBeenCalled();
  });

  it('uses installed-agents lookup when --installed is passed', async () => {
    registryMock.getInstalledAgents.mockResolvedValue([]);
    frameworksMock.getAllFrameworks.mockReturnValue([]);

    const cmd = createListCommand();
    await cmd.parseAsync(['--installed'], { from: 'user' });

    expect(registryMock.getInstalledAgents).toHaveBeenCalled();
    expect(registryMock.getManageableAgents).not.toHaveBeenCalled();
  });

  it('renders a frameworks section when frameworks exist', async () => {
    registryMock.getManageableAgents.mockReturnValue([]);
    const fw = {
      metadata: { name: 'superpowers', displayName: 'Superpowers', description: 'fw', docsUrl: 'https://x' },
      isInstalled: vi.fn(async () => true),
      isInitialized: vi.fn(async () => false),
      getVersion: vi.fn(async () => '9.9.9'),
    };
    frameworksMock.getAllFrameworks.mockReturnValue([fw] as never);

    const cmd = createListCommand();
    await cmd.parseAsync([], { from: 'user' });

    const out = captured();
    expect(out).toContain('Available Frameworks');
    expect(out).toContain('Superpowers');
    expect(out).toContain('9.9.9');
    expect(out).toContain('https://x');
  });
});

// ===========================================================================
// createUpdateCommand — spawn is mocked; we only assert the install args.
// ===========================================================================
describe('createUpdateCommand', () => {
  it('updates a specific npm-based agent via installGlobal with force:true', async () => {
    const agent = {
      name: 'gemini',
      displayName: 'Gemini CLI',
      description: 'd',
      metadata: { isBuiltIn: false, npmPackage: '@google/gemini-cli' },
      isInstalled: vi.fn(async () => true),
      getVersion: vi.fn(async () => '1.0.0'),
    };
    registryMock.getAgent.mockReturnValue(agent as never);
    npmMock.getLatestVersion.mockResolvedValue('2.0.0');

    const cmd = createUpdateCommand();
    await cmd.parseAsync(['gemini'], { from: 'user' });

    expect(npmMock.installGlobal).toHaveBeenCalledTimes(1);
    expect(npmMock.installGlobal).toHaveBeenCalledWith('@google/gemini-cli', {
      version: '2.0.0',
      force: true,
    });
  });

  it('does NOT install in --check mode', async () => {
    const agent = {
      name: 'gemini',
      displayName: 'Gemini CLI',
      description: 'd',
      metadata: { isBuiltIn: false, npmPackage: '@google/gemini-cli' },
      isInstalled: vi.fn(async () => true),
      getVersion: vi.fn(async () => '1.0.0'),
    };
    registryMock.getAgent.mockReturnValue(agent as never);
    npmMock.getLatestVersion.mockResolvedValue('2.0.0');

    const cmd = createUpdateCommand();
    await cmd.parseAsync(['gemini', '--check'], { from: 'user' });

    expect(npmMock.installGlobal).not.toHaveBeenCalled();
  });

  it('does NOT install when the agent is already up to date', async () => {
    const agent = {
      name: 'gemini',
      displayName: 'Gemini CLI',
      description: 'd',
      metadata: { isBuiltIn: false, npmPackage: '@google/gemini-cli' },
      isInstalled: vi.fn(async () => true),
      getVersion: vi.fn(async () => '2.0.0'),
    };
    registryMock.getAgent.mockReturnValue(agent as never);
    npmMock.getLatestVersion.mockResolvedValue('2.0.0');

    const cmd = createUpdateCommand();
    await cmd.parseAsync(['gemini'], { from: 'user' });

    expect(npmMock.installGlobal).not.toHaveBeenCalled();
  });
});
