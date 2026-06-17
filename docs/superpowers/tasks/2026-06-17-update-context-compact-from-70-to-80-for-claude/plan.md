# Plan — bump Claude auto-compact default to 85

**Branch:** `chore/claude-compact-threshold`
**Date:** 2026-06-17

## Clarification answers folded in

- User confirmed runtime should be bumped from the current `80` → `85` (overrides the original "70 → 80" framing once they learned the runtime was already 80).
- Doc comment must reflect the new value.

## Requirements

1. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` injected default becomes `85` when neither the env var nor the profile config provides one.
2. The JSDoc comment for `claudeAutocompactPct` documents `default: 85`.
3. Profile-config override path (`profileConfig.claudeAutocompactPct`) is unchanged and remains authoritative when set.
4. The unrelated `70` in `session-status.mjs:25` (statusline bar color) is left alone.

## Tasks

### T1 — Bump runtime default in claude plugin

- **File:** `src/agents/plugins/claude/claude.plugin.ts`
- **Line:** 183
- **Change:** `let autocompactPct = 80;` → `let autocompactPct = 85;`
- **Test-first:** no — single-constant change in a code path that has no existing unit-test harness (verified by `src/agents/plugins/claude/__tests__/`). Adding a test purely to assert a numeric constant would test the literal back to itself; the change is verified by reading the diff.

### T2 — Update JSDoc comment to match

- **File:** `src/env/types.ts`
- **Line:** 133
- **Change:** trailing `default: 70` → `default: 85`
- **Test-first:** no — comment-only change.

## Out of scope

- No tests added (no harness, single-constant change).
- No README / docs / .env.example updates needed — `grep -rn CLAUDE_AUTOCOMPACT` confirmed no other references.
- `session-status.mjs:25` is untouched.
- No behavior change for users who set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` or `claudeAutocompactPct` themselves.

## Validation

- `npm run lint` clean on the two touched files.
- `npm run typecheck` clean (no type signatures change).
- `npm run build` clean.
- Manual: `grep -n 'autocompactPct = ' src/agents/plugins/claude/claude.plugin.ts` returns `85`; `grep -n 'default: ' src/env/types.ts | grep claudeAutocompact` returns `default: 85`.
