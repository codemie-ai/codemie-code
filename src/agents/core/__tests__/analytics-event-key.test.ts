import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyedDigest, resetEventKeyCache } from '../analytics-event-key.js';

describe('analytics event key file (CR-010)', () => {
  let home = '';
  const prior = process.env.CODEMIE_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'event-key-'));
    process.env.CODEMIE_HOME = home;
    resetEventKeyCache();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = prior;
    resetEventKeyCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('repairs a truncated key file instead of falling back to a per-process key', () => {
    writeFileSync(join(home, 'analytics-event-key'), Buffer.from('short'));
    const first = keyedDigest('x');
    expect(readFileSync(join(home, 'analytics-event-key')).length).toBe(32);
    resetEventKeyCache();
    expect(keyedDigest('x')).toBe(first);
  });

  it('creates the key once and leaves no temp files', () => {
    const first = keyedDigest('x');
    resetEventKeyCache();
    expect(keyedDigest('x')).toBe(first);
    expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
