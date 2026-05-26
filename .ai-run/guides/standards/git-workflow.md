# Git Workflow

## Branch Naming Convention

**Pattern**: `<type>/<kebab-case-description>`

| Branch Type | Purpose | Example |
|---|---|---|
| `feat/...` | New features | `feat/add-codex-plugin` |
| `fix/...` | Bug fixes | `fix/proxy-routing` |
| `refactor/...` | Internal restructuring | `refactor/session-syncer` |
| `docs/...` | Documentation changes | `docs/update-guides` |
| `chore/...` | Maintenance | `chore/update-deps` |

Use GitHub Issues for work tracking. Reference issues in PR descriptions or commit bodies with `#123` when useful; there is no required work-item key prefix.

### Branch Practice

| Rule | Why |
|---|---|
| Start from `main` | CI and release workflow target `main` |
| Keep branch names lowercase and kebab-case | Keeps branch names shell-friendly and readable |
| Use the change type as the first path segment | Makes branch purpose visible before reading the PR |
| Prefer short descriptions | Long branch names become hard to scan in GitHub |
| Use GitHub issue references in PR text | The project has no ticket key prefix |

### Branch Examples

| Scenario | Branch |
|---|---|
| Add a new command | `feat/add-profile-login-command` |
| Fix SSO proxy routing | `fix/sso-proxy-routing` |
| Update GitHub workflow | `ci/update-pr-title-check` |
| Improve skill installer docs | `docs/skill-installer-usage` |
| Refactor session storage | `refactor/session-store` |

## Commit Message Format

**Format**: `type(scope): subject`

Scope is optional. The repository uses Conventional Commits through commitlint.

Allowed types:

| Type | Use For |
|---|---|
| `feat` | New features |
| `fix` | Bug fixes |
| `docs` | Documentation changes |
| `style` | Formatting or whitespace-only changes |
| `refactor` | Internal restructuring without behavior change |
| `perf` | Performance improvements |
| `test` | Test additions or changes |
| `chore` | Maintenance and dependency work |
| `ci` | CI/CD changes |
| `revert` | Reverts |

Allowed optional scopes:

`cli`, `agents`, `providers`, `assistants`, `config`, `proxy`, `workflows`, `ci`, `analytics`, `utils`, `deps`, `tests`, `skills`.

Examples:

```bash
fix(proxy): restore Claude Desktop SSO proxy routing
feat(agents): add OpenAI Codex CLI plugin with API key bypass
docs(cli): update profile auth command references
chore(agents): remove RTK integration and cleanup Claude plugin
```

Commitlint rules:

| Rule | Value | Source |
|---|---|---|
| Commit convention | `@commitlint/config-conventional` | `commitlint.config.cjs:7` |
| Allowed types | Explicit `type-enum` list | `commitlint.config.cjs:11` |
| Allowed scopes | Explicit `scope-enum` list | `commitlint.config.cjs:28` |
| Scope required | No, `scope-empty` disabled | `commitlint.config.cjs:45` |
| Subject case | Flexible | `commitlint.config.cjs:47` |
| Subject max length | 100 chars | `commitlint.config.cjs:49` |
| Body/footer max length | 300 chars | `commitlint.config.cjs:51` |

## Merge Strategy

**Strategy**: squash and merge.

Rationale:

| Reason | Impact |
|---|---|
| One main-branch commit per PR | Easier release notes and reverts |
| PR title is commitlint-checked | Squashed commit keeps conventional format |
| Feature branches can have iterative commits | Main history stays readable |

Repository signals:

| Signal | Evidence |
|---|---|
| Existing guide says squash and merge | `.codemie/guides/standards/git-workflow.md:221` |
| CI checks PR title with commitlint | `.github/workflows/ci.yml:60`, `.github/workflows/ci.yml:66` |
| CI checks PR commit messages | `.github/workflows/ci.yml:37` |
| Main branch is the release target | `.github/workflows/ci.yml:5` |

### PR Title Rule

The PR title should follow the same commit format as the final squashed commit.

| Avoid | Prefer |
|---|---|
| `Restore proxy route` | `fix(proxy): restore Claude Desktop SSO proxy routing` |
| `Codex upload` | `feat(agents): wire Codex mid-session conversation upload` |
| `docs update` | `docs(cli): update profile auth command references` |

CI validates the PR title with commitlint. If the title fails, update the title in GitHub before requesting merge.

### GitHub Issues

Use GitHub Issues as the work tracker.

| Need | Practice |
|---|---|
| Link a fix | Use `Closes #123` in the PR body |
| Reference related work | Use `Refs #123` in the PR body or commit body |
| Explain context | Put issue context in the PR body rather than inventing a ticket prefix |
| Preserve conventional commit subject | Keep the subject focused on the code change |

## Anti-Patterns

| Bad | Good |
|---|---|
| `wip` | `chore: checkpoint local packaging script cleanup` |
| `fix stuff` | `fix(proxy): restore Claude Desktop config path` |
| `feature/codex_plugin` | `feat/add-codex-plugin` |
| `EPMCDME-123: add agent` | `feat(agents): add agent plugin` |
| `feat(random): add model` | `feat(providers): add model configuration` |
| Long subject over 100 chars | Short subject plus body details |
| PR title outside commit format | `fix(cli): handle missing profile config` |

## Troubleshooting

| Issue | Fix |
|---|---|
| Commitlint rejects the type | Use one of the allowed types from `commitlint.config.cjs` |
| Commitlint rejects the scope | Use one of the allowed scopes or omit the scope |
| Subject is too long | Keep subject under 100 chars and move detail to body |
| PR title check fails | Rename the PR title to `type(scope): subject` |
| Branch name has no type prefix | Rename to `<type>/<kebab-case-description>` |
| Need to link GitHub issue | Add `Closes #123` or `Refs #123` in the PR body or commit body |

## Local Workflow

| Step | Command | Notes |
|---|---|---|
| Check current branch | `rtk git branch --show-current` | Read-only branch check |
| Check changes | `rtk git diff` | Review before staging |
| Check status | `rtk git status` | Confirm intended files only |
| Validate message | `echo "fix(proxy): restore route" \| npx commitlint` | Useful before commit |
| Run linting guide gates | `npm run lint`, `npm run typecheck` | Main local guardrails |
| Run full CI equivalent | `npm run ci` | Includes tests and build |

Do not perform git operations unless the user explicitly asks. This repository’s agent policy treats branch, commit, push, and PR operations as explicit-request-only.

## Linting Workflow

The git workflow is tied to linting and commitlint.

| Gate | When | Evidence |
|---|---|---|
| Commit message lint | Commit hook and CI | `.husky/commit-msg:1`, `.github/workflows/ci.yml:37` |
| PR title lint | Pull request CI | `.github/workflows/ci.yml:60`, `.github/workflows/ci.yml:66` |
| Staged TypeScript lint | Pre-commit via lint-staged | `.husky/pre-commit:1`, `package.json:54` |
| Full TypeScript lint | CI build job | `.github/workflows/ci.yml:136`, `package.json:42` |
| Typecheck | Pre-commit and local gate | `.husky/pre-commit:5`, `package.json:39` |

| Avoid | Prefer |
|---|---|
| Waiting until PR CI to discover lint issues | Run `npm run lint` locally for TypeScript changes |
| Committing messages that need later squash cleanup | Use commitlint format from the start |
| Treating lint warnings as advisory | `npm run lint` fails on warnings by design |

## Quick Reference

| Need | Command |
|---|---|
| Check recent commits | `rtk git log --oneline -10` |
| Check branch | `rtk git branch --show-current` |
| Validate last commit range | `npm run commitlint:last` |
| Validate a message manually | `echo "fix(proxy): restore route" \| npx commitlint` |
| Run pre-commit checks | `npm run check:pre-commit` |

## References

| Topic | Path |
|---|---|
| Commitlint config | `commitlint.config.cjs` |
| Commit message hook | `.husky/commit-msg` |
| CI checks | `.github/workflows/ci.yml` |
| Existing git guide | `.codemie/guides/standards/git-workflow.md` |

## Delivery Checklist

| Check | Reason |
|---|---|
| Branch follows `<type>/<kebab-case-description>` | Keeps branch naming predictable |
| PR title follows `type(scope): subject` | Required by CI and squash merge |
| Commit scopes use allowed list or are omitted | Required by commitlint |
| GitHub issue references use `#123` form | Matches tracker choice |
| Linting guide gates are followed | Repository treats linting as a primary workflow guardrail |
| Merge uses squash | Keeps `main` history clean |
