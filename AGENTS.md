# AI Agent Development Guide

**Purpose**: Quick reference for AI coding agents working in the CodeMie Code repository.

---

## 🚀 Quick Start

### Build & Run Commands

```bash
# Install dependencies
npm install

# Build project
npm run build                    # Full build (tsc + tsc-alias + copy-plugin)
npm run dev                      # Watch mode for development

# Lint & Format
npm run lint                     # Check code (requires 0 warnings)
npm run lint:fix                 # Auto-fix issues

# Testing
npm test                         # Run all tests (Vitest)
npm run test:unit                # Unit tests only (src/)
npm run test:integration         # Integration tests (tests/integration/)

# Run single test file
npm test src/utils/__tests__/security.test.ts
npm test -- security             # Pattern matching
npm test -- -t "test name"       # Filter by test name

# Test modes
npm run test:watch               # Watch mode
npm run test:ui                  # Interactive UI
npm run test:coverage            # Coverage report

# Quality & CI
npm run ci                       # Full CI pipeline (lint + build + tests)
npm run validate:secrets         # Check for secrets (Gitleaks)
```

### Tech Stack

- **Language**: TypeScript 5.3+ (strict mode, ES2022 target)
- **Runtime**: Node.js 20.0.0+ (no virtual environment needed)
- **Module System**: ES Modules only (NodeNext resolution)
- **Testing**: Vitest 4.0.10+ with parallel execution
- **Linting**: ESLint 9+ (flat config, zero warnings required)
- **Frameworks**: LangGraph 1.0.2+, LangChain 1.0.4+
- **Package Manager**: npm (no yarn/pnpm)

---

## 📝 Code Style Guidelines

### Imports & Modules

```typescript
// ✅ Always use .js extension (required for ES modules)
import { exec } from './exec.js';
import { logger } from '@/utils/logger.js';
import type { Config } from './types.js';

// ❌ Never omit .js extension
import { exec } from './exec';  // WILL FAIL

// ✅ Path aliases (@/* maps to src/*)
import { sanitizeValue } from '@/utils/security.js';

// ✅ ES modules only
export async function fetchData(): Promise<Result> { }

// ❌ No CommonJS
const module = require('./module');  // NEVER USE
```

### Type Safety

```typescript
// ✅ Explicit return types on all exported functions
export async function processItem(id: string): Promise<ProcessResult> {
  return { success: true };
}

// ✅ Prefer interface over type for objects
interface Config {
  apiKey: string;
  timeout: number;
}

// ✅ Use unknown instead of any when type is truly unknown
function parseInput(input: unknown): ParsedData {
  if (typeof input === 'string') { /* ... */ }
}

// ✅ Intentional unused variables with underscore prefix
function handler(_event: Event, data: Data) {
  return processData(data);
}
```

### Async/Await Patterns

```typescript
// ✅ Always async/await (never callbacks or .then() chains)
export async function fetchData(): Promise<Result> {
  try {
    const data = await apiCall();
    return processData(data);
  } catch (error) {
    throw new CustomError('Failed to fetch', error);
  }
}

// ✅ Use Promise.all() for parallel operations
const [results1, results2] = await Promise.all([
  operation1(),
  operation2()
]);

// ❌ Never await in loops (sequential bottleneck)
for (const item of items) {
  await processItem(item);  // BAD - use Promise.all()
}
```

### Error Handling

```typescript
// ✅ Use custom error classes with context
import { ConfigurationError, createErrorContext } from '@/utils/errors.js';

try {
  await riskyOperation();
} catch (error) {
  const context = createErrorContext(error, { sessionId, agent: 'claude' });
  logger.error('Operation failed', context);
  throw new ConfigurationError('Specific error message');
}

// Available error classes:
// - ConfigurationError
// - AgentNotFoundError
// - AgentInstallationError
// - ToolExecutionError
// - PathSecurityError
// - NpmError
// - CodeMieError (base class)
```

### Logging Patterns

```typescript
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

// ✅ Set session context at agent startup
logger.setSessionId(sessionId);
logger.setAgentName('claude');
logger.setProfileName('work');

// ✅ Use appropriate log levels
logger.debug('Internal details');     // File-only (controlled by CODEMIE_DEBUG)
logger.info('Non-console log');       // File-only
logger.success('User feedback');      // Console + file
logger.error('Error occurred', ctx);  // Console + file

// ✅ Always sanitize sensitive data before logging
logger.debug('Request data', ...sanitizeLogArgs(requestData));

// ❌ Never use console.log() for debug info
console.log('Debug info');  // BAD - use logger.debug()
```

### Security Requirements

```typescript
import { sanitizeValue, CredentialStore } from '@/utils/security.js';

// ✅ No hardcoded credentials
const apiKey = process.env.ANTHROPIC_API_KEY;

// ✅ Use CredentialStore for sensitive data
const store = CredentialStore.getInstance();
await store.storeSSOCredentials(credentials, baseUrl);

// ✅ Sanitize before logging
logger.debug('Data', ...sanitizeLogArgs({ apiKey, data }));

// ✅ Validate all file paths
import { validatePath } from '@/utils/security.js';
validatePath(userProvidedPath);
```

---

## 🏗️ Architecture Guidelines

### 5-Layer Architecture (Never Skip Layers)

**Flow**: `CLI → Registry → Plugin → Core → Utils`

| Layer | Path | Responsibility |
|-------|------|----------------|
| **CLI** | `src/cli/commands/` | User interface (Commander.js commands) |
| **Registry** | `src/agents/registry.ts` | Plugin discovery and routing |
| **Plugin** | `src/agents/plugins/` | Concrete implementations (agents, providers) |
| **Core** | `src/agents/core/` | Base classes, interfaces, contracts |
| **Utils** | `src/utils/` | Shared utilities (errors, logging, security) |

### Testing Patterns (Critical for exec-dependent modules)

```typescript
// ✅ Use dynamic imports when testing modules that call exec()
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as exec from '../exec.js';

describe('module name', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Set up spy BEFORE dynamic import
    execSpy = vi.spyOn(exec, 'exec');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should do something', async () => {
    execSpy.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    
    // Dynamic import AFTER spy setup (crucial!)
    const { functionToTest } = await import('../module.js');
    await functionToTest();
    
    expect(execSpy).toHaveBeenCalledWith('command', ['arg']);
  });
});
```

**Why?** Static imports execute before spies are set up, causing real exec() calls.

---

## 🚨 Critical Rules

### 1. Testing Policy
- ❌ **Never proactively write or run tests**
- ✅ **Only when user explicitly requests**: "write tests", "run tests", "add test coverage"
- **Rationale**: Testing requires time and context; only implement when needed

### 2. Git Operations Policy
- ❌ **Never proactively commit, push, or create branches/PRs**
- ✅ **Only when user explicitly requests**: "commit changes", "push to remote", "create PR"
- **Branch pattern**: `<type>/<description>` (e.g., `feat/add-gemini-support`)
- **Commit format**: Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.)

### 3. Environment Policy
- ✅ **No activation needed** (Node.js >=20.0.0 required)
- ❌ **No virtual environment or conda**
- **Verify**: `node --version` should show >=20.0.0

### 4. Shell Commands
- ✅ **Use bash/Linux commands only** (macOS, Linux, WSL on Windows)
- ❌ **No PowerShell or cmd.exe commands**

---

## 🎯 Common Pitfalls to Avoid

| ❌ Never Do This | ✅ Do This Instead |
|------------------|---------------------|
| Import without `.js` extension | Always use `.js`: `import x from './file.js'` |
| Use `require()` or `__dirname` | Use ES modules: `import` and `getDirname(import.meta.url)` |
| Use `console.log()` for debug | Use `logger.debug()` (file-only, controlled) |
| Log sensitive data (tokens, keys) | Use `sanitizeLogArgs()` before logging |
| Throw generic `Error` | Throw specific error classes (`ConfigurationError`, etc.) |
| Use `child_process.exec` directly | Use `exec()` from `@/utils/processes.js` |
| Hardcode `~/.codemie/` paths | Use `getCodemiePath()` from `@/utils/paths.js` |
| CLI directly calls plugin code | CLI → Registry → Plugin (never skip layers) |
| Await in loops | Use `Promise.all()` for parallel operations |
| Write tests unless requested | Only write tests when user explicitly asks |

---

## 📚 Additional Resources

- **CLAUDE.md**: Comprehensive AI execution guide (608 lines)
- **.codemie/guides/**: Detailed pattern documentation
  - `architecture/architecture.md` - 5-layer architecture
  - `development/development-practices.md` - Error handling, logging
  - `testing/testing-patterns.md` - Vitest patterns
  - `standards/code-quality.md` - TypeScript patterns
  - `standards/git-workflow.md` - Branch/commit conventions
  - `integration/external-integrations.md` - LangGraph, providers
  - `security/security-practices.md` - Sanitization, credentials

---

**Remember**: When in doubt, check guides first, then ask the user for clarification. Never assume or skip critical rules.
