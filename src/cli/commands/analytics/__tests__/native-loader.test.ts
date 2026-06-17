/**
 * Native session discovery + synthesis unit tests (dependency-injected — no fs/registry).
 */

import { describe, it, expect } from 'vitest';
import { synthesizeRawSession, loadNativeSessions, type NativeLoaderDeps } from '../native-loader.js';

const parsed = {
  sessionId: 'sx',
  agentName: 'claude',
  metadata: {},
  messages: [
    { type: 'user', timestamp: '2026-06-08T10:00:00Z', cwd: '/repo/app', gitBranch: 'main' },
    { type: 'assistant', timestamp: '2026-06-08T10:01:00Z', cwd: '/repo/app', gitBranch: 'main', message: { role: 'assistant', model: 'claude-sonnet-4-6' } },
    { type: 'assistant', timestamp: '2026-06-08T10:05:00Z', cwd: '/repo/app', gitBranch: 'feat/x', message: { role: 'assistant', model: 'claude-sonnet-4-6' } },
  ],
  metrics: {
    tools: { Read: 2, Edit: 1 },
    toolStatus: { Read: { success: 2, failure: 0 } },
    fileOperations: [{ type: 'edit', path: 'a.ts', linesAdded: 5 }],
  },
} as never;

const descriptor = {
  sessionId: 'sx',
  filePath: '/logs/sx.jsonl',
  projectPath: '/decoded/hint',
  createdAt: 1000,
  updatedAt: 2000,
  agentName: 'claude',
};

describe('synthesizeRawSession', () => {
  it('maps a parsed native session into RawSessionData', () => {
    const raw = synthesizeRawSession('claude', descriptor, parsed);
    expect(raw.sessionId).toBe('sx');
    expect(raw.agentSessionFile).toBe('/logs/sx.jsonl'); // lets the enricher price it
    // real cwd from messages wins over the lossy decoded descriptor hint
    expect(raw.startEvent!.data.workingDirectory).toBe('/repo/app');
    expect(raw.startEvent!.agentName).toBe('claude');
    expect(raw.startEvent!.data.provider).toBe('native');
    // turns = assistant messages; aggregator derives totalTurns from deltas.length
    expect(raw.deltas).toHaveLength(2);
    expect(raw.endEvent!.data.totalTurns).toBe(2);
    // all metrics carried on the first delta
    expect(raw.deltas[0].tools).toEqual({ Read: 2, Edit: 1 });
    expect(raw.deltas[0].models).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-6']);
    expect(raw.deltas[0].fileOperations).toEqual([{ type: 'edit', path: 'a.ts', linesAdded: 5 }]);
    // modal branch (main x2 vs feat/x x1)
    expect(raw.deltas[0].gitBranch).toBe('main');
    // timestamps from messages
    expect(raw.startEvent!.data.startTime).toBe(Date.parse('2026-06-08T10:00:00Z'));
    expect(raw.endEvent!.data.endTime).toBe(Date.parse('2026-06-08T10:05:00Z'));
  });

  it('carries named invocations (skill/agent/command) from parsed.metrics onto the first delta', () => {
    const withNames = {
      ...parsed,
      metrics: {
        ...parsed.metrics,
        skillInvocations: { 'codemie:msgraph': 2 },
        agentInvocations: { Explore: 1 },
        commandInvocations: { analytics: 3 },
      },
    } as never;
    const raw = synthesizeRawSession('claude', descriptor, withNames);
    expect(raw.deltas[0].skillInvocations).toEqual({ 'codemie:msgraph': 2 });
    expect(raw.deltas[0].agentInvocations).toEqual({ Explore: 1 });
    expect(raw.deltas[0].commandInvocations).toEqual({ analytics: 3 });
  });

  it('omits named-invocation fields when parsed.metrics has none', () => {
    const raw = synthesizeRawSession('claude', descriptor, parsed);
    expect(raw.deltas[0].skillInvocations).toBeUndefined();
    expect(raw.deltas[0].agentInvocations).toBeUndefined();
    expect(raw.deltas[0].commandInvocations).toBeUndefined();
  });

  it('falls back to descriptor when messages lack cwd/timestamps', () => {
    const bare = { sessionId: 'b', agentName: 'claude', metadata: {}, messages: [], metrics: {} } as never;
    const raw = synthesizeRawSession('claude', { ...descriptor, sessionId: 'b' }, bare);
    expect(raw.startEvent!.data.workingDirectory).toBe('/decoded/hint');
    expect(raw.startEvent!.data.startTime).toBe(1000); // descriptor.createdAt
    expect(raw.deltas).toHaveLength(1); // turns floored at 1
  });
});

describe('synthesizeRawSession — opening prompt (native session-title source)', () => {
  function parsedWith(messages: unknown[]): never {
    return { sessionId: 'op', agentName: 'claude', metadata: {}, messages, metrics: { tools: {} } } as never;
  }
  const desc = { ...descriptor, sessionId: 'op' };
  const assistant = { type: 'assistant', timestamp: '2026-06-08T10:00:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-6' } };

  it('captures the first string-content user message as the opening prompt', () => {
    const raw = synthesizeRawSession('claude', desc, parsedWith([
      { type: 'user', message: { role: 'user', content: 'add a dark mode toggle' } },
      assistant,
    ]));
    expect(raw.deltas[0].userPrompts).toEqual([{ count: 1, text: 'add a dark mode toggle' }]);
  });

  it('captures the first text block from an array-content user message', () => {
    const raw = synthesizeRawSession('claude', desc, parsedWith([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the failing build' }] } },
      assistant,
    ]));
    expect(raw.deltas[0].userPrompts).toEqual([{ count: 1, text: 'fix the failing build' }]);
  });

  it('skips a tool_result user message and uses the next real user prompt', () => {
    const raw = synthesizeRawSession('claude', desc, parsedWith([
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'cmd output' }] } },
      assistant,
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'now refactor the enricher' }] } },
    ]));
    expect(raw.deltas[0].userPrompts).toEqual([{ count: 1, text: 'now refactor the enricher' }]);
  });

  it('omits userPrompts when there is no user text (assistant-only / empty messages)', () => {
    const raw = synthesizeRawSession('claude', desc, parsedWith([assistant]));
    expect(raw.deltas[0].userPrompts).toBeUndefined();
  });
});

describe('loadNativeSessions', () => {
  it('skips logs already tracked by CodeMie and synthesizes the rest', async () => {
    const deps: NativeLoaderDeps = {
      trackedLogPaths: () => new Set(['/logs/tracked.jsonl']),
      discover: async () => [
        { agentName: 'claude', descriptor: { sessionId: 'tracked', filePath: '/logs/tracked.jsonl', createdAt: 1, agentName: 'claude' } },
        { agentName: 'claude', descriptor: { sessionId: 'fresh', filePath: '/logs/fresh.jsonl', createdAt: 2, agentName: 'claude' } },
      ],
      parse: async (_agent, filePath, sessionId) =>
        ({
          sessionId,
          agentName: 'claude',
          metadata: {},
          messages: [{ type: 'assistant', timestamp: '2026-06-08T10:00:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-6' } }],
          metrics: { tools: {} },
        }) as never,
      realPath: (p) => p,
    };
    const out = await loadNativeSessions(undefined, deps);
    expect(out.map((s) => s.sessionId)).toEqual(['fresh']); // tracked one deduped out
    expect(out[0].agentSessionFile).toBe('/logs/fresh.jsonl');
  });

  it('drops sessions whose log fails to parse', async () => {
    const deps: NativeLoaderDeps = {
      trackedLogPaths: () => new Set(),
      discover: async () => [
        { agentName: 'claude', descriptor: { sessionId: 'bad', filePath: '/logs/bad.jsonl', createdAt: 1, agentName: 'claude' } },
      ],
      parse: async () => null,
      realPath: (p) => p,
    };
    expect(await loadNativeSessions(undefined, deps)).toEqual([]);
  });
});
