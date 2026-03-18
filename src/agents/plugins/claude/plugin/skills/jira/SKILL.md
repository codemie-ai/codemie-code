---
name: jira
description: >
  Interact with Jira — read issue details, descriptions, acceptance criteria, subtasks,
  comments, and linked issues; create and edit issues; transition issue status; add comments;
  assign issues; list boards, sprints, epics, and projects. Use this skill
  whenever the user mentions a Jira ticket key (e.g., PROJ-123), asks to "read the ticket",
  "check the Jira issue", "implement this Jira story", "update the ticket status",
  "add a comment to Jira", "move the ticket to In Review",
  "list my sprint issues", "what are the acceptance criteria", "what are the subtasks",
  "assign the ticket to me", or any task that requires reading or writing to a Jira project.
  Invoke proactively whenever the user provides a Jira issue key or URL and asks Claude to
  implement, review, or track something.
allowed-tools: [Bash, Read, Write, Glob]
version: 1.0.0
tags: [jira, sdlc, project-management, issue-tracking, agile]
---

# Jira Skill

Interact with Jira issues, boards, sprints, and epics via the `jira-cli` binary. Use this
skill to read tickets before implementing features, update ticket status after work is done,
and add comments with progress updates.

---

## Pre-flight Check

**Always run this first before any Jira operation:**

```bash
command -v jira >/dev/null 2>&1 && echo "INSTALLED" || echo "NOT_INSTALLED"
```

**If `NOT_INSTALLED`**, stop immediately and tell the user:

> "`jira-cli` is not installed. Install it with:
>
> **macOS**: `brew install ankitpokhrel/jira-cli/jira-cli`
>
> **Linux**: Download the binary from https://github.com/ankitpokhrel/jira-cli/releases,
> then run `chmod +x jira && sudo mv jira /usr/local/bin/jira`
>
> After installing, run `jira init` to configure your Jira instance and credentials."

**If installed**, verify the connection:

```bash
jira me 2>&1
```

**If this returns an error** (e.g., "configuration not found", "unauthorized", "connection refused"):

> "Jira CLI is installed but not configured or not authenticated. Run `jira init` to set up
> your Jira instance URL and API token. For Atlassian Cloud, generate a token at:
> https://id.atlassian.com/manage-profile/security/api-tokens
>
> Also export your token: `export JIRA_API_TOKEN=\"your-token\"`"

Do not proceed past this check until `jira me` succeeds.

---

## Reading Issues

### View a specific issue

```bash
# Full issue view (summary, description, status, assignee, reporter, labels, subtasks)
jira issue view PROJ-123 --plain

# Include recent comments (show last 20 comments)
jira issue view PROJ-123 --comments 20 --plain

# Machine-readable JSON (for programmatic processing)
jira issue view PROJ-123 --raw
```

The `--plain` output includes: key, summary, type, priority, status, reporter, assignee,
labels, components, fix version, description (full text), subtasks, and issue links.

### Understanding output fields

When reading a ticket for implementation:
- **Summary**: The feature/bug title
- **Description**: Detailed requirements; often contains acceptance criteria
- **Subtasks**: Child issues; implement each subtask separately
- **Labels/Components**: Team or area ownership
- **Status**: Current workflow state (e.g., "In Progress", "In Review", "Done")
- **Linked Issues**: Blockers, related tickets, dependencies

### List issues

```bash
# List all issues in a project
jira issue list -p PROJ --plain

# Issues assigned to me
jira issue list --assignee me --plain

# Issues by status
jira issue list -p PROJ -s "In Progress" --plain

# Issues in current sprint
jira issue list -q "project = PROJ AND sprint in openSprints()" --plain

# My open tickets in current sprint
jira issue list -q "project = PROJ AND sprint in openSprints() AND assignee = currentUser()" --plain

# Search by text (JQL)
jira issue list -q "project = PROJ AND text ~ \"authentication\"" --plain

# Recently viewed issues
jira issue list --history --plain

# JSON output for processing
jira issue list -p PROJ -s "To Do" --raw
```

### Common JQL patterns

```bash
# Unresolved issues in current sprint
jira issue list -q "sprint in openSprints() AND resolution = Unresolved" --plain

# Issues updated in last 7 days
jira issue list -p PROJ --updated -7d --plain

# Blocked issues
jira issue list -q "project = PROJ AND issueFunction in issuesWithLinks(\"is blocked by\")" --plain

# High priority bugs
jira issue list -p PROJ -t Bug -y High --plain
```

---

## Writing to Issues

### Add a comment

```bash
jira issue comment add PROJ-123 --comment "Your comment text here" --no-input
```

For multi-line comments, use a heredoc approach:
```bash
jira issue comment add PROJ-123 \
  --comment "Implementation complete.

Changes made:
- Added authentication middleware
- Updated user service
- All tests passing

PR: https://github.com/org/repo/pull/42" \
  --no-input
```

### Transition issue status (move)

```bash
# Move to a specific status — status name must match Jira workflow exactly
jira issue move PROJ-123 "In Progress" --no-input
jira issue move PROJ-123 "In Review" --no-input
jira issue move PROJ-123 "Done" --no-input

# Move with a comment (combines transition + comment in one step)
jira issue move PROJ-123 "In Review" \
  --comment "Implementation complete, PR submitted for review" \
  --no-input
```

**Finding available transitions for an issue:**
```bash
# The move command without a status argument shows available transitions interactively.
# To list them non-interactively, check the issue view:
jira issue view PROJ-123 --plain
# The current status is shown; valid next statuses depend on the project's workflow.
```

### Assign an issue

```bash
# Get current user's email
jira me

# Assign to yourself (extract AccountID from jira me output)
jira issue assign PROJ-123 $(jira me | awk '{print $NF}')

# Assign to a specific user (use their Jira username or account ID)
jira issue assign PROJ-123 "john.doe"

# Unassign
jira issue assign PROJ-123 x
```

### Edit issue fields

```bash
# Update summary
jira issue edit PROJ-123 -s "Updated summary" --no-input

# Update description
jira issue edit PROJ-123 -b "Updated description text" --no-input

# Add a label
jira issue edit PROJ-123 -l "backend" --no-input

# Remove a label (prefix with minus)
jira issue edit PROJ-123 -l "-backend" --no-input

# Change priority
jira issue edit PROJ-123 -y High --no-input
```

### Log work (worklog)

```bash
# Log 2 hours of work
jira issue worklog add PROJ-123 "2h" --no-input

# Log 30 minutes
jira issue worklog add PROJ-123 "30m" --no-input

# Log 1 day and 3 hours
jira issue worklog add PROJ-123 "1d 3h" --no-input
```

### Link issues

```bash
# Link two issues with a relationship type
jira issue link PROJ-123 PROJ-456 "blocks"
jira issue link PROJ-123 PROJ-456 "is blocked by"
jira issue link PROJ-123 PROJ-456 "relates to"
jira issue link PROJ-123 PROJ-456 "duplicates"

# Add a remote web link (e.g., link to a PR)
jira issue link remote PROJ-123 "https://github.com/org/repo/pull/42" "PR #42: Feature implementation"
```

---

## Creating Issues

```bash
# Create a task non-interactively
jira issue create -p PROJ -t Task -s "Implement user authentication" \
  -b "Implement JWT-based authentication for the API" \
  --no-input

# Create a bug
jira issue create -p PROJ -t Bug -s "Login fails with special characters" \
  -b "Steps to reproduce..." -y High --no-input

# Create a story under an epic
jira issue create -p PROJ -t Story -s "User can reset password" \
  -b "As a user, I want to reset my password via email" \
  -P PROJ-10 --no-input

# Create with label and component
jira issue create -p PROJ -t Task -s "Add rate limiting" \
  -l "backend" -C "API" --no-input
```

---

## Boards, Sprints, Epics, Projects

```bash
# List all boards
jira board list --plain

# List sprints (on a board)
jira sprint list --plain

# Current sprint issues (active sprint)
jira sprint active --plain

# List epics in a project
jira epic list -p PROJ --plain

# View an epic
jira epic view PROJ-10 --plain

# List all accessible projects
jira project list --plain

# Current user profile
jira me
```

---

## AI SDLC Workflow Patterns

### Pattern 1: Read ticket and implement a feature

**Trigger phrases**: "implement PROJ-123", "work on ticket PROJ-123", "do PROJ-123", "start on PROJ-123"

1. **Pre-flight check** — verify `jira` is installed and configured
2. **Read the ticket**:
   ```bash
   jira issue view PROJ-123 --comments 10 --plain
   ```
3. **Parse the output** — extract:
   - Summary (feature title)
   - Description (requirements and acceptance criteria)
   - Subtasks (if any — implement each)
   - Status (confirm it's not already "Done")
   - Linked issues (check for blockers)
4. **Move to In Progress**:
   ```bash
   jira issue move PROJ-123 "In Progress" --no-input
   ```
5. **Assign to self** (if unassigned):
   ```bash
   jira issue assign PROJ-123 $(jira me | awk '{print $NF}')
   ```
6. **Implement** — write code based on the ticket description
7. **After implementation** — update the ticket (see Pattern 2)

### Pattern 2: Update ticket after implementation

**Use after Pattern 1 or when the user says**: "update the ticket", "mark PROJ-123 done", "add a comment to PROJ-123"

1. **Add implementation summary comment**:
   ```bash
   jira issue comment add PROJ-123 \
     --comment "Implementation complete.

   Summary of changes:
   - [list key changes]

   PR: [link to pull request]
   Tests: [passing/failing]" \
     --no-input
   ```
2. **Transition to the next status** (typically "In Review" after submitting a PR):
   ```bash
   jira issue move PROJ-123 "In Review" --no-input
   ```
3. **Link to the PR** (optional but recommended):
   ```bash
   jira issue link remote PROJ-123 "https://github.com/org/repo/pull/42" "PR #42"
   ```

### Pattern 3: Sprint planning — list and prioritize work

**Trigger phrases**: "what's in my sprint", "show my sprint issues", "what should I work on next"

1. **Check active sprint**:
   ```bash
   jira sprint active --plain
   ```
2. **List my assigned issues**:
   ```bash
   jira issue list -q "sprint in openSprints() AND assignee = currentUser() AND resolution = Unresolved" --plain
   ```
3. **Sort by priority** and present a prioritized work list to the user

### Pattern 4: Bug investigation workflow

**Trigger phrases**: "investigate PROJ-123", "reproduce the bug in PROJ-123"

1. **Read the ticket** with all comments:
   ```bash
   jira issue view PROJ-123 --comments 50 --plain
   ```
2. **Check linked issues** for related bugs or duplicates
3. **After investigation — add findings as a comment**:
   ```bash
   jira issue comment add PROJ-123 \
     --comment "Root cause analysis:

   Cause: [description]
   Affected files: [list]
   Fix approach: [description]" \
     --no-input
   ```
4. **Update priority or labels** if investigation changes the severity:
   ```bash
   jira issue edit PROJ-123 -y Critical --no-input
   ```

### Pattern 5: Tech-lead / dark-factory SDLC automation

For agents running automated SDLC pipelines (tech-lead, dark-factory):

**Full automation loop:**
```bash
# Step 1: Read ticket
jira issue view PROJ-123 --plain

# Step 2: Move to In Progress
jira issue move PROJ-123 "In Progress" --no-input

# Step 3: [Implement feature — code changes happen here]

# Step 4: Run tests, capture result
npm test 2>&1 | tail -20 > /tmp/test-results.txt

# Step 5: Comment with results
jira issue comment add PROJ-123 \
  --comment "Automated implementation complete by CodeMie AI.

Implementation: [summary]
Tests: $(cat /tmp/test-results.txt | tail -5)" \
  --no-input

# Step 6: Move to In Review
jira issue move PROJ-123 "In Review" \
  --comment "PR ready for review" \
  --no-input
```

---

## Output Format Strategy

| Situation | Flag to use | Why |
|-----------|-------------|-----|
| Reading ticket content for Claude to process | `--plain` | Readable text, includes all fields |
| Need structured data (ID, key, status field) | `--raw` | JSON, parseable with grep/jq |
| Listing issues for user to review | `--plain` | Tabular text is user-friendly |
| Scripting / automation | `--raw` | Machine-parseable |

**Prefer `--plain` for reading** — it renders the full description and comments as text that Claude can understand directly. Use `--raw` when you need to extract a specific field programmatically.

---

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `command not found: jira` | jira-cli not installed | Install via brew or binary download |
| `configuration not found` | `jira init` not run | Run `jira init` |
| `401 Unauthorized` | Invalid or expired API token | Regenerate token at Atlassian profile, re-export `JIRA_API_TOKEN` |
| `403 Forbidden` | Insufficient permissions | Contact Jira admin; user lacks permission on the project |
| `404 Not Found` | Issue key does not exist or wrong project | Verify the issue key; check the project prefix |
| `transition not available` | Status transition not allowed by workflow | Check project workflow; use `jira issue view` to see current status, then pick a valid next state |
| `jira me` fails after install | Config file missing or corrupt | Re-run `jira init` |

**For 401/403 errors**, tell the user:
> "Jira returned an authentication error. Try regenerating your API token at
> https://id.atlassian.com/manage-profile/security/api-tokens and re-running:
> `export JIRA_API_TOKEN=\"your-new-token\"`"

**For transition errors**, tell the user:
> "The status transition '[target]' is not available from the current status '[current]'.
> Available transitions depend on the project's workflow configuration. Check with your
> Jira admin or try a different target status."

---

## Prerequisites Summary

| Requirement | How to install/configure |
|-------------|--------------------------|
| `jira-cli` binary | `brew install ankitpokhrel/jira-cli/jira-cli` (macOS) or binary download |
| Initial config | `jira init` (one-time per Jira instance) |
| API token (Cloud) | https://id.atlassian.com/manage-profile/security/api-tokens |
| API token (on-premise PAT) | Set in Jira user profile; export `JIRA_AUTH_TYPE=bearer` |
| jq (optional) | `brew install jq` — useful for parsing `--raw` JSON output |

---

## Dependencies

The `jira` binary is the only dependency. It is a self-contained Go binary with no runtime
dependencies. Node.js, Python, and npm are not required for this skill.

`jq` is optional but useful when parsing `--raw` JSON output. Its absence is gracefully
handled by using `grep` and `cut` as fallbacks in the commands above.