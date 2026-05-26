# AGENTS.md

Entrypoint for CodeMie CLI.

Use the generated AI Run guides as the source of truth for repo workflow,
architecture, quality gates, and implementation patterns.

## Required Guides

@.ai-run/guides/project.md
@.ai-run/guides/architecture/architecture.md
@.ai-run/guides/development/development-practices.md
@.ai-run/guides/standards/code-quality.md
@.ai-run/guides/standards/git-workflow.md
@.ai-run/guides/quality-gates.md

## Task-Specific Guides

Load these only when relevant:

- API and CLI behavior: `.ai-run/guides/api/cli-and-http-api.md`
- Session data and migrations: `.ai-run/guides/data/session-storage-and-migrations.md`
- Testing patterns: `.ai-run/guides/testing/testing-patterns.md`
- External integrations: `.ai-run/guides/integration/external-integrations.md`
- Workflows: `.ai-run/guides/workflows/workflow-patterns.md`
- Security: `.ai-run/guides/security/security-practices.md`
