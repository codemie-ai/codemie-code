# Independent Review Prompt (Round 2) — Pi model `cost` sections

You are an independent reviewer. Another agent implemented a fix, had it reviewed once, and applied remediation. Your job is to judge the **current state of the branch** — the original fix plus the remediation plus a refactor — on correctness, completeness, safety, and conformance to this repository's conventions. You did not write this code and you owe it no benefit of the doubt. In particular, the implementer's claim that each round-1 finding is closed is a claim to test, not a premise.

**You are read-only.** Do not edit, stage, commit, or revert anything. Do not "fix while you're in there". Produce findings; the implementer applies them.

This prompt is self-contained: everything you need is below. Round-1 artifacts sit beside it in this directory (`review-prompt.md`, `review-report.md`, `remediation-plan.md`) and are useful background, but you are not required to read them and you must not treat their conclusions as settled.

---

## 1. The task that was assigned

Verbatim, as the user stated it:

> CodeMie code provides a `codemie-pi` command that prepares a configuration and launches the `Pi` agent harness.
> There is a bug in which CodeMie prepares a model list for `Pi` that does not include cost sections for models.
> Analyze `/home/taras_spashchenko/TS/github/pi`. Identify how the model's cost for input and output tokens must be specified and fix model declaration for `Pi` to include cost sections for models.
> Ensure that the cost sections are correctly formatted and integrated into the model list so that `Pi` can accurately account for token usage during its operations.
>
> Make all your changes in a new branch.
> Run analysis and prepare a detailed implementation plan, then implement this new feature.

Two follow-up instructions shaped the current state: after the round-1 review, the user said *"Address all the issues now in this branch"* (which pulled a deferred layering refactor into scope), and then *"commit all the changes"*.

---

## 2. Where everything is

| What | Where |
|---|---|
| Implementation repo | `/home/taras_spashchenko/EPAM/codemie-ai/codemie-code` |
| Branch under review | `feat/pi-model-cost-sections`, three commits ahead of `main` (`23aa8d2`) |
| Upstream Pi source (the consumer of the generated config) | `/home/taras_spashchenko/TS/github/pi` |
| Installed Pi used for end-to-end checks | `pi` 0.84.2, global npm at `/home/taras_spashchenko/.nvm/versions/node/v22.21.0/lib/node_modules/@earendil-works/pi-coding-agent` |

Review target:

```bash
git log --oneline main..HEAD          # 3 commits: refactor(utils), feat(agents), docs(agents)
git diff main..HEAD                   # everything under review
git status --short                    # expected: clean
```

All three commits are in scope, as is any uncommitted change `git status` reveals. Nothing else on the branch was touched.

> Corrected after round 2. This prompt originally described two commits with the task docs
> untracked, because it was written before the docs commit existed — and was then swept into that
> very commit (`c25430f`), which also carries this file. The round-2 reviewer flagged the
> discrepancy; the branch state above is the accurate one.

---

## 3. The bug that started this

`codemie-pi` regenerates `<cwd>/.pi/codemie/agent/models.json` on every run (`fetchAndBuildPiModels` in `src/agents/plugins/pi/pi.models.ts`, invoked from `pi.plugin.ts`'s `lifecycle.beforeRun`). Originally every emitted model entry omitted the `cost` block, so Pi priced every CodeMie model at zero and reported `$0.00` for all token usage. Baseline before any fix, read back through Pi's own runtime:

```
codemie-proxy/gpt-4.1             {"input":0,"output":0,"cacheRead":0,"cacheWrite":0}
codemie-anthropic/claude-sonnet-5 {"input":0,"output":0,"cacheRead":0,"cacheWrite":0}
```

---

## 4. Ground truth about Pi's requirements

Established by reading the upstream source. **Treat these as claims to verify, not as given** — if any is wrong, the implementation built on it is wrong, and that is a blocking finding.

| Claim | Cited evidence in `/home/taras_spashchenko/TS/github/pi` |
|---|---|
| A model's `cost` is a nested object whose four required rates are `input`, `output`, `cacheRead`, `cacheWrite`, plus an optional `tiers` array | `packages/ai/src/types.ts:776-791` |
| Units are USD per 1,000,000 tokens | `packages/ai/src/models.ts:878-898` — `calculateCost` divides each rate by `1000000` |
| In `models.json` the `cost` block is optional, but when present all four rates are required numbers | `packages/coding-agent/src/core/model-config.ts:142-171` (TypeBox) |
| A schema violation rejects the **entire file**, not the offending entry | `ModelConfig.load`, `model-config.ts:246-285` |
| A missing `cost` block silently defaults to all zeros | `packages/coding-agent/src/core/provider-composer.ts:150-165` |
| Pi has no rate field for 1-hour cache writes; it bills them as `input × 2` | `packages/ai/src/models.ts:889-895` |
| Per-field `??` merging is Pi's own idiom for cost overrides | `provider-composer.ts:103-128` (`applyModelOverride`) |
| Pi reads `<agentDir>/models.json`, agentDir from `PI_CODING_AGENT_DIR` (CodeMie sets `<cwd>/.pi/codemie/agent`) | — |

---

## 5. What the branch contains

### Commit 1 — `refactor(utils): move model pricing table out of the CLI layer`

Round 1 found that the plugin imported the price table upward from `src/cli/commands/analytics/`, against the documented `CLI → Registry → Plugin → Core → Utils` direction. Five files moved with `git mv`:

| From | To |
|---|---|
| `src/cli/commands/analytics/cost/pricing.ts` | `src/utils/pricing.ts` |
| `src/cli/commands/analytics/cost/pricing.json` | `src/utils/pricing.json` |
| `src/cli/commands/analytics/model-normalizer.ts` | `src/utils/model-normalizer.ts` |
| `src/cli/commands/analytics/cost/__tests__/pricing.test.ts` | `src/utils/__tests__/pricing.test.ts` |
| `src/cli/commands/analytics/__tests__/model-normalizer.test.ts` | `src/utils/__tests__/model-normalizer.test.ts` |

`model-normalizer.ts` moved because `pricing.ts` depends on it; leaving it behind would have inverted the violation into `utils → cli`. Analytics consumers (`cost-enricher.ts`, `cost-calculator.ts`, `otel-loader.ts`, `aggregator.ts`) were repointed to the `@/utils/…` alias; `pricing.ts`'s own three imports became `./paths.js`, `./model-normalizer.js`, `./logger.js`; the asset rule in `scripts/copy-plugins.js` now copies `src/utils/pricing.json` → `dist/utils/pricing.json`. The commit message claims **no logic changed inside the moved files**.

### Commit 2 — `feat(agents): emit per-model cost rates in the Pi model list`

All behavior changes live in `src/agents/plugins/pi/pi.models.ts`, plus a new test file `src/agents/plugins/pi/__tests__/pi.models.test.ts`.

1. New exported `PiModelCost` interface — `input`, `output`, `cacheRead`, `cacheWrite`, all required.
2. `cost?: PiModelCost` on the existing `PiModelEntry`.
3. Five module-private helpers between `isReasoningModel` and `convertLlmModelToPiEntry`:
   - `isValidRate(value): value is number` — `typeof === 'number' && Number.isFinite(value) && value >= 0`.
   - `toPerMillion(value)` — `value * 1_000_000`.
   - `resolveRate(apiPerToken, vendoredPerMillion)` — the converted API value wins **only if the product also passes `isValidRate`**; then the vendored value; then `0`.
   - `vendoredPrice(id)` — `lookupPrice` wrapped in try/catch, logging at debug and returning `null` on failure.
   - `resolveModelCost(model, id)` — builds all four rates, returns `undefined` when all four are `0`.
4. `convertLlmModelToPiEntry` assigns `entry.cost` when `resolveModelCost` returns a value, just before `return entry`.

### The two price sources

- **Primary — the CodeMie models API.** `LlmModel.cost` in `src/providers/plugins/sso/sso.http-client.ts:32-57`: `{ input?, output?, cache_read_input_token_cost?, cache_creation_input_token_cost? }`, in USD **per token**. Already fetched before this change; previously ignored. The `× 1_000_000` scaling mirrors `src/agents/plugins/opencode/opencode-dynamic-models.ts:90-138`, which already does this for the OpenCode plugin.
- **Fallback — the vendored table.** `lookupPrice(id)` in `src/utils/pricing.ts` returns `{input, output, cacheRead, cacheCreation, cacheWrite1h?}`, already per million. `cacheCreation` maps to Pi's `cacheWrite`; `cacheWrite1h` is dropped. Coverage measured against the 44 ids the live API currently yields: 34 priced, 10 not.

### Design decisions and their stated rationale

| Decision | Rationale given |
|---|---|
| Per-field resolution, not whole-block preference | Mirrors Pi's `applyModelOverride` per-field `??` merge, so a payload carrying only `input`/`output` still gets cache rates from the table |
| An explicit `0` from the API is authoritative and suppresses the table for that field | The `??` semantics the user chose when picking the price-source strategy |
| Omit the block when all four rates resolve to `0` | Runtime-equivalent to Pi's own default, so an unpriced model behaves as before; explicit zeros would instead assert the model is free |
| Validate rates before **and after** scaling | A finite `1e308` passes an input-only check and overflows to `Infinity`, which serializes as `null` and makes Pi reject the whole file. This was round 1's one severity-rated finding |
| A price-table read failure returns `null` instead of throwing | `lookupPrice` reads a vendored asset on first call, inside the plugin's unguarded `beforeRun`; a throw would abort the user's session over missing metrics |
| No rounding of the scaled product | Consistent with the existing OpenCode helper and with Pi's own generated catalogs, which contain values like `0.19999999999999998` |
| `tiers` not emitted | No CodeMie data source for tiered pricing; the field is optional |

### Disclosed behavior change

The static-fallback path (`buildStaticFallbackModel` → `createSyntheticLlmModel`, used when the live model fetch fails and `CODEMIE_MODEL` is set) previously always produced a free model. It now picks up vendored pricing when that id matches a table entry.

---

## 6. Decisions already made — do not re-litigate

Report a **factual defect** in how one of these was implemented; do not argue the decision itself.

1. **Price source: API first, vendored table as per-field fallback**, with `??` semantics (`api ?? table ?? 0`) and the block omitted when all four resolve to zero. The user chose this over "API only" and "table only".
2. **A unit test file was explicitly requested.** Its presence is correct, not a violation of the repo's tests-on-request policy.
3. **The layering refactor belongs in this branch.** The user directed it here rather than to a follow-up ticket.
4. **Commits were requested**, so the branch having three commits is intended. Their granularity and messages are reviewable; the fact of committing is not.

---

## 7. Scope

### In scope

- Everything in `git diff main..HEAD`, plus any uncommitted change `git status` shows.
- Whether each round-1 finding is genuinely closed, not merely claimed closed.
- Whether the relocation is complete and behavior-preserving.
- Whether the fix actually achieves accurate token accounting in Pi, or only appears to.
- Whether the claims in sections 4 and 5 hold when you check them.
- Repository conventions as they apply to the changed and moved files, including commit-message conformance to `.ai-run/guides/standards/git-workflow.md` and `commitlint.config.cjs`.

### Out of scope — do not review, do not propose changes to

- The Codex plugin (`codex-models.ts`) and Kimi plugin (`kimi.models.ts`), which also ignore `LlmModel.cost`. Known, deliberately deferred.
- The OpenCode plugin, except as a *precedent* you may cite.
- The internals and heuristics of `pricing.ts` / `model-normalizer.ts` beyond verifying the move preserved them byte-for-byte, and the *contents* of `pricing.json`. You may judge whether relying on this table here is sound; do not review its algorithm quality or propose refactors to it.
- Refreshing or extending `pricing.json`.
- Upstream Pi. Read it as the specification; propose no changes to it.
- Session metrics, transcript sync, the run ledger, CodeMie's analytics reports.
- Pushing, PR creation, changelog, version bumps, squash strategy.
- Historical task artifacts under `docs/superpowers/tasks/` other than this directory — they are point-in-time records and deliberately still reference pre-move paths.
- Broad refactors beyond the touched lines; the repo requires every changed line to trace to the request.

---

## 8. Specific areas of concern — address each explicitly

Give a verdict on every one, with evidence. "No issue found" is a valid verdict.

1. **Is the overflow defect actually closed?** Reproduce it: a payload of `1e308` (and `Number.MAX_VALUE`) for `input`. Confirm no non-finite value reaches the emitted entry, that the serialized JSON contains no `null` rate, and that Pi loads the model. Then look for any *other* arithmetic or assignment path in the changed code that can produce a value `isValidRate` never sees.

2. **Is the `vendoredPrice` try/catch right, or too broad?** It swallows every error `lookupPrice` can raise — including a genuine programming error inside `pricing.ts`, not just a missing or corrupt asset. Judge whether that trade is correct here, whether `logger.debug` (rather than `warn`) hides a condition an operator would want to see, and whether it can mask a systematically unpriced fleet. Verify the actual behavior by making the asset unreadable rather than by reading the code alone.

3. **Is the relocation complete?** Verify: no source file still imports the old paths; `pricing.ts` and `model-normalizer.ts` are byte-identical to their pre-move versions apart from `pricing.ts`'s own import lines (`git show` / `git diff -M` against `main`); the moved tests still target the moved modules; the `@/utils/…` alias resolves under both `tsc` and Vitest (the projects define `alias: { '@': '/src' }`); and a **clean** build (`rm -rf dist && npm run build`) puts `pricing.json` at `dist/utils/pricing.json` with nothing left at the old location. Also check whether any non-code reference (docs, guides, scripts, CI config) still points at the old paths.

4. **Unit conversion and field mapping.** Is `× 1_000_000` correct in direction and magnitude for all four rates, given the API is per-token and Pi divides by `1e6`? Does any table value — already per million — get scaled a second time? Is `cache_read_input_token_cost` → `cacheRead` and `cache_creation_input_token_cost` / `ModelPrice.cacheCreation` → `cacheWrite` semantically right? Is dropping `cacheWrite1h` correct given Pi computes long writes as `rates.input * 2 * longWrite`?

5. **Schema conformance under all paths.** Can any input produce a `cost` block with fewer than four keys, a non-finite number, a `null`, or a string — making Pi reject the whole file and drop **every** CodeMie model? Trace `resolveModelCost` exhaustively rather than trusting any claim of impossibility; round 1 showed one such claim was false.

6. **Zero-versus-absent semantics.** An explicit `0` from the API suppresses the table for that field, so an instance that returns `cost: {input: 0, output: 0}` gets no price for those two rates even when the table knows them. This is the approved `??` behavior. Assess only whether the implementation is faithful to it and whether the code and tests make the consequence discoverable to the next maintainer.

7. **Silent inexact pricing.** `lookupPrice` falls back to a longest-segment family match and then to a latest-same-tier Claude match, signalling inexactness only through `logger.debug`; its return type carries no exactness marker, and the pre-existing analytics consumer treats any non-null match as priced. So an approximate price is written into Pi's config as authoritative. Is that acceptable here, and is an unrecognized future id (say `gpt-5.7-*`) at risk of confident mispricing?

8. **Omit-when-all-zero.** Verify that omitting the block is truly equivalent to Pi's default at runtime. Is there any Pi path that distinguishes "no `cost` key" from "`cost` present with zeros" — `modelOverrides` merging, `packages/coding-agent/src/core/cache-stats.ts`, model availability?

9. **Guard proportionality.** Are `isValidRate`'s three conditions, the product re-check, and the try/catch each justified by a reachable failure, or is any of them defensive code for an impossible scenario (which the repo forbids)? Conversely, is any reachable malformed input still unguarded?

10. **Blast radius.** `PiModelEntry` and `PiModelCost` are exported. Does the new optional field break any consumer? Are `buildModelsConfig`, `createSyntheticLlmModel`, `buildStaticFallbackModel`, `fetchAndBuildPiModels` and `pi.plugin.ts` genuinely unaffected? Is the disclosed static-fallback pricing change acceptable, and is anything else silently changed that was not disclosed — including in the four repointed analytics files?

11. **Test quality.** The suite is 15 tests. Do they pin behavior or merely restate the implementation? Judge mocking `lookupPrice` rather than exercising the real table; the overflow, table-failure and explicit-zero cases added in remediation; and what is still missing (the serialized file, multi-model bucketing, `classifyPiModel` interaction). Do they follow `src/agents/plugins/pi/__tests__/` conventions and `.ai-run/guides/testing/testing-patterns.md`?

12. **Conventions and hygiene.** `.ai-run/guides/standards/code-quality.md` and `development-practices.md`: ESM with `.js` extensions, explicit return types on exports, no `any`, `logger` not `console`, comments explaining *why*, small single-purpose functions. Check that no unrelated line was touched, no orphaned import or dead code remains, and that both commit messages satisfy `commitlint.config.cjs` (allowed type, allowed scope, subject ≤ 100 chars, body lines ≤ 300) and describe what they actually contain.

13. **Does it fix the reported bug?** The success criterion is that Pi accurately accounts for token usage. Verify the end state yourself rather than accepting the numbers below.

---

## 9. Verification you must run

Report actual output. Do not mark a gate passed without having run it.

```bash
cd /home/taras_spashchenko/EPAM/codemie-ai/codemie-code
git log --oneline main..HEAD
git diff main..HEAD --stat
# Rename detection needs BOTH sides in the pathspec — with only the destinations, git shows the
# files as pure additions and the "only imports changed" expectation is unreachable.
git diff -M main..HEAD -- \
  src/cli/commands/analytics/cost/pricing.ts src/utils/pricing.ts \
  src/cli/commands/analytics/model-normalizer.ts src/utils/model-normalizer.ts
# expect: model-normalizer.ts 100% similarity, pricing.ts ~97% with only its three import lines changed
git status --short

npm run ci        # license-check → lint → build → test:unit → test:integration
rm -rf dist && npm run build && find dist -name pricing.json
```

**Overflow probe (round-1 finding).** Expect a finite rate, no `null`, and the model present:

```bash
PI_PKG=/home/taras_spashchenko/.nvm/versions/node/v22.21.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js
REPO=/home/taras_spashchenko/EPAM/codemie-ai/codemie-code
TMP=$(mktemp -d /tmp/pi-r2-overflow-XXXX); cd "$TMP"
PI_OFFLINE=1 node --input-type=module -e "
import { mkdirSync, writeFileSync } from 'node:fs';
const { convertLlmModelToPiEntry } = await import('$REPO/dist/agents/plugins/pi/pi.models.js');
const payload = JSON.parse('{\"input\": 1e308, \"output\": 0.000008}');
const entry = convertLlmModelToPiEntry({ base_name:'gpt-4.1', deployment_name:'gpt-4.1', label:'x', enabled:true, cost:{ input: payload.input, output: payload.output } });
console.log('converted:', entry.cost.input, 'finite:', Number.isFinite(entry.cost.input));
mkdirSync('agent',{recursive:true});
writeFileSync('agent/models.json', JSON.stringify({ providers:{ 'codemie-proxy':{ baseUrl:'https://example.invalid/v1', api:'openai-completions', apiKey:'k', models:[entry] } } }, null, 2));
const { ModelRuntime } = await import('$PI_PKG');
const rt = await ModelRuntime.create({ modelsPath: process.cwd()+'/agent/models.json' });
console.log('pi model present:', rt.getModel('codemie-proxy','gpt-4.1') !== undefined);
"
```

**Missing-asset probe.** Move `dist/utils/pricing.json` aside (restore it with a trap), then drive the exported entry point and expect it to write a config and return, not throw:

```bash
node --input-type=module -e "
const { fetchAndBuildPiModels } = await import('<repo>/dist/agents/plugins/pi/pi.models.js');
try { await fetchAndBuildPiModels({ CODEMIE_BASE_URL:'https://example.invalid/api', CODEMIE_MODEL:'claude-sonnet-5' }, '<tmp>'); console.log('launch proceeds'); }
catch (e) { console.log('THREW ->', e.message); }
"
```

**End-to-end pricing.** Same harness without the sabotage, driving `fetchAndBuildPiModels` for `gpt-4.1`, `claude-sonnet-5` and an unpriced id, then reading each back with `ModelRuntime.getModel`. Reported expectations, to verify:

| Model | Expected resolved `cost` |
|---|---|
| `codemie-proxy/gpt-4.1` | `{"input":2,"output":8,"cacheRead":0.5,"cacheWrite":2}` |
| `codemie-anthropic/claude-sonnet-5` | `{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}` |
| an unpriced id | four zeros from Pi's default, with **no** `cost` key in the file |

Also reported: of the 44 ids the live API currently yields, 34 price and 10 do not (`deepseek-r1`, `gpt-image-1.5`, `gpt-image-2`, `gemini-3.1-flash-image`, `gemini-3.5-flash`, `gemini-3.6-flash`, `qwen.qwen3-coder-30b-a3b-v1`, `qwen.qwen3-coder-next`, `claude-4-5-sonnet-vertex`, `claude-4-5-sonnet`), and all 44 load with none dropped. The stale `.pi/codemie/agent/models.json` at the repo root predates the fix — use it only as a source of ids, never as a result.

Cheap regression check (a bad `cost` block drops every CodeMie model from the listing):

```bash
PI_CODING_AGENT_DIR=<tmp>/.pi/codemie/agent PI_OFFLINE=1 pi --list-models claude-sonnet-5
# expect a row: codemie-anthropic  claude-sonnet-5
```

Clean up your temp dirs. Do not modify the repository's own `.pi/` directory, and restore anything you move inside `dist/`.

---

## 10. Deliverable

A single Markdown report containing:

1. **Verdict** — `APPROVE`, `APPROVE WITH MINOR FINDINGS`, or `CHANGES REQUIRED`, with one sentence of justification.
2. **Gate results** — a table of every command from section 9 with its actual outcome. Mark explicitly anything you could not run, and why.
3. **Round-1 closure** — for each of these, state closed / not closed / partially closed, with the evidence you produced: (a) the finite-overflow defect that invalidated the whole model file; (b) the price-table read failure aborting the agent launch; (c) the plugin importing upward into the CLI layer; (d) the zero-versus-table discoverability recommendation; (e) the inaccurate "never reach the file" comment in the test header.
4. **Findings**, most severe first: severity (`blocker` / `major` / `minor` / `nit`), `file:line`, one sentence stating the defect, and a **concrete failure scenario** with specific inputs or state leading to specific wrong output. A finding with no reachable failure scenario is an observation — label it as such.
5. **Section 8 checklist** — each of the 13 concerns with an explicit verdict and its evidence.
6. **Claims audit** — any statement in sections 4 or 5 of this prompt, in either commit message, or in `remediation-plan.md`'s outcome table that you found inaccurate. This matters as much as code defects.
7. **Explicitly not reviewed** — what you left alone because section 7 puts it out of scope, so the reader knows the boundary held.

Rules: cite `file:line` for every claim about code. Distinguish "verified by running X" from "appears correct by inspection". No padding, no praise. Propose nothing out of scope — if something out of scope genuinely worries you, put it in one short "adjacent observations" list at the very end, clearly separated from findings and with no recommendation to act now.
