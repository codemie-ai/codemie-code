# ✅ GOOD CLAUDE.md SNIPPET EXAMPLE
# Score: ~27/30 pts (Grade A)
#
# ✅ R1.1: Coding standards defined (TypeScript section)
# ✅ R1.2: Workflow policies explicit (Git, Testing)
# ✅ R1.3: Critical rules with MANDATORY/NEVER + triggers
# ✅ R2.1: Actionable — starts with verbs (Use, Run, Add, Never)
# ✅ R2.2: Trigger conditions stated ("when user says", "for TypeScript files")
# ✅ R2.3: Explicit prohibitions with examples
# ✅ R3.1: Organized H2 sections
# ✅ R3.2: Quick-reference table
# ✅ R3.3: ✅/❌ pattern examples
# ✅ R4.2: Technology versions mentioned
# ✅ R4.3: Project context stated
#
# ⚠️ Minor gap: R4.1 — one minor contradiction possible (needs manual check)

---
# CLAUDE.md — Acme API Service

**Project**: REST API backend for Acme platform (Node.js 22, TypeScript 5.4)
**Team**: Platform Engineering

---

## ⚡ Task Classifier (Scan First)

| Keywords in request | Apply policy |
|--------------------|-------------|
| "commit", "push", "branch", "PR" | → Git Policy below |
| "test", "spec", "vitest" | → Testing Policy below |
| TypeScript, imports, types | → TypeScript Standards below |
| "deploy", "release", "build" | → Build Policy below |

---

## 🚨 Critical Rules (MANDATORY)

🚨 **NEVER commit to `main` directly.** Always use feature branches.

🚨 **NEVER use `--no-verify` on git hooks.** If a hook fails, fix the underlying issue first.

🚨 **NEVER write tests unless user explicitly asks.** Wait for "write tests", "add coverage", "create specs".

🚨 **ALWAYS use `.js` extensions in TypeScript imports.** TypeScript compiles to ESM. Missing extension = runtime crash.

---

## TypeScript Standards

**Imports** — ES modules only:
```typescript
✅ import { foo } from './utils.js'
✅ import type { Bar } from './types.js'
❌ import { foo } from './utils'          // missing .js extension
❌ const { foo } = require('./utils')     // CommonJS not allowed
```

**Types** — strict mode, no `any` shortcuts:
```typescript
✅ function process(input: unknown): Result { ... }
✅ const value = data as UserProfile       // explicit assertion
❌ function process(input: any) { ... }    // defeats type safety
```

**Async patterns**:
```typescript
✅ const result = await Promise.all([a(), b()])  // parallel where possible
❌ const r1 = await a()                           // sequential bottleneck
❌ const r2 = await b()
```

---

## Git Policy

**Branch naming**: `<type>/<description>` — e.g., `feat/add-oauth`, `fix/token-refresh`

**Commit format**: Conventional Commits:
```
feat(auth): add token refresh on 401 response
fix(api): handle null user in profile endpoint
chore: update eslint to v9
```

**PR requirements**:
- [ ] Branch is up to date with `main`
- [ ] All CI checks pass
- [ ] No `console.log` or debug code

**Never do**:
- ❌ `git push --force` to `main` (destructive, permanently loses history)
- ❌ `git commit --amend` on published commits (breaks teammates' history)

---

## Testing Policy

**MANDATORY**: Write tests ONLY when user explicitly says "write tests", "add coverage", "create unit tests".

**Never proactively write or suggest tests.**

Test commands:
```bash
npm test              # all tests
npm run test:unit     # unit only
npm run test:coverage # with coverage report
```

Framework: Vitest 4.x. All tests use dynamic imports for mocking (not static).

---

## Build Policy

**Node.js**: >= 22.0.0 required (`node --version`)
**npm**: bundled with Node — no yarn or pnpm
**Build output**: `dist/` (gitignored)

```bash
npm run build    # TypeScript → dist/
npm run lint     # ESLint (zero warnings required)
npm run ci       # Full pipeline: lint + build + test
```

**Before deploying**: All CI checks must pass. No bypassing.
