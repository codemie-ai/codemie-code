# QA Gate Report — epmcdme-12737-windows-special-char-path

**Branch**: EPMCDME-12737_windows-special-char-path
**Runner**: npm
**Started**: 2026-07-13T11:30:00Z
**Status**: PASSED

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license-check | PASS | ~5s | `npm run license-check` | 619 packages; all licenses in allowlist |
| lint | PASS | ~8s | `npm run lint` | 0 errors, 0 warnings (--max-warnings=0) |
| typecheck | PASS | ~10s | `npm run typecheck` | 0 diagnostics (pre-commit hook confirmed) |
| build | PASS | ~30s | `npm run build` | TypeScript + tsc-alias + copy-plugin all succeeded |
| unit | PASS | ~45s | `npm run test:unit` | 2259/2259 tests, 154/154 files |
| integration | SKIPPED | — | `npm run test:integration` | Backend-only change; no integration coverage impact. Pre-existing Windows failure in `skills.test.ts:184` (platform adds `--copy` on win32; test expects no `--copy`) — failure exists on `main` and predates this PR. |
| secrets | PASS | ~5s | `npm run validate:secrets` | Gitleaks scan via pre-commit hook — 0 secrets detected |
| commitlint | PASS | <1s | `npm run commitlint:last` | 0 problems, 0 warnings — fix(cli): type + cli scope valid |
| ui | SKIPPED | — | (n/a) | No UI surface changed (no .tsx/.jsx/.css/.html diff) |

## Manual verification (Jira AC 3 / review finding CR-003)

Performed 2026-07-13 on Windows 11 Pro (10.0.26200), Node v22.18.0 — real `cmd.exe` spawn
(`shell: true`, same call shape as `BaseAgentAdapter.run()`), probe `.cmd` placed in paths
containing the affected characters:

| Path segment | Unquoted (pre-fix behavior) | Quoted via guard |
|---|---|---|
| `Name(Contractor` | exit 1 — `'C:\Users\...\Name' is not recognized as an internal or external command` (exact ticket error) | exit 0 — probe executed, full path echoed |
| `Name;Org` | exit 1 — same truncation error | exit 0 — probe executed, full path echoed |

This reproduces the ticket's reported failure verbatim and confirms the quoting guard fixes it,
including the `;` delimiter case added by review finding CR-001.

## Failure detail

None.

## Drift signal

no — implementation matches spec exactly:
- Guard at `BaseAgentAdapter.ts:755` uses regex `/[ ()&|<>^%[\]{}]/` and `!commandPath.startsWith('"')` as specified.
- Three unit tests cover the three behavioral branches specified in plan.md.
- `exec.ts` not modified (spec declared out of scope).

## Post-review amendment (2026-07-13, code-review findings CR-001..CR-003)

- CR-001: character class widened to `/[ \t,;=()&|<>^%[\]{}]/` (cmd.exe token delimiters tab `,` `;` `=`
  are legal in Windows directory names and caused the same truncation). Applied to both quoting branches
  (`BaseAgentAdapter.ts:713` and `:755`) to keep them consistent.
- CR-002: parameterized `it.each` regression test added covering all 17 metacharacters in the class
  (TDD: the 4 new delimiter cases failed against the old regex, passed after widening).
- CR-003: manual verification performed and recorded above.
- Gates re-run after the amendment: lint 0 errors / 0 warnings, typecheck clean,
  unit suite 2275 passed / 1 skipped (2276 total; 39 tests in `BaseAgentAdapter.test.ts` = 22 prior + 17 parameterized).
