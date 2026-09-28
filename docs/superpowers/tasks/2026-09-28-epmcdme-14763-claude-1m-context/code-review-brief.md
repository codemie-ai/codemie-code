# Code review — 2026-09-28-epmcdme-14763-claude-1m-context (2026-09-28)

**request-changes** · confidence: low · 5 blocking · 0 deferred · 0 filtered as noise
Coverage: blind — n/a (compact profile) · edge-case ✓ · verification-gap — n/a (compact profile) · acceptance — n/a (no spec)  (1/1 applicable lenses ran)

## Look here first

- `src/agents/plugins/claude/claude.models.ts:515` — [config] healing onto a catalog id already ending in `[1m]` yields `x[1m][1m]` in ANTHROPIC_* env — CR-003
- `src/agents/plugins/claude/claude.models.ts:375` — [config] picker synthesizes `x[1m][1m]` for literal `[1m]` catalog ids — CR-002
- `src/agents/plugins/claude/claude.plugin.ts:405` — [other: UX] stripping `[1m]` from a live model prints "not available in this CodeMie catalog" — CR-004
- `src/agents/plugins/claude/plugin/statusline.ts:229` — [other: routing] routed-to widget misses `[1m]`-preserved router ids — CR-005
- `src/agents/plugins/claude/claude.models.ts:64` — [config] version-first row rejects two-digit minors (`claude-4-10-sonnet`) — CR-001

## Checked and clean

commit-format — n/a (compact profile) · code-quality — n/a (compact profile) · security — n/a (compact profile)
