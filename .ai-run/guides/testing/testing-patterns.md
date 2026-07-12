# Testing Patterns

**Category**: Testing | **Complexity**: Medium | **Prerequisites**: Vitest, TypeScript

---

## Test Structure

```
codemie-code/
├── src/[module]/__tests__/*.test.ts   Unit tests (co-located)
└── tests/integration/*.test.ts        Integration tests
```

**Naming**: `[feature].test.ts` or `test_[scenario]_[expected_outcome]`

---

## Unit Test Pattern

Rule: Group related tests with `describe`, use nested describes for sub-features, one assertion concept per test, and follow Arrange → Act → Assert.

| Bad | Best |
|-----|------|
| Flat tests, multiple concepts per it() | Nested describe blocks, single concept per it() |
| `test1`, `testFunction` names | Descriptive: `should register all default agents` |

Reference: `src/agents/__tests__/registry.test.ts:10-25`

```typescript
describe('AgentRegistry', () => {
  describe('Agent Registration', () => {
    it('should register all default agents', () => {
      expect(AgentRegistry.getAgentNames()).toContain('claude');
    });
  });
});
```

---

## Mocking with Vitest

### Module Mocking

Rule: Use `vi.mock()` at module level to replace entire modules with controlled fakes.

Reference: `src/utils/__tests__/processes.test.ts:6-13`

```typescript
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
import { logger } from '../logger.js';
```

### Spying on Functions

Rule: Use `vi.spyOn()` in `beforeEach` and `vi.restoreAllMocks()` in `afterEach` to intercept specific functions without replacing the entire module.

Reference: `src/utils/__tests__/processes.test.ts:18-26`

| Bad | Best |
|-----|------|
| Manual mock cleanup | `vi.restoreAllMocks()` in afterEach |
| Spy without teardown | Always pair spyOn with restoreAllMocks |

---

## Dynamic Imports for Mocking (Vitest 4.x)

Rule: Import the module under test **inside the test body or inside `beforeEach`** using dynamic `import()`, AFTER the spy is set up. Static imports are cached before `beforeEach` runs and bypass spies.

| Bad | Best |
|-----|------|
| `import { installGlobal } from '../processes.js'` at top | `const { installGlobal } = await import('../processes.js')` inside test |
| Spy set up after static import | Spy set up before dynamic import |

Reference: `src/utils/__tests__/processes.test.ts:29-46`

```typescript
beforeEach(() => {
  execSpy = vi.spyOn(exec, 'exec');
  execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
});

it('should install package successfully', async () => {
  const { installGlobal } = await import('../processes.js'); // dynamic, AFTER spy
  await installGlobal('test-package');
  expect(execSpy).toHaveBeenCalledWith('npm', ['install', '-g', 'test-package'], expect.objectContaining({ timeout: 120000 }));
});
```

Why: Static imports happen before `beforeEach`; the module caches the `exec` reference at import time, so the spy cannot intercept internal calls.

---

## Testing Async Operations

Rule: Use `await expect(...).rejects.toThrow(ErrorClass)` for async error assertions; alternatively use try/catch to inspect error properties.

Reference: `src/utils/__tests__/processes.test.ts:64-76`

| Bad | Best |
|-----|------|
| Synchronous expect on async call | `await expect(fn()).rejects.toThrow(NpmError)` |
| Only testing happy path | Also test timeout, permission, and network errors |

---

## Testing Error Handling

Rule: Assert both the error class and the specific error code to verify correct error mapping.

Reference: `src/utils/__tests__/processes.test.ts:78-88`

```typescript
try {
  await installGlobal('test-package');
} catch (error) {
  expect(error).toBeInstanceOf(NpmError);
  expect((error as NpmError).code).toBe(NpmErrorCode.PERMISSION_ERROR);
}
```

---

## Cross-Platform Path/URL Assertions

Rule: Never hardcode POSIX-style path or `file://` URL literals in test expectations. Derive paths through `path.join()`/`path.resolve()` and build `file://` URLs via `url.pathToFileURL()`, so the assertion matches whatever separator/encoding the current OS actually produces.

Reference: `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts:276-301`, `src/agents/plugins/claude/__tests__/statusline-installer.test.ts:26-35`

| Bad | Best |
|-----|------|
| `expect(result.scriptPath).toBe('/home/testuser/claude/x.js')` | `expect(result.scriptPath).toBe(join(CLAUDE_HOME, 'x.js'))` |
| `isMainModule(p, 'file:///Users/me/script.mjs')` | `isMainModule(p, pathToFileURL(p).href)` |

Why: `path.join()` uses backslashes on Windows; a hardcoded forward-slash literal only matches on POSIX. This exact class of bug reached CI twice in one PR (#418) — undetected locally because macOS/Linux never surface it.

---

## Testing Dependency-Free Scripts via Parameter Injection

Rule: For a standalone script that must stay import-free of the project's `src/` tree (deployed and run outside the compiled package), avoid `vi.mock()` on its own filesystem/network calls. Instead, give the function optional parameters defaulting to the real dependency, and pass fakes directly in tests.

Reference: `src/agents/plugins/claude/plugin/statusline.mjs:188-246`, `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts:185-273`

```typescript
export async function resolveBudget({
  readFile = fs.readFile,
  fetchImpl = fetch,
} = {}) { /* ... */ }

// test: no vi.mock() needed — pass fakes directly
await resolveBudget({ readFile: vi.fn().mockResolvedValue(...), fetchImpl: vi.fn() });
```

Why: `vi.mock('fs/promises')` only intercepts imports the *test file* resolves — a dependency-free deployed script that must remain framework-agnostic still needs a test seam. Default-parameter injection provides one without adding a runtime dependency.

---

## Integration Tests

Rule: Integration tests use real dependencies (file system, config) and no mocking unless testing external services.

Reference: `tests/integration/*.test.ts`

| Characteristic | Integration | Unit |
|---|---|---|
| Components | Multiple | Single |
| Dependencies | Real | Mocked |
| Runtime | Slower | < 100ms |
| Mocking | External services only | All external |

---

## Test Commands

See `.ai-run/guides/quality-gates.md` for full command definitions (`npm test`, `test:unit`, `test:integration`, `test:coverage`, `test:watch`).

Run a specific file:
```bash
npx vitest src/utils/__tests__/processes.test.ts
```

---

## Test Lifecycle Hooks

| Hook | Runs | Use For |
|------|------|---------|
| `beforeEach` | Before each test | Setup mocks, spy init |
| `afterEach` | After each test | `vi.restoreAllMocks()` |
| `beforeAll` | Once before suite | Expensive one-time setup |
| `afterAll` | Once after suite | Teardown |

---

## Best Practices

| Do | Avoid |
|-----|-------|
| One concept per test | Multiple unrelated assertions |
| Descriptive test names | `test1`, `testFunction` |
| Arrange-Act-Assert | Mixed setup and assertions |
| Dynamic imports when mocking | Static imports with spies |
| Mock external dependencies | Real APIs in unit tests |
| Test error paths | Only happy path |
| `beforeEach`/`afterEach` for cleanup | Manual teardown |

---

## Common Matchers

```typescript
expect(execSpy).toHaveBeenCalledWith('npm', ['install', '-g', 'pkg'], expect.objectContaining({ timeout: 120000 }));
expect(agentNames).toContain('claude');
expect(error).toBeInstanceOf(NpmError);
expect(agent).toBeDefined();
```

Reference: `src/agents/__tests__/registry.test.ts`

---

## Troubleshooting Tests

| Issue | Cause | Fix |
|-------|-------|-----|
| Mock not working | Static import before spy | Use dynamic import after spy setup |
| Flaky tests | Shared state | `beforeEach`/`afterEach` reset |
| Slow tests | Real I/O | Mock file system and network |
| Fail in CI only | Environment differences | Mock time, use consistent test data |
| "Cannot find module" | Missing `.js` extension | Add `.js` to all imports |

---

## Coverage Guidelines

- Overall: 80%+
- Critical paths (`src/utils/`, core logic): 90%+
- UI components: 60%+ acceptable

Focus on: business logic, error handling, edge cases (nulls, timeouts), security-critical paths (path validation, sanitization).

Skip: type definitions, simple getters/setters, third-party integration internals.

---

## References

- Unit tests: `src/**/__tests__/*.test.ts`
- Integration tests: `tests/integration/*.test.ts`
- Test README: `tests/README.md`
- Vitest config: `vitest.config.ts`
- Coverage output: `coverage/` (gitignored)
- Vitest docs: https://vitest.dev
