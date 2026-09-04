/**
 * Verifies that hook.ts:sendSessionEndMetrics reads the per-session metrics-delta JSONL
 * file and sums MetricDelta.tokens into a `tokens` argument passed as the 7th positional
 * argument to MetricsSender.sendSessionEnd, and that a missing/empty delta file still
 * yields a session-end call (with zeroed token totals) rather than throwing.
 *
 * Uses the same MetricsSender/CodeMieSSO module-mock pattern as hook.session-origin.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCodemiePath } from '../../../utils/paths.js';
import { getSessionPath } from '../../../agents/core/session/session-config.js';
import type { HookProcessingConfig } from '../hook.js';

const mockSendSessionEnd = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../providers/plugins/sso/index.js', () => ({
  MetricsSender: vi.fn(function (this: Record<string, unknown>) {
    this.sendSessionEnd = mockSendSessionEnd;
  })
}));

vi.mock('../../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function (this: Record<string, unknown>) {
    this.getStoredCredentials = vi.fn().mockResolvedValue({ cookies: { session: 'abc123' } });
  })
}));

const TMP = join(tmpdir(), `codemie-hook-session-end-tokens-${process.pid}`);

function sessionFilePath(sessionId: string): string {
  return getSessionPath(sessionId);
}

function metricsFilePath(sessionId: string): string {
  return getCodemiePath('sessions', `${sessionId}_metrics.jsonl`);
}

function cleanupSession(sessionId: string): void {
  for (const p of [sessionFilePath(sessionId), metricsFilePath(sessionId)]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

describe('hook.ts sendSessionEndMetrics token accumulation', () => {
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

  it('sums MetricDelta.tokens from the delta file into the 7th sendSessionEnd argument', async () => {
    const sessionId = 'test-session-end-tokens-present';
    const claudeSessionId = 'claude-tokens-1';
    cleanupSession(sessionId);

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
        correlation: {
          status: 'matched',
          agentSessionId: claudeSessionId,
          agentSessionFile: join(TMP, `${claudeSessionId}.jsonl`),
          retryCount: 0,
        },
      })
    );

    const deltaLines = [
      { recordId: 'r1', sessionId, agentSessionId: claudeSessionId, timestamp: Date.now(), syncStatus: 'pending', syncAttempts: 0, tokens: { input: 100, output: 40, cacheRead: 5 } },
      { recordId: 'r2', sessionId, agentSessionId: claudeSessionId, timestamp: Date.now(), syncStatus: 'pending', syncAttempts: 0, tokens: { input: 20, output: 10 } },
    ];
    writeFileSync(metricsFilePath(sessionId), deltaLines.map((d) => JSON.stringify(d)).join('\n') + '\n');

    const { processEvent } = await import('../hook.js');
    const event = {
      session_id: claudeSessionId,
      hook_event_name: 'SessionEnd',
      // Nonexistent transcript path — incremental sync warns and skips without
      // touching the metrics file we just wrote (matches hook.session-origin.test.ts).
      transcript_path: join(TMP, `${claudeSessionId}.jsonl`),
      permission_mode: 'default',
      cwd: process.cwd(),
      reason: 'exit',
    } as unknown as Parameters<typeof processEvent>[0];

    await processEvent(event, { ...baseConfig, sessionId });

    expect(mockSendSessionEnd).toHaveBeenCalledTimes(1);
    const tokensArg = mockSendSessionEnd.mock.calls[0][6];
    expect(tokensArg).toEqual({ input: 120, output: 50, cacheRead: 5, cacheCreation: 0 });

    cleanupSession(sessionId);
  });

  it('still sends session end with zeroed tokens when the delta file is missing', async () => {
    const sessionId = 'test-session-end-tokens-missing';
    const claudeSessionId = 'claude-tokens-2';
    cleanupSession(sessionId);

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
        correlation: {
          status: 'matched',
          agentSessionId: claudeSessionId,
          agentSessionFile: join(TMP, `${claudeSessionId}.jsonl`),
          retryCount: 0,
        },
      })
    );

    expect(existsSync(metricsFilePath(sessionId))).toBe(false);

    const { processEvent } = await import('../hook.js');
    const event = {
      session_id: claudeSessionId,
      hook_event_name: 'SessionEnd',
      transcript_path: join(TMP, `${claudeSessionId}.jsonl`),
      permission_mode: 'default',
      cwd: process.cwd(),
      reason: 'exit',
    } as unknown as Parameters<typeof processEvent>[0];

    await expect(processEvent(event, { ...baseConfig, sessionId })).resolves.not.toThrow();

    expect(mockSendSessionEnd).toHaveBeenCalledTimes(1);
    const tokensArg = mockSendSessionEnd.mock.calls[0][6];
    expect(tokensArg).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

    cleanupSession(sessionId);
  });
});
