# Code Quality Standards

## Quick Summary

Code quality standards for CodeMie Code: ESLint configuration, TypeScript practices, naming conventions, and pre-commit enforcement.

**Category**: Standards
**Complexity**: Simple
**Prerequisites**: TypeScript, ESLint 9, Node.js

---

## Tools

| Tool | Purpose | Config | Version |
|------|---------|--------|---------|
| **ESLint** | Code quality & style | `eslint.config.mjs` | 9.x (flat config) |
| **TypeScript** | Type checking & compilation | `tsconfig.json` | 5.x |
| **Vitest** | Testing | `vitest.config.ts` | Latest |
| **Husky** | Pre-commit hooks | `.husky/` | Latest |
| **lint-staged** | Staged file linting | `package.json` | Latest |
| **Commitlint** | Commit message validation | `commitlint.config.cjs` | Latest |

---

## Commands

```bash
# Lint (check only)
npm run lint

# Lint and auto-fix
npm run lint:fix

# Type check (via build)
npm run build

# Full CI validation
npm run ci

# Pre-commit hook (automatic)
git commit  # Runs lint + tests on staged files
```

**CI Pipeline**: `npm run ci` → License check → Lint → Build → Unit tests → Integration tests

**Source**: package.json:39

---

## ESLint Configuration

### Flat Config Structure (ESLint 9)

```javascript
// Source: eslint.config.mjs:5-78
export default [
  eslint.configs.recommended,
  // Test files (simpler rules, no project requirement)
  {
    files: ['tests/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  // Source files (type-aware linting with tsconfig.json)
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    parserOptions: { project: './tsconfig.json' }
  }
];
```

### Key Rules

| Rule | Level | Rationale |
|------|-------|-----------|
| `@typescript-eslint/no-explicit-any` | OFF | Pragmatic typing (allowed where needed) |
| `@typescript-eslint/no-unused-vars` | WARN | Prefix with `_` to ignore: `_unusedVar` |
| `@typescript-eslint/no-require-imports` | WARN | Prefer ES modules |
| `no-useless-catch` | WARN | Don't catch and re-throw without adding value |
| `max-warnings` | 0 | CI enforces zero warnings (package.json:33) |

**Source**: eslint.config.mjs:29-38, 64-73

---

## TypeScript Configuration

### Compiler Options

| Option | Value | Purpose |
|--------|-------|---------|
| **target** | ES2022 | Modern Node.js (>=20.0.0) |
| **module** | NodeNext | ESM with `.js` imports |
| **strict** | true | Maximum type safety |
| **noImplicitAny** | false | Allow implicit any (pragmatic) |
| **declaration** | true | Generate `.d.ts` files |
| **sourceMap** | true | Enable debugging |

**Source**: tsconfig.json:2-23

### Type Safety Guidelines

```typescript
// ✅ Explicit return types on public APIs
export async function loadConfig(path: string): Promise<Config> {
  // ...
}

// ✅ Type parameters when needed
interface FlagMapping {
  type: FlagMappingType;
  target: string | null;
}

// ✅ Use 'type' keyword for type-only imports
import type { AgentAdapter } from './agents/registry.js';

// ❌ Avoid implicit any (except where ESLint allows)
function process(data) { // ESLint warning if not intentional
  // ...
}
```

**Source**: src/agents/core/types.ts:1-50

---

## Naming Conventions

| Element | Convention | Example | File Reference |
|---------|------------|---------|----------------|
| **Variables** | camelCase | `sessionId`, `agentName` | Universal |
| **Functions** | camelCase | `transformFlags`, `loadConfig` | src/agents/core/flag-transform.ts |
| **Classes** | PascalCase | `BaseAgentAdapter`, `ConfigLoader` | src/agents/core/BaseAgentAdapter.ts |
| **Interfaces** | PascalCase | `AgentConfig`, `FlagMapping` | src/agents/core/types.ts:13-22 |
| **Types** | PascalCase | `FlagMappingType` | src/agents/core/types.ts:8 |
| **Constants** | UPPER_SNAKE_CASE | `DEFAULT_TIMEOUT`, `API_VERSION` | Rare (prefer const) |
| **Files** | kebab-case | `flag-transform.ts`, `agent-executor.js` | src/ and bin/ |
| **Test Files** | `*.test.ts` | `security.test.ts` | src/\_\_tests\_\_/ |
| **Unused Vars** | Prefix with `_` | `_unusedParam` | ESLint rule |

---

## Import Guidelines

### ESM Requirements

```typescript
// ✅ MUST use .js extension (ESM requirement)
import { AgentRegistry } from './agents/registry.js';
import { logger } from '../utils/logger.js';

// ✅ Type-only imports
import type { AgentAdapter } from './agents/registry.js';

// ❌ NO .ts extensions
import { AgentRegistry } from './agents/registry.ts'; // ERROR

// ❌ NO missing extensions
import { AgentRegistry } from './agents/registry'; // ERROR
```

### Import Order

**Standard order** (not enforced by linter, but recommended):
1. Node.js built-ins (`fs`, `path`, `os`)
2. External packages (`commander`, `inquirer`, `chalk`)
3. Internal modules (relative imports)
4. Type-only imports (last)

**Source**: package.json:5 (type: module)

---

## Code Structure Guidelines

| Guideline | Recommendation |
|-----------|----------------|
| **Function length** | < 50 lines preferred |
| **File length** | < 500 lines |
| **Parameters** | ≤ 4 (use options object if more) |
| **Nesting depth** | ≤ 3 levels (use early returns) |
| **Single Responsibility** | One clear purpose per function |

---

## Comments and Documentation

### When to Comment

```typescript
// ✅ Public APIs (JSDoc format)
/**
 * Transform CLI flags based on agent-specific mappings
 * @param args - Original CLI arguments
 * @param mappings - Flag transformation rules
 * @param config - Agent configuration
 * @returns Transformed arguments
 */
export function transformFlags(
  args: string[],
  mappings: FlagMappings | undefined,
  config: AgentConfig
): string[] {
  // ...
}

// ✅ Complex algorithms or non-obvious logic
// Using dynamic import to ensure spy is set up before module loads
const { installGlobal } = await import('../processes.js');

// ✅ Workarounds or gotchas
// Note: Must use .js extension for ESM compatibility (not .ts)
import { exec } from './exec.js';

// ❌ Self-explanatory code (let code speak for itself)
// Get the user name (UNNECESSARY)
const userName = config.userName;
```

**Source**: src/agents/core/types.ts:1-50 (JSDoc examples)

---

## Pre-Commit Hooks

### Configuration

```json
// Source: package.json:45-52
{
  "lint-staged": {
    "*.ts": [
      "eslint --max-warnings=0 --no-warn-ignored",
      "vitest related --run"
    ],
    "package.json": [
      "npm run license-check"
    ]
  }
}
```

**Runs on Commit**: ESLint (zero warnings) + Vitest (related tests) + License check

---

## Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Use descriptive names (`loadConfig`) | Single letters except `i`, `j`, `k` in loops |
| Keep functions focused (one responsibility) | 100+ line functions |
| Use TypeScript types everywhere | Skip types or abuse `any` |
| Follow ESM conventions (`.js` imports) | Mix CommonJS with ESM |
| Use early returns to reduce nesting | Deep if/else pyramids |
| Extract common logic to utils | Copy-paste code |
| Prefix unused params with `_` | Ignore ESLint warnings |
| Test business logic thoroughly | Only test happy paths |
| Use `const` by default | Mutable `let` everywhere |
| Sanitize logs (no secrets) | Log API keys, tokens, passwords |

**Related**: .codemie/guides/development/development-practices.md (error handling, logging)

---

## Error Handling Standards

```typescript
// ✅ Use specific error types
throw new ConfigurationError('Missing API key in profile');

// ✅ Provide context
logger.error('Failed to load config', {
  profileName,
  error: createErrorContext(error)
});

// ✅ Sanitize sensitive data
logger.debug('Request sent', ...sanitizeLogArgs(requestData));

// ❌ Generic errors
throw new Error('Something went wrong');

// ❌ Exposing secrets
logger.debug('API request', { apiKey: config.apiKey }); // NEVER!
```

**Source**: src/utils/errors.ts, src/utils/security.ts

---

## Testing Standards

| Requirement | Standard |
|-------------|----------|
| **Unit tests** | Co-located in `__tests__/` |
| **Integration tests** | In `tests/integration/` |
| **Coverage** | Recommended 80%+ |
| **Test naming** | Descriptive (`should X when Y`) |

**Related**: .codemie/guides/testing/testing-patterns.md

---

## Commit Message Standards

### Format (Conventional Commits)

```bash
type(scope): subject

[optional body]

[optional footer]
```

### Types

| Type | Usage | Example |
|------|-------|---------|
| `feat` | New feature | `feat(agents): add gemini plugin` |
| `fix` | Bug fix | `fix(cli): handle missing config gracefully` |
| `refactor` | Code restructuring | `refactor(utils): consolidate path utilities` |
| `test` | Add/update tests | `test(agents): expand flag transform coverage` |
| `docs` | Documentation | `docs: update README with examples` |
| `chore` | Maintenance | `chore: update dependencies` |
| `perf` | Performance | `perf(exec): optimize command execution` |
| `ci` | CI/CD changes | `ci: add integration test workflow` |

**Validation**: Commitlint runs on commit (commitlint.config.cjs)

**Source**: package.json:35-36 (commitlint scripts)

---

## License Compliance

**Command**: `npm run license-check`

**Allowed**: MIT, Apache-2.0, ISC, BSD variants, CC0, Unlicense

---

## CI/CD Quality Gates

**Command**: `npm run ci`

**Steps**: License → ESLint → Build → Unit tests → Integration tests (all must pass)

---

## Common Pitfalls

| ❌ Mistake | ✅ Fix |
|-----------|--------|
| Import without `.js` | Add `.js` extension (ESM) |
| `any` everywhere | Use specific types or interfaces |
| Deep nesting (4+ levels) | Use early returns |
| Long functions (100+ lines) | Extract smaller functions |
| Missing error handling | Wrap in try/catch, log with context |
| Secrets in logs | Use `sanitizeLogArgs()` |
| Ignoring ESLint warnings | Fix warnings (max-warnings=0) |
| Committing without hooks | Ensure Husky installed (`npm run prepare`) |

---

## References

- **ESLint Config**: `eslint.config.mjs`
- **TypeScript Config**: `tsconfig.json`
- **Package Scripts**: `package.json`
- **Pre-commit Hooks**: `.husky/pre-commit`
- **Commitlint Config**: `commitlint.config.cjs`
- **Vitest Config**: `vitest.config.ts`
- **ESLint 9 Docs**: https://eslint.org/docs/latest/use/configure/
- **TypeScript Docs**: https://www.typescriptlang.org/docs/

---

## Related Guides

- Development Practices: .codemie/guides/development/development-practices.md
- Testing Patterns: .codemie/guides/testing/testing-patterns.md
- Git Workflow: .codemie/guides/standards/git-workflow.md
