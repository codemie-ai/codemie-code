# Code Quality Standards

**Category**: Standards | **Complexity**: Simple | **Prerequisites**: TypeScript, ESLint, Node.js 20+

Quality-gate commands (lint, type-check, build, CI) are defined in `.ai-run/guides/quality-gates.md`. This guide covers coding standards only.

---

## Tools

| Tool | Purpose | Config |
|------|---------|--------|
| ESLint | Code quality & linting | `eslint.config.mjs` |
| TypeScript | Type checking | `tsconfig.json` |
| Husky | Git hooks | `.husky/` |
| lint-staged | Pre-commit checks | `package.json` |

---

## Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Variables / Functions | camelCase | `agentName`, `installAgent()` |
| Classes / Interfaces / Types | PascalCase | `AgentRegistry`, `AgentAdapter` |
| Constants | UPPER_SNAKE_CASE | `BUILTIN_AGENT_NAME` |
| Files | kebab-case.ts; a one-class file may be PascalCase | `session-config.ts`, `BaseAgentAdapter.ts` |
| Plugins | kebab.plugin.ts (agents, frameworks); kebab.template.ts (providers) | `claude.plugin.ts`, `sso.template.ts` |
| Tests | *.test.ts | `registry.test.ts` |

---

## Type Annotations

Rule: all exported functions need explicit return types; prefer `interface` over `type` for object shapes; `any` is allowed but document why; prefix unused vars with `_`.

| Do | Don't |
|----|-------|
| `async function getAgent(name: string): Promise<AgentAdapter \| undefined>` | Omit return type annotation |
| `interface ExecutionOptions { cwd?: string }` | Use inline type literals for shared shapes |
| `_unused: string` | Leave unused vars without `_` prefix |

Reference: `src/agents/registry.ts::AgentRegistry.getAgent`

---

## Imports

Rule: always use `.js` extension (ES modules); use `import type` for type-only imports; group Node built-ins → third-party → local; no wildcard or `require()` imports. Known debt, to fix: `import * as` is used for Node built-ins (`import * as path from 'path'`) and spied modules (`import * as npm from '../../utils/processes.js'`) in non-test files.

```typescript
// src/agents/plugins/claude/claude.plugin.ts::ClaudePlugin (file header)
import type { AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { writeConfigToTempFile } from '../../core/temp-config.js';
```

| Do | Don't |
|----|-------|
| `import { x } from './file.js'` | `import { x } from './file'` |
| `import type { T }` | Import types as values |
| ES module `import` | `require()` / CommonJS |

---

## ESLint Configuration

Key rules (`eslint.config.mjs::rules`, the `src/**/*.ts` block; test files have their own block):

| Rule | Setting | Reason |
|------|---------|--------|
| `@typescript-eslint/no-explicit-any` | off | Allow `any` when needed |
| `@typescript-eslint/no-unused-vars` | warn | Prefix with `_` if intentional |
| `@typescript-eslint/no-require-imports` | warn | Prefer ES modules |
| `no-undef` | off | TypeScript handles this |
| `no-useless-catch` | warn | Avoid catch-and-rethrow |
| `no-case-declarations` | warn | Use blocks in case statements |

---

## TypeScript Configuration

Key settings (`tsconfig.json`):

- `"target": "ES2022"` — modern Node.js features
- `"module": "NodeNext"` — ES modules support
- `"strict": true` — strict mode enabled
- `"declaration": true` — generates `.d.ts` for npm package
- `"outDir": "./dist"`

---

## Code Structure Guidelines

**Functions**: under 50 lines; one responsibility; max 4–5 parameters; use destructuring for multiple params.

**Files**: under 500 lines; one main export per file; co-locate related functionality. Known debt, to fix: `src/utils/config.ts`, `src/cli/commands/hook.ts`, `src/agents/core/BaseAgentAdapter.ts`, `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts`, `src/providers/plugins/sso/proxy/plugins/mcp-auth.plugin.ts` and other modules over 500 lines.

**Classes**: Single Responsibility; prefer composition over inheritance; use dependency injection.

---

## Comments & Documentation

Rule: comment the *why*, not the *what*; JSDoc on all public APIs; delete commented-out code.

| Do | Don't |
|----|-------|
| JSDoc on exported functions with `@throws` | Omit docs from public API |
| Explain non-obvious decisions / workarounds | `// Set name to 'claude'` before `const name = 'claude'` |
| Explain complex algorithms inline | Leave commented-out dead code |

---

## Pre-Commit Hooks

Hooks run automatically via Husky (`.husky/`) after `npm install` / `npm run prepare`.

- **commit-msg**: validates commit message format (commitlint)
- **pre-commit**: runs lint-staged on changed `.ts` files and `package.json`

lint-staged config (`package.json` lint-staged section):
- `*.ts` → `eslint --max-warnings=0 --no-warn-ignored` + `vitest related --run`
- `package.json` → `npm run license-check`

---

## Best Practices

| Do | Don't |
|----|-------|
| Descriptive variable names | Single letters (except `i`, `j`, `k`) |
| Functions < 50 lines | 100+ line functions |
| Explicit type annotations | Skip types / `any` everywhere |
| Early returns | Deep nesting (> 3 levels) |
| Optional chaining `?.` and `??` | Nested null checks |
| `const` over `let` | `var` |
| `async`/`await` | Callbacks or `.then()` chains |
| `logger.debug()` | `console.log()` for debug output |

---

## Pre-Commit Checklist

- ESLint passes with zero warnings
- TypeScript compiles without errors
- No `console.log()` left in code. Known debt, to fix: CLI commands print user output with `console.log` (e.g. `src/cli/commands/shared/helpers.ts::enableVerboseLogging`)
- All imports have `.js` extensions
- Function return types are explicit
- No hardcoded secrets
- Comments explain "why" not "what"
- Naming conventions followed

---

## References

- ESLint config: `eslint.config.mjs`
- TypeScript config: `tsconfig.json`
- Lint-staged: `package.json` lint-staged section
- Husky hooks: `.husky/` directory
- Quality-gate commands: `.ai-run/guides/quality-gates.md`
