# CodeMie Tests

This directory contains the testing infrastructure for the CodeMie CLI project.

## Test Structure

```
tests/
├── integration/       # Integration tests (CLI commands)
│   ├── cli-commands.test.ts
│   └── agent-shortcuts.test.ts
├── fixtures/          # Test data and fixtures
│   └── configs/       # Sample configuration files
├── helpers/           # Reusable test utilities
│   ├── cli-runner.ts       # CLI command execution helper
│   ├── temp-workspace.ts   # Temporary workspace management
│   └── index.ts            # Exports
└── README.md          # This file

src/
└── **/__tests__/      # Unit tests (co-located with source)
    ├── env/__tests__/         # Configuration tests
    ├── agents/__tests__/      # Agent registry tests
    └── utils/__tests__/       # Utility tests
```

## Testing Strategy

### Integration Tests (70%)

Integration tests verify the system works correctly by executing CLI commands directly. These tests:

- Test real user interactions
- Are less brittle (don't break on refactoring)
- Provide high confidence in functionality
- Are easy to maintain

**Example:**
```typescript
it('should list all available agents', () => {
  const output = cli.run('list');
  expect(output).toContain('claude');
  expect(output).toContain('codex');
});
```

### Unit Tests (30%)

Unit tests focus on critical business logic and complex algorithms. These tests:

- Verify configuration loading and validation
- Test type guards and parsers
- Check agent registry functionality
- Validate utility functions

**Example:**
```typescript
it('should identify multi-provider config', () => {
  const config = {
    version: 2,
    activeProfile: 'default',
    profiles: { default: {} }
  };
  expect(isMultiProviderConfig(config)).toBe(true);
});
```

## Running Tests

```bash
# Run all tests
npm test

# Run all tests once (no watch mode)
npm run test:run

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui
```

## Test Helpers

### CLIRunner

Helper for executing CLI commands in tests:

```typescript
import { createCLIRunner } from '../helpers';

const cli = createCLIRunner();

// Run command and get output
const output = cli.run('doctor');

// Run command silently (no throw on error)
const result = cli.runSilent('invalid-command');
console.log(result.exitCode); // 1
console.log(result.error);    // Error message

// Check if command succeeds
if (cli.succeeds('version')) {
  console.log('Command succeeded');
}
```

### TempWorkspace

Helper for creating isolated test environments:

```typescript
import { createTempWorkspace } from '../helpers';

const workspace = createTempWorkspace();

// Write files
workspace.writeFile('test.txt', 'content');
workspace.writeJSON('data.json', { key: 'value' });
workspace.writeConfig({ provider: 'openai' });

// Read files
const content = workspace.readFile('test.txt');
const data = workspace.readJSON('data.json');

// Create directories
workspace.mkdir('src/utils');

// Clean up
workspace.cleanup();
```

## Writing New Tests

### Integration Tests

1. Create a new file in `tests/integration/`
2. Import `createCLIRunner` from helpers
3. Execute CLI commands and verify output
4. Keep tests simple - test behavior, not implementation

```typescript
import { describe, it, expect } from 'vitest';
import { createCLIRunner } from '../helpers';

const cli = createCLIRunner();

describe('My Feature', () => {
  it('should do something', () => {
    const output = cli.run('my-command');
    expect(output).toContain('expected text');
  });
});
```

### Unit Tests

1. Create `__tests__` directory next to source code
2. Test critical logic, edge cases, error handling
3. Use TempWorkspace for file system operations
4. Mock external dependencies if needed

```typescript
import { describe, it, expect } from 'vitest';
import { myFunction } from '../my-module';

describe('myFunction', () => {
  it('should handle edge case', () => {
    expect(myFunction(null)).toBeUndefined();
  });
});
```

## Best Practices

### DO ✅

- Test behavior, not implementation details
- Use real CLI commands in integration tests
- Keep tests simple and readable
- Test happy paths and critical error cases
- Use descriptive test names
- Clean up resources (temp files, workspaces)

### DON'T ❌

- Mock everything in integration tests
- Test internal implementation details
- Write tests for every edge case
- Make tests dependent on each other
- Leave temporary files after tests
- Use hardcoded paths or timestamps

## Coverage Goals

- **Overall:** 60-70% (pragmatic coverage)
- **Configuration System:** 90%+
- **Type Guards:** 100%
- **Agent Registry:** 80%+
- **CLI Commands:** Basic execution verified

## CI Integration

Tests run automatically on:
- Pull requests
- Pushes to main/debug_mode branches
- Manual workflow triggers

The CI pipeline:
1. Installs dependencies
2. Runs linting
3. Builds the project
4. Runs unit tests
5. Runs integration tests
6. Generates coverage reports

## Troubleshooting

### Tests timeout

Increase timeout in vitest.config.ts:
```typescript
testTimeout: 30000,  // 30 seconds
```

### Tests fail locally but pass in CI

- Check Node.js version (must be >=20.0.0)
- Ensure clean state (no leftover config files)
- Run `npm run build` before testing

### CLI commands not found

Make sure to build first:
```bash
npm run build
npm test
```

### Temp files not cleaned up

Always use `afterEach` or `finally` blocks:
```typescript
afterEach(() => {
  workspace.cleanup();
});
```

## Contributing

When adding new features:

1. Write integration test first (if it's a CLI command)
2. Add unit tests for complex logic
3. Ensure tests pass: `npm run test:run`
4. Check coverage: `npm run test:coverage`
5. Update this README if needed

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Testing Best Practices](https://testingjavascript.com/)
- [Integration Testing Guide](https://martinfowler.com/articles/practical-test-pyramid.html)
