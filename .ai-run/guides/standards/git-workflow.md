# Git Workflow

## Quick Summary

Git workflow for CodeMie Code: branching, Conventional Commits, PRs, code review, Squash-and-Merge. Used by `codemie-pr` skill and SDLC Factory MR/PR adapters.

**Category**: Standards
**Complexity**: Simple
**Prerequisites**: Git basics, `gh` CLI

---

## Branching Strategy

| Branch Type | Pattern | Purpose | Example |
|---|---|---|---|
| Main | `main` | Production-ready code | `main` |
| Feature | `feat/<kebab-description>` | New features | `feat/add-gemini-support` |
| Fix | `fix/<kebab-description>` | Bug fixes | `fix/npm-install-error` |
| Refactor | `refactor/<kebab-description>` | Code refactoring | `refactor/utils-consolidation` |
| Chore | `chore/<kebab-description>` | Maintenance | `chore/update-deps` |
| CI | `ci/<kebab-description>` | CI/CD changes | `ci/add-windows-test-runner` |
| Docs | `docs/<kebab-description>` | Documentation | `docs/update-readme` |
| Ticket-scoped | `EPMCDME-<NNNN>[_kebab-description]` | Work tracked by Jira ticket | `EPMCDME-12128`, `EPMCDME-11112_codex-sync` |

**Project pattern**: `<type>/<kebab-case-description>` for type-scoped work; `EPMCDME-<NNNN>[_<kebab-description>]` when a Jira ticket drives the change. Mixed history is acceptable — see `git branch -a`.

**Why no ticket prefix on type branches**: not every change has a tracker item (releases, rebases, doc cleanup, experiments). Conventional Commits and PR descriptions carry the type context.

---

## Workflow

```bash
# 1. Branch from main
git checkout main && git pull origin main
git checkout -b feat/<kebab-description>     # or EPMCDME-<NNNN>

# 2. Work & commit (multiple commits OK before squash)
git add <files>
git commit -m "<type>(<scope>): <subject>"

# 3. Keep branch updated
git fetch origin && git rebase origin/main

# 4. Push & create PR
git push -u origin <branch>
gh pr create --title "<type>(<scope>): <subject>" --body "<body>"
```

The `codemie-pr` skill automates steps 3–4 and writes the PR body. Always invoke it via the Skill tool, never by hand-typing `gh`.

---

## Commit Message Format (Conventional Commits)

```
<type>(<scope>): <subject>

<optional body>

<optional footer>
```

| Constraint | Value | Source |
|---|---|---|
| `subject-max-length` | 100 chars | `commitlint.config.cjs:rules.subject-max-length` |
| `body-max-line-length` | 300 chars | `commitlint.config.cjs:rules.body-max-line-length` |
| `footer-max-line-length` | 300 chars | `commitlint.config.cjs:rules.footer-max-line-length` |
| `subject-case` | flexible (lowercase or sentence-case) | `commitlint.config.cjs` |
| `scope-empty` | optional | `commitlint.config.cjs` |

### Allowed types

`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `revert`. Enforced by `commitlint.config.cjs:type-enum`.

### Allowed scopes

`cli`, `agents`, `providers`, `assistants`, `config`, `proxy`, `workflows`, `ci`, `analytics`, `utils`, `deps`, `tests`, `skills`, `kimi`. Enforced by `commitlint.config.cjs:scope-enum`.

### Examples (real commits from `git log`)

| Type | Example |
|---|---|
| `feat` | `feat(agents): add Kimi SSO support via codemie-kimi (#368)` |
| `fix` | `fix(analytics): include sub-agent transcripts in token usage extraction (#358)` |
| `chore` | `chore: stop tracking .codegraph data files` |
| `refactor` | `refactor(kimi): harden automated verification script` |
| `revert` | `revert(agents): revert accidental merge of kimi branch into main (#359)` |

---

## Commit Rules

| ✅ DO | ❌ DON'T |
|---|---|
| Atomic commits, one logical change each | Mix unrelated changes in one commit |
| Imperative subject ("add X", "fix Y") | Past tense ("added X", "fixed Y") |
| Scope from the allowed list when applicable | Invent ad-hoc scopes (commitlint rejects them) |
| Reference the related issue/PR in the body | Skip context |
| Trust husky hooks to format and lint | Bypass with `--no-verify` |

---

## Pre-commit Hooks (husky)

| Hook | Command | Effect |
|---|---|---|
| `pre-commit` | `npx lint-staged` → `npm run typecheck` → `npm run validate:secrets` (only when Docker daemon is up) | Lint changed files, TypeScript check, optional gitleaks scan. See `.husky/pre-commit`. |
| `commit-msg` | `npx --no -- commitlint --edit "$1"` | Validates Conventional Commits format. See `.husky/commit-msg`. |

If `validate:secrets` skips because Docker is unavailable, the same scan runs in CI — do not bypass locally.

---

## Pull Requests

### Title

Use the same Conventional Commits format as the commit — `<type>(<scope>): <subject>`. After Squash-and-Merge, the PR title becomes the squash commit message.

### Body Template

```markdown
## Summary
<1–3 sentence description of the change and why>

## Changes
- <change 1>
- <change 2>

## Testing
- [ ] Tests added/updated
- [ ] Manual testing done

## Checklist
- [ ] Code follows project standards
- [ ] CI is green (`npm run ci`)
- [ ] No merge conflicts with `main`
```

The repository ships a template at `.github/PULL_REQUEST_TEMPLATE.md`.

### Code Review Checklist

- [ ] Logic is correct and matches the linked ticket / story.
- [ ] Architecture boundaries respected (`CLI → Registry → Plugin → Core → Utils`). See `.ai-run/guides/architecture/architecture.md`.
- [ ] No secrets, no `console.log`, no generic `Error` (see `.ai-run/guides/security/security-practices.md` and `.ai-run/guides/development/development-practices.md`).
- [ ] Tests adequate (`.ai-run/guides/testing/testing-patterns.md`).
- [ ] Lint clean (`npm run lint`) and types check (`npm run typecheck`).
- [ ] Public docs / READMEs updated when behavior changes.

---

## Merge Strategy

**Project standard**: Squash and Merge.

```bash
# Via GitHub UI: click "Squash and merge"
# Or via gh:
gh pr merge --squash --delete-branch
```

**Why Squash**: linear `main` history (every recent commit on `main` ends with `(#NNN)` — see `git log --oneline main`); easier `git revert` per PR; multiple WIP commits during the branch's life stay readable while in review.

---

## Common Commands

```bash
git status
git fetch origin && git rebase origin/main
git push -u origin <branch>
gh pr create
gh pr checks
gh pr view --web
git reset --soft HEAD~1     # undo last commit, keep changes
git rebase -i HEAD~3        # squash WIP commits before pushing
```

---

## Anti-Patterns

| Avoid | Why | Use Instead |
|---|---|---|
| `git push --force` to a shared branch | Rewrites history others depend on | `git push --force-with-lease` only on your branch |
| `git commit --no-verify` | Bypasses commitlint + husky checks | Fix the underlying lint/typecheck issue |
| Merge commits into `main` | Breaks the squash-only convention | Use `gh pr merge --squash` |
| Hand-written `gh pr create` for routine flows | Skips the project PR body template | Invoke the `codemie-pr` skill |
| Mixing two scopes in one commit | Rejected by `commitlint scope-enum` and hard to revert | Split into two commits |
| Ticket key in the commit subject when scope already conveys context | Adds noise; project history shows scope+subject is enough | Reference the ticket in the body footer instead |

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `commitlint` fails on subject length | Subject > 100 chars | Shorten subject; move detail to body |
| `commitlint` fails on type | Custom type | Use one of the allowed types listed above |
| `commitlint` fails on scope | Custom scope | Use one of the allowed scopes or drop the scope |
| `lint-staged` errors during commit | ESLint warnings remain | `npm run lint:fix` then re-stage |
| Secrets scan blocks commit | Real secret detected, or Gitleaks false positive | Remove the secret; for false positives, add to `.gitleaksignore` |
| Merge conflict on rebase | Branch diverged from main | `git fetch origin && git rebase origin/main`; resolve, `git rebase --continue` |
| Wrong branch for PR | PR targets a non-default branch | `gh pr edit --base main` |
