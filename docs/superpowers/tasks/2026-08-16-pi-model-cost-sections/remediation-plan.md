# Remediation Plan — review findings on Pi model `cost` sections

Branch: `feat/pi-model-cost-sections` · Review report: `review-report.md` · Verdict received: **CHANGES REQUIRED**

> **Status: all items applied**, including the layering move that this plan had originally proposed deferring — the user directed that everything be addressed in this branch. See "Outcome" at the end for what shipped and the evidence for each item.

## Scope assessment of the review

The report held the boundary set in `review-prompt.md`. It filed exactly one severity-rated finding, both in the reviewed files; it declined to rate layering and the vendored-data audit as findings and moved them to observations; it proposed no work on Codex, Kimi, OpenCode, `pricing.json` contents, or upstream Pi; it changed no code. One documented deviation — it used `git diff -- <file>` after the prompt's `git diff main...branch` returned empty — was a correct adaptation to a faulty instruction in my prompt, and it disclosed it. **No scope drift.**

Two report claims were re-verified here before acting on them, rather than taken on trust. Both reproduce.

## Verification of the reported defects

**Overflow → invalid config (the Major finding).** Reproduced against the built plugin:

```
parsed finite: true
converted input: Infinity
serialized cost: {"input":null,"output":8,"cacheRead":0.5,"cacheWrite":2}
pi model present: false
```

`JSON.parse('{"input": 1e308}')` yields a finite number, `isValidRate` accepts it, `toPerMillion` overflows to `Infinity`, `JSON.stringify` writes `null`, and Pi's whole-file validation drops **every** CodeMie model. Confirmed real.

**Missing pricing asset aborts the launch (report's adjacent observation #1).** With `dist/cli/commands/analytics/cost/pricing.json` removed:

```
RESULT: THREW -> Error: ENOENT: no such file or directory, open '.../dist/cli/commands/analytics/cost/pricing.json'
```

`lookupPrice` is called unconditionally for every model, `pricing.ts`'s `table()` does an unguarded `readFileSync`, and the throw escapes `fetchAndBuildPiModels`. The `.map(convertLlmModelToPiEntry)` call sits inside that function's `try`, so the throw diverts into the static-fallback path — which calls the same converter and throws again, this time uncaught. `pi.plugin.ts:302-329` does not guard `beforeRun`, so **`codemie-pi` fails to launch at all**. Before this change nothing in that path could fail on a missing asset. The report classified this as "not a present defect" because the asset currently ships; I rate it higher — the failure mode is a dead coding session, and the guard costs four lines.

---

## R1 — Validate the converted rate (Major, required)

**File:** `src/agents/plugins/pi/pi.models.ts:122-134`

`resolveRate` validates its input and then discards that guarantee by returning an unvalidated product. Validate the result and let a non-finite product fall through like any other unusable value:

```ts
function resolveRate(apiPerToken: unknown, vendoredPerMillion: number | undefined): number {
  if (isValidRate(apiPerToken)) {
    const perMillion = toPerMillion(apiPerToken);
    if (isValidRate(perMillion)) {
      return perMillion;
    }
  }
  if (isValidRate(vendoredPerMillion)) {
    return vendoredPerMillion;
  }
  return 0;
}
```

Reusing `isValidRate` on the product keeps one definition of "a rate Pi will accept" and needs no new predicate. Also amend the `isValidRate` doc comment (`pi.models.ts:106-112`), which currently implies that screening the payload is sufficient: state that the multiplication itself can leave the accepted range, which is why the product is re-checked.

**Regression test** in `src/agents/plugins/pi/__tests__/pi.models.test.ts`, alongside the existing malformed-payload cases: a finite `1e308` input against a priced table must yield the table's rate, and every emitted rate must satisfy `Number.isFinite`. The existing hostile-input test only feeds values that were already invalid *before* conversion, which is exactly why this path escaped.

## R2 — A missing or corrupt price table must not stop the agent (recommended, verified)

**File:** `src/agents/plugins/pi/pi.models.ts:143-144`

Wrap the lookup so a pricing-asset failure degrades to "no vendored price" instead of aborting `beforeRun`:

```ts
/**
 * A price table we cannot read is a cost-reporting problem, not a reason to refuse to launch
 * the agent: `lookupPrice` reads a vendored JSON asset on first call, and this runs inside
 * `beforeRun`, where a throw takes the user's whole session with it.
 */
function vendoredPrice(id: string): ModelPrice | null {
  try {
    return lookupPrice(id);
  } catch (error) {
    logger.debug(`[pi-models] Price table unavailable for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
```

`resolveModelCost` calls `vendoredPrice(id)` instead of `lookupPrice(id)`; needs `import type { ModelPrice }` from the same module. `logger.debug`, not `warn` — with 44 models a broken asset would otherwise print 44 warnings per launch, and the visible symptom (no cost data) is already self-evident in Pi.

This mirrors the philosophy already stated in this plugin's own extension (`src/agents/plugins/pi/extension/index.js:20-44`): metrics failures must never cost the user their session.

**Test:** mock `lookupPrice` to throw; assert `convertLlmModelToPiEntry` returns an entry (API-priced rates intact, `cost` omitted when the API gave nothing) rather than propagating.

## R3 — Make the zero-suppresses-table rule discoverable (minor, recommended)

The approved `??` semantics make an explicit `0` from the API authoritative, so it suppresses the vendored value for that field. The report confirmed the implementation is faithful and that fallback stays per-field, but nothing in the code or tests pins the consequence.

- One clause on the `resolveRate` comment (`pi.models.ts:122-125`): an explicit `0` from the API is a price, not a gap, so it wins over the table.
- One test: API `{input: 0}` against a priced table entry yields `input: 0` while `cacheRead`/`cacheWrite` still come from the table.

No behavior change — this is the approved semantics, documented.

## R4 — Fix an inaccurate sentence in the test header (nit, required)

`src/agents/plugins/pi/__tests__/pi.models.test.ts:1-15` says one test pins that hostile values "never reach the file". The suite asserts on the converted entry and never writes a file. Reword to "never reach the emitted entry"; the file-level guarantee is covered by the end-to-end harness, not here.

## R5 — Correct my own inaccurate claims in the task artifacts (required)

The claims audit is right on every count, and both artifacts are checked into this task directory where they will mislead the next reader.

In `docs/superpowers/tasks/2026-08-16-pi-model-cost-sections/review-prompt.md`:

- Replace the review-target command: the branch carries no commits (by policy), so `git diff main...feat/pi-model-cost-sections` is empty. Use `git diff -- src/agents/plugins/pi/pi.models.ts` plus the untracked test file, and note that the whole task directory is untracked too, not just the test.
- "exactly `input`, `output`, `cacheRead`, `cacheWrite`" → the four required base rates, plus optional `tiers` (`packages/ai/src/types.ts:783-790`), which this change deliberately omits.
- Drop the claim that the analytics subsystem flags inexact matches to its consumers. It does not: `lookupPrice` returns `ModelPrice | null` and signals inexactness only via `logger.debug` (`pricing.ts:167-175`), and `cost-enricher.ts:119-130` treats any non-null match as priced. Pi is consistent with the existing consumer, so concern 5's framing was wrong — the risk is real but it is not a deviation.

In `/home/taras_spashchenko/.claude/plans/codemie-code-provides-a-virtual-melody.md`:

- "structurally impossible" was too broad. A *partial* block is indeed impossible, but a complete block containing a non-finite product was not — that is R1. Rewrite to claim only what holds, after R1 lands.
- "byte-for-byte equivalent" → runtime-equivalent: an absent block and an all-zero block serialize differently but normalize identically at `provider-composer.ts:150-165`.

---

## R6 — Move the price table out of the CLI layer (report concern 8) — applied

Originally proposed as a follow-up; the user directed it into this branch.

`git mv` preserves history for all five files:

| From | To |
|---|---|
| `src/cli/commands/analytics/cost/pricing.ts` | `src/utils/pricing.ts` |
| `src/cli/commands/analytics/cost/pricing.json` | `src/utils/pricing.json` |
| `src/cli/commands/analytics/model-normalizer.ts` | `src/utils/model-normalizer.ts` |
| `src/cli/commands/analytics/cost/__tests__/pricing.test.ts` | `src/utils/__tests__/pricing.test.ts` |
| `src/cli/commands/analytics/__tests__/model-normalizer.test.ts` | `src/utils/__tests__/model-normalizer.test.ts` |

`model-normalizer.ts` has to move too: `pricing.ts` depends on it, so leaving it in `cli/` would merely invert the violation into `utils → cli`. It is a pure string helper with zero imports — a natural Utils-layer citizen. Both moved modules keep their filenames, so the "to refresh, re-copy that file" instruction in the pricing header stays literally true.

Consumers repointed to the `@/utils/…` alias (109 files already use `@/`, and the guides prefer it over deep relative paths): `cost-enricher.ts`, `cost-calculator.ts`, `otel-loader.ts`, `aggregator.ts`. `pricing.ts`'s own three imports become `./paths.js`, `./model-normalizer.js`, `./logger.js`. The moved tests already used `../pricing.js` / `../model-normalizer.js`, which resolve unchanged from `src/utils/__tests__/`. The asset rule in `scripts/copy-plugins.js` now copies `src/utils/pricing.json` → `dist/utils/pricing.json` and is renamed "Model pricing table". No logic inside any moved file changed.

The plugin's import is now `../../../utils/pricing.js` — downward through the layers, so concern 8 is closed rather than argued.

## Declined — real observations, deliberately not actioned
| **Inexact family/tier pricing written as authoritative** (report concern 5) | Inherent to the approved fallback source, and identical to how the existing analytics consumer treats it. Suppressing family matches would leave more models unpriced, which is the bug we are fixing. Recording as a known limitation. |
| **`claude-3-sonnet-20240229` has a `cacheWrite1h` that is not `input × 2`** | Out of scope (`pricing.json` contents), not among the 44 current ids, and Pi has no schema field that could carry it. |
| **No test writes JSON or drives Pi** | The end-to-end harness covers that layer and is documented in the plan's verification section; adding a filesystem integration test is new scope. Revisit if you want it as a permanent gate rather than a manual check. |

## Execution order and verification

1. R1 code + regression test → R2 code + test → R3 comment + test → R4 wording.
2. `npm run typecheck && npm run lint && npm run build`
3. `npx vitest run --project unit src/agents/plugins/pi/__tests__/pi.models.test.ts` then `npm run test:unit` (baseline to hold: 208 files / 3063 tests).
4. Re-run the overflow reproduction and require the inverse of the numbers above: `converted input` finite, no `null` in the serialized block, `pi model present: true`.
5. Re-run the missing-asset probe (move `dist/.../pricing.json` aside, restore via trap) and require `config written, launch proceeds`.
6. Re-run the three-model end-to-end harness and the 44-model whole-file load; `gpt-4.1`, `claude-sonnet-5` and the 34/10 split must be unchanged — R1–R3 must not move any ordinary price.
7. R5 doc edits last, so they describe what shipped.

No commits unless asked.

---

## Outcome

All six items applied. Gates and probes, all re-run after the final edit:

| Check | Result |
|---|---|
| `npm run ci` (license-check → lint → build → test:unit → test:integration) | PASS |
| Unit suite | 208 files, **3068** tests pass (was 3063; +5 new) |
| Integration suite | 29 files passed, 1 skipped; 205 passed, 10 skipped (pre-existing skips) |
| Clean rebuild asset check | `dist/utils/pricing.json` present; `dist/cli/commands/analytics/cost/pricing.json` absent |
| **R1 probe** — finite `1e308` payload | `converted input: 2 | finite: true`; serialized `{"input":2,...}`; `pi model present: true`. Round-1 output was `Infinity` / `"input":null` / `present: false` |
| **R2 probe** — `dist/utils/pricing.json` removed | `config written, launch proceeds`, `cost key present: false`. Round-1 output was an uncaught ENOENT out of `fetchAndBuildPiModels` |
| Three-model end-to-end | `gpt-4.1` `{2,8,0.5,2}`, `claude-sonnet-5` `{3,15,0.3,3.75}`, unpriced model four zeros with no `cost` key — unchanged from round 1 |
| 44-model whole-file load | 44 loaded, 34 priced, same 10 unpriced — unchanged from round 1 |
| `pi --list-models claude-sonnet-5` | `codemie-anthropic  claude-sonnet-5` row still printed |

The last two lines are the ones that matter for regression: no remediation moved any ordinary price.

Nothing committed.
