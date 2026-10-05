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
vi.mock('@/utils/exec.js', () => ({
  exec: execMock,
}));

import { ClaudeCodeOtlpPlugin } from '../claude-code-otlp.plugin.js';
import { isProjectTracked } from '../claude-code-otlp.allowlist.js';
import { forwardOtlpEventToSpool } from '../../utils.js';
import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';

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
