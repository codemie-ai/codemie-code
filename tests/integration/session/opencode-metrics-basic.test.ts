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
    gitBranch: 'feature/test-branch',
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

  it('should generate metrics JSONL with delta data', async () => {
    const result = await processSessionViaAdapter(SESSION_FILE, TEST_SESSION_ID);

    expect(result.success).toBe(true);
    expect(existsSync(metricsFilePath)).toBe(true);

    const deltas = readMetricsFile(TEST_SESSION_ID);
    expect(deltas.length).toBeGreaterThan(0);
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

  it('should report the bare model id, matching codemie-claude', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    // Only assistant-derived deltas carry a model; user-prompt deltas do not.
    const withModels = deltas.filter(d => d.models && d.models.length > 0);
    expect(withModels.length).toBeGreaterThan(0);

    for (const delta of withModels) {
      // No `anthropic/` provider prefix — codemie-claude sends a bare model id,
      // and a prefix would split the same model across two analytics buckets.
      expect(delta.models![0]).toBe('claude-sonnet-4-6');
    }
  });

  it('should attribute every delta to the branch from the processing context', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    expect(deltas.length).toBeGreaterThan(0);
    for (const delta of deltas) {
      // The aggregator groups on gitBranch; an empty value collapses every
      // session into one nameless branch bucket.
      expect(delta.gitBranch).toBe('feature/test-branch');
    }
  });

  it('should give each tool call and prompt its own recordId', () => {
    const deltas = readMetricsFile(TEST_SESSION_ID);

    const recordIds = deltas.map(d => d.recordId);
    expect(new Set(recordIds).size).toBe(recordIds.length);

    // Tool deltas are keyed {messageId}:{callID}; prompts {messageId}:prompt.
    expect(recordIds.some(id => id.endsWith(':prompt'))).toBe(true);
    expect(recordIds.some(id => !id.endsWith(':prompt'))).toBe(true);
  });

  it('should aggregate into a tool-usage metric with a real session id and branch', async () => {
    const { aggregateDeltas } = await import(
      '../../../src/providers/plugins/sso/session/processors/metrics/metrics-aggregator.js'
    );
    const session = await sessionStore.loadSession(TEST_SESSION_ID);
    const deltas = readMetricsFile(TEST_SESSION_ID);

    const metrics = aggregateDeltas(deltas, session!, '1.0.0', 'codemie-opencode');

    expect(metrics.length).toBe(1);
    const attrs = metrics[0].attributes;

    // The two headline regressions this work fixes.
    expect(attrs.session_id).not.toBe('unknown');
    expect(attrs.branch).toBe('feature/test-branch');

    expect(attrs.llm_model).toBe('claude-sonnet-4-6');
    expect(attrs.total_tool_calls).toBeGreaterThan(0);
    expect(attrs.total_user_prompts).toBe(1);
    expect(attrs.files_created).toBeGreaterThan(0);
    // Parity guard: codemie-claude sends no token or cost fields anywhere.
    expect(attrs).not.toHaveProperty('total_tokens');
    expect(attrs).not.toHaveProperty('total_cost');
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

  it('should be idempotent when reprocessed by the incremental sync timer', async () => {
    const before = readMetricsFile(TEST_SESSION_ID);

    // The timer re-parses the same session every tick. Without stable per-record
    // recordIds this would append the whole session again on every pass.
    await processSessionViaAdapter(SESSION_FILE, TEST_SESSION_ID);

    const after = readMetricsFile(TEST_SESSION_ID);
    expect(after.length).toBe(before.length);
    expect(after.map(d => d.recordId)).toEqual(before.map(d => d.recordId));
  });

  it('should queue a conversation payload for the sync processor', () => {
    expect(existsSync(conversationFilePath)).toBe(true);

    const lines = readFileSync(conversationFilePath, 'utf-8')
      .trim().split('\n').filter(line => line.length > 0);
    // Exactly one: the session was processed twice (see the idempotency test
    // above) and the checkpoint sentinel must suppress the second queueing.
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);

    expect(record.status).toBe('pending');
    expect(record.payloadId).toContain('test-session-1@');
    // Set explicitly so it never falls back to the 'Claude Desktop' default.
    expect(record.payload.folder).toBe('opencode');
    expect(record.payload.conversationId).toBe('test-session-1');
    expect(record.payload.llmModel).toBe('claude-sonnet-4-6');

    const history = record.payload.history;
    expect(Array.isArray(history)).toBe(true);
    expect(history.some((entry: any) => entry.role === 'User')).toBe(true);

    const assistant = history.find((entry: any) => entry.role === 'Assistant');
    expect(assistant).toBeDefined();
    // Tool calls ride along as thoughts, not as visible history entries.
    const toolThoughts = (assistant.thoughts ?? []).filter((t: any) => t.author_type === 'Tool');
    expect(toolThoughts.length).toBe(2);
    expect(toolThoughts.map((t: any) => t.author_name).sort()).toEqual(['Read', 'Write']);
  });
});
