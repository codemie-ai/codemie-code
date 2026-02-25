---
name: typescript-best-practices
description: TypeScript coding standards for CodeMie Code project
version: 1.0.0
author: CodeMie Team
priority: 10
modes:
  - code
compatibility:
  agents:
    - codemie-code
---

# TypeScript Best Practices

This skill provides TypeScript coding standards specific to the CodeMie Code project.

## Code Quality Standards

### Explicit Return Types
- Always use explicit return types for exported functions
- Helps with type inference and documentation
- Makes refactoring safer

```typescript
// ✅ Good
export function loadConfig(path: string): Config {
  // ...
}

// ❌ Bad
export function loadConfig(path: string) {
  // Return type inferred but not explicit
}
```

### Type Safety
- Avoid `any` - use `unknown` if type is truly unknown
- Use interface over type for object shapes
- Prefer type narrowing over type assertions

```typescript
// ✅ Good
interface User {
  name: string;
  email: string;
}

function processData(data: unknown): void {
  if (typeof data === 'string') {
    // Type narrowing
    console.log(data.toUpperCase());
  }
}

// ❌ Bad
function processData(data: any): void {
  console.log(data.toUpperCase());
}
```

## Import Conventions

### ES Module Extensions
- All imports must use `.js` extension (required for ES modules)
- TypeScript compiles .ts → .js, so import paths must reference .js
- Use named imports over default imports

```typescript
// ✅ Good
import { logger } from '../../utils/logger.js';
import type { Config } from './types.js';

// ❌ Bad
import { logger } from '../../utils/logger';
import { Config } from './types';
```

### Import Grouping
Group imports in this order:
1. External dependencies
2. Internal imports (relative paths)
3. Type-only imports

```typescript
// ✅ Good
import { Command } from 'commander';
import chalk from 'chalk';

import { logger } from '../../utils/logger.js';
import { SkillManager } from '../../skills/index.js';

import type { Skill } from '../../skills/index.js';

// ❌ Bad (mixed order)
import type { Skill } from '../../skills/index.js';
import { Command } from 'commander';
import { logger } from '../../utils/logger.js';
```

## Error Handling

### Custom Error Classes
- Use specific error classes from `src/utils/errors.ts`
- Always provide context with errors
- Log before throwing when appropriate

```typescript
// ✅ Good
import { ConfigurationError, createErrorContext } from '../utils/errors.js';

try {
  await loadConfig();
} catch (error) {
  const context = createErrorContext(error, { sessionId });
  logger.error('Failed to load config', context);
  throw new ConfigurationError('Configuration loading failed', context);
}

// ❌ Bad
try {
  await loadConfig();
} catch (error) {
  throw new Error('Config failed');
}
```

### Async Error Handling
- Always use try/catch in async functions
- Handle promise rejections properly
- Use Promise.all() for parallel operations

```typescript
// ✅ Good
async function loadMultipleConfigs(): Promise<Config[]> {
  try {
    const configs = await Promise.all([
      loadConfig('a'),
      loadConfig('b'),
      loadConfig('c')
    ]);
    return configs;
  } catch (error) {
    logger.error('Failed to load configs', error);
    throw error;
  }
}

// ❌ Bad (sequential, no error handling)
async function loadMultipleConfigs() {
  const a = await loadConfig('a');
  const b = await loadConfig('b');
  const c = await loadConfig('c');
  return [a, b, c];
}
```

## Project-Specific Patterns

### Logging
- Use `logger.debug()` for internal details
- Use `logger.info()` for important events
- Use `logger.error()` for errors
- Never use `console.log()` directly

```typescript
// ✅ Good
import { logger } from '../../utils/logger.js';

logger.debug('Processing skill:', skillName);
logger.info('Skills loaded:', skills.length);
logger.error('Skill loading failed:', error);

// ❌ Bad
console.log('Processing skill:', skillName);
```

### Path Handling
- Use `getCodemiePath()` for ~/.codemie/ paths
- Use `getDirname()` for module directory resolution
- Never hardcode paths

```typescript
// ✅ Good
import { getCodemiePath, getDirname } from '../../utils/paths.js';

const globalSkillsDir = getCodemiePath('skills');
const moduleDir = getDirname(import.meta.url);

// ❌ Bad
const globalSkillsDir = '~/.codemie/skills';
const moduleDir = __dirname; // CommonJS, not ES modules
```

### Security
- Sanitize all logged data using `sanitizeLogArgs()`
- Validate file paths before operations
- Never log sensitive information (tokens, credentials)

```typescript
// ✅ Good
import { sanitizeLogArgs } from '../../utils/security.js';

logger.debug('Request data:', ...sanitizeLogArgs(requestData));

// ❌ Bad
logger.debug('Request data:', requestData); // May contain secrets
```

## When Implementing Features

Follow these guidelines when implementing new features:

1. **Read First**: Always read existing code before modifying
2. **Follow Patterns**: Match existing architectural patterns
3. **Type Everything**: Explicit types on all exports
4. **Error Context**: Provide meaningful error messages and context
5. **Test Imports**: Ensure all imports work with .js extensions
6. **Security Check**: Sanitize logs, validate inputs
7. **Document**: Add JSDoc comments for public APIs

## Common Pitfalls to Avoid

- ❌ Using `require()` instead of `import`
- ❌ Using `__dirname` instead of `getDirname(import.meta.url)`
- ❌ Forgetting `.js` extensions in imports
- ❌ Using `any` type
- ❌ Logging sensitive data
- ❌ Using `console.log()` instead of `logger`
- ❌ Hardcoding paths
- ❌ Missing error handling in async code

---

When you work on CodeMie Code, apply these patterns consistently. Quality and security are non-negotiable.
