/**
 * Integration Test: OpenCode Metrics Processor - Basic Validation
 *
 * This test validates OpenCode metrics extraction:
 * 1. Parse OpenCode session from storage directory
 * 2. Extract metrics deltas with tokens, tools, and file operations
 * 3. Validate JSONL file creation and structure
 * 4. Verify conversation JSONL generation
 *
 * Test Fixture:
 * - tests/integration/metrics/fixtures/opencode/storage/
 *   - Minimal OpenCode session with 1 user + 1 assistant message
 *   - Assistant message has tokens (input: 1000, output: 500, cache: read 200, write 100)
 *   - 2 tool calls: Write (file operation) and Read (file operation)
 *   - Step-finish part with token data
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentRegistry } from '../../../src/agents/registry.js';
import { SessionStore } from '../../../src/agents/core/session/SessionStore.js';
import { getSessionMetricsPath } from '../../../src/agents/core/session/session-config.js';
import { getCodemiePath } from '../../../src/utils/paths.js';
import type { MetricDelta } from '../../../src/agents/core/metrics/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, '..', 'metrics', 'fixtures', 'opencode', 'storage');
const SESSION_FILE = join(FIXTURES_DIR, 'session', 'test-project', 'test-session-1.json');

/**
 * Process session via OpenCode adapter and extract metrics
 */
async function processSessionViaAdapter(
  sessionFilePath: string,
  sessionId: string
): Promise<any> {
  const agent = AgentRegistry.getAgent('opencode');
  if (!agent) {
    throw new Error('OpenCode agent not found in registry');
  }

  const sessionAdapter = (agent as any).getSessionAdapter?.();
  if (!sessionAdapter) {
    throw new Error('No session adapter available for OpenCode agent');
  }

  const processingContext = {
    sessionId,
    agentSessionId: 'test-session-1',
    agentSessionFile: sessionFilePath,
    provider: 'test-provider',
    apiBaseUrl: 'http://localhost:3000',
    cookies: {},
    version: '1.0.0',
    clientType: 'test-client',
    dryRun: true
  };

  return await sessionAdapter.processSession(sessionFilePath, sessionId, processingContext);
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

describe('OpenCode Metrics Processor - Basic Validation', () => {
  const TEST_SESSION_ID = 'test-opencode-metrics-basic';
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
    // Cleanup test files and cache
    const cacheFile = join(getCodemiePath('cache', 'opencode'), `${TEST_SESSION_ID}_last_processed`);
    [metricsFilePath, sessionFilePath, conversationFilePath, cacheFile].forEach(file => {
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
      agentName: 'opencode',
      provider: 'test-provider',
      project: 'test-project',
      startTime: Date.now(),
      workingDirectory: '/test',
      gitBranch: 'test',
      status: 'active',
      correlation: {
        status: 'matched',
        agentSessionId: 'test-session-1',
        agentSessionFile: SESSION_FILE,
        retryCount: 0
      }
    });

    const session = await sessionStore.loadSession(TEST_SESSION_ID);
    expect(session).toBeDefined();
    expect(session?.agentName).toBe('opencode');
  });

  it('should generate metrics JSONL with token data', async () => {
    const result = await processSessionViaAdapter(SESSION_FILE, TEST_SESSION_ID);

    expect(result.success).toBe(true);
    expect(existsSync(metricsFilePath)).toBe(true);

    const deltas = readMetricsFile(TEST_SESSION_ID);
    expect(deltas.length).toBeGreaterThan(0);

    // Verify token data in deltas
    const deltaWithTokens = deltas.find(d => d.tokens && d.tokens.input > 0);
    expect(deltaWithTokens).toBeDefined();
    expect(deltaWithTokens?.tokens.input).toBe(1000);
    expect(deltaWithTokens?.tokens.output).toBe(500);
    expect(deltaWithTokens?.tokens.cacheRead).toBe(200);
    expect(deltaWithTokens?.tokens.cacheCreation).toBe(100);
  });

  it('should extract write operations with correct file path', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Find write operations
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

    expect(writeOps.length).toBeGreaterThan(0);

    // Verify write operation structure
    const writeOp = writeOps[0];
    expect(writeOp.type).toBe('write');
    expect(writeOp.path).toBe('src/test.ts');
  });

  it('should extract read operations', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Find read operations
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

    expect(readOps.length).toBeGreaterThan(0);

    // Verify read operation structure
    const readOp = readOps[0];
    expect(readOp.type).toBe('read');
    expect(readOp.path).toBe('src/existing.ts');
  });

  it('should track tool execution status', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Find deltas with file operations
    const deltasWithFileOps = deltas.filter(d => d.fileOperations && d.fileOperations.length > 0);
    expect(deltasWithFileOps.length).toBeGreaterThan(0);

    // Verify tool status
    for (const delta of deltasWithFileOps) {
      expect(delta.toolStatus).toBeDefined();

      // Should have write or read in toolStatus
      const hasWrite = delta.toolStatus?.write !== undefined;
      const hasRead = delta.toolStatus?.read !== undefined;
      expect(hasWrite || hasRead).toBe(true);

      // All operations should be successful
      if (delta.toolStatus?.write) {
        expect(delta.toolStatus.write.success).toBeGreaterThan(0);
        expect(delta.toolStatus.write.failure).toBe(0);
      }
      if (delta.toolStatus?.read) {
        expect(delta.toolStatus.read.success).toBeGreaterThan(0);
        expect(delta.toolStatus.read.failure).toBe(0);
      }
    }
  });

  it('should have correct model information', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    for (const delta of deltas) {
      expect(delta.models).toBeDefined();
      expect(delta.models.length).toBeGreaterThan(0);
      expect(delta.models[0]).toBe('anthropic/claude-sonnet-4-6');
    }
  });

  it('should have user prompts associated with deltas', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Find deltas with user prompts
    const deltasWithPrompts = deltas.filter(d => (d as any).userPrompts && (d as any).userPrompts.length > 0);
    expect(deltasWithPrompts.length).toBeGreaterThan(0);

    // Verify user prompt structure
    const delta = deltasWithPrompts[0];
    const userPrompts = (delta as any).userPrompts;
    expect(userPrompts[0]).toHaveProperty('text');
    expect(userPrompts[0]).toHaveProperty('count');
    expect(userPrompts[0].count).toBe(1);
    expect(userPrompts[0].text).toContain('Create a test file');
  });

  it('should preserve all metadata fields', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    for (const delta of deltas) {
      // Core fields
      expect(delta.recordId).toBeDefined();
      expect(delta.sessionId).toBe(TEST_SESSION_ID);
      expect(delta.agentSessionId).toBe('test-session-1');
      expect(delta.timestamp).toBeDefined();
      expect(typeof delta.timestamp).toBe('number');

      // Sync status
      expect(delta.syncStatus).toBeDefined();
      expect(['pending', 'synced', 'failed']).toContain(delta.syncStatus);
    }
  });

  it.skip('should generate conversation JSONL', async () => {
    // TODO: OpenCode conversations processor doesn't write JSONL yet (unlike Claude)
    // This is a future enhancement - for now we're focused on metrics sync
    // Once implemented, this test should verify:
    // - Conversation file exists
    // - Contains payload records with status 'pending'
    // - Has correct structure (conversationId, history array)
    expect(existsSync(conversationFilePath)).toBe(true);

    const content = readFileSync(conversationFilePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);

    // Parse conversation payloads
    const payloads = lines.map(line => JSON.parse(line));

    // Verify structure
    for (const payload of payloads) {
      expect(payload).toHaveProperty('sessionId');
      expect(payload).toHaveProperty('conversationHistory');
      expect(payload).toHaveProperty('syncStatus');
      expect(payload.sessionId).toBe(TEST_SESSION_ID);
      expect(Array.isArray(payload.conversationHistory)).toBe(true);
    }
  });
});
