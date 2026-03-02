---
# ✅ GOOD COMMAND EXAMPLE
# Score: ~19/20 pts (Grade A)
#
# ✅ C1.1: Valid frontmatter with name + description
# ✅ C1.2: argument-hint matches $ARGUMENTS usage
# ✅ C1.3: Phase-based numbered workflow
# ✅ C1.4: Usage examples section present
# ✅ C2.1: Error handling table with failure cases
# ✅ C2.2: Output format defined
# ✅ C2.3: Validation gates (confirm before creating)
# ✅ C2.4: Argument parsing with defaults shown
#
# ⚠️ Minor gap: C2.4 — could show more complex argument validation
name: create-jira-ticket
description: Create a structured Jira ticket from code context, error analysis, or user description
argument-hint: "<type> <title> [--priority high|medium|low]"
---

# Create Jira Ticket

Creates a well-structured Jira ticket in the EPM-CDME project based on code
context, error analysis, or user description. Follows project template with
acceptance criteria and technical notes.

## Arguments

| Argument | Values | Default | Description |
|----------|--------|---------|-------------|
| `<type>` | `bug`, `story`, `task`, `epic` | required | Ticket type |
| `<title>` | string | required | Brief ticket title |
| `--priority` | `high`, `medium`, `low` | `medium` | Priority level |

## Usage

```bash
/create-jira-ticket bug "Login fails on mobile Safari"
/create-jira-ticket story "Add dark mode toggle" --priority high
/create-jira-ticket task "Update API documentation"
/create-jira-ticket epic "Authentication system refactor"
```

---

## Phase 1: Parse and Validate Arguments

Parse `$ARGUMENTS`:

1. Extract `<type>` — first token. If missing or invalid:
   ```
   Valid types: bug, story, task, epic
   What type of ticket? [bug/story/task/epic]
   ```

2. Extract `<title>` — remaining text before flags. If missing:
   ```
   What should the ticket title be?
   ```

3. Extract `--priority` flag. Default: `medium`

4. Validate:
   - [ ] Type is one of: bug, story, task, epic
   - [ ] Title is not empty
   - [ ] Title length ≤ 255 characters (Jira limit)

**Abort if**: `JIRA_TOKEN` env var is not set — print:
```
Error: JIRA_TOKEN environment variable is required.
Set it with: export JIRA_TOKEN=your-token
```

---

## Phase 2: Gather Context

Collect relevant context based on type:

**For `bug`**:
- Run `git log --oneline -5` to show recent changes
- Read any error output or stack traces mentioned by user
- Identify affected file(s) if mentioned

**For `story`**:
- Read related files to understand current implementation
- Note what's missing vs what's needed

**For `task`** or **`epic`**:
- Review scope from user description
- Check for related existing tickets if mentioned

---

## Phase 3: Generate Ticket Description

Use the EPM-CDME template:

```markdown
## Problem Statement
[Concrete, observable description of the bug or need.
For bugs: what happens vs what should happen.
For stories: what capability is missing.]

## Acceptance Criteria
- [ ] Criterion 1 (testable, pass/fail)
- [ ] Criterion 2
- [ ] Criterion 3 (minimum 3 criteria)

## Technical Notes
[Implementation hints, related files, potential approach, dependencies]

## Priority Justification
[Why this priority level: high = user-blocking, medium = important, low = nice-to-have]
```

Checklist before proceeding:
- [ ] Problem is concrete and observable (not vague)
- [ ] Acceptance criteria are testable (binary pass/fail)
- [ ] Technical notes reference actual files or components
- [ ] Priority matches user impact

---

## Phase 4: Confirm Before Creating

Show the draft ticket for user approval:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Creating Jira Ticket:
  Project: EPM-CDME
  Type: [Bug | Story | Task | Epic]
  Title: [title]
  Priority: [High | Medium | Low]

Description preview:
  [first 200 chars of description...]

Create ticket? [y/n/edit]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

- If `n`: Print "Cancelled." Exit cleanly.
- If `edit`: Re-prompt for which field to change.
- If `y`: Proceed to Phase 5.

---

## Phase 5: Create and Report

1. POST to Jira API using `JIRA_TOKEN`
2. On success:
   ```
   ✓ Created: EPM-CDME-1234
     https://jira.example.com/browse/EPM-CDME-1234
   ```
3. On failure: see Error Handling

---

## Error Handling

| Error | Action |
|-------|--------|
| `JIRA_TOKEN` not set | Print setup instructions. Exit without saving draft. |
| API 401 Unauthorized | "Invalid token. Check JIRA_TOKEN value." |
| API 403 Forbidden | "No permission for EPM-CDME project. Contact admin." |
| API 429 Rate Limited | Wait 30s, retry once. If fails again: save draft. |
| Network unreachable | Save draft to `./jira-ticket-draft.md`, print path. |
| Title >255 chars | Truncate to 252 chars, append "...", warn user. |
