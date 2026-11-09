/**
 * Logger.runWithContext: a line logged inside the call carries that call's agent / session /
 * profile, across an await; a line outside it keeps the process-wide ones.
 *
 * Seam: `logger.debug` with CODEMIE_DEBUG on; the console is the boundary, the log file goes to a
 * temp CODEMIE_HOME.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codemie-logger-context-'));
  vi.stubEnv('CODEMIE_HOME', home);
  vi.stubEnv('CODEMIE_DEBUG', 'true');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await logger.close();
  rmSync(home, { recursive: true, force: true });
});

describe('logger.runWithContext', () => {
  it('a line inside the call carries its context after an await; a line outside carries the process prefix', async () => {
    const consoleError = vi.spyOn(globalThis.console, 'error').mockImplementation(() => {});
    logger.setAgentName('claude');
    logger.setSessionId('own');
    logger.setProfileName('work');

    await logger.runWithContext({ agentName: 'codex', sessionId: 'other', profileName: 'p' }, async () => {
      await Promise.resolve();
      logger.debug('inside');
    });
    logger.debug('outside');

    const lines = consoleError.mock.calls.map(([line]) => String(line));
    expect(lines.find((line) => line.includes('inside'))).toContain('[DEBUG] [codex] [other] [p] inside');
    expect(lines.find((line) => line.includes('outside'))).toContain('[DEBUG] [claude] [own] [work] outside');
  });

  it('a line written to the log file inside the call carries its context; one outside the process prefix', async () => {
    await logger.close();
    logger.setAgentName('claude');
    logger.setSessionId('own');
    logger.setProfileName('work');

    await logger.runWithContext({ agentName: 'codex', sessionId: 'other', profileName: 'p' }, async () => {
      await Promise.resolve();
      logger.info('file-inside');
    });
    logger.info('file-outside');
    await logger.close();

    const logsDir = join(home, 'logs');
    const lines = readdirSync(logsDir).flatMap((name) => readFileSync(join(logsDir, name), 'utf-8').split('\n'));
    expect(lines.find((line) => line.includes('file-inside'))).toContain('[INFO] [codex] [other] [p] file-inside');
    expect(lines.find((line) => line.includes('file-outside'))).toContain('[INFO] [claude] [own] [work] file-outside');
  });
});
