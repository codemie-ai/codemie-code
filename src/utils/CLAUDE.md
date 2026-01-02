# Utils Directory - Developer Guide

This directory contains shared utility functions organized by logical domain following KISS principles.

---

## Directory Structure

The utils folder maintains a **flat structure** with utilities grouped by functional domain:

```
src/utils/
├── exec.ts              # Base command execution (foundational)
├── processes.ts         # High-level process operations (npm, git, which)
├── paths.ts             # Path manipulation and validation
├── security.ts          # Data sanitization and credential storage
├── errors.ts            # Error handling and context creation
├── config.ts            # Configuration loading and management
├── parsers.ts           # JSON parsing utilities
├── logger.ts            # Logging utilities
├── profile.ts           # Profile display primitives (agents)
└── goodbye-messages.ts  # Random welcome/goodbye messages (agents)
```

---

## Core Modules

### exec.ts - Foundation for Process Execution

**Purpose**: Foundational command execution that all other process utilities depend on.

**Why Separate?**:
- Enables proper test mocking (other modules import and spy on exec)
- Prevents circular dependencies
- Single Responsibility: low-level process spawning only

**Key Functions**:
```typescript
exec(command: string, args?: string[], options?: ExecOptions): Promise<ExecResult>
```

**Important**: Never merge exec.ts back into processes.ts - this creates unmockable internal calls in tests.

### processes.ts - High-Level Operations

**Purpose**: Built on exec.ts to provide npm, git, and command detection utilities.

**Key Functions**:
```typescript
// Command detection
commandExists(command: string): Promise<boolean>
getCommandPath(command: string): Promise<string | null>

// npm operations
installGlobal(packageName: string, options?: NpmInstallOptions): Promise<void>
uninstallGlobal(packageName: string, options?: NpmOptions): Promise<void>
listGlobal(packageName: string, options?: NpmOptions): Promise<boolean>
getVersion(options?: NpmOptions): Promise<string | null>
getLatestVersion(packageName: string, options?: NpmOptions): Promise<string | null>
npxRun(command: string, args?: string[], options?: NpxRunOptions): Promise<void>

// Git operations
detectGitBranch(cwd: string): Promise<string | undefined>
```

**Re-exports**: `exec`, `ExecOptions`, `ExecResult` for convenience.

### paths.ts - Path Operations

**Purpose**: Cross-platform path utilities (merged from path-utils.ts, codemie-home.ts, dirname.ts).

**Key Functions**:
```typescript
// Path normalization
normalizePathSeparators(filePath: string): string
splitPath(filePath: string): string[]
getFilename(filePath: string): string

// Path validation
matchesPathStructure(filePath: string, baseDir: string, expectedStructure: string[]): boolean
validatePathDepth(filePath: string, baseDir: string, expectedDepth: number): boolean
isPathWithinDirectory(workingDir: string, resolvedPath: string): boolean

// CodeMie paths
getCodemieHome(): string
getCodemiePath(...paths: string[]): string

// Module utilities
getDirname(importMetaUrl: string): string
isValidUuid(str: string): boolean
```

### security.ts - Security Operations

**Purpose**: Data sanitization and secure credential storage (merged from sanitize.ts, credential-store.ts).

**Key Functions**:
```typescript
// Data sanitization
sanitizeValue(value: unknown, key?: string): unknown
sanitizeObject(obj: Record<string, unknown>): Record<string, unknown>
sanitizeLogArgs(...args: unknown[]): unknown[]
sanitizeCookies(cookies: Record<string, string> | undefined): string
sanitizeHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown>
sanitizeAuthToken(token: string | undefined): string

// Credential storage (keytar-based)
class CredentialStore {
  static getInstance(): CredentialStore
  async storeSSOCredentials(credentials: SSOCredentials, baseUrl?: string): Promise<void>
  async retrieveSSOCredentials(baseUrl?: string): Promise<SSOCredentials | null>
  async deleteSSOCredentials(baseUrl?: string): Promise<void>
}
```

### errors.ts - Error Handling

**Purpose**: Comprehensive error handling (merged error-context.ts into errors.ts).

**Key Classes**:
```typescript
class CodeMieError extends Error
class ConfigError extends CodeMieError
class NpmError extends CodeMieError
```

**Key Functions**:
```typescript
// Error context
createErrorContext(error: unknown, sessionContext?: ErrorContext['session']): ErrorContext
formatErrorForUser(context: ErrorContext, options?: any): string
formatErrorForLog(context: ErrorContext): string
getErrorExplanation(error: unknown): { explanation: string; suggestions: string[] }

// Error parsing
parseNpmError(error: unknown, context: string): NpmError
parseConfigError(error: unknown, context?: string): ConfigError
```

### config.ts - Configuration Management

**Purpose**: Configuration loading and profile management (merged installation-id into config.ts).

**Key Functions**:
```typescript
// Profile management (ConfigLoader class)
static async load(workingDir: string, overrides?: ConfigOverrides): Promise<Config>
static async saveProfile(name: string, profile: ProfileConfig): Promise<void>
static async switchProfile(name: string): Promise<void>
static async deleteProfile(name: string): Promise<void>

// Installation tracking
getInstallationId(): Promise<string>
```

### profile.ts - Profile Display Primitives

**Purpose**: Low-level profile rendering primitives used by agents.

**Key Functions**:
```typescript
// Profile rendering
renderProfileInfo(config: ProfileConfig): string
displayWarningMessage(title: string, error: unknown, sessionContext?: ErrorContext['session']): void
```

**Used By**: BaseAgentAdapter, codemie-code plugin (agents only)

**Note**: CLI-specific profile display utilities are in `src/cli/commands/profile/display.ts`, following the pattern of keeping CLI-specific helpers with CLI commands (see `doctor/formatter.ts`, `analytics/formatter.ts`).

---

## Testing Guidelines

### Test Structure for exec-dependent modules

When testing functions in `processes.ts` (or any module that uses exec internally), use **dynamic imports** to ensure mocks are set up before the module is loaded:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as exec from '../exec.js';

describe('npm utility', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execSpy = vi.spyOn(exec, 'exec');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should install package successfully', async () => {
    execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    // Dynamic import AFTER spy is set up
    const { installGlobal } = await import('../processes.js');
    await installGlobal('test-package');

    expect(execSpy).toHaveBeenCalledWith(...);
  });
});
```

**Why Dynamic Imports?**
- Static imports happen before beforeEach hooks run
- Module caches the `exec` reference at import time
- Spy set up after import cannot intercept internal calls
- Dynamic imports ensure spy is ready before module loads

**Example**: See `src/utils/__tests__/npm.test.ts` and `src/utils/__tests__/which.test.ts`.

---

## Design Principles Applied

### KISS (Keep It Simple, Stupid)
- Flat file structure (no subdirectories)
- Logical grouping by domain
- No over-engineering or premature abstraction
- Only 10 files instead of 20

### DRY (Don't Repeat Yourself)
- Consolidated path operations (3 files → 1)
- Merged security utilities (2 files → 1)
- Single source of truth for each domain

### Single Responsibility
- exec.ts: Only command execution
- processes.ts: Only high-level operations
- Separated by testing requirements

### Testability
- exec.ts separated to enable mocking
- Re-exported from processes.ts for convenience
- Dynamic imports in tests for proper spy setup

---

## Migration Notes (2024-01)

**Consolidation Summary**:
- 20 files → 10 files
- Git history preserved via `git mv`
- All 575 tests passing
- Zero breaking changes (public API unchanged)

**Key Decisions**:
1. **exec.ts separation**: Required for test mocking - DO NOT merge back
2. **Flat structure**: No subdirectories - easier navigation
3. **Domain grouping**: Logical over historical organization
4. **Re-exports**: processes.ts re-exports exec for convenience

**Files Merged**:
- paths.ts ← path-utils.ts, codemie-home.ts, dirname.ts
- security.ts ← sanitize.ts, credential-store.ts
- errors.ts ← errors.ts, error-context.ts
- config.ts ← config-loader.ts, installation-id.ts
- processes.ts ← npm.ts, git.ts, which.ts
- parsers.ts ← json-parser.ts (renamed only)

---

## Common Pitfalls

### ❌ DON'T: Merge exec.ts back into processes.ts
```typescript
// This creates unmockable internal calls
export async function installGlobal() {
  await exec('npm', ['install']); // Can't mock this!
}
```

### ✅ DO: Keep exec.ts separate
```typescript
// exec.ts
export async function exec() { ... }

// processes.ts
import { exec } from './exec.js';
export async function installGlobal() {
  await exec('npm', ['install']); // Can mock exec module!
}
export { exec }; // Re-export for convenience
```

### ❌ DON'T: Use static imports in exec-dependent tests
```typescript
import { installGlobal } from '../processes.js'; // Too early!

beforeEach(() => {
  execSpy = vi.spyOn(exec, 'exec'); // Too late!
});
```

### ✅ DO: Use dynamic imports after spy setup
```typescript
beforeEach(() => {
  execSpy = vi.spyOn(exec, 'exec'); // Set up spy first
});

it('test', async () => {
  const { installGlobal } = await import('../processes.js'); // Then import
  await installGlobal('pkg');
});
```

---

## Testing Windows Compatibility

After any utils reorganization:
1. Always clean dist/ before committing: `rm -rf dist && npm run build`
2. Verify no stale compiled files remain: `git status dist/`
3. Run complete test suite to ensure all imports work:
   - Unit tests: `npm test`
   - Integration tests: `npm run test:integration`
   - Both must pass (762+ tests total)

## Future Considerations

**If adding new utilities**:
1. Determine logical domain (paths, security, processes, etc.)
2. Add to existing file if domain matches
3. Create new file only if truly distinct domain
4. Keep flat structure - no subdirectories
5. Update this CLAUDE.md with new functions

**If utils grow beyond ~15 files**:
- Consider subdirectories by domain (paths/, security/, etc.)
- Maintain barrel exports (index.ts) per subdirectory
- Update import paths across codebase
- Document new structure here
