# Technical Research

**Task**: codemie proxy claude-desktop connector desktop.ts config.json custom3pMcpOAuth Claude-3p getClaudeDesktopBaseDir managed MCP oauth disconnect connect proxy command index.ts
**Generated**: 2026-11-18
**Research path**: codegraph

---

## 1. Original Context

There is a bug related to Claude Desktop running over the codemie proxy. When an MCP OAuth token expires, it is not possible to reconnect/refresh it. Workaround (from a teammate, originally in Ukrainian): check the claude-3p folder; there should be a config.json file; delete the `custom3pMcpOAuth` key in it (that is where the MCP OAuth tokens are stored); after that try `mcp auth` again. We need to create a new `codemie proxy` command that automatically deletes `custom3pMcpOAuth` from that config.json file. Then the user has to restart Claude Desktop and run `mcp auth` again to refresh the token. Create a Jira ticket for this task.

---

## 2. Codebase Findings

### Existing Implementations

**P1. Clear Desktop's stored MCP OAuth tokens (`custom3pMcpOAuth` in `<Claude-3p>/config.json`) so `mcp auth` can run again**
- None found. Searched `custom3p`, quoted `config.json` literals, `Claude-3p`, `McpOAuth` over `src/`, `docs/`, `README.md`, `openwiki/`. No repo code reads, writes or names `<Claude-3p>/config.json` or the key. Repo code touches only `configLibrary/` (+ `_meta.json`) and the sessions dirs under the Desktop base dir.
- Observed on this dev machine (outside repo, Linux): `~/.config/Claude-3p/config.json` exists, tab-indented; `custom3pMcpOAuth` is a top-level object (line 21) with one child per MCP server name (3 here); other top-level keys are Desktop's own state (`hostGitConfinedInstall`, `version_first_launch`, `bootFrameLayout`, `lastQuitCleanup`). Values deliberately not read (credentials).

**P2. Locate Claude Desktop's per-platform config directory**
- `getClaudeDesktopBaseDir()` `src/telemetry/clients/claude-desktop/claude-desktop.paths.ts:5-36`: win32 `%LOCALAPPDATA%\Claude-3p`; darwin `~/Library/Application Support/Claude-3p`; linux `$XDG_CONFIG_HOME` (absolute only, else `~/.config`) + `Claude-3p`; any other platform throws `ConfigurationError`. 17 callers incl. `getDesktopBaseDir` wrapper (`connectors/desktop.ts:675`), `readDesktopGatewayConfig` (`claude-desktop.gateway.ts:74`), `inspectDesktopProxy` (`inspect-desktop.ts:130`), sessions roots (`claude-desktop.paths.ts:59-65`).

**P3. Undo CodeMie's changes to Claude Desktop**
- `removeDesktopConfig(baseDir, managedStatePath)` `connectors/desktop.ts:979-1063`: reads `configLibrary/_meta.json` -> `appliedConfigId` (`claude-desktop.gateway.ts:36`, rejects unsafe ids) -> applied `<UUID>.json`; acts only if `isCodeMieGatewayConfig` (loopback gateway, `claude-desktop.gateway.ts:52`); strips inference/sign-in keys and CodeMie-managed `managedMcpServers`, keeps user servers and unrelated keys; deletes the file and its `_meta` entry when empty; removes the managed-state marker. Never opens `<base>/config.json`. Returns `RemoveDesktopConfigResult` (`:944`). Dependents: `disconnectClaudeDesktop` (`disconnect-orchestrator.ts:66-87`), tests (`desktop.test.ts:1378-1448`, `disconnect-orchestrator.test.ts:206`).
- Command surface: `codemie proxy disconnect --claude-desktop` (`index.ts:391`); prints "Quit and reopen Claude Desktop to apply the change." (`disconnect-orchestrator.ts:80`).

**P4. Give Desktop managed MCP servers with OAuth**
- `resolveDesktopOAuth` (`desktop.ts:293`), `mapCanonicalToDesktop` (`:317`), `writeDesktopConfig` (`:726-896`) write `managedMcpServers` (oauth object or boolean) into the applied `configLibrary` file. The token exchange and storage after that is Desktop's own; no CodeMie code handles Desktop's tokens.
- Sibling, different client: `codemie-mcp-proxy` persists logins encrypted at `~/.codemie/mcp-auth/<hash>.enc` (`src/mcp/auth/token-store.ts:64-71`); `forgetPersistedLogin` (`:158`) is called only internally (`mcp-oauth-provider.ts`, `token-store.ts`); no CLI command exposes it. Not Desktop's `custom3pMcpOAuth`.
- Proxy daemon routes `/mcp_auth?original=` and `/mcp_relay/` (`providers/plugins/sso/proxy/plugins/mcp-auth.plugin.ts:426,436`; `docs/ARCHITECTURE-PROXY.md:469-485`). Whether Desktop's managed-MCP OAuth uses them: unverified.

**Other touched code**
- Command registration `createProxyCommand` `src/cli/commands/proxy/index.ts:116-495`: subcommands `start`, `stop`, `restart`, `status`, `connect` (+ deprecated `desktop`/`vscode`), `disconnect`, `inspect` (`desktop`), `analytics` group. Handlers sit in sibling files (`disconnect-orchestrator.ts`, `inspect-desktop.ts`, `analytics-command.ts` via `createProxyAnalyticsCommand`). Mounted at `src/cli/index.ts:108`.
- Atomic file writers: `writeAtomically` `connectors/vscode.ts:296` (keeps mode, 0600 default, 26 callers incl. `desktop.ts` named-key move); `writeJsonFileAtomic` `src/utils/atomic-write.ts:49` (2-space JSON, symlink-aware, optional `refuseUnparsable`). `writeDesktopConfig`/`removeDesktopConfig` themselves use plain `writeFile` (`desktop.ts:866,1054`).
- Tracker: Jira, prefix EPMCDME, create via `codemie-jira-assistant` skill (`.ai-run/guides/project.md:13-24`).

### Decisions Already in the Code

- Disconnect scope is "what `connect` wrote": acts only on a loopback-gateway config, "a gateway anywhere else was configured by the user" (`desktop.ts:969-978`). Alternative (clearing Desktop-owned state): none in code; reason for the boundary recorded in that comment.
- Convention for Desktop-affecting commands: tell the user to quit and reopen Desktop (`disconnect-orchestrator.ts:80`; `docs/COMMANDS.md:257`). No code detects whether Desktop is running (searched `pgrep`, `tasklist`, `pidof`, `isRunning` under `src/cli/commands/proxy`).
- Convention for failures: unreadable or non-object JSON -> `ConfigurationError` saying the file "was not changed" (`desktop.ts:993-996,1011-1014`); per-target `try/catch` prints `✗ Claude Desktop - <msg>`, logs via `logger.warn` + `sanitizeLogArgs`, sets `process.exitCode = 1` (`disconnect-orchestrator.ts:81-86`). Unsupported platform -> `ConfigurationError` (`claude-desktop.paths.ts:33`).
- Convention for testability: connector functions take `baseDir` (default `getDesktopBaseDir()`), tests pass a temp dir (`desktop.test.ts:1384-1394`); platform/env simulated via `Object.defineProperty(process,'platform')` (`desktop.test.ts:102-171`).
- Never log secrets/tokens (`.ai-run/guides/development/development-practices.md:127`; `openwiki/integrations/mcp-and-desktop-clients.md:119`).
- File format: Desktop writes `config.json` tab-indented (observed); CodeMie JSON writers emit 2-space `JSON.stringify` (`desktop.ts:866,1054`; `atomic-write.ts:83`). No reason recorded.
- Data direction: none. The key is stored per server name under one top-level key; reading/deleting it needs no inversion.

### Task Statements Checked Against the Code

- "claude-3p folder" - holds with casing: code and docs name `Claude-3p` (`claude-desktop.paths.ts:11,15,30`).
- "there should be a config.json" - unverified in repo (no code mentions it); present on this Linux machine. macOS and Windows layouts unobserved; what would settle it: a macOS/Windows Desktop install.
- "`custom3pMcpOAuth` is where MCP OAuth tokens are stored" - unverified in repo (Desktop-internal). Observed: the key exists as a top-level object with per-server children; values not read.
- "after deleting it, `mcp auth` works again" and "restart Claude Desktop first" - unverified (Desktop behaviour); settle by reproducing on a Desktop install. The restart instruction matches the existing convention (see Decisions).
- "when an OAuth token expires, reconnect/refresh is impossible" - unverified; no Desktop-side refresh logic exists in this repo.
- "create a new `codemie proxy` command" - no existing command does this; `proxy disconnect --claude-desktop` leaves `<base>/config.json` untouched (`desktop.ts:979-1063`). Keeps no existing mechanism in place.
- "create a Jira ticket" - holds: tracker and adapter configured (`.ai-run/guides/project.md:13-24`). Branch is `main`, no EPMCDME key yet.

### Consumers of Changed Contracts

- The task adds a command and changes no existing function by itself. Shared things it would sit beside:
  - `createProxyCommand` (`index.ts:116`): consumer `src/cli/index.ts:108`; tests drive it with `parseAsync` (`index.test.ts`, `connect-wiring.test.ts`, `daemon-status-contract.test.ts`). The only subcommand-name enumerations are the analytics group's (`index.test.ts:656-665`, `analytics-command.test.ts:469`); none enumerates the proxy top-level list.
  - `getClaudeDesktopBaseDir` (17 callers, listed in P2): read-only use.
- Docs that list proxy commands: `docs/COMMANDS.md:86-102,226-300`, `README.md:805-827`. `openwiki/` is generated; AGENTS.md says do not hand-edit.

### Architecture and Layers Affected

- CLI layer: `src/cli/commands/proxy/index.ts` (command registration) and a handler module beside `disconnect-orchestrator.ts`.
- Connector layer: `src/cli/commands/proxy/connectors/desktop.ts` (Desktop config read/write).
- Shared path helper: `src/telemetry/clients/claude-desktop/claude-desktop.paths.ts`.
- No agent/provider plugin or proxy-daemon layer involved in the existing equivalents (`removeDesktopConfig` is invoked straight from the CLI).

### Integration Points

- Filesystem only, in Desktop's directory (`<Claude-3p>/...`); the daemon is not contacted by `disconnect` ("daemon deliberately left running", `disconnect-orchestrator.ts:3-5`).
- `configLibrary/_meta.json` and `<UUID>.json` are the files CodeMie already shares with Desktop.

### Patterns and Conventions

- Commander subcommand per capability; `.action` delegates to an orchestrator function; per-target errors printed with `chalk`, exit code via `process.exitCode`.
- ES modules, `.js` import suffix, `@/` alias, `logger` + `sanitizeLogArgs`, `ConfigurationError` (AGENTS.md "Common Pitfalls").

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md` (5-layer, CLI -> Registry -> Plugin), `development/development-practices.md` (logging, errors), `security/security-practices.md` (credential handling, sanitization).
- No guide covers the Claude Desktop connector; `docs/COMMANDS.md`, `docs/ARCHITECTURE-PROXY.md`, `src/telemetry/clients/claude-desktop/README.md` and `openwiki/integrations/mcp-and-desktop-clients.md` describe it.

### Architectural Decisions
- None recorded for Desktop's own `config.json` or OAuth state.

### Derived Conventions
- See "Decisions Already in the Code".

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`: `getDesktopBaseDir` per platform (`:102`), `writeDesktopConfig` (`:578`), `removeDesktopConfig` (`:1378-1448`).
- `src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts`: orchestration with mocked connectors, failing exit code (`:158`).
- `src/cli/commands/proxy/__tests__/connect-wiring.test.ts:453` (`disconnect --claude-desktop` wiring), `index.test.ts:656` (registration), `inspect-desktop.test.ts`.

### Testing Framework and Patterns
- Vitest; `vi.doMock` + dynamic import, `console.log` spies, temp dirs under `os.tmpdir()`, simulated platform/env. AGENTS.md: write or run tests only on explicit request.

### Coverage Gaps
- No test touches `<Claude-3p>/config.json` or `custom3pMcpOAuth` (nothing in the repo does).

---

## 5. Configuration and Environment

### Environment Variables
- `XDG_CONFIG_HOME` (`claude-desktop.paths.ts:27`), `LOCALAPPDATA` (`:10`); CodeMie home via `getCodemiePath` (managed-state `~/.codemie/proxy/desktop-managed-mcp-state.json`, `desktop.ts:610`). `MCP_PROXY_PERSIST_TOKENS` (`token-store.ts:61`) concerns the stdio relay only.

### Configuration Files
- Desktop-owned, observed on this machine and not referenced by the repo: `<Claude-3p>/config.json`, `claude_desktop_config.json`, `custom3p-mcp-schemas.json`. Referenced by the repo: `configLibrary/_meta.json`, `configLibrary/<UUID>.json`.

### Feature Flags and Deployment Concerns
- None found. Linux `/etc/claude-desktop/managed-settings.json` (`claude-desktop.paths.ts:55`) overrides local `configLibrary`; its effect on `config.json` is unverified.

---

## 6. Risk Indicators

- `<Claude-3p>/config.json` and `custom3pMcpOAuth` appear nowhere in the repo; the file is Desktop-owned, credential-bearing, and shared with Desktop's own state keys (Section 2, P1).
- The workaround's effect (key deletion restores `mcp auth`; restart needed) is unverified; no recorded sample or Desktop doc in reach.
- Only the Linux layout of `config.json` was observed; macOS and Windows locations resolve through `getClaudeDesktopBaseDir` but the file there is unobserved.
- No Desktop-running detection exists in the proxy command code. Speculative: a running Desktop may rewrite `config.json` (it keeps `lastQuitCleanup` state), so ordering against "restart Desktop" may matter.
- Speculative: attaching the behaviour to `disconnect` versus a new command changes which contracts have consumers (`DisconnectTargets`, `DISCONNECT_TARGET_LIST`, aggregate members in `analytics-clients.ts`, `disconnectTargets` guard `disconnect-orchestrator.ts:257-263`).
- Two writer conventions coexist for Desktop files (plain `writeFile` in `desktop.ts:866,1054`; `writeAtomically`/`writeJsonFileAtomic` elsewhere); Desktop's file is tab-indented, CodeMie's writers emit 2-space JSON.
- Credential handling: values under `custom3pMcpOAuth` are tokens; logging rules forbid emitting them (`development-practices.md:127`).
- Docs to keep in step: `docs/COMMANDS.md`, `README.md`; Jira ticket key not yet assigned (branch `main`).

---

## 7. Summary for Complexity Assessment

The research touches the CLI layer (`src/cli/commands/proxy/index.ts` registration plus a handler beside `disconnect-orchestrator.ts`), the Desktop connector (`connectors/desktop.ts`) and the shared path helper (`claude-desktop.paths.ts`). The existing equivalent, `removeDesktopConfig` behind `proxy disconnect --claude-desktop`, is a filesystem-only operation with an established shape: resolve `getClaudeDesktopBaseDir`, read JSON, preserve unrelated keys, fail with `ConfigurationError` without changing the file, print a restart notice. No existing function changes shape for this task; the new command sits beside shared registration code whose tests do not enumerate top-level subcommands.

Technical novelty is moderate: this would be the first CodeMie code to modify a Desktop-owned, credential-bearing file outside `configLibrary/`. Nothing in the repo reads or names `<Claude-3p>/config.json` or `custom3pMcpOAuth`; the key was confirmed to exist on this Linux machine as a top-level object keyed by MCP server name, but its role as the token store and the effect of deleting it are Desktop behaviour unverifiable from this repo. Only Linux layout was observed.

Test posture: adjacent code is well covered (platform path simulation, `removeDesktopConfig` round trips, disconnect orchestration, command wiring) with reusable temp-dir patterns; the target file has no coverage because nothing touches it today. Key risks are the unverified Desktop behaviour, unobserved macOS/Windows file layout, no Desktop-running detection, token-bearing data under the logging rules, and a Jira ticket still to be created via `codemie-jira-assistant`.

---

## 8. External References

- Task names "the claude-3p folder" and its `config.json` by name, not by path. Resolved via `getClaudeDesktopBaseDir()` rules to `~/.config/Claude-3p/config.json` on this Linux machine: resolved, exists.
- Facts needed, quotable: file is JSON, tab-indented; top-level keys include `custom3pMcpOAuth` (object, one child per MCP server name), `hostGitConfinedInstall`, `version_first_launch`, `bootFrameLayout`, `lastQuitCleanup`. Sibling files in the same directory: `claude_desktop_config.json`, `custom3p-mcp-schemas.json`, `configLibrary/`.
- Values of `custom3pMcpOAuth` were deliberately not read: they hold OAuth credentials. Shape came from key-name-only pattern matches.
- Not resolvable here: the teammate's workaround steps (`mcp auth`) and Desktop's reaction to the deletion.
