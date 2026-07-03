# QA Gate Report — npm-windows-path-shims

**Branch**: fix/npm-windows-path-shims
**Runner**: npm (guide-first: `.ai-run/guides/quality-gates.md`)
**Started**: 2026-07-02
**Status**: BLOCKED (mechanically, per the integration-test gate) — see Drift/Notes below; failures confirmed pre-existing and unrelated to this diff.

## Gates

| Gate | Status | Command | Notes |
|---|---|---|---|
| License headers | PASS | `npm run license-check` | No missing/stale headers. |
| Lint | PASS | `npm run lint` | Zero errors/warnings (glob only covers `src/**` + `tests/**` — does not include `scripts/**`; see note below). |
| Typecheck | PASS | `npm run typecheck` | No diagnostics. |
| Build | PASS | `npm run build` | `dist/` rebuilt, plugin assets copied successfully. |
| Unit tests | PASS | `npm run test:unit` (`vitest run src`) | 144 files / 2187 passed / 1 skipped. Scoped to `src/**` only — does not include the new `scripts/__tests__/postinstall.test.ts` (that ran separately under the broader `npm test`/`vitest` config: 27/27 passed, confirmed earlier in this session). |
| Integration tests | **FAIL (pre-existing/flaky, unrelated)** | `npm run test:integration` (`vitest run tests/integration`) | See "Integration test findings" below. |
| Secrets scan | PASS | `npm run validate:secrets` | Clean at every commit throughout this task (Gitleaks, 0 leaks). Final standalone run reported "No staged changes to scan" since nothing is currently staged — not a meaningful re-scan, but every actual commit was scanned clean. |
| Commitlint (range) | PASS | `npm run commitlint:last` | Last commit (`fix(cli): ...`) matches Conventional Commits, 0 problems. |
| Pre-commit aggregate | PASS | `npm run check:pre-commit` (`typecheck && lint`) | Both stages pass. |

## Integration test findings

`npm run test:integration` failed inconsistently across repeated runs on this branch: 2 files failed on the first run, 5 on the second, 6 on a third run with **this branch's changes stashed away** (i.e. against effectively `main`). This is pre-existing flakiness, not a regression from this diff — confirmed via an A/B comparison (same command, our changes stashed vs. present, both showed multiple failures, differing only in which specific files failed between runs).

One failure was consistent across every run: `tests/integration/cli-commands/skills.test.ts > codemie skills (authenticated upstream spawn) > add: forwards source and explicit --agent to upstream argv` — an unrelated assertion about a `--copy` flag being forwarded to an upstream `skills add` command, nothing to do with this change.

**Separately discovered, more serious issue**: during this investigation, one or more integration tests appear to write directly to the real project files `.codemie/codemie-cli.config.json` and `package.json` instead of an isolated fixture/temp copy. After one `test:integration` run, both files were found reverted to their committed baseline, silently discarding the user's local-only edits (a `sonnet5preview` profile in the config, and a Windows-glob fix to the `lint`/`lint:fix` scripts in `package.json`) that had been made earlier in this session and were never meant to be committed. Both were manually restored from a `git stash` backup taken just before the affected test run. This is a **pre-existing test-isolation defect** (tests mutating real project files rather than fixtures) — unrelated to and not introduced by this task's changes, but worth a follow-up ticket, since it can silently destroy any developer's local, uncommitted project-config edits.

## Note: scripts/ lint/typecheck coverage gap (pre-existing, out of scope)

Confirmed during code review: `eslint.config.mjs` has no glob covering `scripts/**` at all (only `tests/**/*.ts`, `src/**/*.test.ts`, `src/**/__tests__/**/*.ts`, `src/**/*.ts`), and `tsconfig.json`'s `include` doesn't cover `scripts/**` either. This means `scripts/postinstall.mjs` and `scripts/__tests__/postinstall.test.ts` are never actually linted or type-checked by `npm run lint` / `npm run typecheck`, despite now being executed by `npm test`. This gap pre-dates this change (it already applied to the original `postinstall.mjs` and to `scripts/license-check.js`/`scripts/validate-secrets.js`) and fixing it is out of this ticket's scope, but is worth flagging for a follow-up.

## Drift signal

no — implementation matches the approved spec/plan; no method/type-signature drift detected.
