/** Uses the REAL logger — process-guards.test.ts mocks it and so cannot catch a
 *  broken logging contract (CR-001). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

type Handler = (payload: unknown) => void;

describe('installProcessGuards log-file persistence', () => {
  let handlers: Record<string, Handler>;

  beforeEach(() => {
    handlers = {};
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: Handler
    ) => {
      handlers[event] = handler;
      return process;
    }) as never);

    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('writes the stack to the log file even though the console omits it', async () => {
    const { logger } = await import('../logger.js');
    const { installProcessGuards } = await import('../process-guards.js');

    // Asserted, not early-returned: a silent return would pass vacuously.
    const logPath = logger.getLogFilePath();
    expect(logPath).toBeTruthy();

    const before = existsSync(logPath!) ? readFileSync(logPath!, 'utf-8') : '';

    installProcessGuards();

    const marker = 'process-guards-logfile-probe';
    const boom = new Error(marker);

    expect(() => handlers.uncaughtException(boom)).toThrow('process.exit:1');

    const after = readFileSync(logPath!, 'utf-8');
    const appended = after.slice(before.length);

    expect(appended).toContain(marker);
    // A stack, not just the message.
    expect(appended).toMatch(/\n\s+at\s/);
    expect(appended).not.toContain('[object Object]');
  });
});
