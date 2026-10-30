/**
 * `lastRecordAt` of each transcript adapter's `processSession`: the latest record time, and with
 * `recordsBeforeMs` (the start of a later run over the same transcript) the latest one before it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionAdapter } from '../BaseSessionAdapter.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const SESSION_ID = '00000000-0000-4000-8000-0000000000bb';
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T10:05:00.000Z';
const T3 = '2026-10-01T10:30:00.000Z';

let root: string;
const previousHome = process.env.CODEMIE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'last-record-at-'));
  process.env.CODEMIE_HOME = join(root, 'codemie');
  mkdirSync(join(root, 'codemie', 'sessions'), { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: unknown[]): string {
  const path = join(root, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

interface Case {
  agent: string;
  adapter: () => Promise<SessionAdapter>;
  transcript: () => string;
}

const cases: Case[] = [
  {
    agent: 'claude',
    adapter: async () => {
      const { ClaudeSessionAdapter } = await import('../../../plugins/claude/claude.session.js');
      const { ClaudePluginMetadata } = await import('../../../plugins/claude/claude.plugin.js');
      return new ClaudeSessionAdapter(ClaudePluginMetadata);
    },
    transcript: () => writeJsonl('claude.jsonl', [T1, T2, T3].map((timestamp, i) => ({
      type: i % 2 === 0 ? 'user' : 'assistant',
      uuid: `msg-${i}`,
      sessionId: 'claude-native',
      timestamp,
      message: i % 2 === 0
        ? { role: 'user', content: `prompt ${i}` }
        : { role: 'assistant', id: `api-${i}`, content: [{ type: 'text', text: 'reply' }], usage: { input_tokens: 1, output_tokens: 1 } },
    }))),
  },
  {
    agent: 'codex',
    adapter: async () => {
      const { CodexSessionAdapter } = await import('../../../plugins/codex/codex.session.js');
      const { CodexPluginMetadata } = await import('../../../plugins/codex/codex.plugin.js');
      return new CodexSessionAdapter(CodexPluginMetadata);
    },
    transcript: () => writeJsonl('rollout.jsonl', [
      { timestamp: T1, type: 'session_meta', payload: { id: 'codex-native', cwd: root, timestamp: T1, cli_version: '0.1.0' } },
      { timestamp: T2, type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
      { timestamp: T3, type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } },
    ]),
  },
  {
    agent: 'pi',
    adapter: async () => {
      const { PiSessionAdapter } = await import('../../../plugins/pi/pi.session.js');
      const { PiPluginMetadata } = await import('../../../plugins/pi/pi.plugin.js');
      return new PiSessionAdapter(PiPluginMetadata);
    },
    transcript: () => writeJsonl('pi.jsonl', [
      { type: 'session', version: 3, id: 'pi-native', timestamp: T1, cwd: root },
      { type: 'message', id: 'm1', parentId: null, timestamp: T2, message: { role: 'user', content: 'hi', timestamp: Date.parse(T2) } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: T3, message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], timestamp: Date.parse(T3) } },
    ]),
  },
  {
    agent: 'copilot-cli',
    adapter: async () => {
      const { CopilotCliSessionAdapter } = await import('../../../plugins/copilot-cli/copilot-cli.session.js');
      const { CopilotCliPluginMetadata } = await import('../../../plugins/copilot-cli/copilot-cli.plugin.js');
      return new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    },
    transcript: () => writeJsonl('events.jsonl', [
      { type: 'session.start', timestamp: T1, data: { sessionId: 'copilot-native', context: { cwd: root } } },
      { type: 'user.message', timestamp: T2, data: { content: 'hi' } },
      { type: 'assistant.message', timestamp: T3, data: { content: 'hello' } },
    ]),
  },
  {
    agent: 'gemini',
    adapter: async () => {
      const { GeminiSessionAdapter } = await import('../../../plugins/gemini/gemini.session-adapter.js');
      const { GeminiPluginMetadata } = await import('../../../plugins/gemini/gemini.plugin.js');
      return new GeminiSessionAdapter(GeminiPluginMetadata);
    },
    transcript: () => {
      const path = join(root, 'session-gemini.json');
      writeFileSync(path, JSON.stringify({
        sessionId: 'gemini-native',
        projectHash: 'hash',
        startTime: T1,
        lastUpdated: T3,
        messages: [
          { id: 'g1', timestamp: T1, type: 'user', content: 'hi' },
          { id: 'g2', timestamp: T2, type: 'gemini', content: 'hello' },
          { id: 'g3', timestamp: T3, type: 'user', content: 'more' },
        ],
      }));
      return path;
    },
  },
];

function context(recordsBeforeMs?: number) {
  return {
    sessionId: SESSION_ID,
    agentSessionId: 'native',
    apiBaseUrl: '',
    cookies: '',
    clientType: 'codemie-cli',
    version: '0.0.0',
    dryRun: true,
    ...(recordsBeforeMs !== undefined && { recordsBeforeMs }),
  } as never;
}

describe('lastRecordAt', () => {
  it.each(cases)('$agent: the last record, or the last one before recordsBeforeMs', async ({ adapter, transcript }) => {
    const path = transcript();
    const sessionAdapter = await adapter();

    const unbounded = await sessionAdapter.processSession(path, SESSION_ID, context());
    const bounded = await sessionAdapter.processSession(path, SESSION_ID, context(Date.parse(T3)));

    expect(unbounded.lastRecordAt).toBe(Date.parse(T3));
    expect(bounded.lastRecordAt).toBe(Date.parse(T2));
  });
});
