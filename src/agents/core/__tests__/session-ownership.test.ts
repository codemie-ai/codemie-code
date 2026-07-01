import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanSessionsForClaudeId } from '../session/session-ownership.js';

const TMP = join(tmpdir(), `codemie-ownership-test-${process.pid}`);

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function writeSession(id: string, claudeSessionId: string): void {
  writeFileSync(
    join(TMP, `${id}.json`),
    JSON.stringify({ correlation: { agentSessionId: claudeSessionId } }),
  );
}

describe('scanSessionsForClaudeId', () => {
  it('returns true when a session file has a matching agentSessionId', () => {
    writeSession('codemie-1', 'claude-abc-123');
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(true);
  });

  it('returns false when no session matches', () => {
    writeSession('codemie-1', 'claude-other');
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(false);
  });

  it('returns false when sessions dir is empty', () => {
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(false);
  });

  it('returns false when sessions dir does not exist', () => {
    expect(scanSessionsForClaudeId('id', '/nonexistent/path')).toBe(false);
  });

  it('skips malformed JSON files without throwing', () => {
    writeFileSync(join(TMP, 'bad.json'), 'not json{{{');
    writeSession('codemie-1', 'claude-abc-123');
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(true);
  });

  it('skips _metrics.json files', () => {
    writeFileSync(join(TMP, 'session1_metrics.json'), JSON.stringify({ correlation: { agentSessionId: 'claude-abc-123' } }));
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(false);
  });

  it('does not skip a session file whose name contains _metrics but does not end with _metrics.json', () => {
    writeFileSync(join(TMP, 'my_metrics_session.json'), JSON.stringify({ correlation: { agentSessionId: 'claude-abc-123' } }));
    expect(scanSessionsForClaudeId('claude-abc-123', TMP)).toBe(true);
  });
});
