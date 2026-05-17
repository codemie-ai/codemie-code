# Testing Patterns

## Quick Summary

Testing patterns for CodeMie Code using Vitest: unit tests, integration tests, mocking, and dynamic imports.

**Category**: Testing
**Complexity**: Medium
**Prerequisites**: Vitest, testing fundamentals, TypeScript

---

## Test Structure

```
codemie-code/
├── src/                        Source with co-located unit tests
│   └── [module]/
│       ├── index.ts
│       └── __tests__/          Unit tests for module
│           └── *.test.ts
└── tests/                      Integration tests
    └── integration/
        └── *.test.ts
```

**Naming**: `[feature].test.ts` or `test_[scenario]_[expected_outcome]`

---

## Unit Test Pattern

```typescript
// Source: src/agents/__tests__/registry.test.ts:10-25
import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../registry.js';

describe('AgentRegistry', () => {
  describe('Agent Registration', () => {
    it('should register all default agents', () => {
      const agentNames = AgentRegistry.getAgentNames();

      expect(agentNames).toHaveLength(3);
      expect(agentNames).toContain('codemie-code');
      expect(agentNames).toContain('claude');
    });
  });
});
```

**Structure**: Arrange → Act → Assert
- Describe block groups related tests
- Nested describes for sub-features
- One assertion concept per test

---

## Mocking with Vitest

### Module Mocking

```typescript
// Source: src/utils/__tests__/processes.test.ts:6-13
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

import { logger } from '../logger.js';
```

### Spying on Functions

```typescript
// Source: src/utils/__tests__/processes.test.ts:18-26
import * as exec from '../exec.js';

describe('npm utility', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSpy = vi.spyOn(exec, 'exec');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
```

---

## Dynamic Imports for Mocking

**Critical Pattern**: Use dynamic imports AFTER spy setup to ensure mocks work correctly.

```typescript
// Source: src/utils/__tests__/processes.test.ts:29-46
describe('installGlobal', () => {
  beforeEach(() => {
    execSpy = vi.spyOn(exec, 'exec');
    execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  });

  it('should install package successfully', async () => {
    // ✅ Dynamic import AFTER spy is set up
    const { installGlobal } = await import('../processes.js');
    await installGlobal('test-package');

    expect(execSpy).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'test-package'],
      expect.objectContaining({ timeout: 120000 })
    );
  });
});
```

**Why Dynamic Imports?**
- Static imports happen before beforeEach
- Module caches exec reference at import time
- Spy can't intercept internal calls
- Dynamic imports ensure spy is ready

---

## Testing Async Operations

```typescript
// Source: src/utils/__tests__/processes.test.ts:64-76
it('should throw NpmError on timeout', async () => {
  execSpy.mockRejectedValue(new Error('Command timed out'));

  const { installGlobal } = await import('../processes.js');

  // Using rejects matcher
  await expect(installGlobal('test-package')).rejects.toThrow(NpmError);

  // Or using try/catch
  try {
    await installGlobal('test-package');
  } catch (error) {
    expect(error).toBeInstanceOf(NpmError);
    expect((error as NpmError).code).toBe(NpmErrorCode.TIMEOUT);
  }
});
```

---

## Integration Tests

**Location**: `tests/integration/`

```typescript
// Example integration test structure
describe('CLI Integration', () => {
  it('should execute agent with real config', async () => {
    // Arrange: Setup real environment
    const config = await ConfigLoader.load(process.cwd());

    // Act: Execute actual command
    const result = await executeAgent('codemie-code', ['--help']);

    // Assert: Verify real behavior
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });
});
```

**Characteristics**:
- Multiple components working together
- Real dependencies (file system, config)
- Longer running than unit tests
- No mocking unless external services

---

## Test Commands

```bash
# Run all tests
npm test

# Run only unit tests (src/)
npm run test:unit

# Run only integration tests (tests/)
npm run test:integration

# Run with coverage
npm run test:coverage

# Run in watch mode
npm run test:watch

# Run with UI
npm run test:ui

# Run specific file
npx vitest src/utils/__tests__/processes.test.ts
```

---

## Test Lifecycle Hooks

| Hook | Runs | Use For |
|------|------|---------|
| `beforeEach` | Before each test | Setup mocks, reset state |
| `afterEach` | After each test | Cleanup, restore mocks |
| `beforeAll` | Once before all tests | Expensive setup |
| `afterAll` | Once after all tests | Teardown |

```typescript
describe('Feature', () => {
  beforeEach(() => {
    // Runs before each test
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Runs after each test
    vi.restoreAllMocks();
  });
});
```

---

## Testing Error Handling

```typescript
// Source: src/utils/__tests__/processes.test.ts:78-88
it('should throw NpmError with PERMISSION_ERROR on EACCES', async () => {
  execSpy.mockRejectedValue(new Error('EACCES: permission denied'));

  const { installGlobal } = await import('../processes.js');

  await expect(installGlobal('test-package')).rejects.toThrow(NpmError);

  try {
    await installGlobal('test-package');
  } catch (error) {
    expect((error as NpmError).code).toBe(NpmErrorCode.PERMISSION_ERROR);
  }
});
```

---

## Coverage Guidelines

**Targets**:
- Overall: 80%+ coverage
- Critical paths: 90%+ coverage (utils, core logic)
- UI components: 60%+ coverage acceptable

**Focus on**:
- Business logic (agent execution, plugin loading)
- Error handling (all error paths)
- Edge cases (empty inputs, null values, timeouts)
- Security-critical code (path validation, sanitization)

**Skip coverage for**:
- Type definitions
- Simple getters/setters
- Third-party integrations (test with mocks)

---

## Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| One concept per test | Multiple unrelated assertions |
| Descriptive test names | `test1`, `testFunction` |
| Arrange-Act-Assert pattern | Mixed concerns |
| Use dynamic imports when mocking | Static imports with spies |
| Mock external dependencies | Real APIs in unit tests |
| Test error paths | Only happy path |
| Keep tests fast (< 100ms each) | Long-running operations |
| Use beforeEach/afterEach | Manual cleanup |

---

## Common Patterns

### Testing with Mock Return Values

```typescript
it('should handle success', async () => {
  execSpy.mockResolvedValue({ code: 0, stdout: 'success', stderr: '' });
  const { installGlobal } = await import('../processes.js');
  await installGlobal('pkg');
  expect(logger.success).toHaveBeenCalled();
});
```

### Testing with Mock Rejections

```typescript
it('should handle errors', async () => {
  execSpy.mockRejectedValue(new Error('Network error'));
  const { installGlobal } = await import('../processes.js');
  await expect(installGlobal('pkg')).rejects.toThrow('Network error');
});
```

### Testing with Matchers

```typescript
// Partial object matching
expect(execSpy).toHaveBeenCalledWith(
  'npm',
  ['install', '-g', 'pkg'],
  expect.objectContaining({ timeout: 120000 })
);

// Array containing
expect(agentNames).toContain('claude');

// Type checking
expect(error).toBeInstanceOf(NpmError);

// Defined/undefined
expect(agent).toBeDefined();
expect(unknownAgent).toBeUndefined();
```

---

## Troubleshooting Tests

| Issue | Cause | Fix |
|-------|-------|-----|
| Mock not working | Static import before spy | Use dynamic import after spy setup |
| Flaky tests | Shared state between tests | Use beforeEach/afterEach to reset |
| Slow tests | No mocks, real I/O | Mock file system and network calls |
| Tests pass locally, fail in CI | Environment differences | Use consistent test data, mock time |
| "Cannot find module" | Missing .js extension | Add .js to all imports |

---

## Running Tests in CI

```bash
# Full CI pipeline (lint + build + tests)
npm run ci

# With commit lint
npm run ci:full
```

**CI Configuration**: Tests run on every commit via GitHub Actions.

---

## References

- **Unit Tests**: `src/**/__tests__/*.test.ts`
- **Integration Tests**: `tests/integration/*.test.ts`
- **Test Framework**: Vitest (https://vitest.dev)
- **Coverage Reports**: `coverage/` (gitignored)
- **Test Config**: `vitest.config.ts`

---
