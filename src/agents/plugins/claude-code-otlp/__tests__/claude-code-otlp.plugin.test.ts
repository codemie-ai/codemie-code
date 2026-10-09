import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../claude-code-otlp.allowlist.js', () => ({
  readAllowlistState: vi.fn(async () => ({ kind: 'valid', paths: ['/proj'] })),
  isProjectTracked: vi.fn(),
}));
vi.mock('@/utils/processes.js', () => ({
  detectGitBranch: vi.fn(async () => 'main'),
  detectGitRemoteRepo: vi.fn(async () => 'org/repo'),
}));
vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn() }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn(async () => ({})), getActiveProfileName: vi.fn(async () => null) },
}));
vi.mock('@/agents/core/hook-credentials.js', () => ({ resolveHookCredentials: vi.fn(async () => null) }));
vi.mock('@/utils/cli-updater.js', () => ({ getCurrentCliVersion: vi.fn(async () => '9.9.9') }));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const resolveClientVersionMock = vi.fn();
const collectMainTranscriptEventsMock = vi.fn();
const collectSubagentTranscriptEventsMock = vi.fn();
const subagentNeedsBackstopMock = vi.fn();
const findSubagentFilesMock = vi.fn();
const readSubagentMetaMock = vi.fn();

vi.mock('../client-version-cache.js', () => ({
  resolveClientVersion: resolveClientVersionMock,
}));

vi.mock('../transcript/orchestrator.js', () => ({
  collectMainTranscriptEvents: collectMainTranscriptEventsMock,
  collectSubagentTranscriptEvents: collectSubagentTranscriptEventsMock,
  subagentNeedsBackstop: subagentNeedsBackstopMock,
}));

vi.mock('../transcript/subagent-usage.js', () => ({
  findSubagentFiles: findSubagentFilesMock,
  readSubagentMeta: readSubagentMetaMock,
}));

import { isProjectTracked } from '../claude-code-otlp.allowlist.js';
import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';

// Deferred past the mock-backing consts above: a static import of the plugin would be
// hoisted ahead of them (ESM import hoisting), tripping a TDZ error inside the
// transcript/orchestrator.js mock factory, which closes over those consts.
const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

const forwardOtlpEventToSpool = vi.fn(async (_event: Record<string, unknown>, _agentName: string) => {});

const event = (name: string) => JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: name });

describe('ClaudeCodeOtlpPlugin.processOtlpEvent', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    resolveClientVersionMock.mockResolvedValue('2.1.23');
  });

  it('does nothing for untracked projects, for every event', async () => {
    vi.mocked(isProjectTracked).mockResolvedValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      await plugin.processOtlpEvent(event(name), { ensureOtlpProxy, forwardOtlpEventToSpool });
    }
    expect(ensureOtlpProxy).not.toHaveBeenCalled();
    expect(ensureCodeMieSsoAuth).not.toHaveBeenCalled();
    expect(forwardOtlpEventToSpool).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('ensures the proxy before forwarding for tracked projects', async () => {
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    await plugin.processOtlpEvent(event('SessionStart'), { ensureOtlpProxy, forwardOtlpEventToSpool });
    expect(ensureOtlpProxy).toHaveBeenCalledTimes(1);
    expect(forwardOtlpEventToSpool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureOtlpProxy).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(forwardOtlpEventToSpool).mock.invocationCallOrder[0]
    );
  });
});

describe('ClaudeCodeOtlpPlugin hook-time enrichment', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});
  const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;

  function hookEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      session_id: 'sid-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/repo',
      hook_event_name: 'Stop',
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    collectMainTranscriptEventsMock.mockResolvedValue([]);
    collectSubagentTranscriptEventsMock.mockResolvedValue([]);
    subagentNeedsBackstopMock.mockResolvedValue(true);
    findSubagentFilesMock.mockResolvedValue([]);
    readSubagentMetaMock.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalEntrypoint === undefined) {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    } else {
      process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint;
    }
  });

  it('enriches the forwarded event with platform, entrypoint, and client_version', async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const rawEvent = JSON.stringify(hookEvent());

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    expect(forwardOtlpEventToSpool).toHaveBeenCalledTimes(1);
    const [forwarded] = vi.mocked(forwardOtlpEventToSpool).mock.calls[0];
    expect(forwarded.platform).toBe('claude-code');
    expect(forwarded.entrypoint).toBe('cli');
    expect(forwarded.client_version).toBe('2.1.23');
  });

  it('stamps git_branch and repo_remote resolved at hook time', async () => {
    await plugin.processOtlpEvent(JSON.stringify(hookEvent()), { ensureOtlpProxy, forwardOtlpEventToSpool });

    const [forwarded] = vi.mocked(forwardOtlpEventToSpool).mock.calls[0];
    expect(forwarded.git_branch).toBe('main');
    expect(forwarded.repo_remote).toBe('org/repo');
  });

  it('preserves agent_id/agent_type already present on the raw event (SubagentStop)', async () => {
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-1.jsonl',
        agent_id: 'sub-1',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    const [forwarded] = vi.mocked(forwardOtlpEventToSpool).mock.calls[0];
    expect(forwarded.agent_id).toBe('sub-1');
    expect(forwarded.agent_type).toBe('explore');
  });
});

describe('ClaudeCodeOtlpPlugin.processOtlpEvent dispatch', () => {
  const ensureOtlpProxy = vi.fn(async () => {});

  function hookEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      session_id: 'sid-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/repo',
      hook_event_name: 'Stop',
      ...overrides,
    };
  }

  beforeEach(() => {
    collectMainTranscriptEventsMock.mockReset();
    collectMainTranscriptEventsMock.mockResolvedValue([]);
    collectSubagentTranscriptEventsMock.mockReset();
    collectSubagentTranscriptEventsMock.mockResolvedValue([]);
    subagentNeedsBackstopMock.mockReset();
    subagentNeedsBackstopMock.mockResolvedValue(true);
    findSubagentFilesMock.mockReset();
    findSubagentFilesMock.mockResolvedValue([]);
    readSubagentMetaMock.mockReset();
    readSubagentMetaMock.mockResolvedValue({});
    resolveClientVersionMock.mockReset();
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    vi.mocked(forwardOtlpEventToSpool).mockReset();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['Stop', 'PreCompact', 'SessionEnd', 'StopFailure'] as const)(
    'invokes collectMainTranscriptEvents with the extracted session/transcript/trigger on %s',
    async (hookEventName) => {
      const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
      const plugin = new ClaudeCodeOtlpPlugin();
      const parsedEvent = hookEvent({ hook_event_name: hookEventName });
      const rawEvent = JSON.stringify(parsedEvent);

      await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

      expect(collectMainTranscriptEventsMock).toHaveBeenCalledWith(
        'sid-1',
        '/tmp/transcript.jsonl',
        hookEventName
      );
      expect(forwardOtlpEventToSpool).toHaveBeenCalledWith(
        expect.objectContaining(parsedEvent),
        'claude-code-otlp'
      );
    }
  );

  it('does not dispatch collectMainTranscriptEvents for unrelated hook events', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'PostToolUse' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    expect(collectMainTranscriptEventsMock).not.toHaveBeenCalled();
  });

  it('invokes collectSubagentTranscriptEvents with the agent_id/tool_use_id/agent_type extracted from a SubagentStop payload', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-1.jsonl',
        agent_id: 'sub-1',
        tool_use_id: 'tu-1',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledWith('sid-1', {
      agentId: 'sub-1',
      filePath: '/tmp/agent-sub-1.jsonl',
      toolUseId: 'tu-1',
      agentType: 'explore',
    });
  });

  it('derives agent_id from the sidecar filename on SubagentStop when agent_id is absent', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-2.jsonl',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledWith(
      'sid-1',
      expect.objectContaining({ agentId: 'sub-2' })
    );
  });

  it('fills tool_use_id/spawn_depth/description from the .meta.json sidecar on SubagentStop', async () => {
    readSubagentMetaMock.mockResolvedValue({ toolUseId: 'tu-sidecar', spawnDepth: 2, description: 'task' });
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-3.jsonl',
        agent_id: 'sub-3',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    expect(readSubagentMetaMock).toHaveBeenCalledWith('/tmp/agent-sub-3.jsonl');
    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledWith('sid-1', {
      agentId: 'sub-3',
      filePath: '/tmp/agent-sub-3.jsonl',
      toolUseId: 'tu-sidecar',
      agentType: 'explore',
      spawnDepth: 2,
      description: 'task',
    });
  });

  it('skips collectSubagentTranscriptEvents on SubagentStop when agent_transcript_path is missing', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'SubagentStop', agent_type: 'explore' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    expect(collectSubagentTranscriptEventsMock).not.toHaveBeenCalled();
  });

  it('skips SubagentStop entirely (no forward, no derive) when agent_type is empty', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-4.jsonl',
        agent_type: '',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    expect(collectSubagentTranscriptEventsMock).not.toHaveBeenCalled();
    expect(forwardOtlpEventToSpool).not.toHaveBeenCalled();
  });

  it('runs collectSubagentTranscriptEvents for every subagent file found on SessionEnd that still needs the backstop', async () => {
    findSubagentFilesMock.mockResolvedValue([
      { agentId: 'sub-1', filePath: '/tmp/agent-sub-1.jsonl' },
      { agentId: 'sub-2', filePath: '/tmp/agent-sub-2.jsonl' },
    ]);
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'SessionEnd' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    expect(findSubagentFilesMock).toHaveBeenCalledWith('/tmp/transcript.jsonl');
    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledTimes(2);
    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledWith(
      'sid-1',
      { agentId: 'sub-1', filePath: '/tmp/agent-sub-1.jsonl' }
    );
  });

  it('skips a subagent on the SessionEnd backstop when it no longer needs re-processing', async () => {
    findSubagentFilesMock.mockResolvedValue([
      { agentId: 'reported', filePath: '/tmp/agent-reported.jsonl' },
      { agentId: 'pending', filePath: '/tmp/agent-pending.jsonl' },
    ]);
    subagentNeedsBackstopMock.mockImplementation(async (_sessionId: string, file: { agentId: string }) =>
      file.agentId !== 'reported'
    );
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'SessionEnd' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledTimes(1);
    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledWith(
      'sid-1',
      { agentId: 'pending', filePath: '/tmp/agent-pending.jsonl' }
    );
  });

  it('forwards every event a per-event handler returns (the raw event plus any derived events) through the single forwardToSpool path, in order', async () => {
    const derivedUsageEvent = { type: 'agent.usage.request' };
    const derivedSummaryEvent = { type: 'agent.session.summary' };
    collectMainTranscriptEventsMock.mockResolvedValue([derivedUsageEvent, derivedSummaryEvent]);

    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const parsedEvent = hookEvent({ hook_event_name: 'Stop' });
    const rawEvent = JSON.stringify(parsedEvent);

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventToSpool });

    // collectMainTranscriptEvents/collectSubagentTranscriptEvents never call forwardOtlpEventToSpool
    // themselves (they are mocked here to just return data) — every event that reaches the spool
    // mock arrived via forwardToSpool, called exactly once from processOtlpEvent.
    expect(forwardOtlpEventToSpool).toHaveBeenCalledTimes(3);
    expect(vi.mocked(forwardOtlpEventToSpool).mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining(parsedEvent),
      expect.objectContaining(derivedUsageEvent),
      expect.objectContaining(derivedSummaryEvent),
    ]);
  });

  it('rejects when rawEvent is malformed JSON', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();

    await expect(plugin.processOtlpEvent('not json', { ensureOtlpProxy, forwardOtlpEventToSpool })).rejects.toThrow();
  });
});

describe('ClaudeCodeOtlpPlugin wire type', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    collectMainTranscriptEventsMock.mockResolvedValue([]);
    collectSubagentTranscriptEventsMock.mockResolvedValue([]);
    findSubagentFilesMock.mockResolvedValue([]);
  });

  const typeFor = async (name: string): Promise<unknown> => {
    // A SubagentStop with no agent_type is Claude Code's own internal check-in, never
    // forwarded (see the `claude-code-otlp.plugin.ts` guard) — give it one here so this
    // generic wire-type matrix still exercises its mapping, like every other hook name.
    const raw =
      name === 'SubagentStop'
        ? JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: name, agent_type: 'explore' })
        : event(name);
    await plugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventToSpool });
    return vi.mocked(forwardOtlpEventToSpool).mock.calls[0][0]['type'];
  };

  it.each([
    ['SessionStart', 'agent.session.start'],
    ['Stop', 'agent.session.stop'],
    ['StopFailure', 'agent.turn.error'],
    ['SessionEnd', 'agent.session.end'],
    ['PreToolUse', 'agent.tool.start'],
    ['PostToolUse', 'agent.tool.end'],
    ['PostToolUseFailure', 'agent.tool.error'],
    ['SubagentStart', 'agent.subagent.start'],
    ['SubagentStop', 'agent.subagent.stop'],
    ['PreCompact', 'agent.session.compact'],
    ['Notification', 'agent.notification'],
  ])('maps %s to %s', async (hookName, expectedType) => {
    expect(await typeFor(hookName)).toBe(expectedType);
  });

  it('maps UserPromptSubmit to agent.prompt.submit', async () => {
    vi.mocked(ensureCodeMieSsoAuth).mockResolvedValue({ ok: true } as never);
    await plugin.processOtlpEvent(
      JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      { ensureOtlpProxy, forwardOtlpEventToSpool }
    );
    expect(vi.mocked(forwardOtlpEventToSpool).mock.calls[0][0]['type']).toBe('agent.prompt.submit');
  });

  it('falls back to agent.event for an unmapped hook name', () => {
    const resolve = (plugin as unknown as { resolveEventType(e: Record<string, unknown>): string }).resolveEventType;
    expect(resolve.call(plugin, { hook_event_name: 'SomethingNew' })).toBe('agent.event');
    expect(resolve.call(plugin, {})).toBe('agent.event');
  });

  it('keeps the explicit type of a derived event', async () => {
    collectMainTranscriptEventsMock.mockResolvedValue([{ type: 'agent.usage.request', session_id: 's' }]);
    await plugin.processOtlpEvent(event('Stop'), { ensureOtlpProxy, forwardOtlpEventToSpool });
    const types = vi.mocked(forwardOtlpEventToSpool).mock.calls.map(([record]) => record['type']);
    expect(types).toEqual(['agent.session.stop', 'agent.usage.request']);
  });
});
