# CLI Statusline Shows Project CLI Budget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded personal-budget lookup in the statusline with a project-aware fallback chain so the segment mirrors the budget CodeMie actually charges for the session.

**Architecture:** All changes live in one standalone file (`statusline.ts`) that must not import `ConfigLoader`. Project resolution is mirrored inline from `CODEMIE_PROJECT` env var and `profile.codeMieProject`, following the existing `sessionCodeMieUrl` precedent. The cache schema is bumped to include `project` so a profile-project switch always produces a fresh fetch.

**Tech Stack:** TypeScript, Vitest, esbuild bundle (`scripts/bundle-statusline.mjs`)

**Spec:** `docs/superpowers/tasks/2026-11-23-cli-statusline-shows-personal-cli-budget-instead-o/spec.md`

## Global Constraints

- `statusline.ts` must not import `ConfigLoader`; inline any config rule with a comment citing the source.
- Bundle-safe imports only: `@/utils/credential-crypto.js`, `price-resolution.js`, `bedrock-pricing.mjs`.
- `formatBudgetSegment` output must not change (spec D2, existing test at `statusline.test.ts:59` asserts `budget_limit` is never rendered).
- AC7: when no row matches the fallback chain, no budget segment is shown and no other budget's figures appear.
- AC9: a profile not connected to CodeMie (`codeMieProject === null`) or any load failure must leave the rest of the statusline unchanged.
- Commit per task using the repository's existing Conventional Commits convention.

## Review Focus

- **`is_default` absent from response** — if the backend drops the field, step 2 of the fallback must still match the personal row by `${userEmail} (cli)` name pattern. Task 1 covers this.
- **`CODEMIE_PROJECT` not set, `profile.codeMieProject` undefined** — fallback chain must reach the `is_default` row, not error. Task 2 covers the env/config read; Task 1's test covers the selection path.
- **Profile with `codeMieProject === null`** — `sessionCodeMieUrl` already returns `undefined`; Task 2 must not read the project before that guard runs.
- **Same profile, two sequential calls with different projects** — cache must miss on project change. Task 3 covers this.
- **`is_shared_limit: true` row** — `formatBudgetSegment` needs no change; existing rendering shows the row's figures as-is. No task should modify `formatBudgetSegment`; validate in Task 1 test using a shared-limit fixture.

---

### Task 1: Project-aware row selector

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline.ts:83-87` — replace `matchBudgetRow` with `selectBudgetRow`
- Test: `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts:26-56` — replace existing `matchBudgetRow` block

**Test-first: yes** — write and run the failing tests before touching the implementation.

**Interfaces:**
- Produces: `selectBudgetRow(rows: BudgetRow[], project: string | null | undefined, userEmail: string): BudgetRow | undefined`
  - `BudgetRow` shape: `{ project_name: string; current_spending: number; total: number; budget_reset_at: string; budget_limit: number; is_default?: boolean; is_shared_limit?: boolean }`

- [ ] **Step 1: Write failing tests** in `statusline.test.ts`, replacing the `matchBudgetRow` describe block:

```ts
// fixtures — reuse/extend the existing ones at :28-30, add project row
const projectRow = { project_name: 'my-project (cli)', current_spending: 5, total: 4,
  budget_reset_at: '2026-12-01T00:00:00Z', budget_limit: 120, is_default: false, is_shared_limit: false };
const personalRow = { project_name: 'user@epam.com (cli)', current_spending: 1.78, total: 1.19,
  budget_reset_at: '2026-12-01T00:00:00Z', budget_limit: 150, is_default: true, is_shared_limit: false };
const sharedRow = { project_name: 'shared-proj (cli)', current_spending: 13, total: 11,
  budget_reset_at: '2026-12-01T00:00:00Z', budget_limit: 200, is_default: false, is_shared_limit: true };
const rows = [projectRow, personalRow, sharedRow];

// AC1: project row selected when project matches
expect(selectBudgetRow(rows, 'my-project', 'user@epam.com')).toBe(projectRow);
// case-insensitive
expect(selectBudgetRow(rows, 'MY-PROJECT', 'user@epam.com')).toBe(projectRow);
// AC2: personal row NOT returned when project row exists
expect(selectBudgetRow(rows, 'my-project', 'user@epam.com')).not.toBe(personalRow);
// AC4/AC4a: no project → is_default row
expect(selectBudgetRow(rows, null, 'user@epam.com')).toBe(personalRow);
expect(selectBudgetRow(rows, undefined, 'user@epam.com')).toBe(personalRow);
// AC4a: project with no CLI row → is_default fallback
expect(selectBudgetRow(rows, 'unknown-project', 'user@epam.com')).toBe(personalRow);
// AC7: no matching rows at all → undefined
expect(selectBudgetRow([], 'my-project', 'user@epam.com')).toBeUndefined();
// is_default absent safety net: match by email pattern when no is_default field
const noDefaultRows = [{ ...personalRow, is_default: undefined }];
expect(selectBudgetRow(noDefaultRows, null, 'user@epam.com')).toBeDefined();
// AC5: shared-limit row selected when project matches
expect(selectBudgetRow(rows, 'shared-proj', 'user@epam.com')).toBe(sharedRow);
```

- [ ] **Step 2: Run tests — verify they fail** (`npm test -- statusline.test.ts`)

- [ ] **Step 3: Implement `selectBudgetRow`** in `statusline.ts` at lines 83-87, removing `matchBudgetRow`. Write it as explicit steps with no nested ternaries:

```ts
export function selectBudgetRow(rows: BudgetRow[], project: string | null | undefined, userEmail: string): BudgetRow | undefined {
  if (!Array.isArray(rows)) return undefined;

  // When a project is selected, show the budget that CodeMie charges against —
  // the project's own CLI allocation, not the user's personal one.
  if (project) {
    const target = `${project.trim().toLowerCase()} (cli)`;
    const projectRow = rows.find(r => r.project_name?.trim().toLowerCase() === target);
    if (projectRow) return projectRow;
  }

  // No project is selected, or the selected project has no CLI budget — show
  // whatever CodeMie would charge by default. The backend marks this row with
  // is_default: true so we don't have to know the user's email format.
  const defaultRow = rows.find(r => r.is_default === true && r.project_name?.trim().toLowerCase().endsWith(' (cli)'));
  if (defaultRow) return defaultRow;

  // Guard against backend API changes where is_default stops being returned —
  // the email-keyed row is always the personal CLI budget.
  if (userEmail) {
    const emailTarget = `${userEmail.trim().toLowerCase()} (cli)`;
    return rows.find(r => r.project_name?.trim().toLowerCase() === emailTarget);
  }

  return undefined;
}
```

- [ ] **Step 4: Update every call site** — `resolveBudget` currently calls `matchBudgetRow(rows, userEmail)` at around line 791; update to `selectBudgetRow(rows, activeProject, userEmail)`. Pass `activeProject` as `null` as a placeholder; Task 2 provides the real value.

- [ ] **Step 5: Run tests — verify they pass**

- [ ] **Step 6: Commit** — `fix(statusline): replace matchBudgetRow with project-aware selectBudgetRow`

---

### Task 2: Resolve session project inside `resolveBudget`

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline.ts:700-806` — `resolveBudget` body
- Test: `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts` — extend `resolveBudget` block

**Test-first: yes**

**Interfaces:**
- Consumes: `selectBudgetRow` from Task 1
- Produces: `activeProject: string | null` derived inside `resolveBudget` before `selectBudgetRow` is called

- [ ] **Step 1: Write failing tests** — extend the `resolveBudget` describe block to cover project selection:

```ts
// AC1: CODEMIE_PROJECT env var selects the project row
// config fixture: profile has no codeMieProject; env has CODEMIE_PROJECT='my-project'
// response: rows = [projectRow, personalRow]
// expect: returned text includes '$5.00'

// AC4: no CODEMIE_PROJECT, no profile.codeMieProject → is_default row selected
// expect: returned text includes '$1.78'

// AC9: profile with codeMieProject === null → budget is null (off CodeMie path unchanged)
```

- [ ] **Step 2: Run tests — verify they fail**

- [ ] **Step 3: Add project resolution** in `resolveBudget` after the profile record is read (around line 723). Inline rule (cite `resolveProfileIdentity` as source):

```ts
// The env var is preferred over the config file because it represents the project
// the CLI session was actually launched with. The config's active profile can be
// repointed by another process mid-session, so it is not a reliable source of
// session identity here — same reason CODEMIE_PROFILE_NAME is preferred above.
// A null codeMieProject is an explicit "off CodeMie" signal, not "unset" —
// it must not be overridden by the env var.
let activeProject: string | null = null;
if (profile.codeMieProject === null) {
  // This profile has been deliberately disconnected from CodeMie.
} else if (process.env.CODEMIE_PROJECT?.trim()) {
  activeProject = process.env.CODEMIE_PROJECT.trim();
} else if (typeof profile.codeMieProject === 'string' && profile.codeMieProject) {
  activeProject = profile.codeMieProject;
} else if (typeof config.workspace?.codeMieProject === 'string' && config.workspace.codeMieProject) {
  activeProject = config.workspace.codeMieProject;
}
```

- [ ] **Step 4: Pass `activeProject` to `selectBudgetRow`** — replace the placeholder `null` from Task 1 step 4 with the real `activeProject` value.

- [ ] **Step 5: Run tests — verify they pass**

- [ ] **Step 6: Commit** — `fix(statusline): resolve session project for budget row selection`

---

### Task 3: Project-aware cache key

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline.ts:35-40, 728-736, 794` — cache constants, hit condition, write

**Test-first: yes**

**Interfaces:**
- Cache schema bumped from `2` to `3`; cache record gains `project: string` field

- [ ] **Step 1: Write failing test** in `statusline.test.ts`:

```ts
// AC8: cache written for profile P / project A must be rejected for profile P / project B
// Use the writeFile/readFile seam. Write a cache entry with project='proj-a', then
// call resolveBudget with the same profile but project='proj-b'.
// Expect: fetchImpl IS called (cache miss), not reading stale data.
```

- [ ] **Step 2: Run test — verify it fails**

- [ ] **Step 3: Update cache constants and logic** in `statusline.ts`:
  - `CACHE_SCHEMA = 3` (line 40)
  - Cache record shape: add `project: string`
  - Hit condition (line 728-736): add `&& cached.project === (activeProject ?? '')`
  - Cache write (line 794): add `project: activeProject ?? ''` to the written object

- [ ] **Step 4: Run tests — verify they pass** (schema bump discards all old schema-2 entries, so existing cache tests remain green)

- [ ] **Step 5: Commit** — `fix(statusline): add project to cache key, bump schema to 3`

---

### Task 4: Fix stale installer description

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline-installer.ts:12-14, 15`

**Test-first: no** — documentation-only change, no behaviour to test.

- [ ] **Step 1: Correct the stale comment** — remove or rewrite lines 12-14 that say "The budget segment was removed". Replace with an accurate summary (e.g. "The budget segment shows the project CLI budget for the current session, with a fallback to the personal CLI budget.").

- [ ] **Step 2: Update `STATUSLINE_DESCRIPTION`** (line 15) to include the budget segment so it matches what the bundle actually renders.

- [ ] **Step 3: Commit** — `docs(statusline): correct stale installer description`

---

## Negative-constraint audit

- **NG1** (no charging change): all tasks modify display logic only. No task touches provider templates, `launch-identity.ts`, or the backend. ✓
- **NG2** (no priority-order change): `activeProject` derivation in Task 2 reads env/config but does not alter what CodeMie charges. ✓
- **NG3** (no web UI): no task touches non-CLI files. ✓
- **NG4** (single budget only): `selectBudgetRow` returns at most one row; `buildStatusLine` receives a single `{text, pct}`. No task adds a second segment. ✓
