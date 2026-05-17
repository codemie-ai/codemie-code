# Quality Gates

## Gate Order

Run gates from fastest to slowest when validating locally. CI runs some jobs in parallel, but local troubleshooting is easier in this order.

This project treats linting guides as a primary guardrail. The local developer path should usually start with lint and typecheck before slower build and test gates.

### Commit Message Gate

**Run**: `npm run commitlint:last`

**Pass**: Commit messages in the checked range follow Conventional Commits with allowed types and optional scopes from `commitlint.config.cjs`.

**Fail**: Commitlint reports invalid type, invalid scope, missing type, or length violations. Fix the commit message or PR title to `type(scope): subject`.

**Auto-fix**: None.

**Skip if**: No git commit has been made yet. Validate the intended message manually with `echo "fix(proxy): example" | npx commitlint`.

### Lint Gate

**Run**: `npm run lint`

**Pass**: ESLint reports zero warnings for `src/**/*.ts` and `tests/**/*.ts`.

**Fail**: ESLint reports warnings or errors. The lint script uses `--max-warnings=0`, so warnings fail the gate.

**Auto-fix**: `npm run lint:fix`

**Skip if**: Only non-TypeScript documentation changed and no TypeScript files are affected.

ESLint configuration details:

| Rule Area | Behavior | Evidence |
|---|---|---|
| Test files matched first | Tests do not require project-aware parser config | `eslint.config.mjs:6` |
| Source files use type-aware linting | `parserOptions.project` points to `tsconfig.json` | `eslint.config.mjs:36` |
| `any` is allowed | `@typescript-eslint/no-explicit-any` is off | `eslint.config.mjs:25`, `eslint.config.mjs:58` |
| Unused vars warn | `_` prefix is ignored | `eslint.config.mjs:26`, `eslint.config.mjs:59` |
| Common JS imports warn | `@typescript-eslint/no-require-imports` is warn | `eslint.config.mjs:27`, `eslint.config.mjs:60` |
| JS/dist ignored | `dist/**`, `node_modules/**`, `**/*.js` ignored | `eslint.config.mjs:67` |

### Type-Check Gate

**Run**: `npm run typecheck`

**Pass**: TypeScript completes `tsc --noEmit` without diagnostics.

**Fail**: TypeScript reports missing imports, invalid types, module-resolution issues, or strict-mode errors.

**Auto-fix**: None.

**Skip if**: Only Markdown or workflow metadata changed and no TypeScript or package metadata changed.

### License Check Gate

**Run**: `npm run license-check`

**Pass**: Dependency licenses match the allowlist enforced by `scripts/license-check.js`.

**Fail**: A dependency has a disallowed, missing, or unrecognized license. Investigate the dependency before overriding.

**Auto-fix**: None.

**Skip if**: No dependency, lockfile, package metadata, or license-check script changed.

### Secret Scan Gate

**Run**: `npm run validate:secrets`

**Pass**: Gitleaks completes without detected secrets using `.gitleaks.toml`.

**Fail**: Gitleaks reports a suspected secret. Remove the secret, rotate it if it was real, and add a narrow allowlist only for verified false positives.

**Auto-fix**: None.

**Skip if**: Docker daemon is unavailable locally; CI runs Gitleaks on pull requests.

### Build Gate

**Run**: `npm run build`

**Pass**: TypeScript compilation, alias rewriting, and plugin copy complete and `dist/` is produced.

**Fail**: Build reports TypeScript errors, path alias issues, missing `.js` import extensions, or plugin-copy failures.

**Auto-fix**: None.

**Skip if**: Only Markdown files changed and package output is not affected.

Build details:

| Step | Source |
|---|---|
| TypeScript compile | `package.json:28` |
| Alias rewriting with `tsc-alias` | `package.json:28` |
| Plugin asset copy | `package.json:28`, `package.json:29` |
| Publish hooks reuse build | `package.json:50`, `package.json:51` |

### Unit Test Gate

**Run**: `npm run test:unit`

**Pass**: Vitest completes tests under `src` without failures.

**Fail**: A unit test fails, times out, or reports an unhandled error. Fix the code or update tests only when the changed behavior is intentional.

**Auto-fix**: None.

**Skip if**: The change is docs-only and no source, package, config, or test files changed.

### Integration Test Gate

**Run**: `npm run test:integration`

**Pass**: Vitest completes integration tests under `tests/integration` without failures.

**Fail**: An integration test fails, times out, or exposes a cross-module behavior regression.

**Auto-fix**: None.

**Skip if**: The change is docs-only, or the affected area has no integration behavior and a maintainer explicitly accepts the narrower gate set.

## CI Gate Mapping

| CI Job | Local Gate | Evidence |
|---|---|---|
| `validate-commits` | `npm run commitlint:last` or PR title commitlint | `.github/workflows/ci.yml:37`, `.github/workflows/ci.yml:66` |
| `secrets-detection` | `npm run validate:secrets` | `.github/workflows/ci.yml:104`, `scripts/validate-secrets.js:7` |
| `build` license step | `npm run license-check` | `.github/workflows/ci.yml:133`, `package.json:47` |
| `build` lint step | `npm run lint` | `.github/workflows/ci.yml:136`, `package.json:42` |
| `build` compile step | `npm run build` | `.github/workflows/ci.yml:139`, `package.json:28` |
| `test-ubuntu` | `npm run test:unit`, `npm run test:integration` | `.github/workflows/ci.yml:166`, `.github/workflows/ci.yml:169` |
| `test-windows` | `npm run test:unit`, `npm run test:integration` | `.github/workflows/ci.yml:195`, `.github/workflows/ci.yml:198` |

## Pre-Commit Gate Mapping

| Hook | Local Behavior | Evidence |
|---|---|---|
| `pre-commit` | Runs `lint-staged`, typecheck, and optional Docker-backed secret scan | `.husky/pre-commit:1`, `.husky/pre-commit:5` |
| `commit-msg` | Runs commitlint against the commit message file | `.husky/commit-msg:1` |
| `lint-staged` TypeScript | Runs ESLint and related Vitest tests for staged `.ts` files | `package.json:54` |
| `lint-staged` package metadata | Runs license check for `package.json` changes | `package.json:59` |

## Full Pipeline

**Run**: `npm run ci`

**Pass**: License check, lint, build, unit tests, and integration tests all pass in sequence.

**Fail**: Any included gate fails. Run the failing gate directly to shorten feedback.

**Auto-fix**: `npm run lint:fix` only for lint-fixable issues.

**Skip if**: Use targeted gates during iteration, but use the full pipeline before release-sensitive changes.

## Gate Selection Rules

| Change Type | Minimum Gates |
|---|---|
| TypeScript source | lint, type-check, build, relevant unit tests |
| Agent/provider/proxy behavior | lint, type-check, build, unit tests, integration tests |
| Dependencies or package metadata | license-check, build, unit tests, integration tests |
| Security-sensitive code | lint, type-check, build, secret-scan, unit tests, integration tests |
| CI/workflow changes | lint if scripts touch TypeScript, commitlint, workflow review, affected test gates |
| Documentation only | no runtime gate required unless docs reference commands or generated outputs |

## Local Versus CI Behavior

| Difference | Local | CI |
|---|---|---|
| Dependency install | Existing `node_modules` or `npm install` | `npm ci` |
| Secret scan | `npm run validate:secrets`, Docker required | Gitleaks GitHub Action |
| Tests | Run on request or when selected for validation | Unit and integration on Ubuntu and Windows |
| Build artifacts | Local `dist/` | Uploaded once, reused by test jobs |
| Commitlint | Hook and manual scripts | PR commit range plus PR title |

## Failure Triage

| Failing Gate | First Check | Common Fix |
|---|---|---|
| commitlint | Type and scope are allowed | Rewrite subject to `type(scope): subject` |
| lint | Warning count is nonzero | Run `npm run lint:fix`, then inspect remaining issues |
| typecheck | Import path or exported return type | Add `.js` extension or explicit return type |
| license-check | New dependency license | Replace dependency or confirm license policy |
| secret-scan | Token-like value in fixture or docs | Remove, rotate, or add justified allowlist |
| build | `tsc` or copy-plugin failure | Fix TypeScript first, then inspect plugin assets |
| unit tests | Focused source behavior | Run the failing file directly |
| integration tests | Cross-module behavior | Check config, paths, session storage, and platform assumptions |

## Evidence Sources

| Gate | Candidate Source Priority Used |
|---|---|
| lint | `package.json` script plus ESLint config |
| type-check | `package.json` script |
| build | `package.json` script and CI build job |
| license-check | `package.json` script and CI |
| secret-scan | Husky local hook, script wrapper, GitHub Action |
| commitlint | commitlint config, Husky hook, CI |
| tests | package scripts and CI Ubuntu/Windows jobs |

## Command Selection Anti-Patterns

| Avoid | Prefer |
|---|---|
| Running `npm test` when only unit scope is needed | `npm run test:unit` |
| Running secret scan without Docker and assuming it passed | Treat local skip as warning; rely on CI if Docker unavailable |
| Using `npx tsc` directly when package script exists | `npm run typecheck` |
| Running direct ESLint command with different globs | `npm run lint` |
| Forgetting license check for dependency changes | `npm run license-check` |
| Treating docs-only changes as requiring full runtime gates | Match gates to changed surface |

## References

| Topic | Path |
|---|---|
| npm scripts | `package.json` |
| ESLint config | `eslint.config.mjs` |
| TypeScript config | `tsconfig.json` |
| Vitest config | `vitest.config.ts` |
| Commitlint config | `commitlint.config.cjs` |
| GitHub CI | `.github/workflows/ci.yml` |
| Husky hooks | `.husky/pre-commit`, `.husky/commit-msg` |
| Secret scan wrapper | `scripts/validate-secrets.js` |
| License wrapper | `scripts/license-check.js` |
