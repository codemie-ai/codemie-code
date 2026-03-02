---
name: dark-factory
description: This skill should be used when the user asks to "delegate a Jira ticket to dark factory", "start working on EPMCDME ticket as a factory", "implement EPMCDME ticket",
  "begin implementation", "implement task autonomously", or wants structured technical leadership for implementing a Jira ticket.
  A valid EPMCDME-XXXXX ticket ID is REQUIRED to start. If no ticket is provided, the skill will block and ask the user to create one first.
version: 0.3.0
---

# Dark Factory: Autonomous Implementation Workflow

## Purpose

This skill is a fully autonomous AI implementation factory. Given a **Jira ticket ID (EPMCDME-XXXXX)**,
it drives the complete cycle from requirements through to a merged MR — without asking for approvals at
each step. It makes technical decisions, follows project patterns, self-reviews, validates in the browser,
and creates the MR.

**A Jira ticket is mandatory.** Dark Factory does not accept free-form task descriptions as a starting
point. If no ticket is provided, stop immediately and ask the user to provide one.

**Core principle**: Work autonomously. Resolve ambiguity through analysis, not questions. Only ask
the user when requirements are genuinely unclear and cannot be inferred.

---

## Autonomous Workflow

```
Phase 1 → Requirements & Jira
Phase 2 → Complexity Assessment
Phase 3 → Specification (Medium/Complex only)
Phase 4 → Branch + Implementation
Phase 5 → Code Review (auto-fix critical/major)
Phase 6 → UI Validation (browser testing, no Jira publish)
Phase 7 → Quality Gates + MR
```

---

## Phase 1: Requirement Gathering

### Step 1a: Gate — Jira Ticket Required

**Check for a valid ticket ID (`EPMCDME-XXXXX`) in the user's request.**

- ✅ **Ticket provided** → continue to Step 1b
- ❌ **No ticket provided** → STOP. Respond with:

  > Dark Factory requires a Jira ticket to start. Please provide an `EPMCDME-XXXXX` ticket ID.
  >
  > If you don't have a ticket yet, you can:
  > - Create one using the **brianna** skill: ask brianna to create a ticket for your task
  > - Create it directly in the **CodeMie platform** at the EPMCDME project board
  >
  > Once you have a ticket, come back with the ID and I'll start implementation.

  Do **not** proceed without a ticket. Do **not** accept a task description as a substitute.

### Step 1b: Fetch Ticket Details

Fetch the ticket via brianna skill (NOT a sub-agent — call the skill directly):
```
Skill(skill="brianna", args="get ticket EPMCDME-XXXXX fields: description, summary")
```

- If the ticket **doesn't exist**: inform the user and stop
- If the ticket **exists**: continue

### Step 1c: Check for Duplicates

Ask brianna to search for similar open tickets:
```
Skill(skill="brianna", args="search for tickets similar to [summary] in EPMCDME project, status: open")
```
- If duplicates found: note them and proceed (the provided ticket is the source of truth)

### Step 1d: Clarifying Questions

Ask only if acceptance criteria are vague or ambiguous in a way that blocks implementation.
Skip if requirements are clear.

### Branch Naming

Always use the exact ticket ID as the branch name — no prefix, no suffix.

| Format | Example |
|--------|---------|
| `EPMCDME-XXXXX` | `EPMCDME-10500` |

---

## Phase 2: Complexity Assessment

Assess using the [Complexity Assessment Guide](references/complexity-assessment-guide.md).

Score each dimension (1=Simple, 2=Medium, 3=Complex):
- Component Scope (how many files/layers)
- Requirements Clarity
- Technical Risk
- File Change Estimate
- Dependencies

| Total Score | Complexity | Path |
|-------------|------------|------|
| 5-7 | **Simple** / Bug fix | → Direct to Phase 4 (Implementation) |
| 8-11 | **Medium** | → Phase 3 (Specification), then Phase 4 |
| 12-15 | **Complex** | → Phase 3 (Specification), then Phase 4 |

**Special rule**: Bug fixes and small isolated changes always go directly to Phase 4, regardless
of score, unless they involve architectural risk.

Output a brief complexity summary before proceeding:
```markdown
## Complexity: [Simple | Medium | Complex] (Score: X/15)
- Scope: [summary]
- Risk: [summary]
- Files affected: [estimate]
→ Path: [Direct implementation | Specification first]
```

---

## Phase 3: Specification (Medium and Complex Only)

### Step 3a: Invoke Solution Architect

Delegate to the solution-architect sub-agent with full context:
```
Task(subagent_type="solution-architect", prompt="
  Generate implementation plan for [ticket/task].
  Requirements: [requirements text]
  Complexity: [Medium/Complex]
  Affected areas: [list from complexity assessment]
  Constraints: [any technical decisions already made]
  Coding standards: Follow CLAUDE.md and .codemie/guides/
")
```

### Step 3b: Review the Specification

Review the generated `.md` spec against the requirements:

**Auto-proceed if:**
- All acceptance criteria are covered
- The implementation path is clear
- No architectural ambiguity remains

**Delegate back to architect if:**
- A requirement is not addressed
- The approach contradicts project patterns
- A critical decision is left as TBD

```
Task(subagent_type="solution-architect", prompt="
  Revise the spec. Issues found:
  1. [Issue 1 - what's missing or wrong]
  2. [Issue 2]
  The spec must address all acceptance criteria before implementation.
")
```

Repeat until the spec is implementation-ready.

---

## Phase 4: Branch Creation and Implementation

### Step 4a: Create Feature Branch

**CRITICAL: Always create the branch before touching any code.**

```bash
# Ensure clean state on main
git checkout main
git pull origin main

# Create and push feature branch
git checkout -b EPMCDME-XXXXX   # or feature/branch-name
git push -u origin EPMCDME-XXXXX
```

If branch already exists locally: switch to it and pull latest (`git checkout EPMCDME-XXXXX && git pull`).

### Step 4b: Implement

**Before coding**, load the relevant guides from `.codemie/guides/` (see CLAUDE.md Task Classifier).

**Implementation order** (respect layer dependencies):
1. Types (`src/types/`)
2. Constants (`src/constants/`)
3. Store (`src/store/`)
4. Hooks (`src/hooks/`)
5. Components (`src/components/`)
6. Pages (`src/pages/`)
7. Router (`src/router.tsx`)

**Coding standards** (non-negotiable):
- Tailwind only — no custom CSS
- Use Popup, not Dialog
- API via custom fetch wrapper, parse with `.json()`
- Valtio stores for global state
- React Hook Form + Yup for forms
- `cn()` from `@/utils/utils`
- `??` not `||` for defaults
- Single quotes for strings
- Components under 300 lines

Commit incrementally with descriptive messages following conventional commits format:
```
<type>(<scope>): <imperative description>

Refs: EPMCDME-XXXXX
```

Where `<type>` is one of: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
And `<scope>` is one of: `cli`, `agents`, `providers`, `assistants`, `config`, `proxy`, `workflows`, `analytics`, `utils`, `deps`, `tests`, `skills` (omit if none applies)

---

## Phase 5: Code Review

Invoke the code-reviewer sub-agent on all changed files:
```
Task(subagent_type="code-reviewer", prompt="
  Review all changes made for [ticket/task] on branch [branch-name].
  Focus on: correctness, React/TypeScript patterns, Valtio usage, Tailwind styling,
  accessibility, and security. Flag critical and major issues.
")
```

**Auto-fix all critical and major issues** found in the review output before continuing.

After fixing, re-run lint to confirm:
```bash
npm run lint:fix
```

---

## Phase 6: UI Validation

Invoke the ui-tester sub-agent to verify the implemented functionality in the browser:
```
Task(subagent_type="ui-tester", prompt="
  Verify the following functionality works correctly in the browser:
  [List of acceptance criteria / user flows]
  Base URL: http://localhost:5173
  Do NOT post to Jira. Only verify and report pass/fail.
")
```

**On failures**: Fix the issue and re-run ui-tester until all scenarios pass.

**Do NOT** publish screenshots or test results to Jira automatically.

---

## Phase 7: Quality Gates and MR

### Step 7a: Run Quality Checks

```bash
# Unit tests
npm test

# Lint
npm run lint

# Build check (optional for large changes)
npm run build
```

All checks must pass before creating the MR. Fix any failures.

### Step 7b: Commit Final Changes

Stage and commit all remaining changes:
```bash
git add <specific files>
git commit -m "$(cat <<'EOF'
<type>(<scope>): final cleanup and fixes

Refs: EPMCDME-XXXXX
EOF
)"
git push
```

### Step 7c: Create Merge Request

Use the codemie-mr skill or create directly:
```
Skill(skill="codemie-mr", args="create MR for branch EPMCDME-XXXXX")
```

Or via gh CLI:
```bash
gh pr create --title "<type>(<scope>): [summary]" --body "$(cat <<'EOF'
## Summary
- [Change 1]
- [Change 2]

## Test Plan
- [ ] Unit tests pass
- [ ] Lint passes
- [ ] UI validation passed (ui-tester)

## Related
- Jira: EPMCDME-XXXXX

🤖 Generated with Claude Code
EOF
)"
```

---

## Error Handling

### Ticket Not Found
```
Unable to fetch EPMCDME-XXXXX. Verify the ticket ID and Jira access.
Stopping — cannot proceed without requirements.
```

### Branch Already Exists
Automatically switch to it and continue:
```bash
git checkout EPMCDME-XXXXX
git pull origin EPMCDME-XXXXX
```

### Tests Failing
Do not create MR. Fix failing tests first, then re-run quality gates.

### UI Validation Failures
Fix the reported issues and re-run ui-tester before proceeding to Step 7.

---

## Key Principles

### Do's
✅ **Require a Jira ticket** — block and redirect if none is provided
✅ Work autonomously — don't ask for approvals at each phase
✅ Fetch only required Jira fields (description, summary)
✅ Always check for duplicate/related tickets via brianna
✅ Create feature branch before any code changes
✅ Use complexity score to route: simple → direct, medium/complex → spec first
✅ Auto-fix critical and major code review issues
✅ Run UI validation before MR — fix failures before continuing
✅ Run tests and lint before MR

### Don'ts
❌ **Don't accept free-form task descriptions** — always require EPMCDME-XXXXX first
❌ Don't ask "shall I proceed?" between phases — proceed autonomously
❌ Don't skip the Jira duplicate check
❌ Don't start coding before branch creation
❌ Don't publish UI test results to Jira automatically
❌ Don't create MR with failing tests or lint errors
❌ Don't use solution architect for simple/bug-fix tasks
❌ Don't guess at complexity — use the scoring matrix

---

## Reference Files

- **`references/complexity-assessment-guide.md`** — Scoring criteria and examples
- **`references/branch-workflow.md`** — Git branching best practices
- **`examples/simple-feature-example.md`** — Full walkthrough: simple task
- **`examples/complex-feature-example.md`** — Full walkthrough: complex task
- **`examples/non-jira-task-example.md`** — Full walkthrough: no Jira ticket

---

## Integration Points

| Skill / Agent | When | How |
|---------------|------|-----|
| **brianna** | Phase 1 — ticket fetch + duplicate search | `Skill(skill="brianna", ...)` |
| **solution-architect** | Phase 3 — Medium/Complex spec | `Task(subagent_type="solution-architect", ...)` |
| **code-reviewer** | Phase 5 — code quality | `Task(subagent_type="code-reviewer", ...)` |
| **ui-tester** | Phase 6 — browser validation | `Task(subagent_type="ui-tester", ...)` |
| **codemie-mr** | Phase 7 — MR creation | `Skill(skill="codemie-mr", ...)` |
