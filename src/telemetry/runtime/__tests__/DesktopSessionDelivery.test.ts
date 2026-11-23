import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '@/utils/logger.js';

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function (this: Record<string, unknown>) {
    this.getStoredCredentials = vi.fn().mockResolvedValue({ cookies: { session: 'abc123' } });
  })
}));

import { SessionStore } from '@/agents/core/session/SessionStore.js';
import { DesktopSessionMetrics } from '../DesktopSessionMetrics.js';
import type { DesktopTelemetryRuntimeConfig } from '../types.js';

const config: DesktopTelemetryRuntimeConfig = {
  clientType: 'claude-desktop',
  targetApiUrl: 'https://api.example.com',
  provider: 'ai-run-sso',
  version: '1.0.0',
  pollIntervalMs: 10_000,
  inactivityTimeoutMs: 300_000,
  port: 4001,
  gatewayKey: 'codemie-proxy'
};

let codemieHome: string;

describe('DesktopSessionMetrics.canDeliver', () => {
  beforeEach(() => {
    codemieHome = mkdtempSync(join(tmpdir(), 'desktop-delivery-'));
    vi.stubEnv('CODEMIE_HOME', codemieHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await logger.close();
    rmSync(codemieHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('is false while the switch is off and while the file is corrupt, true with usable credentials otherwise', async () => {
    const metrics = new DesktopSessionMetrics(config, new SessionStore());
    const preferences = join(codemieHome, 'claude-analytics.json');
    expect(await metrics.canDeliver()).toBe(true);

    writeFileSync(preferences, JSON.stringify({ enabled: false }));
    expect(await metrics.canDeliver()).toBe(false);

    writeFileSync(preferences, 'not json');
    expect(await metrics.canDeliver()).toBe(false);
  });
});
