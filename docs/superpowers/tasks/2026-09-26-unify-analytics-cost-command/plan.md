# Unify `codemie analytics` Cost Contract: Implementation Plan

> **For agentic workers:** implement task by task. Steps use `- [ ]` checkboxes. Commit per task using the repository's existing convention.

**Goal:** One always-costed `codemie analytics` contract (`--export [html|json|both]`, `-o`, `--open`), strict pricing resolution with no silent guessing, and agent-project tests that fail on unpriced models.

**Architecture:** `src/utils/pricing.ts` gains `canonicalizeModelId` and `resolvePrice`, and every caller uses them. `runAnalytics` always enriches cost and writes only `ReportPayload`. New tests live in `tests/integration/agent-*.test.ts`, the vitest `agent` project.

**Tech Stack:** TypeScript ESM (`.js` imports, `@/` alias), commander, Vitest.

**Spec:** `docs/superpowers/tasks/2026-09-26-unify-analytics-cost-command/spec.md`. Analysis: `technical-analysis.md` in the same dir.

## Global Constraints
- No deprecated aliases or warnings for removed flags. No CSV in any form.
- Models without a published price stay unpriced. Tests never fail on `estimatedModels`.
- The per-session exit report keeps its trigger, its location and `--no-analytics-report`, and ignores `-o`.
- Don't change `src/agents/plugins/claude/plugin/skills/codemie-analytics/`.
- New tests go in the `agent` project only, not `npm run ci`.

## Review Focus
1. `-o out/` when `out/` doesn't exist is a directory target, created recursively (Task 5 test).
2. `-o existing-dir` with no trailing slash is a directory target (Task 5 test).
3. `-o report.json --export both` produces `report.html` + `report.report.json` (Task 5 test).
4. A session with `hadLog:true` and zero usage must count as unpriced for T1/T2, not pass as $0 (Tasks 8, 9 assertions).
5. The Vertex id `claude-opus-4-6@20260205` resolves via the snapshot match (Task 1 test).

## Negative-constraint pass
- No family/tier fallback: Task 1 deletes it, and Task 2 keeps the statusline in parity.
- No CSV, no aliases: Task 6 deletes the flags outright.
- `-o` never falls back to home/tmp: Task 5.
- Exit report location unchanged: Task 6 leaves `session-report.ts` paths alone.
- Server-side skill untouched: no task edits it.
- Tests stay out of `ci`: Tasks 8-10 use the `agent-*` filename.
- No guessed prices: Task 1 adds rows only with a cited source.

---

### Task 1: Pricing canonicalization and `resolvePrice`
**Files:** Modify `src/utils/pricing.ts:148-219` (drop `claudeTierFallback` and the family match; rebuild `priceTable` at 175), `src/utils/model-normalizer.ts:25` (vendor-prefix stripping), `src/utils/pricing.json` (`"estimated": true` on the `claude-*-4-7`, `claude-*-4-8` and `claude-haiku-4-6` rows). Test: `src/utils/__tests__/pricing.test.ts`.
**Produces:**
```ts
export function canonicalizeModelId(model: string): string; // spec B steps 1-4
export interface PriceResolution { price: ModelPrice; key: string; match: 'exact' | 'snapshot'; estimated: boolean }
export function resolvePrice(model: string): PriceResolution | null;
// lookupPrice(model) keeps its signature: resolvePrice(model)?.price ?? null
```
`ModelPrice` gains an optional `estimated?: boolean`. `priceTable()` lowercases keys and turns dots into dashes. It throws when two keys collide with different prices. `CODEMIE_PRICES` still merges on top. The Bedrock regional premium applies as today.

Test-first: yes. The failing tests cover:
- `resolvePrice('gpt-5.5')` returns null.
- `claude-opus-6` returns null.
- `claude-opus-4-6-20260205` and `claude-opus-4-6@20260205` resolve to key `claude-opus-4-6` with `match:'snapshot'`.
- `gpt-4o-2024-05-13` gives an exact match.
- `openai.gpt-4o`, `azure/…`, `vertex_ai/…` and `…-vertex` canonicalize correctly.
- `glm-4.7` resolves.
- A colliding pair of keys with different prices throws, tested via an injected table.
- An estimated row reports `estimated:true`.

Update the existing fallback assertions to expect null.
- [ ] Write the failing tests and run `npx vitest run src/utils/__tests__/pricing.test.ts` (FAIL).
- [ ] Implement. Re-run (PASS). Also run `src/agents/plugins/pi/__tests__/pi.models.test.ts` and `cost-calculator.test.ts`, and fix any expectations that relied on a fallback.

### Task 2: Statusline `lookupRate` parity
**Files:** Modify `src/agents/plugins/claude/plugin/statusline.ts:424-` so it applies the same canonicalization plus the exact→snapshot→null order. This is plain JS with no imports from `src/`, so the logic is mirrored inline. Test: the existing statusline test beside it, or a new `__tests__/statusline-lookup.test.ts`.
Test-first: yes. The failing test asserts that `lookupRate(table, 'claude-opus-6')` is null and that `lookupRate(table, 'claude-opus-4-6@20260205')` equals the `claude-opus-4-6` rate.
- [ ] Write the test (FAIL), implement, re-run (PASS).

### Task 3: Cost domain on the resolver, `estimatedModels` surfaced
**Files:** Modify:
- `src/cli/commands/analytics/cost/types.ts:19` (`ModelCost.estimated?: boolean`) and `:203` (`CostSummary.estimatedModels: string[]`)
- `cost/cost-enricher.ts` (`priceUsage` calls `resolvePrice`, collects the estimated set, summary at ~513)
- `cost/dispatch-allocation.ts`, `cost/usage-readers.ts` and `src/agents/plugins/pi/pi.models.ts` (switch to `resolvePrice`/`lookupPrice`, handle null)
- `report/types.ts:94-118` (`ReportMeta.estimatedModels: string[]`)
- `report/payload-builder.ts` (copy `summary.estimatedModels`)

Tests: `cost/__tests__/cost-enricher.test.ts` and `report/__tests__/payload-builder.test.ts`.
**Produces:** `CostSummary.estimatedModels`, `ReportMeta.estimatedModels`, `ModelCost.estimated`.
Test-first: yes. The failing tests check two things:
- The enricher, run on usage for an `estimated:true` model, sets `perModelCost[0].estimated === true` and `summary.estimatedModels` contains it. An unknown `gpt-5.5` lands in `unpricedModels`.
- `buildPayload` copies `meta.estimatedModels`.
- [ ] Tests (FAIL), implement, re-run (PASS). `session-report.test.ts` also still passes.

### Task 4: OTEL path prices usage without `cost_usd`
**Files:** Modify `src/cli/commands/analytics/otel-loader.ts:128-182` (`buildCostIndex`). When an event has usage but no `cost_usd`, price it through `resolvePrice`. Add models that don't resolve to `unpricedModels` and estimated ones to `estimatedModels`. A present `cost_usd` stays authoritative. Test: `__tests__/otel-loader.test.ts`.
Test-first: yes. The failing test covers two events:
- An event with no `cost_usd` and model `gpt-5.5` yields `unpricedModels: ['gpt-5.5']`.
- An event with no `cost_usd` and model `claude-opus-4-6` yields a positive computed cost.
- [ ] Test (FAIL), implement, re-run (PASS).

### Task 5: Output target resolver (`-o` rules)
**Files:** Create `src/cli/commands/analytics/report/output-target.ts`. Test: `report/__tests__/output-target.test.ts`.
**Produces:**
```ts
export type ExportFormat = 'html' | 'json' | 'both';
export interface OutputTargets { html?: string; json?: string; isDefault: boolean }
export function resolveOutputTargets(format: ExportFormat, output: string | undefined, cwd: string, userEmail?: string): OutputTargets;
```
With no `output`, it returns the paths from `getDefaultReportPath`/`getDefaultReportJsonPath` and `isDefault:true`.

A **directory target** is a path that ends with `path.sep` or `/`, or one where `fs.statSync(...).isDirectory()`. Each requested format goes inside it under its default name.

Anything else is a **file target**:
- For `html`/`json` the path is used as given.
- For `both`, strip a trailing `.html`/`.json` and write `<base>.html` + `<base>.report.json`.

This module only computes paths; the caller creates directories.
Test-first: yes. The failing tests cover:
- no `-o` returns the default names;
- `tmp/new/` (missing) is a directory target;
- an existing dir without a slash is a directory target;
- `x.json` with `both` gives `x.html` + `x.report.json`;
- `x.json` with `json` gives `x.json`.
- [ ] Tests (FAIL), implement, re-run (PASS).

### Task 6: CLI contract. Always cost, one JSON schema, flags removed.
**Files:** Modify:
- `src/cli/commands/analytics/index.ts:57-62`: the options become `--export [format]` ('Write report: html (default), json, or both'), `-o, --output <path>` and `--open`. Delete `--report`, `--report-output` and `--report-format`.
- `index.ts:80-103`: `enrichCosts` always runs when the source gave no cost.
- `index.ts:119-` (export and report blocks):
  - Validate the format against `html|json|both`; anything else, csv included, prints the invalid-format error and sets `process.exitCode = 1`.
  - `--open` with no `--export` means `html`.
  - Get the paths from `resolveOutputTargets`.
  - With an explicit `-o`, run `fs.mkdirSync(dirname, {recursive:true})` and call `generateReport`/`generateReportJson` directly. A write failure throws with the path in the message.
  - Default paths keep `writeReportWithFallback`.
  - The email prompt stays, and runs only when `process.stdout.isTTY`.

Also delete `AnalyticsExporter.exportJSON`/`exportCSV` and the file writing in `exporter.ts`. Delete the file if nothing else remains and fix its imports. The options type drops the removed fields. Tests: `__tests__/analytics-cli-metadata.test.ts` and `src/cli/commands/__tests__/cli-misc-coverage.test.ts` (remove the exporter/RootAnalytics-file cases).
Test-first: yes. The failing tests in `analytics-cli-metadata.test.ts` assert that:
- `--report`, `--report-format` and `--report-output` are unknown options, via commander `parseAsync` with `exitOverride`;
- `--export csv` sets a non-zero `exitCode` and writes no file;
- a bare `--export` resolves to `html`;
- `runAnalytics` with a stub source and no export flags still calls `enrichCosts`.
- [ ] Tests (FAIL), implement, re-run the analytics `__tests__` dir and `cli-misc-coverage.test.ts` (PASS).

### Task 7: Terminal summary and HTML show cost, unpriced and estimated models
**Files:** Modify `src/cli/commands/analytics/formatter.ts`. Add `displayCost(summary: CostSummary)`, which prints the total cost, `priced/total` session coverage, `Unpriced models:` when non-empty and `Estimated models:` when non-empty. Call it from `index.ts` after `displayProjects`. The HTML report's existing unpriced-models notice (under `report/`, the view that renders `meta.unpricedModels`) also renders `meta.estimatedModels`. Test: `__tests__/formatter.test.ts` (create it if absent) and `report/__tests__/report-views.test.ts`.
Test-first: yes. The failing tests check that `displayCost` output contains `$`, `Priced sessions: 1/2` and both model lists, and that rendered HTML with `estimatedModels:['claude-opus-4-7']` contains that id.
- [ ] Tests (FAIL), implement, re-run (PASS).

### Task 8: Agent test T1, report shape against the golden fixture
**Files:** Create `tests/integration/agent-analytics-report-shape.test.ts`. It runs the built `bin/codemie.js` with `spawnSync` (no TTY) under an isolated `CODEMIE_HOME` whose config has `userEmail` set. The home is seeded from `tests/integration/metrics/fixtures/claude/` the way `tests/integration/analytics.test.ts` loads it; reuse its fixture-path setup. Run 1 is `analytics --export json -o <tmp>/out.json`. Run 2 is `analytics --export both -o <tmp>/nested/dir/`.
Test-first: yes. The failing test covers both runs:
- **Run 1:**
  - `meta.generatedAt`, `agents`, `totals.{sessions,totalCostUSD,pricedSessions,…}` (numbers), `coverage`, `unpricedModels` and `estimatedModels` all exist;
  - every session has `models`, `tokens`, `costUSD` and `perModelCost`;
  - `totalCostUSD > 0` and `unpricedModels` is `[]`;
  - no session has `hadLog && costUSD === 0`.
- **Run 2:** the new dir contains exactly one `.html` and one `.report.json`, both with default names.

It fails today because `--export json` writes `RootAnalytics`.
- [ ] Write the test, `npm run build`, `npx vitest run --project agent tests/integration/agent-analytics-report-shape.test.ts` (FAIL before Tasks 1-7, PASS after).

### Task 9: Agent test T2, live "hi" per catalog model
**Files:** Create `tests/integration/agent-analytics-live-models.test.ts` with `describe.runIf(process.env.SSO_AVAILABLE !== 'false')`.
- Fetch the models with `fetchCodeMieLlmModels(CI_CODEMIE_URL, creds)` (`src/providers/plugins/sso/sso.http-client.ts`), using the credential setup in `tests/helpers/test-env.ts`, and keep those with `enabled`.
- Map each model to an agent: `claude-*` → `codemie-claude`, `gpt-*`/`o<digit>*`/`*codex*` → `codemie-codex`, `gemini-*` → `codemie-gemini`. Log the skipped ids.
- Call `runAgentTaskSmoke({binName, model, prompt: 'hi'})` (`tests/helpers/agent-smoke.ts`) for each model in one shared isolated home, then run `analytics --export json -o <tmp>/live.json` there.
Test-first: yes. The failing test asserts, per run: a session whose `models` includes the model id (canonicalized) exists, has `costUSD > 0` and is not `hadLog` with zero cost. It also asserts that `meta.unpricedModels` is `[]`.
- [ ] Write it and run it with `--project agent` against SSO. If creds are absent it skips; record which.

### Task 10: Agent test T3, catalog reconciliation
**Files:** Create `tests/integration/agent-analytics-pricing-reconciliation.test.ts`, gated the same way as Task 9. It fetches the enabled catalog models and calls `resolvePrice(m.deployment_name)` for each one.
Test-first: yes. The failing test asserts that the unresolved list is `[]`, with the message `Unpriced catalog models: <ids joined by newline>`. Extra pricing.json rows are ignored. Add a pricing.json row only for a model whose published price has a cited source in `_meta.sources`/`note`, and leave the rest failing and visible.
- [ ] Write it and run it with `--project agent`. Report the unresolved ids rather than inventing rows.

### Task 11: Docs
**Files:** Modify `docs/ANALYTICS-REPORT.md` and the analytics section of `docs/COMMANDS.md`. Cover:
- the flag table and `-o` rules (spec A);
- one JSON schema (`ReportPayload`);
- cost always on;
- no CSV;
- the resolution order (spec B) and what `estimatedModels`/`unpricedModels` mean.

Remove every mention of `--report`, `--report-format`, `--report-output` and `--export csv`.
Test-first: no. This is documentation only.
- [ ] Edit, then `grep -n "report-format\|report-output\|--report\b\|csv" docs/ANALYTICS-REPORT.md docs/COMMANDS.md` returns nothing analytics-related.
