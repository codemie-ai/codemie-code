# Spec: CLI Statusline Shows Project CLI Budget

## Problem

The CodeMie CLI statusline budget segment always shows the user's personal CLI budget
(`email (cli)` row). When a project is selected for the CLI profile (`profile.codeMieProject`),
CodeMie charges that project's CLI budget instead — but the statusline ignores it. Users
see stale personal figures (often `$0.00 (0%)`) instead of the budget that may actually block them.

## Goal

The statusline budget segment must mirror the same budget CodeMie actually charges for the
session: the selected project's CLI budget when one applies, with a fallback to the personal
CLI budget when no project is selected or the selected project has no CLI budget.

## API Contract (confirmed)

The `/v1/analytics/budget_usage` endpoint returns rows with this shape:

```json
// Personal CLI row
{ "project_name": "user@epam.com (cli)", "current_spending": 1.78, "total": 1.19,
  "budget_reset_at": "2026-12-01T00:00:00Z", "budget_limit": 150,
  "is_default": true, "is_shared_limit": false }

// Project CLI row
{ "project_name": "epm-sdai-pr-ally (cli)", "current_spending": 13.84, "total": 11.54,
  "budget_reset_at": "2026-12-01T00:00:00Z", "budget_limit": 120,
  "is_default": false, "is_shared_limit": false }
```

Row naming convention: `"${projectOrEmail} (cli)"` for CLI budgets.
`is_default: true` rows are personal/default budgets; `is_default: false` are project-specific.
`is_shared_limit: true` rows already contain the whole team's spend and the shared pot as
their `current_spending`/`budget_limit` — shared-pot display requires no special casing.

## Acceptance Criteria

- **AC1** — Given the CLI session uses a project that has a CLI budget, when the statusline
  renders, then the budget segment shows that project's CLI spend and percentage used.
- **AC2** — Given a project budget pays for the session's CLI usage, when the statusline
  renders, then the user's personal CLI budget is not shown.
- **AC3** — Given the statusline shows a budget, when it renders, then the reset date shown
  is the reset date of that same budget.
- **AC4** — Given the CLI session uses no project, when the statusline renders, then the
  segment shows the budget CodeMie charges: the user's default project CLI budget if it has
  one, otherwise the user's personal CLI budget.
- **AC4a** — Given the CLI session uses a project without a CLI budget, when the statusline
  renders, then the segment shows the budget CodeMie charges instead: the default project's
  CLI budget if it has one, otherwise the user's personal CLI budget.
- **AC5** — Given the session's project uses one shared pot for the whole team and the member
  has no personal limit, when the statusline renders, then the segment shows the whole
  project's CLI spend against the shared pot, with the matching percentage and reset date.
- **AC5a** — Given the session's project uses one shared pot and the member has a personal
  CLI limit (override), when the statusline renders, then the segment shows the member's own
  CLI spend against that personal limit, with the matching percentage and reset date.
- **AC6** — Given the selected project gives each member an own CLI allowance, when the
  statusline renders, then the segment shows the user's own spend against the user's allowance
  in that project.
- **AC7** (negative) — Given no budget row is found (no project row and no personal row),
  when the statusline renders, then no budget segment is shown.
- **AC8** (negative) — Given the user switches the profile to a different project, when the
  statusline renders after the switch, then it does not show the previous project's figures.
- **AC9** (regression) — Given a profile that is not connected to CodeMie, or a session where
  the budget cannot be loaded, when the statusline renders, then the rest of the statusline
  renders as today, with no wrong budget figures.

## Out of Scope

- **NG1** — Changing which budget CodeMie charges for CLI usage. Only the statusline display changes.
- **NG2** — Changing the charging priority order; the statusline only mirrors it.
- **NG3** — Budget displays in the CodeMie web UI.
- **NG4** — Showing more than one budget in the statusline at the same time.

## Decisions

| ID | Decision |
|----|----------|
| D1 | Fallback order: session project CLI row → personal CLI row. Mirrors CodeMie charging. |
| D2 | Shared-pot (`is_shared_limit: true`): show team spend vs pot — the row already carries the right figures. |
| D5 | Shared-pot personal override: member's own row matched first (personal email pattern). |
| D3 | Session project read from `process.env.CODEMIE_PROJECT` (set by SSO/JWT templates, inherited by Claude Code and statusline subprocess), with fallback to `profile.codeMieProject`. |
| D4 | Whole-project spend for shared-pot: already in the row's `current_spending` when `is_shared_limit: true`. No backend change needed. |

## Design

### Budget selection (the fallback chain)

```
resolve(profile, env) →
  1. if CODEMIE_PROJECT or profile.codeMieProject is set:
       target = "${project} (cli)" (case-insensitive)
       row = rows.find(r => normalize(r.project_name) === target)
       if row → use it (AC1, AC6)
  2. fallback: find the row CodeMie would charge when no project applies —
       row = rows.find(r => r.is_default === true
                         && normalize(r.project_name).endsWith(" (cli)"))
       — today this matches the personal email (cli) row (is_default: true);
         if CodeMie ever designates a project as the user's default, its (cli)
         row would carry is_default: true and be found here instead (AC4, AC4a)
       if row → use it
  3. else → no row → no budget segment (AC7)
```

> **Note:** `is_default` is present on every row in both lab and production but is not in
> the documented `columns` schema. If the backend ever removes it, step 2 falls back to
> matching `${userEmail} (cli)` by name — the existing logic, still present as a safety net.

### Shared-pot rendering (AC5, AC5a)

When `is_shared_limit: true`, the row's `current_spending`, `total`, and `budget_limit` already
reflect the correct figures (whole-project spend vs shared pot for AC5, or member spend vs
personal override for AC5a). `formatBudgetSegment` needs no changes.

### Cache invalidation (AC8)

The budget cache (`budget-cache.json`) today keyed only on `profile`. Add a `project` field
(`activeProject ?? ''`) and bump `CACHE_SCHEMA` from 2 to 3 so a profile switch to a different
project immediately invalidates the cached entry.

## Open Risks

1. **`is_shared_limit` with personal override (AC5a)**: Rows for a shared-pot project where the
   member has a personal override were not observed in testing. The design assumes such a row
   exists as a personal `email (cli)` row alongside the project row, and that the fallback chain
   picks it up correctly. Must be validated once such a project is available.
2. **Bundle deployment**: Changes require rebuilding and reinstalling the statusline bundle
   (`~/.claude/codemie-budget-status.js`) to reach users.
