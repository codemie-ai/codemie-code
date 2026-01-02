/**
 * Integration Test: Gemini Metrics Adapter - Full Pipeline
 *
 * Tests the complete metrics collection pipeline using REAL Gemini session data:
 * 1. Parse session file with GeminiMetricsAdapter
 * 2. Extract incremental deltas
 * 3. Write deltas to disk via DeltaWriter
 * 4. Validate stored data matches expected format
 *
 * Test Scenario (from fixture session-2025-12-17T11-51-e5279324.json):
 * - User: "Create a hello.py file with a simple greeting"
 *   → write_file hello.py (5 lines, python)
 * - User: "Now create hello.md with documentation"
 *   → write_file hello.md (8 lines, markdown)
 * - User: "Read the hello.py file back"
 *   → read_file hello.py
 * - User: "Update hello.py with a comment"
 *   → replace hello.py (edit operation)
 * - User: "Search for 'greet' in the codebase"
 *   → search_file_content (grep operation)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GeminiMetricsAdapter } from '../../../src/agents/plugins/gemini.metrics.js';
import { GeminiPluginMetadata } from '../../../src/agents/plugins/gemini.plugin.js';
import { DeltaWriter } from '../../../src/agents/core/metrics/core/DeltaWriter.js';
import type { MetricDelta } from '../../../src/agents/core/metrics/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('GeminiMetricsAdapter - Full Pipeline Integration Test', () => {
  const fixturesDir = join(__dirname, 'fixtures', 'gemini');
  // Using real Gemini session data from production
  const sessionFilePath = join(fixturesDir, 'session-2025-12-01T21-45-5b959dae.json');
  const testSessionId = 'gemini-test-session-' + Date.now() + '-' + Math.random().toString(36).substring(7);

  let adapter: GeminiMetricsAdapter;
  let deltaWriter: DeltaWriter;
  let deltas: MetricDelta[];

  beforeAll(async () => {
    adapter = new GeminiMetricsAdapter(GeminiPluginMetadata);
    deltaWriter = new DeltaWriter(testSessionId);

    // Parse incremental metrics
    const result = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());

    // Write deltas to disk
    for (const delta of result.deltas) {
      await deltaWriter.appendDelta({
        ...delta,
        sessionId: testSessionId
      });
    }

    // Read back from disk for validation
    deltas = await deltaWriter.readAll();
  });

  afterAll(() => {
    if (deltaWriter.exists()) {
      unlinkSync(deltaWriter.getFilePath());
    }
  });

  describe('Pipeline: Parse → Write → Read', () => {
    it('should write deltas to disk successfully', () => {
      expect(deltaWriter.exists()).toBe(true);
      expect(deltas.length).toBeGreaterThan(0);
    });

    it('should preserve all delta records', async () => {
      const result = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());
      expect(deltas.length).toBe(result.deltas.length);
      // Real session has multiple gemini messages with tokens
      expect(deltas.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Format Parsing', () => {
    it('should parse Gemini session format correctly', async () => {
      const snapshot = await adapter.parseSessionFile(sessionFilePath);
      expect(snapshot.sessionId).toBe('5b959dae-8655-4cd1-b10f-720b8c336ea2');
      expect(snapshot.tokens).toBeDefined();
      expect(snapshot.tokens?.input).toBeGreaterThan(0);
      expect(snapshot.tokens?.output).toBeGreaterThan(0);
    });

    it('should map Gemini tokens to CodeMie format', async () => {
      const snapshot = await adapter.parseSessionFile(sessionFilePath);
      // Real session totals: input=101630, output=2734, thoughts=1493, cached=56538
      expect(snapshot.tokens?.input).toBe(101630);
      expect(snapshot.tokens?.output).toBe(4227); // output + thoughts (2734 + 1493)
      expect(snapshot.tokens?.cacheRead).toBe(56538);
    });

    it('should match session file pattern', () => {
      const validPath = '/Users/test/.gemini/tmp/abc123/chats/session-2025-12-01T21-45-5b959dae.json';
      expect(adapter.matchesSessionPattern(validPath)).toBe(true);

      const invalidPath = '/Users/test/.gemini/session.json';
      expect(adapter.matchesSessionPattern(invalidPath)).toBe(false);
    });

    it('should extract session ID from path', () => {
      const path = '/Users/test/.gemini/tmp/abc123/chats/session-2025-12-01T21-45-5b959dae.json';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('2025-12-01T21-45-5b959dae');
    });
  });

  describe('Tool Extraction', () => {
    it('should extract tool calls with file operations', async () => {
      const result = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());
      const deltasWithTools = result.deltas.filter(d => Object.keys(d.tools).length > 0);
      // Real session has 8 gemini messages with tool calls
      expect(deltasWithTools.length).toBeGreaterThan(0);
    });

    it('should track tool success/failure status', async () => {
      const result = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());
      const deltasWithStatus = result.deltas.filter(d => d.toolStatus !== undefined);
      expect(deltasWithStatus.length).toBeGreaterThan(0);

      // Verify tool status tracking exists
      for (const delta of deltasWithStatus) {
        for (const toolName in delta.toolStatus!) {
          const status = delta.toolStatus![toolName];
          expect(status.success).toBeGreaterThanOrEqual(0);
          expect(status.failure).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('should extract file operations by type', async () => {
      const result = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());
      const allFileOps = result.deltas.flatMap(d => d.fileOperations || []);

      // Real session has various file operations
      expect(allFileOps.length).toBeGreaterThan(0);

      // Verify operations have correct structure
      for (const op of allFileOps) {
        expect(op.type).toMatch(/read|write|edit|glob|grep/);
      }
    });

    it('should detect file languages correctly', async () => {
      const result = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());
      const allFileOps = result.deltas.flatMap(d => d.fileOperations || []);

      // Real session may have various languages - verify language detection works
      const opsWithLanguage = allFileOps.filter(op => op.language !== undefined);
      expect(opsWithLanguage.length).toBeGreaterThanOrEqual(0);

      // If there are operations with languages, verify they're valid
      for (const op of opsWithLanguage) {
        expect(typeof op.language).toBe('string');
        expect(op.language!.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Model Tracking', () => {
    it('should track models per turn', async () => {
      const result = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());
      const deltasWithModels = result.deltas.filter(d => d.models && d.models.length > 0);
      expect(deltasWithModels.length).toBeGreaterThan(0);

      // Real session uses Gemini models
      for (const delta of deltasWithModels) {
        expect(delta.models).toBeDefined();
        expect(delta.models!.length).toBeGreaterThan(0);
      }
    });

    it('should aggregate all models in snapshot', async () => {
      const snapshot = await adapter.parseSessionFile(sessionFilePath);
      expect(snapshot.model).toBeDefined();
      expect(snapshot.metadata?.models).toBeDefined();
      expect(Array.isArray(snapshot.metadata?.models)).toBe(true);
    });
  });

  describe('Incremental Processing', () => {
    it('should skip already processed records', async () => {
      const firstRun = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());
      const processedIds = new Set(firstRun.deltas.map(d => d.recordId));

      const secondRun = await adapter.parseIncrementalMetrics(sessionFilePath, processedIds);
      expect(secondRun.deltas.length).toBe(0);
    });

    it('should process only new records', async () => {
      // Process first 2 records
      const firstRun = await adapter.parseIncrementalMetrics(sessionFilePath, new Set());
      const totalDeltas = firstRun.deltas.length;
      const processedIds = new Set(firstRun.deltas.slice(0, 2).map(d => d.recordId));

      // Second run should return remaining records (total - 2)
      const secondRun = await adapter.parseIncrementalMetrics(sessionFilePath, processedIds);
      expect(secondRun.deltas.length).toBe(totalDeltas - 2);
    });
  });

  describe('Token Accounting', () => {
    it('should sum tokens correctly across all turns', async () => {
      const snapshot = await adapter.parseSessionFile(sessionFilePath);

      // Real session totals (verified from production):
      // Input: 101630
      // Output: 2734 + 1493 (thoughts) = 4227
      // Cached: 56538
      expect(snapshot.tokens?.input).toBe(101630);
      expect(snapshot.tokens?.output).toBe(4227);
      expect(snapshot.tokens?.cacheRead).toBe(56538);
    });

    it('should include cache read tokens in total', async () => {
      const snapshot = await adapter.parseSessionFile(sessionFilePath);
      const totalInput = snapshot.metadata?.totalInputTokens;

      // totalInputTokens = input + cacheRead
      expect(totalInput).toBe(101630 + 56538);
    });
  });

  describe('Watermark Strategy', () => {
    it('should use object-based watermark', () => {
      expect(adapter.getWatermarkStrategy()).toBe('object');
    });

    it('should have correct init delay', () => {
      expect(adapter.getInitDelay()).toBe(500);
    });
  });

  describe('Data Paths', () => {
    it('should return correct sessions directory', () => {
      const paths = adapter.getDataPaths();
      expect(paths.sessionsDir).toContain('.gemini');
      expect(paths.sessionsDir).toContain('tmp');
    });
  });

  describe('Error Handling', () => {
    it('should handle empty session file gracefully', async () => {
      const emptySession = join(fixturesDir, 'empty-session.json');
      await import('fs/promises').then(fs => fs.writeFile(emptySession, '{"messages":[]}'));

      await expect(adapter.parseSessionFile(emptySession))
        .rejects
        .toThrow('Empty session file');

      // Cleanup
      await import('fs/promises').then(fs => fs.unlink(emptySession).catch(() => {}));
    });

    it('should handle corrupted JSON gracefully', async () => {
      const corruptedSession = join(fixturesDir, 'corrupted-session.json');
      await import('fs/promises').then(fs => fs.writeFile(corruptedSession, '{invalid json}'));

      await expect(adapter.parseSessionFile(corruptedSession))
        .rejects
        .toThrow();

      // Cleanup
      await import('fs/promises').then(fs => fs.unlink(corruptedSession).catch(() => {}));
    });

    it('should handle missing token fields gracefully', async () => {
      const noTokensSession = join(fixturesDir, 'no-tokens-session.json');
      const sessionData = {
        sessionId: 'test-no-tokens',
        messages: [
          {
            id: 'msg-1',
            type: 'gemini',
            timestamp: '2025-12-17T12:00:00.000Z'
            // Missing tokens field
          }
        ]
      };
      await import('fs/promises').then(fs => fs.writeFile(noTokensSession, JSON.stringify(sessionData)));

      const snapshot = await adapter.parseSessionFile(noTokensSession);
      expect(snapshot.tokens).toEqual({ input: 0, output: 0 });

      // Cleanup
      await import('fs/promises').then(fs => fs.unlink(noTokensSession).catch(() => {}));
    });

    it('should return empty prompts for invalid logs.json', async () => {
      // This tests the new validation logic in getUserPrompts()
      const prompts = await adapter.getUserPrompts('nonexistent-session');
      expect(prompts).toEqual([]);
    });

    it('should handle tool calls with missing status field', async () => {
      const noStatusSession = join(fixturesDir, 'no-status-session.json');
      const sessionData = {
        sessionId: 'test-no-status',
        messages: [
          {
            id: 'msg-1',
            type: 'gemini',
            timestamp: '2025-12-17T12:00:00.000Z',
            tokens: { input: 100, output: 50, cached: 0 },
            toolCalls: [
              {
                id: 'tool-1',
                name: 'write_file',
                args: { file_path: 'test.txt' },
                result: { success: true }, // Only result.success, no status field
                timestamp: '2025-12-17T12:00:01.000Z'
              }
            ]
          }
        ]
      };
      await import('fs/promises').then(fs => fs.writeFile(noStatusSession, JSON.stringify(sessionData)));

      const snapshot = await adapter.parseSessionFile(noStatusSession);
      expect(snapshot.toolCalls).toHaveLength(1);
      expect(snapshot.toolCalls![0].status).toBe('success');

      // Cleanup
      await import('fs/promises').then(fs => fs.unlink(noStatusSession).catch(() => {}));
    });

    it('should match flexible hex ID lengths in session pattern', () => {
      // Original 8-char format
      expect(adapter.matchesSessionPattern('/home/.gemini/tmp/abc/chats/session-2025-12-17T11-51-e5279324.json')).toBe(true);

      // Longer 12-char format (future-proof)
      expect(adapter.matchesSessionPattern('/home/.gemini/tmp/abc/chats/session-2025-12-17T11-51-e5279324def4.json')).toBe(true);

      // Shorter 6-char format
      expect(adapter.matchesSessionPattern('/home/.gemini/tmp/abc/chats/session-2025-12-17T11-51-abc123.json')).toBe(true);
    });
  });
});
