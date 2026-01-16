/**
 * Integration Test: Gemini Metrics Processor with File Operations
 *
 * This test validates Gemini metrics extraction including file operations:
 * 1. Parse Gemini session file with file operations (write_file tool calls)
 * 2. Extract metrics deltas with file operations data
 * 3. Validate line counts (linesAdded) for write operations
 * 4. Verify format and language detection
 *
 * Test Fixture:
 * - session-2026-01-16T11-01-file-ops-37b7abef.json: Real Gemini session with file operations
 *   - 3 write operations (hello.md: 1 line, 6 lines, 4 lines)
 *   - 6 read operations (4 from exploration: SECURITY.md, validate-secrets.js, manager.ts, pre-commit)
 *     (2 from hello.md modifications)
 *   - Demonstrates Gemini-specific semantics: write_file replaces entire content,
 *     so linesAdded = final line count (not incremental changes)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentRegistry } from '../../../src/agents/registry.js';
import { SessionStore } from '../../../src/agents/core/session/SessionStore.js';
import { getSessionMetricsPath } from '../../../src/agents/core/session/session-config.js';
import type { MetricDelta } from '../../../src/agents/core/metrics/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, '..', 'metrics', 'fixtures', 'gemini');
const SESSION_FILE = join(FIXTURES_DIR, 'session-2026-01-16T11-01-file-ops-37b7abef.json');

/**
 * Process session via Gemini adapter and extract metrics
 */
async function processSessionViaAdapter(
  agentSessionFile: string,
  sessionId: string
): Promise<any> {
  const agent = AgentRegistry.getAgent('gemini');
  if (!agent) {
    throw new Error('Gemini agent not found in registry');
  }

  const sessionAdapter = (agent as any).getSessionAdapter?.();
  if (!sessionAdapter) {
    throw new Error('No session adapter available for Gemini agent');
  }

  const processingContext = {
    sessionId,
    agentSessionId: '37b7abef-713d-4522-85f0-8ff15a4e6d17',
    agentSessionFile,
    provider: 'test-provider',
    apiBaseUrl: 'http://localhost:3000',
    cookies: {},
    version: '1.0.0',
    clientType: 'test-client',
    dryRun: true
  };

  return await sessionAdapter.processSession(agentSessionFile, sessionId, processingContext);
}

/**
 * Read metrics file and parse deltas
 */
function readMetricsFile(sessionId: string): MetricDelta[] {
  const metricsPath = getSessionMetricsPath(sessionId);
  if (!existsSync(metricsPath)) {
    throw new Error(`Metrics file not found: ${metricsPath}`);
  }

  const content = readFileSync(metricsPath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);
  return lines.map(line => JSON.parse(line));
}

describe('Gemini Metrics Processor - File Operations', () => {
  const TEST_SESSION_ID = 'test-gemini-metrics-file-ops';
  const sessionStore = new SessionStore();

  const metricsFilePath = getSessionMetricsPath(TEST_SESSION_ID);
  const sessionFilePath = join(dirname(metricsFilePath), `${TEST_SESSION_ID}.json`);
  const conversationFilePath = join(dirname(metricsFilePath), `${TEST_SESSION_ID}_conversation.jsonl`);

  beforeAll(async () => {
    // Verify fixture exists
    if (!existsSync(SESSION_FILE)) {
      throw new Error(`Session fixture not found: ${SESSION_FILE}`);
    }
  });

  afterAll(() => {
    // Cleanup test files
    [metricsFilePath, sessionFilePath, conversationFilePath].forEach(file => {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  it('should create initial session metadata', async () => {
    await sessionStore.saveSession({
      sessionId: TEST_SESSION_ID,
      agentName: 'gemini',
      provider: 'test-provider',
      project: 'test-project',
      startTime: Date.now(),
      workingDirectory: '/test',
      gitBranch: 'test',
      status: 'active',
      correlation: {
        status: 'matched',
        agentSessionId: '37b7abef-713d-4522-85f0-8ff15a4e6d17',
        agentSessionFile: SESSION_FILE,
        retryCount: 0
      }
    });

    const session = await sessionStore.loadSession(TEST_SESSION_ID);
    expect(session).toBeDefined();
    expect(session?.agentName).toBe('gemini');
  });

  it('should process Gemini session and create metrics with file operations', async () => {
    const result = await processSessionViaAdapter(SESSION_FILE, TEST_SESSION_ID);

    expect(result.success).toBe(true);
    expect(existsSync(metricsFilePath)).toBe(true);

    const deltas = readMetricsFile(TEST_SESSION_ID);
    expect(deltas.length).toBeGreaterThan(0);

    // Find deltas with file operations
    const deltasWithFileOps = deltas.filter(d => d.fileOperations && d.fileOperations.length > 0);
    expect(deltasWithFileOps.length).toBeGreaterThan(0);
  });

  it('should extract write operations with line counts', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Find all write operations
    const writeOps: any[] = [];
    for (const delta of deltas) {
      if (delta.fileOperations) {
        for (const op of delta.fileOperations) {
          if (op.type === 'write') {
            writeOps.push(op);
          }
        }
      }
    }

    // Should have 3 write operations (from the session: 1 line, 6 lines, 4 lines)
    expect(writeOps.length).toBe(3);

    // Verify structure of write operations
    for (const writeOp of writeOps) {
      expect(writeOp.type).toBe('write');
      expect(writeOp.path).toBe('hello.md');
      expect(writeOp.linesAdded).toBeGreaterThan(0);
      expect(writeOp.format).toBe('md');
      expect(writeOp.language).toBe('markdown');
    }

    // Verify specific line counts match the session
    const lineCounts = writeOps.map(op => op.linesAdded).sort((a, b) => a - b);
    expect(lineCounts).toEqual([1, 4, 6]); // 1 line, 4 lines, 6 lines (sorted)
  });

  it('should extract read operations', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Find all read operations
    const readOps: any[] = [];
    for (const delta of deltas) {
      if (delta.fileOperations) {
        for (const op of delta.fileOperations) {
          if (op.type === 'read') {
            readOps.push(op);
          }
        }
      }
    }

    // Should have 6 read operations total (4 from exploration + 2 from hello.md operations)
    expect(readOps.length).toBe(6);

    // Verify structure of read operations
    for (const readOp of readOps) {
      expect(readOp.type).toBe('read');
      expect(readOp.path).toBeDefined();
      expect(readOp.format).toBeDefined();
      // Read operations should not have linesAdded/linesRemoved
      expect(readOp.linesAdded).toBeUndefined();
      expect(readOp.linesRemoved).toBeUndefined();
    }

    // Verify we have read operations for hello.md
    const helloMdReads = readOps.filter(op => op.path === 'hello.md');
    expect(helloMdReads.length).toBe(2);
    for (const op of helloMdReads) {
      expect(op.format).toBe('md');
      expect(op.language).toBe('markdown');
    }
  });

  it('should calculate total lines written correctly', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Sum all lines added from write operations
    let totalLinesAdded = 0;
    for (const delta of deltas) {
      if (delta.fileOperations) {
        for (const op of delta.fileOperations) {
          if (op.type === 'write' && op.linesAdded) {
            totalLinesAdded += op.linesAdded;
          }
        }
      }
    }

    // Total should be 1 + 6 + 4 = 11 lines
    expect(totalLinesAdded).toBe(11);
  });

  it('should have correct user prompts associated with file operations', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Find deltas with write operations and verify user prompts
    const writeDeltas = deltas.filter(d =>
      d.fileOperations?.some(op => op.type === 'write')
    );

    expect(writeDeltas.length).toBe(3);

    // Verify each write operation has associated user prompt
    for (const delta of writeDeltas) {
      expect(delta.userPrompts).toBeDefined();
      expect(delta.userPrompts.length).toBeGreaterThan(0);

      const userPrompt = delta.userPrompts[0];
      expect(userPrompt).toHaveProperty('text');
      expect(userPrompt).toHaveProperty('count');
      expect(userPrompt.count).toBe(1);
    }

    // Verify prompts match expected (order may vary)
    const prompts = writeDeltas.map(d => d.userPrompts[0].text);
    expect(prompts).toContain('create hello.md file');
    expect(prompts).toContain('add 5 lines of random text');
    expect(prompts).toContain('remove 2 and 3 line');
  });

  it('should track tool execution status', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Find deltas with file operations
    const deltasWithFileOps = deltas.filter(d => d.fileOperations && d.fileOperations.length > 0);

    // All should have toolStatus
    for (const delta of deltasWithFileOps) {
      expect(delta.toolStatus).toBeDefined();

      // Should have write_file or read_file in toolStatus
      const hasWriteFile = delta.toolStatus?.write_file !== undefined;
      const hasReadFile = delta.toolStatus?.read_file !== undefined;
      expect(hasWriteFile || hasReadFile).toBe(true);

      // All operations should be successful
      if (delta.toolStatus?.write_file) {
        expect(delta.toolStatus.write_file.success).toBeGreaterThan(0);
        expect(delta.toolStatus.write_file.failure).toBe(0);
      }
      if (delta.toolStatus?.read_file) {
        expect(delta.toolStatus.read_file.success).toBeGreaterThan(0);
        expect(delta.toolStatus.read_file.failure).toBe(0);
      }
    }
  });

  it('should have token usage for each delta with file operations', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    const deltasWithFileOps = deltas.filter(d => d.fileOperations && d.fileOperations.length > 0);

    for (const delta of deltasWithFileOps) {
      expect(delta.tokens).toBeDefined();
      expect(delta.tokens.input).toBeGreaterThan(0);
      expect(delta.tokens.output).toBeGreaterThan(0);
      expect(delta.tokens.cacheRead).toBeGreaterThanOrEqual(0);
      expect(delta.tokens.cacheCreation).toBe(0); // Gemini always has 0 cache creation
    }
  });

  it('should handle Gemini-specific semantics (linesAdded = final state)', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Find the "remove 2 and 3 line" operation
    const removeLineDelta = deltas.find(d =>
      d.userPrompts?.[0]?.text === 'remove 2 and 3 line'
    );

    expect(removeLineDelta).toBeDefined();
    expect(removeLineDelta?.fileOperations).toBeDefined();
    expect(removeLineDelta?.fileOperations?.length).toBeGreaterThan(0);

    const writeOp = removeLineDelta?.fileOperations?.find(op => op.type === 'write');
    expect(writeOp).toBeDefined();

    // Gemini write_file replaces entire content, so linesAdded = final line count
    // User removed 2 lines from 6 lines → result is 4 lines
    // Therefore linesAdded = 4 (not -2)
    expect(writeOp?.linesAdded).toBe(4);

    // Should NOT have linesRemoved (Gemini doesn't track removals separately)
    expect(writeOp?.linesRemoved).toBeUndefined();
  });

  it('should have correct model information', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    for (const delta of deltas) {
      expect(delta.models).toBeDefined();
      expect(delta.models.length).toBeGreaterThan(0);
      expect(delta.models[0]).toBe('gemini-3-pro');
    }
  });

  it('should preserve all metadata fields', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    for (const delta of deltas) {
      // Core fields
      expect(delta.recordId).toBeDefined();
      expect(delta.sessionId).toBe(TEST_SESSION_ID);
      expect(delta.agentSessionId).toBe('37b7abef-713d-4522-85f0-8ff15a4e6d17');
      expect(delta.timestamp).toBeDefined();
      expect(typeof delta.timestamp).toBe('number');

      // Sync status
      expect(delta.syncStatus).toBeDefined();
      expect(['pending', 'synced', 'failed']).toContain(delta.syncStatus);
    }
  });
});
