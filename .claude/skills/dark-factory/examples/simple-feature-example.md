# Example: Simple Feature — Full Autonomous Run

## Scenario

**Input:** `"Implement EPMCDME-10500"`

**Ticket Description:**
```
As a user, I want to see the skill category displayed as a badge on the
skill card in the skills list so I can quickly identify skill types.

Acceptance Criteria:
- Show category badge on SkillCard component
- Use appropriate color per category
- Badge should be styled consistently with other badges in the app
```

---

## Phase 1: Requirement Gathering

**Action 1** — Fetch ticket details:
```
Skill(skill="brianna", args="get ticket EPMCDME-10500 fields: description, summary")
```
→ Receives: title "Add category badge to SkillCard", AC as above

**Action 2** — Check for duplicates:
```
Skill(skill="brianna", args="search for tickets similar to 'add category badge to skill card' in EPMCDME project, status: open")
```
→ No duplicates found. Proceeding.

Requirements are clear. No clarifying questions needed.

---

## Phase 2: Complexity Assessment

```markdown
## Complexity: Simple (Score: 5/15)
- Scope: Single component (SkillCard), UI-only change
- Risk: Low — existing Badge component + existing category field
- Files affected: 1 file modified, 0 new
→ Path: Direct implementation (no specification needed)
```

---

## Phase 4: Branch Creation and Implementation

*(Phase 3 skipped — Simple complexity)*

**Branch creation:**
```bash
git checkout main
git pull origin main
git checkout -b EPMCDME-10500
git push -u origin EPMCDME-10500
```

**Guide consultation:**
```
Read .codemie/guides/components/component-patterns.md
Read .codemie/guides/components/reusable-components.md
Read .codemie/guides/styling/styling-guide.md
```

**Codebase exploration:**
```
Glob pattern="*Skill*.tsx" path="src/"
→ src/pages/skills/components/SkillCard.tsx

Grep pattern="badge|Badge" glob="*.tsx" path="src/components/" output_mode="files_with_matches"
→ src/components/Badge/Badge.tsx (exists, used in AssistantCard)

Grep pattern="category" glob="*.ts" path="src/types/entity/" output_mode="content" -n
→ Skill type has: category: string
```

**Implementation:**
```tsx
// src/pages/skills/components/SkillCard.tsx — after:
import { Badge } from '@/components/Badge/Badge';

export const SkillCard = ({ skill }: SkillCardProps) => {
  return (
    <div className='rounded-lg border border-gray-200 p-4'>
      <div className='flex items-start justify-between'>
        <h3 className='text-sm font-semibold'>{skill.name}</h3>
        {skill.category && <Badge label={skill.category} />}
      </div>
      <p className='mt-1 text-xs text-gray-500'>{skill.description}</p>
    </div>
  );
};
```

**Commit:**
```bash
git add src/pages/skills/components/SkillCard.tsx
git commit -m "EPMCDME-10500: Add category badge to SkillCard

- Display skill category as Badge in card header
- Badge conditionally rendered when category is present
- Follows existing Badge pattern from AssistantCard

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Phase 5: Code Review

```
Task(subagent_type="code-reviewer", prompt="
  Review changes for EPMCDME-10500 on branch EPMCDME-10500.
  Changed file: src/pages/skills/components/SkillCard.tsx
  Focus on: React patterns, Tailwind styling, accessibility.
")
```

**Review output:** Minor — add `aria-label` to the badge for screen readers.

**Auto-fix applied:**
```tsx
{skill.category && <Badge label={skill.category} aria-label={`Category: ${skill.category}`} />}
```

```bash
npm run lint:fix
```

---

## Phase 6: UI Validation

```
Task(subagent_type="ui-tester", prompt="
  Verify in browser at http://localhost:5173:
  1. Navigate to Skills list page
  2. Confirm each skill card shows a category badge
  3. Confirm badge styling matches other badges in the app (e.g., AssistantCard)
  4. Confirm cards without category don't show a broken badge
  Do NOT post to Jira. Report pass/fail only.
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
git add src/pages/skills/components/SkillCard.tsx
git push

gh pr create --title "EPMCDME-10500: Add category badge to SkillCard" --body "$(cat <<'EOF'
## Summary
- Added category Badge to SkillCard component
- Badge is conditionally rendered (hidden when category is absent)
- Follows existing Badge usage from AssistantCard

## Test Plan
- [x] Unit tests pass
- [x] Lint passes
- [x] UI validation passed (ui-tester)

## Related
- Jira: EPMCDME-10500

🤖 Generated with Claude Code
EOF
)"
```

---

## Outcome

| Metric | Value |
|--------|-------|
| Files changed | 1 |
| Lines added | 4 |
| Code review issues | 1 minor (auto-fixed) |
| UI validation | ✅ All pass |
| Tests | ✅ All pass |
| Total phases | 6 (Phase 3 skipped) |
