# Technical Research

**Task**: proxy connect claude-otlp vscode-claude-code analytics-clients
**Generated**: 2026-11-19
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-17531, Bug, verbatim essentials:

Summary: [CLI Analytics] connect --claude-otlp moves the VS Code Claude Code extension from the user's Claude subscription to the CodeMie budget without saying so.

`codemie proxy connect --claude-otlp` sets up analytics for every Claude client it finds. For the VS Code Claude Code extension it routes the extension's model traffic through the CodeMie proxy: writes ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (as claudeCode.environmentVariables) and claudeCode.disableLoginPrompt: true into the VS Code user settings. From then on the extension stops using the user's own Claude login (Pro/Max); its model requests are billed to the CodeMie (cli) budget of the proxy's profile. CLI output, --help, README and docs/COMMANDS.md say the extension is "routed through the CodeMie proxy" but none says this changes who pays. By design (D1/D13: extension can only be measured through the route). Defect: change not disclosed.

Actual: connect output "✓ VS Code Claude Code extension configured (…/Code/User/settings.json)" / "Reload VS Code to apply changes." — nothing about billing. Spend shows under Claude Desktop label on purpose (header-injection.plugin.ts: "The extension's requests keep the Desktop label").

Expected:
1. connect --help (the --claude-otlp and --vscode-claude-code descriptions), README line ~718 and docs/COMMANDS.md line ~1866 add one sentence, e.g. "The extension's model requests are then billed to your CodeMie budget instead of your Claude subscription; `codemie proxy disconnect --claude-otlp` switches it back."
2. Connect output adds one line under "✓ VS Code Claude Code extension configured", e.g. "Its model requests now use your CodeMie budget (profile <name>), not your Claude login."
3. Optional (PO decides): the interactive prompt mentions it too, together with the line about clients connected whatever the answer (see EPMCDME-17530).

Cause: connectors/vscode-claude-code.ts writes the route and disableLoginPrompt. Proxy authenticates with profile SSO, CodeMie bills to user's _codemie_cli budget. Wording in analytics-clients.ts (connectDescription for claude-otlp) and docs covers routing and removal, not billing.

Acceptance criteria:
1. Help text, README and docs/COMMANDS.md say that the extension (and Claude Desktop) use the CodeMie budget once connected, and how to switch back.
2. Interactive and --silent connect print the billing line for the extension when it is configured, and not when it is skipped (not found).
3. --claude-code-otlp alone (hooks only, no route) prints no billing line.

Tests to add: unit — connectDescription/help text for --claude-otlp and --vscode-claude-code contains billing sentence; unit — connect result printer adds billing line only when extension target configured; integration — scratch HOME with VS Code present, connect --claude-otlp --silent: output contains billing line, settings.json has route, then disconnect --claude-otlp restores settings.json exactly; integration — scratch HOME without VS Code: no billing line.

Also please identify: how to reproduce locally in a scratch HOME (which env vars / paths make the connector detect VS Code — e.g. the VS Code user settings dir location on macOS/Linux, and whether connect --silent needs a running proxy/profile), where the connect result is printed (interactive vs --silent paths), how the profile name is available at print time, and whether Claude Desktop's connect path is also a route (so the billing sentence for "Claude Desktop" is accurate).

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A — tell the user what connecting the extension does (help/list text).**
- `ANALYTICS_AGGREGATES[0].connectDescription` / `disconnectDescription` / `connectListLine` / `disconnectListLine` — `src/cli/commands/proxy/analytics-clients.ts:57-70`. Says "routes Claude Desktop and the extension through the CodeMie proxy, and codemie proxy disconnect --claude-otlp removes that route". Consumed by `addAggregateOptions()` (`src/cli/commands/proxy/index.ts:198-201`, Commander `Option(...).implies(members)`) for both `connect` and `disconnect` help, and by `aggregateListRows()` for bare-command target lists. No billing wording.
- `--vscode-claude-code` connect help — `index.ts:334`: "Configure the VS Code Claude Code extension (writes settings.json: ANTHROPIC_BASE_URL/token)". `--claude-desktop` help — `index.ts:333`: "Configure the Claude Desktop app (writes MCP servers config)" (does not mention the gateway route either).
- Bare-connect note — `CONNECT_TARGET_LIST`, `connect-orchestrator.ts:363`: "Note: --claude-otlp also routes Claude Desktop and the VS Code extension through the proxy; disconnect --claude-otlp removes that route." Pinned verbatim by `__tests__/target-lists.test.ts:77-86` (rows ≤100 chars rule at :62).
- Deprecation replacement text `CLAUDE_OTLP_CONNECT` — `index.ts:79`.
- Docs: `README.md:617`, `:714`, `:722` (the paragraph the ticket calls ~718), `:738`, `:740`; `docs/COMMANDS.md:97`, `:104`, `:1874` (ticket's ~1866), `:1878` table, `:1887`; `docs/PROXY-AND-ANALYTICS.md:42` (same "routes … through the proxy" sentence, not named by the ticket).

**Purpose B — report the outcome of connecting the extension.**
- `runVscodeClaudeCode(state, insiders, skipRerun)` — `connect-orchestrator.ts:712-732`. Prints `✓ VS Code Claude Code extension configured (<path>)` + `  Reload VS Code to apply changes.` (:715-716) on success; on `ClientNotInstalledError` under a vendor flag returns `skippedResult()` (:570-573, prints `… skipped — VS Code not installed; re-run …`); other errors print `Could not configure …`. This is the only place the success line is printed; there is no separate "result printer" — each `run*` prints its own lines, `printFailures()` (:575) lists failures at the end.
- `runClaudeDesktop` — `connect-orchestrator.ts:583-641`, prints `✓ Claude Desktop configured` + `Restart Claude Desktop to apply changes.`; no billing line.
- Dispatch — `connectTargets()` `connect-orchestrator.ts:948-1175`; extension runs at :1117-1122 only when `activeTargets.vscodeClaudeCode` (set by `--claude-otlp` via `.implies` or by `--vscode-claude-code`). `--claude-code-otlp` alone never sets it, so it never reaches `runVscodeClaudeCode`.
- Other prints for an existing route (not a new route): `moveToNamedKey` hints `✓ VS Code Claude Code extension moved to its own key — Reload VS Code…` (`client-targets.ts:174-207`), run by `moveClientsToNamedKeys` after any successful connect and by `proxy start`/`restart`.

**Purpose C — billing/attribution of extension traffic.**
- Header injection maps `VSCODE_CLAUDE_CODE` → `CLAUDE_DESKTOP` client type — `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts:153-156`. Billing (`_codemie_cli` budget) is decided by the backend; this repo has no budget logic for model requests (grep `budget` in docs only hits statusline/retry contexts). Unverified locally.

**Other touched code**
- `writeVsCodeClaudeCodeConfigAtPath` — `connectors/vscode-claude-code.ts:182-240`: upserts `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (`<gatewayKey>.vscode-claude-code`) and `claudeCode.disableLoginPrompt: true`; absent/empty file → full JSON with tab indent.
- `removeVsCodeClaudeCodeConfigAtPath` — `vscode-claude-code.ts:347-405`: acts only if `ANTHROPIC_BASE_URL` is loopback; deletes both managed env entries (array removed if empty) and `disableLoginPrompt`.
- `getVsCodeProductDir` — `connectors/vscode.ts:98-118`; `getVsCodeClaudeCodeSettingsPath` — `vscode-claude-code.ts:48-60` throws `ClientNotInstalledError` when the product dir is missing.
- `writeDesktopConfig` — `connectors/desktop.ts` writes `inferenceProvider: 'gateway'` (:642, :662) with `inferenceGatewayBaseUrl: proxyUrl` / `inferenceGatewayApiKey` (:115-130). Claude Desktop's model traffic is therefore also routed through the proxy.

### Decisions Already in the Code
- Each `run*` writer prints its own success/hint lines; outcome lines are not centralised. A billing line placed inside `runVscodeClaudeCode` success branch inherits AC2/AC3 behaviour automatically (skipped/failed/not-requested paths never reach it).
- `--silent` is a deprecated alias of `--yes` (`index.ts:72-77`, `:355`, `:380`); interactive vs `--yes`/`--silent` differ only in whether `confirmClaudeCodeOtlp` prompts (`connect-orchestrator.ts:1045-1068`). The per-target print path is identical in both.
- Profile at print time: `runVscodeClaudeCode` already receives `state: DaemonState`, which carries `state.profile` (used at :616 for Desktop logging). `connectTargets` also holds local `profile = config.name ?? 'default'` (:1025). The daemon match is strict on profile (`daemonMatchesRequest` :188-192; mismatching daemon is restarted :482), so `state.profile` equals the requested profile.
- Extension spend is labelled Claude Desktop on purpose (header-injection comment).
- Help rows in the bare-connect list are capped at 100 chars per line (`target-lists.test.ts:62`).

### Task Statements Checked Against the Code
- "writes ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN … and claudeCode.disableLoginPrompt: true" — holds (`vscode-claude-code.ts:200-219`).
- "help/README/COMMANDS say routed but not billing" — holds (analytics-clients.ts:61-64, index.ts:334, README:722, COMMANDS:1874); also `PROXY-AND-ANALYTICS.md:42` and the bare-connect Note (`connect-orchestrator.ts:363`) carry the same wording, not named by the ticket.
- "Claude Desktop also uses the CodeMie budget" (AC1) — routing holds (Desktop `inferenceProvider: 'gateway'` to the proxy); the billing consequence is backend-side, unverified here.
- "billed to the _codemie_cli budget of the proxy's profile" — unverified (backend); `_codemie_cli` appears only in metrics/identity code (`metrics-api-client.ts`, `identity-fields.ts`), not in request billing.
- "disconnect --claude-otlp restores settings.json exactly" — holds only partially: see Risk Indicators.
- "--claude-code-otlp alone prints no billing line" — holds structurally (no route written; `runVscodeClaudeCode` not called).
- "README line ~718 / COMMANDS ~1866" — actual lines are README:722 and COMMANDS:1874.

### Consumers of Changed Contracts
- `connectDescription` text: `index.ts:198-201` (help for connect); tests `analytics-clients.test.ts`, `index.test.ts` (grep-hit `claude-otlp`; no assertion found on the exact description string).
- `CONNECT_TARGET_LIST` note: asserted verbatim in `target-lists.test.ts:82-83`.
- Extension success output: `connect-orchestrator.test.ts` asserts skipped/failure lines (:1626-1714); no assertion found on the `✓ … configured` line itself. `index.test.ts:265` and `connect-orchestrator.test.ts:2246,2360,2373` pin the "moved to its own key" hint (unchanged by this task unless that path is touched).

### Architecture and Layers Affected
CLI layer only: `src/cli/commands/proxy/` (`index.ts` help, `analytics-clients.ts` aggregate text, `connect-orchestrator.ts` runner output, optionally `prompts/analytics-confirmation.ts`). Docs: README, docs/COMMANDS.md (and PROXY-AND-ANALYTICS.md). No proxy/plugin/connector behaviour.

### Integration Points
CLI → `connectors/vscode-claude-code.ts` (settings write) → VS Code `settings.json`; daemon via `ensureDaemon` (`connect-orchestrator.ts:442`); SSO credential check `assertSsoCredentials` (:283-306) via `getStoredPlatformCredentials` (keytar first, encrypted file under `CODEMIE_HOME` fallback, `src/utils/security.ts:416-540`).

### Patterns and Conventions
`chalk.green('✓ …')` success lines, `chalk.yellow('  …')` two-space indented follow-ups; `renderHint({reason, command})` for actionable hints; flags named via `aggregateFlagOf`/`memberFlag` rather than hard-coded.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/integration/exposed-api.md`, `external-integrations.md` exist; grep found no `vscode-claude-code`/`disableLoginPrompt` mention. `docs/COMMANDS.md` §"Analytics for every client of a vendor" (:1872) and §"Claude Desktop 3P" (:229) are the authoritative user docs.

### Architectural Decisions
D1/D13 named by the ticket were not located under `docs/superpowers/specs` by grep. Inline decision: header-injection Desktop label (:153).

### Derived Conventions
Docs and help text are kept in sync sentence-for-sentence (README:722 mirrors COMMANDS:1874 and PROXY-AND-ANALYTICS:42).

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` — connectors mocked (`vi.mock('../connectors/vscode-claude-code.js', …)` :84), `printed()` helper on console; covers skipped/failed extension lines.
- `__tests__/target-lists.test.ts` — bare list note; `__tests__/analytics-clients.test.ts`, `__tests__/index.test.ts` — aggregate/help wiring.
- `connectors/__tests__/vscode-claude-code.test.ts` — writer/remover.
- Integration: `tests/helpers/isolated-cli.ts` runs the real CLI with `CODEMIE_HOME` and `HOME` overridden (:72-73); `tests/integration/hook-proxy-cold-start-profile.test.ts`, `proxy-status-otlp-mismatch.test.ts` use it.

### Testing Framework and Patterns
Vitest; module mocks with `vi.mock` + `importOriginal`; `isNonInteractiveEnvironment` mocked from `@/utils/interactive.js`.

### Coverage Gaps
No assertion on the extension `✓ configured` line, on help description text content, or an end-to-end connect→disconnect round trip of the extension's settings.json via the real CLI.

---

## 5. Configuration and Environment

### Environment Variables
- VS Code detection (`getVsCodeProductDir`, `vscode.ts:98-118`): macOS `$HOME/Library/Application Support/Code` (`homedir()`), Linux `${XDG_CONFIG_HOME:-$HOME/.config}/Code`, Windows `%APPDATA%\Code`; Insiders uses `Code - Insiders`. Only the directory's existence matters; settings path is `<dir>/User/settings.json`.
- `CODEMIE_HOME` relocates CodeMie state (`src/utils/paths.ts:368`).

### Configuration Files
VS Code user `settings.json`; Claude Desktop `configLibrary` under `getDesktopBaseDir()`; `~/.claude/settings.json` (Claude Code hooks).

### Feature Flags and Deployment Concerns
Local repro requirements: `connect` needs an SSO-backed profile (`resolveSsoProxyConfig` :208), stored SSO credentials for its baseUrl (else exits 1 before any write, :308-320), a `baseUrl`, and for Claude Desktop a `codeMieUrl` (otherwise Desktop alone fails, :1019). It starts (or adopts) the daemon itself via `ensureDaemon`; no pre-running proxy needed. Without a TTY `--claude-otlp` needs `--yes`/`--silent` (:1008-1013). Keytar lookup is not scoped by `HOME`, so a scratch HOME on macOS may still find keychain credentials.

---

## 6. Risk Indicators

- "Restores settings.json exactly" is not guaranteed by `removeVsCodeClaudeCodeConfigAtPath`: a pre-existing user `claudeCode.disableLoginPrompt` value or user `ANTHROPIC_*` entries are overwritten on connect and deleted on disconnect; an absent settings.json before connect leaves a file (with remaining keys or `{}`) after disconnect. The integration test should seed a non-empty settings.json without those keys.
- Integration test needs SSO credentials and spawns a real daemon; keychain (keytar) is global, so isolation of a scratch HOME is partial on macOS.
- Wording length: bare-connect note and list rows are pinned verbatim and capped at 100 chars (`target-lists.test.ts`).
- Billing claim (`_codemie_cli` budget) and Desktop billing are backend facts not verifiable in this repo.
- `--claude-desktop` help text (`index.ts:333`) says "writes MCP servers config" while it also writes the gateway route — AC1 extends billing wording to Desktop, so this description is also in scope of the same disclosure.
- `docs/PROXY-AND-ANALYTICS.md:42` and `CONNECT_TARGET_LIST` note repeat the routing sentence and are not named by the ticket; leaving them unchanged keeps an inconsistent disclosure.
- Speculative: printing the line in `runClaudeDesktop` too is not asked by AC2 (extension only) though AC1 names Desktop.

---

## 7. Summary for Complexity Assessment

The change is confined to the CLI presentation layer of `src/cli/commands/proxy/`: help strings in `index.ts` (`--vscode-claude-code`, possibly `--claude-desktop`) and `analytics-clients.ts` (`claude-otlp` `connectDescription`), one extra output line in the success branch of `runVscodeClaudeCode` (`connect-orchestrator.ts:715-716`), optionally the confirmation prompt text, plus README (:722, :738-740), docs/COMMANDS.md (:104, :1874) and possibly docs/PROXY-AND-ANALYTICS.md:42. No connector, proxy or data behaviour changes. The profile name is already in scope at print time (`state.profile`), and the success branch is reached only when the extension was actually configured, so AC2/AC3 follow from placement; interactive and `--silent` (alias of `--yes`) share the same print path.

Novelty is low: existing `chalk` line conventions and Vitest `printed()` helpers in `connect-orchestrator.test.ts` cover the unit tests. Coverage gaps: no current assertion on the extension's `✓ configured` line or on help description content; no real-CLI connect/disconnect round trip for the extension. The integration tests the ticket asks for are the costly part: they require an SSO-backed profile with stored credentials and spawn a real daemon (`tests/helpers/isolated-cli.ts` provides `HOME`/`CODEMIE_HOME` isolation; VS Code is "present" when `$HOME/Library/Application Support/Code` on macOS or `$XDG_CONFIG_HOME/Code` on Linux exists).

Key risks: the "restores exactly" expectation holds only for a seeded settings.json without pre-existing managed keys; billing facts are backend-side and unverified; verbatim-pinned help/list text and the 100-char row limit; Claude Desktop is also a model route (`inferenceProvider: 'gateway'`), so the Desktop billing sentence in AC1 is consistent with the code.

---

## 8. External References

None named by the task.
