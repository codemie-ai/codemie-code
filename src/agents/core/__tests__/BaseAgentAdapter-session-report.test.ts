// src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateSessionReportMock = vi.fn();
vi.mock('../../../cli/commands/analytics/report/session-report.js', () => ({
  generateSessionReport: (...a: unknown[]) => generateSessionReportMock(...a),
}));
vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setSessionId: vi.fn(), setAgentName: vi.fn(), setProfileName: vi.fn() },
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
  beforeEach(() => { vi.clearAllMocks(); generateSessionReportMock.mockResolvedValue({ written: '/x.json', sessions: 1 }); });

  it('generates a report when enabled', async () => {
    await new TestAdapter({ sessionAnalyticsReport: true }).call(baseEnv);
    expect(generateSessionReportMock).toHaveBeenCalledTimes(1);
    const arg = generateSessionReportMock.mock.calls[0][0];
    expect(arg.sessionId).toBe('s1');
    expect(arg.outputPath).toContain('docs/codemie/analytics/codemie-analytics-s1.json');
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
});
