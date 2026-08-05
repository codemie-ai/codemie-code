import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GeminiSessionAdapter } from '../gemini.session-adapter.js';
import { GeminiPluginMetadata } from '../gemini.plugin.js';

let geminiHome: string;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Creates ~/.gemini/tmp/{hash}/chats/{sessionId}.json with well-formed content.
 * Returns the absolute path to the created file.
 */
function makeSession(
  hash: string,
  sessionId: string,
  startTime: number,
  opts: { lastUpdated?: number } = {}
): string {
  const chatsDir = join(geminiHome, 'tmp', hash, 'chats');
  mkdirSync(chatsDir, { recursive: true });
  const filePath = join(chatsDir, `${sessionId}.json`);
  writeFileSync(
    filePath,
    JSON.stringify({
      sessionId,
      projectHash: hash,
      startTime: new Date(startTime).toISOString(),
      lastUpdated: new Date(opts.lastUpdated ?? startTime + 1000).toISOString(),
      messages: [],
    })
  );
  return filePath;
}

function newAdapter(): GeminiSessionAdapter {
  return new GeminiSessionAdapter(GeminiPluginMetadata);
}

beforeEach(() => {
  geminiHome = mkdtempSync(join(tmpdir(), 'gemini-home-'));
  process.env.GEMINI_HOME = geminiHome;
});

afterEach(() => {
  delete process.env.GEMINI_HOME;
  rmSync(geminiHome, { recursive: true, force: true });
});

describe('GeminiSessionAdapter.discoverSessions', () => {
  it('returns [] when tmp dir does not exist', async () => {
    expect(await newAdapter().discoverSessions!()).toEqual([]);
  });

  it('returns [] when tmp dir exists but is empty', async () => {
    mkdirSync(join(geminiHome, 'tmp'), { recursive: true });
    expect(await newAdapter().discoverSessions!()).toEqual([]);
  });

  it('honors GEMINI_HOME and sets correct filePath', async () => {
    const filePath = makeSession('abc123', 'sess-1', Date.now() - DAY);

    const found = await newAdapter().discoverSessions!();

    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe('sess-1');
    expect(found[0].filePath).toBe(filePath);
    expect(found[0].agentName).toBe('gemini');
    expect(found[0].projectPath).toBeUndefined();
    expect(found[0].updatedAt).toBeGreaterThan(found[0].createdAt);
  });

  it('skips hash dirs with no chats/ subdirectory', async () => {
    const now = Date.now();
    makeSession('has-chats', 'sess-a', now - DAY);
    // hash dir with no chats/ subdir
    mkdirSync(join(geminiHome, 'tmp', 'no-chats'), { recursive: true });

    const found = await newAdapter().discoverSessions!();

    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe('sess-a');
  });

  it('skips malformed JSON files and includes valid ones', async () => {
    const now = Date.now();
    makeSession('hash1', 'good-sess', now - DAY);
    const badChatsDir = join(geminiHome, 'tmp', 'hash2', 'chats');
    mkdirSync(badChatsDir, { recursive: true });
    writeFileSync(join(badChatsDir, 'bad.json'), '{ not valid json');

    const found = await newAdapter().discoverSessions!();

    expect(found.map((d) => d.sessionId)).toEqual(['good-sess']);
  });

  it('honors maxAgeDays and excludes old sessions', async () => {
    const now = Date.now();
    makeSession('h1', 'recent', now - 2 * DAY);
    makeSession('h2', 'ancient', now - 90 * DAY);

    const found = await newAdapter().discoverSessions!({ maxAgeDays: 30 });

    expect(found.map((d) => d.sessionId)).toEqual(['recent']);
  });

  it('defaults to a 30-day window', async () => {
    const now = Date.now();
    makeSession('h1', 'inside', now - 10 * DAY);
    makeSession('h2', 'outside', now - 45 * DAY);

    const found = await newAdapter().discoverSessions!();

    expect(found.map((d) => d.sessionId)).toEqual(['inside']);
  });

  it('sorts newest-first', async () => {
    const now = Date.now();
    makeSession('h1', 'older', now - 5 * DAY);
    makeSession('h2', 'newer', now - 1 * DAY);
    makeSession('h3', 'middle', now - 3 * DAY);

    const found = await newAdapter().discoverSessions!();

    expect(found.map((d) => d.sessionId)).toEqual(['newer', 'middle', 'older']);
  });

  it('applies limit after sort', async () => {
    const now = Date.now();
    makeSession('h1', 'older', now - 5 * DAY);
    makeSession('h2', 'newer', now - 1 * DAY);
    makeSession('h3', 'middle', now - 3 * DAY);

    const found = await newAdapter().discoverSessions!({ limit: 2 });

    expect(found.map((d) => d.sessionId)).toEqual(['newer', 'middle']);
  });

  it('excludes timestampless sessions by default', async () => {
    const chatsDir = join(geminiHome, 'tmp', 'hash-no-ts', 'chats');
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(
      join(chatsDir, 'no-ts.json'),
      JSON.stringify({ sessionId: 'no-ts', projectHash: 'hash-no-ts', messages: [] })
    );

    expect(await newAdapter().discoverSessions!()).toEqual([]);
  });

  it('includes timestampless sessions when asked', async () => {
    const chatsDir = join(geminiHome, 'tmp', 'hash-no-ts', 'chats');
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(
      join(chatsDir, 'no-ts.json'),
      JSON.stringify({ sessionId: 'no-ts', projectHash: 'hash-no-ts', messages: [] })
    );

    const found = await newAdapter().discoverSessions!({ includeTimestampless: true });
    expect(found.map((d) => d.sessionId)).toEqual(['no-ts']);
  });

  it('discovers sessions across multiple hash directories', async () => {
    const now = Date.now();
    makeSession('hash-a', 'sess-a', now - 1 * DAY);
    makeSession('hash-b', 'sess-b', now - 2 * DAY);

    const found = await newAdapter().discoverSessions!();

    expect(found.map((d) => d.sessionId)).toEqual(['sess-a', 'sess-b']);
  });
});
