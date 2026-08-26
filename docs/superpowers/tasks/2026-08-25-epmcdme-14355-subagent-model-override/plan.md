# Plan — EPMCDME-14355 subagent model override

## Requirements block

**Fix**: CodeMie Claude CLI silently sets `CLAUDE_CODE_SUBAGENT_MODEL` to the sonnet-tier model whenever sonnet is provisioned. Upstream Claude Code treats that env var as a **global override** for all subagent launches, which silences the per-subagent `model` parameter of the Agent tool. Result: `Agent({subagent_type: "model-pin-test", model: "haiku"})` from a Sonnet orchestrator runs on Sonnet instead of Haiku.

**Fix approach (chosen)**: Do not set `CLAUDE_CODE_SUBAGENT_MODEL` when sonnet IS provisioned. Keep the existing fallback paths that set it for haiku-only and opus-only tenants (those paths REDIRECT the subagent when the upstream default sonnet tier is not usable — the semantics are load-bearing for EPMCDME-12779). Sonnet-provisioned + haiku-provisioned tenants: `ANTHROPIC_DEFAULT_SONNET_MODEL` covers the subagent default; explicit per-subagent overrides now flow through unmolested.

**AC-6**: startup log-warning in the Claude plugin's `beforeRun`. Log which tiers are provisioned at info level; warn when haiku is NOT provisioned (haiku is the most common per-subagent override — its absence is a foot-gun worth surfacing).

## Non-goals

- No proxy-level enforcement of `body.model` against the provisioned catalog — follow-up ticket.
- No changes to backend `codemie` `_extract_model` — already correct.
- No new abstraction layer around `envMapping` beyond one new field.
- No changes to `beforeRun` auto-resolve semantics beyond dropping `CLAUDE_CODE_SUBAGENT_MODEL` from the sonnet tier's target vars.

## Change surface

- `src/agents/adapters/AgentAdapterEnvMapping.ts` (or wherever the `EnvMapping` interface lives — one of the type files under `src/agents/adapters/`; verify path in Task 1) — add `subagentDefaultModel?: string[]` field.
- `src/agents/plugins/claude/claude.plugin.ts` — (a) remove `'CLAUDE_CODE_SUBAGENT_MODEL'` from the sonnet tier's `envMapping.sonnetModel` and add a new `envMapping.subagentDefaultModel = ['CLAUDE_CODE_SUBAGENT_MODEL']`; (b) remove `'CLAUDE_CODE_SUBAGENT_MODEL'` from the sonnet tier's `native` array in `TIER_TARGET_VARS` in `beforeRun`; (c) add the startup log-warning after tier resolution.
- `src/agents/core/BaseAgentAdapter.ts` `transformEnvVars()` (lines 1088–1160) — (a) Step 1: also clear `envMapping.subagentDefaultModel` vars; (b) Step 2: rewrite lines 1143–1153 to test on `envMapping.subagentDefaultModel` (single-source-of-truth for the "subagent redirect" target var) rather than the hardcoded `envMapping.sonnetModel?.includes('CLAUDE_CODE_SUBAGENT_MODEL')` string check.
- `src/agents/core/__tests__/model-tier-config.test.ts` — add two regression tests (Task 1 and Task 2 tests below).
- `src/agents/plugins/claude/__tests__/` — add unit test for the startup log-warning path in Task 4.

## Tasks

### Task 1 — Introduce `envMapping.subagentDefaultModel`; unhook `CLAUDE_CODE_SUBAGENT_MODEL` from sonnet tier

**Test-first: yes** — new test in `model-tier-config.test.ts`:
```
describe('subagent model override (EPMCDME-14355)')
  it('does NOT set CLAUDE_CODE_SUBAGENT_MODEL when both haiku and sonnet tiers are provisioned', () => {
    const env = { CODEMIE_HAIKU_MODEL: 'anthropic/claude-haiku-4-5', CODEMIE_SONNET_MODEL: 'anthropic/claude-sonnet-5', ... }
    const out = adapter.transformEnvVars(env)
    expect(out.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic/claude-haiku-4-5')
    expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-5')
    expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()   // ← the fix
  })
```
Failing (RED) because current code sets `CLAUDE_CODE_SUBAGENT_MODEL = CODEMIE_SONNET_MODEL`. Then implement:
1. Extend the `EnvMapping` interface with optional `subagentDefaultModel?: string[]`.
2. In `claude.plugin.ts`, change `envMapping.sonnetModel` to `['ANTHROPIC_DEFAULT_SONNET_MODEL']` (drop `CLAUDE_CODE_SUBAGENT_MODEL`). Add `envMapping.subagentDefaultModel: ['CLAUDE_CODE_SUBAGENT_MODEL']`.
3. In `claude.plugin.ts` `beforeRun` `TIER_TARGET_VARS`, drop `'CLAUDE_CODE_SUBAGENT_MODEL'` from the sonnet tier's `native` array.
4. In `BaseAgentAdapter.transformEnvVars` Step 1, add clearing loop for `envMapping.subagentDefaultModel`.
5. In `BaseAgentAdapter.transformEnvVars` Step 2 (line 1143–1153), replace `envMapping.sonnetModel?.includes('CLAUDE_CODE_SUBAGENT_MODEL')` with `envMapping.subagentDefaultModel?.length`. Assign to each var in `envMapping.subagentDefaultModel` rather than the hardcoded `env['CLAUDE_CODE_SUBAGENT_MODEL']`.

**Verify**: RED test now passes (GREEN); the existing EPMCDME-12779 haiku-only test still passes.

### Task 2 — Preserve haiku-only tenant behaviour (EPMCDME-12779 regression check)

**Test-first: yes** — assert existing behaviour is intact:
```
it('sets CLAUDE_CODE_SUBAGENT_MODEL = haiku model when only haiku tier is provisioned (EPMCDME-12779)', () => {
  const env = { CODEMIE_HAIKU_MODEL: 'anthropic/claude-haiku-4-5' }   // no sonnet, no opus
  const out = adapter.transformEnvVars(env)
  expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBe('anthropic/claude-haiku-4-5')
  expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()  // intentional per EPMCDME-12779
})
it('sets CLAUDE_CODE_SUBAGENT_MODEL = opus model when only opus tier is provisioned', () => {
  const env = { CODEMIE_OPUS_MODEL: 'anthropic/claude-opus-5' }
  const out = adapter.transformEnvVars(env)
  expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBe('anthropic/claude-opus-5')
})
```
Both should be GREEN with the Task 1 changes (fallback branches still trigger via the new `subagentDefaultModel` field). If either goes RED, revisit Task 1.5.

### Task 3 — Sonnet-only tenant regression check

**Test-first: yes**:
```
it('does not set CLAUDE_CODE_SUBAGENT_MODEL when only sonnet is provisioned (no fallback needed)', () => {
  const env = { CODEMIE_SONNET_MODEL: 'anthropic/claude-sonnet-5' }
  const out = adapter.transformEnvVars(env)
  expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-5')
  expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
})
```
GREEN with Task 1 changes. No implementation needed beyond Task 1.

### Task 4 — Startup log-warning for missing subagent-override tiers

**Test-first: yes** — new test in `src/agents/plugins/claude/__tests__/claude.plugin.subagent-warning.test.ts` (a new test file focused on this cross-cutting concern):
```
describe('claude.plugin beforeRun subagent tier warning (EPMCDME-14355 AC-6)')
  it('logs a warning when haiku tier is NOT provisioned (subagents can no longer be pinned to haiku)', async () => {
    // mock resolveClaudeModel to return sonnet-only
    // invoke beforeRun with the appropriate env
    // expect logger.warn to be called with a message mentioning "haiku" and "subagent"
  })
  it('does not warn when haiku IS provisioned', async () => {
    // mock resolveClaudeModel to return both haiku and sonnet
    // expect logger.warn NOT called with the subagent-warning message
  })
```
Failing (RED). Then implement in `claude.plugin.ts` `beforeRun`, immediately after the tier-resolution loop:
1. Inspect final env: which of `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` are set.
2. `logger.info` a single line summary: `[Claude] Provisioned tiers: haiku=<yes|no>, sonnet=<yes|no>, opus=<yes|no>. Subagent default: <sonnet|haiku|opus|per-request>.`
3. If haiku is NOT set: `logger.warn('[Claude] Haiku tier not provisioned — subagents dispatched with model: "haiku" will fail. Provision CODEMIE_HAIKU_MODEL or omit the model parameter.')`.
4. Fire only in the same `CODEMIE_PROVIDER !== 'anthropic-subscription'` branch as the existing tier auto-resolve (subscription path uses upstream defaults; no CodeMie-catalog check applies).

**Verify**: RED tests now GREEN; a manual run of `codemie doctor` or a normal orchestrator launch on a sonnet-only tenant shows the warning line once at startup.

## Validation

- `npm run test -- src/agents/core/__tests__/model-tier-config.test.ts` — Task 1/2/3 tests green.
- `npm run test -- src/agents/plugins/claude/__tests__/claude.plugin.subagent-warning.test.ts` — Task 4 tests green.
- `npm run lint` — zero warnings.
- `npm run typecheck` — clean.
- `npm run test` — full suite green (make sure no other test relied on `CLAUDE_CODE_SUBAGENT_MODEL` being set in the sonnet-provisioned case).

## Manual verification (evidence for MR body)

Run `codemie claude -- --print "spawn model-pin-test with haiku"` (or equivalent) from a Sonnet-orchestrator session with both haiku and sonnet provisioned:
- Before fix: subagent reports Sonnet (bug).
- After fix: subagent reports Haiku (fixed).

If a `model-pin-test` diagnostic agent is not available locally, a stub is acceptable: grep the outbound proxy request body for `"model":"anthropic/claude-haiku-4-5"` when the Agent tool call passes `model: "haiku"`.

## Risk & rollback

- Behavioural change is limited to environments where BOTH haiku and sonnet are provisioned (or ONLY sonnet). Haiku-only and opus-only tenants are unchanged (Task 2 regression tests guard this).
- Rollback: revert the two source changes; the tests will need to be rolled back with them. No data migration.
