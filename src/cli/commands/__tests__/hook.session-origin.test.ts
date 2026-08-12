/**
 * Regression tests for EPMCDME-12992: a confirmed external-resume session must never
 * upload anything (lifecycle metrics or conversations), and its transcript must never be
 * (re-)stamped with a CodeMie ownership marker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCodemiePath } from '../../../utils/paths.js';
import { getSessionPath } from '../../../agents/core/session/session-config.js';
import type { BaseHookEvent } from '../../../agents/core/types.js';
import type { HookProcessingConfig } from '../hook.js';

const mockSendSessionStart = vi.fn().mockResolvedValue(undefined);
const mockSendSessionEnd = vi.fn().mockResolvedValue(undefined);

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

const TMP = join(tmpdir(), `codemie-hook-origin-test-${process.pid}`);

function sessionFilePath(sessionId: string): string {
  return getSessionPath(sessionId);
}

function markerFilePath(claudeSessionId: string): string {
  return getCodemiePath('sessions', `${claudeSessionId}-codemie-marker.json`);
}

function cleanupSession(sessionId: string, claudeSessionId: string): void {
  const p = sessionFilePath(sessionId);
  if (existsSync(p)) rmSync(p, { force: true });
  const m = markerFilePath(claudeSessionId);
  if (existsSync(m)) rmSync(m, { force: true });
}

describe('hook.ts external-resume origin gating', () => {
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
    delete process.env.CODEMIE_SESSION_ORIGIN;
  });

  afterEach(() => {
    delete process.env.CODEMIE_SESSION_ORIGIN;
    rmSync(TMP, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('persists origin=external-resume and skips start metrics + marker write for a confirmed external resume', async () => {
    const sessionId = 'test-origin-external-start';
    const claudeSessionId = 'claude-ext-1';
    const transcriptPath = join(TMP, `${claudeSessionId}.jsonl`);
    writeFileSync(transcriptPath, '{"type":"user"}\n');
    cleanupSession(sessionId, claudeSessionId);

    process.env.CODEMIE_SESSION_ORIGIN = 'external-resume';

    const { processEvent } = await import('../hook.js');
    const event: BaseHookEvent = {
      session_id: claudeSessionId,
      hook_event_name: 'SessionStart',
      transcript_path: transcriptPath,
      permission_mode: 'default',
      cwd: process.cwd(),
    } as BaseHookEvent & { source: string };
    (event as unknown as { source: string }).source = 'startup';

    await processEvent(event, { ...baseConfig, sessionId });

    // Origin persisted on the Session record.
    const saved = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'));
    expect(saved.origin).toBe('external-resume');

    // No lifecycle metrics uploaded.
    expect(mockSendSessionStart).not.toHaveBeenCalled();

    // No ownership marker written (sidecar or in-band) — must not re-adopt the transcript.
    expect(existsSync(markerFilePath(claudeSessionId))).toBe(false);
    const transcriptContent = readFileSync(transcriptPath, 'utf-8');
    expect(transcriptContent).not.toContain('codemie_session_start');

    cleanupSession(sessionId, claudeSessionId);
  });

  it('persists no origin and uploads start metrics + marker for a normal CodeMie session', async () => {
    const sessionId = 'test-origin-codemie-start';
    const claudeSessionId = 'claude-normal-1';
    const transcriptPath = join(TMP, `${claudeSessionId}.jsonl`);
    writeFileSync(transcriptPath, '{"type":"user"}\n');
    cleanupSession(sessionId, claudeSessionId);

    const { processEvent } = await import('../hook.js');
    const event: BaseHookEvent = {
      session_id: claudeSessionId,
      hook_event_name: 'SessionStart',
      transcript_path: transcriptPath,
      permission_mode: 'default',
      cwd: process.cwd(),
    } as BaseHookEvent & { source: string };
    (event as unknown as { source: string }).source = 'startup';

    await processEvent(event, { ...baseConfig, sessionId });

    const saved = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'));
    expect(saved.origin).toBeUndefined();

    expect(mockSendSessionStart).toHaveBeenCalledTimes(1);
    expect(existsSync(markerFilePath(claudeSessionId))).toBe(true);

    cleanupSession(sessionId, claudeSessionId);
  });

  it('skips end metrics for a session already flagged external-resume', async () => {
    const sessionId = 'test-origin-external-end';
    const claudeSessionId = 'claude-ext-end-1';
    cleanupSession(sessionId, claudeSessionId);

    writeFileSync(
      sessionFilePath(sessionId),
      JSON.stringify({
        sessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now() - 1000,
        workingDirectory: process.cwd(),
        status: 'active',
        activeDurationMs: 0,
        origin: 'external-resume',
        correlation: {
          status: 'matched',
          agentSessionId: claudeSessionId,
          agentSessionFile: join(TMP, `${claudeSessionId}.jsonl`),
          retryCount: 0,
        },
      })
    );

    const { processEvent } = await import('../hook.js');
    const event = {
      session_id: claudeSessionId,
      hook_event_name: 'SessionEnd',
      transcript_path: join(TMP, `${claudeSessionId}.jsonl`),
      permission_mode: 'default',
      cwd: process.cwd(),
      reason: 'exit',
    } as unknown as BaseHookEvent;

    await processEvent(event, { ...baseConfig, sessionId });

    expect(mockSendSessionEnd).not.toHaveBeenCalled();

    cleanupSession(sessionId, claudeSessionId);
  });
});
