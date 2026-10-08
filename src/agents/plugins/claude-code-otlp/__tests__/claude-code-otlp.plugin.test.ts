import { describe, it, expect, vi, beforeEach } from 'vitest';

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
