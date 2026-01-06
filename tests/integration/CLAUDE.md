# Integration Testing Guide

**Context**: This file provides guidance for writing integration tests in CodeMie CLI with a focus on **simplicity and performance**.

---

## Specialized Documentation

For **agent metrics integration tests**, see the comprehensive guide:
- **[metrics/CLAUDE.md](metrics/CLAUDE.md)** - Full verification suite, golden dataset validation, mathematical correctness

**IMPORTANT**: Metrics tests are in a separate folder (`tests/integration/metrics/`) with specialized requirements:
- **Mandatory verification suite**: 6 test sections covering adapter config, parsing, deltas, and pipeline
- **Mathematical verification**: Delta sum MUST equal snapshot (critical correctness proof)
- **Golden dataset**: Expected values documented in fixture README.md
- **17-20 tests minimum** per agent with complete verification

This document covers general integration testing patterns. Metrics tests have additional requirements documented separately.

---

## Core Principles

### 1. **Performance First**
Integration tests must run FAST. Every millisecond counts when running the full test suite.

**Target**: < 100ms per test file average execution time

**Key Strategies**:
- ✅ Use small, focused fixture files (< 50KB)
- ✅ Single `beforeAll` for expensive setup (parse once, validate many times)
- ✅ Avoid redundant parsing or I/O operations
- ✅ Reuse parsed data across multiple test cases
- ❌ Never parse the same file twice in the same test suite
- ❌ No nested describe blocks with separate beforeAll/afterAll
- ❌ No file system operations inside individual test cases

### 2. **Simplicity Over Coverage**
Write focused tests that validate critical functionality with real data, not exhaustive edge cases.

**Good Test**: Validates end-to-end pipeline with real session data
**Bad Test**: 50 variations of the same calculation logic

**Key Strategies**:
- ✅ Test with REAL production data from fixtures
- ✅ Golden dataset validation (known inputs → expected outputs)
- ✅ One logical assertion per test case
- ✅ Group related assertions (e.g., "token calculations") into single test
- ❌ Don't test framework behavior (Vitest, Node.js built-ins)
- ❌ Don't duplicate unit test coverage
- ❌ Don't test every permutation of every function

### 3. **Real Data Only**
Integration tests MUST use real production session files from agents, not mocked or synthetic data.

**Why**: Real data catches edge cases that synthetic data misses (encoding issues, schema variations, timing bugs).

**Fixture Requirements**:
- Use actual agent session files copied from `~/.claude/`, `~/.codex/`, etc.
- Include edge cases (errors, multi-model sessions, sub-agents)
- Keep files small (< 50KB) - extract representative subset if needed
- Document golden dataset values in fixture README.md

---

## Integration Test Pattern

All integration tests follow this standard structure:

### File Structure
```
tests/integration/
├── CLAUDE.md                    # This file
├── {agent}-metrics.test.ts      # Agent metrics integration test
└── fixtures/
    └── {agent}/
        ├── README.md            # Fixture documentation with golden dataset
        ├── {session-files}      # Real agent session files
        ├── expected-metrics.jsonl    # Expected output from metrics adapter
        └── expected-session.json     # Expected session metadata
```

### Test Template (Fast & Simple)

```typescript
/**
 * Integration Test: {Agent} Metrics - Full Pipeline
 *
 * Golden Dataset: {brief summary of test scenario}
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

describe('{Agent}MetricsAdapter - Integration', () => {
  const fixturesDir = join(__dirname, 'fixtures', '{agent}');
  const tempDir = join(tmpdir(), '{agent}-test-' + Date.now());

  let adapter: AgentMetricsAdapter;
  let snapshot: MetricSnapshot;
  let deltas: MetricDelta[];

  // SINGLE beforeAll - parse once, validate many times
  beforeAll(async () => {
    // 1. Setup fixtures (copy to temp)
    mkdirSync(tempDir, { recursive: true });
    copyFileSync(
      join(fixturesDir, 'session.jsonl'),
      join(tempDir, 'session.jsonl')
    );

    // 2. Parse ONCE
    adapter = new AgentMetricsAdapter(AgentPluginMetadata);
    snapshot = await adapter.parseSessionFile(join(tempDir, 'session.jsonl'));

    const result = await adapter.parseIncrementalMetrics(
      join(tempDir, 'session.jsonl'),
      new Set(),
      new Set()
    );
    deltas = result.deltas;
  });

  afterAll(() => {
    // Cleanup (fast, no retries)
    try { unlinkSync(join(tempDir, 'session.jsonl')); } catch {}
  });

  // Fast validation tests (no I/O, no parsing)
  describe('Golden Dataset', () => {
    it('should extract correct token totals', () => {
      expect(snapshot.tokens.input).toBe(EXPECTED_INPUT);
      expect(snapshot.tokens.output).toBe(EXPECTED_OUTPUT);
    });

    it('should track all tool calls', () => {
      const toolCount = snapshot.toolCalls?.length || 0;
      expect(toolCount).toBe(EXPECTED_TOOL_COUNT);
    });

    it('should calculate correct delta totals', () => {
      const totalInput = deltas.reduce((sum, d) => sum + d.tokens.input, 0);
      expect(totalInput).toBe(snapshot.tokens.input); // Delta sum = snapshot
    });
  });
});
```

---

## Performance Checklist

Before committing an integration test, verify:

- [ ] **Single parse**: Data parsed once in `beforeAll`, never in test cases
- [ ] **No redundant checks**: Each test validates unique aspect, no overlap
- [ ] **Fast assertions**: < 1ms per test case (no I/O, no complex calculations)
- [ ] **Small fixtures**: Fixture files < 50KB total
- [ ] **Focused scope**: 10-20 tests maximum per file
- [ ] **Golden dataset**: Expected values documented in fixture README
- [ ] **Execution time**: `npm test {file}` completes in < 500ms

---

## Agent Metrics Test Pattern

All agent metrics tests follow this structure:

### Test Sections (Order Matters for Readability)

1. **Adapter Configuration** (2-3 tests)
   - Verify data paths, watermark strategy, init delay

2. **Golden Dataset - Snapshot** (3-5 tests)
   - Token totals (input, output, cache)
   - Tool calls count and status
   - Session metadata (model, git branch)

3. **Golden Dataset - Deltas** (2-4 tests)
   - Delta count matches expected
   - Delta totals = snapshot totals (critical mathematical verification)
   - Incremental calculations correct

4. **End-to-End Validation** (1-2 tests)
   - Pipeline works: parse → write → read
   - Compare with expected output files (if available)

**Total**: ~10-15 tests maximum per agent

### What NOT to Test

Integration tests should NOT duplicate unit test coverage:

❌ **Don't test**: Path matching logic (unit test responsibility)
❌ **Don't test**: Every edge case of date filtering (unit test responsibility)
❌ **Don't test**: Error handling for invalid files (unit test responsibility)
❌ **Don't test**: Cross-platform path handling details (unit test responsibility)

✅ **DO test**: Real session file → correct metrics output (integration responsibility)

---

## Fixture Management

### Creating Fixtures

1. **Generate real session**: Run agent with real provider
2. **Extract session file**: Copy from `~/.{agent}/` to `fixtures/{agent}/`
3. **Run metrics pipeline**: Generate expected output with CodeMie
4. **Copy expected output**: Store in `fixtures/{agent}/expected-*.json[l]`
5. **Document golden dataset**: Add values to `fixtures/{agent}/README.md`

### Fixture Guidelines

**Size**: Keep individual files < 50KB
- Large sessions? Extract representative subset (first 10 turns + error cases)
- Use tools to truncate: `head -n 100 large-session.jsonl > fixture.jsonl`

**Completeness**: Include edge cases in separate fixture files
- Success-only session (main fixture)
- Error handling session (separate small fixture)
- Multi-model session (if agent supports it)

**Documentation**: README.md must include
- Session summary (turns, tokens, tools)
- Golden dataset values (expected totals)
- Test scenario narrative (what user did)

---

## Example: Codex Integration Test

**File**: `tests/integration/codex-metrics.test.ts`
**Execution time**: ~150ms
**Test count**: 15 tests

### What Makes This Test Fast

✅ **Single parse in beforeAll**: Both `parseSessionFile` and `parseIncrementalMetrics` run once
✅ **Reused variables**: `snapshot` and `deltas` shared across all tests
✅ **No I/O in tests**: All validations use in-memory data
✅ **Small fixture**: 2KB session file with 4 turns

### What Makes This Test Simple

✅ **Clear golden dataset**: README documents expected values
✅ **Focused assertions**: Each test validates one aspect
✅ **Mathematical verification**: Delta totals = snapshot totals
✅ **Real data**: Actual Codex session from production use

### Test Structure Breakdown

```typescript
beforeAll(async () => {
  // Setup: Copy fixture (1ms)
  // Parse snapshot (50ms)
  // Parse deltas (40ms)
  // Total: ~100ms
});

describe('Adapter Configuration', () => {
  // 3 tests, <1ms each
});

describe('Full Session Parse', () => {
  // 5 tests, <1ms each
  // Validates snapshot values against golden dataset
});

describe('Incremental Delta Calculations', () => {
  // 4 tests, <1ms each
  // Validates deltas sum to snapshot (critical!)
});

describe('Error Handling', () => {
  // 3 tests, <10ms each
  // Uses separate fixture, separate beforeAll
});

// Total execution: ~150ms
```

---

## Common Pitfalls

### ❌ Slow Tests

**Problem**: Test takes 2+ seconds
**Cause**: Parsing in test cases instead of beforeAll
**Fix**: Move parsing to beforeAll, store results in variables

**Before** (SLOW):
```typescript
it('should calculate tokens', async () => {
  const snapshot = await adapter.parseSessionFile(path); // 100ms
  expect(snapshot.tokens.input).toBe(1000);
});

it('should count tools', async () => {
  const snapshot = await adapter.parseSessionFile(path); // 100ms (redundant!)
  expect(snapshot.toolCalls.length).toBe(5);
});
```

**After** (FAST):
```typescript
let snapshot: MetricSnapshot;

beforeAll(async () => {
  snapshot = await adapter.parseSessionFile(path); // 100ms once
});

it('should calculate tokens', () => {
  expect(snapshot.tokens.input).toBe(1000); // <1ms
});

it('should count tools', () => {
  expect(snapshot.toolCalls.length).toBe(5); // <1ms
});
```

### ❌ Redundant Tests

**Problem**: Testing the same thing multiple ways
**Fix**: Combine related assertions

**Before** (REDUNDANT):
```typescript
it('should have input tokens', () => {
  expect(snapshot.tokens.input).toBeDefined();
});

it('should have correct input tokens', () => {
  expect(snapshot.tokens.input).toBeGreaterThan(0);
});

it('should calculate exact input tokens', () => {
  expect(snapshot.tokens.input).toBe(1000);
});
```

**After** (FOCUSED):
```typescript
it('should calculate correct input tokens', () => {
  expect(snapshot.tokens.input).toBe(1000); // Golden dataset value
});
```

### ❌ Fragile Tests

**Problem**: Test breaks when unrelated code changes
**Cause**: Testing implementation details instead of outcomes
**Fix**: Test outputs, not internal state

**Before** (FRAGILE):
```typescript
it('should use specific parsing algorithm', () => {
  expect(adapter.parseStrategy).toBe('line-by-line'); // Implementation detail
});
```

**After** (ROBUST):
```typescript
it('should parse session correctly', () => {
  expect(snapshot.tokens.input).toBe(1000); // Output validation
});
```

---

## Performance Targets

### Test File Execution Time

| Agent Test | Target | Current | Status |
|------------|--------|---------|--------|
| codex-metrics.test.ts | < 200ms | ~150ms | ✅ |
| claude-metrics.test.ts | < 200ms | ~XXXms | ⏳ Need optimization |
| gemini-metrics.test.ts | < 200ms | ~XXXms | ⏳ Need optimization |

### Individual Test Performance

| Test Type | Target | Notes |
|-----------|--------|-------|
| Configuration validation | < 1ms | Simple property checks |
| Golden dataset validation | < 5ms | Array reduce operations |
| Delta calculations | < 10ms | Sum/filter operations |
| File I/O (beforeAll only) | < 100ms | Parsing session files |

---

## Best Practices Summary

### DO ✅

1. **Use real production data** from agent session files
2. **Parse once** in beforeAll, validate many times in tests
3. **Document golden dataset** values in fixture README
4. **Focus tests** on critical functionality only
5. **Validate outputs** not implementation details
6. **Keep fixtures small** (< 50KB per file)
7. **Verify delta math**: Sum of deltas MUST equal snapshot

### DON'T ❌

1. **Don't parse** in individual test cases
2. **Don't test** framework behavior
3. **Don't duplicate** unit test coverage
4. **Don't create** nested describe blocks with separate setup
5. **Don't use** synthetic/mocked data
6. **Don't test** every edge case (that's for unit tests)
7. **Don't write** tests that take > 10ms individually

---

## Quick Reference: Writing a New Agent Test

```bash
# 1. Create fixture directory
mkdir -p tests/integration/fixtures/newagent

# 2. Copy real session file (< 50KB)
cp ~/.newagent/sessions/session-123.json tests/integration/fixtures/newagent/

# 3. Generate expected output
codemie-newagent "test task"  # Run with metrics enabled
cp ~/.codemie/metrics/sessions/xxx_metrics.jsonl tests/integration/fixtures/newagent/expected-metrics.jsonl

# 4. Document golden dataset
cat > tests/integration/fixtures/newagent/README.md << EOF
# NewAgent Test Fixtures

**Session**: session-123.json
**Tokens**: 1000 input, 500 output
**Tools**: 5 tool calls
**Expected deltas**: 10
EOF

# 5. Create test file from template (see above)
cp tests/integration/codex-metrics.test.ts tests/integration/newagent-metrics.test.ts
# Edit: Replace agent name, update golden dataset values

# 6. Verify performance
npm test tests/integration/newagent-metrics.test.ts
# Expected: < 200ms, all tests pass
```

---

## Reference Implementations

**Best Examples**:

1. **Unit Tests**: `src/agents/plugins/__tests__/codex.metrics.test.ts`
   - Fast: 3ms test execution (42 tests)
   - Complete: Path matching, adapter config, cross-platform
   - Pattern: beforeEach + focused describes

2. **Integration Tests**: `tests/integration/codex-metrics.test.ts`
   - Fast: ~150ms total execution
   - Simple: 15 focused tests
   - Clear: Golden dataset documented
   - Complete: Covers success + error cases

**Use as templates** when creating new agent tests.
