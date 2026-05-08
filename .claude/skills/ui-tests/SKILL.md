---
name: ui-tests
description: This skill should be used when a user says "run UI tests", "test the frontend", "run browser tests", "check UI regressions", or when qa-lead invokes it after detecting UI file changes. Runs UI/component tests for changed frontend files. This skill applies only when changes include .tsx/.jsx/.css/.html/component files — skip for backend-only changes.
version: 0.1.0
---

# UI Tests: Frontend and Component Tests

## Purpose

Runs UI tests scoped to changed frontend files. Invoked by `qa-lead` when git diff shows changes in UI-related files. Distinguishes regressions from expected visual changes and reports clearly.

## When to Invoke

Invoke only when the changeset includes:
- `.tsx`, `.jsx` files
- `.css`, `.scss`, `.html` files
- `src/ui/`, `src/frontend/`, `src/components/` directories
- `.vue`, `.svelte` files

Skip for backend-only changes (Node.js CLI, providers, agents with no UI).

---

## Step 1: Scope the Changed UI Files

```bash
git diff origin/main --name-only | grep -E "\.(tsx|jsx|css|html|vue|svelte)$|src/ui/|src/frontend/|src/components/"
```

List the changed files — these define the scope of what needs testing.

---

## Step 2: Run UI Tests

Run the project's UI test command. Check `package.json` for the available scripts:

```bash
# Try these in order (first one that exists):
npm run test:ui
npm run test:e2e
npm run test:components
npx playwright test
npx vitest --project ui
```

If no dedicated UI test command exists in `package.json`, report:
> "No UI test command found in package.json. Manual verification required for changed UI files: [list files]"

---

## Step 3: Classify Failures

Not all UI test failures are regressions. Classify each failure:

**Regression** (unexpected failure):
- A test that previously passed now fails
- Screenshot diff with unintended pixel changes
- Broken interaction (button not clickable, form not submitting)
- → Report as blocker; ask implementer to fix

**Expected change** (intentional UI update):
- Test was written for old UI, implementation intentionally changed it
- Screenshot diff matches the new design intent
- → Document the change, update the test/snapshot to reflect new UI, then re-run

---

## Report Format

### All tests pass:

```markdown
## UI Tests: PASSED ✅

**Changed UI files**: N files
**Tests run**: N suites, N tests
**Regressions**: 0

qa-lead may proceed to next gate.
```

### Regression detected:

```markdown
## UI Tests: FAILED ⛔

**Changed UI files**: src/components/Button.tsx, src/ui/dashboard.css
**Tests run**: 12 suites, 47 tests
**Regressions**: 2

### Regression 1: ButtonComponent.spec.tsx — "renders disabled state"
- Expected: button has opacity 0.5
- Actual: button has opacity 1.0
- Fix needed: update disabled style in Button.tsx

### Regression 2: DashboardLayout.spec.tsx — "sidebar width matches design"
- Expected: 240px
- Actual: 260px
- Fix needed: revert sidebar width change or update spec

Fix the regressions above, then re-invoke ui-tests.
```

### Expected change (needs snapshot update):

```markdown
## UI Tests: NEEDS SNAPSHOT UPDATE ⚠️

**Changed UI files**: src/components/Header.tsx
**Failing tests**: 1 (expected visual change — not a regression)

### Update Required: Header.spec.tsx — "renders nav links"
- Intentional change: nav link style updated to match new design
- Action: run `npm run test:ui -- --update-snapshots` to update snapshot, then re-run tests
```

---

## Key Principles

### Do's
✅ Scope tests to changed UI files — no need to run the entire test suite
✅ Classify failures: regressions vs. expected changes
✅ Update snapshots for intentional visual changes, not to hide regressions
✅ Report specific component and test names for any failure

### Don'ts
❌ Don't invoke for backend-only changes
❌ Don't auto-update snapshots without confirming with the user whether the change is intentional
❌ Don't treat snapshot mismatches as always regressions — check if the UI change was intentional

---

## Integration

### qa-lead
- Invoked after `automated-tests` passes, only if `ui_changes=true`
- Returns PASSED, FAILED (regression), or NEEDS SNAPSHOT UPDATE
- PASSED → qa-lead proceeds to spec-refinement (conditional)
- FAILED → qa-lead stops; implementer fixes regression
- NEEDS SNAPSHOT UPDATE → update snapshots, re-run, then report PASSED

### automated-tests
- Prerequisite: must pass before ui-tests runs
- Shares the same Node.js project commands context
