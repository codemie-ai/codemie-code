/**
 * Tests for analytics system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Analytics } from '../index.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Analytics', () => {
  let analytics: Analytics;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `codemie-analytics-test-${Date.now()}`);
    analytics = new Analytics({
      enabled: true,
      target: 'local',
      localPath: testDir,
      flushInterval: 100, // Short interval for testing
      maxBufferSize: 10,
    });
  });

  afterEach(async () => {
    await analytics.destroy();
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });

  it('should create analytics instance', () => {
    expect(analytics).toBeDefined();
    expect(analytics.isEnabled).toBe(true);
  });

  it('should not track when disabled', async () => {
    const disabledAnalytics = new Analytics({
      enabled: false,
    });

    disabledAnalytics.startSession({
      agent: 'test-agent',
      agentVersion: '1.0.0',
      cliVersion: '0.0.11',
      profile: 'test',
      provider: 'openai',
      model: 'gpt-4.1',
      workingDir: '/test',
      interactive: true,
    });

    await disabledAnalytics.track('user_prompt', {});
    await disabledAnalytics.flush();

    expect(disabledAnalytics.isEnabled).toBe(false);

    await disabledAnalytics.destroy();
  });
});
