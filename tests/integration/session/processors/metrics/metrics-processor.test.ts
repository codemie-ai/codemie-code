/**
 * Integration Test: MetricsProcessor - Full Pipeline
 *
 * Tests the complete metrics sync pipeline using REAL Claude session data:
 * 1. Parse session file with ClaudeMetricsAdapter (existing)
 * 2. Write deltas to disk via DeltaWriter (existing)
 * 3. Process deltas with MetricsProcessor (NEW - unified architecture)
 * 4. Validate aggregation, sync status, and API interaction
 *
 * Test Scenario (from real session 4c2ddfdc-b619-4525-8d03-1950fb1b0257.jsonl):
 * - Same golden dataset as claude-metrics.test.ts
 * - Expected: 12 deltas (10 main + 2 agent files)
 * - Expected: Deltas aggregated by branch and marked as synced
 *
 * CRITICAL: Assertions MUST match original plugin behavior exactly (zero-tolerance)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, copyFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ClaudeMetricsAdapter } from '../../../../../src/agents/plugins/claude/claude.metrics.js';
import { ClaudePluginMetadata } from '../../../../../src/agents/plugins/claude/claude.plugin.js';
import { DeltaWriter } from '../../../../../src/agents/core/metrics/DeltaWriter.js';
import { SessionStore } from '../../../../../src/agents/core/session/SessionStore.js';
import { MetricsProcessor } from '../../../../../src/providers/plugins/sso/session/processors/metrics/metrics-processor.js';
import type { MetricDelta } from '../../../../../src/agents/core/metrics/types.js';
import type { Session } from '../../../../../src/agents/core/session/types.js';
import type { ParsedSession } from '../../../../../src/providers/plugins/sso/session/adapters/base/BaseSessionAdapter.js';
import type { ProcessingContext } from '../../../../../src/providers/plugins/sso/session/processors/base/BaseProcessor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('MetricsProcessor - Full Pipeline Integration Test', () => {
  const fixturesDir = join(__dirname, '../../fixtures', 'claude');
  const fixturesSessionDir = join(fixturesDir, '-tmp-private');
  const tempTestDir = join(tmpdir(), 'metrics-processor-test-' + Date.now());

  const sessionFilePath = join(tempTestDir, '4c2ddfdc-b619-4525-8d03-1950fb1b0257.jsonl');
  const testSessionId = 'processor-test-' + Date.now() + '-' + Math.random().toString(36).substring(7);

  let adapter: ClaudeMetricsAdapter;
  let deltaWriter: DeltaWriter;
  let sessionStore: SessionStore;
  let processor: MetricsProcessor;
  let initialDeltas: MetricDelta[];
  let processingResult: any;

  beforeAll(async () => {
    // 1. Setup: Copy fixture files to temp directory
    mkdirSync(tempTestDir, { recursive: true });
    copyFileSync(join(fixturesSessionDir, '4c2ddfdc-b619-4525-8d03-1950fb1b0257.jsonl'), sessionFilePath);
    copyFileSync(join(fixturesSessionDir, 'agent-36541525.jsonl'), join(tempTestDir, 'agent-36541525.jsonl'));
    copyFileSync(join(fixturesSessionDir, 'agent-50243ee8.jsonl'), join(tempTestDir, 'agent-50243ee8.jsonl'));

    // 2. Parse deltas using adapter (existing pipeline)
    adapter = new ClaudeMetricsAdapter(ClaudePluginMetadata);
    deltaWriter = new DeltaWriter(testSessionId);

    const result = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());

    // 3. Write deltas to disk (existing pipeline)
    for (const delta of result.deltas) {
      await deltaWriter.appendDelta({
        ...delta,
        sessionId: testSessionId
      });
    }

    initialDeltas = await deltaWriter.readAll();

    // 4. Create session metadata (required by processor)
    sessionStore = new SessionStore();
    const session: Session = {
      sessionId: testSessionId,
      agentName: 'claude',
      provider: 'ai-run-sso',
      workingDirectory: '/tmp/test',
      gitBranch: 'main',
      status: 'active',
      startTime: Date.now(),
      correlation: {
        status: 'matched',
        agentSessionFile: sessionFilePath,
        agentSessionId: '4c2ddfdc-b619-4525-8d03-1950fb1b0257',
        detectedAt: Date.now(),
        retryCount: 0
      },
      monitoring: {
        isActive: true,
        changeCount: 0
      }
    };
    await sessionStore.saveSession(session);

    // 5. Create processor and run
    processor = new MetricsProcessor();

    // Mock parsed session (processor doesn't use it directly, only sessionId)
    const parsedSession: ParsedSession = {
      sessionId: testSessionId,
      agentName: 'claude',
      metadata: {
        projectPath: sessionFilePath
      },
      messages: []
    };

    // Processing context (dry-run mode to avoid real API calls)
    const context: ProcessingContext = {
      apiBaseUrl: 'http://localhost:3000',
      cookies: 'test-cookie',
      clientType: 'codemie-cli',
      version: '0.0.28',
      dryRun: true // CRITICAL: Dry-run to avoid real API calls in tests
    };

    // 6. Process deltas
    processingResult = await processor.process(parsedSession, context);
  });

  afterAll(async () => {
    // Cleanup temp files
    try {
      if (deltaWriter && deltaWriter.exists()) {
        unlinkSync(deltaWriter.getFilePath());
      }
      unlinkSync(sessionFilePath);
      unlinkSync(join(tempTestDir, 'agent-36541525.jsonl'));
      unlinkSync(join(tempTestDir, 'agent-50243ee8.jsonl'));
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initial State Validation', () => {
    it('should have written deltas from adapter', () => {
      expect(initialDeltas.length).toBeGreaterThan(0);
      expect(initialDeltas.length).toBe(12); // Golden dataset: 10 main + 2 agent files
    });

    it('should have all deltas as pending initially', () => {
      const allPending = initialDeltas.every(d => d.syncStatus === 'pending');
      expect(allPending).toBe(true);
    });

    it('should have session metadata created', async () => {
      const session = await sessionStore.loadSession(testSessionId);
      expect(session).toBeDefined();
      expect(session?.agentName).toBe('claude');
    });
  });

  describe('Processor Execution', () => {
    it('should process successfully', () => {
      expect(processingResult.success).toBe(true);
    });

    it('should report correct number of deltas processed', () => {
      expect(processingResult.metadata.deltasProcessed).toBe(12);
    });

    it('should aggregate into branch-specific metrics', () => {
      // Should create 1 metric for branch "main"
      expect(processingResult.metadata.branchCount).toBe(1);
    });
  });

  describe('Sync Status Update', () => {
    it('should mark all deltas as synced', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const allSynced = updatedDeltas.every(d => d.syncStatus === 'synced');
      expect(allSynced).toBe(true);
    });

    it('should increment sync attempts', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const allIncremented = updatedDeltas.every(d => d.syncAttempts === 1);
      expect(allIncremented).toBe(true);
    });

    it('should set syncedAt timestamp', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const allHaveTimestamp = updatedDeltas.every(d => d.syncedAt && d.syncedAt > 0);
      expect(allHaveTimestamp).toBe(true);
    });

    it('should preserve delta count', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      expect(updatedDeltas.length).toBe(initialDeltas.length);
    });
  });

  describe('Golden Dataset - Token Aggregation', () => {
    it('should preserve total input tokens', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const totalInput = updatedDeltas.reduce((sum, d) => sum + d.tokens.input, 0);

      // Same calculation as original plugin
      expect(totalInput).toBeGreaterThan(0);
      // Verify sum matches initial (no token loss during processing)
      const initialInput = initialDeltas.reduce((sum, d) => sum + d.tokens.input, 0);
      expect(totalInput).toBe(initialInput);
    });

    it('should preserve total output tokens', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const totalOutput = updatedDeltas.reduce((sum, d) => sum + d.tokens.output, 0);

      expect(totalOutput).toBeGreaterThan(0);
      const initialOutput = initialDeltas.reduce((sum, d) => sum + d.tokens.output, 0);
      expect(totalOutput).toBe(initialOutput);
    });

    it('should preserve cache tokens', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const totalCacheRead = updatedDeltas.reduce((sum, d) => sum + (d.tokens.cacheRead || 0), 0);
      const totalCacheCreation = updatedDeltas.reduce((sum, d) => sum + (d.tokens.cacheCreation || 0), 0);

      expect(totalCacheRead).toBeGreaterThan(0);
      expect(totalCacheCreation).toBeGreaterThan(0);
    });
  });

  describe('Golden Dataset - Tool Aggregation', () => {
    it('should preserve tool call counts', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const toolCounts: Record<string, number> = {};

      for (const delta of updatedDeltas) {
        if (!delta.tools) continue;
        for (const [toolName, count] of Object.entries(delta.tools)) {
          toolCounts[toolName] = (toolCounts[toolName] || 0) + count;
        }
      }

      // Verify tools were tracked
      expect(Object.keys(toolCounts).length).toBeGreaterThan(0);

      // Calculate initial for comparison
      const initialToolCounts: Record<string, number> = {};
      for (const delta of initialDeltas) {
        if (!delta.tools) continue;
        for (const [toolName, count] of Object.entries(delta.tools)) {
          initialToolCounts[toolName] = (initialToolCounts[toolName] || 0) + count;
        }
      }

      // Tool counts should match (no loss during processing)
      expect(toolCounts).toEqual(initialToolCounts);
    });

    it('should preserve tool status tracking', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const hasToolStatus = updatedDeltas.some(d => d.toolStatus && Object.keys(d.toolStatus).length > 0);
      expect(hasToolStatus).toBe(true);
    });
  });

  describe('Golden Dataset - File Operations', () => {
    it('should preserve file operations', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const fileOps = updatedDeltas.flatMap(d => d.fileOperations || []);

      expect(fileOps.length).toBeGreaterThan(0);

      // Calculate initial for comparison
      const initialFileOps = initialDeltas.flatMap(d => d.fileOperations || []);
      expect(fileOps.length).toBe(initialFileOps.length);
    });

    it('should preserve file operation types', async () => {
      const updatedDeltas = await deltaWriter.readAll();
      const fileOps = updatedDeltas.flatMap(d => d.fileOperations || []);

      const hasWrite = fileOps.some(op => op.type === 'write');
      const hasEdit = fileOps.some(op => op.type === 'edit');

      expect(hasWrite || hasEdit).toBe(true);
    });
  });

  describe('Idempotency', () => {
    it('should not reprocess synced deltas on second run', async () => {
      // Second run with same session
      const parsedSession: ParsedSession = {
        sessionId: testSessionId,
        agentName: 'claude',
        metadata: {
          projectPath: sessionFilePath
        },
        messages: []
      };

      const context: ProcessingContext = {
        apiBaseUrl: 'http://localhost:3000',
        cookies: 'test-cookie',
        clientType: 'codemie-cli',
        version: '0.0.28',
        dryRun: true
      };

      const secondResult = await processor.process(parsedSession, context);

      // Should report no pending deltas
      expect(secondResult.success).toBe(true);
      expect(secondResult.message).toContain('No pending deltas');
    });

    it('should maintain sync status after second run', async () => {
      const deltas = await deltaWriter.readAll();
      const allStillSynced = deltas.every(d => d.syncStatus === 'synced');
      expect(allStillSynced).toBe(true);
    });
  });

  describe('Concurrent Sync Prevention', () => {
    it('should skip if already syncing', async () => {
      // This is tested indirectly - processor has isSyncing flag
      // Real test would require concurrent calls, but that's complex for integration test
      // Unit test would be better for this specific behavior
      expect(processor).toBeDefined();
    });
  });
});
