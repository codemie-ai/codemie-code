/**
 * Regression test for the unhandled write-stream error that failed CI on
 * PR #522: every unit test passed, then the run died with
 *
 *   Error: ENOENT: no such file or directory,
 *   open '/tmp/metrics-upload-XXXX/logs/debug-YYYY-MM-DD.log'
 *
 * fs.createWriteStream opens the file asynchronously, so a logs directory that
 * disappears between the mkdir and the open surfaces as an 'error' event rather
 * than a throw the initializeLogFile try/catch could catch. With no listener
 * Node treats it as an unhandled error and takes the process down.
 *
 * Reproducing the ENOENT timing directly would be a race. Occupying the log
 * path with a DIRECTORY produces the identical failure mode deterministically:
 * createWriteStream fails asynchronously (EISDIR), exercising the same listener.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';

const ORIGINAL_CODEMIE_HOME = process.env.CODEMIE_HOME;
let home: string;

describe('Logger write-stream error handling', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codemie-logger-writeerr-'));
    process.env.CODEMIE_HOME = home;
  });

  afterEach(() => {
    if (ORIGINAL_CODEMIE_HOME === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = ORIGINAL_CODEMIE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('does not crash the process when the log file cannot be opened', async () => {
    const today = new Date().toISOString().split('T')[0];
    // Occupy the exact log-file path with a directory so the async open fails.
    mkdirSync(join(home, 'logs', `debug-${today}.log`), { recursive: true });

    expect(() => logger.notice('write stream should fail to open')).not.toThrow();

    // Let the stream's async 'error' event fire. Before the fix this surfaced as
    // an unhandled error and failed the whole vitest run despite passing tests.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The handler disables file logging rather than letting the error escape.
    expect(logger.getLogFilePath()).toBeNull();

    // Logging still works afterwards (console-only) and stays non-fatal.
    expect(() => logger.notice('still alive')).not.toThrow();
  });
});
