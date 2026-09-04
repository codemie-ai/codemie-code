import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GeminiSessionAdapter } from '../gemini.session-adapter.js';
import { GeminiPluginMetadata } from '../gemini.plugin.js';

let geminiHome: string;

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

describe('GeminiSessionAdapter JSONL and Deduplication', () => {
  it('discovers and parses metadata for .jsonl session files', async () => {
    const chatsDir = join(geminiHome, 'tmp', 'hash-jsonl', 'chats');
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, 'sess-jsonl.jsonl');

    const lines = [
      JSON.stringify({ sessionId: 'sess-jsonl', projectHash: 'hash-jsonl', startTime: new Date().toISOString() }),
      JSON.stringify({ $set: { lastUpdated: new Date().toISOString() } }),
    ];
    writeFileSync(filePath, lines.join('\n'));

    const found = await newAdapter().discoverSessions!();
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe('sess-jsonl');
    expect(found[0].filePath).toBe(filePath);
  });

  it('parses .jsonl with line-by-line stream chunks and reconstructs messages', async () => {
    const chatsDir = join(geminiHome, 'tmp', 'hash-stream', 'chats');
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, 'sess-stream.jsonl');

    const lines = [
      JSON.stringify({ sessionId: 'sess-stream', projectHash: 'hash-stream', startTime: '2026-09-03T00:00:00.000Z' }),
      JSON.stringify({ id: 'msg-1', type: 'user', timestamp: '2026-09-03T00:00:01.000Z', content: 'hello' }),
      JSON.stringify({ id: 'msg-2', type: 'gemini', timestamp: '2026-09-03T00:00:02.000Z', content: 'hi there', tokens: { input: 10, output: 5, cached: 0, thoughts: 0, tool: 0, total: 15 } }),
    ];
    writeFileSync(filePath, lines.join('\n'));

    const parsed = await newAdapter().parseSessionFile(filePath, 'sess-stream');
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].id).toBe('msg-1');
    expect(parsed.messages[1].id).toBe('msg-2');
    expect(parsed.messages[1].tokens?.total).toBe(15);
  });

  it('deduplicates turn-level messages by merging fields in-place for identical message IDs', async () => {
    const chatsDir = join(geminiHome, 'tmp', 'hash-dedup', 'chats');
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, 'sess-dedup.jsonl');

    const lines = [
      JSON.stringify({ sessionId: 'sess-dedup', projectHash: 'hash-dedup', startTime: '2026-09-03T00:00:00.000Z' }),
      JSON.stringify({ id: 'msg-1', type: 'gemini', timestamp: '2026-09-03T00:00:01.000Z', content: 'partial thinking...' }),
      // Update of same message with complete content and tokens
      JSON.stringify({ id: 'msg-1', type: 'gemini', timestamp: '2026-09-03T00:00:01.000Z', content: 'final complete response', tokens: { input: 20, output: 10, cached: 5, thoughts: 5, tool: 2, total: 42 } }),
    ];
    writeFileSync(filePath, lines.join('\n'));

    const parsed = await newAdapter().parseSessionFile(filePath, 'sess-dedup');
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].id).toBe('msg-1');
    expect(parsed.messages[0].content).toBe('final complete response');
    expect(parsed.messages[0].tokens?.total).toBe(42);
    expect(parsed.messages[0].tokens?.cached).toBe(5);
  });

  it('supports legacy .json session files perfectly', async () => {
    const chatsDir = join(geminiHome, 'tmp', 'hash-legacy', 'chats');
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, 'sess-legacy.json');

    const sessionData = {
      sessionId: 'sess-legacy',
      projectHash: 'hash-legacy',
      startTime: '2026-09-03T00:00:00.000Z',
      lastUpdated: '2026-09-03T00:00:01.000Z',
      messages: [
        { id: 'msg-1', type: 'user', timestamp: '2026-09-03T00:00:01.000Z', content: 'legacy standard user' },
      ],
    };
    writeFileSync(filePath, JSON.stringify(sessionData));

    const parsed = await newAdapter().parseSessionFile(filePath, 'sess-legacy');
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].id).toBe('msg-1');
    expect(parsed.messages[0].content).toBe('legacy standard user');
  });
});
