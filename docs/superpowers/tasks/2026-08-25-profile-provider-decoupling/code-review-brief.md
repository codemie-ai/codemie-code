# Code review — 2026-08-25-profile-provider-decoupling (2026-08-25)

**request-changes** · confidence: low · 6 blocking (1 decision needed) · 1 deferred · 8 filtered as noise
Coverage: blind ✓ · edge-case ✓ · verification-gap ✓ · acceptance ✓ (4/4 lenses ran)

## Look here first

- `src/agents/plugins/claude/plugin/statusline.mjs:215` — [config] `codeMieUrl` moved out of the profile object; statusline's budget check always fails, silently hiding the budget segment for every SSO user post-migration — CR-001
- `src/migrations/006-decouple-provider-workspace-config.migration.ts:92` — [config] migration always writes `workspace` (even `{}`); `resolveWorkspace()` treats any defined workspace as a full override, so every local-config project permanently loses global fallback — CR-003
- `src/env/__tests__/types.test.ts:186` — [other: build] stale `ProviderProfile` literal still sets `codeMieUrl`/`codeMieIntegration`, which no longer exist on the interface — breaks typecheck/CI — CR-002
- `src/utils/config.ts:211` — [config] explicit `"workspace": null` in a hand-edited config crashes `ConfigLoader.load()` via `Object.entries(null)` — CR-005
- `src/utils/config.ts:124` — [config] `applyProjectOnly` was required to be removed by the AC but is still needed; decision needed on whether to eliminate it or revise the AC — CR-004

## Also flagged

- `src/utils/config.ts:1246` — [config] `loadWithSources` hardcodes workspace `source: 'project'` even when the value actually came from global scope, mislabeling `--show-sources` output — CR-006

## Checked and clean

commit-format ✓ · security ✓ · code-quality partial (1 pre-existing 500-line-limit violation, deferred, not introduced by this diff) · 1 deferred → code-review-deferred.md
