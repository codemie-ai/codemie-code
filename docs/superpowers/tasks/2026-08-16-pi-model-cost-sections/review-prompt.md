# Independent Review Prompt — Pi model `cost` sections

You are an independent reviewer. Another agent implemented a fix; your job is to judge whether that fix is correct, complete, safe, and conformant to this repository's conventions. You did not write this code and you owe it no benefit of the doubt.

**You are read-only.** Do not edit, stage, commit, or revert anything. Do not "fix while you're in there". Produce findings; the implementer applies them.

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

---

## 2. Where everything is

| What | Where |
|---|---|
| Implementation repo | `/home/taras_spashchenko/EPAM/codemie-ai/codemie-code` |
| Branch under review | `feat/pi-model-cost-sections` (branched from `main`, base commit `23aa8d2`) |
| Upstream Pi source (the consumer of the generated config) | `/home/taras_spashchenko/TS/github/pi` |
| Installed Pi binary used for end-to-end checks | `pi` 0.84.2, global npm at `/home/taras_spashchenko/.nvm/versions/node/v22.21.0/lib/node_modules/@earendil-works/pi-coding-agent` |
| Approved implementation plan | `/home/taras_spashchenko/.claude/plans/codemie-code-provides-a-virtual-melody.md` |

Review target — the branch carries **no commits** (repo policy: commits only on request), so `git diff main...feat/pi-model-cost-sections` is empty and `main` and `HEAD` are the same object. Review the working tree instead:

```bash
git status --short                              # renames are staged by `git mv`; edits are unstaged
git diff HEAD -- src scripts                    # tracked changes, staged and unstaged
```

**Untracked paths will NOT appear in any diff.** Read them directly:
`src/agents/plugins/pi/__tests__/pi.models.test.ts` and this task directory.

Everything the diff and those paths show is in scope. Nothing else was changed.

---

## 3. The bug being fixed

`codemie-pi` regenerates `<cwd>/.pi/codemie/agent/models.json` on every run (`fetchAndBuildPiModels` in `src/agents/plugins/pi/pi.models.ts`, invoked from `pi.plugin.ts`'s `lifecycle.beforeRun`). Before this change, every emitted model entry omitted the `cost` block, so Pi silently priced every CodeMie model at zero and reported `$0.00` for all token usage.

Confirmed pre-fix baseline, read back through Pi's own runtime:

```
codemie-proxy/gpt-4.1             {"input":0,"output":0,"cacheRead":0,"cacheWrite":0}
codemie-anthropic/claude-sonnet-5 {"input":0,"output":0,"cacheRead":0,"cacheWrite":0}
```

---

## 4. Ground truth about Pi's requirements

These were established by reading the upstream source. **Treat them as claims to verify, not as given** — if any is wrong, the implementation built on it is wrong, and that is a blocking finding.

| Claim | Cited evidence in `/home/taras_spashchenko/TS/github/pi` |
|---|---|
| The field is a nested `cost` object whose four required rates are `input`, `output`, `cacheRead`, `cacheWrite`, plus an optional `tiers` array | `packages/ai/src/types.ts:776-791` (`ModelCostRates`, `ModelCostTier`, `ModelCost`) |
| Units are USD per 1,000,000 tokens | `packages/ai/src/models.ts:878-898` (`calculateCost` divides each rate by `1000000`) |
| In `models.json` the `cost` block is optional, but when present all four rates are required numbers | `packages/coding-agent/src/core/model-config.ts:142-171` (TypeBox `ModelCostSchema`, `ModelDefinitionSchema`) |
| A schema violation rejects the entire file, not the offending entry | `ModelConfig.load`, `model-config.ts:246-285` |
| A missing `cost` block defaults to all zeros — silent, no error | `packages/coding-agent/src/core/provider-composer.ts:159` |
| Pi has no rate field for 1-hour cache writes; it bills them as `input × 2` | `packages/ai/src/models.ts:890-895` |
| `tiers` is optional and defaults to absent | `model-config.ts:152-155`; `calculateCost` iterates `model.cost.tiers ?? []` |
| Per-field `??` merging is Pi's own idiom for cost overrides | `provider-composer.ts:103-128` (`applyModelOverride`) |
| Config path Pi reads | `<agentDir>/models.json`, where agentDir comes from `PI_CODING_AGENT_DIR` (CodeMie sets it to `<cwd>/.pi/codemie/agent`) |

---

## 5. What was implemented

### `src/agents/plugins/pi/pi.models.ts` (the only production file with behavior changes)

1. New exported `PiModelCost` interface — `input`, `output`, `cacheRead`, `cacheWrite`, all required.
2. `cost?: PiModelCost` added to the existing `PiModelEntry` interface.
3. Static import of `lookupPrice` (and the `ModelPrice` type) from `../../../utils/pricing.js`.
4. Five module-private helpers inserted between `isReasoningModel` and `convertLlmModelToPiEntry`:
   - `isValidRate(value): value is number` — `typeof === 'number' && Number.isFinite(value) && value >= 0`.
   - `toPerMillion(value)` — `value * 1_000_000`.
   - `resolveRate(apiPerToken, vendoredPerMillion)` — the converted API value wins **only if the product also passes `isValidRate`**, then the vendored value, then `0`.
   - `vendoredPrice(id)` — `lookupPrice` wrapped so an unreadable price asset logs at debug and returns `null` instead of throwing out of `beforeRun`.
   - `resolveModelCost(model, id): PiModelCost | undefined` — builds all four rates; returns `undefined` when all four are `0`.
5. `convertLlmModelToPiEntry` assigns `entry.cost` when `resolveModelCost` returns a value, immediately before `return entry`.

### Relocation of the price table (round 2, in response to the layering finding)

`pricing.ts`, `pricing.json` and `model-normalizer.ts` moved from `src/cli/commands/analytics/` to `src/utils/` (with their tests to `src/utils/__tests__/`), so the plugin no longer imports upward into the CLI layer. Analytics consumers (`cost-enricher.ts`, `cost-calculator.ts`, `otel-loader.ts`, `aggregator.ts`) were repointed to `@/utils/…`, and the `scripts/copy-plugins.js` asset rule now copies `src/utils/pricing.json` to `dist/utils/pricing.json`. No logic inside the moved files changed apart from their own import paths.

### Two price sources, both pre-existing in the repo

- **Primary — the CodeMie models API.** `LlmModel.cost` in `src/providers/plugins/sso/sso.http-client.ts:32-57`: `{ input?, output?, cache_read_input_token_cost?, cache_creation_input_token_cost? }`, in USD **per token**. Already fetched by `pi.models.ts`; previously ignored. The `× 1_000_000` conversion mirrors `src/agents/plugins/opencode/opencode-dynamic-models.ts:90-138` (`toPerMillion`), which already does this for the OpenCode plugin.
- **Fallback — the vendored price table.** `lookupPrice(id)` in `src/utils/pricing.ts`, returning `{input, output, cacheRead, cacheCreation, cacheWrite1h?}` already in USD per million. `cacheCreation` maps to Pi's `cacheWrite`; `cacheWrite1h` is dropped. Measured coverage against the 44 model ids the live API currently yields: 34 priced, 10 not.

### Design decisions and their stated rationale

| Decision | Rationale given |
|---|---|
| Per-field resolution rather than whole-block preference | Mirrors Pi's own `applyModelOverride` per-field `??` merge; a payload with only `input`/`output` still gets cache rates from the table |
| Omit the `cost` block entirely when all four rates resolve to `0` | Functionally identical to Pi's own default, so an unpriced model behaves exactly as before; emitting explicit zeros would assert "this model is free", a different claim from "we have no price" |
| Reject non-numeric / non-finite / negative API values, **and re-check the scaled product** | The field is typed `number` but arrives via `JSON.parse` of an HTTP response; a `NaN` serializes to `null` and makes Pi reject the whole file. Screening the payload alone is insufficient — a finite `1e308` overflows to `Infinity` during the per-million conversion, which is the round-1 defect this now closes |
| A price-table read failure degrades to "no vendored price" | `lookupPrice` reads a vendored asset on first call and this runs inside the plugin's unguarded `beforeRun`, so a throw would abort the user's session over missing metrics |
| No rounding of the `× 1_000_000` product | Consistent with the existing OpenCode helper and with Pi's own generated catalogs, which contain values like `0.19999999999999998` |
| `tiers` not emitted | No CodeMie data source for tiered pricing; the field is optional |
| `cacheWrite1h` dropped | Pi has no such rate field |
| Static (not dynamic) import of `lookupPrice` | `pricing.ts` already defers its disk read to a memoized first call, so a dynamic import buys nothing and would force `convertLlmModelToPiEntry` to become `async`, rippling into `buildStaticFallbackModel` and the `.map(convertLlmModelToPiEntry)` call site |
| Nothing else changed | `buildModelsConfig`, `PiModelsConfig`, `createSyntheticLlmModel`, `pi.plugin.ts`, `scripts/copy-plugins.js` and the guides were assessed as not needing edits; `cost` rides inside `PiModelEntry` and `pricing.json` is already copied to `dist` |

### Acknowledged behavior change

The static-fallback path (`buildStaticFallbackModel` → `createSyntheticLlmModel`, used when the live model fetch fails and `CODEMIE_MODEL` is set) previously always produced a free model. It now picks up vendored pricing when that id matches a table entry, because the synthetic `LlmModel` carries no `cost` and falls through to `lookupPrice`.

---

## 6. Decisions already made — do not re-litigate

The user was consulted and chose these. Report a **factual defect** in how a decision was implemented; do not argue the decision itself.

1. **Price source: API first, vendored table as per-field fallback.** The user explicitly picked this over "API only" and over "table only", and the option they selected specified `??` semantics: `input: api.input ?? table.input ?? 0`, with the block omitted when all four resolve to `0`.
2. **A unit test file was explicitly requested** (the repo's default policy is tests only on request, so its presence is correct, not a violation).
3. **Work happens on a new branch; no commits without being asked.** The branch exists and nothing is committed. That is the intended state.

---

## 7. Scope

### In scope

- `src/agents/plugins/pi/pi.models.ts` — the diff and its interaction with the rest of that file.
- `src/agents/plugins/pi/__tests__/pi.models.test.ts` — the new tests.
- Correctness of the emitted `models.json` against Pi's actual schema and cost math.
- Whether the fix actually achieves accurate token accounting in Pi, or only appears to.
- Whether the claims in section 4 and section 5 hold when you check them.
- Repository conventions as they apply to these two files.

### Out of scope — do not review, do not propose changes to

- The Codex plugin (`src/agents/plugins/codex/codex-models.ts`) and the Kimi plugin (`src/agents/plugins/kimi/kimi.models.ts`), which also ignore `LlmModel.cost`. Known, deliberately deferred.
- The OpenCode plugin and its model configs, except as a *precedent* you may cite.
- The price-table module and the analytics cost subsystem (`src/utils/pricing.ts`, `src/utils/model-normalizer.ts`, `src/cli/commands/analytics/cost/**`) — their internals, the matching heuristics' implementation, and the contents of `pricing.json` are pre-existing and unchanged apart from the relocation described above. You may evaluate whether *relying* on it here is sound; do not review its code quality or propose refactors to it.
- Refreshing, re-sourcing, or extending `pricing.json` to cover more models.
- Pi's upstream source. Read it as the specification; do not propose changes to it.
- Anything about session metrics, transcript sync, the run ledger, or CodeMie's own analytics reports.
- Commits, branch naming, PR creation, changelog, version bumps.
- Broad refactors of `pi.models.ts` beyond the lines this change touches (the repo mandates surgical changes: "Every changed line should trace directly to the user's request").

---

## 8. Specific areas of concern — address each explicitly

Give a verdict on every one of these, with evidence. Say "no issue found" where that is the answer.

1. **Unit conversion.** Is `× 1_000_000` correct in both direction and magnitude for every one of the four rates, given the API is per-token and Pi divides by `1e6`? Does anything double-convert a table value that is already per-million?

2. **Field mapping.** `cache_read_input_token_cost` → `cacheRead` and `cache_creation_input_token_cost` → `cacheWrite`: is that semantically right? Same question for `ModelPrice.cacheCreation` → `cacheWrite`. Is dropping `cacheWrite1h` correct given Pi computes 1h writes as `rates.input * 2 * longWrite` (`models.ts:895`), or does dropping it lose accuracy the task asked for?

3. **Schema conformance under all paths.** Can any input produce a `cost` block with fewer than four keys, a non-finite number, a `null`, a string, or a value `JSON.stringify` renders unparseable — thereby making Pi reject the whole `models.json` and drop *every* CodeMie model? Trace `resolveModelCost` exhaustively rather than trusting the claim that this is structurally impossible.

4. **Zero-versus-absent semantics.** `isValidRate(0)` is `true`, so an API payload that reports `cost: {input: 0, output: 0}` — plausible for a deployment that has the field but never populates it — suppresses the vendored fallback and yields no `cost` block at all, leaving the original bug in place for that instance. This follows the `??` semantics the user approved. Assess: is the implementation faithful to the approved semantics, and does the code or its comments make this consequence discoverable to the next maintainer? Recommend, do not unilaterally redesign.

5. **Silent inexact pricing.** `lookupPrice` falls back to a longest-segment family match and then to a latest-same-tier Claude match, signalling the inexactness only via `logger.debug` (`src/utils/pricing.ts`); its return type carries no exactness marker, and the existing analytics consumer (`cost-enricher.ts`) treats any non-null match as priced. So an inexact family price is written into Pi's config as authoritative. Is that acceptable for this use, and is a new or unrecognized model id (say a future `gpt-5.7-*`) at risk of being confidently mispriced?

6. **The omit-when-all-zero rule.** Verify the claim that omitting is byte-for-byte equivalent to Pi's default for an unpriced model. Is there any Pi code path that distinguishes "no `cost` key" from "`cost` present with zeros" — for example in `modelOverrides` merging, cache statistics (`packages/coding-agent/src/core/cache-stats.ts`), or model-availability logic?

7. **Guard proportionality.** Are `isValidRate`'s three conditions each justified by a reachable failure, or is any of them defensive code for an impossible scenario (the repo forbids that)? Conversely, is any reachable malformed input left unguarded?

8. **Layering.** The price table now lives in the Utils layer (`src/utils/pricing.ts` + `src/utils/pricing.json`, with `src/utils/model-normalizer.ts` moved alongside it because pricing depends on it), so the plugin imports downward per `.ai-run/guides/architecture/architecture.md`. Verify no module still imports the old `src/cli/commands/analytics/cost/pricing.js` or `analytics/model-normalizer.js` paths, that the analytics consumers were repointed, and that `pricing.json` still reaches `dist` — it is copied by the "Model pricing table" entry in `scripts/copy-plugins.js`. Confirm from a clean build (`rm -rf dist && npm run build`) that `dist/utils/pricing.json` exists and the old location does not, and that the built plugin loads it.

9. **Blast radius.** `PiModelEntry` and the new `PiModelCost` are exported. Does adding an optional field break any consumer? Are `buildModelsConfig`, `createSyntheticLlmModel`, `buildStaticFallbackModel`, `fetchAndBuildPiModels`, and `pi.plugin.ts` genuinely unaffected? Is the acknowledged fallback-path behavior change acceptable, and is anything else silently changed that was not disclosed?

10. **Test quality.** Do the tests pin the behaviors that matter, or do they merely restate the implementation? Judge the choice to mock `lookupPrice` rather than exercise the real table. What is missing — for instance the `tiers` absence, the exact JSON as written to disk, the multi-model file, or the interaction with `classifyPiModel`'s provider bucketing? Are the assertions right (note the deliberate `as unknown as number` for a hostile string input, and the use of `toBeCloseTo` for float products)? Do they follow `src/agents/plugins/pi/__tests__/` conventions and `.ai-run/guides/testing/testing-patterns.md`?

11. **Conventions.** `.ai-run/guides/standards/code-quality.md` and `.ai-run/guides/development/development-practices.md`: ES modules with `.js` extensions, explicit return types on exports, no `any`, `logger` not `console`, comments explaining *why*, small single-purpose functions, meaningful names. Also check that no unrelated line was touched and no orphaned import or dead code was introduced.

12. **Does it actually fix the reported bug?** The task's success criterion is that Pi can accurately account for token usage. Verify the end state yourself (section 9) rather than accepting the implementer's numbers.

---

## 9. Verification you must run

Run these and report actual output. Do not report a gate as passing without having run it.

```bash
cd /home/taras_spashchenko/EPAM/codemie-ai/codemie-code
git branch --show-current                 # expect: feat/pi-model-cost-sections
git diff main...feat/pi-model-cost-sections
git status --short                        # the test file is untracked; nothing should be committed

npm run typecheck
npm run lint
npm run build
npx vitest run --project unit src/agents/plugins/pi/__tests__/pi.models.test.ts
npm run test:unit
```

End-to-end through Pi's own runtime — this exercises the real conversion, the real pricing table, and Pi's real config validator, offline. It drives the exported `fetchAndBuildPiModels` via its fallback path (no CodeMie credentials required; the fetch failure is expected and logged):

```bash
PI_PKG=/home/taras_spashchenko/.nvm/versions/node/v22.21.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js
REPO=/home/taras_spashchenko/EPAM/codemie-ai/codemie-code
TMP=$(mktemp -d /tmp/pi-cost-review-XXXX)
for M in gpt-4.1 claude-sonnet-5 some-unpriced-model; do
  mkdir -p "$TMP/$M" && cd "$TMP/$M"
  PI_OFFLINE=1 node --input-type=module -e "
    const { fetchAndBuildPiModels } = await import('$REPO/dist/agents/plugins/pi/pi.models.js');
    await fetchAndBuildPiModels({ CODEMIE_BASE_URL: 'https://example.invalid/api', CODEMIE_MODEL: '$M' }, process.cwd());
    const { ModelRuntime } = await import('$PI_PKG');
    const rt = await ModelRuntime.create({ modelsPath: process.cwd() + '/.pi/codemie/agent/models.json' });
    for (const p of ['codemie-proxy','codemie-anthropic']) {
      const m = rt.getModel(p, '$M');
      if (m) console.log('$M', p, JSON.stringify(m.cost));
    }
  "
  cat "$TMP/$M/.pi/codemie/agent/models.json"
done
```

Reported expectations (verify, and flag any mismatch):

| Model | Expected resolved `cost` |
|---|---|
| `codemie-proxy/gpt-4.1` | `{"input":2,"output":8,"cacheRead":0.5,"cacheWrite":2}` |
| `codemie-anthropic/claude-sonnet-5` | `{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}` |
| `codemie-proxy/some-unpriced-model` | `{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}` — from Pi's default, with **no** `cost` key in the file |

Also reported: across the 44 model ids the live API currently yields, 34 resolve to a nonzero price and 10 do not (`deepseek-r1`, `gpt-image-1.5`, `gpt-image-2`, `gemini-3.1-flash-image`, `gemini-3.5-flash`, `gemini-3.6-flash`, `qwen.qwen3-coder-30b-a3b-v1`, `qwen.qwen3-coder-next`, `claude-4-5-sonnet-vertex`, `claude-4-5-sonnet`), and the whole 44-model file loads with no model dropped. Re-derive this if you want to confirm the multi-model file validates; the previously generated list of ids is in `.pi/codemie/agent/models.json` at the repo root (that file is stale and pre-dates the fix — it is a source of ids, not a result).

Cheap regression check that a schema violation would catch (a bad `cost` block drops every CodeMie model from the listing):

```bash
PI_CODING_AGENT_DIR="$TMP/claude-sonnet-5/.pi/codemie/agent" PI_OFFLINE=1 pi --list-models claude-sonnet-5
# expect a row: codemie-anthropic  claude-sonnet-5
```

Clean up your temp dirs. Do not modify the repo's own `.pi/` directory.

---

## 10. Deliverable

A single Markdown report with:

1. **Verdict** — one of `APPROVE`, `APPROVE WITH MINOR FINDINGS`, `CHANGES REQUIRED`. One sentence of justification.
2. **Gate results** — a table of every command from section 9 with its actual outcome (pass/fail plus the salient output). Explicitly mark anything you could not run and why.
3. **Findings**, most severe first. For each: severity (`blocker` / `major` / `minor` / `nit`), `file:line`, one sentence stating the defect, and a **concrete failure scenario** — specific inputs or state leading to specific wrong output. A finding without a reachable failure scenario is an observation, not a finding; label it as such.
4. **Section 8 checklist** — each of the 12 concerns with an explicit verdict and its evidence.
5. **Claims audit** — any statement in sections 4 or 5 of this prompt, or in the implementer's own summary, that you found to be inaccurate. This matters as much as code defects.
6. **Explicitly not reviewed** — anything you left alone because section 7 puts it out of scope, so the reader knows the boundary held.

Rules for the report: cite `file:line` for every claim about code. Distinguish "I verified this by running X" from "this appears correct by inspection". Do not pad with praise. Do not propose out-of-scope improvements, even good ones — if something out of scope genuinely worries you, put it in one short "adjacent observations" list at the very end, clearly separated from findings, with no recommendation to act now.
