# Spec: One always-costed `codemie analytics` contract, correct pricing resolution, and cost guard tests

## Problem

`runAnalytics` (`src/cli/commands/analytics/index.ts:82-103`) only computes cost when a report flag is present. So `codemie analytics`, `--export json` and `--export csv` never carry cost. `--export json` also writes a second schema (`RootAnalytics`, `exporter.ts`), which differs from the `ReportPayload` used by `--report-format json` and the session-exit report. Several flags do the same job. The OTEL path hard-codes `unpricedModels: []` (`otel-loader.ts`).

Separately, `lookupPrice` (`src/utils/pricing.ts:192-219`) prices unknown models silently in two ways:
- **Wrong-model family match.** `gpt-5.5` and `gpt-5.6` resolve to `gpt-5` ($1.25/$10), below the table's own `gpt-5-4` ($2.5/$15).
- **Claude tier guess.** The assumption that a tier's price stays flat was wrong for Sonnet 5 and for Opus 4.1→4.5.

Neither case appears in `unpricedModels`. Dotted keys (`glm-4.7`, `minimax-m2.5`, `gemini-3.7-flash`) can never be matched. The rows the pricing.json notes call "tier estimates" (`claude-*-4-7`, `claude-*-4-8`, `claude-haiku-4-6`) are indistinguishable from published prices.

## Goals

1. Every analytics output path computes cost, and there is one flag per capability.
2. A model is either priced correctly through a documented normalization, or reported as unpriced. There is no silent guessing.
3. Agent-project tests fail when any observed or catalog model is unpriced.

## Design

### A. CLI contract (maximum compatibility, duplicates removed)

| Capability | Surviving flag | Removed duplicate |
|---|---|---|
| Write the report file | `--export [format]`: `html` (default when bare), `json` or `both`. `--export json` keeps its familiar name but now writes the costed `ReportPayload` | `--report`, `--report-format` |
| Target file or directory | `-o, --output <path>` (rules below) | `--report-output` |
| Open in browser | `--open` (implies `--export html` when no `--export` is given; `--open --export json` prints the existing "no HTML produced" notice) | none |
| CSV | none | `--export csv` (dropped; `csv` is rejected as an invalid format) |

**`-o, --output <path>`**, the one flag for choosing where files go:
- With no `-o`, files go to the current directory under the default names, exactly as today. That is `codemie-analytics-[<email-slug>-]<YYYY-MM-DD>.html` / `.report.json` from `getDefaultReportPath`/`getDefaultReportJsonPath`, and the home/tmp fallback in `writeReportWithFallback` still applies.
- **Directory target.** The path ends with a path separator, or it names an existing directory. Each requested format is written inside it under its default name, so `both` produces the `.html` and the `.report.json` side by side.
- **File target.** Anything else. For `html` or `json` the path is used as given. For `both` a trailing `.html`/`.json` is stripped and `<base>.html` plus `<base>.report.json` are written.
- A missing target directory or parent directory is created recursively. An explicit `-o` never falls back to home/tmp; a write failure is a hard error with the path in the message.

**Also in this contract:**
- `-o <path>` with no `--export`/`--open` also implies an export; the format is inferred from the path (a `.json` path → `json`, otherwise → `html`).
- An invalid `--export` value (e.g. `csv`) is rejected with a non-zero exit before any sessions are loaded, even when the filtered result set would otherwise be empty.
- The filter flags, `-v`, `--no-scan-native`, `--include-external`, and `otel`'s `--file`/`--user` are unchanged.
- Removed flags are deleted outright, so commander rejects them as unknown.
- Cost enrichment always runs (both the `else if (wantReport)` gate and the `wantReport && costResult` gate go).
- The terminal summary always shows total cost, priced-session coverage, and any unpriced or estimated models.
- The only JSON file schema is `ReportPayload`. `AnalyticsExporter.exportJSON/exportCSV` and the `RootAnalytics` file output are removed. `RootAnalytics` stays as an internal aggregation type.
- `analytics otel` stays a subcommand under the same contract. `cost_usd` remains authoritative. Any event model with usage but no `cost_usd` is priced through the resolver (section B), and models that still don't resolve are listed in `unpricedModels`.
- The session-exit report (`session-report.ts`) already produces a costed `ReportPayload`. It picks up the new resolver and the new metadata fields with no flag change.

### B. Pricing resolution (`src/utils/pricing.ts`)

**Table build.** Every key is lowercased and dots become dashes. If two keys collide after that (e.g. `gemini-3.7-flash`/`gemini-3-7-flash`), they must hold identical prices; otherwise the build throws. `CODEMIE_PRICES` stays merged over the vendored rows.

**Canonicalization** of an observed id, in order. This extends `normalizeModelName` and is one exported function used by both analytics and reconciliation:
1. Strip a Bedrock `converse/` or `bedrock/` prefix (including the two stacked together as `bedrock/converse/`), the `<region>.anthropic.` prefix, and the `-v<N>:<N>` suffix. This already exists.
2. Strip the vendor path prefixes `kimi-code/` (exists), `openai.`, `openai/`, `azure/`, `vertex_ai/`, `anthropic/`, and the dot-form `moonshotai.` and `qwen.` (e.g. `moonshotai.kimi-k2.5`, `qwen.qwen3-coder-480b-a35b-v1`).
3. Lowercase the id, turn dots into dashes, and turn `@` into `-`, so Vertex's `claude-x@20260205` gets the same form as a dated id.
4. Strip the `-vertex` suffix.

**Lookup order:**
1. Exact match on the step-4 id. This keeps distinct dated rows, e.g. `gpt-4o-2024-05-13`.
2. Exact match after stripping one trailing snapshot suffix: `-YYYYMMDD`, `-YYYY-MM-DD`, `-latest` or `-preview`.
3. A version-first Claude id (`claude-<ver>-<family>`, e.g. `claude-4-5-sonnet`) reordered to the table's family-first form (`claude-<family>-<ver>`, e.g. `claude-sonnet-4-5`) and tried the same way — exact, then with one trailing snapshot suffix stripped — only after steps 1-2 have already failed on the id as observed. Reported as `match: 'reordered'`. This maps onto an existing published row under its other spelling; it is not a family/tier guess.
4. Otherwise **unpriced (null)**.

The segment-boundary family match and `claudeTierFallback` are removed. The Bedrock regional premium (`applyBedrockRegionalPremium`) is applied as today.

**Provenance.** A new export states how each model was priced, and `lookupPrice` keeps its current signature on top of it:

```ts
export interface PriceResolution { price: ModelPrice; key: string; match: 'exact' | 'snapshot' | 'reordered'; estimated: boolean }
export function resolvePrice(model: string): PriceResolution | null;
```

A price-table build collision (two raw keys normalizing to the same table key with different prices) throws `ConfigurationError`.

**Estimates.** pricing.json rows accept an optional `"estimated": true`. The current tier-estimate rows are marked with it. Every newly added row must cite its source in `_meta.sources`/`note`. Rows are added only for models whose published price can be verified. Any model without one stays unpriced so that it is visible.

**Report surfacing.**
- `ReportMeta` gains `estimatedModels: string[]`.
- `ModelCost` gains `estimated?: boolean`.
- `unpricedModels` also covers models that previously slipped through a fallback.
- The HTML report and the terminal summary show both lists.

**Callers.** `cost-enricher.ts`, `dispatch-allocation.ts` and `pi.models.ts` go through the resolver. They already handle `null`. The Claude statusline's `lookupRate` (`src/agents/plugins/claude/plugin/statusline.ts:424-`) documents itself as mirroring `lookupPrice`, so it adopts the same resolution order.

### C. Tests (all new tests in the vitest `agent` project; existing unit tests updated for the new behavior)

- **T1: report shape.** Runs the built CLI non-interactively (no TTY, email configured, isolated `CODEMIE_HOME`) with `analytics --export json -o <tmp>/out.json` against the golden Claude fixture (`tests/integration/metrics/fixtures/claude/`). It asserts:
  - `meta` fields exist: `generatedAt`, `agents`, the `totals.*` numbers, `coverage`, `unpricedModels` and `estimatedModels`;
  - each session has `models`, `tokens`, `costUSD` and `perModelCost`;
  - `totals.totalCostUSD > 0`;
  - `unpricedModels` is empty;
  - no session has `hadLog: true` while unpriced.

  A second invocation, `--export both -o <tmp>/nested/dir/`, targets a directory that doesn't exist yet. It asserts the directory is created and holds exactly the default-named `.html` and `.report.json`.
- **T2: live tool-forcing prompt per model.** Fetches the enabled models from `fetchCodeMieLlmModels` (`/v1/llm_models`). Each model runs through its compatible agent via `runAgentTaskSmoke` (`tests/helpers/agent-smoke.ts`), driven by an explicit tool-forcing prompt (not a plain "hi") so every run reliably produces billable tool-call usage: `claude-*` → claude, `gpt-*`/`o*`/`*codex*` → codex, `gemini-*` → gemini. Models with no compatible agent are skipped and listed. A documented `EXCLUDED_MODEL_IDS` map (per-id reason, e.g. a reproduced upstream LiteLLM 400 or an id the agent silently substitutes/rejects) further exempts a handful of catalog ids from the cost assertion below — never a silent skip: each exclusion is logged with what that run actually observed, so a since-fixed upstream/agent issue doesn't hide forever. The test then runs `analytics --export json` over that home and asserts, per non-excluded run:
  - the session is present and its model is listed;
  - the session is priced, with `costUSD > 0`;
  - `unpricedModels` is empty.
- **T3: reconciliation.** Every enabled catalog model (`deployment_name`) must resolve through `resolvePrice` to any non-null result — an exact, snapshot, or reordered match (section B's lookup order). The failure message lists every unresolved id. Extra pricing.json rows are ignored.
- **Existing tests updated:** `src/utils/__tests__/pricing.test.ts`, which covers the canonicalization cases, the removed fallbacks, dotted keys and the collision check. Also the cost-enricher, otel-loader, payload-builder, analytics-cli-metadata and `cli-misc-coverage` tests, where they touch the removed flags or `RootAnalytics` export.

### D. Docs

Update `docs/ANALYTICS-REPORT.md` and `docs/COMMANDS.md` to the flag table and `-o` rules above, one JSON schema, always-on cost, and the resolution rules and meaning of `estimatedModels`.

## Acceptance criteria

- **AC1.** A plain `codemie analytics` run prints total cost and priced coverage. Every file output carries cost.
- **AC2.** `--report`, `--report-format` and `--report-output` are rejected as unknown options. `--export [html|json|both]` (bare = `html`), `-o` and `--open` cover every capability they provided. `--export csv` is rejected as an invalid format.
- **AC3.** `--export json` writes a costed `ReportPayload`, the only JSON schema `codemie analytics` writes. No `RootAnalytics` file and no CSV are produced.
- **AC4.** `analytics otel` accepts the same flags. Its `unpricedModels` lists models without `cost_usd` that the resolver can't price.
- **AC5.** `resolvePrice` resolves only through the canonicalization and lookup order in section B (exact → snapshot → reordered → unpriced). `gpt-5.5` with no row returns null. `claude-opus-6` returns null. `claude-opus-4-6-20260205` resolves to `claude-opus-4-6` with `match: 'snapshot'`. A version-first id such as `claude-4-5-sonnet` resolves to `claude-sonnet-4-5` with `match: 'reordered'`.
- **AC6.** Dotted pricing.json keys resolve. Colliding keys with different prices make the table build throw.
- **AC7.** Rows marked `estimated: true` appear in `meta.estimatedModels` and in `perModelCost[].estimated`.
- **AC8.** The statusline `lookupRate` uses the same resolution order as `resolvePrice`.
- **AC9.** T1, T2 and T3 exist in the `agent` project. Each fails on unpriced models; T1 and T2 also fail on sessions with a log but no price. T2 exempts only the catalog ids listed in the documented `EXCLUDED_MODEL_IDS` map (each with a cited reason) from the per-run cost assertion. T3 accepts any non-null `resolvePrice` result, including `match: 'reordered'`.
- **AC10.** `docs/ANALYTICS-REPORT.md` and `docs/COMMANDS.md` describe only the surviving contract (`--export [html|json|both]`, `-o`, `--open`).
- **AC11.** `-o <path>` targets a directory when the path ends with a separator or names an existing directory. Each requested format is then written there under its default name. Any other path is a file path; for `both` it produces `<base>.html` and `<base>.report.json`. Missing directories are created. An explicit `-o` never relocates to home/tmp. A bare `-o <path>` with no `--export`/`--open` also implies an export, with the format inferred from the path (`.json` → `json`, otherwise → `html`).

## Amendments (user-approved, 2026-09-26)

The implementation extended the pricing resolver beyond this spec's original section B/C wording, and the extensions were reviewed and approved. This spec is amended in place to match the approved and implemented behavior, rather than left to silently diverge from what shipped:

- **Canonicalization prefixes.** Step 2 also strips the dot-form `moonshotai.` and `qwen.` vendor prefixes, and step 1 explicitly covers the stacked `bedrock/converse/` form (both observed on real usage data).
- **Reordered lookup step.** A third lookup step reorders a version-first Claude id (`claude-<ver>-<family>`) to the table's family-first form and tries it exact/snapshot, after the plain exact/snapshot steps fail and before falling back to unpriced. This maps an id onto an existing published row under its other spelling — it is not a family/tier guess — and is reported as `match: 'reordered'` on `PriceResolution`.
- **T2 `EXCLUDED_MODEL_IDS`.** A documented, per-id-reasoned exclusion map exempts a small number of catalog ids with a reproduced upstream/agent-side failure from T2's cost assertion, and the live prompt is a tool-forcing prompt rather than a plain "hi", so every run reliably produces billable usage.
- **T3 accepts reordered matches.** T3's per-catalog-model reconciliation accepts any non-null `resolvePrice` result, including `match: 'reordered'`, not only exact/snapshot.
- **`-o` alone implies an export.** `-o <path>` with no `--export`/`--open` implies an export, with the format inferred from the path extension. Invalid `--export` values are validated and rejected before any sessions are loaded.

Section B, section C (T2/T3), section D, and AC5/AC9/AC11 above already reflect these amendments.

## Non-goals

- Keeping deprecated aliases or warnings for the removed flags.
- CSV export in any form.
- Moving the new tests into `npm run ci` (`unit`/`cli` projects).
- Guessing prices for models that have no published price. Such models stay unpriced until a sourced row is added.
- Failing the tests on `estimatedModels`. These are reported, not blocking.
- Changing the server-side `codemie-analytics` skill (`src/agents/plugins/claude/plugin/skills/codemie-analytics/`).
- Changing the per-session exit report's trigger, location or `--no-analytics-report` flag. Its directory is not affected by `-o`.
- Speeding up native-log parsing for always-on cost.
