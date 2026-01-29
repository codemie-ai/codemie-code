---
allowed-tools: Bash(git add:*), Bash(git commit:*), Bash(git checkout:*)
description: Create a git commit (not on main branch)
---

## Context

- Current branch: !`git branch --show-current`
- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Recent commits: !`git log --oneline -5`

## Your task

Based on the above changes, create a single git commit.

**IMPORTANT**: If the current branch is `main` or `master`:
1. Analyze the changes to determine the type (feat, fix, refactor, etc.)
2. Suggest a branch name in format `<type>/<short-description>` (e.g., `feat/add-auth-header-support`, `fix/proxy-timeout-issue`)
3. Ask user to confirm the branch name or provide an alternative
4. After confirmation, create the branch with `git checkout -b <branch-name>` and proceed with the commit

If on a feature branch:
1. Stage all relevant changes
2. Create a commit message following commitlint rules:
   - Format: `<type>(<scope>): <subject>` or `<type>: <subject>`
   - Types: feat, fix, docs, style, refactor, perf, test, chore, ci, revert
   - Scopes (optional): cli, agents, providers, config, proxy, workflows, ci, analytics, utils, deps, tests
   - Subject: max 100 characters, lowercase start, no period at end

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.
