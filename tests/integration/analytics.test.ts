/**
 * Simplified E2E Analytics Test
 *
 * Tests the complete analytics pipeline using real Claude session data.
 * Validates that running `codemie analytics --session <id>` produces
 * correct aggregated statistics matching our golden dataset.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { MetricsDataLoader } from '../../src/cli/commands/analytics/data-loader.js';
import { AnalyticsAggregator } from '../../src/cli/commands/analytics/aggregator.js';
import { setupTestIsolation, getTestHome } from '../helpers/test-isolation.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Analytics E2E Test - Golden Dataset Validation', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  const fixturesDir = join(__dirname, 'metrics', 'fixtures', 'claude');
  const testSessionId = '71a17a83-ff99-4d05-964b-0bd56892faec';

  // Use getTestHome() to get isolated test directory
  let testMetricsDir: string;
  let testSessionFile: string;
  let testMetricsFile: string;

  beforeAll(() => {
    // Initialize paths with isolated test home
    testMetricsDir = join(getTestHome(), 'metrics', 'sessions');
    testSessionFile = join(testMetricsDir, `${testSessionId}.json`);
    testMetricsFile = join(testMetricsDir, `${testSessionId}_metrics.jsonl`);

    // Setup: Copy expected files to isolated test directory
    mkdirSync(testMetricsDir, { recursive: true });
    copyFileSync(join(fixturesDir, 'expected-session.json'), testSessionFile);
    copyFileSync(join(fixturesDir, 'expected-metrics.jsonl'), testMetricsFile);
  });

  afterAll(() => {
    // Cleanup
    try {
      if (existsSync(testSessionFile)) unlinkSync(testSessionFile);
      if (existsSync(testMetricsFile)) unlinkSync(testMetricsFile);
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should load and aggregate session data correctly', () => {
    const loader = new MetricsDataLoader();
    const sessions = loader.loadSessions({ sessionId: testSessionId });

    // Verify session loaded
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(testSessionId);
    expect(sessions[0].deltas).toHaveLength(11); // Golden dataset has 11 deltas

    // Run aggregation
    const analytics = AnalyticsAggregator.aggregate(sessions, true);

    // Validate basic structure
    expect(analytics.totalSessions).toBe(1);
    expect(analytics.projects).toHaveLength(1);
    expect(analytics.projects[0].projectPath).toBe('/tmp/private');
  });

  it('should calculate correct token totals from golden dataset', () => {
    const loader = new MetricsDataLoader();
    const sessions = loader.loadSessions({ sessionId: testSessionId });
    const analytics = AnalyticsAggregator.aggregate(sessions, true);

    // Calculate expected from raw deltas
    const expectedInput = sessions[0].deltas.reduce((sum, d) => sum + d.tokens.input, 0);
    const expectedOutput = sessions[0].deltas.reduce((sum, d) => sum + d.tokens.output, 0);
    const expectedCacheCreation = sessions[0].deltas.reduce((sum, d) => sum + (d.tokens.cacheCreation || 0), 0);
    const expectedCacheRead = sessions[0].deltas.reduce((sum, d) => sum + (d.tokens.cacheRead || 0), 0);

    // Validate aggregated totals match
    expect(analytics.totalTokens.input).toBe(expectedInput);
    expect(analytics.totalTokens.output).toBe(expectedOutput);
    expect(analytics.totalTokens.cacheCreation).toBe(expectedCacheCreation);
    expect(analytics.totalTokens.cacheRead).toBe(expectedCacheRead);
    expect(analytics.totalTokens.total).toBe(expectedInput + expectedOutput + expectedCacheCreation + expectedCacheRead);
  });

  it('should track tool usage correctly', () => {
    const loader = new MetricsDataLoader();
    const sessions = loader.loadSessions({ sessionId: testSessionId });
    const analytics = AnalyticsAggregator.aggregate(sessions, true);

    // Tools are array of ToolStats
    expect(analytics.tools).toBeDefined();
    expect(Array.isArray(analytics.tools)).toBe(true);
    expect(analytics.tools.length).toBeGreaterThan(0);

    // Golden dataset: 3 Write + 1 Read + 1 Edit + 1 Bash = 6 total tool calls
    const totalToolCalls = analytics.tools.reduce((sum, tool) => sum + tool.totalCalls, 0);
    expect(totalToolCalls).toBe(6);

    // Verify Write tool exists and has correct count
    const writeTool = analytics.tools.find(t => t.toolName === 'Write');
    expect(writeTool).toBeDefined();
    expect(writeTool?.totalCalls).toBe(3);
  });

  it('should track file operations correctly', () => {
    const loader = new MetricsDataLoader();
    const sessions = loader.loadSessions({ sessionId: testSessionId });
    const analytics = AnalyticsAggregator.aggregate(sessions, true);

    // Verify file operations are tracked (aggregator counts unique files, not all operations)
    expect(analytics.totalFileOperations).toBeGreaterThan(0);
    expect(analytics.totalLinesAdded).toBeGreaterThan(0);

    // Verify we have file operation data in deltas
    const hasFileOps = sessions[0].deltas.some(d => d.fileOperations && d.fileOperations.length > 0);
    expect(hasFileOps).toBe(true);
  });

  it('should track models with normalization', () => {
    const loader = new MetricsDataLoader();
    const sessions = loader.loadSessions({ sessionId: testSessionId });
    const analytics = AnalyticsAggregator.aggregate(sessions, true); // normalize=true

    // Models are array of ModelStats
    expect(analytics.models).toBeDefined();
    expect(Array.isArray(analytics.models)).toBe(true);
    expect(analytics.models.length).toBeGreaterThan(0);

    // Golden dataset has claude-sonnet and claude-haiku (normalized)
    const models = analytics.models.map(m => m.model.toLowerCase());
    const hasClaude = models.some(m => m.includes('claude') || m.includes('sonnet') || m.includes('haiku'));
    expect(hasClaude).toBe(true);
  });

  it('should track languages used in file operations', () => {
    const loader = new MetricsDataLoader();
    const sessions = loader.loadSessions({ sessionId: testSessionId });
    const analytics = AnalyticsAggregator.aggregate(sessions, true);

    // Languages are array of LanguageStats
    expect(analytics.languages).toBeDefined();
    expect(Array.isArray(analytics.languages)).toBe(true);
    expect(analytics.languages.length).toBeGreaterThan(0);

    // Golden dataset has: python, markdown, javascript
    const languages = analytics.languages.map(l => l.language.toLowerCase());
    expect(languages).toContain('python');
    expect(languages).toContain('markdown');
    expect(languages).toContain('javascript');
  });

  it('should preserve data integrity through full pipeline', () => {
    const loader = new MetricsDataLoader();
    const sessions = loader.loadSessions({ sessionId: testSessionId });

    // Raw deltas
    expect(sessions[0].deltas).toHaveLength(11);

    // Calculate raw totals
    const rawInput = sessions[0].deltas.reduce((sum, d) => sum + d.tokens.input, 0);
    const rawOutput = sessions[0].deltas.reduce((sum, d) => sum + d.tokens.output, 0);

    // Aggregated totals should match exactly
    const analytics = AnalyticsAggregator.aggregate(sessions, true);
    expect(analytics.totalTokens.input).toBe(rawInput);
    expect(analytics.totalTokens.output).toBe(rawOutput);

    // No data loss
    expect(analytics.totalSessions).toBe(1);
    expect(analytics.projects).toHaveLength(1);
  });

  it('should match exact golden dataset values from expected-metrics.jsonl', async () => {
    const { readFile } = await import('fs/promises');

    // Load expected metrics file directly
    const expectedMetricsContent = await readFile(
      join(fixturesDir, 'expected-metrics.jsonl'),
      'utf-8'
    );
    const expectedDeltas = expectedMetricsContent
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line));

    // Calculate expected totals from golden dataset
    const expectedTokens = expectedDeltas.reduce((acc, d) => {
      acc.input += d.tokens.input || 0;
      acc.output += d.tokens.output || 0;
      acc.cacheCreation += d.tokens.cacheCreation || 0;
      acc.cacheRead += d.tokens.cacheRead || 0;
      return acc;
    }, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
    expectedTokens.total = expectedTokens.input + expectedTokens.output + expectedTokens.cacheCreation + expectedTokens.cacheRead;

    // Count tools from golden dataset
    const expectedTools = {};
    expectedDeltas.forEach(d => {
      if (d.tools) {
        Object.entries(d.tools).forEach(([tool, count]) => {
          expectedTools[tool] = (expectedTools[tool] || 0) + count;
        });
      }
    });
    const expectedTotalToolCalls = Object.values(expectedTools).reduce((sum, c) => sum + c, 0);

    // Count file operations from golden dataset
    const expectedFileOps = { write: 0, read: 0, edit: 0 };
    let expectedLinesAdded = 0;
    expectedDeltas.forEach(d => {
      if (d.fileOperations) {
        d.fileOperations.forEach(op => {
          expectedFileOps[op.type] = (expectedFileOps[op.type] || 0) + 1;
          expectedLinesAdded += op.linesAdded || 0;
        });
      }
    });

    // Now run analytics and compare
    const loader = new MetricsDataLoader();
    const sessions = loader.loadSessions({ sessionId: testSessionId });
    const analytics = AnalyticsAggregator.aggregate(sessions, true);

    // Validate exact token counts
    expect(analytics.totalTokens.input).toBe(expectedTokens.input);
    expect(analytics.totalTokens.output).toBe(expectedTokens.output);
    expect(analytics.totalTokens.cacheCreation).toBe(expectedTokens.cacheCreation);
    expect(analytics.totalTokens.cacheRead).toBe(expectedTokens.cacheRead);
    expect(analytics.totalTokens.total).toBe(expectedTokens.total);

    // Validate exact tool counts
    const actualTotalToolCalls = analytics.tools.reduce((sum, t) => sum + t.totalCalls, 0);
    expect(actualTotalToolCalls).toBe(expectedTotalToolCalls);

    // Validate Write tool specifically (most common)
    const writeTool = analytics.tools.find(t => t.toolName === 'Write');
    expect(writeTool?.totalCalls).toBe(expectedTools['Write'] || 0);

    // Validate lines added
    expect(analytics.totalLinesAdded).toBe(expectedLinesAdded);

    // Validate ALL fields displayed by analytics command

    // 1. Sessions count
    expect(analytics.totalSessions).toBe(1);

    // 2. Duration (should be > 0 for active session)
    expect(analytics.totalDuration).toBeGreaterThanOrEqual(0);

    // 3. Turns (total deltas)
    expect(analytics.totalTurns).toBe(expectedDeltas.length);

    // 4. Token breakdown (already validated above, but let's be explicit)
    expect(analytics.totalTokens.input).toBe(expectedTokens.input);
    expect(analytics.totalTokens.output).toBe(expectedTokens.output);
    expect(analytics.totalTokens.cacheCreation).toBe(expectedTokens.cacheCreation);
    expect(analytics.totalTokens.cacheRead).toBe(expectedTokens.cacheRead);
    expect(analytics.totalTokens.total).toBe(expectedTokens.total);
    expect(analytics.totalTokens.cacheHitRate).toBeDefined();
    expect(analytics.totalTokens.cacheHitRate).toBeGreaterThanOrEqual(0);
    expect(analytics.totalTokens.cacheHitRate).toBeLessThanOrEqual(1);

    // 5. File operations count (already validated)
    expect(analytics.totalFileOperations).toBeGreaterThan(0);

    // 6. Lines added/removed/modified
    expect(analytics.totalLinesAdded).toBe(expectedLinesAdded);
    expect(analytics.totalLinesRemoved).toBeGreaterThanOrEqual(0);
    expect(analytics.totalLinesModified).toBeGreaterThanOrEqual(0);
    expect(analytics.netLinesChanged).toBeDefined();

    // 7. Tool calls with success rates
    expect(analytics.totalToolCalls).toBe(expectedTotalToolCalls);
    expect(analytics.successfulToolCalls).toBe(expectedTotalToolCalls); // All tools succeeded
    expect(analytics.failedToolCalls).toBe(0);
    expect(analytics.toolSuccessRate).toBe(100); // 100% success rate

    // 8. Models array (displayed in table)
    expect(analytics.models).toBeDefined();
    expect(Array.isArray(analytics.models)).toBe(true);
    expect(analytics.models.length).toBeGreaterThan(0);

    // Validate model percentages sum to 100%
    const totalPercentage = analytics.models.reduce((sum, m) => sum + m.percentage, 0);
    expect(Math.round(totalPercentage)).toBe(100);

    // 9. Tools array (displayed in table)
    expect(analytics.tools).toBeDefined();
    expect(Array.isArray(analytics.tools)).toBe(true);

    // Validate each tool has required fields
    analytics.tools.forEach(tool => {
      expect(tool).toHaveProperty('toolName');
      expect(tool).toHaveProperty('totalCalls');
      expect(tool).toHaveProperty('successCount');
      expect(tool).toHaveProperty('failureCount');
      expect(tool).toHaveProperty('successRate');
      expect(tool.successRate).toBeGreaterThanOrEqual(0);
      expect(tool.successRate).toBeLessThanOrEqual(100);
    });

    // 10. Languages array
    expect(analytics.languages).toBeDefined();
    expect(Array.isArray(analytics.languages)).toBe(true);
    expect(analytics.languages.length).toBeGreaterThan(0);

    // 11. Formats array
    expect(analytics.formats).toBeDefined();
    expect(Array.isArray(analytics.formats)).toBe(true);

    // 12. Projects array
    expect(analytics.projects).toBeDefined();
    expect(Array.isArray(analytics.projects)).toBe(true);
    expect(analytics.projects.length).toBe(1);

    // Validate project structure
    const project = analytics.projects[0];
    expect(project.projectPath).toBe('/tmp/private');
    expect(project.totalSessions).toBe(1);
    expect(project.totalTokens.input).toBe(analytics.totalTokens.input);
    expect(project.totalTokens.output).toBe(analytics.totalTokens.output);
    expect(project.totalTokens.total).toBe(analytics.totalTokens.total);
    expect(project.branches).toBeDefined();
    expect(Array.isArray(project.branches)).toBe(true);

    // Log golden dataset summary for visibility
    console.log('\n=== Golden Dataset Validation ===');
    console.log('ANALYTICS SUMMARY:');
    console.log(`  Sessions: ${analytics.totalSessions}`);
    console.log(`  Duration: ${analytics.totalDuration}ms`);
    console.log(`  Turns: ${analytics.totalTurns}`);
    console.log(`  Tokens: ${analytics.totalTokens.total.toLocaleString()}`);
    console.log(`    Input: ${analytics.totalTokens.input.toLocaleString()}`);
    console.log(`    Output: ${analytics.totalTokens.output.toLocaleString()}`);
    console.log(`    Cache Creation: ${analytics.totalTokens.cacheCreation.toLocaleString()}`);
    console.log(`    Cache Read: ${analytics.totalTokens.cacheRead.toLocaleString()}`);
    console.log(`  File Operations: ${analytics.totalFileOperations}`);
    console.log(`  Lines: +${analytics.totalLinesAdded} -${analytics.totalLinesRemoved} ~${analytics.totalLinesModified} (${analytics.netLinesChanged})`);
    console.log(`  Tool Calls: ${analytics.totalToolCalls} (✓${analytics.successfulToolCalls} ✗${analytics.failedToolCalls} ${analytics.toolSuccessRate.toFixed(1)}%)`);
    console.log('\nMODELS:');
    analytics.models.forEach(m => {
      console.log(`  ${m.model}: ${m.calls} calls (${m.percentage.toFixed(1)}%)`);
    });
    console.log('\nTOOLS:');
    analytics.tools.forEach(t => {
      console.log(`  ${t.toolName}: ${t.totalCalls} calls (${t.successRate.toFixed(1)}% success)`);
    });
    console.log('\nLANGUAGES:');
    analytics.languages.forEach(l => {
      console.log(`  ${l.language}: ${l.filesCreated} created, ${l.filesModified} modified, ${l.tokens} tokens`);
    });
    console.log('\nPROJECTS:');
    analytics.projects.forEach(p => {
      console.log(`  ${p.projectPath} (${p.totalSessions} sessions)`);
    });
    console.log('\n=== ALL ANALYTICS FIELDS VALIDATED ✓ ===\n');
  });
});
