/**
 * Global hooks fire for non-CodeMie `claude` runs: the hook command must exit 0
 * silently when CODEMIE_AGENT / CODEMIE_SESSION_ID are absent.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createHookCommand } from '../hook.js';
import { logger } from '@/utils/logger.js';

describe('hook command outside a CodeMie session', () => {
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalExitCode = process.exitCode;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([JSON.stringify({ session_id: 'native-1', hook_event_name: 'SessionEnd' })]),
      configurable: true,
    });
    process.exitCode = undefined;
    delete process.env.CODEMIE_AGENT;
    delete process.env.CODEMIE_SESSION_ID;
  });

  afterEach(() => {
    if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    process.exitCode = originalExitCode;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function runHook(): Promise<{
    errorSpy: ReturnType<typeof vi.spyOn>;
    debugSpy: ReturnType<typeof vi.spyOn>;
    closeSpy: ReturnType<typeof vi.spyOn>;
  }> {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const closeSpy = vi.spyOn(logger, 'close').mockResolvedValue(undefined as never);
    await createHookCommand().parseAsync(['--agent', 'claude'], { from: 'user' });
    return { errorSpy, debugSpy, closeSpy };
  }

  const debugMessages = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map(c => String(c[0]));

  it('exits 0 silently when CODEMIE_AGENT is unset', async () => {
    const { errorSpy, debugSpy, closeSpy } = await runHook();

    expect(process.exitCode).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    const msgs = debugMessages(debugSpy);
    expect(msgs.some(m => /not a CodeMie session|CODEMIE_AGENT missing|CODEMIE_SESSION_ID missing/.test(m))).toBe(true);
    expect(msgs.some(m => m.includes('[hook:debug] CODEMIE_AGENT missing. Available CODEMIE_* vars:'))).toBe(true);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('exits 0 silently when CODEMIE_SESSION_ID is unset', async () => {
    process.env.CODEMIE_AGENT = 'claude';
    const { errorSpy, debugSpy, closeSpy } = await runHook();

    expect(process.exitCode).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugMessages(debugSpy).some(m => /not a CodeMie session|CODEMIE_SESSION_ID missing/.test(m))).toBe(true);
    expect(closeSpy).toHaveBeenCalled();
  });
});
