// src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateSessionReportMock = vi.fn();
vi.mock('../../../cli/commands/analytics/report/session-report.js', () => ({
  generateSessionReport: (...a: unknown[]) => generateSessionReportMock(...a),
}));
vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setSessionId: vi.fn(), setAgentName: vi.fn(), setProfileName: vi.fn() },
}));

const loadMultiProviderConfigMock = vi.fn();
vi.mock('../../../utils/config.js', () => ({
  ConfigLoader: {
    loadMultiProviderConfig: (...a: unknown[]) => loadMultiProviderConfigMock(...a),
  },
}));

import { BaseAgentAdapter } from '../BaseAgentAdapter.js';
import type { AgentMetadata } from '../types.js';

class TestAdapter extends BaseAgentAdapter {
  constructor(meta: Partial<AgentMetadata>) {
    super({ name: 't', displayName: 'T', description: 'd', envMapping: {}, supportedProviders: [], ...meta } as AgentMetadata);
  }
  // expose the private method for testing
  call(env: NodeJS.ProcessEnv) { return (this as unknown as { maybeWriteSessionReport(e: NodeJS.ProcessEnv): Promise<void> }).maybeWriteSessionReport(env); }
}

const baseEnv = { CODEMIE_SESSION_ID: 's1' } as NodeJS.ProcessEnv;

describe('BaseAgentAdapter.maybeWriteSessionReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateSessionReportMock.mockResolvedValue({ written: '/x.json', sessions: 1 });
    loadMultiProviderConfigMock.mockResolvedValue({ userEmail: undefined });
  });

  it('generates a report when enabled', async () => {
    await new TestAdapter({ sessionAnalyticsReport: true }).call(baseEnv);
    expect(generateSessionReportMock).toHaveBeenCalledTimes(1);
    const arg = generateSessionReportMock.mock.calls[0][0];
    expect(arg.sessionId).toBe('s1');
    // outputPath is now derived inside session-report.ts; adapter passes sessionId + optional userEmail only
    expect(arg.outputPath).toBeUndefined();
  });

  it('extracts userEmail from CODEMIE_PROFILE_CONFIG and passes it to generateSessionReport', async () => {
    const env = {
      ...baseEnv,
      CODEMIE_PROFILE_CONFIG: JSON.stringify({ userEmail: 'carol@example.com' }),
    } as NodeJS.ProcessEnv;
    await new TestAdapter({ sessionAnalyticsReport: true }).call(env);
    expect(generateSessionReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'carol@example.com' })
    );
  });

  it('omits userEmail when CODEMIE_PROFILE_CONFIG has no email', async () => {
    const env = {
      ...baseEnv,
      CODEMIE_PROFILE_CONFIG: JSON.stringify({ someOtherField: 'value' }),
    } as NodeJS.ProcessEnv;
    await new TestAdapter({ sessionAnalyticsReport: true }).call(env);
    const arg = generateSessionReportMock.mock.calls[0][0];
    expect(arg.userEmail).toBeUndefined();
  });

  it('omits userEmail gracefully when CODEMIE_PROFILE_CONFIG is malformed JSON', async () => {
    const env = { ...baseEnv, CODEMIE_PROFILE_CONFIG: 'not-json' } as NodeJS.ProcessEnv;
    await expect(new TestAdapter({ sessionAnalyticsReport: true }).call(env)).resolves.toBeUndefined();
    const arg = generateSessionReportMock.mock.calls[0][0];
    expect(arg.userEmail).toBeUndefined();
  });

  it('skips when metadata flag is not set', async () => {
    await new TestAdapter({}).call(baseEnv);
    expect(generateSessionReportMock).not.toHaveBeenCalled();
  });

  it('skips when disabled via env kill-switch', async () => {
    await new TestAdapter({ sessionAnalyticsReport: true }).call({ ...baseEnv, CODEMIE_SESSION_ANALYTICS_REPORT: '0' });
    expect(generateSessionReportMock).not.toHaveBeenCalled();
  });

  it('skips when there is no session id', async () => {
    await new TestAdapter({ sessionAnalyticsReport: true }).call({} as NodeJS.ProcessEnv);
    expect(generateSessionReportMock).not.toHaveBeenCalled();
  });

  it('never throws when report generation fails (non-fatal)', async () => {
    generateSessionReportMock.mockRejectedValue(new Error('boom'));
    await expect(new TestAdapter({ sessionAnalyticsReport: true }).call(baseEnv)).resolves.toBeUndefined();
  });

  it('falls back to ConfigLoader.loadMultiProviderConfig when CODEMIE_PROFILE_CONFIG is absent', async () => {
    loadMultiProviderConfigMock.mockResolvedValue({ userEmail: 'from-config@example.com' });
    await new TestAdapter({ sessionAnalyticsReport: true }).call(baseEnv);
    expect(loadMultiProviderConfigMock).toHaveBeenCalledTimes(1);
    expect(generateSessionReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'from-config@example.com' })
    );
  });

  it('falls back to ConfigLoader when CODEMIE_PROFILE_CONFIG has no email', async () => {
    loadMultiProviderConfigMock.mockResolvedValue({ userEmail: 'from-config@example.com' });
    const env = {
      ...baseEnv,
      CODEMIE_PROFILE_CONFIG: JSON.stringify({ someOtherField: 'value' }),
    } as NodeJS.ProcessEnv;
    await new TestAdapter({ sessionAnalyticsReport: true }).call(env);
    expect(loadMultiProviderConfigMock).toHaveBeenCalledTimes(1);
    expect(generateSessionReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'from-config@example.com' })
    );
  });

  it('does not call ConfigLoader when CODEMIE_PROFILE_CONFIG already has an email', async () => {
    const env = {
      ...baseEnv,
      CODEMIE_PROFILE_CONFIG: JSON.stringify({ userEmail: 'from-env@example.com' }),
    } as NodeJS.ProcessEnv;
    await new TestAdapter({ sessionAnalyticsReport: true }).call(env);
    expect(loadMultiProviderConfigMock).not.toHaveBeenCalled();
    expect(generateSessionReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'from-env@example.com' })
    );
  });

  it('omits userEmail silently when both env and ConfigLoader fail', async () => {
    loadMultiProviderConfigMock.mockRejectedValue(new Error('no config file'));
    await new TestAdapter({ sessionAnalyticsReport: true }).call(baseEnv);
    const arg = generateSessionReportMock.mock.calls[0][0];
    expect(arg.userEmail).toBeUndefined();
  });
});
