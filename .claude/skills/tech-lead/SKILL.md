---
name: tech-lead
description: Use when starting implementation of a Jira ticket, feature, or task. Kicks off the SDLC with requirements gathering, branch setup, and complexity assessment — then routes to brainstorming or direct implementation. Triggers on: "implement EPMCDME ticket", "start working on EPMCDME-XXXXX", "begin implementation", "implement new task", "implement feature", "act as tech lead", "plan implementation", "analyze task". Each phase pauses for user confirmation before proceeding.
version: 1.0.0
---

# Tech Lead: SDLC Kickoff

## Purpose

Entry point for all development work. Gathers requirements, sets up the branch, and assesses complexity to route you to the right next step — either design (brainstorming) or direct implementation.

This skill does three things and nothing else. It does not load guides, explore the codebase, run tests, create PRs, or perform code review. Those steps belong to downstream skills in the chain.

---

## Phase 1: Requirements

### If a Jira ticket ID is provided (EPMCDME-XXXXX format)

Fetch it via brianna — description and summary fields only:

```
Invoke Skill: brianna
Args: "Get ticket details for EPMCDME-XXXXX. I need only the description and summary fields."
```

Do not request status, assignee, or other fields.

### If a task description is provided instead

Confirm your understanding of the requirements. If anything is vague or ambiguous, ask clarifying questions before proceeding. Document requirements in this format:

```markdown
## Task Requirements

**Goal**: [what needs to be implemented]

**Acceptance Criteria**:
- [criterion 1]
- [criterion 2]

**Context**: [any constraints or dependencies]
```

---

## Phase 2: Branch Setup

### Step 1: Check for local changes

```bash
git status --short
```

If the output is non-empty, **stop here** and tell the user:
> "There are uncommitted local changes. Please stash or commit them before I sync to main."

Only continue once the working tree is clean.

### Step 2: Check current branch state

Fetch latest from remote and check whether the current branch has commits not yet in main:

```bash
git fetch origin
git branch --show-current
git log origin/main..HEAD --oneline
```

If commits exist ahead of `origin/main` → **stop and ask the user before doing anything destructive**:
> "The current branch `<branch-name>` has [N] commit(s) not yet in main — resetting will permanently lose them.
> (a) Reset to main anyway
> (b) Keep this branch as-is (I'll create the target branch from main and continue)"

Wait for the user's answer:
- **(a) Reset** → continue to Step 3.
- **(b) Keep** → skip Step 3, go directly to Step 4. When creating the target branch, use `origin/main` as the base instead of the current HEAD:
  ```bash
  git checkout -b <branch-name> origin/main
  git push -u origin <branch-name>
  ```
  Then continue to Phase 3 as normal.

If there are **no commits ahead of main** → continue directly to Step 3 (safe to reset without prompting).

### Step 3: Sync to latest main

```bash
git reset --hard origin/main
```

### Step 4: Determine and set up target branch

- **Jira ticket**: branch name = `EPMCDME-XXXXX` (exact ticket ID, no prefix)
- **No Jira ticket**: suggest `task/kebab-case-description` and ask the user to confirm before proceeding

If arriving here via the **(b) Keep** path from Step 2, skip the checks below — the branch was already created from `origin/main` and you are already on it. Continue to Phase 3.

Otherwise, check if the target branch already exists:

```bash
git branch --list <branch-name>
```

- **Branch does not exist** → create it:
  ```bash
  git checkout -b <branch-name>
  git push -u origin <branch-name>
  ```
- **Branch already exists and we are not on it** → check it out:
  ```bash
  git checkout <branch-name>
  ```
- **Already on the target branch** → nothing to do; continue to Phase 3.

---

## Phase 3: Complexity Assessment and Routing

Dispatch the `complexity-assessor` agent:

```
Use the Agent tool:
  description: "Complexity assessment for [feature area]"
  subagent_type: "complexity-assessor"
  prompt: |
    task_description: "[full task description from Phase 1]"
    feature_area: "[keywords — e.g. 'budget service LLM', 'datasource indexer', 'agent tool']"
    branch: "[current branch name]"
```

Present the full assessment block returned by the agent.

### Routing

Based on the total score:

- **Score ≥ 15** → tell the user:
  > "Next step: run `/brainstorming` to design the solution before implementation."

- **Score < 15** → tell the user:
  > "Next step: run `/subagent-driven-development` to implement directly."

- **SPLIT REQUIRED (score 27+)** → tell the user:
  > "This task is too large to implement as a single story. Please decompose it into smaller stories using the splitting strategies above, then come back with the first story."

Do not invoke brainstorming or subagent-driven-development automatically. The user triggers the next step manually.

---

## Fast-Track / Skip Requests

If the user says "skip [phase]" or asks to bypass a step:

1. Confirm the skip: > "Skipping [phase name]. Continuing from [next phase]."
2. Note what was bypassed so the context is clear.
3. Proceed from the requested phase.

Skipping is the user's prerogative — acknowledge and adapt.

---

## Error Handling

### Ticket not found

```
Unable to fetch Jira ticket [ID]. Verify the ticket ID format (EPMCDME-XXXXX) and your access.
```

### complexity-assessor fails

Check whether `.claude/references/complexity-assessment/` exists:

- **Exists** → use the 6-dimension scoring criteria to produce a manual estimate:
  > "Complexity assessor failed. Manual estimate: [X]/36 — [Size]. Routing: [brainstorming | direct implementation]. Confirm to proceed."

- **Does not exist** → ask the user:
  > "Complexity assessor failed and the fallback guide is not present. Please give me a rough size estimate (XS/S/M/L/XL/XXL) so I can route correctly."
