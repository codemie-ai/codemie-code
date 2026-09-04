/**
 * Verifies MetricsWriter.readAll() tolerates a single corrupt JSONL line
 * (e.g. from a crash mid-append) instead of aborting the entire read —
 * a corrupt line should be skipped, not propagate an exception that would
 * abort the whole session-end metrics send (see CR-006).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const SESSION_ID = 'test-session-corrupt-metrics';

describe('MetricsWriter.readAll corrupt-line tolerance', () => {
  let tempHome: string;
  let originalCodemieHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'metrics-writer-test-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = tempHome;
    mkdirSync(join(tempHome, 'sessions'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* ignore cleanup races */ }
    if (originalCodemieHome !== undefined) {
      process.env.CODEMIE_HOME = originalCodemieHome;
    } else {
      delete process.env.CODEMIE_HOME;
    }
  });

  it('skips a single malformed line and returns the valid deltas around it', async () => {
    const { MetricsWriter } = await import('../MetricsWriter.js');
    const writer = new MetricsWriter(SESSION_ID);
    const filePath = writer.getFilePath();

    const validLine1 = JSON.stringify({ recordId: 'r1', sessionId: SESSION_ID, syncStatus: 'pending', syncAttempts: 0 });
    const corruptLine = '{"recordId": "r2", "sessionId": broken-json-here';
    const validLine2 = JSON.stringify({ recordId: 'r3', sessionId: SESSION_ID, syncStatus: 'pending', syncAttempts: 0 });

    writeFileSync(filePath, `${validLine1}\n${corruptLine}\n${validLine2}\n`, 'utf-8');

    const deltas = await writer.readAll();

    expect(deltas.map(d => d.recordId)).toEqual(['r1', 'r3']);
  });
});
