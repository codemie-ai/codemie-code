/**
 * Regression tests for duplicate SessionEnd handling.
 *
 * If stale-session reconciliation already finalized a session as interrupted,
 * a later real SessionEnd from the original long-lived process must not emit a
 * second end metric for the same CodeMie session. Likewise, repeated synthetic
 * SessionEnd deliveries for the same stranded session should emit at most one
 * terminal metric even without an inter-process lock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCodemiePath } from '../../../utils/paths.js';
import { getSessionPath } from '../../../agents/core/session/session-config.js';
import type { BaseHookEvent } from '../../../agents/core/types.js';
import type { HookProcessingConfig } from '../hook.js';

const mockSendSessionEnd = vi.fn().mockResolvedValue(undefined);
const mockSendSessionStart = vi.fn().mockResolvedValue(undefined);
const mockSync = vi.fn().mockResolvedValue({ success: true, message: 'ok' });

vi.mock('../../../providers/plugins/sso/index.js', () => ({
  MetricsSender: vi.fn(function (this: Record<string, unknown>) {
    this.sendSessionStart = mockSendSessionStart;
    this.sendSessionEnd = mockSendSessionEnd;
  })
}));

vi.mock('../../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function (this: Record<string, unknown>) {
    this.getStoredCredentials = vi.fn().mockResolvedValue({ cookies: { session: 'abc123' } });
  })
}));

vi.mock('../../../providers/plugins/sso/session/SessionSyncer.js', () => ({
  SessionSyncer: vi.fn(function (this: Record<string, unknown>) {
    this.sync = mockSync;
  })
}));

const TMP = join(tmpdir(), `codemie-hook-end-dedup-${process.pid}`);

function completedPath(sessionId: string): string {
  return getCodemiePath('sessions', `completed_${sessionId}.json`);
}

function cleanupSession(sessionId: string): void {
  for (const p of [getSessionPath(sessionId), completedPath(sessionId)]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  for (const suffix of ['_metrics.jsonl', '_conversation.jsonl']) {
    const p = getCodemiePath('sessions', `${sessionId}${suffix}`);
    if (existsSync(p)) rmSync(p, { force: true });
    const c = getCodemiePath('sessions', `completed_${sessionId}${suffix}`);
    if (existsSync(c)) rmSync(c, { force: true });
  }
}

function transcriptFile(name: string): string {
  const p = join(TMP, `${name}.jsonl`);
  writeFileSync(p, '{"type":"user"}\n');
  return p;
}

describe('hook.ts SessionEnd metric de-duplication', () => {
  const baseConfig: Omit<HookProcessingConfig, 'sessionId'> = {
    agentName: 'claude',
    provider: 'ai-run-sso',
    ssoUrl: 'https://sso.example.invalid',
    syncApiUrl: 'https://api.example.invalid',
  };

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    mkdirSync(getCodemiePath('sessions'), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not emit a second end metric when a reconciled interrupted session later ends for real', async () => {
    const sessionId = 'test-duplicate-real-end';
    const claudeSessionId = 'claude-duplicate-real-end';
    const transcriptPath = transcriptFile('duplicate-real-end');
    cleanupSession(sessionId);

    const interruptedAt = Date.now() - 2 * 60 * 60 * 1000;
    writeFileSync(
      completedPath(sessionId),
      JSON.stringify({
        sessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: interruptedAt - 30 * 60 * 1000,
        endTime: interruptedAt,
        workingDirectory: process.cwd(),
        status: 'completed',
        reason: 'interrupted',
        activeDurationMs: 5 * 60 * 1000,
        correlation: {
          status: 'matched',
          agentSessionId: claudeSessionId,
          agentSessionFile: transcriptPath,
          retryCount: 0,
        },
      })
    );

    const { processEvent } = await import('../hook.js');
    const event = {
      session_id: claudeSessionId,
      hook_event_name: 'SessionEnd',
      transcript_path: transcriptPath,
      permission_mode: 'default',
      cwd: process.cwd(),
      reason: 'exit',
    } as unknown as BaseHookEvent;

    await processEvent(event, { ...baseConfig, sessionId });

    expect(mockSendSessionEnd).not.toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(completedPath(sessionId), 'utf-8'));
    expect(saved.reason).toBe('interrupted');
    expect(saved.endTime).toBe(interruptedAt);
  });

  it('emits at most one end metric when the same stranded session is finalized twice', async () => {
    const sessionId = 'test-duplicate-synthetic-end';
    const claudeSessionId = 'claude-duplicate-synthetic-end';
    const transcriptPath = transcriptFile('duplicate-synthetic-end');
    cleanupSession(sessionId);

    writeFileSync(
      getSessionPath(sessionId),
      JSON.stringify({
        sessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now() - 2 * 60 * 60 * 1000,
        workingDirectory: process.cwd(),
        status: 'active',
        activeDurationMs: 0,
        correlation: {
          status: 'matched',
          agentSessionId: claudeSessionId,
          agentSessionFile: transcriptPath,
          retryCount: 0,
        },
      })
    );

    const { processEvent } = await import('../hook.js');
    const interruptedAt = Date.now() - 60 * 60 * 1000;
    const event = {
      session_id: claudeSessionId,
      hook_event_name: 'SessionEnd',
      transcript_path: transcriptPath,
      permission_mode: 'default',
      cwd: process.cwd(),
      reason: 'interrupted',
      endTime: interruptedAt,
    } as unknown as BaseHookEvent;

    await processEvent(event, { ...baseConfig, sessionId });
    await processEvent(event, { ...baseConfig, sessionId });

    expect(mockSendSessionEnd).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(readFileSync(completedPath(sessionId), 'utf-8'));
    expect(saved.status).toBe('completed');
    expect(saved.reason).toBe('interrupted');
  });
});
