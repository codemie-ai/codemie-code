# Example: No Jira Ticket — Full Autonomous Run

## Scenario

**Input:** `"Improve form validation messages in the skill form to be more user-friendly"`

No Jira ticket provided.

---

## Phase 1: Requirement Gathering

**Action 1** — Search for existing related tickets:
```
Skill(skill="brianna", args="search for tickets related to 'skill form validation messages' in EPMCDME project, status: open")
```
→ No matching open tickets found.

**Suggest creating a ticket** (informational — does not block):
```
No existing Jira ticket found for this task.
Consider creating one via brianna for traceability.
Proceeding with implementation using the provided description.
```

**Document requirements:**
```markdown
## Task Requirements
**Goal**: Improve validation error messages in the skill creation/edit form to be
  clear, actionable, and user-friendly.

**Acceptance Criteria**:
- Error messages are descriptive (e.g., "Please enter a skill name" not just "Required")
- Messages specify exactly what needs to be fixed
- Consistent tone across all skill form fields
- Existing React Hook Form + Yup pattern maintained
- No structural form changes

**Context**: Skill form at src/pages/skills/
```

**Branch name**: Task is clear — using `fix/skill-form-validation-messages`.

---

## Phase 2: Complexity Assessment

```markdown
## Complexity: Simple (Score: 6/15)
- Scope: 1-2 files (Yup schema in form hook + optional constants file)
- Risk: Low — no architecture change, enhancement only
- Files affected: 2 files modified, 0 new (or 1 new constants entry)
→ Path: Direct implementation (no specification needed)
```

---

## Phase 4: Branch Creation and Implementation

*(Phase 3 skipped — Simple complexity)*

**Branch creation:**
```bash
git checkout main
git pull origin main
git checkout -b fix/skill-form-validation-messages
git push -u origin fix/skill-form-validation-messages
```

**Guide consultation:**
```
Read .codemie/guides/patterns/form-patterns.md
Read .codemie/guides/development/constants-usage.md
```

**Codebase exploration:**
```
Glob pattern="*Skill*Form*" path="src/"
→ src/pages/skills/hooks/useSkillForm.ts
→ src/pages/skills/components/SkillForm.tsx

Grep pattern="\.required\|\.min\|\.max" glob="*.ts" path="src/pages/skills/" output_mode="content" -n
→ Yup schema in useSkillForm.ts has bare .required() with no messages

Grep pattern="SKILL_FORM" glob="*.ts" path="src/constants/" output_mode="content"
→ Not found — no existing validation constants
```

**Implementation:**

Step 1 — Add validation message constants to `src/constants/skills.ts`:
```ts
export const SKILL_FORM_VALIDATION = {
  name: {
    required: 'Please enter a skill name',
    min: 'Skill name must be at least 2 characters',
    max: 'Skill name cannot exceed 100 characters',
  },
  description: {
    required: 'Please add a description for this skill',
    max: 'Description cannot exceed 500 characters',
  },
  category: {
    required: 'Please select a category for this skill',
  },
} as const;
```

Step 2 — Update Yup schema in `src/pages/skills/hooks/useSkillForm.ts`:
```ts
import { SKILL_FORM_VALIDATION } from '@/constants/skills';

const schema = yup.object({
  name: yup
    .string()
    .required(SKILL_FORM_VALIDATION.name.required)
    .min(2, SKILL_FORM_VALIDATION.name.min)
    .max(100, SKILL_FORM_VALIDATION.name.max),
  description: yup
    .string()
    .required(SKILL_FORM_VALIDATION.description.required)
    .max(500, SKILL_FORM_VALIDATION.description.max),
  category: yup
    .string()
    .required(SKILL_FORM_VALIDATION.category.required),
});
```

**Commit:**
```bash
git add src/constants/skills.ts src/pages/skills/hooks/useSkillForm.ts
git commit -m "fix/skill-form-validation-messages: Improve skill form validation messages

- Add SKILL_FORM_VALIDATION constants with user-friendly messages
- Update Yup schema to use descriptive messages for all fields
- Extract strings to constants to avoid magic strings

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Phase 5: Code Review

```
Task(subagent_type="code-reviewer", prompt="
  Review changes for skill form validation messages on branch fix/skill-form-validation-messages.
  Changed files: src/constants/skills.ts, src/pages/skills/hooks/useSkillForm.ts
  Focus on: Yup schema correctness, constants structure, TypeScript types, naming conventions.
")
```

**Review output:** No critical or major issues. 1 minor suggestion (use `as const` on schema object — already present). ✅

```bash
npm run lint:fix
```

---

## Phase 6: UI Validation

```
Task(subagent_type="ui-tester", prompt="
  Verify in browser at http://localhost:5173:
  1. Navigate to New Skill page (/skills/new)
  2. Submit empty form — confirm all three fields show descriptive error messages
     (not just 'Required')
  3. Enter 1-character name — confirm min-length error appears
  4. Enter valid data — confirm no validation errors shown
  Do NOT post to Jira. Report pass/fail for each scenario.
")
```

**Result:** All scenarios pass. ✅

---

## Phase 7: Quality Gates and MR

```bash
npm test
# ✅ All tests pass

npm run lint
# ✅ No lint errors
```

```bash
git push

gh pr create --title "fix: Improve skill form validation messages" --body "$(cat <<'EOF'
## Summary
- Added SKILL_FORM_VALIDATION constants with clear, user-friendly messages
- Updated Yup schema in useSkillForm to use descriptive messages for all fields
- Messages follow imperative tone: "Please enter..." / "Please select..."

## Test Plan
- [x] Unit tests pass
- [x] Lint passes
- [x] UI validation passed (ui-tester) — all 4 scenarios verified

🤖 Generated with Claude Code
EOF
)"
```

---

## Outcome

| Metric | Value |
|--------|-------|
| Files changed | 2 |
| Lines added | ~25 |
| Jira ticket | None (suggested creating one) |
| Code review issues | 0 critical/major |
| UI validation | ✅ All pass |
| Tests | ✅ All pass |
| Total phases | 6 (Phase 3 skipped) |
