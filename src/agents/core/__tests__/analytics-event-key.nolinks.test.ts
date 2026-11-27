import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  linkSync: () => {
    throw Object.assign(new Error('hard links not supported'), { code: 'EPERM' });
  },
}));

import { keyedDigest, resetEventKeyCache } from '../analytics-event-key.js';

describe('analytics event key on a filesystem without hard links (CR-038)', () => {
  let home = '';
  const prior = process.env.CODEMIE_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'event-key-nolinks-'));
    process.env.CODEMIE_HOME = home;
    resetEventKeyCache();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = prior;
    resetEventKeyCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('still creates a persistent key, so ids are stable across processes', () => {
    const first = keyedDigest('x');
    expect(readFileSync(join(home, 'analytics-event-key')).length).toBe(32);
    resetEventKeyCache();
    expect(keyedDigest('x')).toBe(first);
  });
});
