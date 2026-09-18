import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile } from 'fs/promises';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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
