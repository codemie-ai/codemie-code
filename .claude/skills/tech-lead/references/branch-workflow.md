# Git Branch Workflow

## Purpose

This guide defines the branch and PR workflow for the CodeMie Code TypeScript CLI repository.

## Branch Naming

Use a descriptive branch name:

```bash
feat/add-provider-command
fix/sso-config-validation
docs/update-skills-guide
```

For Jira-backed work, include the ticket when it helps traceability:

```bash
feat/EPMCDME-12345-provider-command
fix/EPMCDME-12345-sso-validation
```

## Branch Setup

Start from the latest `main` unless the user explicitly asks otherwise:

```bash
git fetch origin
git checkout main
git pull origin main
git checkout -b <type>/<description>
git push -u origin <type>/<description>
```

If the working tree is dirty, stop and ask the user whether to commit, stash, or keep the current branch as-is.

## Commit Format

Use conventional commits:

```bash
git commit -m "feat(agents): add provider setup flow"
git commit -m "fix(cli): validate profile arguments"
git commit -m "docs(skills): update product-owner workflow"
```

Common scopes: `cli`, `agents`, `providers`, `config`, `workflows`, `utils`, `skills`, `deps`.

## Validation

Follow repository policy: only run tests when the user explicitly asks. Common checks:

```bash
npm run license-check
npm run lint
npm run typecheck
npm run build
npm run validate:secrets
```

If tests are requested:

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:coverage
```

## Pull Request

Use the `codemie-pr` skill for commit, push, and GitHub PR creation. It reads `.github/PULL_REQUEST_TEMPLATE.md` and avoids duplicate PRs for the current branch.

## Cleanup

After merge:

```bash
git checkout main
git pull origin main
git branch -d <branch-name>
git fetch --prune
```
