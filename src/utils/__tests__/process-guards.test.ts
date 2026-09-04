import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    getLogFilePath: vi.fn(() => null),
  },
}));

type Handler = (payload: unknown) => void;

describe('installProcessGuards', () => {
  let handlers: Record<string, Handler>;
  let exitCode: number | undefined;
  let stderr: string[];

  beforeEach(() => {
    handlers = {};
    exitCode = undefined;
    stderr = [];

    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: Handler
    ) => {
      handlers[event] = handler;
      return process;
    }) as never);

    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit:${code}`);
    }) as never);

    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('registers guards for both unhandledRejection and uncaughtException', async () => {
    const { installProcessGuards } = await import('../process-guards.js');

    installProcessGuards();

    expect(handlers.unhandledRejection).toBeTypeOf('function');
    expect(handlers.uncaughtException).toBeTypeOf('function');
  });

  it('reports an unhandled rejection without a stack trace and exits non-zero', async () => {
    const { installProcessGuards } = await import('../process-guards.js');
    installProcessGuards();

    const boom = new Error('credentials unavailable');

    expect(() => handlers.unhandledRejection(boom)).toThrow('process.exit:1');
    expect(exitCode).toBe(1);

    const output = stderr.join('\n');
    expect(output).toContain('credentials unavailable');
    expect(output).not.toContain('at ');
  });

  it('reports an uncaught exception without a stack trace and exits non-zero', async () => {
    const { installProcessGuards } = await import('../process-guards.js');
    installProcessGuards();

    expect(() => handlers.uncaughtException(new Error('boom'))).toThrow(
      'process.exit:1'
    );
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).not.toContain('at ');
  });

  it('passes the original error to the logger so the stack is preserved', async () => {
    const { logger } = await import('../logger.js');
    const { installProcessGuards } = await import('../process-guards.js');
    installProcessGuards();

    const boom = new Error('credentials unavailable');

    expect(() => handlers.uncaughtException(boom)).toThrow('process.exit:1');

    // logger.error unwraps .stack only from an Error; an object literal
    // stringifies to "[object Object]".
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), boom);
  });

  it('sets a non-zero exitCode before exiting so a premature natural exit still fails', async () => {
    const { installProcessGuards } = await import('../process-guards.js');
    installProcessGuards();

    const original = process.exitCode;
    try {
      process.exitCode = 0;
      expect(() => handlers.uncaughtException(new Error('boom'))).toThrow(
        'process.exit:1'
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = original;
    }
  });

  it('handles a non-Error rejection reason without crashing', async () => {
    const { installProcessGuards } = await import('../process-guards.js');
    installProcessGuards();

    expect(() => handlers.unhandledRejection('plain string reason')).toThrow(
      'process.exit:1'
    );
    expect(stderr.join('\n')).toContain('plain string reason');
  });
});
