import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanSessionsForClaudeId,
  resolveClaudeResumeSession,
} from '../session/session-ownership.js';

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

interface RecordFixture {
  sessionId: string;
  agentName?: string;
  agentSessionId?: string;
}

function writeRecord(fileName: string, fixture: RecordFixture): void {
  const record: Record<string, unknown> = {
    sessionId: fixture.sessionId,
    agentName: fixture.agentName ?? 'claude',
  };
  if (fixture.agentSessionId !== undefined) {
    record.correlation = { agentSessionId: fixture.agentSessionId };
  }
  writeFileSync(join(TMP, fileName), JSON.stringify(record));
}

describe('resolveClaudeResumeSession', () => {
  it('resolves a native id to itself', () => {
    writeRecord('cm-1.json', { sessionId: 'cm-1', agentSessionId: 'native-1' });
    expect(resolveClaudeResumeSession('native-1', TMP)).toEqual({
      owned: true,
      nativeId: 'native-1',
      codemieSessionId: 'cm-1',
    });
  });

  it('resolves a CodeMie id from a completed file to its native id', () => {
    writeRecord('completed_cm-1.json', { sessionId: 'cm-1', agentSessionId: 'native-1' });
    expect(resolveClaudeResumeSession('cm-1', TMP)).toEqual({
      owned: true,
      nativeId: 'native-1',
      codemieSessionId: 'cm-1',
    });
  });

  it('resolves a CodeMie id from a live (non-completed) record', () => {
    writeRecord('cm-2.json', { sessionId: 'cm-2', agentSessionId: 'native-2' });
    expect(resolveClaudeResumeSession('cm-2', TMP).nativeId).toBe('native-2');
  });

  it('resolves a claude-acp record by its CodeMie id', () => {
    writeRecord('cm-acp.json', { sessionId: 'cm-acp', agentName: 'claude-acp', agentSessionId: 'native-acp' });
    expect(resolveClaudeResumeSession('cm-acp', TMP).nativeId).toBe('native-acp');
  });

  it('resolves the <uuid>-<generation> id shown by analytics to that generation', () => {
    writeRecord('completed_cm-3-gen_a.json', { sessionId: 'cm-3', agentSessionId: 'n-a' });
    writeRecord('completed_cm-3-gen_b.json', { sessionId: 'cm-3', agentSessionId: 'n-b' });
    expect(resolveClaudeResumeSession('cm-3-gen_a', TMP).nativeId).toBe('n-a');
    expect(resolveClaudeResumeSession('cm-3-gen_b', TMP).nativeId).toBe('n-b');
  });

  it('prefers the newest generation file for a bare CodeMie id', () => {
    writeRecord('completed_cm-3-gen_a.json', { sessionId: 'cm-3', agentSessionId: 'n-a' });
    writeRecord('completed_cm-3-gen_b.json', { sessionId: 'cm-3', agentSessionId: 'n-b' });
    utimesSync(join(TMP, 'completed_cm-3-gen_a.json'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    utimesSync(join(TMP, 'completed_cm-3-gen_b.json'), new Date(2026, 5, 1), new Date(2026, 5, 1));
    expect(resolveClaudeResumeSession('cm-3', TMP).nativeId).toBe('n-b');
  });

  it.each([
    ['has no correlation', undefined],
    ['has agentSessionId "unknown"', 'unknown'],
    ['has agentSessionId equal to its own sessionId', 'cm-6'],
  ])('returns owned without a nativeId when the record %s', (_label, agentSessionId) => {
    writeRecord('completed_cm-6.json', { sessionId: 'cm-6', agentSessionId });
    expect(resolveClaudeResumeSession('cm-6', TMP)).toEqual({
      owned: true,
      nativeId: undefined,
      codemieSessionId: 'cm-6',
    });
  });

  it('does not resolve a CodeMie id that belongs to another agent', () => {
    writeRecord('completed_cm-4.json', { sessionId: 'cm-4', agentName: 'opencode', agentSessionId: 'oc-native' });
    expect(resolveClaudeResumeSession('cm-4', TMP)).toEqual({ owned: false });
  });

  it('returns owned: false for an unknown id', () => {
    writeRecord('completed_cm-1.json', { sessionId: 'cm-1', agentSessionId: 'native-1' });
    expect(resolveClaudeResumeSession('nope', TMP)).toEqual({ owned: false });
  });

  it('returns owned: false when the dir is empty or missing', () => {
    expect(resolveClaudeResumeSession('x', TMP)).toEqual({ owned: false });
    expect(resolveClaudeResumeSession('x', join(TMP, 'missing'))).toEqual({ owned: false });
  });

  it('prefers a native-id match over a CodeMie-id match', () => {
    writeRecord('a.json', { sessionId: 'x', agentSessionId: 'native-a' });
    writeRecord('b.json', { sessionId: 'b', agentSessionId: 'x' });
    expect(resolveClaudeResumeSession('x', TMP)).toEqual({
      owned: true,
      nativeId: 'x',
      codemieSessionId: 'b',
    });
  });

  it('ignores ownership marker files', () => {
    writeFileSync(
      join(TMP, 'abc12345-cm-5-codemie-marker.json'),
      JSON.stringify({ codemieSessionId: 'cm-5', sessionId: 'cm-5', transcriptPath: '/x/native-5.jsonl' }),
    );
    expect(resolveClaudeResumeSession('cm-5', TMP).owned).toBe(false);
  });
});
