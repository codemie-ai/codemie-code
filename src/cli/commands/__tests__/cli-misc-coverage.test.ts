/**
 * cli-misc coverage — pins today's behavior for a handful of small CLI surfaces:
 *
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
// Live-tracked agents read the registry directly; route it to the same mock.
vi.mock('@/utils/npm-registry.js', () => ({
  fetchLatestVersionFromRegistry: (pkg: string) => npmMock.getLatestVersion(pkg),
  resolveRegistry: () => 'https://registry.npmjs.org/',
}));

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

import { isValidConversationId } from '../assistants/chat/conversationIdSafety.js';
import { appendConversationTurn } from '../assistants/chat/historyPersister.js';
import { getSessionConversationPath } from '@/agents/core/session/session-config.js';
import { createListCommand } from '../list.js';
import { createUpdateCommand } from '../update.js';

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
  // The env var wins over every config scope, so these tests never depend on
  // the developer's own versionChecks setting.
  beforeEach(() => {
    process.env.CODEMIE_VERSION_CHECKS_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.CODEMIE_VERSION_CHECKS_ENABLED;
  });

  it('skips a live-tracked agent with a note, and never looks it up, when version checks are disabled', async () => {
    process.env.CODEMIE_VERSION_CHECKS_ENABLED = 'false';
    const agent = {
      name: 'gemini',
      displayName: 'Gemini CLI',
      description: 'd',
      metadata: { isBuiltIn: false, npmPackage: '@google/gemini-cli' },
      isInstalled: vi.fn(async () => true),
      getVersion: vi.fn(async () => '1.0.0'),
    };
    registryMock.getAgent.mockReturnValue(agent as never);

    const cmd = createUpdateCommand();
    await cmd.parseAsync(['gemini'], { from: 'user' });

    expect(captured()).toContain('Version checks are disabled');
    expect(captured()).not.toContain('Could not check');
    expect(spinner.warn).not.toHaveBeenCalled();
    expect(npmMock.getLatestVersion).not.toHaveBeenCalled();
    expect(npmMock.installGlobal).not.toHaveBeenCalled();
  });

  it('explains an empty result instead of "No updatable agents installed" when checks are disabled', async () => {
    process.env.CODEMIE_VERSION_CHECKS_ENABLED = 'false';
    registryMock.getManageableAgents.mockReturnValue([
      {
        name: 'gemini',
        displayName: 'Gemini CLI',
        metadata: { isBuiltIn: false, npmPackage: '@google/gemini-cli' },
        isInstalled: vi.fn(async () => true),
        getVersion: vi.fn(async () => '1.0.0'),
      },
    ] as never);

    const cmd = createUpdateCommand();
    await cmd.parseAsync([], { from: 'user' });

    expect(spinner.info).toHaveBeenCalledWith(expect.stringContaining('version checks are disabled'));
    expect(spinner.info).not.toHaveBeenCalledWith('No updatable agents installed');
    expect(npmMock.getLatestVersion).not.toHaveBeenCalled();
  });

  // Each test below uses its own package name so earlier tests' cache entries can't satisfy it.
  function liveTrackedAgent(npmPackage: string, installed = '1.0.0'): Record<string, unknown> {
    return {
      name: 'codex',
      displayName: 'OpenAI Codex CLI',
      description: 'd',
      metadata: { isBuiltIn: false, npmPackage, supportedVersion: '9.9.9' },
      isInstalled: vi.fn(async () => true),
      getVersion: vi.fn(async () => installed),
      installVersion: vi.fn(async () => '9.9.9'),
    };
  }

  it('reports an installed agent whose lookup failed instead of "No updatable agents installed"', async () => {
    registryMock.getManageableAgents.mockReturnValue([liveTrackedAgent('@codemie-test/all-offline')] as never);
    npmMock.getLatestVersion.mockResolvedValue(null);

    await createUpdateCommand().parseAsync([], { from: 'user' });

    expect(captured()).toContain('Could not check OpenAI Codex CLI for updates');
    expect(spinner.info).not.toHaveBeenCalledWith('No updatable agents installed');
  });

  it('reports the built-in agent whose CLI lookup failed instead of "No updatable agents installed"', async () => {
    registryMock.getManageableAgents.mockReturnValue([
      {
        name: 'codemie-code',
        displayName: 'CodeMie Code',
        description: 'd',
        metadata: { isBuiltIn: true, npmPackage: null },
        isInstalled: vi.fn(async () => true),
        getVersion: vi.fn(async () => '1.0.0'),
      },
    ] as never);
    npmMock.getLatestVersion.mockResolvedValue(null);

    await createUpdateCommand().parseAsync([], { from: 'user' });

    expect(captured()).toContain('Could not check CodeMie Code for updates');
    expect(spinner.info).not.toHaveBeenCalledWith('No updatable agents installed');
  });

  it('lists the agents it could check and reports the one whose lookup failed', async () => {
    const opencode = {
      name: 'opencode',
      displayName: 'OpenCode',
      description: 'd',
      metadata: { isBuiltIn: false, npmPackage: 'opencode-ai' },
      isInstalled: vi.fn(async () => true),
      getVersion: vi.fn(async () => '1.0.0'),
    };
    registryMock.getManageableAgents.mockReturnValue([
      opencode,
      liveTrackedAgent('@codemie-test/mixed-offline'),
    ] as never);
    npmMock.getLatestVersion.mockImplementation(async (pkg: string) => (pkg === 'opencode-ai' ? '2.0.0' : null));

    await createUpdateCommand().parseAsync(['--check'], { from: 'user' });

    const output = captured();
    expect(output).toContain('OpenCode');
    expect(output).toContain('2.0.0');
    expect(output).toContain('Could not check OpenAI Codex CLI for updates');
    expect(npmMock.installGlobal).not.toHaveBeenCalled();
  });

  it('never offers the hardcoded fallback as an update when the live lookup fails', async () => {
    const agent = liveTrackedAgent('@codemie-test/lookup-fails');
    registryMock.getAgent.mockReturnValue(agent as never);
    npmMock.getLatestVersion.mockResolvedValue(null);

    const cmd = createUpdateCommand();
    await cmd.parseAsync(['codex'], { from: 'user' });

    expect(spinner.warn).toHaveBeenCalledWith('Could not check OpenAI Codex CLI for updates');
    expect(npmMock.installGlobal).not.toHaveBeenCalled();
    expect(agent.installVersion).not.toHaveBeenCalled();
  });

  it('queries the registry on every explicit check, bypassing a fresh cache entry', async () => {
    registryMock.getAgent.mockReturnValue(liveTrackedAgent('@codemie-test/cached') as never);
    npmMock.getLatestVersion.mockResolvedValue('2.0.0');
    await createUpdateCommand().parseAsync(['codex', '--check'], { from: 'user' });

    // A release published after the first check must be seen right away, not after 24h.
    npmMock.getLatestVersion.mockResolvedValue('3.0.0');
    await createUpdateCommand().parseAsync(['codex', '--check'], { from: 'user' });

    expect(npmMock.getLatestVersion).toHaveBeenCalledTimes(2);
    expect(spinner.succeed).toHaveBeenLastCalledWith(expect.stringContaining('3.0.0'));
  });

  it('updates a specific npm-based agent via installGlobal with force:true', async () => {
    const agent = {
      name: 'gemini',
      displayName: 'Gemini CLI',
      description: 'd',
      metadata: { isBuiltIn: false, npmPackage: '@google/gemini-cli' },
      isInstalled: vi.fn(async () => true),
      getVersion: vi.fn(async () => '1.0.0'),
      warnOnceIfUntested: vi.fn(async () => undefined),
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

  it('updates Claude to the exact version it offered, through its own installer, not npm', async () => {
    const agent = {
      name: 'claude',
      displayName: 'Claude Code',
      description: 'd',
      metadata: { isBuiltIn: false, npmPackage: '@codemie-test/claude-update', supportedVersion: '1.0.0' },
      isInstalled: vi.fn(async () => true),
      getVersion: vi.fn(async () => '1.5.0 (Claude Code)'),
      installVersion: vi.fn(async () => '2.0.0'),
      warnOnceIfUntested: vi.fn(async () => undefined),
    };
    registryMock.getAgent.mockReturnValue(agent as never);
    npmMock.getLatestVersion.mockResolvedValue('2.0.0');

    await createUpdateCommand().parseAsync(['claude'], { from: 'user' });

    // The version the check displayed — not 'supported' re-resolved through the cache.
    expect(agent.installVersion).toHaveBeenCalledWith('2.0.0');
    expect(npmMock.installGlobal).not.toHaveBeenCalled();
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
