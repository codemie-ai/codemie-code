/**
 * Unit tests for ClaudeLifecycleAdapter
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeLifecycleAdapter } from '../claude.lifecycle-adapter.js';
import { HistoryParser } from '../history-parser.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, 'fixtures');

describe('ClaudeLifecycleAdapter', () => {
  let adapter: ClaudeLifecycleAdapter;

  beforeEach(() => {
    adapter = new ClaudeLifecycleAdapter();
  });

  it('finds /clear in XML format', async () => {
    // Use fixture with <command-name>/clear</command-name>
    const parser = new HistoryParser(join(fixturesDir, 'history-single-clear.jsonl'));
    const result = await parser.findClearCommand('test-session-1', 1704672000000);

    expect(result).toBe(1704672100000); // Timestamp of /clear command
  });

  it('finds /clear in plain format', async () => {
    // Use fixture with /clear
    const parser = new HistoryParser(join(fixturesDir, 'history-multi-clear.jsonl'));
    const result = await parser.findClearCommand('test-session-2', 1704672000000);

    expect(result).toBe(1704672100000); // First /clear (plain format)
  });

  it('returns null if no /clear found', async () => {
    // Use fixture without /clear
    const parser = new HistoryParser(join(fixturesDir, 'history-no-clear.jsonl'));
    const result = await parser.findClearCommand('test-session-3', 1704672000000);

    expect(result).toBeNull();
  });

  it('returns null if /clear before afterTimestamp', async () => {
    // Use fixture with old /clear
    const parser = new HistoryParser(join(fixturesDir, 'history-old-clear.jsonl'));
    // Search after the /clear timestamp
    const result = await parser.findClearCommand('test-session-4', 1704672060000);

    expect(result).toBeNull(); // /clear is before afterTimestamp
  });

  it('handles missing history file', async () => {
    const parser = new HistoryParser(join(fixturesDir, 'non-existent.jsonl'));
    const result = await parser.findClearCommand('test-session-5', 1704672000000);

    expect(result).toBeNull(); // Should gracefully return null
  });

  it('finds first /clear when multiple exist', async () => {
    // Use fixture with multiple /clear commands
    const parser = new HistoryParser(join(fixturesDir, 'history-multi-clear.jsonl'));
    const result = await parser.findClearCommand('test-session-2', 1704672000000);

    expect(result).toBe(1704672100000); // First /clear, not the second one
  });

  it('adapter implements SessionLifecycleAdapter interface', () => {
    expect(adapter.detectSessionEnd).toBeDefined();
    expect(typeof adapter.detectSessionEnd).toBe('function');
  });

  it('adapter returns null for non-existent session', async () => {
    // This will use the default path (~/.claude/history.jsonl)
    // which likely doesn't have this test session
    const result = await adapter.detectSessionEnd('non-existent-session', Date.now());

    expect(result).toBeNull();
  });
});
