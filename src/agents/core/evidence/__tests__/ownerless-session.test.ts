import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNERLESS_SESSION_TTL_MS,
  clearOwnerlessSessionStart,
  hasOwnerlessSessionStart,
  markOwnerlessSessionStart,
  ownerlessSessionDir,
} from '../ownerless-session.js';

let home: string;
let prev: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ownerless-'));
  prev = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('ownerless-session marker', () => {
  it('is absent until written, then found for that session only', async () => {
    expect(await hasOwnerlessSessionStart('s1')).toBe(false);
    await markOwnerlessSessionStart('s1');
    expect(await hasOwnerlessSessionStart('s1')).toBe(true);
    expect(await hasOwnerlessSessionStart('s2')).toBe(false);
  });

  it('stores no session id, only a hash and a timestamp, and leaves no temp file', async () => {
    await markOwnerlessSessionStart('secret-session-id');
    const files = readdirSync(ownerlessSessionDir());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.json$/);
    const content = readFileSync(join(ownerlessSessionDir(), files[0]), 'utf8');
    expect(content).not.toContain('secret-session-id');
    expect(JSON.parse(content)).toMatchObject({ v: 1 });
  });

  it('marking twice keeps one marker', async () => {
    await markOwnerlessSessionStart('s1');
    await markOwnerlessSessionStart('s1');
    expect(readdirSync(ownerlessSessionDir())).toHaveLength(1);
  });

  it('expires after the TTL', async () => {
    const t0 = Date.now();
    await markOwnerlessSessionStart('s1', t0);
    expect(await hasOwnerlessSessionStart('s1', t0 + OWNERLESS_SESSION_TTL_MS - 60_000)).toBe(true);
    expect(await hasOwnerlessSessionStart('s1', t0 + OWNERLESS_SESSION_TTL_MS + 60_000)).toBe(false);
  });

  it('a later mark removes markers that already expired', async () => {
    const t0 = Date.now();
    await markOwnerlessSessionStart('old', t0);
    await markOwnerlessSessionStart('new', t0 + OWNERLESS_SESSION_TTL_MS + 60_000);
    expect(readdirSync(ownerlessSessionDir())).toHaveLength(1);
    expect(await hasOwnerlessSessionStart('new')).toBe(true);
  });

  it('clearing removes only that session\'s marker and is harmless when there is none', async () => {
    await clearOwnerlessSessionStart('never-marked');
    await markOwnerlessSessionStart('s1');
    await markOwnerlessSessionStart('s2');
    await clearOwnerlessSessionStart('s1');
    expect(await hasOwnerlessSessionStart('s1')).toBe(false);
    expect(await hasOwnerlessSessionStart('s2')).toBe(true);
    await clearOwnerlessSessionStart('');
    expect(await hasOwnerlessSessionStart('s2')).toBe(true);
  });

  it('an empty session id is never marked or found', async () => {
    await markOwnerlessSessionStart('');
    expect(existsSync(ownerlessSessionDir())).toBe(false);
    expect(await hasOwnerlessSessionStart('')).toBe(false);
  });

  it('never throws when the state directory is unusable', async () => {
    writeFileSync(join(home, 'analytics'), 'not a directory');
    await expect(markOwnerlessSessionStart('s1')).resolves.toBeUndefined();
    expect(await hasOwnerlessSessionStart('s1')).toBe(false);
  });
});
