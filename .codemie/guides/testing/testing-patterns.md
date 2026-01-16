# Testing Patterns

## Quick Summary

Testing patterns for CodeMie Code using Vitest: unit tests, integration tests, dynamic imports, and mocking strategies.

**Category**: Testing
**Complexity**: Medium
**Prerequisites**: Vitest, TypeScript, testing fundamentals

---

## Test Structure

```
tests/
├── integration/            Full workflow tests
│   ├── cli-commands/      CLI command execution
│   ├── metrics/           Analytics tracking
│   │   └── fixtures/      Test data
│   └── session/           Session management
│       └── fixtures/      Test data
├── helpers/               Shared test utilities
│   ├── index.ts          CLI test runner
│   └── test-isolation.ts  Isolated test environment
src/
└── **/__tests__/          Unit tests (co-located)
    └── *.test.ts
```

**Naming Convention**: `describe-what-it-does.test.ts`

---

## Test Configuration

| Setting | Value | Purpose |
|---------|-------|---------|
| **Framework** | Vitest | Fast, ESM-native test runner |
| **Environment** | node | CLI tool (not browser) |
| **Coverage** | v8 provider | Built-in V8 coverage |
| **Timeout** | 30s tests, 10s hooks | CLI operations can be slow |
| **Isolation** | Enabled | Each test file runs in separate context |
| **Threads** | 2-8 | Parallel execution |

**Source**: vitest.config.ts:1-42

---

## Unit Test Pattern

```typescript
// Source: src/agents/core/__tests__/flag-transform.test.ts:11-21
describe('transformFlags', () => {
  const mockConfig: AgentConfig = {
    provider: 'test-provider',
    model: 'test-model'
  };

  it('should transform --task to target flag', () => {
    const args = ['--task', 'hello world', '--verbose'];
    const mappings: FlagMappings = {
      '--task': { type: 'flag', target: '-p' }
    };
    const result = transformFlags(args, mappings, mockConfig);
    expect(result).toEqual(['-p', 'hello world', '--verbose']);
  });
});
```

**Structure**: Arrange (setup) → Act (execute) → Assert (verify)

---

## Dynamic Import Pattern (CRITICAL)

```typescript
// Source: src/utils/__tests__/processes.test.ts (pattern)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as exec from '../exec.js';

describe('npm utility', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSpy = vi.spyOn(exec, 'exec'); // Spy BEFORE import
  });

  it('should install package', async () => {
    execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const { installGlobal } = await import('../processes.js'); // Dynamic import
    await installGlobal('test-package');
    expect(execSpy).toHaveBeenCalled();
  });
});
```

**Why Dynamic Imports?**:
- Static imports execute before `beforeEach` hooks
- Module caches function references at import time
- Spies set up after import cannot intercept internal calls
- Dynamic imports ensure spy is ready before module loads

**Use For**: Testing functions that depend on `exec.ts`, `logger.ts`, or other mockable modules

---

## Mocking Strategies

| Mock Type | Pattern | Example |
|-----------|---------|---------|
| **Module function** | `vi.spyOn(module, 'fn')` | src/utils/\_\_tests\_\_/security.test.ts:1-10 |
| **External API** | Mock fetch/http client | (use dynamic imports) |
| **File system** | Mock fs operations | tests/integration/session/ |
| **Time** | `vi.useFakeTimers()` | Not currently used |
| **Environment** | Setup/teardown in helpers | tests/helpers/test-isolation.ts |

---

## Integration Test Pattern

```typescript
// Source: tests/integration/cli-commands/version.test.ts:1-35
import { describe, it, expect, beforeAll } from 'vitest';
import { createCLIRunner, type CommandResult } from '../../helpers/index.js';
import { setupTestIsolation } from '../../helpers/test-isolation.js';

const cli = createCLIRunner();

describe('Version Command', () => {
  setupTestIsolation(); // Isolated CODEMIE_HOME

  let versionResult: CommandResult;

  beforeAll(() => {
    versionResult = cli.runSilent('version'); // Run once, test multiple times
  });

  it('should display version number', () => {
    expect(versionResult.output).toMatch(/\d+\.\d+\.\d+/);
  });
});
```

**Characteristics**: Real CLI execution, isolated environment, full workflow validation

---

## Test Isolation

```typescript
// Pattern: tests/helpers/test-isolation.ts
export function setupTestIsolation() {
  const tempDir = path.join(os.tmpdir(), `codemie-test-${uuid()}`);

  beforeEach(() => {
    process.env.CODEMIE_HOME = tempDir;
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.CODEMIE_HOME;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}
```

**Use For**: Integration tests that need isolated config/session directories

---

## Fixtures

**Location**: `tests/integration/*/fixtures/`

**Examples**:
- `metrics/fixtures/sample-metrics.json` - Sample analytics data
- `session/fixtures/conversation-history.json` - Chat history for session tests

**Pattern**:
```typescript
const fixtureData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.json'), 'utf-8')
);
```

---

## Parameterized Tests

```typescript
// Source: src/utils/__tests__/security.test.ts:236-256
describe('case-insensitive key matching', () => {
  it.each([
    ['API_KEY', 'sk-1234567890abcdefghijklmnop'],
    ['api-key', 'sk-1234567890abcdefghijklmnop'],
    ['AuthToken', 'some-long-secret-token-value-here'],
    ['PASSWORD', 'my-super-secret-password']
  ])('should match %s', (key, value) => {
    const result = sanitizeValue(value, key);
    expect(result).toContain('[REDACTED]');
  });
});
```

**Use For**: Testing multiple inputs against same logic

---

## Test Commands

```bash
# Run all tests (watch mode)
npm test

# Run once (CI mode)
npm run test:run

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Coverage report
npm run test:run -- --coverage

# Specific file
npm test -- flag-transform.test.ts

# Specific test
npm test -- -t "should transform --task"
```

---

## Coverage Targets

**Current Thresholds**: Not enforced (recommended: 80% overall, 100% critical paths)

**Critical Paths** (must have high coverage):
- Error handling: src/utils/errors.ts
- Security: src/utils/security.ts
- Process execution: src/utils/exec.ts, src/utils/processes.ts
- Configuration: src/utils/config.ts

**Focus On**: Business logic, error paths, edge cases

**Exclude**: Type definitions, fixtures, test files

**Source**: vitest.config.ts:21-32

---

## Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Use dynamic imports for mockable modules | Static imports when mocking is needed |
| One assertion per test (prefer focused tests) | Multiple unrelated assertions |
| Descriptive test names (`should X when Y`) | Generic names (`test1`, `test2`) |
| Arrange-Act-Assert structure | Mixed concerns |
| Mock external dependencies | Real APIs in unit tests |
| Isolate integration tests (`setupTestIsolation`) | Share state between tests |
| Test error paths and edge cases | Only happy paths |
| Keep tests fast (<100ms for unit tests) | Long-running synchronous operations |

---

## Common Patterns

### Testing Error Handling

```typescript
// Source: src/utils/__tests__/security.test.ts:197-234 (edge cases pattern)
describe('edge cases', () => {
  it('should handle null values', () => {
    expect(sanitizeValue(null)).toBe(null);
  });

  it('should handle undefined values', () => {
    expect(sanitizeValue(undefined)).toBe(undefined);
  });

  it('should handle empty strings', () => {
    expect(sanitizeValue('')).toBe('');
  });
});
```

### Testing Async Operations

```typescript
// Use async/await throughout
it('should complete async operation', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

### Testing CLI Commands

```typescript
// Source: tests/integration/cli-commands/ pattern
const cli = createCLIRunner();
const result = cli.runSilent('command', ['--flag', 'value']);

expect(result.exitCode).toBe(0);
expect(result.output).toContain('expected output');
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Mock not intercepting calls | Static import before spy | Use dynamic imports |
| Tests passing locally, failing in CI | Shared state between tests | Add `setupTestIsolation()` |
| Timeout errors | Default 30s timeout exceeded | Increase timeout or optimize test |
| Module not found (`.js` extension) | Missing `.js` in import | Add `.js` extension (ESM requirement) |
| Coverage not generated | Excluded in config | Check vitest.config.ts:24-32 |

---

## Test Organization Strategy

| Test Type | Location | Dependencies | Speed |
|-----------|----------|--------------|-------|
| **Unit** | `src/**/__tests__/` | Mock all external deps | Fast (<100ms) |
| **Integration** | `tests/integration/` | Real deps, isolated env | Slow (1-5s) |
| **Helpers** | `tests/helpers/` | Shared utilities | N/A |

**Decision Tree**:
- Testing single function/class? → Unit test (co-located)
- Testing CLI command or workflow? → Integration test (tests/integration/)
- Testing multiple components together? → Integration test

---

## References

- **Test Config**: `vitest.config.ts`
- **Unit Tests**: `src/**/__tests__/`
- **Integration Tests**: `tests/integration/`
- **Test Helpers**: `tests/helpers/`
- **Utils Testing Guide**: `src/utils/CLAUDE.md` (dynamic import patterns)
- **Vitest Docs**: https://vitest.dev

---

## Related Guides

- Development Practices: .codemie/guides/development/development-practices.md
- Code Quality: .codemie/guides/standards/code-quality.md
- Project Structure: .codemie/guides/architecture/project-structure.md
