# Technical Research

**Task**: analytics proxy confirmation scope
**Generated**: 2026-10-26
**Research path**: filesystem
**Workspace**: `C:\Repositories\codemie-code-dzmitry-halai`
**Repository**: `codemie-code` — branch `EPMCDME-16394`, revision `cc618832412626530ad44712a8b19ce6faeac920` — **affected**

---

## 1. Original Context

Jira EPMCDME-16394: [CodeMie CLI][Analytics] Confirm analytics collection before starting the proxy
https://jiraeu.epam.com/browse/EPMCDME-16394
Issue type: Story. Status: In Progress.

User story
As a CodeMie user, I want to understand and confirm the analytics scope when the proxy starts, so that I know what activity may be collected and sent to CodeMie.

Description
The default analytics scope is Project. Users can select Project or Global scope during setup or reconfiguration.

When the proxy starts with analytics enabled, display a confirmation prompt for the configured scope. Use the same structure and confirmation behavior for both scopes. Clearly describe the activity covered and state that analytics will be sent to CodeMie. The prompt's default action is Confirm; pressing Enter confirms. If the user declines or cancels, analytics remain disabled for that proxy start.

Respect the existing silent flag at proxy startup. In silent mode, skip the interactive confirmation prompt and continue analytics collection using the configured scope. For example, pass --silent to the proxy startup command.

Confirmation prompts

Project scope
- Prompt: Enable Claude Code analytics for the current project?
- Body: When analytics are enabled, data from Claude Code activity in the current project will be sent to CodeMie. This applies whether Claude Code is launched through CodeMie or directly.
- Options: Enable analytics / Decline

Global scope
- Prompt: Enable global Claude Code analytics?
- Body: When analytics are enabled, data from Claude Code activity in any project will be sent to CodeMie. This applies whether Claude Code is launched through CodeMie or directly.
- Options: Enable analytics / Decline

Acceptance criteria
1. Project is the default scope when none has been configured. Users can select Project or Global during setup or reconfiguration; the selected scope is saved and shown in the effective configuration.
2. When the proxy starts with analytics enabled, it displays a confirmation prompt for the configured scope. The Project prompt includes the project name and describes collection within that project. The Global prompt describes collection across all activity, including activity outside configured CodeMie projects. Both prompts state that analytics will be sent to CodeMie.
3. The prompt defaults to Confirm; pressing Enter confirms. Declining or cancelling keeps analytics disabled for that proxy start.
4. The existing silent flag applies to proxy startup: in silent mode, the proxy skips the interactive prompt and continues analytics collection using the configured scope.
5. The new notification's visual style should be consistent with the rest of the CLI design.
6. Update the relevant documentation to describe the default scope, scope selection and persistence, proxy-start confirmation behavior, and silent-mode behavior.
7. Regression coverage verifies confirmation, decline, cancellation, and silent-mode behavior.

Note the wording tension already in the ticket: sample options say Enable analytics / Decline, while acceptance criteria say the default action is Confirm and Enter confirms; acceptance criterion 2 says the Project prompt includes the project name, while the sample prompt says "the current project" without a name. Record that as a finding, do not resolve it.

---

## 2. Codebase Findings

Node.js CLI (`package.json`: `@codemieai/code`, `"type": "module"`, Node `>=20`). Guides describe CLI → Registry → Plugin → Core → Utils. This behavior does not follow that chain for proxy start: the proxy command calls the daemon and connector directly.

### Existing Implementations

- `src/cli/commands/proxy/index.ts` — `proxy start` (`ProxyStartOptions`: `--port`, `--profile` only). Loads config, verifies SSO, calls `spawnDaemon`. If a matching daemon is already running, it prints and returns. No analytics prompt and no `--silent`.
- `src/cli/commands/proxy/connect-orchestrator.ts` — `ensureDaemon` (used by `proxy connect`) and exported `ensureOtlpProxy(agentName)`. Both spawn via `spawnDaemon` when no live daemon matches. `ensureOtlpProxy` returns immediately when `readState()` finds a live pid. Neither takes a silent flag or prompts.
- `src/cli/commands/proxy/daemon-manager.ts` — `SpawnOptions` / `DaemonState` carry target URL, profile, project, client type, telemetry mode. No analytics-enabled or scope field.
- `src/cli/commands/proxy/index.ts` — `proxy connect` / `disconnect --claude-code-otlp` take `--scope <user|project>`, default `'user'`. Help text: `"user"` tracks all projects and resets the list; `"project"` adds or removes only the current project.
- `src/cli/commands/proxy/connectors/claude-code-otlp.ts` — writes hooks and OTel env into user-level `~/.claude/settings.json`. Hook command is `codemie hook --agent claude-code-otlp` (`CODEMIE_COMMAND_MARKER`). `--scope project` sets the allowlist to paths from `addProjectPath(..., resolveProjectRoot())`. Any other scope (including the default) writes `[]`. Comment on the result: empty allowlist means all projects. Requires a live daemon (`readState()`), otherwise throws "Run: codemie proxy start".
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.ts` — `CODEMIE_ANALYTICS_PROJECT_FILTER` is a JSON array string in `~/.claude/settings.json` `env`. `isProjectTracked`: absent or empty list → tracked (all projects); invalid → not tracked; otherwise `cwd` must be inside a listed path.
- `src/utils/project-root.ts` — `resolveProjectRoot()` walks up for `.git` and returns that directory path, else `process.cwd()`. It does not return a display name.
- `src/agents/core/OtlpAgentAdapter.ts` — `processOtlpEvent`: allowlist gate first (`isTracked`), then `ensureOtlpProxy`, then evaluate and spool. Untracked projects must not start the daemon. Comment: the daemon has no allowlist; the completeness gate sends only sessions that have hooks data.
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` — `isTracked` calls `isProjectTracked(cwd, readAllowlistState())`.
- `src/cli/commands/hook.ts` — `codemie hook --agent <name>` reads JSON from stdin. If the agent is an analytics adapter, it calls `processOtlpEvent` and exits. No `--silent`. Stdout is the hook protocol for blocking decisions.
- `src/cli/commands/setup.ts` — `codemie setup` / update-an-existing-profile uses inquirer. Storage question is Global (`~/.codemie/`) vs Local (`.codemie/`), default Global. That is config-file location, not analytics collection scope. No analytics scope prompt.
- `src/cli/commands/shared/prompts/storage-scope.ts` — custom raw-mode prompt used by assistants/skills setup, not by `codemie setup`. Choices Global/Local. Footer: "Enter Confirm". ESC and Ctrl+C resolve to `StorageScope.GLOBAL`.
- `src/env/types.ts` — `MultiProviderConfig` has `version`, `activeProfile`, skills, assistants, `userEmail`, `workspace`, `profiles`. No analytics scope. `WorkspaceConfig.metrics` is `{ enabled?, sync? }` with comments "default: true". `codeMieProject` is the selected CodeMie application name.
- `src/utils/config.ts` — `WORKSPACE_KEYS` includes `metrics`. `loadWithSources` / `showWithSources` attribute merged profile and workspace fields (`cli > env > project > global > default`). No analytics-scope key is merged. `loadFull` comment says "including analytics"; the returned object is the raw multi-provider file, which has no analytics field.
- `src/cli/commands/profile/index.ts` and `src/utils/profile.ts` — `profile status` shows profile, provider, model, CodeMie URL, auth. `--show-sources` prints `showWithSources`. Neither shows an analytics scope.
- `src/agents/core/AgentCLI.ts` — agent binaries (`codemie-claude` and siblings) define `-s, --silent` ("Enable silent mode"). `BaseAgentAdapter` uses `silentMode` to suppress stdout notices (ACP/JSON-RPC). That flag is not forwarded to `proxy start` or the hook command written into Claude settings.
- `src/utils/interactive.ts` — `isNonInteractiveEnvironment()` is `!process.stdin.isTTY`.

No reader of `metrics.enabled` was found outside the type, `WORKSPACE_KEYS`, and migration key lists. No confirmation, decline, or per-start analytics disable exists on proxy start.

### Architecture and Layers Affected

- **CLI** — `proxy start`, `proxy connect --claude-code-otlp --scope`, `codemie setup`, `profile status`, `codemie hook`.
- **Core** — `OtlpAgentAdapter.processOtlpEvent` (allowlist gate, then daemon ensure).
- **Plugin** — `claude-code-otlp` adapter and the proxy connector that writes Claude settings.
- **Utils** — `ConfigLoader`, `resolveProjectRoot`, `isNonInteractiveEnvironment`.
- **Proxy daemon** — `spawnDaemon` / spool. Filtering is not in the daemon.

### Integration Points

- Claude Code user settings `~/.claude/settings.json` (`env.CODEMIE_ANALYTICS_PROJECT_FILTER`, hooks, OTel endpoint `${daemon.url}/v1/analytics/otlp`).
- Hook process → `ensureOtlpProxy` → local daemon → `otlp-spool` forwarder → CodeMie analytics API. Documented in `docs/ARCHITECTURE-PROXY.md` §6.14 and `docs/HOOKS.md`.
- CodeMie config files (`~/.codemie/codemie-cli.config.json`, `.codemie/codemie-cli.config.json`) hold profiles and workspace, including `codeMieProject`, not the allowlist.
- OTel export is global: untracked projects still send telemetry to the local daemon; the completeness gate does not upload OTEL-only sessions (`docs/COMMANDS.md` privacy note).

### Patterns and Conventions

- Inquirer `type: 'confirm'` with `default: true` (Enter confirms) is used in setup and SSO re-auth (`sso.setup-steps.ts`).
- Richer CLI chrome is the custom raw-mode selection UI (`src/cli/commands/shared/selection/ui.ts`, purple chalk, `●`/`○`, Enter to confirm). `promptStorageScope` is the closest existing scope chooser and it does not treat ESC/Ctrl+C as cancel.
- `@clack/prompts` and `@clack/core` are dependencies in `package.json` and have no imports under `src/`.
- Allowlist semantics and the "do not start the daemon for untracked projects" invariant are commented as load-bearing in `OtlpAgentAdapter` and the allowlist module.
- Config persistence goes through `ConfigLoader` (`saveProfile` splits workspace keys). Guides say not to read config files directly.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — five layers; `src/analytics/` is listed as usage tracking. Proxy confirmation is not described.
- `.ai-run/guides/usage/project-config.md` — priority `CLI > env > project > global > default`; `profile status --show-sources`. No analytics collection scope.
- `.ai-run/guides/integration/external-integrations.md` — OTLP ingestion via `codemie hook --agent <adapter>`; points at `docs/ARCHITECTURE-OTLP-PLUGIN.md`. No confirmation prompt.
- `.ai-run/guides/integration/exposed-api.md` — v2 config example includes `analytics?`. **Stale:** `MultiProviderConfig` in `src/env/types.ts` has no `analytics` field.
- `docs/COMMANDS.md` § "Claude Code OTLP analytics" — connect scope table: default `--scope user` writes `[]` (every project); `--scope project` adds the current project root. States the daemon has no allowlist logic.
- `docs/ARCHITECTURE-PROXY.md` §6.14 and `docs/HOOKS.md` "Claude Code OTLP Hook Filter" — same allowlist rules and hook-side filtering.
- `docs/AGENTS.md` — agent `--silent` is described for ACP adapters (no stdout that would break JSON-RPC), not for proxy start.

### Architectural Decisions

- Allowlist absent or empty means track every project; invalid means track nothing (`claude-code-otlp.allowlist.ts`, COMMANDS.md).
- Daemon must not decide tracking; only the hook process does (`OtlpAgentAdapter.ts` invariant comment, ARCHITECTURE-PROXY.md).
- OTel environment is global, so untracked sessions still export to the local daemon and are then skipped/swept rather than uploaded.

### Derived Conventions

- "Scope" already means two other things: config storage Global vs Local, and connect `--scope user|project`. Neither is a saved Project/Global analytics field on the effective profile.
- `codeMieProject` (platform application name) and `resolveProjectRoot()` (filesystem git root) are different values. The allowlist stores the filesystem path.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/__tests__/index.test.ts` — `proxy start` spawn, profile selection, already-running short circuit. No prompt or `--silent`.
- `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts` — user vs project allowlist writes, invalid allowlist, disconnect.
- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.allowlist.test.ts` — absent/empty track all; invalid tracks nothing; path nesting.
- `src/agents/core/__tests__/OtlpAgentAdapter.test.ts` — untracked project does not call `ensureOtlpProxy`.
- `src/cli/commands/__tests__/hook.analytics-wiring.test.ts` — hook passes `{ ensureOtlpProxy, forwardOtlpEventsToSpool }`.
- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` — daemon ensure/restart. No `ensureOtlpProxy` confirmation cases (the symbol is not asserted there).

### Testing Framework and Patterns

Vitest `^4.1.5`. Unit tests co-located in `__tests__` with `vi.mock` and dynamic `import()` after mock setup. Integration tests live under `tests/`. Proxy tests mock `spawnDaemon`, `ConfigLoader`, and stdin/stdout spies.

### Coverage Gaps

No test covers an analytics confirmation, decline, cancellation, or silent skip at proxy start or inside `ensureOtlpProxy`. No test covers a persisted Project/Global analytics scope on the effective configuration.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_ANALYTICS_PROJECT_FILTER` — allowlist in Claude settings, read only by the hook process.
- OTel vars written beside it (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, and the fixed `CODEMIE_ENV_KEYS` in the connector).
- ConfigLoader env overrides (`CODEMIE_PROVIDER`, `CODEMIE_URL`, and the set in `project-config.md`) do not include an analytics scope. `CODEMIE_PROJECT` does not override `codeMieProject`.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` and `.codemie/codemie-cli.config.json` — profiles and workspace. No analytics scope field in the type.
- `~/.claude/settings.json` — actual Claude Code analytics tracking list.
- `~/.codemie/proxy-daemon.json` — daemon state (`DaemonState`). No analytics flag.

### Feature Flags and Deployment Concerns

- Connect `--scope` default `'user'` (all projects). Not a runtime feature flag.
- `workspace.metrics.enabled` is documented on the type as default true and is not read by proxy start.
- Agent `-s, --silent` and `isNonInteractiveEnvironment()` exist. `proxy start` and `codemie hook` do not define `--silent`.
- Hook command in settings has no silent argument, so a silent agent launch does not mark later direct Claude Code hook runs as silent.

---

## 6. Risk Indicators

- Unconfigured tracking is global: absent or `[]` tracks every project, and connect’s default `--scope user` writes `[]`. The ticket default is Project. Names differ (`user`/`project` vs Global/Project).
- Scope lives in Claude settings, not CodeMie config, so profile status cannot show it. `codeMieProject` is not the git-root path from `resolveProjectRoot()`.
- `ensureOtlpProxy` runs in a new hook process per event (JSON stdin, protocol stdout). An in-memory decline does not survive the next event. A live daemon returns before any prompt.
- No `--silent` on `proxy start` or `codemie hook`. Agent `--silent` is not stored in the hook command. `SpawnOptions` has no per-start analytics switch. OTel still reaches the local daemon when hooks are skipped.
- Ticket wording stays unresolved: Enable analytics / Decline versus default action Confirm; project name versus "the current project".
- Inquirer confirms default to yes. `promptStorageScope` maps ESC/Ctrl+C to Global. `@clack/prompts` is unused. `exposed-api.md`’s `analytics?` field is absent from `MultiProviderConfig`.

---

## 7. Summary for Complexity Assessment

Claude Code analytics scope is `CODEMIE_ANALYTICS_PROJECT_FILTER` in `~/.claude/settings.json`, written by `proxy connect --claude-code-otlp`. Default `--scope user` stores `[]`; absent and empty both track every project. `--scope project` adds the git root. Setup never asks, and profile status does not show it. `workspace.metrics` has no runtime reader. Layers: CLI proxy command, OTLP connector, `OtlpAgentAdapter`, config display.

The daemon starts from `proxy start` (`--port`, `--profile` only), `ensureDaemon` on connect, and `ensureOtlpProxy` after the allowlist gate. None prompt. Each hook is a new process. Agent `-s/--silent` only sets `silentMode`. A live daemon skips spawn.

Vitest covers the allowlist, connect writes, proxy-start spawn, and the untracked gate. It does not cover confirmation, decline, cancel, or silent. Docs say empty means all projects, opposite the ticket’s Project default. The ticket also disagrees with itself on Confirm versus Enable analytics, and on including the project name.

---

## 8. External References

`https://jiraeu.epam.com/browse/EPMCDME-16394` was not opened. Section 1 is the supplied copy. Left unresolved: sample options are Enable analytics / Decline, while acceptance criterion 3 says the default action is Confirm and Enter confirms; acceptance criterion 2 requires the project name, while the sample Project prompt says "the current project".
