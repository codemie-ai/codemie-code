/**
 * Tests for analytics system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Analytics } from '../index.js';
import { readFile, rm } from 'node:fs/promises';
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

  it('should track session lifecycle', async () => {
    analytics.startSession({
      agent: 'test-agent',
      agentVersion: '1.0.0',
      cliVersion: '0.0.11',
      profile: 'test',
      provider: 'openai',
      model: 'gpt-4.1',
      workingDir: '/test',
      interactive: true,
    });

    await analytics.endSession('test_exit', { totalPrompts: 5 });

    // Wait for flush
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify file was created
    const files = await readFile(
      join(testDir, `${new Date().toISOString().split('T')[0]}.jsonl`),
      'utf-8'
    );

    expect(files).toContain('session_start');
    expect(files).toContain('session_end');
    expect(files).toContain('test_exit');
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
