# Configuration Module Tests

## Test Coverage

This directory contains comprehensive unit tests for the configuration module:

- ✅ **constants.test.ts** (26 tests) - All configuration constants
- ✅ **ui.test.ts** (15 tests) - UI rendering functions
- ✅ **actions.test.ts** (31 tests) - Action handlers for keyboard input
- ✅ **types.test.ts** (39 tests) - TypeScript type definitions
- ✅ **index.test.ts** (21 tests) - Main orchestration logic

**Total: 132 unit tests**

## Not Unit Tested

- ⚠️ **interactive-prompt.ts** - This module directly interacts with `process.stdin` and `process.stdout` for terminal I/O, which cannot be easily mocked in unit tests without complex workarounds.

### Why No Unit Tests for interactive-prompt.ts?

The `interactive-prompt.ts` module:
1. Uses `process.stdin.setRawMode()` which doesn't exist in test environments
2. Requires actual terminal interaction (TTY)
3. Sets up event listeners on stdin that can't be easily cleaned up in tests
4. `process.stdin` and `process.stdout` are read-only and can't be replaced

### Testing Strategy

- **Unit Tests**: Test all testable components (constants, UI rendering, actions, types)
- **Integration Tests**: The interactive prompt should be tested with actual terminal interaction or proper terminal emulation in integration tests
- **Manual Testing**: Use `codemie setup assistants` to test the full interactive experience

## Running Tests

```bash
# Run all configuration tests
npm test -- src/cli/commands/assistants/setup/configuration/__tests__

# Run specific test file
npm test -- src/cli/commands/assistants/setup/configuration/__tests__/actions.test.ts
```
