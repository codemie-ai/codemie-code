# Project Context

## Project Identity

| Field | Value | Source |
|---|---|---|
| Project name | CodeMie Code | `README.md:1` |
| Repository/package | `@codemieai/code` (`codemie-ai/codemie-code`) | `package.json:name`, `git remote -v` origin |
| Project code/key | `epm-cdme` | `.codemie/codemie-cli.config.json:activeProfile` |

## Work Item Tracker

| Field | Value |
|---|---|
| Provider | Jira |
| Key/prefix | EPMCDME |

## Ticket Adapter

**Status**: configured
**Adapter**: Invoke the `codemie-jira-assistant` skill via the Skill tool.
**Lookup**: Invoke the `codemie-jira-assistant` skill with the ticket key and a request for summary, description, acceptance criteria, and links.
**Create**: Invoke the `codemie-jira-assistant` skill with the complete ticket payload or approved story file as the argument.
**Output**: Ticket key and URL returned by the skill.

## Source Control And Review

| Field | Value |
|---|---|
| Provider | GitHub |
| Repository remote | git@github.com:codemie-ai/codemie-code.git |
| Default target branch | main |
| Review artifact type | PR |

## MR Adapter

**Status**: configured
**Adapter**: `gh` CLI (authenticated; repo remote is GitHub).
**Instructions**: Check current branch state via `gh pr list --head $(git branch --show-current)` and avoid creating duplicate PRs. Follow Conventional Commits and the project Squash-and-Merge default. Create with `gh pr create --title "<type>(<scope>): <subject>" --body "<body>"` using the Body Template below.

## Lifecycle Intent Handling

### record_complexity_score
Invoke the `codemie-jira-assistant` skill and ask it to update the ticket's complexity score (Total Score) with the value from `data.complexity_total`.
Ticket ID: extract from the current branch name (pattern `EPMCDME-\d+`) or from the run work item.

### artifact_published
Invoke the `codemie-jira-assistant` skill and attach the artifact file using the `--file` flag:

```bash
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" \
  "Attach this file to Jira ticket EPMCDME-<ID> as the approved <kind> artifact." \
  --file "<path-to-artifact>"
```

Ticket ID: extract from the current branch name (pattern `EPMCDME-\d+`) or from the run work item.
`<path-to-artifact>`: use `data.artifact_path`, or the path to `spec.md` / `plan.md` in the run directory.
