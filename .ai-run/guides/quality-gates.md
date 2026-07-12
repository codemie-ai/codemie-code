# Quality Gates

Run order is fastest-to-slowest. Each gate is a real `npm run` script in `package.json:scripts`. CI runs the same gates in `npm run ci` and `npm run ci:full`.

---

### License headers

**Run**: `npm run license-check`
**Pass**: exits `0`; no missing or stale Apache-2.0 headers in `src/`.
**Fail**: prints offending files; CI rejects PRs that fail this gate.
**Auto-fix**: edit the offending file's header to match `scripts/license-check.js`; no automatic rewrite.

### Lint

**Run**: `npm run lint` (ESLint 9.x; `eslint '{src,tests}/**/*.ts' --max-warnings=0`)
**Pass**: zero errors, zero warnings.
**Fail**: lists files with errors/warnings; even one warning fails the gate.
**Auto-fix**: `npm run lint:fix` (same as `npm run format`).
**Skip if**: never.

### Typecheck

**Run**: `npm run typecheck` (`tsc --noEmit`)
**Pass**: no diagnostics.
**Fail**: TypeScript errors with file:line. Address every error — `// @ts-expect-error` is reviewed case by case.
**Auto-fix**: none.

### Build

**Run**: `npm run build` (`tsc && tsc-alias && npm run copy-plugin`)
**Pass**: `dist/` rebuilt; `npm run copy-plugin` (`scripts/copy-plugins.js`) succeeds.
**Fail**: TypeScript or path-alias error; missing plugin sources for `copy-plugin`.
**Auto-fix**: none — fix the underlying error.
**Skip if**: pure docs / `.ai-run/guides/` edits.

### Unit tests

**Run**: `npm run test:unit` (`vitest run src`)
**Pass**: all tests under `src/**/__tests__/` and `src/**/*.test.ts` pass.
**Fail**: Vitest prints failing specs with stack traces.
**Auto-fix**: none.
**Skip if**: never, unless the change is `.ai-run/guides/` or doc-only.

### Cross-platform CI (Windows)

CI runs a separate `test-windows` job (`.github/workflows/ci.yml`) using the same `npm run test:unit`/`test:integration` commands on `windows-latest`. GitHub's Windows runners default `core.autocrlf=true`, so any text file is checked out with CRLF unless `.gitattributes` forces LF. The repo's `.gitattributes` (`* text=auto eol=lf`) exists specifically to prevent this — without it, a `.mjs`/`.js` file starting with a shebang line (`#!/usr/bin/env node`) breaks Vite/Vitest's module transform with `SyntaxError: Invalid or unexpected token` when checked out with CRLF. See `src/agents/plugins/claude/plugin/statusline.mjs:1`.

**Local repro**: convert a file to CRLF (`perl -pi -e 's/\n/\r\n/ unless /\r\n$/' <file>`) and re-run `npx vitest run <its-test>` — this reproduces Windows-only CI failures without needing a Windows machine.

### Integration tests

**Run**: `npm run test:integration` (`vitest run tests/integration`)
**Pass**: all specs under `tests/integration/` pass.
**Fail**: Vitest output identifies the failing scenario; check `tests/integration/session/fixtures/` for snapshot drift.
**Auto-fix**: none.
**Skip if**: backend-only change with no integration coverage impact (rare; default to running).

### Secrets scan (optional, local-only)

**Run**: `npm run validate:secrets` (`node scripts/validate-secrets.js`, Gitleaks-backed)
**Pass**: no secrets detected.
**Fail**: lists matched files and rule IDs.
**Auto-fix**: remove the secret; add a `.gitleaksignore` rule only for confirmed false positives.
**Skip if**: Docker daemon is not running (`.husky/pre-commit` prints a hint and skips); CI runs the same scan unconditionally — do not rely on local skips.

### Commitlint (range)

**Run**: `npm run commitlint:last` (verifies `HEAD~1..HEAD`); CI uses `npm run ci:full` which calls the same.
**Pass**: every commit in the range matches Conventional Commits per `commitlint.config.cjs`.
**Fail**: prints the offending commit and rule.
**Auto-fix**: rewrite the commit message (`git commit --amend` or interactive rebase).

### Pre-commit aggregate

**Run**: `npm run check:pre-commit` (`typecheck && lint`)
**Pass**: both stages pass.
**Fail**: see Typecheck / Lint above.
**Auto-fix**: `npm run lint:fix` for lint issues; manual for typecheck.

### Full CI

**Run**: `npm run ci` (`license-check && lint && build && test:unit && test:integration`)
**Pass**: every above-listed gate passes in order.
**Fail**: stops at the first failing gate.
**Skip if**: never before merge.

---

## Hook integration

| Hook | Where | Runs |
|---|---|---|
| `pre-commit` (husky) | `.husky/pre-commit` | `lint-staged` → `npm run typecheck` → optional `validate:secrets` |
| `commit-msg` (husky) | `.husky/commit-msg` | `commitlint --edit` |
| Claude Code PostToolUse | `.claude/settings.json` | `npm run format` after every `Edit`/`MultiEdit`/`Write`/`Update` |
| Claude Code Stop | `.claude/settings.json` | `npm run check:pre-commit` at session end |

---

## Gate ordering rules

- Always run gates fastest-to-slowest, stop at the first failure, surface the failing command verbatim.
- `qa-lead` orchestrates these gates via the `automated-tests` skill and `ui-tests` skill (the latter only when changed files include `.tsx`/`.jsx`/`.css`/`.html` per `qa-lead/SKILL.md:44-51`).
- Never paste raw test output into PR descriptions — link to the failing log instead.
