import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile } from 'fs/promises';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Console } from 'node:console';
import { logger } from '../logger.js';

const ORIGINAL_CODEMIE_HOME = process.env.CODEMIE_HOME;
const ORIGINAL_DEBUG = process.env.CODEMIE_DEBUG;

async function waitForLogContent(logPath: string, marker: string, timeoutMs = 2000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const contents = await readFile(logPath, 'utf-8').catch(() => '');
    if (contents.includes(marker)) return contents;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Log file did not contain marker "${marker}" within ${timeoutMs}ms`);
}

describe('Logger.notice', () => {
  beforeEach(async () => {
    process.env.CODEMIE_HOME = await mkdtemp(join(tmpdir(), 'codemie-logger-notice-'));
    delete process.env.CODEMIE_DEBUG;
  });

  afterEach(() => {
    if (ORIGINAL_CODEMIE_HOME === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = ORIGINAL_CODEMIE_HOME;
    if (ORIGINAL_DEBUG === undefined) delete process.env.CODEMIE_DEBUG;
    else process.env.CODEMIE_DEBUG = ORIGINAL_DEBUG;
    vi.restoreAllMocks();
  });

  it('prints a ⚠ warning to console even when CODEMIE_DEBUG is unset', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.notice('hook failed: boom');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('⚠');
    expect(warnSpy.mock.calls[0][0]).toContain('hook failed: boom');
  });

  it('always writes an entry to the file log', async () => {
    logger.notice('plugin hooks.json malformed');
    const logPath = logger.getLogFilePath();
    expect(logPath).not.toBeNull();
    const contents = await waitForLogContent(logPath!, 'plugin hooks.json malformed');
    expect(contents).toContain('[NOTICE]');
  });
});

describe('Logger console sinks', () => {
  beforeEach(async () => {
    process.env.CODEMIE_HOME = await mkdtemp(join(tmpdir(), 'codemie-logger-sinks-'));
    delete process.env.CODEMIE_DEBUG;
  });

  afterEach(() => {
    if (ORIGINAL_CODEMIE_HOME === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = ORIGINAL_CODEMIE_HOME;
    if (ORIGINAL_DEBUG === undefined) delete process.env.CODEMIE_DEBUG;
    else process.env.CODEMIE_DEBUG = ORIGINAL_DEBUG;
    vi.restoreAllMocks();
  });

  /**
   * A fresh logger whose default sink is a real Node console on process.stdout / process.stderr
   * (vitest's own console does not write to them), plus spies on both streams.
   */
  async function freshLoggerWithStreamSpies() {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('console', new Console(process.stdout, process.stderr));
    vi.resetModules();
    const { logger: fresh } = await import('../logger.js');
    vi.unstubAllGlobals();
    const text = (spy: typeof stdoutWrite) => spy.mock.calls.map(([chunk]) => String(chunk)).join('');
    return { fresh, stdoutWrite, stderrWrite, stdout: () => text(stdoutWrite), stderr: () => text(stderrWrite) };
  }

  it('writes debug output to stderr, never stdout, when CODEMIE_DEBUG is set', async () => {
    process.env.CODEMIE_DEBUG = '1';
    const { fresh, stdoutWrite, stderr } = await freshLoggerWithStreamSpies();
    fresh.debug('x');
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderr()).toContain('[DEBUG]');
    expect(stderr()).toContain('x');
  });

  it('writes debug output nowhere when CODEMIE_DEBUG is unset', async () => {
    const { fresh, stdoutWrite, stderrWrite } = await freshLoggerWithStreamSpies();
    fresh.debug('x');
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('writes success to stdout by default, and its plain message to the log file at info', async () => {
    const { fresh, stderrWrite, stdout } = await freshLoggerWithStreamSpies();
    fresh.success('y');
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(stdout()).toContain('✓ y');

    const contents = await waitForLogContent(fresh.getLogFilePath()!, ' y');
    // A fresh CODEMIE_HOME: the only file entry is the success line.
    const lines = contents.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[INFO]');
    expect(lines[0].endsWith('] y')).toBe(true);
  });

  it('writes a status line as is to stdout by default, and one info line with the message to the log file', async () => {
    const { fresh, stderrWrite, stdout } = await freshLoggerWithStreamSpies();
    fresh.status('m');
    expect(stdout()).toBe('m\n');
    expect(stderrWrite).not.toHaveBeenCalled();

    const contents = await waitForLogContent(fresh.getLogFilePath()!, ' m');
    // A fresh CODEMIE_HOME: the only file entry is the status line.
    const lines = contents.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[INFO]');
    expect(lines[0].endsWith('] m')).toBe(true);
  });

  it('writes a status line as is to the stream given to setConsoleStream', async () => {
    const { fresh, stdoutWrite, stderr } = await freshLoggerWithStreamSpies();
    fresh.setConsoleStream(process.stderr);
    fresh.status('m');
    expect(stderr()).toBe('m\n');
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('sends success, notice and debug to the stream given to setConsoleStream', async () => {
    vi.resetModules();
    const { logger: fresh } = await import('../logger.js');
    process.env.CODEMIE_DEBUG = '1';
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    fresh.setConsoleStream(process.stderr);
    fresh.success('y');
    fresh.notice('n');
    fresh.debug('dbg-line');

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('✓ y');
    expect(written).toContain('⚠ n');
    expect(written).toContain('[DEBUG]');
    expect(written).toContain('dbg-line');
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('writes nothing to any console after setConsoleStream(null), and the file sink still receives every level it records, success and status included', async () => {
    process.env.CODEMIE_DEBUG = '1';
    const { fresh, stdoutWrite, stderrWrite } = await freshLoggerWithStreamSpies();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fresh.setConsoleStream(null);
    fresh.debug('null-debug');
    fresh.success('null-success');
    fresh.status('null-status');
    fresh.notice('null-notice');
    fresh.error('null-error', new Error('e'));

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    const contents = await waitForLogContent(fresh.getLogFilePath()!, 'null-error');
    expect(contents).toContain('null-debug');
    expect(contents).toMatch(/\[INFO\][^\n]* null-success\n/);
    expect(contents).toMatch(/\[INFO\][^\n]* null-status\n/);
    expect(contents).toContain('null-notice');
  });
});

describe('Logger.close', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await logger.close();
    if (ORIGINAL_CODEMIE_HOME === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = ORIGINAL_CODEMIE_HOME;
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });

  it('releases the log file so its home can be removed, and the next write opens a file under the new home', async () => {
    const first = await mkdtemp(join(tmpdir(), 'codemie-logger-close-a-'));
    const second = await mkdtemp(join(tmpdir(), 'codemie-logger-close-b-'));
    homes.push(first, second);

    process.env.CODEMIE_HOME = first;
    await logger.close();
    logger.info('before-close');
    expect(logger.getLogFilePath()!.startsWith(first)).toBe(true);
    await waitForLogContent(logger.getLogFilePath()!, 'before-close');
    await logger.close();
    await rm(first, { recursive: true, force: true });

    process.env.CODEMIE_HOME = second;
    logger.info('after-close');
    const reopened = logger.getLogFilePath();
    expect(reopened).not.toBeNull();
    expect(reopened!.startsWith(second)).toBe(true);
    expect(await waitForLogContent(reopened!, 'after-close')).toContain('[INFO]');
  });
});
