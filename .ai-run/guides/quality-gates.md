# Quality Gates

Run order is fastest-to-slowest.

## Full runs

| Command | Covers | Source |
|---|---|---|
| `npm run ci` | license check, lint, build, unit tests, CLI integration tests | package.json::ci |
| `npm run ci:full` | commitlint on the last commit, then npm run ci | package.json |
| `npm run check:pre-commit` | typecheck and lint (the Claude Code Stop hook) | package.json |
| `GitHub CI on pull requests` | secrets detection, license check, lint, build, unit and CLI tests on Ubuntu and Windows; PR title commit-lint | .github/workflows/ci.yml |

---

### license-check

**Run**: `npm run license-check`
**Pass**: exit 0 (every dependency license in the allow list)
**Fail**: non-zero exit from license-checker naming the disallowed package

### lint

**Run**: `npm run lint`
**Pass**: exit 0, no errors and no warnings
**Fail**: non-zero exit; any ESLint error or warning
**Auto-fix**: npm run lint:fix

### type-check

**Run**: `npm run typecheck`
**Pass**: exit 0, no diagnostics
**Fail**: non-zero exit with TypeScript diagnostics

### secret-scan

**Run**: `npm run validate:secrets`
**Pass**: exit 0 from Gitleaks, or no staged changes
**Fail**: Gitleaks non-zero exit with findings; or exit 1 when no container engine is available
**Skip if**: CODEMIE_SKIP_SECRETS_SCAN=1 with no container engine (exit 0)

### build

**Run**: `npm run build`
**Side effects**: rewrites `dist/` (the `cli` test project and CI test jobs run against it)
**Pass**: exit 0; `dist/` rebuilt
**Fail**: non-zero exit from tsc, tsc-alias, copy-plugin or bundle-statusline

### test

**Run**: `npx vitest run --project unit && npx vitest run --project cli`
**Side effects**: creates a temp CODEMIE_HOME under the OS temp dir
**Pass**: both runs exit 0
**Fail**: non-zero exit with failing tests
