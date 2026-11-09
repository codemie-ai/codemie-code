# Project Context

## Project Identity

| Field | Value | Source |
|---|---|---|
| Project name | CodeMie Code | README.md::CodeMie |
| Repository/package | @codemieai/code | package.json::name |
| Project code/key | epm-cdme | .codemie/codemie-cli.config.json::activeProfile |

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
**Comment**: Invoke the `codemie-jira-assistant` skill with a request to add a comment to the ticket, passing the comment body as the argument.
**Attach**: Invoke the `codemie-jira-assistant` skill with a request to attach the file at {{FILE_PATH}} to ticket {{ID}} under the name `sdlc-<kind>-<filename>`.
**Instructions**: Complexity: add the label `sdlc-factory-est-<SIZE>` for an initial score and `sdlc-factory-act-<SIZE>` for an actual one (XS–XXL as given); add only, never remove or change existing labels. Reading the Labels field returns no value (labels are additive). Ticket ID: from the branch name (`EPMCDME-\d+`) or the run work item. A published complexity-assessment artifact also adds `sdlc-factory-est-<size>` from its `size` key.

## Source Control And Review

| Field | Value |
|---|---|
| Provider | GitHub |
| Repository remote | https://github.com/codemie-ai/codemie-code.git |
| Default target branch | main |
| Review artifact type | PR |

## MR Adapter

**Status**: configured
**Adapter**: `gh` CLI (authenticated; repo remote is GitHub).
**Instructions**: Check the current branch with `gh pr list --head $(git branch --show-current)` and avoid duplicate PRs. Follow Conventional Commits; the PR title is commit-linted in CI and becomes the squash commit. Create with `gh pr create --title "<type>(<scope>): <subject>" --body "<body>"`, the body following `.github/PULL_REQUEST_TEMPLATE.md`.

## Complexity Scoring

**Status**: configured
**Field**: Labels
**Format**: t-shirt
