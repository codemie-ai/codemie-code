# QA Gate Report — 2026-08-11-epmcdme-14072-extend-the-codemie-cli-s-managed-mcp

**Branch**: EPMCDME-14072_managed-mcp-oauth-config (HEAD `ff130d8`)
**Merge base**: main
**Runner**: npm
**Started**: 2026-08-11T20:55:20+02:00
**Status**: PASSED

Changed files vs `main` (6, all TypeScript, no UI surface):

```
src/cli/commands/proxy/index.ts
src/cli/commands/proxy/connectors/desktop.ts
src/cli/commands/proxy/connectors/managed-mcp-remote.ts
src/cli/commands/proxy/__tests__/index.test.ts
src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts
```

## Gates

| Gate | Source | Status | Duration | Command | Notes |
|---|---|---|---|---|---|
| license-check | guide | PASS | 7s | `npm run license-check` | Dependency license inventory produced (111 Apache-2.0, 32 ISC, ...); no policy violations |
| lint | guide | PASS | 9s | `npm run lint` | ESLint 9.39.1, `--max-warnings=0`, zero output |
| typecheck | guide | PASS | 5s | `npm run typecheck` | `tsc --noEmit`, no diagnostics |
| build | guide | PASS | 8s | `npm run build` | `tsc && tsc-alias && copy-plugin`; plugin assets copied |
| unit | guide | PASS | 11s | `npm run test:unit` | 198 files passed; 2985 passed, 1 skipped |
| integration | guide | PASS | 22s | `npm run test:integration` | 29 files passed, 1 file skipped; 214 passed, 1 skipped. Skipped file is `tests/integration/vscode-models.live.test.ts`, gated on `CODEMIE_VSCODE_LIVE=1` — pre-existing, unrelated to this diff, and skipped in CI too |
| commitlint-last | guide | PASS | 1s | `npm run commitlint:last` | `HEAD~1..HEAD`: 0 problems, 0 warnings |
| secrets | guide + hook | SKIPPED | 0s | `npm run validate:secrets` | Self-skipped: `"No staged changes to scan"`. Docker **is** running; `scripts/validate-secrets.js:87` scans `git diff --staged` only, and the working tree is clean (all work committed). Enable locally by staging the diff (`git add -A`) before running, or by scanning the range/tree directly. CI runs `gitleaks-action` unconditionally, so this check is still owed to CI |
| affected | hook (lint-staged) | PASS | 4s | `npx vitest related --run --exclude 'tests/integration/agent-*.test.ts' --exclude 'tests/integration/cli-commands/models.test.ts' <changed .ts>` | 3 files passed; 116 passed, 1 skipped. Same command lint-staged runs on staged `*.ts` |
| hook-eslint | hook (lint-staged) | PASS | 3s | `npx eslint --max-warnings=0 --no-warn-ignored <changed .ts>` | Zero findings; subset of the `lint` gate |
| ci-commitlint-range | ci | PASS | 1s | `npx commitlint --from main --to HEAD --verbose` | Full PR range (11 commits): every commit 0 problems, 0 warnings. Broader than the guide's `commitlint:last`, which only covers `HEAD~1..HEAD` |
| ci-gitleaks | ci | N/A | — | `gitleaks/gitleaks-action@v2` (`.github/workflows/ci.yml` `secrets-detection`) | Requires GitHub Actions PR context and `GITHUB_TOKEN`; not reachable locally. Local counterpart (`secrets`) self-skipped — only CI can settle this one |
| ci-pr-title | ci | N/A | — | `echo "$PR_TITLE" \| npx commitlint --verbose` | Needs a PR title; no PR exists yet. Whoever opens the MR must use a Conventional Commits title |
| ci-test-windows | ci | N/A | — | `npm run test:unit` + `npm run test:integration` on `windows-latest` | Needs a Windows runner. Risk is low for this diff: `.gitattributes` (`* text=auto eol=lf`) is in place and the diff touches only `.ts` files, no shebang `.mjs`/`.js` |
| ui | guide | SKIPPED | — | (n/a) | No UI surface changed — diff matches no `ui_globs` entry. `package.json:scripts.test:ui` is Vitest's interactive UI (`vitest --ui`), not a browser suite. This is a green outcome |

Aggregate scripts `npm run check:pre-commit` (`typecheck && lint`) and `npm run ci` / `ci:full` were not re-run: every gate they chain ran individually above and passed.

## Guide vs repository mismatch

`.ai-run/guides/quality-gates.md` documents `test:unit` as `vitest run src` and `test:integration` as `vitest run tests/integration`. `package.json` now defines them as `vitest run --project unit` and `vitest run --project cli`. The **Run** fields (script names) are unchanged, so the gates ran verbatim; only the guide's parenthetical descriptions are stale. Worth a guide refresh — the repo, not the guide, is authoritative.

The guide also describes `license-check` as an Apache-2.0 header check over `src/`; the script's actual output is a dependency license inventory. Gate passed either way.

## Failure detail (if any)

None. No gate failed.

Two runs in this session produced misleading output from shell quoting on the runner side, not from the code under test, and were re-run correctly before being recorded:

- `vitest related` invoked with an unquoted `tests/integration/agent-*.test.ts` exclude: zsh expanded the glob, so 8 agent specs became positional test targets and `tests/integration/agent-model.test.ts` failed on missing metrics fixtures. That suite is the `agent` project, which CI never runs on PRs.
- A changed-file list passed as `$FILES`: zsh does not word-split unquoted expansions, so ESLint and Vitest each received one concatenated pseudo-path (`No files matching the pattern`, `No test files found`). Re-run through `xargs`, both pass.

## Drift signal

no

Every identifier the spec references still resolves in `src/`: `mergeManagedMcpServers`, `collidesWithManagedEntry`, `displacedDefaults`, `keptDefaults`, `seededDefaultCount`, `ManagedMcpServerEntry`.

## Outstanding for CI

`PASSED` here means nothing local blocks this branch — not that CI will be green. Still unsettled:

1. **Secrets scan** — never actually executed locally (no staged changes). CI's `gitleaks-action` scans for real.
2. **Windows test job** — unexecutable locally.
3. **PR title** — must satisfy Conventional Commits when the MR is opened.
