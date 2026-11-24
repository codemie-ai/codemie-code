# Technical Research

**Task**: proxy daemon hook profile (EPMCDME-16321)
**Generated**: 2026-11-02
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16321 (Bug): "[CLI Analytics][Proxy] After the proxy daemon stops, a hook silently restarts it with the profile of the hook's working directory instead of the connected profile".

Ticket body: `codemie proxy connect --claude-code-otlp --profile <name>` starts one shared proxy daemon on port 4001, used by all clients (Claude Code OTel/hook events, Claude Desktop model requests). If the daemon stops, the next claude-code-otlp hook starts a new one via `ensureOtlpProxy()` in src/cli/commands/proxy/connect-orchestrator.ts. That function takes the profile from the hook's cwd (`ConfigLoader.getActiveProfileName(process.cwd())`), not the profile chosen in `proxy connect`. If a Claude Code session runs in a directory with a different local `.codemie/` profile, the daemon comes back on that profile: different environment, credentials, project, model list, analytics. Nothing tells the user; hook prints only "Starting proxy... Proxy started". Also: while the daemon cannot start (e.g. expired SSO) every hook waits 5s then fails ("Daemon failed to start within 5 seconds"); expected: fail fast.
Acceptance criteria:
1. The hook auto-start restarts the daemon with the profile that `proxy connect` configured, regardless of the hook's working directory.
2. If that profile cannot be started (e.g. expired SSO), the daemon is not started on another profile, and the reason is logged with the profile name.
3. "Starting proxy" output names the profile used.

Agreed design (verify each statement against the code and report where it is wrong or risky):
- New file `proxy-connection.json` in ~/.codemie (path via getCodemiePath, constant next to DEFAULT_STATE_FILE in src/cli/commands/proxy/daemon-manager.ts). Content (identity only): profile, project, clientType, telemetryMode, updatedAt. No secrets, no URL/model/provider (those are re-resolved from the profile at restart so profile edits apply).
- Written inside `spawnDaemon` (covers proxy connect, proxy start, proxy restart, hook cold start). Deleted only by `proxy disconnect`. `proxy stop` does not delete it (hooks keep restarting after stop, as today).
- `ensureOtlpProxy`: reads the record; if missing -> do not start a daemon, log one line and return. If present -> `ConfigLoader.load(cwd, { name: record.profile })`, spawn with the recorded project/clientType/telemetryMode. Never fall back to the cwd profile.
- Credentials check before spawning, without process.exit: `verifySsoCredentials` currently calls process.exit(1) (connect-orchestrator.ts ~288-305) so the hook needs a throwing/non-exiting variant shared with connect. On failure: no spawn, log reason incl. profile name (hook failure stays non-blocking; OtlpAgentAdapter catches ensureOtlpProxy errors).
- 'Starting proxy' status message (ensureDaemon, logger.status) must include the profile name.
- Existing proxy-daemon.json semantics and all its readers stay unchanged.
Out of scope: the concurrent-hooks stop-and-respawn race in ensureDaemon.

Questions: (a) project resolution with explicit `name`; (b) every spawnDaemon caller; (c) where `proxy disconnect` lives; (d) affected tests; (e) recorded profile missing/unloadable; (f) other OTLP adapters; (g) malformed record.

feature_area: proxy daemon hook profile

---

## 2. Codebase Findings

### Existing Implementations

Purpose A: restart the daemon with the identity it had.
- `proxy-daemon.json` (`daemon-manager.ts:33`, `DaemonState` :9-31) already stores profile, project, clientType, telemetryMode, but only while the daemon lives: `stopDaemon` (:146-183), daemon `cleanup()` on SIGTERM/SIGINT (`src/bin/proxy-daemon.ts:113-118`) and `checkStatus` on a dead pid (:67-70) delete it. Readers: `agents/plugins/utils.ts:26`, `agents/core/hook-credentials.ts:22`, `otlp-spool/forwarder.ts:216`, `connectors/claude-code-otlp.ts:471`, `restart.ts:28,97`, `index.ts:146,168,197,421`, `connect-orchestrator.ts:400,451`.
- `restart.ts:63-93` `restartRunning` preserves port/clientType/telemetryMode/gatewayKey/model/project from the live state. `restart.ts:35-43` `lostIdentityError` records that once nothing runs the identity is lost and "a plain restart would start a default proxy". `restartStopped` (:17-24) spawns `clientType: 'codemie-daemon'` from the cwd/`--profile` config.
- `ensureOtlpProxy` (`connect-orchestrator.ts:450-491`): early return when `readState()` pid alive; else `getActiveProfileName(cwd)` -> `ConfigLoader.load(cwd, {name})`; silent return when `baseUrl` blank (EPMCDME-15372 guard, :466-471); `ensureDaemon` with `clientType = agentName`, `spawnOptions {clientType: agentName}`, no telemetryMode, no model override beyond `config.model`.

Purpose B: know whether the profile can start before spawning (fail fast).
- `verifySsoCredentials` (`connect-orchestrator.ts:288-305`): `getStoredPlatformCredentials({provider:'ai-run-sso', baseUrl, codeMieUrl})`; on a miss or throw it does `console.error` + `process.exit(1)`. Callers: `connectTargets` :851 and `launch-daemon.ts:23` (`prepareDaemonLaunch`, used by `proxy start` and `proxy restart`). `getStoredCredentials` deletes expired credentials, so expiry shows as "not found" (`codemie-auth-helpers.ts:222-226`).
- Hook-side SSO flows that read the cwd profile independently: `claude-code-otlp.plugin.ts:443-459` `ensureProxyAuth` (`ConfigLoader.load(process.cwd())`, runs on UserPromptSubmit after `ensureOtlpProxy`), `copilot-chat-otlp.plugin.ts:210`, `copilot-cli-otlp.plugin.ts:262`. `hook-credentials.ts` is daemon-state driven.
- `spawnDaemon` poll (`daemon-manager.ts:133-143`): 50x100 ms then `ToolExecutionError('Daemon failed to start within 5 seconds')`; any daemon boot failure (not only SSO) costs the 5 s.

Purpose C: show which profile is used.
- `ensureDaemon` `logger.status('Starting proxy...')` (:431) and `logger.success('Proxy started')` (:444): no profile. `launch-daemon.ts:39` `console.log('Starting proxy daemon...')`: no profile. `connectTargets` prints `Using profile: <name>` via console.log (:843-848). `restart.ts:13` and `index.ts:149,157` print `(profile: X)`.
- In a hook process `bin/codemie.js:27` calls `logger.setConsoleStream(null)`: `logger.status/success/warn` reach only the file log; any `console.*` reaches the protocol stdout/stderr (`tests/integration/hook-stdout.test.ts:284-289` asserts both empty). The ticket's "hook prints" therefore means the file log.

Other touched code:
- `daemon-manager.ts` `SpawnOptions` (:75-87), `spawnDaemon` (:89-144); `disconnect-orchestrator.ts`; `OtlpAgentAdapter.ts:99-105` (swallows `ensureOtlpProxy` errors with `logger.warn('[name] ensureOtlpProxy failed (non-blocking): <message>')`; the flow then continues to `evaluate` and `forwardOtlpEventsToSpool`, which returns false when no state, `utils.ts:28-31`).

### Decisions Already in the Code

- Daemon state path: module-level `DEFAULT_STATE_FILE = join(getCodemieHome(), 'proxy-daemon.json')` (`daemon-manager.ts:33`); `getCodemiePath(...)` = `path.join(getCodemieHome(), ...)` (`utils/paths.ts:385`) honours `CODEMIE_HOME`. Convention: tests redirect via `CODEMIE_HOME`/mock of `getCodemieHome`.
- State file I/O convention: `readState` swallows every error (missing, unreadable, malformed JSON) and returns null (:35-42) but casts without shape validation; `writeState` writes `<file>.tmp` then `rename` (:44-51); `clearState` ignores errors.
- Explicit-profile loading never fails for an unknown name: `loadGlobalConfigProfile` returns `{}` when a name was given and is absent from global (`config.ts:306-310`); `loadLocalConfigProfile` returns `{}` (:352). The returned config still has `name = <requested>` because cliOverrides are assigned last (:197-199), `provider` defaults to `'openai'` (:99), `baseUrl` undefined. Env `CODEMIE_BASE_URL/API_KEY/MODEL/PROVIDER/URL/AUTH_METHOD/INTEGRATION_*` are dropped when a name is given (:151-189). A legacy (non-multi) global config returns `{...raw, name:'default'}` for any requested name (:325-327).
- An empty/undefined `name` is treated as "no explicit profile" (`resolveProfileName` :382, `if (cliOverrides?.name)` :151) and falls back to the cwd's local `activeProfile`.
- `ConfigLoader.load` reads the cwd every time: `resolveWorkspace` -> `loadLocalMultiProviderConfig(cwd)` throws `ConfigurationError` for an unrecognised local config format (`config.ts:557-574`), also with an explicit name; `.env` in cwd is dotenv-loaded (:141-143).
- `deriveDaemonIdentity` (:137-154) makes one identity per target set; Claude Desktop / VS Code Claude Code spawn only `{telemetryMode:'claude-desktop'}` (no `clientType`); the daemon derives `clientType='claude-desktop'` (`src/bin/proxy-daemon.ts:90`) and starts the Desktop telemetry runtime only for that mode (:151-175). `getEffectiveClientType(state)` (:179-185) is the existing helper for that derivation.
- Daemon `clientType` is used by proxy plugins: ALLOWED_AGENTS gates (`claude-request-normalizer` and `background-request-normalizer`: `codemie-claude, codemie-copilot, claude-desktop`; vscode normalizer: `vscode-byok`; codex plugins), `X-CodeMie-Client` header, session-sync, analytics `agentName` (`sso.proxy.ts:439,687`). The OTLP hook endpoint does not read it (body carries `agentName`, `utils.ts:36`).
- `daemonMatchesRequest` (:192-204) requires profile, port, project, provider, targetUrl, model and effective clientType to be equal.
- Data direction: the task needs the identity after the daemon is gone; it exists only in the live state file (see Purpose A). Usual alternative in this codebase: none found (restart.ts documents the loss).

### Task Statements Checked Against the Code

- "one shared daemon on port 4001 for all clients": holds (`DEFAULT_DAEMON_PORT`, single `DEFAULT_STATE_FILE`, single identity per daemon).
- "`ensureOtlpProxy` takes the profile from the cwd": holds (`connect-orchestrator.ts:457-464`).
- "hook prints 'Starting proxy... Proxy started'": holds only in the file log (see Purpose C); nothing reaches the user's terminal.
- "every hook waits 5 s then fails": holds (`daemon-manager.ts:133-143`; swallowed at `OtlpAgentAdapter.ts:99-105`). The wait applies to any boot failure, not only expired SSO.
- "written inside `spawnDaemon` covers proxy connect": contradicted in part. `ensureDaemon` skips `spawnDaemon` when a healthy matching daemon runs (:400-418, :429-445), so `connect` against an already-running matching daemon (also one started earlier by a hook, or before an upgrade) writes/refreshes nothing. `proxy start` against a matching daemon returns early too (`index.ts:147-151`).
- "`spawnDaemon` covers proxy start / restart": holds for the caller list; `proxy start` and `restartStopped` overwrite the same record with their own profile (cwd/`--profile`) and `codemie-daemon` identity, so "the profile `proxy connect` configured" becomes "profile of the last spawn".
- "`verifySsoCredentials` calls process.exit(1) (~288-305)": holds, plus `console.error` which would reach a hook's stdout/stderr (bin/codemie.js:27 mutes only the logger). Shared with `launch-daemon.ts:23`.
- "No URL/model/provider recorded; re-resolved from the profile": holds for global profiles. Contradicted for a same-named local profile: when the cwd defines a local profile with the recorded name, `ConfigLoader.load` overlays that local profile (baseUrl, provider, apiKey, model) and takes `codeMieProject/codeMieUrl/codeMieIntegration` from the cwd's workspace (`config.ts:112-137, 234-249`).
- "OtlpAgentAdapter catches ensureOtlpProxy errors": holds. Its log line carries only the error message, so the profile name must be in the thrown message or logged by `ensureOtlpProxy` itself.
- "`proxy stop` does not delete the record; hooks keep restarting": holds (`stopDaemon` clears only `proxy-daemon.json`; `index.ts:164-175`).
- "proxy-daemon.json semantics and readers unchanged": no code in the task conflicts; the readers listed under Purpose A read only `proxy-daemon.json`.
- Out of scope race (concurrent hooks): keeps `stopRacingDaemon` (`restart.ts:26-32`) and `ensureDaemon` stop-then-spawn (:418-427) in place.

### Consumers of Changed Contracts

- `spawnDaemon(SpawnOptions)` callers (all, non-test): `connect-orchestrator.ts:432` (via `ensureDaemon`, reached from `connectTargets` :889 and `ensureOtlpProxy` :490) and `launch-daemon.ts:40` (`spawnForProfile`, reached from `launchDaemon` -> `proxy start` `index.ts:155`, `restartStopped` `restart.ts:20`, `restartRunning` `restart.ts:74`). No other spawn of `bin/proxy-daemon.js`.
  - `ensureDaemon`: `profile=config.name ?? 'default'`, `project=config.codeMieProject`, `model` only if set, `port=4001`, `...identity.spawnOptions` (`{telemetryMode:'claude-desktop'}` | `{clientType:'vscode-byok'|'codex-desktop'|'claude-code-otlp'|'copilot-chat-otlp'|'copilot-cli-otlp'}`), `syncApiUrl`, `syncCodeMieUrl`. Hook path: `{clientType: agentName}`.
  - `proxy start`: overrides `{port}` only -> `clientType`/`telemetryMode` undefined in `SpawnOptions` (daemon defaults to `codemie-daemon`).
  - `restartStopped`: `{port:4001, clientType:'codemie-daemon'}`. `restartRunning`: `{port, clientType: state.clientType, telemetryMode: state.telemetryMode, gatewayKey, model, project}`; with `--profile` switch the project is re-read from the new profile.
  - Record completeness: for the Claude Desktop / VS Code Claude Code identity `SpawnOptions.clientType` is undefined and `telemetryMode='claude-desktop'`; for everything else `telemetryMode` is undefined.
- `proxy disconnect`: `index.ts:341-372` -> `disconnectTargets` (`disconnect-orchestrator.ts:153-175`). Targets only `--codex-desktop`, `--claude-code-otlp`, `--copilot-chat-otlp`, `--copilot-cli-otlp` (no Claude Desktop / VS Code target). It removes client wiring (Codex toml block; Claude settings hooks/env/allowlist; Copilot hook files/settings) and "deliberately leaves the daemon running" (file header :1-5; `docs/COMMANDS.md:308-313`). `--scope project` (`mode: 'entry-removed'`) removes only the current project from the tracked list while others stay tracked. It never touches `proxy-daemon.json`. Each target result is independent; a failure sets `process.exitCode=1`.
- `ensureOtlpProxy(agentName)` callers: only `OtlpAgentAdapter.ts:101` via `hook.ts:1567`; used by `ClaudeCodeOtlpPlugin` (name `claude-code-otlp`), `CopilotChatOtlpPlugin` (`copilot-chat-otlp`), `CopilotCliOtlpPlugin` (`copilot-cli-otlp`), all `extends OtlpAgentAdapter`. Each passes its own name as `clientType`; the daemon is shared and the OTLP hook endpoint ignores daemon `clientType`, so a single record per machine holds one `clientType` regardless of which hook triggers the restart.
- `verifySsoCredentials`: `connect-orchestrator.ts:851`, `launch-daemon.ts:23`; tests rely on `process.exit` being thrown by a spy (`connect-orchestrator.test.ts:144-146, 383, 412`).
- The `'Starting proxy...'` string: `connect-orchestrator.ts:431`; asserted exactly at `connect-orchestrator.test.ts:468, 554, 1048`, and by regex `/\[INFO\][^\n]* Starting proxy\.\.\.\n/` at `tests/integration/hook-stdout.test.ts:289`; documented output in `docs/COMMANDS.md:1619` (`Proxy started`).

### Architecture and Layers Affected

CLI command layer (`src/cli/commands/proxy/`: daemon-manager, connect-orchestrator, launch-daemon, restart, disconnect-orchestrator, index), agent-core layer (`agents/core/OtlpAgentAdapter.ts` consumer only), config layer (`utils/config.ts`, read only). Dependency flow: `hook.ts` -> `connect-orchestrator` -> `daemon-manager`; `launch-daemon` -> `connect-orchestrator` (for `verifySsoCredentials`) and `restart.ts` -> `connect-orchestrator` (`DEFAULT_DAEMON_PORT`).

### Integration Points

`ConfigLoader.load/getActiveProfileName/listProfiles`; `getStoredPlatformCredentials` (dynamic import of `providers/core/codemie-auth-helpers.js`); detached daemon via `utils/processes.ts spawnDetached`; `logger` (`sanitizeLogArgs` for structured args).

### Patterns and Conventions

ESM with `.js` extensions, `@/` alias, `logger.*` not `console.*` in hook paths, specific error classes (`ConfigurationError`, `ToolExecutionError`), atomic tmp+rename state writes, `getCodemiePath` over hardcoded `~/.codemie` (AGENTS.md pitfalls table).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development-practices, testing-patterns, project-config, external-integrations); none documents the daemon state file or hook cold start. Behavior is described in `docs/ARCHITECTURE-PROXY.md` (hook-side filtering :925), `docs/ARCHITECTURE-OTLP-PLUGIN.md` (`ensureOtlpProxy` in the dispatch flow :26, :53), `docs/HOOKS.md:580`, `docs/COMMANDS.md:87-93, 267, 308-313, 1619`.

### Architectural Decisions
No ADR on this topic. Prior related task: `docs/superpowers/tasks/2026-10-22-epmcdme-15372-missing-baseurl-proxy-startup/` (baseUrl guard) and `2026-10-29-epmcdme-15379-hook-stdout/` (status lines through the logger so hook stdout stays clean).

### Derived Conventions
See Patterns and Conventions above.

---

## 4. Testing Landscape

### Existing Coverage (affected by the change)
- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`: `vi.mock('../daemon-manager.js')` factory (:26-31) exports only `checkStatus/readState/spawnDaemon/stopDaemon`; any new import from daemon-manager is undefined under it. `describe('ensureOtlpProxy')` (:993-1056, four tests: three blank-baseUrl skips, one cold start asserting `'Starting proxy...'` / `'Proxy started'`); `ConfigLoader` mock has `load/listProfiles/getActiveProfileName`; `process.exit` spy (:144); SSO via `CodeMieSSO` mock (:68-70, :109-111). `Starting proxy...` also asserted at :468, :554.
- `src/agents/core/__tests__/OtlpAgentAdapter.test.ts`: mocks `@/cli/commands/proxy/daemon-manager.js` (:41) and `@/utils/config.js`; test at :232-250 runs the real `ensureOtlpProxy` cold start with `readState/checkStatus/spawnDaemon` mocks and expects exactly one JSON stdout line.
- `src/cli/commands/proxy/__tests__/daemon-manager.test.ts`: `getCodemieHome` mocked to `tmpdir()`; `spawnDaemon` tests (:137+) use `spawnDetached` mock plus a file written into `tmpdir()/proxy-daemon.json`; their cleanup deletes only that file.
- `src/cli/commands/proxy/__tests__/index.test.ts` (mocks daemon-manager at :21-; start/restart/connect flows), `disconnect-orchestrator.test.ts` (per-connector `vi.doMock`, no daemon-manager or fs mock), `daemon-status-contract.test.ts`, `connect-wiring.test.ts`.
- `tests/integration/hook-stdout.test.ts:242-291`: real cold-start hook with a fresh `CODEMIE_HOME` containing only a global config; asserts the file log has `[daemon-manager] Spawning daemon` and `Starting proxy...\n`. With no `proxy-connection.json` seeded this scenario spawns nothing under the agreed design.
- `tests/integration/proxy-daemon-lifecycle.test.ts`: real `spawnDaemon` under a temp home.
- Unaffected by signature (mock `ensureOtlpProxy` through deps): `hook.analytics-wiring.test.ts`, the three OTLP plugin tests.

### Testing Framework and Patterns
Vitest, dynamic `await import` after `vi.mock`, `vi.doMock` + `vi.resetModules` in disconnect tests, `CODEMIE_HOME` temp dirs in integration tests. Tests only on explicit user request (AGENTS.md).

### Coverage Gaps
No test covers: `ConfigLoader.load` with an explicit name versus a different cwd local profile; a missing/unknown recorded profile; `proxy disconnect` interaction with daemon files; `verifySsoCredentials` outside `process.exit` paths.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_HOME` (`utils/paths.ts:367-373`) relocates all state files; `CODEMIE_DEBUG` affects hook log verbosity (`hook-stdout.test.ts`); `CODEMIE_BASE_URL/PROVIDER/MODEL/API_KEY/URL/AUTH_METHOD` are ignored by `ConfigLoader.load` when a name is given.

### Configuration Files
`~/.codemie/codemie-cli.config.json` (global profiles + `workspace`), `<cwd>/.codemie/codemie-cli.config.json` (local profiles + `workspace`), `~/.codemie/proxy-daemon.json` (live state). No `proxy-connection.json` or similar exists (searched `src`, `docs`).

### Feature Flags and Deployment Concerns
None for the daemon. Hooks are installed in `~/.claude/settings.json` etc. by `connect`; an install made before this change has no record.

---

## 6. Risk Indicators

- Speculative: users who ran `proxy connect` before the change have a hook wired but no record; with "missing record -> no daemon" their hooks stop auto-starting until they reconnect, and `connect` against an already-running matching daemon does not call `spawnDaemon` (see Task Statements), so reconnecting alone may not create the record.
- Speculative: `ConfigLoader.load(cwd, {name})` returns a normal-looking config for an unknown name (`baseUrl` undefined, `provider` 'openai') instead of throwing; the existing blank-`baseUrl` silent return would hide "profile no longer exists" unless detected separately (AC2 needs the profile name in the log). A local-only profile recorded from another directory is unresolvable from the hook's cwd (the record has no scope).
- Speculative: a same-named local profile in the hook's cwd overlays baseUrl/provider/model/apiKey and supplies `codeMieProject`; recording only the name leaves that part of the ticket's "different environment" in place; the recorded project would need to take precedence over `config.codeMieProject`.
- Speculative: record validation. `readState`-style reading casts without checking shape; an empty/undefined `profile` makes `ConfigLoader.load` fall back to the cwd profile, which is exactly the behavior to remove; `JSON.parse('null')` would throw on property access.
- Speculative: single record, many writers. `proxy start`/`restart` overwrite it with their own profile and `codemie-daemon`; a hook of one adapter can restart a daemon with another target's `clientType` (e.g. `vscode-byok`), changing plugin gating and `X-CodeMie-Client`, where today the hook uses its own agent name. For Claude Desktop the record would carry `telemetryMode` only, with `clientType` undefined.
- Speculative: `disconnect` semantics: it has one target per client, `--scope project` leaves other projects tracked, and Claude Desktop/VS Code have no disconnect; deleting the record on any disconnect would also disable cold start for still-connected adapters.
- Speculative: fixed `.tmp` suffix in the write convention can collide between concurrent hooks that both reach `spawnDaemon` (race itself out of scope); a throwing record write inside `spawnDaemon` would fail the spawn.
- Speculative: `verifySsoCredentials` is shared with `proxy start/restart` (`launch-daemon.ts:23`); any non-exiting variant must keep the `process.exit` behavior for those paths and the existing test spies; `console.error` must not be used in the hook variant.
- Speculative: AC2 "fail fast" is met only for missing/expired stored credentials; any other boot failure still costs the 5 s poll. The UserPromptSubmit SSO login flow still resolves the cwd profile (`claude-code-otlp.plugin.ts:445`, copilot plugins :210/:262), so it can log in to a different environment than the recorded profile.
- Test churn: exact-string assertions on `Starting proxy...` (3 unit, 1 integration regex), daemon-manager mock factories in two suites, and `hook-stdout.test.ts` cold-start cases.

---

## 7. Summary for Complexity Assessment

The change sits in the proxy command layer: `daemon-manager.ts` (new record constant, read/write helpers, write in `spawnDaemon`), `connect-orchestrator.ts` (`ensureOtlpProxy`, `ensureDaemon` message, `verifySsoCredentials` split), `disconnect-orchestrator.ts` (delete), plus `launch-daemon.ts` as a second `verifySsoCredentials` consumer. `spawnDaemon` has exactly two code paths calling it (`ensureDaemon`, `spawnForProfile`), five distinct identity shapes, and no other daemon spawn. `ConfigLoader` is read-only here but has several non-obvious behaviors with an explicit name (silent empty config for unknown names, same-named local overlay, cwd-derived workspace, throw on bad local config).

No technical novelty: the pattern to follow is the existing state-file I/O in `daemon-manager.ts`. The uncertainty is in semantics: when the record is written (not on connect against a matching daemon), single-record multi-writer identity, what `disconnect` should remove, upgrade behavior with no record, and project override.

Test posture: the touched code has unit coverage in `src/cli/commands/proxy/__tests__` and `OtlpAgentAdapter.test.ts`, and integration coverage in `tests/integration/hook-stdout.test.ts` and `proxy-daemon-lifecycle.test.ts`; several suites mock `daemon-manager` with closed factories and assert the exact `Starting proxy...` string, so they need updating. No existing tests cover explicit-name loading against a different cwd profile.

---

## 8. External References

None named by the task. (The task cites repository files only; all were read.)
