# Development Practices

## Quick Summary

Core development practices for CodeMie Code: error handling, logging, process execution, and TypeScript patterns.

**Category**: Development
**Complexity**: Medium
**Prerequisites**: TypeScript fundamentals, Node.js 20+, ES Modules

---

## Error Handling

### Exception Hierarchy

| Exception | When to Use | Example Use Case | Source |
|-----------|-------------|------------------|--------|
| `CodeMieError` | Base for all errors | Generic CodeMie failures | src/utils/errors.ts:1-6 |
| `ConfigurationError` | Config issues | Invalid profile, missing settings | src/utils/errors.ts:8-13 |
| `AgentNotFoundError` | Agent lookup failed | Unknown agent name requested | src/utils/errors.ts:15-20 |
| `AgentInstallationError` | Install failed | npm install errors, missing deps | src/utils/errors.ts:22-27 |
| `ToolExecutionError` | Tool exec failed | Command execution errors | src/utils/errors.ts:29-34 |
| `PathSecurityError` | Path validation failed | Path traversal attempt | src/utils/errors.ts:36-41 |
| `NpmError` | npm operations | Network, permission, package issues | src/utils/errors.ts:57-66 |

### Pattern: Throw & Catch

```typescript
// Throw - Source: src/agents/registry.ts:47-50
if (!adapter) {
  throw new AgentNotFoundError(name);
}

// Catch - Source: src/cli/commands/execute.ts:30-38
try {
  await adapter.execute(args);
} catch (error) {
  const context = createErrorContext(error, { agentName });
  logger.error('Execution failed', context);
  console.error(formatErrorForUser(context));
}
```

**Rules**:
- ✅ Use specific error classes (not bare Error)
- ✅ Always add context via createErrorContext()
- ✅ Log errors with logger.error()
- ✅ Format errors for user with formatErrorForUser()
- ❌ Expose internal implementation details
- ❌ Log stack traces to console (use logger.debug())

---

## Logging

### Configuration

```typescript
// Source: src/utils/logger.ts:22-60
// Set context at agent startup
logger.setAgentName('claude');
logger.setProfileName('work');
logger.setSessionId(sessionId);
```

### Log Levels

| Level | When | Console | File | Example |
|-------|------|---------|------|---------|
| DEBUG | Internal details | ❌ No | ✅ Yes | `logger.debug('State transition', { from, to })` |
| INFO | Normal operations | ❌ No | ✅ Yes | `logger.info('Agent initialized', { agent })` |
| WARN | Recoverable issues | ✅ Yes | ✅ Yes | `logger.warn('Config missing', { key })` |
| ERROR | Failures | ✅ Yes | ✅ Yes | `logger.error('Install failed', context)` |
| SUCCESS | User feedback | ✅ Yes | ✅ Yes | `logger.success('Agent installed')` |

### Pattern: Structured Logging with Sanitization

```typescript
// Source: src/utils/logger.ts:150-165
import { sanitizeLogArgs } from './security.js';

// Good - Structured with sanitization
logger.debug('API request', ...sanitizeLogArgs({
  url: request.url,
  headers: request.headers, // Automatically sanitizes sensitive headers
  body: request.body
}));

// Bad - Raw logging
console.log('Request:', request); // ❌ May expose secrets
logger.debug(JSON.stringify(request)); // ❌ No sanitization
```

**Rules**:
- ✅ Use logger.debug() for internal details (file-only)
- ✅ Use logger.success() for user feedback messages
- ✅ Always sanitize with sanitizeLogArgs() before logging
- ✅ Set session context (agent, profile, sessionId) at startup
- ❌ Use console.log() for debug info (use logger.debug())
- ❌ Log sensitive data (tokens, passwords, API keys)
- ❌ Log in performance-critical paths

**Log File Location**: `~/.codemie/logs/debug-YYYY-MM-DD.log`
**Debug Mode**: Set `CODEMIE_DEBUG=true` to see debug logs in console

---

## Process Execution

### npm & Process Operations

```typescript
// Source: src/utils/processes.ts
import { installGlobal, commandExists, exec } from './utils/processes.js';

// Check if package installed
const installed = await listGlobal('@anthropic-ai/claude-cli');

// Install package
await installGlobal('@anthropic-ai/claude-cli');

// Check command exists
const hasGit = await commandExists('git');

// Execute command
const result = await exec('npm', ['install', '-g', 'package']);
```

**Rules**:
- ✅ Use exec() from src/utils/exec.ts for all process spawning
- ✅ Use high-level functions (installGlobal, etc.) when available
- ✅ Handle errors with parseNpmError() for npm operations
- ✅ Set appropriate timeouts (default: 2 minutes)
- ❌ Use child_process.exec() directly
- ❌ Use synchronous operations (execSync) in async contexts

---

## TypeScript Patterns

### TypeScript Best Practices

```typescript
// ✅ Good - ES modules with .js extension
import { AgentRegistry } from './agents/registry.js';
import type { AgentAdapter } from './agents/core/types.js';

// ✅ Good - async/await with error handling
async function installAgent(name: string): Promise<void> {
  try {
    await AgentRegistry.getAgent(name).install();
  } catch (error) {
    logger.error('Install failed', createErrorContext(error));
  }
}

// ✅ Good - Interface for objects
export interface ExecutionOptions {
  cwd?: string;
  timeout?: number;
}

// ❌ Bad - Missing .js or no return type
import { AgentRegistry } from './agents/registry'; // Missing .js
async function getAgent(name: string) { } // Missing return type
```

**Rules**:
- ✅ All imports use .js extensions (required for ES modules)
- ✅ All exported functions have explicit return types
- ✅ Use interfaces for object shapes (prefer over types)
- ✅ Use async/await consistently (no Promise chains)
- ✅ Use optional chaining (?.) and nullish coalescing (??)
- ✅ Use single quotes ('') for strings (project convention, consistent style)
- ⚠️ 'any' allowed when needed - @typescript-eslint/no-explicit-any disabled
- ❌ Use require() or __dirname (use ES modules and getDirname())
- ❌ Use double quotes ("") for strings (use single quotes instead)

---

## Path Utilities

### CodeMie Paths

```typescript
// Source: src/utils/paths.ts:80-95
import { getCodemiePath, getCodemieHome } from './utils/paths.js';

// Get base directory (~/.codemie/)
const home = getCodemieHome();

// Get specific paths
const configPath = getCodemiePath('config.json');
const logsDir = getCodemiePath('logs');
const agentsDir = getCodemiePath('agents');
```

### Path Validation

```typescript
// Source: src/utils/paths.ts:40-60
import { isPathWithinDirectory, matchesPathStructure } from './utils/paths.js';

// Ensure path is within working directory
const safe = isPathWithinDirectory(workingDir, resolvedPath);
if (!safe) {
  throw new PathSecurityError(resolvedPath, 'Path outside working directory');
}

// Validate path structure
const matches = matchesPathStructure(
  filePath,
  baseDir,
  ['src', 'agents', 'plugins']
);
```

---

## Configuration Management

### Profile Loading

```typescript
// Source: src/env/config-loader.ts:50-70
import { ConfigLoader } from './env/config-loader.js';

// Load config from working directory
const config = await ConfigLoader.load(process.cwd(), {
  profile: 'work',
  provider: 'openai'
});

// Access profile settings
const apiKey = config.profile.provider.apiKey;
const model = config.profile.model;
```

### Environment Variables

**Required**:
```bash
# Provider-specific (one required)
ANTHROPIC_API_KEY=sk-ant-...          # For Claude
OPENAI_API_KEY=sk-...                 # For OpenAI
GOOGLE_AI_API_KEY=...                 # For Gemini
```

**Optional**:
```bash
CODEMIE_DEBUG=true                    # Debug logging to console (default: false)
CODEMIE_PROFILE=work                  # Default profile (default: default)
NODE_ENV=development                  # Environment mode
```

**Rules**:
- ✅ Use environment variables for deployment-specific config
- ✅ Use profiles for user-specific settings
- ✅ Validate config at startup with ConfigLoader
- ❌ Hardcode secrets (use CredentialStore or env vars)
- ❌ Commit .env files

---

## Setup Guide

### Quick Start

```bash
# Install
npm install -g @codemieai/code

# Verify
codemie doctor

# Setup profile
codemie setup

# Run built-in agent
codemie-code health
```

### Development Setup

```bash
# 1. Clone repository
git clone https://github.com/codemie-ai/codemie-code.git
cd codemie-code

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Link for local testing
npm link

# 5. Verify
codemie doctor
```

---

## Common Commands

| Task | Command | Notes |
|------|---------|-------|
| Install deps | `npm install` | First time setup |
| Build | `npm run build` | Compile TypeScript to dist/ |
| Dev watch | `npm run dev` | Watch mode (tsc --watch) |
| Lint | `npm run lint` | ESLint check (zero warnings) |
| Lint fix | `npm run lint:fix` | Auto-fix issues |
| Test | `npm test` | ONLY if user requests |
| Test unit | `npm run test:unit` | Unit tests only |
| Test integration | `npm run test:integration` | Integration tests only |
| CI | `npm run ci` | Full CI pipeline |
| Link global | `npm link` | Link for local testing |

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `command not found: codemie` | Not installed globally | Run `npm install -g @codemieai/code` or `npm link` |
| `Cannot find module './file'` | Missing .js extension | Add `.js` to all imports |
| `Module not found: @codemieai/code` | Dependencies not installed | Run `npm install` |
| Tests fail with dynamic imports | Static imports before spy | Use dynamic imports after beforeEach |
| `CODEMIE_DEBUG=true` not working | Env var not set | Export: `export CODEMIE_DEBUG=true` |
| ESLint warnings | Code quality issues | Run `npm run lint:fix` |
| TypeScript errors | Type issues | Check tsconfig.json, use strict mode |

---

## Testing Guidelines

### Dynamic Imports for Mocking

```typescript
// Source: src/utils/__tests__/npm.test.ts:10-30
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as exec from '../exec.js';

describe('npm utilities', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Set up spy BEFORE importing module
    execSpy = vi.spyOn(exec, 'exec').mockResolvedValue({
      code: 0, stdout: '', stderr: ''
    });
  });

  it('should install package', async () => {
    // Dynamic import AFTER spy is ready
    const { installGlobal } = await import('../processes.js');
    await installGlobal('test-package');

    expect(execSpy).toHaveBeenCalledWith('npm', ['install', '-g', 'test-package'], expect.any(Object));
  });
});
```

**Why Dynamic Imports?**
- Static imports cache module before beforeEach runs
- Spy can't intercept calls to already-imported functions
- Dynamic imports ensure spy is ready before module loads

---

## References

- **Error Handling**: `src/utils/errors.ts`
- **Logging**: `src/utils/logger.ts`
- **Processes**: `src/utils/processes.ts`, `src/utils/exec.ts`
- **Paths**: `src/utils/paths.ts`
- **Security**: `src/utils/security.ts`
- **Configuration**: `src/env/config-loader.ts`
- **Utils Guide**: `src/utils/CLAUDE.md`

---
