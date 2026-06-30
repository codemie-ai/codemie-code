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
**Adapter**: Invoke the `codemie-pr` skill via the Skill tool.
**Instructions**: The `codemie-pr` skill checks current branch state via `gh pr list --head $(git branch --show-current)` and avoids creating duplicate PRs; it follows Conventional Commits and the project Squash-and-Merge default. Pass the user's intent ("commit changes", "push", "create PR") verbatim as the skill argument.
