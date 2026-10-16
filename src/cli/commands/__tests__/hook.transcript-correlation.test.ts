/**
 * Regression tests for #523: correlation must reflect whether the reported transcript
 * was persisted, judged at SessionEnd. Claude Code reports transcript_path at startup
 * but only creates the file once the conversation begins, so SessionStart must not
 * downgrade a not-yet-existing transcript.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { getCodemiePath } from '../../../utils/paths.js';
import { getSessionPath } from '../../../agents/core/session/session-config.js';
import type { BaseHookEvent } from '../../../agents/core/types.js';
import type { HookProcessingConfig } from '../hook.js';

const TMP = join(tmpdir(), `codemie-hook-correlation-test-${process.pid}`);

// A non-SSO provider without analytics URLs keeps SessionEnd off the network.
const baseConfig: Omit<HookProcessingConfig, 'sessionId'> = {
  agentName: 'claude',
  provider: 'litellm',
};

function completedSessionPath(sessionId: string): string {
  const path = getSessionPath(sessionId);
  return join(dirname(path), `completed_${basename(path)}`);
}

function readCorrelationStatus(sessionId: string): string | undefined {
  const path = existsSync(getSessionPath(sessionId)) ? getSessionPath(sessionId) : completedSessionPath(sessionId);
  return JSON.parse(readFileSync(path, 'utf-8')).correlation?.status;
}

function cleanupSession(sessionId: string, claudeSessionId: string): void {
  for (const path of [
    getSessionPath(sessionId),
    completedSessionPath(sessionId),
    getCodemiePath('sessions', `${claudeSessionId}-codemie-marker.json`),
  ]) {
    rmSync(path, { force: true });
  }
}

function writeActiveSession(sessionId: string, claudeSessionId: string, transcriptPath: string): void {
  writeFileSync(
    getSessionPath(sessionId),
    JSON.stringify({
      sessionId,
      agentName: 'claude',
      provider: 'litellm',
      startTime: Date.now() - 1000,
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
}

function sessionEndEvent(claudeSessionId: string, transcriptPath: string): BaseHookEvent {
  return {
    session_id: claudeSessionId,
    hook_event_name: 'SessionEnd',
    transcript_path: transcriptPath,
    permission_mode: 'default',
    cwd: process.cwd(),
    reason: 'exit',
  } as unknown as BaseHookEvent;
}

describe('hook.ts transcript correlation (#523)', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    mkdirSync(getCodemiePath('sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps correlation matched at SessionStart when the reported transcript does not exist yet', async () => {
    const sessionId = 'test-correlation-start-pending';
    const claudeSessionId = 'claude-correlation-start-1';
    cleanupSession(sessionId, claudeSessionId);

    const { processEvent } = await import('../hook.js');
    const event = {
      session_id: claudeSessionId,
      hook_event_name: 'SessionStart',
      transcript_path: join(TMP, `${claudeSessionId}.jsonl`),
      permission_mode: 'default',
      cwd: process.cwd(),
      source: 'startup',
    } as unknown as BaseHookEvent;

    await processEvent(event, { ...baseConfig, sessionId });

    expect(readCorrelationStatus(sessionId)).toBe('matched');

    cleanupSession(sessionId, claudeSessionId);
  });

  it('marks correlation file_not_found at SessionEnd when the reported transcript was never persisted', async () => {
    const sessionId = 'test-correlation-end-missing';
    const claudeSessionId = 'claude-correlation-end-1';
    const transcriptPath = join(TMP, `${claudeSessionId}.jsonl`);
    cleanupSession(sessionId, claudeSessionId);
    writeActiveSession(sessionId, claudeSessionId, transcriptPath);

    const { processEvent } = await import('../hook.js');
    await processEvent(sessionEndEvent(claudeSessionId, transcriptPath), { ...baseConfig, sessionId });

    expect(readCorrelationStatus(sessionId)).toBe('file_not_found');

    cleanupSession(sessionId, claudeSessionId);
  });

  it('keeps correlation matched at SessionEnd when the transcript was created after SessionStart', async () => {
    const sessionId = 'test-correlation-end-present';
    const claudeSessionId = 'claude-correlation-end-2';
    const transcriptPath = join(TMP, `${claudeSessionId}.jsonl`);
    cleanupSession(sessionId, claudeSessionId);
    writeActiveSession(sessionId, claudeSessionId, transcriptPath);
    writeFileSync(transcriptPath, '{"type":"user"}\n');

    const { processEvent } = await import('../hook.js');
    await processEvent(sessionEndEvent(claudeSessionId, transcriptPath), { ...baseConfig, sessionId });

    expect(readCorrelationStatus(sessionId)).toBe('matched');

    cleanupSession(sessionId, claudeSessionId);
  });
});
