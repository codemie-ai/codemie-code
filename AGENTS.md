# AGENTS.md

Canonical instruction file for AI agents working in the CodeMie Code repository. This is the shared source of truth. `CLAUDE.md` should stay minimal and import this file.

## Purpose

- CodeMie Code is an umbrella project with multiple agent plugins and provider integrations.
- This file defines the repo-specific workflow, architecture guardrails, policies, and quick references agents should use before changing code.

## Core Rules

### 1. Check Guides First

Before searching the codebase for patterns or implementation details:

1. Identify the task type and likely guides.
2. Load the relevant P0 guides from `.ai-run/guides/`.
3. Search the codebase only after confirming the guides do not already answer the question.

Why this is mandatory:

- Guides contain curated patterns, conventions, and architectural decisions.
- Guide-first work reduces duplicated investigation and avoids anti-patterns.

### 2. Tests Only On Explicit Request

Only write or run tests when the user explicitly asks for it.

Explicit triggers:

- "write tests"
- "run tests"
- "create unit tests"
- "add test coverage"
- "execute test suite"

Do not proactively write, run, or suggest tests otherwise.

### 3. Git Operations Only On Explicit Request

Only perform git operations when the user explicitly asks for them.

Explicit triggers:

- "commit these changes"
- "create a commit"
- "push to remote"
- "create a branch"
- "create a pull request"

Do not proactively commit, push, branch, or suggest git operations.

### 4. Environment

- This is a Node.js project. No virtual environment activation is needed.
- Required runtime: Node.js `>=20.0.0`.
- npm is the package manager.

### 5. Shell

- Use bash/Linux-compatible shell commands only.
- Do not rely on PowerShell or `cmd.exe` syntax.

### Critical Rules (at a glance)

<!-- ai-run-init:critical-rules start -->
| Rule | Trigger | Action |
|---|---|---|
| Check Guides First | ANY task | Match keywords → category → load P0 guide before searching the codebase |
| Tests on explicit request only | "write tests" / "run tests" / "create unit tests" | Otherwise do not write, run, or suggest tests |
| Git ops on explicit request only | "commit" / "push" / "create branch" / "create PR" | Load `.ai-run/guides/standards/git-workflow.md`; defer to `codemie-pr` skill for PR work |
| Shell | ANY shell command | bash/Linux syntax only |
<!-- ai-run-init:critical-rules end -->

## Working Sequence

Use this sequence for every task:

1. Parse the request.
2. Identify keywords, complexity, and applicable policies.
3. Load relevant guides first.
4. Match against existing patterns and utilities.
5. Execute changes with those patterns.
6. Validate before delivery.

Confidence gate:

- `>= 90%`: proceed.
- `80-89%`: proceed after quick reference check.
- `70-79%`: load P0 guides, then reassess.
- `< 70%`: load P0 and P1 guides, then ask the user if still unclear.

Ask the user when:

- requirements are ambiguous,
- multiple approaches are equally valid,
- confidence stays below `80%`,
- architectural tradeoffs are material,
- or policy applicability is unclear.

## Guide Map

<!-- ai-run-init:guide-imports start -->
| Category | Guide Path | Purpose |
|---|---|---|
| Architecture | `.ai-run/guides/architecture/architecture.md` | Plugin-based 5-layer architecture, layer responsibilities, dependency flow |
| Development practices | `.ai-run/guides/development/development-practices.md` | Error handling, logging, processes, async patterns |
| Code quality | `.ai-run/guides/standards/code-quality.md` | TypeScript style, naming, type-safety conventions |
| Git workflow | `.ai-run/guides/standards/git-workflow.md` | Branching, Conventional Commits, PRs, Squash-and-Merge |
| Testing | `.ai-run/guides/testing/testing-patterns.md` | Vitest patterns, dynamic-import mocking |
| Security | `.ai-run/guides/security/security-practices.md` | Credentials, sanitization, path validation |
| External integrations | `.ai-run/guides/integration/external-integrations.md` | Provider plugins, SSO, LiteLLM, Bedrock, Kimi, ACP |
| Exposed API | `.ai-run/guides/integration/exposed-api.md` | CLI surface, MCP proxy endpoints, plugin contracts |
| Project config | `.ai-run/guides/usage/project-config.md` | Profiles, ConfigLoader, env vars, paths |
| Project context | `.ai-run/guides/project.md` | Tracker (Jira EPM-CDME / codemie-jira-assistant), MR (GitHub / codemie-pr) |
| Quality gates | `.ai-run/guides/quality-gates.md` | lint, typecheck, build, test, license, secrets |
<!-- ai-run-init:guide-imports end -->

### Task Classifier

<!-- ai-run-init:task-classifier start -->
| Keywords | P0 Guide | P1 Guide |
|---|---|---|
| `plugin`, `registry`, `agent`, `adapter` | architecture | external-integrations |
| `architecture`, `layer`, `structure`, `pattern` | architecture | development-practices |
| `test`, `vitest`, `mock`, `coverage` | testing-patterns | development-practices |
| `error`, `exception`, `validation` | development-practices | security-practices |
| `security`, `sanitize`, `credential` | security-practices | development-practices |
| `provider`, `sso`, `bedrock`, `litellm`, `langgraph`, `kimi` | external-integrations | architecture |
| `cli`, `command`, `commander` | architecture | development-practices |
| `workflow`, `ci/cd`, `github`, `gitlab` | git-workflow | quality-gates |
| `lint`, `eslint`, `format`, `code quality` | code-quality | quality-gates |
| `commit`, `branch`, `pr`, `git` | git-workflow | project |
| `config`, `profile`, `env`, `setup` | project-config | project |
| `ticket`, `EPMCDME`, `jira`, `story` | project | git-workflow |
<!-- ai-run-init:task-classifier end -->

Complexity guidance:

- Simple: 1 file, obvious pattern, usually direct tools are enough.
- Medium: 2-5 files, standard patterns, guide reference expected.
- High: 6+ files or architecture-sensitive work; investigate carefully before editing.

## Quick Validation

Before delivery, verify:

- the change matches the user request,
- the relevant policies were followed,
- no secrets or unsafe logging were introduced,
- error handling uses the project patterns,
- architecture boundaries were respected,
- async patterns are sound,
- exported APIs remain type-safe,
- there are no placeholder TODOs in delivered code.

## Pattern Reference

Detailed patterns for architecture, error handling, logging, security, project configuration, and process utilities live in the generated guides. Use the **Task Classifier** above to map your task to the right P0 guide and load it before searching the codebase.

## Common Pitfalls

| Avoid | Use Instead |
|---|---|
| `require()` and `__dirname` | ES modules and `getDirname(import.meta.url)` |
| Imports without `.js` | Always include `.js` extension |
| Deep relative imports (`../../..`) | `@/` alias (e.g. `@/env/types.js`) |
| Writing tests by default | Tests only on explicit request |
| `child_process.exec` directly | `exec()` from `src/utils/processes.ts` |
| `console.log()` debug output | `logger.debug()` |
| Logging raw secrets or tokens | `sanitizeLogArgs()` |
| Throwing generic `Error` | Specific project error classes |
| Hardcoded `~/.codemie` paths | `getCodemiePath()` from `src/utils/paths.ts` |
| CLI skipping architecture layers | `CLI -> Registry -> Plugin` |
| Callback-heavy async code | `async`/`await` |

## Development Commands

<!-- ai-run-init:commands start -->
| Need | Source Guide | Source Evidence | Notes |
|---|---|---|---|
| Setup | `.ai-run/guides/quality-gates.md` | `package.json:scripts` | Run `npm install`; verify Node ≥ 20 |
| Build / typecheck | `.ai-run/guides/quality-gates.md` | `package.json:scripts.build`, `scripts.typecheck` | Stops at first failure |
| Lint / format | `.ai-run/guides/quality-gates.md` | `package.json:scripts.lint`, `scripts.lint:fix` | Zero-warning policy |
| Unit / integration tests | `.ai-run/guides/quality-gates.md` | `package.json:scripts.test*` | Only on explicit user request |
| Pre-commit | `.ai-run/guides/quality-gates.md` | `.husky/pre-commit`, `package.json:scripts.check:pre-commit` | Runs automatically; do not `--no-verify` |
| Full CI | `.ai-run/guides/quality-gates.md` | `package.json:scripts.ci`, `scripts.ci:full` | Required before merge |
| Commit message | `.ai-run/guides/standards/git-workflow.md` | `commitlint.config.cjs`, `.husky/commit-msg` | Conventional Commits enforced |
| PR creation | `.ai-run/guides/standards/git-workflow.md` | `.claude/skills/codemie-pr/SKILL.md` | Invoke the `codemie-pr` skill |
| Ticket lookup / create | `.ai-run/guides/project.md` | `.codemie/codemie-cli.config.json`, codemie-jira-assistant | Invoke the `codemie-jira-assistant` skill |
| Doctor | (no guide needed) | `codemie doctor`, `codemie-code health` | Health diagnostics |
<!-- ai-run-init:commands end -->

Project defaults:

- Package manager: npm
- Test framework: Vitest
- Build output: `dist/`
- Entry points: `bin/codemie.js`, `bin/agent-executor.js`

## Project Context

See `package.json` for exact dependency versions and `.ai-run/guides/architecture/architecture.md` for the plugin-based 5-layer architecture, layer responsibilities, and `src/` directory roles.

## Coding Standards

ES modules, async/await, `interface` for shapes, explicit return types on exports, no `any`. Full conventions live in `.ai-run/guides/development/development-practices.md` and `.ai-run/guides/standards/code-quality.md`.

## Detailed Policies

### Testing Policy

- Only work on tests if the user explicitly asks.
- See `.ai-run/guides/testing/testing-patterns.md` for Vitest conventions and `.ai-run/guides/quality-gates.md` for test commands.

### Git Policy

- Only perform git operations on explicit user request.
- Before any git operation, load and follow `.ai-run/guides/standards/git-workflow.md`; defer to the `codemie-pr` skill for PR work.

## Troubleshooting

### Common Issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| `command not found: codemie` | CLI not linked or installed | `npm install -g @codemieai/code` or `npm link` |
| `Cannot find module './file'` | Missing `.js` extension | Add `.js` extension to imports |
| `Module not found: @codemieai/code` | Dependencies missing | `npm install` |
| Tests fail with mocking | Import timing issue | Use dynamic imports after setup |
| `CODEMIE_DEBUG=true` not working | Env var not exported | Export it in the shell |
| ESLint warnings | Code quality issues | `npm run lint:fix` |
| TypeScript compile errors | Type issues or missing declarations | Check `tsconfig.json` and imports |
| Permission denied on global install | Permissions issue | Use a user-local Node.js setup or elevated install |
| Agent not found after install | Registry or installation issue | Check `~/.codemie/agents/` and run `codemie doctor` |

### Diagnostic

Run `codemie doctor` and `codemie-code health`. If the correct pattern is unclear: search `.ai-run/guides/`, re-check the Guide Map and Task Classifier above, then ask the user.

## Remember

- Check relevant guides before searching the codebase.
- Keep confidence and policy gates explicit.
- Follow the project architecture rather than inventing local shortcuts.
- Deliver complete, secure, production-ready changes without placeholders.
