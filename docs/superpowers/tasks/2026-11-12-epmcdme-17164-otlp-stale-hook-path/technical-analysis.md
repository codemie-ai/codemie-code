# Technical Research

**Task**: otlp hooks localize default-agent-hooks claude-code-otlp
**Generated**: 2026-11-12
**Research path**: filesystem

---

## 1. Original Context

Bug EPMCDME-17164 — "OTLP hooks in ~/.claude/settings.json keep a stale CodeMie path after the CLI is removed". `codemie proxy connect --claude-code-otlp` writes Claude Code OTLP hooks into ~/.claude/settings.json with the absolute path of the CodeMie CLI found on PATH. If that CLI is later removed (e.g. npm install -> CodeMie Connect bundled runtime), agent launches don't repair the paths and Claude Code reports a SessionStart hook error (missing executable e.g. npm-prefix/codemie.cmd). Plugin hooks in ~/.codemie/claude-plugin/hooks/hooks.json ARE healed every launch via defaultAgentHooks.beforeRun -> installer.install() -> localizeInstalledHooks in BaseExtensionInstaller.ts (~lines 702-705; #656). OTLP hooks are localized only by proxy connect in claude-code-otlp.ts (~line 672) and once by migration 011-localize-otlp-hook-commands (#773), which can be marked applied while the old executable still exists.
Acceptance criteria: (1) On each agent launch, CodeMie checks OTLP hook commands in ~/.claude/settings.json and repairs CodeMie-owned `hook --agent claude-code-otlp` entries whose CLI path is stale. (2) After npm->CodeMie Connect switch, next launch points all affected OTLP hooks to current CLI, no missing-executable SessionStart error. (3) Other users' hooks and unrelated settings unchanged. (4) Settings file written atomically only when content changes; already-valid config not rewritten. (5) Automated tests cover removed executable, already-valid path, preservation of non-CodeMie hooks.
Implementation note from ticket: reuse localizeCodemieHookCommands (claude-code-otlp.ts ~line 330) alongside per-launch plugin healing in default-agent-hooks.ts.

---

## 2. Codebase Findings

### Existing Implementations

Purpose A: repair stale CodeMie CLI path in OTLP hook commands of `~/.claude/settings.json`.
- `src/cli/commands/proxy/connectors/claude-code-otlp.ts:330` `localizeCodemieHookCommands(hooksBlock)`: resolves binary, selects only hook entries whose command contains `hook --agent claude-code-otlp` (`CODEMIE_COMMAND_MARKER`, line 245; `isCodemieCommand` line 321), calls `rewriteHooksCommandTree(entries, binary, win32)`; mutates in place, returns `true` if changed. Does not read or write the file. Consumers: connect path (line 672, return value ignored; hooks were freshly built there), migration 011 (`src/migrations/011-localize-otlp-hook-commands.migration.ts:32`).
- `src/utils/hook-command.ts:96` `resolveHookCommand`: rewrites bare `codemie`, shadowed shims, and absolute codemie paths where any path token fails `existsSync` (line 109); an existing valid path is kept (only the `& ` prefix re-rendered, line 113). `rewriteHooksCommandTree` (line 120) recursively mutates, and on Windows adds `"shell": "powershell"` when the command starts with `& `. `resolveCodemieBinary` (line 60) = PATH shim via `getCommandPath('codemie')`, else `process.argv[1]`, else bare `codemie`; never throws.
- Migration 011 (`.../011-localize-otlp-hook-commands.migration.ts`): one-shot; reads `getClaudeSettingsPath()` (`src/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.ts:53`), calls `localizeCodemieHookCommands`, writes with `writeAtomically` only if changed. Silently skips on read error/ENOENT; invalid JSON is only warned. Runs once (registry marks applied) — it already does the "read, localize, write if changed" sequence the ticket needs per launch, inline, not as a reusable function.
- `writeAtomically` (`src/cli/commands/proxy/connectors/vscode.ts:247`): temp file + rename, preserves existing mode, creates parent dir. Used for settings writes by the connector and migration 011. `readSettingsFile` (claude-code-otlp.ts:273) returns `{}` if absent, throws `ConfigurationError` on invalid JSON / non-object.
- Migration 006 (`src/migrations/006-resolve-hook-command-paths.migration.ts:42`) is another one-shot using `rewriteHooksCommandTree`.

Purpose B: per-launch healing of plugin hooks (the pattern to mirror).
- `src/providers/core/default-agent-hooks.ts:18-51` wildcard `'*'.beforeRun`: lazy-imports `AgentRegistry`, gets `agent.getExtensionInstaller?.()`, calls `install()`; whole thing in try/catch, logs and continues on failure (never blocks launch). Returns early if no `config.agent` or no installer.
- `src/agents/core/extension/BaseExtensionInstaller.ts:525` `localizeInstalledHooks` (non-fatal try/catch, writes only if `rewriteHooksCommandTree` returned true, plain `writeFile` not atomic) called on both fresh-copy (701) and already-up-to-date (705) branches.
- `defaultAgentHooks` is consumed only by `src/providers/plugins/sso/sso.template.ts:62` and `jwt/jwt.template.ts:42`. `bedrock`, `ollama`, `anthropic-subscription`, `moonshot-subscription` templates define their own `agentHooks`; `litellm` showed no `agentHooks` match. Hook resolution chains wildcard then agent-specific (`src/agents/core/lifecycle-helpers.ts:80-93`); resolved by `env.CODEMIE_PROVIDER`.
- Distance from purpose: plugin healing is per-launch but covers only `~/.codemie/claude-plugin`; OTLP settings.json is healed only at connect time and by one-shot 011.

Other touched code: `src/providers/core/__tests__/providers-core.test.ts:295` (defaultAgentHooks tests).

### Decisions Already in the Code
- Staleness = "absolute codemie path with a non-existent file", decided inside `resolveHookCommand` (hook-command.ts:109); recorded reason in comment: EPMCDME-15907. Valid paths are left as-is, so idempotency (already-valid -> no change -> no write) is built into `rewriteHooksCommandTree`'s boolean.
- Ownership of an entry is by command substring marker `hook --agent claude-code-otlp`, at hook-entry granularity (claude-code-otlp.ts:308-323); user hooks in the same group are untouched.
- Convention: heal steps are non-fatal (try/catch + `logger.warn`) so launch is never blocked (default-agent-hooks.ts:42-47, BaseExtensionInstaller.ts:537).
- Convention: settings writes via `writeAtomically` (vscode.ts:247); `readSettingsFile` throws on invalid JSON "and was not changed".
- Convention: dynamic imports for cycle avoidance and startup cost (default-agent-hooks.ts:24, migration 011 line 15).
- Migrations are one-shot by design; no recorded reason for not re-running. Windows Claude hooks use `"shell": "powershell"` + `& ` prefix on quoted paths.
- Project rule: tests only on explicit request (AGENTS.md); the ticket explicitly requests tests (criterion 5).

### Task Statements Checked Against the Code
- "plugin hooks healed every launch via defaultAgentHooks.beforeRun -> install() -> localizeInstalledHooks (~702-705)": holds (lines 701/705; default-agent-hooks.ts:34).
- "OTLP hooks localized only by proxy connect (~672) and migration 011": holds (only two callers of `localizeCodemieHookCommands`).
- "localizeCodemieHookCommands at ~line 330": holds, but it takes an in-memory hooks block; it neither reads nor writes the file, so criterion 4 (write only on change, atomic) needs a caller doing read/write (migration 011 body is the existing example).
- "alongside per-launch plugin healing in default-agent-hooks.ts": the wildcard `beforeRun` is attached only to `sso` and `jwt` provider templates; other providers (bedrock, ollama, litellm, subscription ones) do not use it. Keeps in place: per-launch plugin healing is provider-scoped; criterion 1 "each agent launch" would not be met for providers not using `defaultAgentHooks`. Unverified whether those providers' own beforeRun call it.
- "migration can be marked applied while the old executable still exists": holds (one-shot registry; 011 returns success with `nothing-to-rewrite`).
- "SessionStart error for missing executable": cause consistent with `resolveHookCommand` line 109 existence check never running at launch; not reproduced.
- Wildcard `beforeRun` runs for every agent in these providers, not only claude; early-return conditions are `!config.agent`. Criterion "agent launch" includes non-Claude agents unless gated. Gating by agent is a spec decision.

### Consumers of Changed Contracts
- `localizeCodemieHookCommands`: connect path (claude-code-otlp.ts:672), migration 011, test mock in `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts:50-53,147` (mocks `resolveCodemieBinary`). Signature unchanged if reused as-is.
- `defaultAgentHooks['*'].beforeRun`: sso and jwt templates; tests in `providers-core.test.ts:298+`; `executeBeforeRun` chain in lifecycle-helpers.ts.
- `rewriteHooksCommandTree` / `resolveHookCommand`: connector, BaseExtensionInstaller, migrations 006/011, codemie-code.plugin.ts:304; tests `src/utils/__tests__/hook-command.test.ts`.

### Architecture and Layers Affected
Provider layer (`src/providers/core/default-agent-hooks.ts`), CLI/connector layer (`claude-code-otlp.ts` helper location), utilities (`hook-command.ts`, `writeAtomically` currently exported from `vscode.ts`), migrations (011 as precedent). Importing the connector from provider code is a layering crossing (migration 011 does it lazily).

### Integration Points
Claude Code `~/.claude/settings.json` (path from `getClaudeSettingsPath`, allowlist.ts:53); PATH lookup `getCommandPath`; `AgentRegistry`; `CODEMIE_PROVIDER` hook resolution.

### Patterns and Conventions
Lazy `await import`, `.js` extensions, `@/` alias, `logger` (no console), `ConfigurationError`, non-fatal heal.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists per AGENTS.md (architecture, development-practices, testing-patterns); not read in depth. `docs/ARCHITECTURE-OTLP-PLUGIN.md` referenced for the OTLP adapter contract; not read.

### Architectural Decisions
None recorded for per-launch vs one-shot settings healing. Inline: EPMCDME-15907 (claude-code-otlp.ts:328, migration 011, hook-command.ts:108), EPMCDME-14035 (BaseExtensionInstaller.ts:521).

### Derived Conventions
See "Decisions Already in the Code".

---

## 4. Testing Landscape

### Existing Coverage
- `src/migrations/__tests__/011-localize-otlp-hook-commands.migration.test.ts`: temp HOME via mocked `os.homedir`, mocked `resolveCodemieBinary`, seeded settings.json; covers bare rewrite and user-hook preservation.
- `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`: connector incl. localize on connect.
- `src/utils/__tests__/hook-command.test.ts`: `resolveHookCommand`/`rewriteHooksCommandTree`.
- `src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts`: plugin hook healing.
- `src/providers/core/__tests__/providers-core.test.ts:298`: `defaultAgentHooks`.

### Testing Framework and Patterns
Vitest, `vi.resetModules` + `vi.doMock` + dynamic import, tmp dirs.

### Coverage Gaps
No test of per-launch settings.json healing (nothing exists). No test for a stale absolute path in settings.json specific to removed executable (hook-command tests cover the resolver generally).

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_PROVIDER` (selects hook chain), `CODEMIE_<AGENT>_EXTENSION_DIR` (set by beforeRun). No new flags found.

### Configuration Files
`~/.claude/settings.json` (via `getClaudeSettingsPath`), `~/.codemie/claude-plugin/hooks/hooks.json`.

### Feature Flags and Deployment Concerns
None found. Windows-specific: `.cmd` shim handling, PowerShell pinning.

---

## 6. Risk Indicators

- Provider scope: `defaultAgentHooks` only on sso/jwt; other providers would not heal (see Task Statements Checked Against the Code).
- Wildcard beforeRun fires for all agents, including ones where Claude settings are irrelevant.
- `localizeCodemieHookCommands` does no I/O; each launch would add a settings.json read (and a `getCommandPath` PATH lookup) to startup.
- Invalid-JSON settings: `readSettingsFile` throws; migration 011 swallows. Launch must not fail on it (non-fatal convention).
- Concurrent Claude processes share settings.json; `writeAtomically` is rename-based, not locked (last-writer-wins race).
- Migration 011 duplicates read/write logic that a launch-time function would also need.
- Speculative: layering — provider code importing from `cli/commands/proxy/connectors` (and `writeAtomically` living in `vscode.ts`) crosses layers.
- Speculative: hooks only exist if the user connected OTLP; absent file/hooks must be a no-op.
- Tests: Windows path/`existsSync` behaviour makes "removed executable" tests need a nonexistent absolute path fixture; platform-dependent `shell: powershell` behaviour.

---

## 7. Summary for Complexity Assessment

The reusable parts already exist: `localizeCodemieHookCommands` (in-memory, marker-scoped, returns changed flag), `resolveHookCommand`'s file-exists staleness test, and `writeAtomically`. Migration 011 already contains the full read-localize-write-if-changed sequence once. The launch hook point is `defaultAgentHooks['*'].beforeRun` (default-agent-hooks.ts), which has a non-fatal try/catch convention. Likely change surface: 1 new small function (file-level heal), 1 edit to default-agent-hooks.ts, plus tests; 2-4 files.

Novelty is low. The notable design questions are scope: `defaultAgentHooks` is wired to only the sso and jwt providers, and its wildcard hook runs for every agent. Layering of the import from provider to connector code is a minor concern.

Test posture: good analogues (migration 011 test, hook-command tests, providers-core defaultAgentHooks tests), none for per-launch settings healing. Main risks are provider coverage, startup I/O on every launch, concurrent writers, and Windows-specific path handling.

---

## 8. External References

None named by the task.
