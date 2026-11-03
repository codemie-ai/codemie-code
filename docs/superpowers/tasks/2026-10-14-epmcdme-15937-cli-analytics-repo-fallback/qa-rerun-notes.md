# QA re-run notes (2026-10-15)

Supersedes the failure notes in `gate-run.json` (unit / integration entries) and the `feature.verification` rationale in `decisions.jsonl`. Those files are generated, append-only run records and were left as written.

Commit under test: `dc88e6f7` (code) on `EPMCDME-15937_cli-analytics-repo-fallback`, clean working tree, all `CODEMIE_*` env vars unset.

| Project | Command | Result |
|---|---|---|
| unit | `npx vitest run --project unit` | PASS — 344 files, 5119 tests passed, 2 skipped |
| cli | `npx vitest run --project cli` | PASS — 37 files passed, 1 skipped; 278 tests passed, 10 skipped |
| agent | `npx vitest run --project agent` | NOT RUN — global setup could not install the Claude agent (`Command timed out after 300000ms`); no tests executed |

## What this changes in the earlier record

- `gate-run.json` unit FAIL (1 failure in `forwarder.test.ts`): attributed by the runner to an uncommitted local `forwarder.ts` edit. Not reproduced on a clean tree; unit passes.
- `gate-run.json` integration FAIL (cli project; 15 failures per the runner, 12 in a later run): not reproduced. The cli project passes on a clean tree with `CODEMIE_*` unset. Cause of the earlier failures is likely the environment (inherited `CODEMIE_*` variables, a loaded machine), but this was not proven.
- `decisions.jsonl` `feature.verification` rationale ("cli project 12 subprocess/timeout failures ... accepted") no longer applies: there are no known cli failures.

## Still open

- The `agent` project (`tests/integration/agent-*.test.ts`) is unverified because its setup needs network access to install an external agent.
