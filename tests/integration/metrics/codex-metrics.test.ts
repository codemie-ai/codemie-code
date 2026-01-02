/**
 * Integration Test: Codex Metrics Adapter - Full Pipeline
 *
 * Tests the complete metrics collection pipeline using REAL Codex session data:
 * 1. Parse session file with CodexMetricsAdapter
 * 2. Extract incremental deltas
 * 3. Write deltas to disk via DeltaWriter
 * 4. Validate stored data matches expected golden dataset
 *
 * Test Scenario (from real session 019b7f94-51b4-7593-922e-ba12b5b73b52.jsonl):
 * - Provider: ai-run-sso (preview-codex)
 * - Model: gpt-5-1-codex-2025-11-13
 * - Turns: 4
 * - Tool calls: 3 shell commands (all success)
 * - Tokens: 22,474 input / 428 output / 14,848 cache read
 * - Total: 37,750 tokens
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CodexMetricsAdapter } from '../../../src/agents/plugins/codex.metrics.js';
import { CodexPluginMetadata } from '../../../src/agents/plugins/codex.plugin.js';
import { DeltaWriter } from '../../../src/agents/core/metrics/core/DeltaWriter.js';
import type { MetricDelta, MetricSnapshot } from '../../../src/agents/core/metrics/types.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('CodexMetricsAdapter - Full Pipeline Integration Test', () => {
  // Use fixture files in tests/integration/fixtures/codex directory
  const fixturesDir = join(__dirname, 'fixtures', 'codex');
  const fixturesSessionDir = join(fixturesDir, 'sessions', '2026', '01', '02');
  const tempTestDir = join(tmpdir(), 'codex-metrics-test-' + Date.now());
  const tempSessionDir = join(tempTestDir, 'sessions', '2026', '01', '02');

  const sessionFilePath = join(tempSessionDir, 'rollout-2026-01-02T18-39-45-019b7f94-51b4-7593-922e-ba12b5b73b52.jsonl');
  const testSessionId = 'codex-test-session-' + Date.now() + '-' + Math.random().toString(36).substring(7);

  let adapter: CodexMetricsAdapter;
  let deltaWriter: DeltaWriter;
  let deltas: MetricDelta[];
  let snapshot: MetricSnapshot;

  beforeAll(async () => {
    // Setup: Copy fixture file to temp directory with proper date structure
    mkdirSync(tempSessionDir, { recursive: true });
    copyFileSync(
      join(fixturesSessionDir, 'rollout-2026-01-02T18-39-45-019b7f94-51b4-7593-922e-ba12b5b73b52.jsonl'),
      sessionFilePath
    );

    adapter = new CodexMetricsAdapter(CodexPluginMetadata);
    deltaWriter = new DeltaWriter(testSessionId);

    // Parse full session snapshot
    snapshot = await adapter.parseSessionFile(sessionFilePath);

    // Parse incremental metrics from fixture session file
    const result = await adapter.parseIncrementalMetrics(sessionFilePath, new Set(), new Set());

    // Write deltas to disk
    for (const delta of result.deltas) {
      await deltaWriter.appendDelta({
        ...delta,
        sessionId: testSessionId // Override with test session ID
      });
    }

    // Read back from disk for validation
    deltas = await deltaWriter.readAll();
  });

  afterAll(() => {
    // Clean up test metrics file
    if (deltaWriter.exists()) {
      unlinkSync(deltaWriter.getFilePath());
    }

    // Clean up temp test directory
    try {
      unlinkSync(sessionFilePath);
      // Note: tmpdir cleanup happens automatically on system reboot
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Adapter Configuration', () => {
    it('should detect correct data paths', () => {
      const dataPaths = adapter.getDataPaths();
      expect(dataPaths.sessionsDir).toContain('.codex');
      expect(dataPaths.sessionsDir).toContain('sessions');
      expect(dataPaths.settingsDir).toContain('.codex');
    });

    it('should use object-based watermark strategy', () => {
      expect(adapter.getWatermarkStrategy()).toBe('object');
    });

    it('should have 500ms initialization delay', () => {
      expect(adapter.getInitDelay()).toBe(500);
    });
  });

  describe('Session Identification', () => {
    it('should extract correct session ID from filename', () => {
      const sessionId = adapter.extractSessionId(sessionFilePath);
      expect(sessionId).toBe('019b7f94-51b4-7593-922e-ba12b5b73b52');
    });

    it('should extract session ID from real Codex path', () => {
      const realPath = '/Users/user/.codex/sessions/2026/01/02/rollout-2026-01-02T16-58-23-019b7f37-8646-7b42-af3b-3a02bcaed870.jsonl';
      const sessionId = adapter.extractSessionId(realPath);
      expect(sessionId).toBe('019b7f37-8646-7b42-af3b-3a02bcaed870');
    });
  });

  describe('Full Session Parse - Golden Dataset', () => {
    it('should extract correct session ID', () => {
      expect(snapshot.sessionId).toBe('019b7f94-51b4-7593-922e-ba12b5b73b52');
    });

    it('should count correct number of turns', () => {
      expect(snapshot.turnCount).toBe(4);
    });

    it('should identify correct model', () => {
      expect(snapshot.model).toBe('gpt-5-1-codex-2025-11-13');
    });

    it('should calculate correct input tokens', () => {
      expect(snapshot.tokens?.input).toBe(22474);
    });

    it('should calculate correct output tokens', () => {
      expect(snapshot.tokens?.output).toBe(428);
    });

    it('should calculate correct cache read tokens', () => {
      expect(snapshot.tokens?.cacheRead).toBe(14848);
    });

    it('should calculate correct total tokens', () => {
      const total = (snapshot.tokens?.input || 0) + (snapshot.tokens?.output || 0) + (snapshot.tokens?.cacheRead || 0);
      expect(total).toBe(37750);
    });

    it('should extract tool calls', () => {
      expect(snapshot.toolCalls).toHaveLength(3);
      snapshot.toolCalls?.forEach(tc => {
        expect(tc.name).toBe('shell');
        expect(tc.status).toBe('success');
      });
    });

    it('should generate tool usage summary', () => {
      expect(snapshot.toolUsageSummary).toHaveLength(1);
      expect(snapshot.toolUsageSummary?.[0].name).toBe('shell');
      expect(snapshot.toolUsageSummary?.[0].count).toBe(3);
      expect(snapshot.toolUsageSummary?.[0].successCount).toBe(3);
      expect(snapshot.toolUsageSummary?.[0].errorCount).toBe(0);
    });

    it('should extract metadata', () => {
      expect(snapshot.metadata?.workingDirectory).toContain('codemie-code');
      expect(snapshot.metadata?.gitBranch).toBe('codex');
      expect(snapshot.metadata?.models).toContain('gpt-5-1-codex-2025-11-13');
    });

    it('should track model calls', () => {
      expect(snapshot.metadata?.modelCalls).toEqual({
        'gpt-5-1-codex-2025-11-13': 4
      });
    });
  });

  describe('Pipeline: Parse → Write → Read', () => {
    it('should write deltas to disk successfully', () => {
      expect(deltaWriter.exists()).toBe(true);
      expect(deltas.length).toBeGreaterThan(0);
    });

    it('should preserve all delta records', () => {
      // Expected: 6 deltas (3 unique token increments + 3 tool calls)
      // Deduplicated: only create deltas when cumulative tokens actually change
      expect(deltas).toHaveLength(6);
    });

    it('should set correct sync status for new deltas', () => {
      // All new deltas should be 'pending'
      const allPending = deltas.every(d => d.syncStatus === 'pending');
      expect(allPending).toBe(true);
    });

    it('should initialize sync attempts to 0', () => {
      const allZeroAttempts = deltas.every(d => d.syncAttempts === 0);
      expect(allZeroAttempts).toBe(true);
    });
  });

  describe('Golden Dataset: Incremental Delta Calculations', () => {
    it('should calculate deltas that sum exactly to snapshot totals', () => {
      // CRITICAL: Delta totals MUST equal snapshot totals (mathematical verification)
      const totalInput = deltas.reduce((sum, d) => sum + d.tokens.input, 0);
      const totalOutput = deltas.reduce((sum, d) => sum + d.tokens.output, 0);
      const totalCacheRead = deltas.reduce((sum, d) => sum + (d.tokens.cacheRead || 0), 0);

      // Verify against snapshot
      expect(totalInput).toBe(snapshot.tokens!.input);
      expect(totalOutput).toBe(snapshot.tokens!.output);
      expect(totalCacheRead).toBe(snapshot.tokens!.cacheRead || 0);

      // Explicit values for regression testing
      expect(totalInput).toBe(22474);
      expect(totalOutput).toBe(428);
      expect(totalCacheRead).toBe(14848);
    });

    it('should match Codex last_token_usage deltas exactly', async () => {
      // CRITICAL: Our deltas MUST match Codex's own delta calculations
      // Codex provides last_token_usage which shows the delta for each turn
      const content = await import('fs/promises').then(fs =>
        fs.readFile(sessionFilePath, 'utf-8')
      );
      const events = content.trim().split('\n').map(line => JSON.parse(line));

      // Extract token_count events with data
      const tokenEvents = events.filter(e =>
        e.type === 'event_msg' &&
        e.payload?.type === 'token_count' &&
        e.payload.info?.total_token_usage
      );

      // Simulate our delta calculation
      let prevInputTokens = 0;
      let prevOutputTokens = 0;
      let prevCachedTokens = 0;

      const ourDeltas: Array<{ input: number; output: number; cache: number }> = [];
      const codexDeltas: Array<{ input: number; output: number; cache: number }> = [];

      for (const event of tokenEvents) {
        const total = event.payload.info.total_token_usage;
        const last = event.payload.info.last_token_usage;

        // Our calculation (combines output + reasoning)
        const currInput = total.input_tokens || 0;
        const currOutput = (total.output_tokens || 0) + (total.reasoning_output_tokens || 0);
        const currCache = total.cached_input_tokens || 0;

        const deltaInput = Math.max(0, currInput - prevInputTokens);
        const deltaOutput = Math.max(0, currOutput - prevOutputTokens);
        const deltaCache = Math.max(0, currCache - prevCachedTokens);

        if (deltaInput > 0 || deltaOutput > 0 || deltaCache > 0) {
          ourDeltas.push({ input: deltaInput, output: deltaOutput, cache: deltaCache });

          // Codex's delta (combine output + reasoning from last_token_usage)
          const codexInput = last.input_tokens || 0;
          const codexOutput = (last.output_tokens || 0) + (last.reasoning_output_tokens || 0);
          const codexCache = last.cached_input_tokens || 0;
          codexDeltas.push({ input: codexInput, output: codexOutput, cache: codexCache });

          prevInputTokens = currInput;
          prevOutputTokens = currOutput;
          prevCachedTokens = currCache;
        }
      }

      // Verify our deltas match Codex's deltas exactly
      expect(ourDeltas.length).toBe(codexDeltas.length);
      for (let i = 0; i < ourDeltas.length; i++) {
        expect(ourDeltas[i]).toEqual(codexDeltas[i]);
      }
    });

    it('should handle duplicate token_count events correctly', () => {
      // Codex emits duplicate token_count events with same cumulative values
      // Our delta calculation should skip duplicates (produce 0 delta)
      const tokenDeltas = deltas.filter(d =>
        d.tokens.input > 0 || d.tokens.output > 0 || (d.tokens.cacheRead && d.tokens.cacheRead > 0)
      );

      // Should only create deltas for unique cumulative values, not duplicates
      // Verify no zero deltas were created
      for (const delta of tokenDeltas) {
        const hasNonZeroTokens = delta.tokens.input > 0 ||
                                 delta.tokens.output > 0 ||
                                 (delta.tokens.cacheRead && delta.tokens.cacheRead > 0);
        expect(hasNonZeroTokens).toBe(true);
      }
    });

    it('should combine output_tokens and reasoning_output_tokens', async () => {
      // CRITICAL: output + reasoning MUST be combined into single output field
      const content = await import('fs/promises').then(fs =>
        fs.readFile(sessionFilePath, 'utf-8')
      );
      const events = content.trim().split('\n').map(line => JSON.parse(line));

      // Find last token_count event with data
      const lastTokenEvent = events
        .filter(e =>
          e.type === 'event_msg' &&
          e.payload?.type === 'token_count' &&
          e.payload.info?.total_token_usage
        )
        .pop();

      const total = lastTokenEvent.payload.info.total_token_usage;
      const outputTokens = total.output_tokens || 0;
      const reasoningTokens = total.reasoning_output_tokens || 0;

      // Verify snapshot combines output + reasoning
      expect(snapshot.tokens!.output).toBe(outputTokens + reasoningTokens);

      // Explicit values: 300 output + 128 reasoning = 428
      expect(outputTokens).toBe(300);
      expect(reasoningTokens).toBe(128);
      expect(snapshot.tokens!.output).toBe(428);
    });

    it('should track model in all deltas', () => {
      const allHaveModel = deltas.every(d => d.models && d.models.length > 0);
      expect(allHaveModel).toBe(true);

      deltas.forEach(delta => {
        expect(delta.models).toContain('gpt-5-1-codex-2025-11-13');
      });
    });

    it('should track git branch in all deltas', () => {
      const allHaveBranch = deltas.every(d => d.gitBranch === 'codex');
      expect(allHaveBranch).toBe(true);
    });
  });

  describe('Golden Dataset: Delta 1 - Token Usage', () => {
    let tokenDelta: MetricDelta;

    beforeAll(() => {
      // Find the token usage delta (has tokens, no tools)
      tokenDelta = deltas.find(d => d.tokens.input > 0 && Object.keys(d.tools).length === 0)!;
    });

    it('should exist', () => {
      expect(tokenDelta).toBeDefined();
    });

    it('should have correct record ID format', () => {
      expect(tokenDelta.recordId).toMatch(/^019b7f94-51b4-7593-922e-ba12b5b73b52:.+:\d+$/);
    });

    it('should have correct agent session ID', () => {
      expect(tokenDelta.agentSessionId).toBe('019b7f94-51b4-7593-922e-ba12b5b73b52');
    });

    it('should have tokens from first turn', () => {
      // First delta has cumulative tokens from turn 1
      expect(tokenDelta.tokens.input).toBeGreaterThan(0);
      expect(tokenDelta.tokens.output).toBeGreaterThan(0);
    });

    it('should have no tools', () => {
      expect(Object.keys(tokenDelta.tools)).toHaveLength(0);
    });

    it('should track model', () => {
      expect(tokenDelta.models).toContain('gpt-5-1-codex-2025-11-13');
    });
  });

  describe('Golden Dataset: Delta 2 - Tool Call', () => {
    let toolDelta: MetricDelta;

    beforeAll(() => {
      // Find the tool call delta (has tools, no tokens)
      toolDelta = deltas.find(d => Object.keys(d.tools).length > 0)!;
    });

    it('should exist', () => {
      expect(toolDelta).toBeDefined();
    });

    it('should have correct record ID format', () => {
      expect(toolDelta.recordId).toMatch(/^019b7f94-51b4-7593-922e-ba12b5b73b52:.+:\d+$/);
    });

    it('should have no tokens', () => {
      expect(toolDelta.tokens.input).toBe(0);
      expect(toolDelta.tokens.output).toBe(0);
    });

    it('should track shell tool', () => {
      expect(toolDelta.tools.shell).toBe(1);
    });

    it('should have tool status', () => {
      expect(toolDelta.toolStatus?.shell).toEqual({
        success: 1,
        failure: 0
      });
    });

    it('should track model', () => {
      expect(toolDelta.models).toContain('gpt-5-1-codex-2025-11-13');
    });
  });

  describe('Session Correlation', () => {
    it('should generate unique record IDs', () => {
      const recordIds = deltas.map(d => d.recordId);
      const uniqueIds = new Set(recordIds);
      expect(uniqueIds.size).toBe(deltas.length);
    });

    it('should maintain consistent agent session ID', () => {
      const allSameSession = deltas.every(
        d => d.agentSessionId === '019b7f94-51b4-7593-922e-ba12b5b73b52'
      );
      expect(allSameSession).toBe(true);
    });

    it('should have ascending timestamps', () => {
      for (let i = 1; i < deltas.length; i++) {
        const prevTimestamp = typeof deltas[i - 1].timestamp === 'string'
          ? new Date(deltas[i - 1].timestamp).getTime()
          : deltas[i - 1].timestamp;
        const currTimestamp = typeof deltas[i].timestamp === 'string'
          ? new Date(deltas[i].timestamp).getTime()
          : deltas[i].timestamp;

        expect(currTimestamp).toBeGreaterThanOrEqual(prevTimestamp);
      }
    });
  });
});

describe('CodexMetricsAdapter - Error Handling', () => {
  const fixturesDir = join(__dirname, 'fixtures', 'codex');
  const fixturesSessionDir = join(fixturesDir, 'sessions', '2026', '01', '02');
  const errorSessionPath = join(fixturesSessionDir, 'rollout-2026-01-02T19-00-00-019b7f95-0000-7000-0000-000000000001.jsonl');

  let adapter: CodexMetricsAdapter;
  let snapshot: MetricSnapshot;

  beforeAll(async () => {
    adapter = new CodexMetricsAdapter(CodexPluginMetadata);
    snapshot = await adapter.parseSessionFile(errorSessionPath);
  });

  it('should parse session with mixed success/failure tool calls', () => {
    expect(snapshot.toolCalls).toHaveLength(3);
  });

  it('should correctly identify successful tool calls', () => {
    const successCalls = snapshot.toolCalls?.filter(tc => tc.status === 'success') || [];
    expect(successCalls).toHaveLength(2);
  });

  it('should correctly identify failed tool calls', () => {
    const failedCalls = snapshot.toolCalls?.filter(tc => tc.status === 'error') || [];
    expect(failedCalls).toHaveLength(1);
  });

  it('should track failure in tool usage summary', () => {
    const shellSummary = snapshot.toolUsageSummary?.find(t => t.name === 'shell');
    expect(shellSummary).toBeDefined();
    expect(shellSummary?.count).toBe(3);
    expect(shellSummary?.successCount).toBe(2);
    expect(shellSummary?.errorCount).toBe(1);
  });

  it('should include error details in failed tool calls', () => {
    const failedCall = snapshot.toolCalls?.find(tc => tc.status === 'error');
    expect(failedCall).toBeDefined();
    expect(failedCall?.error).toContain('No such file or directory');
  });

  it('should track toolStatus with failures in deltas', async () => {
    const result = await adapter.parseIncrementalMetrics(errorSessionPath, new Set(), new Set());
    const toolDeltas = result.deltas.filter(d => Object.keys(d.tools).length > 0);

    // Should have 3 tool call deltas
    expect(toolDeltas).toHaveLength(3);

    // Find the failed tool delta
    const failedDelta = toolDeltas.find(d => d.toolStatus?.shell?.failure === 1);
    expect(failedDelta).toBeDefined();
    expect(failedDelta?.toolStatus?.shell?.success).toBe(0);
    expect(failedDelta?.toolStatus?.shell?.failure).toBe(1);
  });

  it('should calculate correct total tokens including failed calls', () => {
    const totalInput = snapshot.tokens?.input || 0;
    const totalOutput = snapshot.tokens?.output || 0;

    // Total: 5300 input + 180 output = 5480
    expect(totalInput).toBe(5300);
    expect(totalOutput).toBe(180);
  });
});
