---
allowed-tools: Bash(git push:*), Bash(gh pr create:*)
description: Push changes and create PR using GitHub template
---

## Context

- Current branch: !`git branch --show-current`
- Recent commits on this branch: !`git log origin/main..HEAD --oneline`
- PR template: !`cat .github/PULL_REQUEST_TEMPLATE.md`

## Your task

Based on the above changes:

1. Push the current branch to origin (use the same branch name)
2. Create a pull request using `gh pr create` following the PR template format from `.github/PULL_REQUEST_TEMPLATE.md`

When creating the PR:
- Generate a clear, concise title based on the changes
- Use `--body` with content that follows the PR template structure
- Fill in the Summary section with a brief overview based on the recent commits
- Include the Checklist section with "Self-reviewed" marked as checked

3. You have the capability to call multiple tools in a single response. You MUST do all of the above in a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.
