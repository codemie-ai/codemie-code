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
const openMainTranscriptPassMock = vi.fn();
const openSubagentPassMock = vi.fn();
const openSessionEndPassMock = vi.fn();
const readSubagentMetaMock = vi.fn();

vi.mock('../client-version-cache.js', () => ({
  resolveClientVersion: resolveClientVersionMock,
}));

vi.mock('../transcript/orchestrator.js', () => ({
  openMainTranscriptPass: openMainTranscriptPassMock,
  openSubagentPass: openSubagentPassMock,
  openSessionEndPass: openSessionEndPassMock,
}));

vi.mock('../transcript/subagent-usage.js', () => ({
  readSubagentMeta: readSubagentMetaMock,
}));

import { isProjectTracked } from '../claude-code-otlp.allowlist.js';
import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';

// Deferred past the mock-backing consts above: a static import of the plugin would be
// hoisted ahead of them (ESM import hoisting), tripping a TDZ error inside the
// transcript/orchestrator.js mock factory, which closes over those consts.
const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

const forwardOtlpEventsToSpool = vi.fn(async (_events: Record<string, unknown>[], _agentName: string) => true);

const event = (name: string) => JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: name });

/** A pass with no derived events and a no-op finalize — the default "nothing to add" stub. */
function emptyPass(): { events: Record<string, unknown>[]; finalize: ReturnType<typeof vi.fn> } {
  return { events: [], finalize: vi.fn(async () => {}) };
}

/** Every event sent in the batch call (there is at most one call per processOtlpEvent). */
function forwardedEvents(): Record<string, unknown>[] {
  return vi.mocked(forwardOtlpEventsToSpool).mock.calls[0]?.[0] ?? [];
}

describe('ClaudeCodeOtlpPlugin.processOtlpEvent', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
  });

  it('does nothing for untracked projects, for every event', async () => {
    vi.mocked(isProjectTracked).mockResolvedValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      await plugin.processOtlpEvent(event(name), { ensureOtlpProxy, forwardOtlpEventsToSpool });
    }
    expect(ensureOtlpProxy).not.toHaveBeenCalled();
    expect(ensureCodeMieSsoAuth).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('ensures the proxy before forwarding for tracked projects', async () => {
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    await plugin.processOtlpEvent(event('SessionStart'), { ensureOtlpProxy, forwardOtlpEventsToSpool });
    expect(ensureOtlpProxy).toHaveBeenCalledTimes(1);
    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureOtlpProxy).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(forwardOtlpEventsToSpool).mock.invocationCallOrder[0]
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
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    openMainTranscriptPassMock.mockResolvedValue(emptyPass());
    openSubagentPassMock.mockResolvedValue(emptyPass());
    openSessionEndPassMock.mockResolvedValue(emptyPass());
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

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
    const [forwarded] = forwardedEvents();
    expect(forwarded.platform).toBe('claude-code');
    expect(forwarded.entrypoint).toBe('cli');
    expect(forwarded.client_version).toBe('2.1.23');
  });

  it('stamps git_branch and repo_remote resolved at hook time', async () => {
    await plugin.processOtlpEvent(JSON.stringify(hookEvent()), { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
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

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    const [forwarded] = forwardedEvents();
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
    openMainTranscriptPassMock.mockReset();
    openMainTranscriptPassMock.mockResolvedValue(emptyPass());
    openSubagentPassMock.mockReset();
    openSubagentPassMock.mockResolvedValue(emptyPass());
    openSessionEndPassMock.mockReset();
    openSessionEndPassMock.mockResolvedValue(emptyPass());
    readSubagentMetaMock.mockReset();
    readSubagentMetaMock.mockResolvedValue({});
    resolveClientVersionMock.mockReset();
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockReset();
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    vi.mocked(isProjectTracked).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['Stop', 'PreCompact', 'StopFailure'] as const)(
    'invokes openMainTranscriptPass with the extracted session/transcript/trigger on %s',
    async (hookEventName) => {
      const plugin = new ClaudeCodeOtlpPlugin();
      const parsedEvent = hookEvent({ hook_event_name: hookEventName });
      const rawEvent = JSON.stringify(parsedEvent);

      await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

      expect(openMainTranscriptPassMock).toHaveBeenCalledWith('sid-1', '/tmp/transcript.jsonl', hookEventName);
      const [forwarded] = forwardedEvents();
      expect(forwarded).toMatchObject({ ...parsedEvent, cwd: 'repo' });
    }
  );

  it('invokes openSessionEndPass with the session/transcript/cwd on SessionEnd, and sets retryOnce', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const parsedEvent = hookEvent({ hook_event_name: 'SessionEnd' });
    const rawEvent = JSON.stringify(parsedEvent);

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSessionEndPassMock).toHaveBeenCalledWith('sid-1', '/tmp/transcript.jsonl', '/repo');
    const [forwarded] = forwardedEvents();
    expect(forwarded).toMatchObject({ ...parsedEvent, cwd: 'repo' });
  });

  it('resends the SessionEnd batch once more when the first send fails (retryOnce)', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    forwardOtlpEventsToSpool.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'SessionEnd' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(2);
  });

  it('does not retry Stop (no retryOnce) when the send fails', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    forwardOtlpEventsToSpool.mockResolvedValue(false);
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'Stop' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
  });

  it('calls the pass finalize with the send outcome', async () => {
    const pass = emptyPass();
    openMainTranscriptPassMock.mockResolvedValue(pass);
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'Stop' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(pass.finalize).toHaveBeenCalledWith(true);
  });

  it('does not dispatch openMainTranscriptPass for unrelated hook events', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'PostToolUse' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openMainTranscriptPassMock).not.toHaveBeenCalled();
  });

  it('invokes openSubagentPass with the agent_id/tool_use_id/agent_type extracted from a SubagentStop payload', async () => {
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

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSubagentPassMock).toHaveBeenCalledWith('sid-1', {
      agentId: 'sub-1',
      filePath: '/tmp/agent-sub-1.jsonl',
      toolUseId: 'tu-1',
      agentType: 'explore',
      cwd: '/repo',
    });
  });

  it('derives agent_id from the sidecar filename on SubagentStop when agent_id is absent', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-2.jsonl',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSubagentPassMock).toHaveBeenCalledWith('sid-1', expect.objectContaining({ agentId: 'sub-2' }));
  });

  it('fills tool_use_id/spawn_depth/description from the .meta.json sidecar on SubagentStop', async () => {
    readSubagentMetaMock.mockResolvedValue({ toolUseId: 'tu-sidecar', spawnDepth: 2, description: 'task' });
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-3.jsonl',
        agent_id: 'sub-3',
        agent_type: 'explore',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(readSubagentMetaMock).toHaveBeenCalledWith('/tmp/agent-sub-3.jsonl');
    expect(openSubagentPassMock).toHaveBeenCalledWith('sid-1', {
      agentId: 'sub-3',
      filePath: '/tmp/agent-sub-3.jsonl',
      toolUseId: 'tu-sidecar',
      agentType: 'explore',
      spawnDepth: 2,
      description: 'task',
      cwd: '/repo',
    });
  });

  it('skips openSubagentPass on SubagentStop when agent_transcript_path is missing', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'SubagentStop', agent_type: 'explore' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSubagentPassMock).not.toHaveBeenCalled();
  });

  it('skips SubagentStop entirely (no forward, no derive) when agent_type is empty', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(
      hookEvent({
        hook_event_name: 'SubagentStop',
        agent_transcript_path: '/tmp/agent-sub-4.jsonl',
        agent_type: '',
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    expect(openSubagentPassMock).not.toHaveBeenCalled();
    expect(forwardOtlpEventsToSpool).not.toHaveBeenCalled();
  });

  it('forwards every event a pass returns (the raw event plus any derived events) as one batch, in order', async () => {
    const derivedUsageEvent = { type: 'agent.usage.request' };
    const derivedSummaryEvent = { type: 'agent.session.summary' };
    openMainTranscriptPassMock.mockResolvedValue({
      events: [derivedUsageEvent, derivedSummaryEvent],
      finalize: vi.fn(async () => {}),
    });

    const plugin = new ClaudeCodeOtlpPlugin();
    const parsedEvent = hookEvent({ hook_event_name: 'Stop' });
    const rawEvent = JSON.stringify(parsedEvent);

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy, forwardOtlpEventsToSpool });

    // openMainTranscriptPass never calls forwardOtlpEventsToSpool itself (it is mocked here to
    // just return data) — every event that reaches the mock arrived via one batch call from
    // processOtlpEvent.
    expect(forwardOtlpEventsToSpool).toHaveBeenCalledTimes(1);
    expect(forwardedEvents()).toEqual([
      expect.objectContaining({ ...parsedEvent, cwd: 'repo' }),
      expect.objectContaining(derivedUsageEvent),
      expect.objectContaining(derivedSummaryEvent),
    ]);
  });

  it('rejects when rawEvent is malformed JSON', async () => {
    const plugin = new ClaudeCodeOtlpPlugin();

    await expect(plugin.processOtlpEvent('not json', { ensureOtlpProxy, forwardOtlpEventsToSpool })).rejects.toThrow();
  });
});

describe('ClaudeCodeOtlpPlugin wire type', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    resolveClientVersionMock.mockResolvedValue('2.1.23');
    forwardOtlpEventsToSpool.mockResolvedValue(true);
    openMainTranscriptPassMock.mockResolvedValue(emptyPass());
    openSubagentPassMock.mockResolvedValue(emptyPass());
    openSessionEndPassMock.mockResolvedValue(emptyPass());
  });

  const typeFor = async (name: string): Promise<unknown> => {
    // A SubagentStop with no agent_type is Claude Code's own internal check-in, never
    // forwarded (see the `claude-code-otlp.plugin.ts` guard) — give it one here so this
    // generic wire-type matrix still exercises its mapping, like every other hook name.
    const raw =
      name === 'SubagentStop'
        ? JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: name, agent_type: 'explore' })
        : event(name);
    await plugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventsToSpool });
    return forwardedEvents()[0]['type'];
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
      { ensureOtlpProxy, forwardOtlpEventsToSpool }
    );
    expect(forwardedEvents()[0]['type']).toBe('agent.prompt.submit');
  });

  it('falls back to agent.event for an unmapped hook name', () => {
    const resolve = (plugin as unknown as { resolveEventType(e: Record<string, unknown>): string }).resolveEventType;
    expect(resolve.call(plugin, { hook_event_name: 'SomethingNew' })).toBe('agent.event');
    expect(resolve.call(plugin, {})).toBe('agent.event');
  });

  it('keeps the explicit type of a derived event', async () => {
    openMainTranscriptPassMock.mockResolvedValue({
      events: [{ type: 'agent.usage.request', session_id: 's' }],
      finalize: vi.fn(async () => {}),
    });
    await plugin.processOtlpEvent(event('Stop'), { ensureOtlpProxy, forwardOtlpEventsToSpool });
    const types = forwardedEvents().map((r) => r['type']);
    expect(types).toEqual(['agent.session.stop', 'agent.usage.request']);
  });
});
