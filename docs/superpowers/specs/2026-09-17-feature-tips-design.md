# Feature Tips ("Did you know?") — Design

Date: 2026-09-17
Status: Approved (design presented in session; auto permission mode)

## Problem

CodeMie Code ships a large and growing set of capabilities (28+ commands, hooks,
proxy integrations, env toggles). Users can't keep up: they don't know features
exist and can't find the right command. Today the only session-lifecycle
messaging is personality-only: hardcoded random welcome/goodbye one-liners in
`src/utils/goodbye-messages.ts`, rendered by `BaseAgentAdapter`. There is no
mechanism to surface features, and no "what's new"/announcement subsystem.

## Goals

- Show short, useful "did you know" tips at session start and session finish.
- Make the tip catalog trivially maintainable: adding a tip = adding one object;
  retiring a command must not leave a dangling tip (staleness must be visible
  and self-healing where cheap).
- Respect existing gates: silent mode (ACP / `--task` / `-s`) must suppress tips
  because stdout may be a JSON-RPC stream.
- Give users a browseable surface (`codemie tips`) so all tips are discoverable
  on demand.
- Give users an off switch.

## Non-goals (YAGNI)

- Remote/dynamic tip feeds, "what's new on upgrade" changelog surface.
- Per-tip targeting by profile/provider/agent.
- Rich UI (boxes, pagers) for the tip list.
- Frequency tuning beyond on/off.

## Current state (verified)

- `src/utils/goodbye-messages.ts` — two hardcoded arrays + `getRandomWelcomeMessage()` / `getRandomGoodbyeMessage()`.
- Render points (all gated on `!this.metadata.silentMode`, `console.log` + chalk):
  - Session start: `src/agents/core/BaseAgentAdapter.ts` (~line 577-591), after `renderProfileInfo(...)`.
  - Session end (built-in handler path): `BaseAgentAdapter.ts` (~line 751-756).
  - Session end (spawned binary exit): `BaseAgentAdapter.ts` (~line 920-926).
- CLI: commander, root in `src/cli/index.ts`; each command is a `createXCommand()` factory in `src/cli/commands/`. No central metadata registry beyond the commander tree.
- Precedents to reuse:
  - Env boolean toggle: `isAutoUpdateEnabled()` in `src/utils/cli-updater.ts` (`CODEMIE_AUTO_UPDATE`, accepts true/1/yes).
  - Best-effort marker/state files under `~/.codemie/` (`getCodemiePath()` from `src/utils/paths.ts`), e.g. `.last-update-check`, `VersionWarningStore` — never throw, never block.
  - Output style: `console.log(chalk.cyan.bold(...))` for lifecycle messages, `chalk.dim` for hints.

## Approaches considered

### A. Declarative tip catalog + rotation state + `codemie tips` command (chosen)

One data module holds curated tips as objects; a rotation store prevents
repeats until all tips have been shown; tips render at the existing
welcome/goodbye points; a new `codemie tips` command lists everything and
validates command references against the live commander tree.

- Pros: engaging curated content (can cover env vars and multi-word
  subcommands, not just dry descriptions); maintenance = edit one array;
  staleness detectable; browseable; testable in isolation.
- Cons: catalog content is curated by hand (accepted — that's what makes tips
  good).

### B. Auto-derive tips from commander metadata

Walk `program.commands` and show command name + description.

- Pros: zero content maintenance, never stale.
- Cons: dry help text, not engaging; can't highlight hidden gems (hooks,
  `proxy connect --claude-desktop`, env toggles); no curation of what is
  actually worth promoting; imports whole CLI into the agent runtime for
  validation.

### C. Extend the existing welcome/goodbye arrays

Append feature tips into `WELCOME_MESSAGES`/`GOODBYE_MESSAGES`.

- Pros: zero code changes.
- Cons: mixes personality with product education; no rotation tracking; no
  browseable surface; no structure for validation; maintenance stays exactly as
  painful as today.

Decision: **A**, possibly borrowing B's validation where cheap (see below).

## Design

### 1. Tip catalog — `src/utils/tips.ts`

Pure-data module (no heavy imports — safe to load from the agent runtime):

```ts
export interface Tip {
  /** Stable unique id, kebab-case, e.g. 'cmd-skill'. Never reused. */
  id: string;
  /** Short category for grouping in `codemie tips`, e.g. 'Commands'. */
  category: string;
  /** Full sentence shown to the user. May embed the command inline. */
  message: string;
  /**
   * Optional command reference used for validation and display,
   * e.g. 'skill' or 'proxy connect'. When the referenced command is
   * retired, `codemie tips` drops/flags this tip automatically.
   */
  command?: string;
}

export const TIPS: readonly Tip[];
```

Selection API in the same module:

- `getSessionTip(context: 'start' | 'end'): Tip | null` — random pick from tips
  not yet shown (per rotation state), records the pick. Returns `null` when
  tips are disabled or catalog is empty.
- `listTips(): readonly Tip[]` — the full catalog for the `codemie tips` command.

Seed catalog: ~20 tips covering real capabilities (verified against
`src/cli/index.ts`): `setup`, `profile`, `doctor`, `skill`/`skills`, `plugin`,
`hook`, `sound`, `analytics`, `log`, `models`, `workflow`, `mcp`, `proxy
connect --claude-desktop|--vscode`, `codebase ui`, `docs`, `install`/`update`,
`self-update`, `--task` flag, `CODEMIE_DEBUG`, SessionStart/SessionEnd hooks,
`-s/--silent`.

### 2. Rotation state — `~/.codemie/.tips-state.json`

Follows the `VersionWarningStore` / `.last-update-check` precedent:

```json
{ "shownTipIds": ["cmd-skill", "env-debug"] }
```

- Best-effort: read/write wrapped in try/catch, never throws, never blocks a session.
- When every tip has been shown, the list resets and rotation restarts.
- Path via `getCodemiePath()` — no hardcoded `~/.codemie`.

### 3. Off switch — `CODEMIE_TIPS`

`isTipsEnabled(): boolean` in `src/utils/tips.ts`, boolean parsing copied from
`isAutoUpdateEnabled()` (`CODEMIE_TIPS=0|false|no` disables; default enabled).
Checked inside `getSessionTip()` so all render points inherit it.

### 4. Render points — `src/agents/core/BaseAgentAdapter.ts`

Reuse the existing `!this.metadata.silentMode` gates:

- **Session start** (after the welcome message, ~line 590): render one tip as
  `console.log(chalk.dim(`💡 Tip: ${tip.message}`))` followed by the existing
  spacing line.
- **Session end** (both goodbye blocks, ~lines 751-756 and 920-926): render one
  tip the same way, after the goodbye message, before `Powered by ...`.

Silent mode (ACP, `--task`, `--print-config`, `-s`) suppresses tips
automatically because the gate already exists. Rendering uses `console.log` +
chalk (matches existing lifecycle output; `logger` writes to the debug log file
and is not appropriate for user-facing tips).

### 5. Browseable surface — `codemie tips` command

New `src/cli/commands/tips.ts` (`createTipsCommand()`), registered in
`src/cli/index.ts` alongside the other factories:

- `codemie tips` — list all tips grouped by category, one per line, with the
  referenced command highlighted.
- `codemie tips --random` — print a single random tip (bypasses rotation state,
  does not record).
- Validation: the command walks its own commander's root program
  (`cmd.parent` chain → `.commands`, recursively) to build the set of known
  command names/paths. Tips whose `command` reference does not resolve are
  omitted from output and reported via `logger.debug(...)` as stale — this is
  the self-healing maintenance signal when commands retire. Session rendering
  does not validate (keeps the agent runtime free of commander); the catalog
  header documents the convention.

### 6. Maintenance workflow (the point of the feature)

- **Add a feature/tip**: add one `{ id, category, message, command? }` object
  to `TIPS`. Done.
- **Retire a command**: delete its tip from `TIPS` in the same PR. If missed,
  `codemie tips` silently drops the stale tip and `logger.debug` flags it — no
  user-facing breakage, no crash.
- **Reword a tip**: edit the message string in place (keep the `id` stable so
  rotation history stays meaningful).

## Data flow

```
codemie-<agent> session start
  └─ BaseAgentAdapter.run() [silentMode gate]
       └─ getSessionTip('start') → reads ~/.codemie/.tips-state.json
            → filters shown ids → random pick → records → renders dim tip

session end
  └─ goodbye block [silentMode gate] → getSessionTip('end') → renders dim tip

codemie tips
  └─ createTipsCommand() → listTips() → validate against commander tree
       → grouped listing (stale entries dropped + logger.debug)
```

## Error handling

- State file unreadable/corrupt → treat as empty, continue without a tip
  failure path; write failures swallowed (debug-logged).
- Tips disabled (`CODEMIE_TIPS=0`) or catalog empty → `getSessionTip` returns
  `null`, render points skip cleanly.
- No new dependencies; chalk and fs patterns already in the repo.

## Testing

Per project policy, tests only on explicit request — none are added. Manual
verification: build, run a built-in-agent session, observe a dim tip after the
welcome message and at exit; run `codemie tips`; run with `CODEMIE_TIPS=0` and
in silent mode to confirm suppression; delete a tip's command and confirm
`codemie tips` drops it.

## Files touched

- `src/utils/tips.ts` — new (catalog, selection, toggle, state store).
- `src/agents/core/BaseAgentAdapter.ts` — render tip at start + both exit paths.
- `src/cli/commands/tips.ts` — new (`codemie tips`).
- `src/cli/index.ts` — register the tips command.

---

## Addendum 2026-09-17: surface wiring + What's New

### Tips on CLI surfaces

- New `renderTip(options?: { category?: string })` in `src/utils/tips.ts` prints
  one random tip (optionally restricted to a category, falling back to the full
  catalog). It never touches the rotation state — rotation stays exclusive to
  session start/end — and never throws.
- Wired into high-value, non-parseable surfaces only: `codemie doctor`
  (Diagnostics tip after the summary; note `displaySummary()` exits non-zero on
  failures, so the tip only shows on a clean bill of health) and the first-run
  screens in `src/cli/first-time.ts` (`showWelcomeMessage` → Getting Started,
  `showQuickStart` → any tip, `showPostSetupMessage` → Configuration).
- Parseable-output commands (`version`, `list`, etc.) intentionally get no tips.

### What's New, driven by CHANGELOG.md

- `CHANGELOG.md` (Keep a Changelog) becomes the curated source of truth for
  release notes, seeded from conventional-commit history between the last four
  tags. It ships in the npm package (`files` in package.json), so installed
  CLIs can read it locally.
- `scripts/release.sh` gained a non-blocking pre-flight reminder when the
  target version has no `## [x.y.z]` section in CHANGELOG.md — the release is
  never aborted or delayed by missing notes.
- `src/utils/whatsnew.ts` parses the changelog (tolerant parser), renders
  chalk-styled notes, and tracks a best-effort `.last-seen-version` marker
  under the CodeMie home directory.
- `codemie whatsnew [--all] [--version <v>]` browses the notes; a
  once-per-upgrade notice in `bin/codemie.js` shows the current version's notes
  (max 6 bullets) on the first CLI start after an update, then marks the
  version seen — versions without a changelog entry are marked seen silently so
  they never nag.
- The upgrade notice shares the `CODEMIE_TIPS` off switch with feature tips:
  one "reduce chatter" toggle (`isWhatsNewEnabled()` delegates to
  `isTipsEnabled()`). The browse commands (`codemie tips`, `codemie whatsnew`)
  are never gated by it.

### Files touched (addendum)

- `src/utils/tips.ts` — `renderTip()`, `cmd-whatsnew` catalog entry.
- `src/cli/commands/doctor/index.ts`, `src/cli/first-time.ts` — tip call sites.
- `CHANGELOG.md` — new; `package.json` — ship it; `scripts/release.sh` — reminder.
- `src/utils/whatsnew.ts` — new (parser, renderer, seen-marker, toggle).
- `src/cli/commands/whatsnew.ts` — new (`codemie whatsnew`); `src/cli/index.ts` — register.
- `bin/codemie.js` — once-per-upgrade notice.
