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

Knowledge sources and precedence:

- `.ai-run/guides/` owns workflow and policy: git workflow, quality gates, testing rules, security policies, coding standards.
- `openwiki/` (generated, see the OpenWiki section below) owns codebase facts: architecture, CLI surface, plugins, configuration behavior.
- On disagreement: guides win for process; source code wins for facts. Report stale guides instead of working around them.

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
| Testing | "write tests" / "run tests" | ONLY then |
| Git Operations | "commit" / "push" / "PR" / "MR" | Only then; load `.ai-run/guides/standards/git-workflow.md` |
| Shell | ANY shell command | bash/Linux syntax only |
| Changes to X-CodeMie-* attribution headers go through the security guide | adding, renaming or re-deriving an attribution header or the Responses user field | load `.ai-run/guides/security/security-practices.md` |
| Keep stdout clean in hook, --json and MCP stdio processes | editing bin/*.js start-up, codemie hook/sound, or the MCP proxy | load `.ai-run/guides/development/development-practices.md` |
| Register new plugins and migrations in their registry | adding an agent, provider, framework, proxy plugin or migration | load `.ai-run/guides/architecture/architecture.md` |
| Run unit and cli Vitest projects, not the agent project, unless agent tests are requested | running tests | load `.ai-run/guides/testing/testing-patterns.md` |
| Tests on explicit request only | "write tests" / "run tests" / "create unit tests" | Otherwise do not write, run, or suggest tests |
| Git ops on explicit request only | "commit" / "push" / "create branch" / "create PR" | Load `.ai-run/guides/standards/git-workflow.md`; defer to `sdlc-factory:mr-creator` skill for PR work |
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
| Project | .ai-run/guides/project.md | Project identity, tracker and source control |
| Quality | .ai-run/guides/quality-gates.md | Quality gates and how to run them |
| Architecture | `.ai-run/guides/architecture/architecture.md` | Plugin-based 5-layer architecture, layer responsibilities, dependency flow |
| Configuration | .ai-run/guides/usage/project-config.md | Global config writes and profile storage |
| Development | .ai-run/guides/development/development-practices.md | Logger levels, hook and --json stdout rules, process execution, errors, HTTP retries |
| Integration | .ai-run/guides/integration/exposed-api.md | codemie hook exit-code contract for agents |
| Integration | .ai-run/guides/integration/external-integrations.md | Provider HTTP client, MCP stdio bridge |
| Security | `.ai-run/guides/security/security-practices.md` | Credentials, sanitization, path validation |
| Standards | .ai-run/guides/standards/code-quality.md | Pi extension JS rules, any-usage convention |
| Standards | .ai-run/guides/standards/git-workflow.md | Branch, commit, PR title and merge conventions |
| Testing | `.ai-run/guides/testing/testing-patterns.md` | Vitest patterns, dynamic-import mocking |
| Development practices | `.ai-run/guides/development/development-practices.md` | Error handling, logging, processes, async patterns |
| Code quality | `.ai-run/guides/standards/code-quality.md` | TypeScript style, naming, type-safety conventions |
| Git workflow | `.ai-run/guides/standards/git-workflow.md` | Branching, Conventional Commits, PRs, Squash-and-Merge |
| External integrations | `.ai-run/guides/integration/external-integrations.md` | Provider plugins, SSO, LiteLLM, Bedrock, Kimi, ACP |
| Exposed API | `.ai-run/guides/integration/exposed-api.md` | CLI surface, MCP proxy endpoints, plugin contracts |
| Project config | `.ai-run/guides/usage/project-config.md` | Profiles, ConfigLoader, env vars, paths |
| Project context | `.ai-run/guides/project.md` | Tracker (Jira EPM-CDME / codemie-jira-assistant), MR (GitHub / sdlc-factory:mr-creator) |
| Quality gates | `.ai-run/guides/quality-gates.md` | lint, typecheck, build, test, license, secrets |
<!-- ai-run-init:guide-imports end -->

### Task Classifier

<!-- ai-run-init:task-classifier start -->
| Category | User Intent | Example Requests | P0 Guide | P1 Guide |
|---|---|---|---|---|
| Architecture | add or change a plugin, command, migration or packaged asset | "add a new agent plugin", "add a proxy plugin", "add a config migration", "add a CLI command" | .ai-run/guides/architecture/architecture.md | - |
| Configuration | read or write CodeMie config | "save a profile", "change config format" | .ai-run/guides/usage/project-config.md | - |
| Development | write runtime code that logs, spawns processes or prints output | "log a failure the user should see", "change codemie hook behaviour", "run a child process" | .ai-run/guides/development/development-practices.md | - |
| Integration | call an external service or change the MCP proxy | "add a provider API call", "change the MCP bridge" | .ai-run/guides/integration/external-integrations.md | .ai-run/guides/integration/exposed-api.md |
| Security | touch credentials, logging of request data, or X-CodeMie headers | "log request headers", "store a token", "add an attribution header" | .ai-run/guides/security/security-practices.md | - |
| Standards | commit, branch or open a PR | "commit changes", "create a PR" | .ai-run/guides/standards/git-workflow.md | .ai-run/guides/standards/code-quality.md |
| Testing | write or run tests | "write a unit test", "run integration tests", "mock a module" | .ai-run/guides/testing/testing-patterns.md | - |
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
| `child_process.exec` directly | `exec()` from `src/utils/exec.ts`; npm/spawn helpers in `src/utils/processes.ts` |
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
| license-check | .ai-run/guides/quality-gates.md | package.json::license-check | Load guide before running |
| lint | .ai-run/guides/quality-gates.md | package.json::lint | Load guide before running |
| type-check | .ai-run/guides/quality-gates.md | package.json::typecheck | Load guide before running |
| secret-scan | .ai-run/guides/quality-gates.md | package.json::validate:secrets | Load guide before running |
| test-unit | .ai-run/guides/quality-gates.md | vitest.config.ts::testCodemieHome | Load guide before running |
| test-cli | .ai-run/guides/quality-gates.md | vitest.config.ts::testCodemieHome | Load guide before running |
| Git / review workflow | .ai-run/guides/standards/git-workflow.md | git history and project context | Load guide before git operations |
<!-- ai-run-init:commands end -->

Project defaults:

- Package manager: npm
- Test framework: Vitest
- Build output: `dist/`
- Entry points: `bin/codemie.js` (CLI), `bin/agent-executor.js` (built-in agent), `bin/codemie-<agent>.js` (per-agent shortcuts), `bin/codemie-mcp-proxy.js`, `bin/proxy-daemon.js`. All declared in `package.json:bin`.

## Project Context

See `package.json` for exact dependency versions and `.ai-run/guides/architecture/architecture.md` for the plugin-based 5-layer architecture, layer responsibilities, and `src/` directory roles.

### Agent Plugins (`src/agents/plugins/`, registered in `src/agents/registry.ts`)

| Plugin | Dir | Upstream | Notes |
|---|---|---|---|
| `codemie-code` | `codemie-code.plugin.ts` | `@codemieai/codemie-opencode` | Built-in (`isBuiltIn`); native binary resolved by `codemie-code-binary.ts`, OpenCode-derived (`.opencode` home, `run`/`chat`/`config`/`init` subcommands). |
| `claude` / `claude-acp` | `claude/` | `@anthropic-ai/claude-code`, `@agentclientprotocol/claude-agent-acp` | Ships the CodeMie Claude plugin (`claude/plugin/`) |
| `codex` / `codex-acp` | `codex/` | `@openai/codex`, `@agentclientprotocol/codex-acp` | Responses API; reasoning state handled by proxy plugins. ACP variant wraps `@openai/codex` via a separate JSON-RPC adapter package, configured through an injected `CODEX_CONFIG` env var (no `--config` flags) |
| `gemini` / `gemini-acp` | `gemini/` | `@google/gemini-cli` | ACP variant prepends `--acp` to argv (native Gemini CLI mode, no extra package) |
| `opencode` / `opencode-acp` | `opencode/` | `opencode-ai` | Session metrics via `codemie opencode-metrics`. ACP variant prepends `acp` subcommand (native OpenCode mode, no extra package) |
| `pi` | `pi/` | `@earendil-works/pi-coding-agent` | Redirects `PI_CODING_AGENT_DIR` to `<cwd>/.pi/codemie/agent`; metrics via injected extension + run ledger |
| `kimi` / `kimi-acp` | `kimi/` | `@moonshot-ai/kimi-code` | ACP variant prepends `acp` to argv |
| `openwiki` | `openwiki/` | `openwiki` | Docs/wiki tool, not a chat agent; declarative-only adapter — `envMapping` feeds the profile's base URL/key/model to `OPENAI_COMPATIBLE_*`/`OPENWIKI_MODEL_ID`, SSO/JWT goes through the local proxy |
| `copilot-cli` | `copilot-cli/` | `copilot` (GitHub Copilot CLI) | Managed launcher — launches the real `copilot` binary and syncs conversations/usage to the shared spool; **not** analytics-only |
| `claude-code-otlp` | `claude-code-otlp/` | none | `OtlpAgentAdapter`, not a chat agent — ingests Claude Code's native hook events via `codemie hook --agent claude-code-otlp`; see `docs/ARCHITECTURE-OTLP-PLUGIN.md` for the agent-agnostic `OtlpAgentAdapter` dispatch pattern (used when adding a new hook event here, or a new adapter for another tool) |
| `copilot-chat-otlp` | `copilot-chat-otlp/` | none | `OtlpAgentAdapter` — hooks-only ingestion of VS Code Copilot Chat's native "Local" hooks via `codemie hook --agent copilot-chat-otlp`; no native OTel export is configured, so token usage is unavailable |
| `copilot-cli-otlp` | `copilot-cli-otlp/` | none | `OtlpAgentAdapter` — hooks-only ingestion of native (non-managed) GitHub Copilot CLI sessions via `codemie hook --agent copilot-cli-otlp --event <name>`; separate from the managed `copilot-cli` plugin above and guarded against double-counting via `CODEMIE_SESSION_ID` |

Not agent adapters, but injected runtime plugins under the same tree: `codemie-code-hooks/` (injected into `codemie-code` and `opencode`) and `reasoning-sanitizer/` (injected into `codemie-code`).

### Provider Plugins (`src/providers/plugins/`, auto-register via `registerProvider()`)

`sso` (CodeMie SSO — default, owns the local proxy), `jwt` (Bearer Authorization), `litellm`, `bedrock`, `ollama`, `anthropic-subscription`, `moonshot-subscription`.

Proxy plugins live under `src/providers/plugins/sso/proxy/plugins/` — see `.ai-run/guides/` and `docs/ARCHITECTURE-PROXY.md`.

### Documentation & Knowledge Tools (`src/frameworks/plugins/`, `group: 'documentation'`)

Deterministic docs/knowledge tooling (not agent harnesses): `codebase-memory` (MCP + graph UI), `codegraph` (local code intelligence graph + MCP), `graphify` (knowledge-graph skill for Claude Code). Managed via `codemie docs list|install|init <name>`; also visible in the grouped `codemie install` listing. OpenWiki is the exception — it is model-backed, so it stays an agent plugin (`codemie install openwiki`, `codemie-openwiki`) and is listed by `codemie docs` as a pointer.

> Neither `.ai-run/guides/integration/external-integrations.md` nor `docs/AGENTS.md` covers Pi yet. For Pi work, read `src/agents/plugins/pi/` directly plus the design docs under `docs/superpowers/specs/`.

## OTel (OTLP) Ingestion

The preferred way to ingest a coding tool's own native telemetry/hook events into CodeMie's analytics pipeline is the `OtlpAgentAdapter` pattern — one plugin per tool, each implementing `processOtlpEvent` (`src/agents/core/types.ts`), registered in `AgentRegistry`, invoked via `codemie hook --agent <adapter-name>`. Every adapter's `evaluate()` dispatch should follow the same shape (one `ForwardDecision`-returning handler per native event name, no `switch`, a single `forwardToSpool()` call site) and feed the same shared, agent-agnostic spool/forwarder pipeline (`OtlpHookSpoolData` → proxy daemon spool → `otlp-spool/forwarder.ts` → analytics API). Agent-owned common fields (platform, version, entrypoint, …) are resolved inside `processOtlpEvent`/`evaluate()` at hook-time and merged into the event before it reaches the spool — never via a callback the forwarder makes back into the adapter.

`claude-code-otlp` (`src/agents/plugins/claude-code-otlp/`) is the current reference implementation — see **`docs/ARCHITECTURE-OTLP-PLUGIN.md`** for the full contract, the dispatch pattern, how to add a new event to an existing adapter, and how to add a new adapter for another tool (e.g. a future Cursor adapter).

## Coding Standards

ES modules, async/await, `interface` for shapes, explicit return types on exports, no `any`. Full conventions live in `.ai-run/guides/development/development-practices.md` and `.ai-run/guides/standards/code-quality.md`.

## Detailed Policies

### Testing Policy

- Only work on tests if the user explicitly asks.
- See `.ai-run/guides/testing/testing-patterns.md` for Vitest conventions and `.ai-run/guides/quality-gates.md` for test commands.

### Git Policy

- Only perform git operations on explicit user request.
- Before any git operation, load and follow `.ai-run/guides/standards/git-workflow.md`; defer to the `sdlc-factory:mr-creator` skill for PR work.

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

**Diagnostic**: run `codemie doctor` and `codemie-code health`. If the correct pattern is unclear: search `.ai-run/guides/`, re-check the Guide Map and Task Classifier above, then ask the user.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
