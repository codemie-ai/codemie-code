# Development Practices

## Quick Summary

Core development practices for CodeMie Code: error handling, logging, and configuration patterns.

**Category**: Development
**Complexity**: Medium
**Prerequisites**: TypeScript fundamentals, Node.js

---

## Error Handling

### Exception Hierarchy

| Exception | When to Use | Module | Source |
|-----------|-------------|---------|--------|
| `CodeMieError` | Base error class | All | src/utils/errors.ts:1-6 |
| `ConfigurationError` | Config loading failed | Configuration | src/utils/errors.ts:8-13 |
| `AgentNotFoundError` | Agent not registered | Agent system | src/utils/errors.ts:15-20 |
| `AgentInstallationError` | Agent install failed | Installation | src/utils/errors.ts:22-27 |
| `ToolExecutionError` | Built-in agent tool failed | Built-in agent | src/utils/errors.ts:29-34 |
| `PathSecurityError` | Path traversal detected | Security | src/utils/errors.ts:36-41 |
| `NpmError` | npm operations failed | Process utils | src/utils/errors.ts:57-66 |

### Pattern: Custom Error Classes

```typescript
// Source: src/utils/errors.ts:1-13
export class CodeMieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeMieError';
  }
}

export class ConfigurationError extends CodeMieError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
```

**Key Points**:
- Extend from `CodeMieError` base class
- Set `this.name` for proper error identification
- Use specific error types (not generic `Error`)

### Pattern: Error Parsing

```typescript
// Source: src/utils/errors.ts:74-119
export function parseNpmError(error: unknown, context: string): NpmError {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

  let code: NpmErrorCode = NpmErrorCode.UNKNOWN;
  let hint = '';

  if (lowerMessage.includes('timed out')) {
    code = NpmErrorCode.TIMEOUT;
    hint = 'Try increasing timeout or check connection.';
  } else if (lowerMessage.includes('404')) {
    code = NpmErrorCode.NOT_FOUND;
    hint = 'Verify package name and version.';
  }
  // ... more patterns
}
```

**Pattern**: Parse error messages to categorize failures and provide helpful hints

### Error Context

```typescript
// Source: src/utils/errors.ts:295-309
const context = createErrorContext(error, { sessionId, agent: 'claude' });
logger.error('Operation failed', context);
console.error(formatErrorForUser(context, { showStack: false }));
```

**Functions**: `createErrorContext`, `formatErrorForUser`, `formatErrorForLog`, `getErrorExplanation`

**Rules**: ✅ Specific exceptions ✅ Add context ✅ Log with context ✅ Friendly user messages ❌ Generic errors ❌ Expose stacks ❌ Log secrets

---

## Logging

### Logger Setup

```typescript
// Source: src/utils/logger.ts:22-58
class Logger {
  private sessionId: string = '';
  private agentName: string | null = null;
  private profileName: string | null = null;

  setAgentName(name: string): void {
    this.agentName = name;
  }

  setProfileName(name: string): void {
    this.profileName = name;
  }
}

// Singleton instance
export const logger = new Logger();
```

### Log Levels

| Level | When | Environment | Example Use |
|-------|------|-------------|-------------|
| `DEBUG` | Development details, API calls | `CODEMIE_DEBUG=true` | Request/response bodies, tool args |
| `INFO` | Normal operations | Always | Agent start, command execution |
| `WARN` | Recoverable issues | Always | Deprecated features, fallbacks |
| `ERROR` | Failures requiring attention | Always | Installation failures, API errors |

### Pattern: Structured Logging

```typescript
// ✅ Good - with context
logger.debug('Loading agent plugin', {
  agent: 'claude',
  version: '1.0.0',
  config: sanitizedConfig
});

// ✅ Good - error with context
logger.error('Failed to sync metrics', {
  sessionId,
  error: createErrorContext(error)
});

// ❌ Bad - no context
logger.debug('Loading plugin');

// ❌ Bad - logging secrets
logger.debug('API request', { apiKey: config.apiKey }); // NEVER!
```

### Log File Management

**Location**: `~/.codemie/logs/debug-YYYY-MM-DD.log`

**Features**:
- Daily log files
- Auto-cleanup (files older than 5 days deleted)
- Auto-sanitization of secrets/PII
- Session ID tracking

**Enable Debug Logging**:
```bash
# Via environment variable
export CODEMIE_DEBUG=true
codemie-code "your prompt"

# Via CLI flag
codemie setup --verbose
```

**View Logs**:
```bash
# Today's log
tail -f ~/.codemie/logs/debug-$(date +%Y-%m-%d).log

# All recent logs
ls -lh ~/.codemie/logs/
```

### Sanitization (CRITICAL)

```typescript
// Source: src/utils/security.ts:11-45
import { sanitizeLogArgs } from './security.js';

// Automatically sanitize before logging
logger.debug('Config loaded', ...sanitizeLogArgs(config));

// Sanitizes:
// - Cookies (redacted)
// - Authorization headers (redacted)
// - API keys/tokens (redacted)
// - Passwords (redacted)
```

**Rules**:
- ✅ Use `sanitizeLogArgs` for all structured data
- ✅ Include session/request context
- ✅ Use appropriate log levels
- ❌ Log secrets, tokens, API keys
- ❌ Log PII (emails, names, addresses)
- ❌ Log in hot paths (inside tight loops)

---

## Configuration

### Environment Variables

**CodeMie-Specific**:
```bash
CODEMIE_DEBUG=true              # Enable debug logging
CODEMIE_HOME=/custom/path       # Custom config directory (default: ~/.codemie)
CODEMIE_CLI_VERSION=0.0.28      # Set by CLI (auto-detected)
```

**Provider-Specific** (via profile config):
- Stored in `~/.codemie/config.json`
- Managed via `codemie setup` or `codemie profile`
- Never commit config files (in `.gitignore`)

### Pattern: Load Configuration

```typescript
// Source: src/utils/config.ts:ConfigLoader class
import { ConfigLoader } from './utils/config.js';

// Load with overrides
const config = await ConfigLoader.load(process.cwd(), {
  provider: 'openai',
  model: 'gpt-4'
});

// Profile management
await ConfigLoader.saveProfile('work', workProfile);
await ConfigLoader.switchProfile('work');
await ConfigLoader.deleteProfile('old-profile');
```

**Configuration Structure**:
```typescript
interface Config {
  provider: string;              // 'openai', 'anthropic', 'sso', etc.
  model: string;                 // Model identifier
  authToken?: string;            // API key (if applicable)
  baseUrl?: string;              // Custom endpoint
  timeout?: number;              // Request timeout (ms)
  // ... provider-specific fields
}
```

### Multi-Profile Support

```bash
# Create profiles
codemie setup  # Creates 'default' profile
codemie profile --create work   # Create 'work' profile
codemie profile --create personal  # Create 'personal' profile

# Switch profiles
codemie profile --switch work

# List profiles
codemie profile --list
```

**Profile Storage**: `~/.codemie/config.json`

```json
{
  "activeProfile": "work",
  "profiles": {
    "work": {
      "provider": "sso",
      "baseUrl": "https://company.api.com",
      "model": "claude-4-5-sonnet"
    },
    "personal": {
      "provider": "anthropic",
      "authToken": "sk-ant-...",
      "model": "claude-4-5-sonnet"
    }
  }
}
```

**Rules**:
- ✅ Use environment variables for deployment config
- ✅ Validate config at startup
- ✅ Use profiles for multi-environment setups
- ✅ Never commit `.env` or config files
- ❌ Hardcode secrets in source
- ❌ Store secrets in git

---

## Setup Guide

### Quick Start

```bash
# 1. Install globally
npm install -g @codemieai/code

# 2. Run setup wizard
codemie setup

# 3. Verify installation
codemie doctor

# 4. Install an agent (optional)
codemie install claude

# 5. Use the built-in agent
codemie-code "analyze this codebase"
```

### Development Setup

```bash
# 1. Clone repository
git clone https://github.com/codemie-ai/codemie-code.git
cd codemie-code

# 2. Install dependencies
npm install

# 3. Build TypeScript
npm run build

# 4. Link for global use
npm link

# 5. Verify
codemie --version
```

**Verify**: Run `codemie doctor` - all checks should pass

---

## Common Commands

| Task | Command | Notes |
|------|---------|-------|
| **Build** | `npm run build` | Compile TypeScript to dist/ |
| **Dev Watch** | `npm run dev` | Watch mode (auto-recompile) |
| **Lint** | `npm run lint` | ESLint with max-warnings=0 |
| **Lint Fix** | `npm run lint:fix` | Auto-fix linting issues |
| **Test** | `npm test` | Run tests in watch mode |
| **Test Once** | `npm run test:run` | Single test run |
| **Test Unit** | `npm run test:unit` | Unit tests only |
| **Test Integration** | `npm run test:integration` | Integration tests only |
| **CI Check** | `npm run ci` | Full CI validation (lint + build + tests) |
| **Secrets Check** | `npm run validate:secrets` | Check for exposed secrets (requires Docker) |

**Pre-commit**: Husky hooks automatically run lint and related tests

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `Command not found: codemie` | Not installed globally | Run `npm install -g @codemieai/code` or `npm link` |
| `EACCES` npm install error | Permission issues | Use `npm install -g --unsafe-perm` or fix npm permissions |
| `Cannot find module` after build | Stale dist/ directory | Run `rm -rf dist && npm run build` |
| Tests failing with "module not found" | Missing `.js` extensions | Ensure all imports use `.js` (ESM requirement) |
| Debug logs not appearing | Debug mode not enabled | Set `CODEMIE_DEBUG=true` or use `--verbose` flag |
| Config not loading | Wrong directory | Check `~/.codemie/config.json` exists and is valid JSON |
| Agent not found | Agent not installed | Run `codemie list` then `codemie install <agent>` |

---

## Development Workflow

**Making Changes**: Branch → Edit src/ → Build → Test → Lint → Commit (Conventional Commits) → Push

**Pre-Commit**: ✅ Build ✅ Lint ✅ Tests ✅ Commit format

**CI Validation**: `npm run ci` (or `npm run ci:full` with commit check)

---

## References

- **Error Classes**: `src/utils/errors.ts`
- **Logger**: `src/utils/logger.ts`
- **Configuration**: `src/utils/config.ts`
- **Security/Sanitization**: `src/utils/security.ts`
- **Process Utils**: `src/utils/processes.ts`
- **Contributing Guide**: `CONTRIBUTING.md`
- **Code Quality Standards**: `.codemie/guides/standards/code-quality.md`
