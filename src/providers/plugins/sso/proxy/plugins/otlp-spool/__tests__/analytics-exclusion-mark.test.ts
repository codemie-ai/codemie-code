import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { excludedSessionsRoot, isSessionExcluded, markSessionExcluded } from '../analytics-exclusion-mark.js';

describe('analytics exclusion mark', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'exclusion-mark-'));
    vi.stubEnv('CODEMIE_HOME', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('a marked session is excluded, another is not', async () => {
    await markSessionExcluded('sid-1');

    expect(await isSessionExcluded('sid-1')).toBe(true);
    expect(await isSessionExcluded('sid-2')).toBe(false);
  });

  it('the mark is an empty file under <CODEMIE_HOME>/analytics/excluded, private to the user', async () => {
    await markSessionExcluded('sid-1');

    expect(excludedSessionsRoot()).toBe(join(home, 'analytics', 'excluded'));
    const info = await stat(join(home, 'analytics', 'excluded', 'sid-1'));
    expect(info.size).toBe(0);
    if (process.platform !== 'win32') {
      expect(info.mode & 0o777).toBe(0o600);
      expect((await stat(excludedSessionsRoot())).mode & 0o777).toBe(0o700);
    }
  });

  it('edge: an id with a path separator or no id writes no file and is not excluded', async () => {
    await markSessionExcluded('../escape');
    await markSessionExcluded('a/b');
    await markSessionExcluded(undefined);

    await expect(readdir(join(home, 'analytics'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(home)).toEqual([]);
    expect(await isSessionExcluded('a/b')).toBe(false);
    expect(await isSessionExcluded(undefined)).toBe(false);
  });
});
