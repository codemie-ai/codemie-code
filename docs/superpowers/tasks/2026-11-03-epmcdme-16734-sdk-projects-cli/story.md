---
schema_version: 1
id: cli-projects-and-skill
parent: nodejs-sdk-project-parity
repository: codemie-code
depends_on: [sdk-project-admin-parity]
---
# `codemie sdk projects` CLI and codemie-sdk Skill Update — Story

**Date**: 2026-11-02
**Status**: Approved
**Ticket**: [EPMCDME-16734](https://jiraeu.epam.com/browse/EPMCDME-16734) (sub-task of EPMCDME-16732)
**Parent**: ../../story.md

---

## Context

- The `codemie sdk` CLI is built on the published Node.js SDK. It has command groups for assistants, categories, datasources, integrations, llm, skills, users and workflows, but none for projects.
- The codemie-sdk skill documents only `codemie sdk` commands. Its mandatory Project Clarification step relies on "users me", which cannot confirm that a named project exists.
- The skill's mandatory "Consult Examples" table has no projects row or example file.
- The Node.js SDK release from the sibling child (sdk-project-admin-parity) provides the project operations and the "project exists" check.

---

## Complexity

**Size**: M (19/36) · **Recommended flow**: sdlc-standard

This adds a new command group that follows the existing patterns, plus skill docs. Risk comes from bulk/CSV input, the change to the mandatory Project Clarification step, and the blocking dependency on the SDK release.

---

## Story

**As a** CodeMie admin or an agent using the codemie-sdk skill, **I want** a `codemie sdk projects` command and skill guidance that uses it **so that** I can check that a project exists, inspect it and manage its members from the CLI before creating or changing assets in it.

---

## Background

Admins and agents work through the CLI and the skill, not the SDK directly. Without a projects command, the new SDK capability does not reach them, and agents can target a project name that does not exist.

---

## Acceptance Criteria

- [ ] Given codemie-code depends on the Node.js SDK release from the sibling child, when it is built, then the projects operations are available to the CLI.
- [ ] Given a user, when they run `codemie sdk projects` for list, get (details), exists, members and the other management actions (create, update, delete, transfer ownership, assign/update/remove member, bulk assign/remove, CSV validate/import), then each command works in human-readable and `--json` modes, consistent with the existing command groups.
- [ ] Given an existing visible project, when the user runs `codemie sdk projects exists <name>`, then it reports that the project exists and exits with code 0.
- [ ] Given a missing or not visible project, when the user runs the exists command, then it reports "not found or not accessible" with a distinct non-zero exit code. When they run the details command, then it prints a clear "project not found or not accessible" message and exits with a non-zero code.
- [ ] Given an authentication or server failure, when any projects command runs, then the CLI shows the error the way existing groups do. It is not reported as "not found".
- [ ] Given an agent following the codemie-sdk skill, when it clarifies the target project, then the skill tells it to confirm the project exists with the new check before creating or changing assets.
- [ ] Given the skill's asset list and Consult Examples table, when an agent works with projects, then projects are listed and a new projects example file shows the commands.

---

## Out of Scope

- SDK changes and the parity guide. Those belong to the codemie-sdk child.
- CLI commands for other services that exist only in Python.

---

## Decisions

- D4 and D6 from the parent story apply.
- D8: The exists command uses a distinct non-zero exit code for "not found or not accessible", so scripts can tell it apart from errors. — proposed by PO: makes the check usable in shell scripts and agent steps

---

## Open Questions

- None
