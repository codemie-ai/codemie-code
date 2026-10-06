import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../claude-code-otlp.allowlist.js', () => ({
  readAllowlistState: vi.fn(async () => ({ kind: 'valid', paths: ['/proj'] })),
  isProjectTracked: vi.fn(),
}));
vi.mock('../../utils.js', () => ({ forwardOtlpEventToSpool: vi.fn() }));
vi.mock('@/providers/plugins/sso/sso.auth-gate.js', () => ({ ensureCodeMieSsoAuth: vi.fn() }));
vi.mock('@/utils/config.js', () => ({ ConfigLoader: { load: vi.fn(async () => ({})) } }));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const execMock = vi.fn();
const collectMainTranscriptEventsMock = vi.fn();
const collectSubagentTranscriptEventsMock = vi.fn();
const findSubagentFilesMock = vi.fn();

vi.mock('@/utils/exec.js', () => ({
  exec: execMock,
}));

vi.mock('../transcript/orchestrator.js', () => ({
  collectMainTranscriptEvents: collectMainTranscriptEventsMock,
  collectSubagentTranscriptEvents: collectSubagentTranscriptEventsMock,
}));

vi.mock('../transcript/subagent-usage.js', () => ({
  findSubagentFiles: findSubagentFilesMock,
}));

import { isProjectTracked } from '../claude-code-otlp.allowlist.js';
import { forwardOtlpEventToSpool } from '../../utils.js';
import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';

// Deferred past the mock-backing consts above: a static import of the plugin would be
// hoisted ahead of them (ESM import hoisting), tripping a TDZ error inside the
// transcript/orchestrator.js mock factory, which closes over those consts.
const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

const event = (name: string) => JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: name });

describe('ClaudeCodeOtlpPlugin.processOtlpEvent', () => {
  const plugin = new ClaudeCodeOtlpPlugin();
  const ensureOtlpProxy = vi.fn(async () => {});

  beforeEach(() => vi.clearAllMocks());

  it('does nothing for untracked projects, for every event', async () => {
    vi.mocked(isProjectTracked).mockResolvedValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      await plugin.processOtlpEvent(event(name), { ensureOtlpProxy });
    }
    expect(ensureOtlpProxy).not.toHaveBeenCalled();
    expect(ensureCodeMieSsoAuth).not.toHaveBeenCalled();
    expect(forwardOtlpEventToSpool).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('ensures the proxy before forwarding for tracked projects', async () => {
    vi.mocked(isProjectTracked).mockResolvedValue(true);
    await plugin.processOtlpEvent(event('SessionStart'), { ensureOtlpProxy });
    expect(ensureOtlpProxy).toHaveBeenCalledTimes(1);
    expect(forwardOtlpEventToSpool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureOtlpProxy).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(forwardOtlpEventToSpool).mock.invocationCallOrder[0]
    );
  });
});

describe('ClaudeCodeOtlpPlugin.prepareAnalyticsFields', () => {
  const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;

  beforeEach(() => {
    execMock.mockReset();
    execMock.mockResolvedValue({ code: 0, stdout: '2.1.23 (Claude Code)', stderr: '', signal: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEntrypoint === undefined) {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    } else {
      process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint;
    }
  });

  it('returns platform, entrypoint, and client_version', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';

    const plugin = new ClaudeCodeOtlpPlugin();
    const fields = await plugin.prepareAnalyticsFields({});

    expect(fields.platform).toBe('claude-code');
    expect(fields.entrypoint).toBe('cli');
    expect(fields.client_version).toBe('2.1.23');
  });

  it('includes agent_id/agent_type when present on the hook event', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

    const plugin = new ClaudeCodeOtlpPlugin();
    const fields = await plugin.prepareAnalyticsFields({ agent_id: 'sub-1', agent_type: 'explore' });

    expect(fields.agent_id).toBe('sub-1');
    expect(fields.agent_type).toBe('explore');
  });

  it('omits agent_id/agent_type when absent from the hook event', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

    const plugin = new ClaudeCodeOtlpPlugin();
    const fields = await plugin.prepareAnalyticsFields({});

    expect(fields).not.toHaveProperty('agent_id');
    expect(fields).not.toHaveProperty('agent_type');
  });

  it('spawns `claude --version` only once across two prepareAnalyticsFields calls', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

    const plugin = new ClaudeCodeOtlpPlugin();
    await plugin.prepareAnalyticsFields({});
    await plugin.prepareAnalyticsFields({ agent_id: 'sub-2' });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith('claude', ['--version']);
  });

  it('falls back to an empty client_version when `claude --version` throws', async () => {
    execMock.mockRejectedValue(new Error('ENOENT'));
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');

    const plugin = new ClaudeCodeOtlpPlugin();
    const fields = await plugin.prepareAnalyticsFields({});

    expect(fields.client_version).toBe('');
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
    findSubagentFilesMock.mockReset();
    findSubagentFilesMock.mockResolvedValue([]);
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
      const rawEvent = JSON.stringify(hookEvent({ hook_event_name: hookEventName }));

      await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy });

      expect(collectMainTranscriptEventsMock).toHaveBeenCalledWith(
        'sid-1',
        '/tmp/transcript.jsonl',
        hookEventName
      );
      expect(forwardOtlpEventToSpool).toHaveBeenCalledWith(rawEvent, 'claude-code-otlp');
    }
  );

  it('does not dispatch collectMainTranscriptEvents for unrelated hook events', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'PostToolUse' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy });

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

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy });

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
      })
    );

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy });

    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledWith(
      'sid-1',
      expect.objectContaining({ agentId: 'sub-2' })
    );
  });

  it('skips collectSubagentTranscriptEvents on SubagentStop when agent_transcript_path is missing', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'SubagentStop' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy });

    expect(collectSubagentTranscriptEventsMock).not.toHaveBeenCalled();
  });

  it('runs collectSubagentTranscriptEvents for every subagent file found on SessionEnd', async () => {
    findSubagentFilesMock.mockResolvedValue([
      { agentId: 'sub-1', filePath: '/tmp/agent-sub-1.jsonl' },
      { agentId: 'sub-2', filePath: '/tmp/agent-sub-2.jsonl' },
    ]);
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'SessionEnd' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy });

    expect(findSubagentFilesMock).toHaveBeenCalledWith('/tmp/transcript.jsonl');
    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledTimes(2);
    expect(collectSubagentTranscriptEventsMock).toHaveBeenCalledWith(
      'sid-1',
      { agentId: 'sub-1', filePath: '/tmp/agent-sub-1.jsonl' }
    );
  });

  it('forwards the raw event and skips all transcript-parse dispatch when session_id is empty', async () => {
    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ session_id: '', hook_event_name: 'Stop' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy });

    expect(collectMainTranscriptEventsMock).not.toHaveBeenCalled();
    expect(forwardOtlpEventToSpool).toHaveBeenCalledWith(rawEvent, 'claude-code-otlp');
  });

  it('forwards every event a per-event handler returns (the raw event plus any derived events) through the single forwardToSpool path, in order', async () => {
    const derivedUsageEvent = JSON.stringify({ type: 'agent.usage.request' });
    const derivedSummaryEvent = JSON.stringify({ type: 'agent.session.summary' });
    collectMainTranscriptEventsMock.mockResolvedValue([derivedUsageEvent, derivedSummaryEvent]);

    const { ClaudeCodeOtlpPlugin } = await import('../claude-code-otlp.plugin.js');
    const plugin = new ClaudeCodeOtlpPlugin();
    const rawEvent = JSON.stringify(hookEvent({ hook_event_name: 'Stop' }));

    await plugin.processOtlpEvent(rawEvent, { ensureOtlpProxy });

    // collectMainTranscriptEvents/collectSubagentTranscriptEvents never call forwardOtlpEventToSpool
    // themselves (they are mocked here to just return data) — every event that reaches the spool
    // mock arrived via forwardToSpool, called exactly once from processOtlpEvent.
    expect(forwardOtlpEventToSpool).toHaveBeenCalledTimes(3);
    expect(vi.mocked(forwardOtlpEventToSpool).mock.calls.map(([raw]) => raw)).toEqual([
      rawEvent,
      derivedUsageEvent,
      derivedSummaryEvent,
    ]);
  });
});
