# Code review — 2026-10-16-epmcdme-16065 (2026-10-16)

**request-changes** · confidence: low · 2 blocking · 0 deferred · 2 filtered as noise
Coverage: blind — n/a (compact profile) · edge-case ✓ · verification-gap — n/a (compact profile) · acceptance — n/a (no spec)  (1/4 lenses ran, 3 n/a by design for this profile)

## Look here first

- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:538` — [other: analytics-correctness] `openSessionStartPass`'s merge doesn't branch on `SessionStart`'s `source`, so a `/clear` or forked fire is merged the same as `compact`/`resume` even though the SDK also reports `source: 'clear' | 'fork'` — CR-001
- `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:565` — [other: analytics-correctness] the merge trusts `state.lastSessionEnvFields.effort` without checking it's a string; `loadParseState` casts persisted JSON with no runtime validation, so a partial/older-schema snapshot makes `effort` `undefined` and drops it from the `agent.session.env` payload — CR-002

## Also flagged

(none)

## Checked and clean

No standards audit for this profile (compact; `standards_expected: false`) — not applicable, not a gap.
