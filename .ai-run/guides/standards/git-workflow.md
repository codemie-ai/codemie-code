# Git Workflow

**Project**: @codemieai/code · **Stack**: TypeScript (ESM, target ES2022, module NodeNext) commander CLI · **Scope**: branch names, commit subjects, merge policy and their recovery steps; exact gate commands live in `.ai-run/guides/quality-gates.md`, the MR adapter in `.ai-run/guides/project.md`

## Branch Naming Convention

- base branch: main
- pattern: `<type>/<kebab-description>` or `EPMCDME-<NNNNN>[_<kebab-description>]`

### Rules
- R1. Branch Naming: base branch main (origin/HEAD); observed patterns `<type>/<kebab-description>` and `EPMCDME-<NNNNN>[_<kebab-description>]`; no hook or CI job checks branch names.

## Commit Message Format

### Rules
- R1. Commit Message Format: `<type>(<scope>): <subject>`, types and scopes from commitlint.config.cjs (type-enum, scope-enum), scope optional, subject at most 100 chars, body/footer lines at most 300; enforced locally by .husky/commit-msg (`commitlint --edit`). Several scopes may be comma- or slash-separated.
- R2. Commit Message Format: an optional `(EPMCDME-NNNNN)` ticket suffix is allowed in the subject (recorded user decision).
- R3. CI checks the PR title (pr-title-lint.yml, reusable commit-lint workflow, PRs to main), not each commit; ci.yml runs no commitlint.

## Merge Strategy

### Rules
- R1. Merge Strategy: merge into main by squash and merge (recorded user decision).
- R2. Use `.github/PULL_REQUEST_TEMPLATE.md` (Summary / Changes / Impact / Checklist) as the PR body template (recorded user decision).

## Anti-Patterns

- Anti-Patterns: keep one logical change per commit (convention only; commitlint scope-enum accepts several scopes).
- Anti-Patterns: the pre-commit secrets scan (`npm run validate:secrets`) scans only the staged diff with gitleaks through docker, podman or Apple container; with no container engine it fails unless `CODEMIE_SKIP_SECRETS_SCAN=1`; CI runs its own reusable secrets workflow.
- Anti-Patterns: do not bypass hooks with `git commit --no-verify`; fix the lint/typecheck/secret finding instead (editorial convention; nothing blocks it).

## Troubleshooting

| Issue | Fix |
|---|---|
| Branch was cut from the wrong base | `git rebase --onto main <old-base> <branch>`, then `git push --force-with-lease` |
| Rebase conflicts on `main` | resolve file by file, `git add`, `git rebase --continue`; `git rebase --abort` to restart; never resolve by taking one side wholesale |
