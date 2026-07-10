import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendSessionStart = vi.fn().mockResolvedValue(undefined);
const mockSendSessionEnd = vi.fn().mockResolvedValue(undefined);

vi.mock('@/providers/plugins/sso/index.js', () => ({
  MetricsSender: vi.fn(function (this: Record<string, unknown>) {
    this.sendSessionStart = mockSendSessionStart;
    this.sendSessionEnd = mockSendSessionEnd;
  })
}));

vi.mock('@/agents/core/session/SessionStore.js', () => ({
  SessionStore: vi.fn(function (this: Record<string, unknown>) {
    this.findSessionByExternalId = vi.fn().mockResolvedValue(null);
    this.saveSession = vi.fn().mockResolvedValue(undefined);
    this.loadSession = vi.fn().mockResolvedValue(null);
  })
}));

vi.mock('@/providers/plugins/sso/session/SessionSyncer.js', () => ({
  SessionSyncer: vi.fn(function (this: Record<string, unknown>) {
    this.sync = vi.fn().mockResolvedValue({ message: 'ok' });
  })
}));

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function (this: Record<string, unknown>) {
    this.getStoredCredentials = vi.fn().mockResolvedValue({ cookies: { session: 'abc123' } });
  })
}));

vi.mock('@/utils/processes.js', () => ({
  detectGitRemoteRepo: vi.fn().mockResolvedValue('codemie-ai/codemie-code'),
  detectGitBranch: vi.fn().mockResolvedValue('main')
}));

vi.mock('@/telemetry/runtime/checkpoints.js', () => ({
  setRuntimeCheckpoint: vi.fn()
}));

import { DesktopTelemetryRuntime } from '../DesktopTelemetryRuntime.js';
import type {
  LocalTelemetryAdapter,
  DesktopTelemetryRuntimeConfig,
  LocalTelemetryDiscoveredSession
} from '../types.js';

const config: DesktopTelemetryRuntimeConfig = {
  clientType: 'claude',
  targetApiUrl: 'https://api.example.com',
  provider: 'ai-run-sso',
  version: '1.0.0',
  pollIntervalMs: 5000,
  inactivityTimeoutMs: 300000
};

const discovered: LocalTelemetryDiscoveredSession = {
  externalSessionId: 'ext-session-1',
  agentSessionId: 'agent-session-1',
  transcriptPath: '/tmp/transcript.jsonl',
  metadataPath: '/tmp/metadata.json',
  workingDirectory: '/Users/test/codemie-ai/codemie-code',
  createdAt: Date.now() - 1000,
  updatedAt: Date.now(),
  model: 'claude-sonnet-5'
};

const mockAdapter: LocalTelemetryAdapter = {
  clientType: 'claude',
  discoverSessions: vi.fn().mockResolvedValue([discovered]),
  parseSession: vi.fn().mockResolvedValue({ records: [] }),
  processParsedSession: vi.fn().mockResolvedValue({ totalRecords: 0 })
};

describe('DesktopTelemetryRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards session.repository to MetricsSender.sendSessionStart', async () => {
    const runtime = new DesktopTelemetryRuntime(mockAdapter, config);
    await (runtime as any).ensureSession(discovered);

    expect(mockSendSessionStart).toHaveBeenCalledOnce();
    const [sessionArg] = mockSendSessionStart.mock.calls[0];
    expect(sessionArg).toMatchObject({ repository: 'codemie-ai/codemie-code' });
  });

  it('forwards session.repository to MetricsSender.sendSessionEnd', async () => {
    const mockSessionStore = {
      findSessionByExternalId: vi.fn().mockResolvedValue(null),
      saveSession: vi.fn().mockResolvedValue(undefined),
      loadSession: vi.fn()
    };

    const runtime = new DesktopTelemetryRuntime(mockAdapter, config);
    const session = await (runtime as any).ensureSession(discovered);

    mockSessionStore.loadSession.mockResolvedValue({ ...session, status: 'active' });
    (runtime as any).sessionStore.loadSession = mockSessionStore.loadSession;

    await (runtime as any).finalizeSession(session.sessionId, 'test-reason');

    expect(mockSendSessionEnd).toHaveBeenCalledOnce();
    const [sessionArg] = mockSendSessionEnd.mock.calls[0];
    expect(sessionArg).toMatchObject({ repository: 'codemie-ai/codemie-code' });
  });
});
