---
name: spec-refinement
description: This skill should be used when a user says "update the spec", "refine the spec", "spec is outdated", "sync spec with implementation", or when qa-lead invokes it because spec_drift was detected during implementation. Updates existing spec/plan documents to reflect what was actually implemented, so the spec remains accurate for future reference. Do not use to change requirements — only to align the spec with implemented reality.
version: 0.1.0
---

# Spec Refinement: Align Spec with Implementation

## Purpose

After implementation, the spec sometimes drifts from what was actually built — a function was renamed, a file was split, a public interface changed. This skill updates the spec document to match the implemented reality. It does not change requirements or add features; it corrects inaccuracies so the spec remains a trustworthy artifact.

## When to Invoke

Invoke when:
- A public interface or type signature changed during implementation
- File paths in the spec no longer match the actual file structure
- Method or class names were renamed during implementation
- A feature was descoped or simplified (with user approval) and the spec still describes the old approach
- qa-lead sets `spec_drift=true` during quality gate triage

Do NOT invoke when:
- The spec is correct and implementation followed it
- You want to add new requirements (open a new ticket instead)
- Minor wording improvements are desired (not worth the churn)

---

## Step 1: Identify the Spec File

Locate the spec or plan file to update:
- Plans: `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`
- Specs/design docs: `docs/superpowers/specs/YYYY-MM-DD-<feature-name>-design.md`

If not provided by the caller (qa-lead or user), ask: "Which spec file needs updating?"

---

## Step 2: Diff Implementation vs. Spec

Compare the actual implementation to the spec by:

1. Reading the spec file in full
2. Checking the git diff for changed public APIs:
   ```bash
   git diff origin/main -- "*.ts" "*.js" | grep -E "^[+-].*(export|interface|type |class |function )" | head -40
   ```
3. Identifying discrepancies:

| What to check | How |
|---|---|
| File paths | Compare spec `Files:` sections to actual `git diff --name-only` |
| Type/interface names | Compare spec type names to actual exported types |
| Method signatures | Compare spec code snippets to actual implementations |
| Removed features | Check if spec describes anything not in the codebase |

---

## Step 3: Apply Targeted Updates

Update only what drifted — do not rewrite the spec. Each change should be the minimum edit to make the spec accurate:

- Rename a type: update every occurrence in the spec
- Changed file path: update the `Files:` section of the relevant task
- Simplified implementation: remove the section describing the removed approach, keep the implemented one
- Added a field to an interface: add it to the spec's type definition

**What not to change**:
- The goal/acceptance criteria sections (these describe requirements, not implementation)
- The reasoning behind architectural choices
- Historical context ("we chose X over Y because...")

---

## Step 4: Commit the Updated Spec

**If the user explicitly requested a commit** (e.g., "commit the spec", "run qa", direct user invocation), commit after updating:

```bash
git add docs/superpowers/plans/<filename>.md
git commit -m "docs(spec): align <feature> spec with implementation

- <change 1>
- <change 2>"
```

**If invoked programmatically by qa-lead** (no direct user commit request), skip the commit and include the changes in the report. The user can commit when ready.

---

## Report Format

```markdown
## Spec Refinement: COMPLETE ✅

**Spec file**: docs/superpowers/plans/2026-05-03-feature-name.md

### Changes made:
- Renamed `MessageStore` → `CCRStore` (Task 1, interface definition)
- Updated file path: `src/utils/store.ts` → `src/ccr/store.ts` (Task 1, Files section)
- Removed `computeHash()` method from spec (not implemented — integrated into `alignForCache()`)

Spec is now aligned with implementation. Committed as docs(spec): align feature spec.
```

---

## Key Principles

### Do's
✅ Make minimum changes to align spec with reality
✅ Update all occurrences of renamed identifiers
✅ Commit the spec change separately from implementation commits
✅ Describe what changed (old → new) in the report

### Don'ts
❌ Don't add new requirements to the spec
❌ Don't rewrite the spec from scratch — patch it
❌ Don't change the goals, rationale, or acceptance criteria sections
❌ Don't invoke for minor wording issues — only for materially inaccurate content
❌ Don't skip the commit — spec changes must be tracked in git

---

## Integration

### qa-lead
- Invoked when `spec_drift=true` (set during automated-tests failure triage)
- Fires after all tests pass, before `/memory-refresh` reminder
- Returns: COMPLETE with list of changes made

### spec-reviewer
- spec-reviewer validates the spec *before* implementation starts
- spec-refinement corrects the spec *after* implementation diverges from it
- These are complementary, not redundant
