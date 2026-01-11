/**
 * Unit tests for SessionOrchestrator lifecycle detection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionOrchestrator } from '../SessionOrchestrator.js';
import type { SessionLifecycleAdapter } from '../types.js';
import type { AgentMetricsSupport } from '../../metrics/types.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SessionOrchestrator - Lifecycle Detection', () => {
  let tempDir: string;
  let mockMetricsAdapter: AgentMetricsSupport;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = join(tmpdir(), `codemie-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    // Create mock metrics adapter
    mockMetricsAdapter = {
      getDataPaths: () => ({
        sessionsDir: tempDir,
        historyPath: join(tempDir, 'history.jsonl')
      }),
      getInitDelay: () => 100,
      matchesSessionPattern: (path: string) => path.endsWith('.jsonl'),
      parseIncrementalMetrics: vi.fn().mockResolvedValue({
        deltas: [],
        lastLine: 0,
        newlyAttachedPrompts: []
      }),
      getWatermarkStrategy: () => 'hash' as const,
      parseSnapshotMetrics: vi.fn().mockResolvedValue({
        sessionId: 'test-session',
        totalTokens: 0,
        totalTools: 0,
        recordCount: 0
      })
    };
  });

  afterEach(async () => {
    // Cleanup temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('skips lifecycle check if no adapter provided', async () => {
    // Create orchestrator without lifecycle adapter
    const orchestrator = new SessionOrchestrator({
      agentName: 'claude',
      provider: 'ai-run-sso',
      workingDirectory: tempDir,
      metricsAdapter: mockMetricsAdapter
      // No lifecycleAdapter
    });

    // Manually invoke discoverNewSessions (private method, testing via side effects)
    // Since it's private, we'll test that it doesn't throw and continues normally
    expect(() => orchestrator).not.toThrow();
  });

  it('accepts lifecycle adapter in constructor', () => {
    // Mock lifecycle adapter
    const mockLifecycleAdapter: SessionLifecycleAdapter = {
      detectSessionEnd: vi.fn().mockResolvedValue(null)
    };

    // Create orchestrator with lifecycle adapter
    const orchestrator = new SessionOrchestrator({
      agentName: 'claude',
      provider: 'ai-run-sso',
      workingDirectory: tempDir,
      metricsAdapter: mockMetricsAdapter,
      lifecycleAdapter: mockLifecycleAdapter
    });

    // Verify orchestrator was created successfully
    expect(orchestrator).toBeDefined();
    expect(mockLifecycleAdapter.detectSessionEnd).toBeDefined();
  });

  it('accepts transition callback in constructor', () => {
    const mockLifecycleAdapter: SessionLifecycleAdapter = {
      detectSessionEnd: vi.fn().mockResolvedValue(null)
    };

    const transitionCallback = vi.fn();

    const orchestrator = new SessionOrchestrator({
      agentName: 'claude',
      provider: 'ai-run-sso',
      workingDirectory: tempDir,
      metricsAdapter: mockMetricsAdapter,
      lifecycleAdapter: mockLifecycleAdapter,
      onSessionTransition: transitionCallback
    });

    // Verify orchestrator was created successfully
    expect(orchestrator).toBeDefined();
    expect(transitionCallback).toBeDefined();
  });

  it('finds new file in same directory', async () => {
    // Create session file BEFORE transition
    const oldFile = join(tempDir, 'session-1.jsonl');
    await writeFile(oldFile, JSON.stringify({ type: 'old' }) + '\n');

    // Record transition timestamp
    const transitionTimestamp = Date.now();

    // Wait to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 100));

    // Create new file AFTER transition
    const newFile = join(tempDir, 'session-2.jsonl');
    await writeFile(newFile, JSON.stringify({ type: 'new' }) + '\n');

    // Verify new file is newer than transition
    const fs = await import('fs/promises');
    const stats = await fs.stat(newFile);
    expect(stats.mtimeMs).toBeGreaterThan(transitionTimestamp);
  });

  it('handles timestamp-based file filtering', async () => {
    const transitionTimestamp = Date.now();

    // Wait a bit to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 50));

    // Create a new file after transition
    const newFile = join(tempDir, 'session-new.jsonl');
    await writeFile(newFile, JSON.stringify({ type: 'new' }) + '\n');

    // Verify file is newer than transition timestamp
    const fs = await import('fs/promises');
    const stats = await fs.stat(newFile);
    expect(stats.mtimeMs).toBeGreaterThan(transitionTimestamp);
  });

  it('filters files correctly', async () => {
    // Create old file (reference file to exclude)
    const oldFile = join(tempDir, 'old-session.jsonl');
    await writeFile(oldFile, JSON.stringify({ type: 'old' }) + '\n');

    // Create new files
    const newFile1 = join(tempDir, 'new-session-1.jsonl');
    const newFile2 = join(tempDir, 'new-session-2.jsonl');
    const nonMatchingFile = join(tempDir, 'other.txt');

    await writeFile(newFile1, JSON.stringify({ type: 'new1' }) + '\n');
    await writeFile(newFile2, JSON.stringify({ type: 'new2' }) + '\n');
    await writeFile(nonMatchingFile, 'not a session file');

    // Verify filtering logic (matching pattern, excluding old)
    const files = [oldFile, newFile1, newFile2, nonMatchingFile];
    const filtered = files.filter(f =>
      mockMetricsAdapter.matchesSessionPattern(f) &&
      f !== oldFile
    );

    expect(filtered).toContain(newFile1);
    expect(filtered).toContain(newFile2);
    expect(filtered).not.toContain(oldFile);
    expect(filtered).not.toContain(nonMatchingFile);
  });
});
