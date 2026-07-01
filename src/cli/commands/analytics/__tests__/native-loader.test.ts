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
      hasOwnershipMarker: () => false,
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
      hasOwnershipMarker: () => false,
    };
    expect(await loadNativeSessions(undefined, deps)).toEqual([]);
  });
});

describe('synthesizeRawSession — /clear sentinel in post-/clear file', () => {
  const desc = { ...descriptor, sessionId: 'clr', filePath: '/logs/clr.jsonl' };
  const assistant = { type: 'assistant', timestamp: '2026-01-01T10:01:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-6' } };
  const clearSentinel = { type: 'user', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } };

  it('strips the /clear sentinel so it does not appear as the opening prompt', () => {
    const p = {
      sessionId: 'clr', agentName: 'claude', metadata: {},
      metrics: { tools: {} },
      messages: [
        clearSentinel,
        { type: 'user', timestamp: '2026-01-01T10:01:00Z', message: { role: 'user', content: 'actual prompt' } },
        assistant,
      ],
    } as never;
    const raw = synthesizeRawSession('claude', desc, p);
    expect(raw.sessionId).toBe('clr');
    expect(raw.deltas[0].userPrompts?.[0].text).toBe('actual prompt');
  });
});

describe('loadNativeSessions — external session labeling', () => {
  const baseDescriptor = {
    sessionId: 'ext-1',
    filePath: '/logs/ext-1.jsonl',
    createdAt: 1000,
    updatedAt: 2000,
    agentName: 'claude',
  };
  const parsedSession = {
    sessionId: 'ext-1',
    agentName: 'claude',
    metadata: {},
    messages: [
      { type: 'assistant', timestamp: '2026-06-08T10:00:00Z', message: { role: 'assistant', model: 'claude-sonnet-4-6' } },
    ],
    metrics: { tools: {} },
  } as never;

  function makeDeps(hasMarker: boolean): NativeLoaderDeps {
    return {
      trackedLogPaths: () => new Set<string>(),
      discover: async () => [{ agentName: 'claude', descriptor: baseDescriptor }],
      parse: async () => parsedSession,
      realPath: (p) => p,
      hasOwnershipMarker: () => hasMarker,
    };
  }

  it('sets provider native-external when marker absent', async () => {
    const results = await loadNativeSessions(undefined, makeDeps(false));
    expect(results).toHaveLength(1);
    expect(results[0].startEvent!.data.provider).toBe('native-external');
  });

  it('keeps provider native when marker present', async () => {
    const results = await loadNativeSessions(undefined, makeDeps(true));
    expect(results).toHaveLength(1);
    expect(results[0].startEvent!.data.provider).toBe('native');
  });
});

describe('synthesizeCodexRawSession', () => {
  it('derives turns from task_complete and carries codex metrics', () => {
    const desc = { sessionId: 'cx', filePath: '/rollout.jsonl', createdAt: 1000, updatedAt: 2000, agentName: 'codex' };
    const p = {
      sessionId: 'cx',
      agentName: 'codex',
      metadata: { projectPath: '/repo', branch: 'main', model: 'gpt-5.4' },
      messages: [
        { timestamp: '2026-06-08T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'fix the bug' } },
        { timestamp: '2026-06-08T10:00:30Z', type: 'event_msg', payload: { type: 'task_complete' } },
        { timestamp: '2026-06-08T10:01:00Z', type: 'event_msg', payload: { type: 'task_complete' } },
      ],
      metrics: {
        tools: { exec_command: 2 },
        toolStatus: { exec_command: { success: 2, failure: 0 } },
        skillInvocations: { brainstorming: 1 },
      },
    } as never;
    const raw = synthesizeRawSession('codex', desc, p);
    expect(raw.deltas).toHaveLength(2);
    expect(raw.deltas[0].userPrompts?.[0].text).toBe('fix the bug');
    expect(raw.deltas[0].skillInvocations).toEqual({ brainstorming: 1 });
    expect(raw.agentSessionFile).toBe('/rollout.jsonl');
  });

  it('routes codemie-codex through the codex synthesizer', () => {
    const desc = { sessionId: 'cmx', filePath: '/rollout.jsonl', createdAt: 1000, updatedAt: 2000, agentName: 'codemie-codex' };
    const p = {
      sessionId: 'cmx',
      agentName: 'codemie-codex',
      metadata: { projectPath: '/repo' },
      messages: [{ timestamp: '2026-06-08T10:00:00Z', type: 'event_msg', payload: { type: 'task_complete' } }],
      metrics: { skillInvocations: { qa: 1 } },
    } as never;
    const raw = synthesizeRawSession('codemie-codex', desc, p);
    expect(raw.startEvent.agentName).toBe('codemie-codex');
    expect(raw.deltas[0].skillInvocations).toEqual({ qa: 1 });
  });
});

describe('loadNativeSessions codex child dedup', () => {
  it('skips native child rollout files referenced by wait_agent targets', async () => {
    const parentMessages = [
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait_agent',
          arguments: '{"targets":["child-uuid"]}',
        },
      },
    ];
    const deps: NativeLoaderDeps = {
      trackedLogPaths: () => new Set(),
      discover: async () => ([
        { agentName: 'codex', descriptor: { sessionId: 'parent-uuid', filePath: '/logs/parent.jsonl', createdAt: 1, agentName: 'codex' } },
        { agentName: 'codex', descriptor: { sessionId: 'child-uuid', filePath: '/logs/child.jsonl', createdAt: 2, agentName: 'codex' } },
      ]),
      parse: async (_agent, filePath) =>
        ({
          sessionId: filePath.includes('parent') ? 'parent-uuid' : 'child-uuid',
          agentName: 'codex',
          metadata: {},
          messages: filePath.includes('parent') ? parentMessages : [{ type: 'event_msg', payload: { type: 'task_complete' } }],
          metrics: { tools: {} },
        } as never),
      realPath: (p) => p,
      hasOwnershipMarker: () => false,
    };
    const out = await loadNativeSessions(undefined, deps);
    expect(out.map((s) => s.sessionId)).toEqual(['parent-uuid']);
  });
});
