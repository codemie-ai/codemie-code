---
name: qa-lead
description: Use this skill when a user says "run qa", "quality gates", "final checks before merge", "is the branch ready to merge", or when tech-lead has completed implementation and code review phases. Orchestrates final quality gates by invoking automated-tests (always), ui-tests (if UI changes detected), and optionally spec-refinement (if spec drift found), then reminds to run /memory-refresh. Invoke at the end of every implementation session.
version: 0.1.0
---

# QA Lead: Final Quality Gates Orchestrator

## Purpose

This skill runs after all implementation tasks complete and code review passes. It ensures the branch is genuinely ready to merge by running a structured sequence of quality checks, detecting test failures, and optionally updating the spec if implementation drifted from it.

## Prerequisites

Before invoking this skill:
- All implementation tasks complete (`superpowers:subagent-driven-development` finished)
- Code review passed (`superpowers:requesting-code-review` + `superpowers:receiving-code-review` done)
- Working inside an isolated worktree (branch is not main/master)

## Quality Gate Flow

```
Step 1: Detect UI Changes
    ↓
Step 2: Invoke automated-tests
    ↓
   PASS → Step 3 (conditional)        FAIL → diagnose + fix, re-run
    ↓
Step 3 (if ui_changes=true): Invoke ui-tests
    ↓
   PASS → Step 4                      FAIL → diagnose + fix, re-run
    ↓
Step 4 (if spec_drift=true): Invoke spec-refinement
    ↓
Step 5: /memory-refresh reminder
    ↓
Report gate result
```

---

## Step 1: Detect UI Changes

Check git diff against main to determine if UI tests are needed:

```bash
git diff origin/main --name-only | grep -E "\.(tsx|jsx|css|html|vue|svelte)$|src/ui/|src/frontend/|src/components/" | head -20
```

- If matches found → UI tests required (flag `ui_changes=true`)
- If no matches → skip UI tests

---

## Step 2: Invoke automated-tests

```
Invoke Skill: automated-tests
Provide: branch name, current worktree path
```

**automated-tests** runs: lint (`npm run lint`) → build (`npm run build`) → unit tests (`npm test`)

If automated-tests **FAILS**:
1. Read the failure output
2. Assess: is this a code bug or spec drift?
   - **Code bug** (test assertions fail, unexpected runtime error) → ask implementer to fix; re-run automated-tests after fix
   - **Spec drift** (implementation changed public contracts, types, or behavior) → set `flag: spec_drift=true`; continue after tests pass
3. Do not proceed past Step 2 until automated-tests passes

---

## Step 3: Invoke ui-tests (conditional)

Only invoke if `ui_changes=true` from Step 1:

```
Invoke Skill: ui-tests
Provide: branch name, list of changed UI files
```

If ui-tests **FAILS**:
1. Read the failure output
2. Determine if it's a regression or expected change
   - **Regression** → ask implementer to fix; re-run ui-tests
   - **Expected visual change** (intentional UI update) → document the change, proceed

---

## Step 4: spec-refinement (conditional)

Invoke `spec-refinement` if `spec_drift=true` (set in Step 2 during failure triage):
- Implementation diverged from the spec in a meaningful way (new public interfaces, changed contracts, added/removed features)
- Spec references outdated types, method names, or file paths after refactoring

```
Invoke Skill: spec-refinement
Provide: spec file path, list of changes that diverged from spec
```

`spec-refinement` updates the spec to match the implemented reality so it remains accurate for future reference.

---

## Step 5: /memory-refresh reminder

After all gates pass (including spec-refinement if invoked), remind the user:

```
Quality gates passed. Run /memory-refresh (or /codemie:memory-refresh) to update
your session memory with any architectural decisions made during this implementation
before closing the session.
```

---

## Gate Report

After all checks complete, report the result:

### If all gates passed:

```markdown
## QA Gate Report: PASSED ✅

**Branch**: <branch-name>
**Automated Tests**: ✅ lint + build + unit tests
**UI Tests**: ✅ (if applicable) or ⏭️ skipped (no UI changes)
**Spec**: ✅ aligned (or updated via spec-refinement)

Branch is ready for merge. Use `codemie-pr` to create the pull request.
```

### If a gate failed:

```markdown
## QA Gate Report: BLOCKED ⛔

**Branch**: <branch-name>
**Failed Gate**: <automated-tests | ui-tests>
**Failure**: <brief description>

Fix the issues above, then re-invoke qa-lead to re-run the failing gate.
```

---

## Key Principles

### Do's
✅ Always run automated-tests before ui-tests
✅ Fix test failures before proceeding to the next gate
✅ Remind about /memory-refresh after tests pass
✅ Invoke spec-refinement only when spec drift is real (changed contracts, not minor wording)
✅ Report a clear pass/fail gate result

### Don'ts
❌ Don't skip automated-tests — it's the primary gate
❌ Don't invoke ui-tests for backend-only changes
❌ Don't invoke spec-refinement for every implementation — only when spec is materially inaccurate
❌ Don't mark branch as merge-ready if any gate is blocked
❌ Don't run quality gates on main/master

---

## Integration with Other Skills

### automated-tests
- Runs lint + build + unit tests
- Primary quality gate — must pass before anything else

### ui-tests
- Conditional on UI file changes
- Runs browser/component tests

### spec-refinement
- Updates spec when implementation diverged
- Optional — only when spec is materially wrong

### tech-lead
- Invokes qa-lead as Phase 5 after subagent-driven-development + code review
- qa-lead reports back PASSED/BLOCKED

### codemie-pr
- Invoked by user after qa-lead reports PASSED
- Creates the pull request for the branch
