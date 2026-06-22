# QA Gate Report — codex-explicit-model

**Branch**: feat/unified-headless-sessions  
**Runner**: npm (guide-first)  
**Started**: 2026-06-17  
**Status**: BLOCKED

## Gates

| Gate         | Status  | Command                         | Notes |
|---|---|---|---|
| license-check | PASS   | `npm run license-check`         | — |
| lint          | FAIL   | `npm run lint`                  | 65 errors in 5 files — all pre-existing, none in files changed on this branch |
| typecheck     | PASS   | `npm run typecheck`             | — |
| build         | PASS   | `npm run build`                 | dist/ rebuilt cleanly |
| unit          | PASS   | `npm run test:unit`             | 135 files, 2065 tests passed, 1 skipped |
| integration   | PASS   | `npm run test:integration`      | — |
| secrets       | PASS   | `npm run validate:secrets`      | 0 leaks found |
| commitlint    | PASS   | `npm run commitlint:last`       | 0 problems |
| ui            | SKIPPED | —                              | No UI surface changed |

## Failure detail

**Gate**: lint — `npm run lint` → exit 1

65 errors in 5 files, all pre-existing (not introduced by this branch):
- `compare-codex-conversations.mjs` — 32× `no-undef`
- `src/agents/plugins/claude/plugin/statusline.mjs` — 11× `no-undef`, 2× `no-empty`, 1× `no-constant-condition`
- `postinstall.mjs` — 9× `no-undef`
- `skills-sh-egress-guard.cjs` — 7× `no-undef`
- `prepare-install-artifacts.mjs` — 3× `no-undef`

**Confirmed pre-existing**: `git log origin/main..HEAD -- <all 5 files>` returns empty — none were modified on this branch.

**Our change is clean**: `npx eslint --max-warnings=0 <branch-changed TS files>` → exit 0, no issues.

## Drift signal

no
