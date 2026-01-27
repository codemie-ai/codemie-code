# Code Quality Standards

## Quick Summary

Code quality standards for CodeMie Code: ESLint, TypeScript, naming conventions, and code structure.

**Category**: Standards
**Complexity**: Simple
**Prerequisites**: TypeScript, ESLint, Node.js 20+

---

## Tools

| Tool | Purpose | Config |
|------|---------|--------|
| ESLint | Code quality & linting | `eslint.config.mjs` |
| TypeScript | Type checking | `tsconfig.json` |
| Vitest | Test runner | `vitest.config.ts` |
| Husky | Git hooks | `.husky/` |
| lint-staged | Pre-commit checks | `package.json` |

---

## Commands

```bash
# Lint (check)
npm run lint

# Lint (auto-fix)
npm run lint:fix

# Type check
npx tsc --noEmit

# Build (includes type check)
npm run build

# Run all checks (CI)
npm run ci
```

---

## Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Variables | camelCase | `agentName`, `sessionId` |
| Functions | camelCase | `installAgent()`, `getProvider()` |
| Classes | PascalCase | `AgentRegistry`, `ConfigLoader` |
| Interfaces | PascalCase | `AgentAdapter`, `ExecutionOptions` |
| Types | PascalCase | `AgentConfig`, `ProviderType` |
| Constants | UPPER_SNAKE_CASE | `BUILTIN_AGENT_NAME`, `MAX_TIMEOUT` |
| Files | kebab-case.ts | `agent-registry.ts`, `config-loader.ts` |
| Plugins | kebab.plugin.ts | `claude.plugin.ts`, `openai.plugin.ts` |
| Tests | *.test.ts | `registry.test.ts`, `security.test.ts` |

---

## Type Annotations

```typescript
// Source: src/agents/registry.ts:47-50
// ✅ Explicit return types required
export async function getAgent(name: string): Promise<AgentAdapter | undefined> {
  return AgentRegistry.adapters.get(name);
}

// ✅ Interface for object shapes
export interface ExecutionOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

// ⚠️ 'any' allowed but document why
export function parseJSON(data: any): Config { // Accepts any JSON format
  return JSON.parse(data);
}
```

**Required**:
- ✅ All function parameters must have types
- ✅ All exported function returns must be typed
- ✅ Prefer `interface` over `type` for objects
- ⚠️ `any` is allowed (@typescript-eslint/no-explicit-any: off)
- ✅ Prefix unused vars with `_` if intentional

---

## Imports

```typescript
// Source: src/agents/plugins/claude/claude.plugin.ts:1-8
// ✅ Good - All imports use .js extension
import { AgentAdapter } from '../../core/types.js';
import { exec, commandExists } from '../../../utils/processes.js';
import { logger } from '../../../utils/logger.js';
import type { ExecutionOptions } from '../../core/types.js';

export class ClaudePlugin implements AgentAdapter {
  // ...
}
```

**Rules**:
- ✅ Always use `.js` extension (ES modules requirement)
- ✅ Use `import type` for type-only imports
- ✅ One import per line
- ✅ Group: Node.js built-ins → Third-party → Local
- ❌ No wildcard imports (`import * as`)
- ❌ No require() (use ES modules)

---

## ESLint Configuration

### Key Rules

| Rule | Setting | Reason |
|------|---------|--------|
| `@typescript-eslint/no-explicit-any` | off | Allow `any` when needed |
| `@typescript-eslint/no-unused-vars` | warn | Warn, prefix with `_` if intentional |
| `@typescript-eslint/no-require-imports` | warn | Prefer ES modules |
| `no-undef` | off | TypeScript handles this |
| `no-useless-catch` | warn | Avoid catch-and-rethrow |
| `no-case-declarations` | warn | Use blocks in case statements |

### Flat Config Format

```javascript
// Source: eslint.config.mjs:5-20
export default [
  eslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    }
  }
];
```

---

## Code Structure Guidelines

**Functions**:
- Keep functions under 50 lines
- One responsibility per function
- Limit parameters to 4-5 maximum
- Use destructuring for multiple params

**Files**:
- Keep files under 500 lines
- One main export per file
- Co-locate related functionality

**Classes**:
- Single Responsibility Principle
- Prefer composition over inheritance
- Use dependency injection

---

## Comments & Documentation

```typescript
// ✅ Good - Document public APIs
/**
 * Install agent package globally
 * @param packageName - npm package name
 * @param options - Install options (version, timeout, etc.)
 * @throws {NpmError} If installation fails
 */
export async function installGlobal(
  packageName: string,
  options?: NpmInstallOptions
): Promise<void> {
  // Implementation
}

// ✅ Good - Explain non-obvious logic
// Use HEREDOC for multiline commit messages to preserve formatting
const message = `$(cat <<'EOF'
${commitMessage}
EOF
)`;

// ❌ Bad - Explaining obvious code
// Set name to 'claude'
const name = 'claude';
```

**When to Comment**:
- ✅ Public APIs (JSDoc)
- ✅ Complex algorithms
- ✅ Non-obvious decisions or workarounds
- ✅ WHY not WHAT (code shows what, comment shows why)
- ❌ Self-explanatory code
- ❌ Commented-out code (delete it)

---

## Pre-Commit Hooks

```bash
# Install hooks (runs automatically after npm install)
npm run prepare

# Manually run pre-commit checks
npx lint-staged
```

**Hooks Configured**:
- **commit-msg**: Validates commit message format (commitlint)
- **pre-commit**: Runs lint-staged on changed files

**lint-staged Checks**:
```json
{
  "*.ts": [
    "eslint --max-warnings=0 --no-warn-ignored",
    "vitest related --run"
  ],
  "package.json": [
    "npm run license-check"
  ]
}
```

---

## Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Descriptive variable names | Single letters (except i, j, k) |
| Keep functions small (< 50 lines) | 100+ line functions |
| Use type annotations | Skip types (`any` everywhere) |
| Follow naming conventions | Mix camelCase and snake_case |
| Use early returns | Deep nesting (> 3 levels) |
| Use optional chaining (`?.`) | Nested if checks for null |
| Use nullish coalescing (`??`) | OR operator for defaults |
| Prefer `const` over `let` | Use `var` |
| Use ES modules (`import`) | Use CommonJS (`require`) |
| Use async/await | Use callbacks or `.then()` |

---

## Code Quality Checklist

Before committing:
- [ ] ESLint passes with zero warnings (`npm run lint`)
- [ ] TypeScript compiles (`npm run build`)
- [ ] Tests pass (`npm test`)
- [ ] No console.log() left in code (use logger.debug())
- [ ] All imports have `.js` extensions
- [ ] Function return types are explicit
- [ ] No hardcoded secrets
- [ ] Comments explain "why" not "what"
- [ ] Code follows naming conventions

---

## TypeScript Configuration

### Key Settings

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist"
  }
}
```

**Important**:
- ES2022 target for modern Node.js features
- NodeNext module for ES modules support
- Strict mode enabled
- Declaration files generated for npm package

---

## References

- **ESLint Config**: `eslint.config.mjs`
- **TypeScript Config**: `tsconfig.json`
- **Lint-staged**: `package.json` lint-staged section
- **Husky Hooks**: `.husky/` directory
- **Style Guide**: This document

---
