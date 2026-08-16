# Independent Review Report (Round 2) — Pi model `cost` sections

Review date: 2026-08-16  
Branch: `feat/pi-model-cost-sections`  
Base: `23aa8d21f17428eb545ea4d515b71aead4b4b8e3` (`main`)  
Reviewed HEAD: `c25430f35d2195e47d202a4676aceca23aec009c`

## Verdict

**APPROVE WITH MINOR FINDINGS** — the generated model list now passes Pi's schema, loads all reviewed models, and produces the expected costs, but an unavailable pricing asset silently restores zero-cost reporting and one canonical documentation reference still points to the old asset location.

## Gate results

| Command / check | Result | Actual outcome |
|---|---|---|
| `git log --oneline main..HEAD` | PASS, prompt discrepancy | Exit 0. Output contained **three**, not two, commits: `c25430f docs(agents)`, `40f3282 feat(agents)`, and `a2a6881 refactor(utils)`.
| `git diff main..HEAD --stat` | PASS | Exit 0. `17 files changed, 1192 insertions(+), 12 deletions(-)`; this includes the committed review artifacts and `docs/COMMANDS.md`.
| `git diff -M main..HEAD -- src/utils/pricing.ts src/utils/model-normalizer.ts` | PASS command; expected output was inaccurate | Exit 0, but the command displayed both destination files as new files because its pathspec excludes the old paths. Re-running rename-aware diff with both old and new paths reported `model-normalizer.ts` as 100% similar and `pricing.ts` as 97% similar with only its three import paths changed. A normalized `diff` produced no output, and `cmp` reported `model-normalizer byte-identical: true`.
| `git status --short` | PASS at review gate | No output before this report was written: the branch was clean. This report is the sole review-session filesystem addition.
| `npm run ci` | PASS | Exit 0. License check, lint, build, unit tests, and integration tests completed. Unit: 208 files / 3,068 tests passed. Integration: 29 files passed, 1 skipped; 205 tests passed, 10 skipped. npm/Node emitted only environment warnings.
| `rm -rf dist && npm run build && find dist -name pricing.json` | PASS | Exit 0. Clean `tsc`, `tsc-alias`, and asset copy completed; `find` printed only `dist/utils/pricing.json`. A separate existence check confirmed the old `dist/cli/commands/analytics/cost/pricing.json` path is absent. The copy rule is `scripts/copy-plugins.js:55-66`.
| Overflow probe: API `input: 1e308` | PASS | Converted input was `2`, finite was `true`, serialized JSON contained no `null`, Pi loaded `codemie-proxy/gpt-4.1`, and runtime cost was `{"input":2,"output":8,"cacheRead":0.5,"cacheWrite":2}`.
| Overflow probe: API `input: Number.MAX_VALUE` | PASS | Same result as `1e308`: input fell back to `2`, remained finite, JSON contained no `null`, and Pi loaded the model with the expected cost.
| Missing-asset probe | PASS for launch continuity | With `dist/utils/pricing.json` moved aside, `fetchAndBuildPiModels` wrote `claude-sonnet-5` without a `cost` key and printed `launch proceeds`; it did not throw. SHA-256 before/after confirmed `asset restored: true`.
| Three-model end-to-end generation and `ModelRuntime.getModel` | PASS | `gpt-4.1` loaded as `{2,8,0.5,2}`; `claude-sonnet-5` loaded as `{3,15,0.3,3.75}`; `review-unpriced-model` had no file-level `cost` key and loaded with four runtime zeros. `ModelRuntime.getError()` returned none.
| 44-model whole-file load | PASS | Using the stale repository config only as an ID source: 44 generated, 34 priced, 10 unpriced, 0 dropped, no runtime error. The unpriced IDs exactly matched the ten listed in the prompt.
| `PI_CODING_AGENT_DIR=<tmp>/.pi/codemie/agent PI_OFFLINE=1 pi --list-models claude-sonnet-5` | PASS | Printed the expected `codemie-anthropic  claude-sonnet-5` row.
| Installed Pi cost-math probe | PASS | One million input, output, cache-read, and short cache-write tokens for generated `gpt-4.1` produced `{"input":2,"output":8,"cacheRead":0.5,"cacheWrite":2,"total":12.5}`, consistent with Pi's calculation at `/home/taras_spashchenko/TS/github/pi/packages/ai/src/models.ts:878-897`.
| Static fallback probe | PASS | A failed live fetch with `CODEMIE_MODEL=gpt-4.1` wrote `{2,8,0.5,2}`, confirming the disclosed static-fallback behavior through `src/agents/plugins/pi/pi.models.ts:303-316,336-345`.
| Focused unit suite | PASS | `npx vitest run --project unit src/agents/plugins/pi/__tests__/pi.models.test.ts`: 1 file / 15 tests passed.
| Commitlint and whitespace | PASS | `npx commitlint --from main --to HEAD --verbose` found 0 problems for all three commits; `git diff --check main..HEAD` exited 0 with no output. Commit constraints are defined at `commitlint.config.cjs:6-57`.
| Scratch cleanup | PASS | Every scratch directory used a `/tmp/pi-r2-*` prefix and an exit trap. The repository's `.pi/` directory was read only; the temporarily moved built asset was restored.

## Round-1 closure

| Round-1 item | Status | Evidence |
|---|---|---|
| Finite multiplication overflow invalidated the whole model file | **Closed** | `resolveRate` now checks the scaled product before returning it at `src/agents/plugins/pi/pi.models.ts:131-141`. Fresh probes for `1e308` and `Number.MAX_VALUE` produced finite fallback rate `2`, no serialized `null`, and a model Pi could load. Pi still rejects an entire invalid file at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/model-config.ts:246-284`, so the successful probe exercises the original failure boundary.
| Price-table read failure aborted agent launch | **Closed** | `vendoredPrice` catches lookup failure at `src/agents/plugins/pi/pi.models.ts:144-158`; the missing-asset probe wrote a config and returned. The remaining lack of a persistent diagnostic is Finding 1, but the launch-abort defect itself is closed.
| Plugin imported upward into the CLI layer | **Closed** | The plugin imports `../../../utils/pricing.js` at `src/agents/plugins/pi/pi.models.ts:6-7`; all four analytics consumers point to `@/utils/...`; no source import of either old path remains. This now follows the documented Plugin-to-Utils direction at `.ai-run/guides/architecture/architecture.md:65-87`.
| Zero-versus-table behavior was not discoverable | **Closed** | The comment explicitly states that API zero suppresses the table at `src/agents/plugins/pi/pi.models.ts:126-130`, and the regression test supplies API input/output zero with nonzero table cache rates at `src/agents/plugins/pi/__tests__/pi.models.test.ts:225-239`.
| Test header inaccurately claimed hostile values never reached the file | **Closed** | The header now says the unit tests protect the emitted entry and explicitly assigns serialized-file loading to the external harness at `src/agents/plugins/pi/__tests__/pi.models.test.ts:1-16`.

## Findings

### Minor — pricing-asset failure silently recreates zero-cost reporting

- **Location:** `src/agents/plugins/pi/pi.models.ts:150-156`
- **Defect:** the catch correctly preserves agent launch, but records the loss of the fallback price source only through `logger.debug`, which does nothing unless `CODEMIE_DEBUG` is enabled at `src/utils/logger.ts:260-297`.
- **Concrete failure scenario:** install or package CodeMie without `dist/utils/pricing.json`, receive an API model with optional `LlmModel.cost` absent, and launch `codemie-pi` without `CODEMIE_DEBUG`. Every lookup throws at `src/utils/pricing.ts:36-40`, every field falls through to zero at `src/agents/plugins/pi/pi.models.ts:131-141`, the all-zero block is omitted at `src/agents/plugins/pi/pi.models.ts:168-178`, and Pi normalizes it to four zeros at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/provider-composer.ts:150-160`. The reproduced launch proceeds, but the operator gets neither a cost nor a retained diagnostic and sees the original `$0` symptom. The API shape permits absent cost at `src/providers/plugins/sso/sso.http-client.ts:32-46`.
- **Required correction:** retain the graceful fallback, but record the table-load failure once at a non-debug level rather than discarding it or emitting one message per model.

### Nit — the canonical refresh instruction names the removed asset path

- **Location:** `docs/COMMANDS.md:638-640`
- **Defect:** the main cost-estimation paragraph names `src/utils/pricing.json` at `docs/COMMANDS.md:615-623`, but the refresh block still tells maintainers to edit `cost/pricing.json`.
- **Concrete failure scenario:** a maintainer follows the refresh block after this relocation and searches the former analytics-cost directory; the clean build proved that path no longer exists, so the documented update target cannot be used.
- **Required correction:** name `src/utils/pricing.json` consistently in the refresh block.

## Section 8 checklist

### 1. Overflow defect

**Closed.** Both required values were reproduced. API values are checked before multiplication, the product is checked after multiplication, and only a validated product is returned at `src/agents/plugins/pi/pi.models.ts:117-141`. Neither serialized probe contained `null`; installed Pi loaded both models. The only changed arithmetic is multiplication at `src/agents/plugins/pi/pi.models.ts:121-123`, and its result flows through the check at lines 133-136 before assignment.

### 2. `vendoredPrice` catch breadth and logging

**Launch behavior is correct; diagnostic behavior has a minor defect.** A missing asset is reachable because the lookup reads synchronously on first use at `src/utils/pricing.ts:34-40`, and the plugin invokes model generation from unguarded `beforeRun` at `src/agents/plugins/pi/pi.plugin.ts:302-307`. Catching the lookup boundary broadly is proportional: cost enrichment must not prevent an agent session, and the downstream rate validator prevents malformed table values from reaching Pi at `src/agents/plugins/pi/pi.models.ts:131-141`. However, the `debug` call at `src/agents/plugins/pi/pi.models.ts:153-155` is entirely suppressed outside debug mode by `src/utils/logger.ts:280-297`, allowing a systematically unpriced fleet to be silent; see Finding 1.

### 3. Relocation completeness

**Code and build relocation complete; one documentation reference incomplete.** Rename-aware diff showed `src/utils/model-normalizer.ts` byte-identical and `src/utils/pricing.ts` changed only at imports `src/utils/pricing.ts:9-13`. Moved tests still import their adjacent modules; source search found no old source imports. TypeScript resolves `@/*` at `tsconfig.json:24-27`, Vitest defines the alias in every project at `vitest.config.ts:41-43,63-65,85-87`, and full CI passed both compiler and test consumers. A clean build copied only `dist/utils/pricing.json` through `scripts/copy-plugins.js:55-66`. `docs/COMMANDS.md:638-640` is the sole current, non-historical stale path found; historical task artifacts outside this directory were excluded as directed.

The mandated destination-only diff command does not prove byte preservation: it displays additions because the old paths are outside the pathspec. This is a review-prompt command defect, not a source defect.

### 4. Unit conversion and field mapping

**Correct.** The existing CodeMie integration documents API dollars per token and multiplies by one million at `src/agents/plugins/opencode/opencode-dynamic-models.ts:90-107`; the Pi code applies that conversion only to API values at `src/agents/plugins/pi/pi.models.ts:121-136`. Vendored values are already per million at `src/utils/pricing.ts:1-21` and pass directly through the independently validated fallback at `src/agents/plugins/pi/pi.models.ts:138-140`, so they are not scaled twice. Pi defines all four rates as dollars per million at `/home/taras_spashchenko/TS/github/pi/packages/ai/src/types.ts:776-790` and divides them by one million at `/home/taras_spashchenko/TS/github/pi/packages/ai/src/models.ts:878-897`.

`cache_read_input_token_cost` maps to `cacheRead`, and `cache_creation_input_token_cost` / vendored `cacheCreation` map to `cacheWrite` at `src/agents/plugins/pi/pi.models.ts:168-175`; the table maps raw `cacheWrite` to `cacheCreation` at `src/utils/pricing.ts:46-51`. Dropping `cacheWrite1h` is correct because Pi exposes no such rate and bills long writes as input times two at `/home/taras_spashchenko/TS/github/pi/packages/ai/src/models.ts:889-895`.

### 5. Schema conformance under all paths

**Correct.** Pi makes `cost` optional but requires all four numeric base rates whenever it is present at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/model-config.ts:142-165`; invalid input empties the entire loaded provider map at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/model-config.ts:246-284`. `resolveModelCost` always constructs four keys at `src/agents/plugins/pi/pi.models.ts:168-175`. API and table candidates must be numbers, finite, and nonnegative, and the API product is rechecked at `src/agents/plugins/pi/pi.models.ts:117-141`. Thus strings, `null`, negative numbers, non-finite values, and overflow resolve to a validated table value or numeric zero. If all four are zero, no block is attached at `src/agents/plugins/pi/pi.models.ts:177-178,212-215`. The 44-model runtime probe returned zero config errors and zero dropped models.

### 6. Zero-versus-absent semantics

**Faithful and discoverable.** Zero passes `isValidRate`, is scaled to zero, and is returned before table fallback at `src/agents/plugins/pi/pi.models.ts:117-139`. The comment documents the consequence at `src/agents/plugins/pi/pi.models.ts:126-130`, and the explicit-zero test pins `{input:0, output:0}` while retaining table-derived cache rates at `src/agents/plugins/pi/__tests__/pi.models.test.ts:225-239`.

### 7. Silent inexact pricing

**Known approved risk; no implementation defect filed.** `lookupPrice` documents exact, longest-family, then same-tier Claude fallback and logs inexact matches at `src/utils/pricing.ts:144-175`. Fresh probes showed `gpt-5.7-codex` resolving to `{1.25,10,0.125,1.25}` and `claude-sonnet-99` to `{3,15,0.3,3.75}` plus its unused one-hour rate. A future family whose pricing changes can therefore be confidently mispriced. That behavior is inherent in the approved vendored-table fallback and matches the pre-existing analytics consumer, which treats every non-null lookup as priced at `src/cli/commands/analytics/cost/cost-enricher.ts:119-130`; changing the matching policy would re-litigate the selected source strategy.

### 8. Omit-when-all-zero

**Runtime-equivalent.** Pi normalizes a missing block to `{input:0, output:0, cacheRead:0, cacheWrite:0}` at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/provider-composer.ts:150-160`. Model overrides operate on that normalized object at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/provider-composer.ts:103-120`, cache statistics read only the runtime `cost.cacheRead` at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/cache-stats.ts:73-87`, and availability reads the composed provider models at `/home/taras_spashchenko/TS/github/pi/packages/ai/src/models.ts:522-541`. The end-to-end probe confirmed an absent file key, four runtime zeros, model presence, and no runtime error.

### 9. Guard proportionality

**Proportional; no remaining malformed-cost gap found.** Runtime API data is only asserted as `LlmModel[]` after `JSON.parse` at `src/providers/plugins/sso/sso.http-client.ts:77-102`, so type, string, negative, and non-finite checks are justified. A large valid JSON exponent or multiplication can yield infinity; the required probes verified the product guard. A missing/corrupt built asset was reproduced, justifying the catch. The broad catch preserves the session, while all rate assignments still pass through `isValidRate` at `src/agents/plugins/pi/pi.models.ts:117-141`. The logging level, not the guard itself, is Finding 1.

### 10. Blast radius

**No compatibility defect found.** `PiModelEntry.cost` is optional and `PiModelCost` adds no required property to existing call sites at `src/agents/plugins/pi/pi.models.ts:40-65`. The converter attaches cost without changing classification, limits, reasoning, input modalities, or compat at `src/agents/plugins/pi/pi.models.ts:181-217`. `buildModelsConfig` retains entry objects while bucketing them at `src/agents/plugins/pi/pi.models.ts:254-300`; `fetchAndBuildPiModels` still filters enabled models and serializes the same provider structure at `src/agents/plugins/pi/pi.models.ts:319-354`. Full CI and the 44-model probe exercised both provider buckets. The static fallback now acquiring table pricing through `createSyntheticLlmModel` and the converter at `src/agents/plugins/pi/pi.models.ts:303-316` is disclosed and was reproduced. The four analytics changes are import-only, and the moved implementations are behavior-preserving.

### 11. Test quality

**Adequate unit coverage; permanent integration coverage remains an observation.** The focused suite passed all 15 tests. It pins all four API conversions, API precedence, per-field/table fallback, exact four-key shape, omission, hostile values, pre/post-scaling overflow, table failure, explicit zero, and unchanged non-cost fields at `src/agents/plugins/pi/__tests__/pi.models.test.ts:50-254`. Mocking `lookupPrice` at `src/agents/plugins/pi/__tests__/pi.models.test.ts:24-29` appropriately isolates conversion semantics from a refreshable data file and follows the module-mocking guidance at `.ai-run/guides/testing/testing-patterns.md:42-55`.

No committed test serializes through `fetchAndBuildPiModels`, loads Pi, or exercises multi-model provider bucketing; the test header accurately discloses that boundary at `src/agents/plugins/pi/__tests__/pi.models.test.ts:1-16`. Fresh manual end-to-end and 44-model probes cover the current branch, but not future regressions. Because no present behavior is wrong, this is an observation rather than a severity-rated finding.

### 12. Conventions and hygiene

**Conformant except for Finding 2.** Changed TypeScript uses ESM `.js` imports, `import type`, interfaces for object shapes, explicit return types on exports, `unknown` rather than `any`, single-purpose helpers, and `logger` rather than `console` at `src/agents/plugins/pi/pi.models.ts:1-217`, consistent with `.ai-run/guides/standards/code-quality.md:20-49,93-110,128-152`. No orphaned old-path import or dead cost helper remains. `git diff --check` passed. All three actual commit messages use allowed types/scopes and satisfy configured lengths; commitlint verified them against `commitlint.config.cjs:6-57`. The stale current documentation reference is Finding 2.

### 13. Reported bug

**Fixed in the normal supported build.** The three-model probe read the expected file costs back through installed Pi, the 44-model probe loaded every generated entry, the CLI listing retained `claude-sonnet-5`, and Pi calculated `$12.50` for one million tokens in each `gpt-4.1` bucket. The config is written before `PI_CODING_AGENT_DIR` is assigned at `src/agents/plugins/pi/pi.plugin.ts:302-307`; CodeMie writes `<cwd>/.pi/codemie/agent/models.json` through `src/agents/plugins/pi/pi.paths.ts:11-16`, and Pi resolves its environment-controlled agent directory and `models.json` at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/config.ts:494-530`. The only reviewed degradation is the silent missing-asset condition in Finding 1.

## Claims audit

### Prompt sections 4 and 5

- **Ground-truth Pi claims verified.** The required/optional schema is at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/model-config.ts:142-165`; whole-file rejection is at lines 246-284; zero defaulting and per-field override merging are at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/provider-composer.ts:103-120,150-160`; rates and optional tiers are at `/home/taras_spashchenko/TS/github/pi/packages/ai/src/types.ts:776-790`; division by one million and long-write input-times-two logic are at `/home/taras_spashchenko/TS/github/pi/packages/ai/src/models.ts:878-897`; agent-dir/model-path resolution is at `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/config.ts:494-530`.
- **The branch-state claim is stale.** The prompt says two commits and untracked docs; actual HEAD is three commits ahead, and the docs plus `docs/COMMANDS.md` are committed in `c25430f`. `git status --short` was empty before this report.
- **The destination-only rename command's expectation is false.** `git diff -M main..HEAD -- src/utils/pricing.ts src/utils/model-normalizer.ts` cannot show the old sides excluded by its pathspec, so it displays full additions rather than “only import lines.” Including both old/new paths proves the stated move preservation.
- **The implementation description is otherwise accurate.** The five files are renames; only `pricing.ts` imports changed; analytics consumers, copy destination, four-rate mapping, per-field resolution, zero omission, post-scale validation, static fallback, and the 34/10 coverage split all matched inspection and fresh probes.

### Commit messages

- `a2a6881`'s “no logic changed” claim is accurate: normalized diff found only the three moved import paths in `src/utils/pricing.ts:9-13`, and `src/utils/model-normalizer.ts` was byte-identical.
- `40f3282`'s schema, overflow, graceful lookup failure, ordinary cost, and 34/44 load claims were independently reproduced. Its phrase “degrades to no vendored price” is accurate, though the degradation's diagnostic is insufficient as described in Finding 1.
- `c25430f` accurately says it stores the review artifacts and repoints the main cost-estimation note at `docs/COMMANDS.md:615-623`; it does not disclose that the separate refresh instruction at `docs/COMMANDS.md:638-640` remains stale.

### Remediation-plan outcome

- The outcome table at `docs/superpowers/tasks/2026-08-16-pi-model-cost-sections/remediation-plan.md:158-172` matches the fresh CI, overflow, asset, three-model, 44-model, and CLI results.
- The rationale at `docs/superpowers/tasks/2026-08-16-pi-model-cost-sections/remediation-plan.md:83` is inaccurate: `logger.warn` does not “print” a visible warning in the current logger implementation—it writes to the log at `src/utils/logger.ts:309-312`—while `logger.debug` is fully suppressed unless debug mode is enabled at `src/utils/logger.ts:280-297`. The assertion that missing cost data is self-evident is also false in the reproduced failure: Pi reports the same four runtime zeros as a genuinely free model.
- “Nothing committed” at `docs/superpowers/tasks/2026-08-16-pi-model-cost-sections/remediation-plan.md:176` was a point-in-time statement subsequently superseded by the user's explicit commit request, not evidence of an implementation discrepancy.

## Explicitly not reviewed

- Codex and Kimi model-cost behavior.
- OpenCode behavior except as evidence for CodeMie's established API cost units.
- `pricing.ts` / `model-normalizer.ts` algorithm quality or `pricing.json` contents beyond relocation preservation and the caller-visible fallback behavior.
- Refreshing or extending `pricing.json`.
- Upstream Pi changes; Pi was read and executed only as the consumer specification.
- Session metrics, transcript sync, run ledger, or analytics-report behavior beyond confirming import-only relocation and existing exactness semantics.
- Pushing, PR creation, changelog, versioning, and merge strategy.
- Historical task artifacts outside this task directory.
- Broad refactors outside the reviewed diff.
