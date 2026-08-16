# Remediation plan — review round 2

Report: `review-report-round-2.md` (verdict: APPROVE WITH MINOR FINDINGS)
Branch: `feat/pi-model-cost-sections` @ `c25430f`

## Scope check

**No drift.** Both findings land inside code this branch added:

- Finding 1 is about `vendoredPrice`, a helper introduced by `40f3282` as round-1 remediation.
- Finding 2 is about the same `docs/COMMANDS.md` cost-estimation section that `c25430f` edited — the paragraph was repointed, the refresh block three lines below it was missed.

The report also declined to file the two things that *would* have been drift, and said so:

| Item | Report's handling | Correct? |
|---|---|---|
| §7 inexact family / Claude-tier price matching (`gpt-5.7-codex` → `gpt-5-codex` rates) | "Known approved risk; no implementation defect filed" — changing it re-litigates the approved source strategy | Yes. `lookupPrice`'s matching policy is pre-existing and shared with analytics; the fence listed it as out of scope |
| §11 no committed test serializes through `fetchAndBuildPiModels` or loads Pi | Observation, not a severity-rated finding, because no present behavior is wrong | Yes. Also constrained by repo policy: tests only on explicit request |

Its "explicitly not reviewed" list matches the prompt's fence item for item.

One row to discount: the gate table calls the three-commit count a "prompt discrepancy". That is my error, not the reviewer's — `review-prompt-round-2.md` was written when the branch had two commits, then got swept into the third commit alongside the docs. Same root cause for its "untracked docs" claim. Covered by R3.

## Findings — both real, both reproduced

### Finding 1 (Minor) — an unreadable price table silently restores the original `$0` symptom

Confirmed by reading the logger rather than trusting the report:

- `logger.debug` (`src/utils/logger.ts:280-298`) puts **both** the console write and `writeToLogFile` inside `if (this.isDebugMode())`. Without `CODEMIE_DEBUG` the call is a complete no-op — it does not even reach the log file. The report understated this slightly; it is worse than "no console output".
- `pricing.ts` memoizes only on success (`TABLE = built` after the read, `src/utils/pricing.ts:36-56`), so a missing asset re-throws on **every** `lookupPrice` call — 44 throws and 44 discarded messages per launch.

Failure chain, all four links verified: asset absent → `vendoredPrice` returns `null` for every model → every field falls to `0` → the all-zero block is omitted → Pi normalizes to four zeros. Identical output to a genuinely free model, with nothing retained anywhere to distinguish them.

**My round-1 rationale for choosing `debug` was wrong on both counts**, exactly as the claims audit says (`remediation-plan.md:83`):

- "would otherwise print 44 warnings" — `logger.warn` (`logger.ts:309-312`) writes to the log file only, never to the console. It cannot print anything.
- "the visible symptom is already self-evident in Pi" — false. The symptom is `$0`, indistinguishable from correct behavior for a free model. That is the bug this task exists to fix.

The cardinality concern was still legitimate; the level was the wrong lever for it.

### Finding 2 (Nit) — stale asset path in the refresh instruction

`docs/COMMANDS.md:638` says `cost/pricing.json`; `docs/COMMANDS.md:617` says `src/utils/pricing.json`. The clean-build probe already proved the old directory is gone, so the refresh block sends a maintainer to a path that no longer exists.

Independently swept for others — `grep` for `cost/pricing`, `analytics/cost/pricing`, `analytics/model-normalizer` across `*.ts`/`*.js`/`*.json`/`*.md`, excluding `node_modules`, `dist/`, and closed task dirs: **line 638 is the only hit.** Confirms the report's "sole current, non-historical stale path".

## R1 — Record the price-table failure once, at a level that survives (required)

`src/agents/plugins/pi/pi.models.ts:144-158`. Add a module-scoped latch; drop the per-model message.

```ts
/** A missing price table is process-wide and permanent, so it is worth exactly one log line. */
let priceTableFailureLogged = false;

function vendoredPrice(id: string): ModelPrice | null {
  try {
    return lookupPrice(id);
  } catch (error) {
    if (!priceTableFailureLogged) {
      priceTableFailureLogged = true;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[pi-models] Model price table unavailable; models the CodeMie API does not price will be reported to Pi as free: ${message}`,
      );
    }
    return null;
  }
}
```

Four decisions worth defending:

1. **`warn`, not `debug`.** `warn` always reaches `~/.codemie/logs/debug-<date>.log`, so the diagnostic is retained — the report's stated requirement. It is also what `fetchAndBuildPiModels:338` already uses for the sibling degradation (live model fetch failed → static fallback), which is a *larger* loss of fidelity than this one. Matching it is the consistency argument.
2. **Not `error`.** Nothing failed for the user; the session launches normally. `logger.error` also only reaches the console under `CODEMIE_DEBUG`, so it buys no visibility over `warn` while overstating severity.
3. **No console output.** Reaching the terminal would need `console.warn` or `logger.success`, against `.ai-run/guides/standards/code-quality.md` and against writing to stdout during the handoff to the Pi TUI. The report's required correction is "record ... at a non-debug level", which `warn` satisfies. **Residual, stated plainly: the diagnostic lands in the log file, not in front of the operator.** Surfacing launch-time degradation in the terminal is a UX decision spanning every plugin, not something to invent inside this fix.
4. **Latch over plumbing.** The alternative — attempt the table once in `fetchAndBuildPiModels` and thread the result down — changes the exported signature of `convertLlmModelToPiEntry`, which `buildStaticFallbackModel` and the test suite both call directly. A refactor of the module's public surface to relocate one log line is not proportionate.

Message drops the model id: the failure is fleet-wide, and naming one arbitrary model implies otherwise.

Known wart: module state persists across tests in a file (no `vi.resetModules` in the suite). No existing test asserts on logging, so nothing breaks; a new test would need `vi.resetModules()` plus a dynamic re-import.

## R2 — Repoint the refresh block (required)

`docs/COMMANDS.md:638`: `` `cost/pricing.json` `` → `` `src/utils/pricing.json` ``. One token; matches line 617.

## R3 — Correct my own inaccurate artifacts (required)

The claims audit is right on every count, and both files are committed in this task directory where the next reader will trust them.

`review-prompt-round-2.md`:

- The branch-state section says two commits with the task docs untracked. Actual: three commits, docs committed in `c25430f`, clean tree. Restate as three commits and note the prompt shipped inside the commit it failed to mention.
- The rename check `git diff -M main..HEAD -- src/utils/pricing.ts src/utils/model-normalizer.ts` cannot show renames — its pathspec excludes the old paths, so both files render as pure additions and the "only import lines changed" expectation is unreachable. Replace with the form the reviewer had to derive:
  `git diff -M main..HEAD -- src/cli/commands/analytics/cost/pricing.ts src/utils/pricing.ts src/cli/commands/analytics/model-normalizer.ts src/utils/model-normalizer.ts`
  (reported `100%` similarity for `model-normalizer.ts`, `97%` for `pricing.ts`).

`remediation-plan.md`:

- Line 83: strike both wrong claims (`warn` "prints"; symptom "self-evident"), replace with the R1 finding and a pointer to this file.
- Line 176 "Nothing committed": annotate as point-in-time, superseded by the later explicit commit request. The report already classified it as such rather than as a discrepancy, so this is a clarity edit, not a correction.

## Proposed but not applied — needs your go-ahead

A unit test pinning warn-once (mock `lookupPrice` to throw for two models, spy on `logger.warn`, assert one call). Repo policy is tests only on explicit request; the round-1 suite exists because you asked for it. Say the word and it goes in the existing file.

## Declined

- **§7 inexact pricing.** Out of scope per the fence, and the report itself declined to file it. `lookupPrice`'s family/tier fallback is pre-existing behavior shared with analytics; tightening it changes the approved price-source strategy.
- **§11 permanent end-to-end coverage.** Recorded as an observation with no present defect. Would mean a new integration test that installs Pi and loads a generated file — a testing-strategy decision, and blocked by the same test policy.

## Order and verification

1. R1 (behavior), then R2, then R3 last so the artifacts describe what shipped.
2. `npm run typecheck && npm run lint` — zero warnings.
3. `npx vitest run --project unit src/agents/plugins/pi/__tests__/pi.models.test.ts` — 15 tests still pass unchanged. Then `npm run ci`.
4. **R1 probe.** With `dist/utils/pricing.json` moved aside (restore via trap), run `fetchAndBuildPiModels` over a multi-model payload with `CODEMIE_DEBUG` unset. Require: config written, launch proceeds, `cost` key absent, and **exactly one** `[pi-models] Model price table unavailable` line in `~/.codemie/logs/debug-<date>.log` — not 44, not 0. Round-2 baseline is 0 lines.
5. **Regression floor, unchanged from round 1.** Three-model harness must still yield `gpt-4.1` `{2,8,0.5,2}` and `claude-sonnet-5` `{3,15,0.3,3.75}`; the 44-model load must still be 34 priced / 10 unpriced / 0 dropped; `pi --list-models claude-sonnet-5` must still print the `codemie-anthropic` row. No remediation may move an ordinary price.
6. Scratch dirs under `/tmp/pi-r3-*` with exit traps; the repository's own `.pi/` stays read-only; the moved `dist` asset restored and SHA-verified.

No commits unless asked.

---

## Outcome

R1, R2 and R3 applied. The proposed warn-once unit test was **not** written — repo policy is tests
only on explicit request, and "apply fixes" was not one.

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run lint` | PASS, zero warnings |
| Focused suite `pi.models.test.ts` | 15/15 pass, unchanged — no test needed editing |
| `npm run ci` (license-check → lint → build → unit → integration) | PASS. Unit 208 files / 3068 tests; integration 29 passed 1 skipped / 205 passed 10 skipped |
| **R1 control** — asset present, isolated `CODEMIE_HOME` | 5 models converted, **5** cost blocks, **0** warn lines (no log file created at all) |
| **R1 probe** — asset moved aside, `CODEMIE_DEBUG` unset | 5 models converted, 0 cost blocks, **exactly 1** warn line in `<home>/logs/debug-*.log`. Round-2 baseline was 0 lines; a per-model log would have been 5 |
| R1 launch continuity | `fetchAndBuildPiModels` wrote the config and returned: `launch proceeds \| id: gpt-4.1 \| cost key present: false` |
| Asset restored | SHA-256 before == after: true |
| Regression — three-model end-to-end | `gpt-4.1` `{2,8,0.5,2}`, `claude-sonnet-5` `{3,15,0.3,3.75}`, unpriced four runtime zeros with no file-level `cost` key — **unchanged** |
| Regression — whole-file load | 44 generated, 34 priced, 10 unpriced, **44 loaded by Pi**, same 10 unpriced ids — **unchanged** |
| Regression — `pi --list-models claude-sonnet-5` | `codemie-anthropic` rows still printed |

The warn line as emitted, with `CODEMIE_DEBUG` unset:

```
[2026-08-16T00:29:06.016Z] [WARN] [system] [] [pi-models] Model price table unavailable; models the
CodeMie API does not price will be reported to Pi as free: ENOENT: no such file or directory, open
'.../dist/utils/pricing.json'
```

Probe hygiene: every scratch dir under `/tmp/pi-r3-*` with an exit trap; `CODEMIE_HOME` redirected
into the scratch dir so no probe touched the user's real `~/.codemie/logs`; the repository's own
`.pi/models.json` read only, as an id source; the moved `dist` asset restored and SHA-verified.

Nothing committed.
