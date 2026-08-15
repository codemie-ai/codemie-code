# Independent Review Report — Pi model `cost` sections

Review date: 2026-08-16

## Verdict

**CHANGES REQUIRED** — ordinary model prices are converted and consumed correctly, but a reachable finite API number can overflow during per-million conversion, serialize as `null`, and cause Pi to reject the entire CodeMie model file.

## Gate results

| Command / check | Result | Actual outcome |
|---|---|---|
| `git branch --show-current` | PASS | `feat/pi-model-cost-sections` |
| `git diff main...feat/pi-model-cost-sections` | **FAIL (stated review-target expectation)** | Exit 0 with no diff. `main` and `HEAD` are both `23aa8d21f17428eb545ea4d515b71aead4b4b8e3`; the 72-line production change is unstaged and therefore absent from this three-dot diff. The review used `git diff -- src/agents/plugins/pi/pi.models.ts` plus the untracked test file instead. |
| `git status --short` | PASS, with prompt discrepancy | Before this report was written: ` M src/agents/plugins/pi/pi.models.ts`, `?? src/agents/plugins/pi/__tests__/pi.models.test.ts`, and `?? docs/superpowers/tasks/2026-08-16-pi-model-cost-sections/`. Nothing is committed, as intended; the review-prompt directory is also untracked, not only the test file. |
| `npm run typecheck` | PASS | Exit 0; `tsc --noEmit` reported no diagnostics. npm emitted only its unrelated `allow-scripts` deprecation warning. |
| `npm run lint` | PASS | Exit 0; ESLint completed with zero errors and zero warnings. |
| `npm run build` | PASS | Exit 0; `tsc`, `tsc-alias`, and `copy-plugin` completed. The build explicitly copied the analytics pricing table through `scripts/copy-plugins.js:62-66`; the resulting `dist/cli/commands/analytics/cost/pricing.json` existed and was 19,711 bytes. |
| `npx vitest run --project unit src/agents/plugins/pi/__tests__/pi.models.test.ts` | PASS | 1 file passed; 10/10 tests passed in 559 ms. |
| `npm run test:unit` | PASS | 208 files passed; 3,063/3,063 tests passed in 11.61 s. The output contained only existing npm/Node warnings. |
| End-to-end fallback generation through installed Pi 0.84.2 | PASS for the three requested models | Pi loaded `gpt-4.1` as `{"input":2,"output":8,"cacheRead":0.5,"cacheWrite":2}`, `claude-sonnet-5` as `{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}`, and the unpriced model as four runtime zeros. Inspection of the generated JSON verified that `some-unpriced-model` had no `cost` key. |
| `PI_CODING_AGENT_DIR=... PI_OFFLINE=1 pi --list-models claude-sonnet-5` | PASS | Pi printed the expected `codemie-anthropic  claude-sonnet-5` row. |
| 44-model validation using the stale repo config only as an ID source | PASS | Rebuilt scratch config contained 44 IDs; 34 had nonzero cost blocks, the reported 10 were unpriced, Pi reported no config error, and all 44 models loaded. |
| Pi cost-math probe | PASS | Calling installed Pi's `calculateCost` for one million each of input, output, cache-read, and short cache-write tokens on generated `gpt-4.1` produced `{"input":2,"output":8,"cacheRead":0.5,"cacheWrite":2,"total":12.5}`. This follows `packages/ai/src/models.ts:878-897`. |
| Scratch cleanup | PASS | Every review directory was created by `mktemp -d /tmp/pi-cost-*-review-XXXX`, guarded by a prefix check, and removed by its exit trap. The repository's `.pi/` directory was read only as the 44-ID source and was not modified. |

## Findings

### Major — conversion can turn a valid finite rate into an invalid Pi config

- **Location:** `src/agents/plugins/pi/pi.models.ts:126-129`
- **Defect:** `resolveRate` validates the API value before `toPerMillion` multiplies it, but it never validates the converted result.
- **Concrete failure scenario:** a valid JSON response contains `"input": 1e308`. `JSON.parse` returns the finite number `1e308`, `isValidRate` accepts it at `src/agents/plugins/pi/pi.models.ts:113-115`, and multiplication at `src/agents/plugins/pi/pi.models.ts:118-120` produces `Infinity`. `JSON.stringify` then writes `"input": null`. Pi requires a number at `packages/coding-agent/src/core/model-config.ts:142-165`; its whole-file validation at `packages/coding-agent/src/core/model-config.ts:270-284` rejects the config, and no CodeMie model from that file is available.
- **Verified failure:** the review probe printed `PARSED_FINITE true`, `CONVERTED_INPUT Infinity`, `SERIALIZED_COST {"input":null,"output":8,"cacheRead":0,"cacheWrite":0}`, Pi's `must be number` schema error, and `PI_MODEL_PRESENT false`.
- **Required correction:** validate the multiplied result before returning it and fall through to the vendored rate or zero if the result is non-finite. Add a regression test with a finite overflowing input; the current malformed-input coverage at `src/agents/plugins/pi/__tests__/pi.models.test.ts:135-163` checks values already invalid before conversion and does not expose this path.

## Section 8 checklist

### 1. Unit conversion

**Issue found only for overflow; direction and normal magnitude are correct.** CodeMie API values are multiplied exactly once at `src/agents/plugins/pi/pi.models.ts:117-129`, while values returned by the already-per-million table pass through unchanged at `src/agents/plugins/pi/pi.models.ts:130-132`. Pi divides all four rates by one million at `packages/ai/src/models.ts:892-895`. The focused tests and Pi runtime probe verified the expected ordinary values. The post-multiplication overflow described above is the exception.

### 2. Field mapping

**No schema-mapping issue found.** `cache_read_input_token_cost` maps to `cacheRead` and `cache_creation_input_token_cost`/`ModelPrice.cacheCreation` map to `cacheWrite` at `src/agents/plugins/pi/pi.models.ts:147-150`. The analytics table defines `cacheCreation` as its source's cache-write rate at `src/cli/commands/analytics/cost/pricing.ts:1-6,46-52`. Pi has no `cacheWrite1h` rate; it charges long writes at `input * 2` and applies `cacheWrite` only to short writes at `packages/ai/src/models.ts:889-895`, so not emitting the unsupported field is schema-correct.

A targeted data audit found 36 vendored rows with `cacheWrite1h`; 35 equal `input * 2`. The remaining `claude-3-sonnet-20240229` row does not, so Pi cannot reproduce that table row's distinct long-write value. That row is not among the current 44 IDs, Pi offers no field that could encode it, and pricing-table contents are out of scope; this is recorded under adjacent observations rather than as an implementation finding.

### 3. Schema conformance under all paths

**Major issue found.** `resolveModelCost` constructs all four keys at `src/agents/plugins/pi/pi.models.ts:144-151`, and missing, string, negative, or already non-finite inputs resolve to a finite fallback or zero through `src/agents/plugins/pi/pi.models.ts:113-134`. A finite value can nevertheless overflow after validation, serialize as `null`, and trigger Pi's whole-file rejection at `packages/coding-agent/src/core/model-config.ts:270-284`. No path emits fewer than four keys when `cost` is present; the problem is a reachable non-number after conversion.

### 4. Zero-versus-absent semantics

**Faithful to the approved semantics; no defect filed.** Zero satisfies `value >= 0` at `src/agents/plugins/pi/pi.models.ts:113-115`, so it is authoritative and suppresses the corresponding vendored field at `src/agents/plugins/pi/pi.models.ts:126-132`. The review probe confirmed that API `{input: 0, output: 0}` plus the real `gpt-4.1` table yields `{input:0, output:0, cacheRead:0.5, cacheWrite:2}`: fallback remains per-field, so the prompt's claim that this necessarily yields no block is not generally true. If every resolved field is zero, `src/agents/plugins/pi/pi.models.ts:153-154` omits the block as approved.

The comment that the API value "wins" at `src/agents/plugins/pi/pi.models.ts:122-125` technically covers zero, but the consequence is not explicit and the zero test at `src/agents/plugins/pi/__tests__/pi.models.test.ts:126-132` uses no nonzero table fallback. A comment or test pinning zero against a priced table entry would make the selected behavior discoverable; this is a maintainability recommendation, not a request to redesign the approved semantics.

### 5. Silent inexact pricing

**Accepted design risk under the approved source choice; no separate implementation finding.** `lookupPrice` uses exact, family, then Claude-tier matching at `src/cli/commands/analytics/cost/pricing.ts:144-175`. The review probe confirmed that `gpt-5.7-codex` currently receives `{input:1.25, output:10, cacheRead:0.125, cacheCreation:1.25}` and `claude-sonnet-99` receives the latest Sonnet-tier price. If a future model's actual rates differ, Pi will confidently report the fallback estimate because its schema has no exactness marker.

The prompt's assertion that analytics flags inexact matches to consumers is false: `lookupPrice` returns only `ModelPrice | null` and exposes inexactness only via `logger.debug` at `src/cli/commands/analytics/cost/pricing.ts:167-175`; `priceUsage` treats every non-null match as priced at `src/cli/commands/analytics/cost/cost-enricher.ts:119-130`. Pi is therefore consistent with the existing consumer behavior, although the approximation risk remains.

### 6. Omit-when-all-zero

**Runtime-equivalent, not byte-for-byte equivalent.** An absent cost is normalized to all four zeros at `packages/coding-agent/src/core/provider-composer.ts:150-165`. Model overrides then merge against that runtime object per field at `packages/coding-agent/src/core/provider-composer.ts:103-120`, and cache statistics read only the normalized runtime `cost.cacheRead` at `packages/coding-agent/src/core/cache-stats.ts:73-87`. No inspected model-availability path distinguishes the original JSON shape. The end-to-end unpriced-model run verified an absent file key and four runtime zeros.

### 7. Guard proportionality

**One missing guard found.** `typeof === 'number'`, `Number.isFinite`, and nonnegative validation at `src/agents/plugins/pi/pi.models.ts:106-115` each protect a reachable bad-cost or schema path. Valid JSON can yield non-finite numbers through a large exponent, and negative numbers can produce nonsensical negative estimates. Conversely, the converted-result finiteness gap is reachable and is the major finding. The conditions are not disproportional, but their placement is incomplete.

### 8. Layering

**Architectural observation; no present runtime failure found.** The runtime import at `src/agents/plugins/pi/pi.models.ts:6` points from the plugin layer into the CLI layer, reversing the documented `CLI -> Registry -> Plugin -> Core -> Utils` direction in `.ai-run/guides/architecture/architecture.md:145-155`. The cited precedent exists at `src/agents/plugins/codex/session/codex-dispatch-extractor.ts:9-11`, but it imports an analytics type and constant and is itself another reverse dependency; it does not make the direction conformant. A genuinely shared pricing lookup belongs outside the CLI layer.

The current package is operational despite that boundary: the copy rule exists at `scripts/copy-plugins.js:55-67`, `npm run build` produced the JSON asset in `dist`, and the real-table end-to-end run loaded it successfully. Because no current packaging or runtime failure was found, this remains an observation rather than a severity-rated finding.

### 9. Blast radius

**No compatibility issue found.** `PiModelEntry.cost` is optional at `src/agents/plugins/pi/pi.models.ts:53-64`, so existing TypeScript consumers are not forced to populate it. `buildModelsConfig` groups and retains the same entry objects at `src/agents/plugins/pi/pi.models.ts:230-276`; `createSyntheticLlmModel` and `buildStaticFallbackModel` intentionally flow through the converter at `src/agents/plugins/pi/pi.models.ts:279-293`; `fetchAndBuildPiModels` writes those entries without reshaping them at `src/agents/plugins/pi/pi.models.ts:295-329`; and Pi's `beforeRun` still invokes generation before setting `PI_CODING_AGENT_DIR` at `src/agents/plugins/pi/pi.plugin.ts:302-308`. The static-fallback path becoming priced when the table recognizes `CODEMIE_MODEL` is the disclosed and intended behavior change.

### 10. Test quality

**Adequate unit isolation, with one material gap tied to the major finding.** Mocking `lookupPrice` at `src/agents/plugins/pi/__tests__/pi.models.test.ts:23-28` avoids coupling a converter unit test to mutable vendored data. The tests cover all four API conversions, API precedence, per-field and table-only fallback, exact four-key shape, omission, and several malformed values at `src/agents/plugins/pi/__tests__/pi.models.test.ts:55-163`. The exact-key assertion also proves `tiers` is absent. `toBeCloseTo` is appropriate for multiplication products, and the hostile string cast intentionally bypasses the compile-time claim.

The missing finite-overflow case allowed the major defect through. The suite also does not write JSON or invoke Pi, despite its opening comment saying values never reach "the file" at `src/agents/plugins/pi/__tests__/pi.models.test.ts:1-15`; the review's separate runtime checks supplied that integration evidence. Multi-model bucketing remained correct in the 44-model probe. The file follows the co-located naming, module mocking, descriptive grouping, `.js` import, and `@group unit` conventions documented at `.ai-run/guides/testing/testing-patterns.md:7-28,42-55` and demonstrated by `src/agents/plugins/pi/__tests__/pi.paths.test.ts:1-22`.

### 11. Repository conventions

**No issue found apart from the layering observation.** The changed source uses ESM `.js` extensions, `import type`, exported interfaces, explicit return types on exported functions, meaningful names, small helpers, and `logger` rather than `console`, consistent with `.ai-run/guides/standards/code-quality.md:20-49,93-110,128-139`. `git diff --check` passed. The production working-tree diff contains exactly 72 additions in `src/agents/plugins/pi/pi.models.ts`, all related to the requested cost behavior; no orphaned import or dead helper was found.

### 12. Does it fix the reported bug?

**Yes for ordinary prices, but not safely for every reachable payload; changes are required.** Installed Pi loaded the expected prices for `gpt-4.1` and `claude-sonnet-5`, defaulted an omitted unpriced block to zeros, loaded all 44 scratch models, and calculated the expected `$12.50` example. However, the reproduced finite-overflow payload makes Pi discard the entire custom config. The implementation therefore demonstrates the intended end state but does not yet satisfy the schema-safety guarantee it claims.

## Claims audit

- **Outdated review range:** the prompt says `git diff main...feat/pi-model-cost-sections` contains one changed production file. It is empty because `main` and the feature branch both point to `23aa8d2`; the production file is unstaged. The 72-line claim is true only for the working-tree diff.
- **"Exactly four fields" is imprecise:** Pi requires the four base rates at `packages/ai/src/types.ts:776-781`, but `ModelCost` also permits optional `tiers` at `packages/ai/src/types.ts:783-790`, reflected in `packages/coding-agent/src/core/model-config.ts:148-165`. The implementation correctly omits tiers because it has no tier data.
- **"Structurally impossible" is false:** `src/agents/plugins/pi/pi.models.ts:126-129` can return `Infinity` after validating a finite API value, leading to serialized `null` and whole-file rejection.
- **Analytics does not flag inexact matches to consumers:** inexactness is debug-only at `src/cli/commands/analytics/cost/pricing.ts:167-175`; analytics consumers receive a normal non-null price and mark it priced at `src/cli/commands/analytics/cost/cost-enricher.ts:119-130`.
- **"Byte-for-byte equivalent" is false literally:** omitted cost and explicit zero cost serialize differently. They are runtime-equivalent after `modelFromJson` applies the zero default at `packages/coding-agent/src/core/provider-composer.ts:150-165`.
- **The 44-model coverage claim is accurate:** the review independently re-derived 34 priced and the same 10 unpriced IDs, with all 44 loading through Pi.
- **The stated ordinary end-to-end prices are accurate:** the review independently reproduced both expected priced models and the unpriced default through installed Pi 0.84.2.

## Explicitly not reviewed

- Codex and Kimi model-cost behavior.
- OpenCode behavior except as evidence for the existing per-token to per-million convention.
- Analytics pricing implementation quality or pricing-table refresh/content policy, except for the caller-visible exactness behavior needed by concern 5.
- Extending or refreshing `pricing.json`.
- Changes to upstream Pi.
- Session metrics, transcript synchronization, run-ledger behavior, or CodeMie analytics reports.
- Commits, branch naming, pull requests, changelog, and versioning.
- Broad refactoring outside the touched Pi conversion path.

## Adjacent observations

- `resolveModelCost` calls `lookupPrice` before examining whether all four API rates are present at `src/agents/plugins/pi/pi.models.ts:144-150`. A missing or corrupt pricing asset would therefore block even a fully API-priced payload. The built artifact currently contains both the compiled lookup and its JSON file, so this is not a present defect.
- One out-of-scope vendored row, `claude-3-sonnet-20240229`, has a `cacheWrite1h` value different from Pi's fixed `input * 2` rule. Pi has no schema field with which this integration could preserve that distinct value; the row was not in the current 44-model list.
