# AGENTS.md

Canonical instruction file for AI agents working in the CodeMie Code repository. This is the shared source of truth. `CLAUDE.md` should stay minimal and import this file.

## Purpose

- CodeMie Code is an umbrella project with multiple agent plugins and provider integrations.
- This file defines the repo-specific workflow, architecture guardrails, policies, and quick references agents should use before changing code.

## Core Rules

### 1. Check Guides First

Before searching the codebase for patterns or implementation details:

1. Identify the task type and likely guides.
2. Load the relevant P0 guides from `.codemie/guides/`.
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

Primary guide locations:

- Architecture: `.codemie/guides/architecture/architecture.md`
- Development practices: `.codemie/guides/development/development-practices.md`
- Code quality: `.codemie/guides/standards/code-quality.md`
- Testing: `.codemie/guides/testing/testing-patterns.md`
- Git workflow: `.codemie/guides/standards/git-workflow.md`
- External integrations: `.codemie/guides/integration/external-integrations.md`
- Security: `.codemie/guides/security/security-practices.md`
- Project config: `.codemie/guides/usage/project-config.md`

### Task Classifier

| Keywords | Complexity | P0 Guide | P1 Guide |
|---|---|---|---|
| `plugin`, `registry`, `agent`, `adapter` | Medium-High | architecture | integrations |
| `architecture`, `layer`, `structure`, `pattern` | Medium | architecture | development practices |
| `test`, `vitest`, `mock`, `coverage` | Medium | testing | development practices |
| `error`, `exception`, `validation` | Medium | development practices | security |
| `security`, `sanitize`, `credential` | High | security | development practices |
| `provider`, `sso`, `bedrock`, `litellm`, `langgraph` | Medium-High | integrations | architecture |
| `cli`, `command`, `commander` | Medium | architecture | development practices |
| `workflow`, `ci/cd`, `github`, `gitlab` | Medium | git workflow | - |
| `lint`, `eslint`, `format`, `code quality` | Simple | code quality | - |
| `commit`, `branch`, `pr`, `git` | Simple | git workflow | - |

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

### Architecture

Core layers:

- CLI: `src/cli/commands/`
- Registry: plugin discovery and routing
- Plugin: concrete agent/provider implementations
- Core: base classes and contracts
- Utils: shared foundations like errors, logging, security, and processes

Required flow:

- `CLI -> Registry -> Plugin -> Core -> Utils`

Do not bypass layers by making the CLI call implementation details directly.

### Error Handling

Use the typed error classes in `src/utils/errors.ts` instead of generic `Error`.

Common classes:

- `ConfigurationError`
- `AgentNotFoundError`
- `AgentInstallationError`
- `ToolExecutionError`
- `PathSecurityError`
- `NpmError`
- `CodeMieError`

Always include useful context when handling failures. Use `createErrorContext()` and `formatErrorForUser()` from `src/utils/errors.js` where appropriate.

### Logging

- Use `logger.debug()` for internal details.
- Use `logger.info()` or `logger.success()` as appropriate.
- Do not use `console.log()` for debug logging.
- Do not log secrets, tokens, or raw sensitive payloads.
- Include session and agent context when relevant.

Session context is expected at startup:

- `logger.setSessionId(sessionId)`
- `logger.setAgentName('claude')`
- `logger.setProfileName('work')`

### Security

- Never hardcode credentials.
- Use environment variables or `CredentialStore`.
- Validate file paths with the security utilities.
- Sanitize values before logging with `sanitizeValue()` and `sanitizeLogArgs()`.

Utilities live in `src/utils/security.js`.

### Project Configuration

Config priority:

1. CLI arguments
2. Environment variables
3. Project config
4. Global config
5. Defaults

Config files:

- Global: `~/.codemie/codemie-cli.config.json`
- Local: `.codemie/codemie-cli.config.json`

Important behavior:

- Local config does not isolate from global config.
- Profile lookup is two-level: global base plus local overrides.
- Use `ConfigLoader` helpers instead of custom config logic.

### Process Utilities

Use the utilities in `src/utils/processes.ts`:

- `exec(command, args, options)`
- `commandExists(command)`
- `installGlobal(packageName)`
- `npxRun(command, args)`
- `detectGitBranch(cwd)`

Avoid calling low-level process APIs directly when the shared wrapper exists.

## Common Pitfalls

| Avoid | Use Instead |
|---|---|
| `require()` and `__dirname` | ES modules and `getDirname(import.meta.url)` |
| Imports without `.js` | Always include `.js` extension |
| Writing tests by default | Tests only on explicit request |
| `child_process.exec` directly | `exec()` from `src/utils/processes.ts` |
| `console.log()` debug output | `logger.debug()` |
| Logging raw secrets or tokens | `sanitizeLogArgs()` |
| Throwing generic `Error` | Specific project error classes |
| Hardcoded `~/.codemie` paths | `getCodemiePath()` from `src/utils/paths.ts` |
| CLI skipping architecture layers | `CLI -> Registry -> Plugin` |
| Callback-heavy async code | `async`/`await` |

## Development Commands

Common commands:

| Task | Command | Notes |
|---|---|---|
| Setup | `npm install` | Install dependencies |
| Build | `npm run build` | Compile TypeScript |
| Dev watch | `npm run dev` | Watch mode |
| Lint | `npm run lint` | Zero warnings required |
| Lint fix | `npm run lint:fix` | Auto-fix lint issues |
| Test | `npm test` | Only if user requested |
| Unit tests | `npm run test:unit` | Only if user requested |
| Integration tests | `npm run test:integration` | Only if user requested |
| CI pipeline | `npm run ci` | Full pipeline |
| Doctor | `codemie doctor` | Health check |
| Link global | `npm link` | Local CLI testing |

Build and link flow:

```bash
npm run build && npm link
codemie doctor
codemie-code health
```

Project defaults:

- Package manager: npm
- Test framework: Vitest
- Build output: `dist/`
- Entry points: `bin/codemie.js`, `bin/agent-executor.js`

## Project Context

### Stack

- TypeScript `5.3+`
- Node.js `20.0.0+`
- LangGraph `1.0.2+`
- LangChain `1.0.4+`
- Vitest `4.0.10+`
- ESLint `9.38.0+`
- Commander.js `11.1.0+`
- Inquirer `9.2.12+`

### Core Areas

- `src/cli/commands/`: CLI commands
- `src/agents/`: plugin-based agent system
- `src/providers/`: provider integrations
- `src/analytics/`: usage and metrics
- `src/workflows/`: CI/CD workflow templates
- `src/utils/`: shared utilities
- `src/env/`: configuration and profile management

### Architecture Summary

The codebase follows a plugin-based 5-layer architecture:

- CLI layer
- Registry layer
- Plugin layer
- Core layer
- Utils layer

Key design goals:

- separation of concerns,
- dependency inversion,
- extension through plugins,
- testability by layer.

## Coding Standards

### TypeScript

- Use ES modules everywhere.
- Use `async`/`await` for async flows.
- Prefer `interface` for object shapes.
- Use generics where they improve safety and reuse.
- Use optional chaining and nullish coalescing when appropriate.
- Prefer destructuring for clear parameter and return handling.

### Type Safety

- All exported functions must have explicit return types.
- Avoid `any`; use `unknown` when the type is truly unknown.
- `any` is allowed only when justified.
- Respect strict TypeScript settings.
- Prefix intentionally unused variables with `_`.

### Async and Concurrency

- Use `try`/`catch` around async operations that need context.
- Use `Promise.all()` for safe parallel operations.
- Avoid sequential `await` in loops unless ordering matters.
- Avoid blocking synchronous file operations in async CLI flows.

## Detailed Policies

### Testing Policy

- Only work on tests if the user explicitly asks.
- Testing uses Vitest.
- Dynamic imports are often required for mocking setups.

Useful commands:

- `npm test`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:watch`
- `npm run test:coverage`

### Git Policy

- Only perform git operations on explicit user request.
- Branch format: `<type>/<description>`
- Commit format: Conventional Commits like `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

### Environment Policy

- No activation step is required.
- Verify Node.js with `node --version`.
- If commands are missing, inspect Node.js installation and `PATH`.

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

### Diagnostic Commands

- `node --version`
- `npm --version`
- `npm list -g --depth=0`
- `codemie doctor`
- `ls -la dist/`
- `cat tsconfig.json`

### Recovery

If commands fail:

1. Verify Node.js version.
2. Reinstall dependencies with `npm install`.
3. Rebuild with `npm run build`.
4. Re-link with `npm link`.

If the build fails:

1. Check TypeScript errors.
2. Verify `.js` import extensions.
3. Rebuild after fixing errors.

If the correct pattern is unclear:

1. Search `.codemie/guides/`.
2. Re-check the quick references in this file.
3. Ask the user if ambiguity remains.

## Remember

- Check relevant guides before searching the codebase.
- Keep confidence and policy gates explicit.
- Follow the project architecture rather than inventing local shortcuts.
- Deliver complete, secure, production-ready changes without placeholders.

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# Wrong
git add . && git commit -m "msg" && git push

# Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build
rtk cargo check
rtk cargo clippy
rtk tsc
rtk lint
rtk prettier --check
rtk next build
```

### Test (90-99% savings)
```bash
rtk cargo test
rtk vitest run
rtk playwright test
rtk test <cmd>
```

### Git (59-80% savings)
```bash
rtk git status
rtk git log
rtk git diff
rtk git show
rtk git add
rtk git commit
rtk git push
rtk git pull
rtk git branch
rtk git fetch
rtk git stash
rtk git worktree
```

Note: Git passthrough works for all subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>
rtk gh pr checks
rtk gh run list
rtk gh issue list
rtk gh api
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list
rtk pnpm outdated
rtk pnpm install
rtk npm run <script>
rtk npx <cmd>
rtk prisma
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>
rtk read <file>
rtk grep <pattern>
rtk find <pattern>
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>
rtk log <file>
rtk json <file>
rtk deps
rtk env
rtk summary <cmd>
rtk diff
```

### Infrastructure (85% savings)
```bash
rtk docker ps
rtk docker images
rtk docker logs <c>
rtk kubectl get
rtk kubectl logs
```

### Network (65-70% savings)
```bash
rtk curl <url>
rtk wget <url>
```

### Meta Commands
```bash
rtk gain
rtk gain --history
rtk discover
rtk proxy <cmd>
rtk init
rtk init --global
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|---|---|---|
| Tests | `vitest`, `playwright`, `cargo test` | 90-99% |
| Build | `next`, `tsc`, `lint`, `prettier` | 70-87% |
| Git | `status`, `log`, `diff`, `add`, `commit` | 59-80% |
| GitHub | `gh pr`, `gh run`, `gh issue` | 26-87% |
| Package Managers | `pnpm`, `npm`, `npx` | 70-90% |
| Files | `ls`, `read`, `grep`, `find` | 60-75% |
| Infrastructure | `docker`, `kubectl` | 85% |
| Network | `curl`, `wget` | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->
