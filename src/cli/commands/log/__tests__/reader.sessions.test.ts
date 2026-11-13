/**
 * `codemie log` session listing: `/clear` generations (`completed_<uuid>-<gen>.json`) are sessions too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionReader } from '../reader.js';

const ID = 'eddd66b2-0e73-4167-841c-9263207870ae';
let dir: string;

function writeRecord(name: string, startTime: number): void {
  writeFileSync(join(dir, name), JSON.stringify({ sessionId: ID, agentName: 'claude', provider: 'ai-run-sso', startTime, status: 'completed' }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-reader-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionReader', () => {
  it('lists a session and its generations under --session <uuid>', () => {
    writeRecord(`completed_${ID}.json`, 3000);
    writeRecord(`completed_${ID}-gen-alpha.json`, 1000);
    writeRecord(`completed_${ID}-gen-alpha_metrics.jsonl`, 1000);

    const sessions = new SessionReader(dir).listSessions({ sessionId: ID });

    expect(sessions.map((s) => s.startTime)).toEqual([3000, 1000]);
  });

  it('reads a generation by its id', () => {
    writeRecord(`completed_${ID}-gen-alpha.json`, 1000);

    expect(new SessionReader(dir).readSession(`${ID}-gen-alpha`)?.startTime).toBe(1000);
  });
});
