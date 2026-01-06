# Agent Metrics Integration Testing Guide

**Context**: This file provides specialized guidance for agent metrics integration tests with a focus on **complete verification** and **mathematical correctness**.

---

## Overview

Metrics integration tests validate the **complete pipeline** from agent session files to stored metrics:

```
Agent Session File → Adapter.parse() → Deltas → DeltaWriter → Stored Metrics → Validation
```

**Critical Requirement**: Every metrics test MUST include the **full verification suite** to ensure mathematical correctness and data integrity.

---

## Full Verification Suite (Mandatory)

Every agent metrics test MUST implement these validation sections:

### 1. Adapter Configuration (3 tests)
```typescript
describe('Adapter Configuration', () => {
  it('should detect correct data paths', () => {
    const dataPaths = adapter.getDataPaths();
    expect(dataPaths.sessionsDir).toContain('.{agent}');
    expect(dataPaths.settingsDir).toContain('.{agent}');
  });

  it('should use correct watermark strategy', () => {
    // Claude: 'hash' | Codex: 'object' | Gemini: 'line'
    expect(adapter.getWatermarkStrategy()).toBe('{strategy}');
  });

  it('should have correct initialization delay', () => {
    // Standard: 500ms for all agents
    expect(adapter.getInitDelay()).toBe(500);
  });
});
```

**Why Critical**: Configuration errors cause system-wide failures (wrong paths = no metrics, wrong strategy = duplicates/loss).

### 2. Session Identification (2 tests)
```typescript
describe('Session Identification', () => {
  it('should extract correct session ID from filename', () => {
    const sessionId = adapter.extractSessionId(sessionFilePath);
    expect(sessionId).toBe(EXPECTED_SESSION_ID);
  });

  it('should extract session ID from real {agent} path', () => {
    const realPath = '/path/to/{agent}/session-file';
    const sessionId = adapter.extractSessionId(realPath);
    expect(sessionId).toBe(EXPECTED_ID);
  });
});
```

**Why Critical**: Wrong session IDs break correlation between metrics and sessions.

### 3. Full Session Parse - Golden Dataset (5-7 tests)
```typescript
describe('Full Session Parse - Golden Dataset', () => {
  it('should extract correct session ID', () => {
    expect(snapshot.sessionId).toBe(EXPECTED_SESSION_ID);
  });

  it('should count correct number of turns', () => {
    expect(snapshot.turnCount).toBe(EXPECTED_TURNS);
  });

  it('should identify correct model', () => {
    expect(snapshot.model).toBe(EXPECTED_MODEL);
  });

  it('should calculate correct input tokens', () => {
    expect(snapshot.tokens.input).toBe(EXPECTED_INPUT);
  });

  it('should calculate correct output tokens', () => {
    expect(snapshot.tokens.output).toBe(EXPECTED_OUTPUT);
  });

  it('should calculate correct cache tokens', () => {
    // Claude: cacheCreation + cacheRead
    // Codex: cacheRead only
    // Gemini: N/A
    expect(snapshot.tokens.cacheRead).toBe(EXPECTED_CACHE);
  });

  it('should extract tool calls', () => {
    expect(snapshot.toolCalls).toHaveLength(EXPECTED_TOOL_COUNT);
    // Validate tool types and statuses
  });

  it('should extract metadata', () => {
    expect(snapshot.metadata.workingDirectory).toContain('project');
    expect(snapshot.metadata.gitBranch).toBe(EXPECTED_BRANCH);
  });
});
```

**Why Critical**: Validates adapter correctly parses session files with real data.

### 4. Incremental Delta Calculations (3-4 tests)
```typescript
describe('Golden Dataset: Incremental Delta Calculations', () => {
  it('should calculate deltas that sum exactly to snapshot totals', () => {
    // MATHEMATICAL VERIFICATION - MOST CRITICAL TEST
    const totalInput = deltas.reduce((sum, d) => sum + d.tokens.input, 0);
    const totalOutput = deltas.reduce((sum, d) => sum + d.tokens.output, 0);

    expect(totalInput).toBe(snapshot.tokens.input);
    expect(totalOutput).toBe(snapshot.tokens.output);
  });

  it('should handle incremental token tracking correctly', () => {
    // Agent-specific: validate cumulative vs incremental logic
  });

  it('should track model in all deltas', () => {
    const allHaveModel = deltas.every(d => d.models && d.models.length > 0);
    expect(allHaveModel).toBe(true);
  });

  it('should track git branch in all deltas', () => {
    const allHaveBranch = deltas.every(d => d.gitBranch === EXPECTED_BRANCH);
    expect(allHaveBranch).toBe(true);
  });
});
```

**Why Critical**: Ensures incremental tracking produces mathematically correct results. **Delta sum MUST equal snapshot** - this is the most important verification.

### 5. Pipeline: Parse → Write → Read (3 tests)
```typescript
describe('Pipeline: Parse → Write → Read', () => {
  it('should write deltas to disk successfully', () => {
    expect(deltaWriter.exists()).toBe(true);
    expect(deltas.length).toBeGreaterThan(0);
  });

  it('should preserve all delta records', () => {
    expect(deltas).toHaveLength(EXPECTED_DELTA_COUNT);
  });

  it('should set correct sync status for new deltas', () => {
    const allPending = deltas.every(d => d.syncStatus === 'pending');
    expect(allPending).toBe(true);
  });
});
```

**Why Critical**: Validates data persistence and sync tracking.

### 6. End-to-End Validation (1 test)
```typescript
describe('End-to-End Validation', () => {
  it('should match golden dataset expectations', () => {
    // Total tokens calculation
    const totalTokens = deltas.reduce((sum, d) =>
      sum + d.tokens.input + d.tokens.output +
      (d.tokens.cacheCreation || 0) + (d.tokens.cacheRead || 0),
      0
    );
    expect(totalTokens).toBe(EXPECTED_TOTAL_TOKENS);

    // Tool calls count
    const totalToolCalls = deltas.reduce((sum, d) => {
      if (!d.tools) return sum;
      return sum + Object.values(d.tools).reduce((s, count) => s + count, 0);
    }, 0);
    expect(totalToolCalls).toBe(EXPECTED_TOOL_COUNT);

    // All operations successful (if applicable)
    const hasErrors = deltas.some(d => d.apiErrorMessage);
    expect(hasErrors).toBe(EXPECTED_HAS_ERRORS);
  });
});
```

**Why Critical**: Final sanity check that all metrics are correct.

---

## Golden Dataset Requirements

Every test fixture MUST include:

### 1. Fixture README.md
Document these values clearly:
```markdown
# {Agent} Test Fixtures

## Golden Dataset

**Session ID**: xxx
**Turns**: N
**Input Tokens**: N
**Output Tokens**: N
**Cache Tokens**: N
**Total Tokens**: N
**Tool Calls**: N
**Models**: [list]

## Expected Deltas

**Count**: N
**Delta Input Sum**: N (must equal snapshot input)
**Delta Output Sum**: N (must equal snapshot output)
```

### 2. Mathematical Verification
The most critical test validates **delta sum = snapshot**:

```typescript
// This test MUST pass - it's mathematical proof of correctness
it('should calculate deltas that sum exactly to snapshot totals', () => {
  const totalInput = deltas.reduce((sum, d) => sum + d.tokens.input, 0);
  const totalOutput = deltas.reduce((sum, d) => sum + d.tokens.output, 0);

  // CRITICAL: These MUST be equal
  expect(totalInput).toBe(snapshot.tokens.input);
  expect(totalOutput).toBe(snapshot.tokens.output);
});
```

**Why**: If deltas don't sum to snapshot, the adapter has a calculation bug that will cause incorrect metrics in production.

---

## Agent-Specific Patterns

### Claude

**Path Pattern**: `~/.claude/projects/{hash}/{uuid}.jsonl`
**Watermark**: `hash` (full file hash)
**Key Features**:
- Agent files (sub-agents) with same sessionId
- Cache creation + cache read tokens
- Multi-model sessions (Sonnet + Haiku)

**Specific Tests**:
```typescript
describe('Agent File Discovery', () => {
  it('should find and parse all agent files with matching sessionId', () => {
    // Validates automatic sidechain discovery
  });
});

describe('Cache Token Tracking', () => {
  it('should track both cache creation and cache read', () => {
    expect(snapshot.tokens.cacheCreation).toBeGreaterThan(0);
    expect(snapshot.tokens.cacheRead).toBeGreaterThan(0);
  });
});
```

### Codex

**Path Pattern**: `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{date}T{time}-{uuid}.jsonl`
**Watermark**: `object` (record ID tracking)
**Key Features**:
- Date-based hierarchy
- Cumulative token tracking with deltas
- Performance optimization via date filtering

**Specific Tests**:
```typescript
describe('Date Filtering', () => {
  it('should match today\'s session by default', () => {
    // Performance: only match current date
  });

  it('should match all dates when filter is null', () => {
    // Historical analysis mode
  });
});

describe('Cumulative Token Tracking', () => {
  it('should match Codex last_token_usage deltas exactly', () => {
    // Cross-validation with agent's own delta calculation
  });

  it('should combine output_tokens and reasoning_output_tokens', () => {
    // Codex-specific: output + reasoning = total output
  });
});
```

### Gemini

**Path Pattern**: `~/.gemini/logs/{project-hash}/session-{date}T{time}-{hash}.json`
**Watermark**: `line` (line number tracking)
**Key Features**:
- Project hash mapping
- Separate logs.json file
- Line-by-line incremental processing

**Specific Tests**:
```typescript
describe('Project Hash Mapping', () => {
  it('should register project mapping for analytics', () => {
    // Validates project hash → path mapping
  });
});

describe('Line-Based Watermark', () => {
  it('should track last processed line number', () => {
    // Validates incremental processing
  });
});
```

---

## Common Validation Patterns

### Tool Call Validation
```typescript
describe('Tool Call Tracking', () => {
  it('should track all {toolName} operations correctly', () => {
    const toolCalls = deltas
      .filter(d => d.tools?.['ToolName'])
      .reduce((sum, d) => sum + (d.tools!['ToolName'] || 0), 0);

    expect(toolCalls).toBe(EXPECTED_COUNT);
  });

  it('should mark all tool calls with correct status', () => {
    const hasFailures = deltas.some(d => {
      if (!d.toolStatus) return false;
      return Object.values(d.toolStatus).some(status => status.failure > 0);
    });

    expect(hasFailures).toBe(EXPECTED_HAS_FAILURES);
  });
});
```

### File Operations Validation
```typescript
describe('File Operations', () => {
  it('should track file creation operations', () => {
    const fileOps = deltas.flatMap(d => d.fileOperations || []);
    const writeOps = fileOps.filter(op => op.type === 'write');

    expect(writeOps).toHaveLength(EXPECTED_WRITES);
  });

  it('should calculate correct total lines added', () => {
    const fileOps = deltas.flatMap(d => d.fileOperations || []);
    const totalLinesAdded = fileOps.reduce((sum, op) =>
      sum + (op.linesAdded || 0), 0
    );

    expect(totalLinesAdded).toBe(EXPECTED_LINES);
  });
});
```

### Session Correlation
```typescript
describe('Session Correlation', () => {
  it('should generate unique record IDs', () => {
    const recordIds = deltas.map(d => d.recordId);
    const uniqueIds = new Set(recordIds);
    expect(uniqueIds.size).toBe(deltas.length);
  });

  it('should maintain consistent agent session ID', () => {
    const allSameSession = deltas.every(
      d => d.agentSessionId === EXPECTED_AGENT_SESSION_ID
    );
    expect(allSameSession).toBe(true);
  });
});
```

---

## Test Structure Template

```typescript
/**
 * Integration Test: {Agent} Metrics - Full Pipeline
 *
 * Golden Dataset:
 * - Session: {session-id}
 * - Turns: N
 * - Tokens: N input / N output / N cache
 * - Tools: N calls
 * - Models: [list]
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, mkdirSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentMetricsAdapter } from '../../src/agents/plugins/{agent}.metrics.js';
import { AgentPluginMetadata } from '../../src/agents/plugins/{agent}.plugin.js';
import { DeltaWriter } from '../../src/agents/core/metrics/core/DeltaWriter.js';
import type { MetricDelta, MetricSnapshot } from '../../src/agents/core/metrics/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('{Agent}MetricsAdapter - Full Pipeline Integration Test', () => {
  const fixturesDir = join(__dirname, 'fixtures', '{agent}');
  const tempDir = join(tmpdir(), '{agent}-test-' + Date.now());

  let adapter: AgentMetricsAdapter;
  let snapshot: MetricSnapshot;
  let deltas: MetricDelta[];
  let deltaWriter: DeltaWriter;

  beforeAll(async () => {
    // 1. Setup fixtures
    mkdirSync(tempDir, { recursive: true });
    copyFileSync(
      join(fixturesDir, 'session-file'),
      join(tempDir, 'session-file')
    );

    // 2. Create adapter
    adapter = new AgentMetricsAdapter(AgentPluginMetadata);

    // 3. Parse full snapshot
    snapshot = await adapter.parseSessionFile(join(tempDir, 'session-file'));

    // 4. Parse incremental deltas
    const result = await adapter.parseIncrementalMetrics(
      join(tempDir, 'session-file'),
      new Set(),
      new Set()
    );

    // 5. Write to disk
    deltaWriter = new DeltaWriter('test-session-' + Date.now());
    for (const delta of result.deltas) {
      await deltaWriter.appendDelta({
        ...delta,
        sessionId: deltaWriter.getSessionId()
      });
    }

    // 6. Read back
    deltas = await deltaWriter.readAll();
  });

  afterAll(() => {
    // Cleanup
    if (deltaWriter.exists()) {
      unlinkSync(deltaWriter.getFilePath());
    }
    try {
      unlinkSync(join(tempDir, 'session-file'));
    } catch {}
  });

  // === MANDATORY VERIFICATION SUITE ===

  describe('Adapter Configuration', () => {
    // 3 tests - see above
  });

  describe('Session Identification', () => {
    // 2 tests - see above
  });

  describe('Full Session Parse - Golden Dataset', () => {
    // 5-7 tests - see above
  });

  describe('Incremental Delta Calculations', () => {
    // 3-4 tests - see above (INCLUDES CRITICAL MATH VERIFICATION)
  });

  describe('Pipeline: Parse → Write → Read', () => {
    // 3 tests - see above
  });

  describe('End-to-End Validation', () => {
    // 1 test - see above
  });

  // === AGENT-SPECIFIC TESTS (optional) ===

  describe('{Agent}-Specific Features', () => {
    // Add agent-specific validation here
  });
});
```

---

## Verification Checklist

Before committing a metrics integration test, verify:

- [ ] **Adapter Configuration**: 3 tests (paths, watermark, delay)
- [ ] **Session Identification**: 2 tests (extractSessionId)
- [ ] **Full Session Parse**: 5-7 tests (tokens, tools, metadata)
- [ ] **Delta Calculations**: 3-4 tests (INCLUDES mathematical verification)
- [ ] **Pipeline Test**: 3 tests (write, read, sync status)
- [ ] **End-to-End**: 1 test (golden dataset totals)
- [ ] **Golden Dataset**: Documented in fixture README.md
- [ ] **Mathematical Proof**: Delta sum = snapshot (CRITICAL)
- [ ] **Real Data**: Uses actual agent session files
- [ ] **Performance**: Completes in < 200ms
- [ ] **No Redundancy**: Each test validates unique aspect

**Minimum**: 17-20 tests per agent
**Critical Test**: Delta sum = snapshot (mathematical verification)

---

## Error Handling Tests (Optional but Recommended)

For comprehensive coverage, add a separate error handling section:

```typescript
describe('{Agent}MetricsAdapter - Error Handling', () => {
  const errorFixturePath = join(fixturesDir, 'error-session-file');
  let errorSnapshot: MetricSnapshot;

  beforeAll(async () => {
    errorSnapshot = await adapter.parseSessionFile(errorFixturePath);
  });

  it('should parse session with mixed success/failure tool calls', () => {
    expect(errorSnapshot.toolCalls).toHaveLength(EXPECTED_TOTAL);
  });

  it('should correctly identify failed tool calls', () => {
    const failedCalls = errorSnapshot.toolCalls?.filter(
      tc => tc.status === 'error'
    ) || [];
    expect(failedCalls).toHaveLength(EXPECTED_FAILURES);
  });

  it('should track failure in tool usage summary', () => {
    const toolSummary = errorSnapshot.toolUsageSummary?.find(
      t => t.name === 'ToolName'
    );
    expect(toolSummary?.errorCount).toBe(EXPECTED_FAILURES);
  });

  it('should include error details in failed tool calls', () => {
    const failedCall = errorSnapshot.toolCalls?.find(tc => tc.status === 'error');
    expect(failedCall?.error).toBeDefined();
    expect(failedCall?.error).toContain('error message');
  });
});
```

---

## Common Mistakes to Avoid

### ❌ Missing Mathematical Verification
```typescript
// WRONG - doesn't verify delta sum
it('should have deltas', () => {
  expect(deltas.length).toBeGreaterThan(0); // Not enough!
});

// CORRECT - verifies mathematical correctness
it('should calculate deltas that sum exactly to snapshot totals', () => {
  const totalInput = deltas.reduce((sum, d) => sum + d.tokens.input, 0);
  expect(totalInput).toBe(snapshot.tokens.input); // MUST equal!
});
```

### ❌ Incomplete Golden Dataset
```typescript
// WRONG - missing critical values
it('should parse tokens', () => {
  expect(snapshot.tokens.input).toBeGreaterThan(0); // Too generic
});

// CORRECT - validates exact golden dataset value
it('should calculate correct input tokens', () => {
  expect(snapshot.tokens.input).toBe(22474); // Exact value from fixture
});
```

### ❌ No Agent-Specific Validation
```typescript
// WRONG - generic test that doesn't validate agent-specific logic
it('should parse session', () => {
  expect(snapshot).toBeDefined();
});

// CORRECT - validates Codex-specific cumulative tracking
it('should combine output_tokens and reasoning_output_tokens', () => {
  // Codex provides both separately, we combine them
  const outputTokens = 300;
  const reasoningTokens = 128;
  expect(snapshot.tokens.output).toBe(428); // 300 + 128
});
```

---

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Test file execution | < 200ms | Total time for beforeAll + all tests |
| Individual test | < 1ms | No I/O in test cases |
| beforeAll setup | < 150ms | Parsing + writing fixtures |
| Fixture size | < 50KB | Keep files small for fast parsing |

---

## Reference Implementations

**Claude**: `claude-metrics.test.ts`
- Complete verification suite
- Agent file discovery
- Multi-model sessions
- Cache token tracking

**Codex**: `codex-metrics.test.ts`
- Date filtering
- Cumulative delta validation
- Cross-validation with agent's own deltas
- Error handling fixture

**Gemini**: `gemini-metrics.test.ts`
- Project hash mapping
- Line-based watermark
- Separate logs.json parsing

**All tests follow the same structure** with agent-specific additions. Use any as a template.

---

## Key Takeaways

1. **Full verification suite is MANDATORY** - every metrics test must have all 6 sections
2. **Mathematical verification is CRITICAL** - delta sum MUST equal snapshot
3. **Golden dataset must be documented** - in fixture README.md
4. **Real data only** - use actual agent session files
5. **Performance matters** - parse once in beforeAll, validate in tests
6. **Agent-specific patterns** - add specialized tests for unique features

**Bottom line**: If your test doesn't include mathematical verification (delta sum = snapshot), it's incomplete.
