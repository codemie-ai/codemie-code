# Quality Gates

Run order is fastest-to-slowest.

## Full runs

| Command | Covers | Source |
|---|---|---|
| `npm run ci` | license-check, lint, build, vitest unit, vitest cli | package.json::ci |
| `npm run ci:full` | commitlint HEAD~1..HEAD then npm run ci | package.json |
| `npm run check:pre-commit` | typecheck, lint | package.json |
| `npm run build` | tsc, tsc-alias, copy-plugin, bundle-statusline | package.json::build |
| `CI on pull_request (ci.yml)` | reusable secrets detection; npm ci; license-check; lint; build; vitest unit and cli on ubuntu-latest and windows-latest, Node 20 | .github/workflows/ci.yml |
| `PR Checks (pr-title-lint.yml)` | PR title commit-lint on PRs to main (reusable workflow) | .github/workflows/pr-title-lint.yml |

---

### license-check

**Run**: `npm run license-check`
**Side effects**: npx may fetch license-checker if not installed (network)
**Pass**: exit 0: every installed package licence is in the allowlist
**Fail**: non-zero exit; license-checker prints the disallowed packages

### lint

**Run**: `npm run lint`
**Pass**: exit 0, no errors or warnings
**Fail**: non-zero exit; ESLint lists files and rules
**Auto-fix**: npm run lint:fix

### type-check

**Run**: `npm run typecheck`
**Pass**: exit 0, no diagnostics
**Fail**: non-zero exit with file:line diagnostics

### secret-scan

**Run**: `npm run validate:secrets`
**Side effects**: pulls the gitleaks container image
**Pass**: exit 0: no findings, or no staged changes
**Fail**: gitleaks exit code on findings; exit 1 when no container engine and no skip variable
**Skip if**: CODEMIE_SKIP_SECRETS_SCAN=1 with no container engine (exit 0); empty staged diff (exit 0)

### test-unit

**Run**: `npx vitest run --project unit`
**Side effects**: writes logs under the temp CODEMIE_HOME
**Pass**: exit 0, all specs pass
**Fail**: non-zero exit; failing specs listed

### test-cli

**Run**: `npx vitest run --project cli`
**Side effects**: temp homes under the OS temp dir
**Pass**: exit 0
**Fail**: non-zero exit
**Skip if**: dist/ missing or stale (build first)
