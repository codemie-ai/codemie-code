---
name: tech-lead
description: Use when starting implementation of a Jira ticket, feature, or task. Orchestrates the full SDLC from requirements to QA — requirements gathering → worktree creation → complexity scoring → brainstorming (complex) or writing-plans (simple) → spec-reviewer → subagent-driven-development → qa-lead. Also triggers on: "implement a Jira ticket", "start working on EPMCDME ticket", "analyze task", "begin implementation", "implement new task", "implement feature", "act as tech lead", "plan implementation", "how should I implement".
version: 0.2.0
---

# Tech Lead: Full SDLC Orchestrator

## Purpose

This skill orchestrates the full development lifecycle from requirements to QA. It:
- Gathers requirements (Jira ticket or free-form description)
- Creates an isolated worktree for the feature
- Scores complexity across 5 dimensions to route to the right planning path
- Drives planning, review, implementation, and quality gates

## Full SDLC Flow

```
Phase 1: Requirements Gathering
    ↓
superpowers:using-git-worktrees  (isolated branch + worktree)
    ↓
Phase 2: Assessment + Complexity Scoring  (inside worktree)
    ↓
Score 5–7  → superpowers:writing-plans → spec-reviewer → superpowers:subagent-driven-development
Score 8–15 → superpowers:brainstorming → superpowers:writing-plans → spec-reviewer → superpowers:subagent-driven-development
    ↓
superpowers:requesting-code-review + superpowers:receiving-code-review
    ↓
qa-lead
```

---

## Phase 1: Requirements Gathering

### Step 1: Determine Requirement Source

Check if user provided:
- **Jira ticket ID** (EPMCDME-XXXXX format)
- **Task description** (user-provided text)

**If Jira Ticket Provided:**

Use the brianna skill to fetch description and summary fields only:

```
Use Skill tool with skill="brianna" and args:
"Get ticket details for EPMCDME-XXXXX. I need only the description and summary fields."
```

Do NOT request status, assignee, or other fields unless needed for the complexity assessment.

**If Task Description Provided:**

1. Confirm understanding of requirements
2. Ask clarifying questions if requirements are vague
3. Document requirements in structured format:

```markdown
## Task Requirements

**Goal**: [What needs to be implemented]

**Acceptance Criteria**:
- [Criterion 1]
- [Criterion 2]

**Context**: [Any additional context or constraints]
```

### Step 2: Determine Branch Name

**If Jira ticket:** Branch name = `EPMCDME-XXXXX` (exact ticket ID, no prefix)

**If no Jira ticket:** Suggest `feature/descriptive-name` or `task/descriptive-name` (kebab-case). Confirm with user before proceeding.

### Step 3: Create Worktree

Invoke `superpowers:using-git-worktrees` with the determined branch name. All subsequent work happens inside the worktree.

```
Invoke Skill: superpowers:using-git-worktrees
Provide: branch name [EPMCDME-XXXXX or feature/name]
```

---

## Phase 2: Assessment (Inside Worktree)

### Step 4: Load Guides and Search Codebase

**Load relevant guides first** from `.codemie/guides/` based on task type:

| Task Keywords | P0 Guide |
|---|---|
| plugin, agent, registry, adapter | architecture/architecture.md |
| security, auth, credentials | security/security-practices.md |
| test, coverage, mock | testing/testing-patterns.md |
| provider, LLM, integration | integration/external-integrations.md |
| git, workflow, CI/CD | standards/git-workflow.md |
| error, exception, validation | development/development-practices.md |
| cli, command | architecture/architecture.md |

Then search the codebase for related implementations (Grep/Glob) and identify affected components.

### Step 5: Complexity Scoring

Score each dimension 1–3 points. Total range: 5–15.

| Dimension | 1 pt | 2 pts | 3 pts |
|---|---|---|---|
| **Component Scope** | Single file/function | 2–5 files, 1–2 layers | 6+ files, 3+ layers |
| **Requirements Clarity** | Fully specified | Minor gaps | Ambiguous or missing |
| **Technical Risk** | Known pattern, low risk | Some unknowns | New integration or security impact |
| **File Estimate** | 1–3 files | 4–8 files | 9+ files |
| **Dependencies** | No new deps | 1–2 existing deps | New external dep or new service |

**Routing:**
- **Score 5–7** → **Simple** → invoke `superpowers:writing-plans` directly
- **Score 8–15** → **Medium/Complex** → invoke `superpowers:brainstorming` first

Always report the score breakdown before routing:

```
Complexity Score: 9/15 (Medium)
- Component Scope:       2 pts  (2–5 files, 2 layers)
- Requirements Clarity:  2 pts  (minor gaps in ticket)
- Technical Risk:        2 pts  (some unknowns)
- File Estimate:         2 pts  (4–8 files estimated)
- Dependencies:          1 pt   (uses existing deps only)

Routing → superpowers:brainstorming
```

---

## Phase 3: Planning

### Simple Path (Score 5–7)

Invoke `superpowers:writing-plans` directly, passing requirements summary, guide findings, and affected files as context.

After writing-plans produces a plan → invoke `spec-reviewer`:

```
Invoke Skill: spec-reviewer
Provide: plan file path, Jira ticket ID (if available)
```

After spec-reviewer **APPROVED** → proceed to Phase 4.

If spec-reviewer returns **NEEDS WORK** → address the issues and resubmit.

### Medium/Complex Path (Score 8–15)

Invoke `superpowers:brainstorming`, passing requirements summary, guide findings, complexity score, and open architectural questions.

After brainstorming produces design doc → invoke `superpowers:writing-plans`, passing the design doc.

After writing-plans produces a plan → invoke `spec-reviewer`:

```
Invoke Skill: spec-reviewer
Provide: plan file path, Jira ticket ID (if available)
```

After spec-reviewer **APPROVED** → proceed to Phase 4.

---

## Phase 4: Implementation

Invoke `superpowers:subagent-driven-development`, passing the plan file path, worktree path, and key architectural context from Phase 2.

After all implementation tasks complete and code review passes → proceed to Phase 5.

---

## Phase 5: Quality Gates

Invoke `qa-lead`, passing branch name, spec file path (if available), and Jira ticket ID (if available).

qa-lead orchestrates automated tests, UI tests (conditional), spec-refinement (if needed), and `/memory-refresh` reminder.

---

## Key Principles

### Do's
✅ Gather requirements fully before creating worktree
✅ Load `.codemie/guides/` before searching codebase
✅ Report complexity score breakdown before routing
✅ Follow score routing strictly — do not override without explicit user input
✅ Ask specific, blocking questions only (not generic ones)

### Don'ts
❌ Never create branches with raw git commands — `superpowers:using-git-worktrees` handles it
❌ Never call `solution-architect` — use `superpowers:brainstorming` for complex features
❌ Never start implementation before spec-reviewer APPROVED
❌ Never ask about information already in the code or guides
❌ Never implement on main/master (worktrees enforce this)

---

## Integration with Other Skills

### superpowers:using-git-worktrees
- Invoked between Phase 1 and Phase 2
- Creates isolated branch + worktree — all Phase 2+ work happens there
- Handles all branch creation, no manual `git checkout -b` needed

### superpowers:brainstorming
- Invoked for Medium/Complex features (score 8–15)
- Produces design doc that feeds into `superpowers:writing-plans`

### superpowers:writing-plans
- Invoked for Simple features (score 5–7) directly, or after brainstorming
- Produces the implementation plan reviewed by spec-reviewer

### spec-reviewer
- Validates plan/spec before implementation starts
- Must return APPROVED before `superpowers:subagent-driven-development` is invoked

### superpowers:subagent-driven-development
- Invoked after spec-reviewer APPROVED
- Dispatches fresh subagent per task, with two-stage review after each

### qa-lead
- Invoked after all implementation tasks and code review are complete
- Orchestrates all quality gates before the branch is merged

### brianna
- Fetches Jira ticket details (description + summary only)
- Used in Phase 1 when Jira ticket ID is provided

### codemie-commit / codemie-pr
- Used after qa-lead passes for commits and PR creation

---

## Example Workflows

### Example 1: Simple Feature (Jira Ticket)

```
User: "Implement EPMCDME-10500"

1. Fetches EPMCDME-10500 via brianna (description + summary)
2. Determines branch: EPMCDME-10500
3. Invokes superpowers:using-git-worktrees
4. Inside worktree: loads .codemie/guides/api/ and architecture guide
5. Scores complexity: 6/15 (Simple — 1 endpoint, standard CRUD, clear requirements)
6. Routes to superpowers:writing-plans
7. After plan produced → invokes spec-reviewer
8. spec-reviewer APPROVED → invokes superpowers:subagent-driven-development
9. After implementation + code review → invokes qa-lead
```

### Example 2: Complex Feature (Jira Ticket)

```
User: "Start work on EPMCDME-10700"

1. Fetches EPMCDME-10700 via brianna
2. Determines branch: EPMCDME-10700
3. Invokes superpowers:using-git-worktrees
4. Inside worktree: loads architecture + integration guides
5. Scores complexity: 12/15 (Complex — new external integration, 9+ files, security impact)
6. Routes to superpowers:brainstorming
7. brainstorming produces design doc → invokes superpowers:writing-plans
8. writing-plans produces plan → invokes spec-reviewer
9. spec-reviewer APPROVED → invokes superpowers:subagent-driven-development
10. After implementation + code review → invokes qa-lead
```

### Example 3: Free-Form Task (No Jira Ticket)

```
User: "Add structured logging to the agent executor"

1. Confirms requirements, documents acceptance criteria
2. Suggests branch: feature/add-agent-executor-logging (confirmed by user)
3. Invokes superpowers:using-git-worktrees
4. Inside worktree: loads development-practices guide
5. Scores complexity: 7/15 (Simple — known pattern, 2–3 files, clear requirements)
6. Routes to superpowers:writing-plans
7. After plan produced → invokes spec-reviewer
8. spec-reviewer APPROVED → invokes superpowers:subagent-driven-development
9. After implementation + code review → invokes qa-lead
```

---

## Additional Resources

For detailed complexity criteria and branch naming conventions:
- **`references/complexity-assessment-guide.md`** — detailed scoring examples
- **`references/branch-workflow.md`** — branch naming rules and examples
