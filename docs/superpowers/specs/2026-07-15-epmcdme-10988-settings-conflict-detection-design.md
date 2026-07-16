# Design: ANTHROPIC_BASE_URL Settings Conflict Detection

**Date**: 2026-07-15
**Ticket**: EPMCDME-10988
**Run**: 20260715-1402-EPMCDME-10988
**Complexity**: M (score 17/36, routing: brainstorming)

---

## Problem

`codemie-code` injects `ANTHROPIC_BASE_URL` into the process environment via `transformEnvVars()`, mapping it from the active profile's `CODEMIE_BASE_URL`. However, Claude Code reads `~/.claude/settings.json` at its own startup and silently overrides any environment-level `ANTHROPIC_BASE_URL` with the value in that file. The startup banner (`renderProfileInfo`) shows the profile URL, not the effective URL — giving the user a false picture of where requests go.

---

## Execution Order Context

`BaseAgentAdapter.run()` executes in this fixed order:

```
L537  renderProfileInfo(env.CODEMIE_URL)     // banner: shows profile URL
L557  transformEnvVars(env)                   // sets env.ANTHROPIC_BASE_URL = CODEMIE_BASE_URL
L561  executeBeforeRun() → beforeRun(env)     // called with already-transformed env
        ↑ THIS is where detection must happen
L???  Claude Code starts                       // reads ~/.claude/settings.json, overrides ANTHROPIC_BASE_URL
```

Detection must happen in `beforeRun`: by that point, `env.ANTHROPIC_BASE_URL` holds the profile value, and the comparison against `~/.claude/settings.json` is meaningful.

---

## Approaches Considered

| Approach | Summary | Verdict |
|---|---|---|
| A. Inline in `beforeRun` | Add detection logic inside the existing lifecycle hook | Rejected — conflates two responsibilities; detection logic can't be unit-tested in isolation |
| **B. New helper module** | `settings-conflict.ts` called from `beforeRun` | **Recommended** — single responsibility, testable, follows existing `statusline-installer.ts` pattern |
| C. Patch `renderProfileInfo()` | Read `settings.json` from the banner function | Rejected — wrong timing (called before `transformEnvVars`; profile URL not in env yet); also couples a generic utility to Claude-specific paths |

---

## Design

### New file: `src/agents/plugins/claude/settings-conflict.ts`

Exports a pure async detection function and a typed result:

```typescript
export interface ConflictInfo {
  /** URL that will actually be used (from ~/.claude/settings.json) */
  settingsUrl: string;
  /** URL the active profile injected; undefined when no profile URL was set */
  profileUrl: string | undefined;
}

export async function detectSettingsConflict(
  env: NodeJS.ProcessEnv
): Promise<ConflictInfo | null>
```

**Logic:**

1. Resolve `settingsPath = join(resolveHomeDir('.claude'), 'settings.json')`.
2. If file does not exist → return `null`.
3. Parse JSON; if malformed → return `null` (non-fatal; startup continues unchanged).
4. Read `settings.ANTHROPIC_BASE_URL`; if absent → return `null`.
5. Compare against `env.ANTHROPIC_BASE_URL`; if equal → return `null` (same endpoint, no confusion).
6. Return `{ settingsUrl: settings.ANTHROPIC_BASE_URL as string, profileUrl: env.ANTHROPIC_BASE_URL }`.

**Edge cases:**

| Scenario | Behavior |
|---|---|
| `~/.claude/settings.json` absent | `null` — no false positive |
| File present, no `ANTHROPIC_BASE_URL` key | `null` |
| Both URLs identical | `null` — no user confusion |
| URLs differ | `ConflictInfo` returned |
| `env.ANTHROPIC_BASE_URL` undefined (no profile URL set) + settings has URL | `ConflictInfo` returned — user still needs to know what URL is active |
| Malformed JSON | `null` — non-fatal; log nothing |

**Imports:**
- `existsSync` from `'fs'`
- `readFile` from `'fs/promises'`
- `join` from `'path'`
- `resolveHomeDir` from `'../../../utils/paths.js'` (deep-relative, matching the pattern in `claude.plugin.ts` line 21)

### Modified: `src/agents/plugins/claude/claude.plugin.ts`

In `lifecycle.beforeRun(env)`, after the existing `statusLine` injection block:

```typescript
import { detectSettingsConflict } from './settings-conflict.js';
// chalk is already imported in claude.plugin.ts (line 20)

// ... existing statusLine logic ...

const conflict = await detectSettingsConflict(env);
if (conflict) {
  const profileDisplay = conflict.profileUrl ?? '(not set — direct Anthropic API)';
  console.error(chalk.yellow('\n⚠️  ANTHROPIC_BASE_URL override detected in ~/.claude/settings.json'));
  console.error(chalk.yellow('─'.repeat(60)));
  console.error(chalk.yellow(`  Profile URL  │ ${profileDisplay}`));
  console.error(chalk.yellow(`  Active URL   │ ${conflict.settingsUrl}  ← settings.json wins`));
  console.error(chalk.yellow(''));
  console.error(chalk.yellow('  ~/.claude/settings.json ANTHROPIC_BASE_URL takes precedence'));
  console.error(chalk.yellow('  over the profile value. Session will use the settings.json URL.'));
  console.error(chalk.yellow(''));
  console.error(chalk.yellow('  To fix: remove ANTHROPIC_BASE_URL from ~/.claude/settings.json'));
  console.error(chalk.yellow('─'.repeat(60)));
  console.error('');
}
```

This matches the existing `chalk.yellow` + `console.error` pattern used for warnings in `claude.plugin.ts` (lines 563, 580). No new imports needed — `chalk` is already imported at line 20.

### New file: `src/agents/plugins/claude/__tests__/settings-conflict.test.ts`

Unit tests using the mocking pattern from `claude.plugin.statusline.test.ts`:

```typescript
vi.mock('fs/promises');
vi.mock('fs');
vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
}));
```

Test cases:

| # | Scenario | Expected |
|---|---|---|
| 1 | settings.json does not exist | `null` |
| 2 | settings.json has no `ANTHROPIC_BASE_URL` | `null` |
| 3 | settings.json URL === env URL | `null` |
| 4 | URLs differ | `ConflictInfo { settingsUrl, profileUrl }` |
| 5 | env `ANTHROPIC_BASE_URL` undefined, settings has URL | `ConflictInfo { settingsUrl, profileUrl: undefined }` |
| 6 | settings.json is malformed JSON | `null` |

Integration test addition in `claude.plugin.conflict.test.ts` (dedicated file — do not mix into `claude.plugin.statusline.test.ts`):

- `beforeRun` calls `console.error(chalk.yellow(...))` when `detectSettingsConflict` returns non-null
- `beforeRun` does NOT call `console.error` for conflict when `detectSettingsConflict` returns `null`

### Documentation update: `.ai-run/guides/usage/project-config.md`

Add a section:

```markdown
## Claude Code ANTHROPIC_BASE_URL Override

Claude Code reads `~/.claude/settings.json` at startup. If that file contains an
`ANTHROPIC_BASE_URL` key, Claude Code uses it instead of any environment variable.

`codemie-code` detects this at startup and prints a visible warning showing:
- The profile URL that was injected
- The settings.json URL that will actually be used

**Precedence chain (highest wins):**
`~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL` (codemie-code profile)

To avoid silent overrides: remove `ANTHROPIC_BASE_URL` from `~/.claude/settings.json`.
```

---

## Data Flow

```
BaseAgentAdapter.run()
  1. renderProfileInfo(env.CODEMIE_URL)        → banner shows profile URL
  2. transformEnvVars(env)                      → env.ANTHROPIC_BASE_URL = CODEMIE_BASE_URL
  3. beforeRun(env)
       → detectSettingsConflict(env)
            read ~/.claude/settings.json
            if settings.ANTHROPIC_BASE_URL ≠ env.ANTHROPIC_BASE_URL
              return { settingsUrl, profileUrl }
            else
              return null
       → if ConflictInfo: console.error(chalk.yellow(...))  → stderr
       → return env                              (env unchanged; warning is informational)
  4. Claude Code starts                          → uses settings.json URL if present
```

---

## Files Changed

| File | Change |
|---|---|
| `src/agents/plugins/claude/settings-conflict.ts` | New — detection helper |
| `src/agents/plugins/claude/claude.plugin.ts` | Modified — import `detectSettingsConflict`, add conflict check in `beforeRun` (chalk already imported) |
| `src/agents/plugins/claude/__tests__/settings-conflict.test.ts` | New — unit tests |
| `src/agents/plugins/claude/__tests__/claude.plugin.conflict.test.ts` | New — integration tests for `beforeRun` warning call |
| `.ai-run/guides/usage/project-config.md` | Updated — document `~/.claude/settings.json` precedence |

---

## Acceptance Criteria Mapping

| AC | Implementation |
|---|---|
| Detect `ANTHROPIC_BASE_URL` override at startup | `detectSettingsConflict` called from `beforeRun` |
| Clear warning printed before session starts | `console.error(chalk.yellow(...))` in `beforeRun` |
| Banner / info reflects actual endpoint | Warning shows `settingsUrl` as "Active URL" alongside "Profile URL" |
| Documentation updated | `.ai-run/guides/usage/project-config.md` section added |
| Tests added/updated covering override scenario | `settings-conflict.test.ts` + `claude.plugin.conflict.test.ts` |

---

## Out of Scope

- Blocking startup (the ticket marks this as explicitly optional; warning is sufficient)
- Modifying `renderProfileInfo()` signature — wrong timing in the call sequence
- Reading any settings keys other than `ANTHROPIC_BASE_URL`
- Auto-removing the conflicting key from `settings.json`
