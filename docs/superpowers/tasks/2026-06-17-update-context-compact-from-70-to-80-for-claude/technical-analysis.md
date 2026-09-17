# Technical Analysis — update context compact from 70 to 80% for Claude

**Task:** Update Claude Code auto-compact threshold env-var default from 70 → 80 in codemie-code.
**Branch under analysis:** `chore/claude-compact-threshold` (off `origin/main` at fetch time).
**Date:** 2026-06-17.

## Codebase Findings

### Runtime default (already 80 — verified on origin/main)

`src/agents/plugins/claude/claude.plugin.ts:182-195` injects `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` into the Claude Code child-process env when not already set. The hardcoded fallback is **`80`** (line 183), with a per-profile override via `profileConfig.claudeAutocompactPct` parsed from `CODEMIE_PROFILE_CONFIG`.

```ts
if (!env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) {
  let autocompactPct = 80;
  if (env.CODEMIE_PROFILE_CONFIG) {
    try {
      const profileConfig = JSON.parse(env.CODEMIE_PROFILE_CONFIG);
      if (typeof profileConfig.claudeAutocompactPct === 'number') {
        autocompactPct = profileConfig.claudeAutocompactPct;
      }
    } catch {
      // ignore malformed profile config
    }
  }
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(autocompactPct);
}
```

### Stale JSDoc comment (the actual delta)

`src/env/types.ts:133` still documents `default: 70`:

```ts
claudeAutocompactPct?: number; // Auto-compact threshold percentage (sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, default: 70)
```

This is the only surface in the repo where `70` is associated with autocompact. There are **no** README/docs/.env.example references to update.

### Audit (all references to autocompact)

```
src/agents/plugins/claude/claude.plugin.ts:182  if (!env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) {
src/agents/plugins/claude/claude.plugin.ts:183    let autocompactPct = 80;
src/agents/plugins/claude/claude.plugin.ts:187    if (typeof profileConfig.claudeAutocompactPct === 'number') {
src/agents/plugins/claude/claude.plugin.ts:188      autocompactPct = profileConfig.claudeAutocompactPct;
src/agents/plugins/claude/claude.plugin.ts:194    env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(autocompactPct);
src/env/types.ts:133 claudeAutocompactPct?: number; // ...default: 70
```

No tests cover the injection path.

## Risk Indicators

1. **`70` in `session-status.mjs:25` is unrelated** — that is the *statusline bar color* threshold (`pct >= 70 ? YELLOW : GREEN`). Do not touch.
2. **User-supplied override takes precedence** — even after the doc fix, a user with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set in their environment will see no behavior change. If the user's reported "70%" is observed behavior rather than reading the comment, there may be an externally-set override; the fix here cannot remediate that.

## Exact Delta

`src/env/types.ts:133` — replace the trailing `default: 70` with `default: 80`. No other edits.
