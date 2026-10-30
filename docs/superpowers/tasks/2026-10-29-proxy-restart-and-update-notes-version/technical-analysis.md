# Technical Research

**Task**: proxy daemon cli update-notes changelog
**Generated**: 2026-10-29
**Research path**: codegraph

---

## 1. Original Context

Two related CLI fixes in codemie-code. (1) `codemie proxy restart` fails with "error: unknown command 'restart' (Did you mean start?)" — add a proper `restart` subcommand to `codemie proxy` (stop the running proxy daemon if any, then start it again). (2) The post-update banner says "✨ Updated to 0.16.2 — here's what changed:" but then prints "## What's new in 0.15.1 (2026-09-08)" notes — the release-notes/changelog shown after an update must match the installed version (show the notes for the version actually updated to, or the range of versions between previous and current), not a stale 0.15.1 entry. Also observed: the banner fires repeatedly on every session start / user prompt hook (SessionStart and UserPromptSubmit hooks print it each time) and sometimes says 0.16.0 vs 0.16.2 in the same session — so the "already shown" marker and the version source are suspect.

---

## 2. Codebase Findings

### Existing Implementations

**Proxy CLI (fix 1)**
- `src/cli/commands/proxy/index.ts` — `createProxyCommand()` registers `start` (L130-188), `stop` (L191-202), `status` (L205-298), `connect`, `disconnect`, `inspect`. No `restart` subcommand exists. `start` loads `ConfigLoader.load(cwd, {name: opts.profile})`, builds `RequestedDaemonConfig` with `clientType: 'codemie-daemon'`, returns early if a matching daemon runs, throws `ConfigurationError(formatDaemonConflict(state))` if a non-matching one runs, then `verifySsoCredentials`, skill sync, `spawnDaemon(...)`. Errors go through `printProxyError(error, 'Failed to start proxy')`. `stop` = `checkStatus()` then `stopDaemon()`.
- `src/cli/commands/proxy/daemon-manager.ts` — `DaemonState` (pid, port, url, profile, gatewayKey, telemetryMode, targetUrl, provider, project, model, clientType, syncApiUrl, syncCodeMieUrl, startedAt, health fields); `readState`/`writeState`/`clearState`/`checkStatus`; `spawnDaemon(opts: SpawnOptions)` (detached spawn of `bin/proxy-daemon.js`, polls 5 s for state file); `stopDaemon()` (SIGTERM, 5 s wait, SIGKILL escalation, always clears state). State file: `getCodemieHome()/proxy-daemon.json`.
- `src/cli/commands/proxy/connect-orchestrator.ts` — `ensureDaemon()` (L393-450) already implements stop-then-spawn ("Restarting proxy to match the requested client...", `--force` path "Forcing a fresh proxy restart..."); `daemonMatchesRequest()`, `getEffectiveClientType()`, `normalizeDaemonModel()`; `ensureOtlpProxy()` cold-starts the daemon from hooks with `clientType: agentName`.
- `src/bin/proxy-daemon.ts` — daemon entry; has an internal in-process `restartProxy()` used by `ProxyWatcher` (not exposed via CLI). Reads version from `package.json` relative to itself.

**Update banner / release notes (fix 2)**
- `bin/codemie.js` L46-86 — startup notice. Logic: `currentVersion` from `../package.json` of the executing install; `lastSeen = getLastSeenVersion()`; null → `markVersionSeen` silently; `lastSeen !== currentVersion` → `getReleaseNotes(currentVersion)`, print `✨ Updated to ${currentVersion} — here's what changed:`, `renderReleaseNotes(entries, {maxItems: 6})`, `markVersionSeen(currentVersion)`. Gate: `!isTestEnvironment && isInteractiveTerminal && !hasOutputContractArg`, where `isInteractiveTerminal = process.stdout.isTTY !== false` (comment: "undefined -> treat as TTY"). Skip args: `--version`, `-V`, `--task`, `--help` only.
- `src/utils/whatsnew.ts` — `parseChangelog`, `getChangelogPath` (`../../CHANGELOG.md` from module), `getReleaseNotes(version?)`: exact match, else **falls back to the newest non-Unreleased entry** (L129-136); `getLastSeenVersion`/`markVersionSeen` on `getCodemiePath('.last-seen-version')` (single plain-text version string, overwritten); `renderReleaseNotes`; `isWhatsNewEnabled()` = `isTipsEnabled()`.
- `src/cli/commands/whatsnew.ts` — `codemie whatsnew [version] [--all]`, uses same `getReleaseNotes` (so also falls back silently).
- `CHANGELOG.md` — headings present: `[Unreleased]`, `[0.15.1] - 2026-09-08`, `[0.15.0]`, `[0.14.1]`, `[0.14.0]`. No 0.16.x headings; `package.json` version is `0.16.2`; `CHANGELOG.md` is in `package.json:files`.
- `scripts/release.sh` L135-139 — only a non-blocking warning when `## [$VERSION]` is missing.

**Hook invocation path**
- `src/cli/commands/proxy/connectors/claude-code-otlp.ts` — `HOOK_EVENTS` includes `SessionStart`, `UserPromptSubmit`, etc.; hook command written as plain `codemie hook --agent claude-code-otlp` (L585), resolved via whatever `codemie` is first on Claude Code's PATH. These invocations go through `bin/codemie.js`, so the banner block runs for every hook call.

### Architecture and Layers Affected
- CLI layer: `src/cli/commands/proxy/index.ts` (commander subcommands).
- Utility/daemon-lifecycle layer: `daemon-manager.ts`, `connect-orchestrator.ts`.
- Bin entry: `bin/codemie.js` (startup notice, pre-CLI).
- Utility: `src/utils/whatsnew.ts`; data: `CHANGELOG.md`.

### Integration Points
- Daemon state file `~/.codemie/proxy-daemon.json` shared by `start`/`stop`/`status`/`connect`/hooks (`ensureOtlpProxy`).
- Claude Desktop daemons are started via `connect --claude-desktop` with `telemetryMode: 'claude-desktop'` / clientType `claude-desktop`; OTLP hook daemons with clientType = agent name; `proxy start` with `codemie-daemon`.
- Marker `~/.codemie/.last-seen-version` (honours `CODEMIE_HOME`) is shared by every installed `codemie` that uses the same home.

### Patterns and Conventions
- Commander subcommand per action with `.description()`, `try/catch` → `printProxyError`; `chalk.green('✓ ...')` success lines.
- Project error classes (`ConfigurationError`, `ToolExecutionError`), `logger.debug`, `sanitizeLogArgs`.
- whatsnew module must stay importable from bin (no commander/CLI deps — module header comment).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/integration/exposed-api.md` (CLI surface), `.ai-run/guides/testing/testing-patterns.md` exist. No guide covers whatsnew or proxy lifecycle specifically.
- `docs/COMMANDS.md` L86-88 and `README.md` L732-734 list `proxy start|stop|status` (no `restart`).
- `docs/ARCHITECTURE-PROXY.md` covers daemon spawn flow (L1127).

### Architectural Decisions
- whatsnew.ts header: notice shows "the current version's notes once"; fallback documented as intentional ("so the once-per-upgrade notice always has something to show").
- `bin/codemie.js` comment: notice skipped for "scripted/piped use (stdout not a TTY)" — but the code treats `isTTY === undefined` (the piped case in Node) as TTY.

### Derived Conventions
- `--force` in `connect` is the existing user-facing "restart" semantic.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/proxy/__tests__/index.test.ts` — `proxy start`, `proxy status`, `connect desktop/vscode` with mocked `daemon-manager.js` (`checkStatus`, `readState`, `spawnDaemon`, `stopDaemon`), `ConfigLoader`, connectors. No `stop`/`restart` tests.
- `__tests__/daemon-manager.test.ts`, `daemon-status-contract.test.ts`, `connect-orchestrator.test.ts`, `watcher.test.ts`, `health-check.test.ts`.

### Testing Framework and Patterns
- Vitest, `vi.mock` module mocks before dynamic import (see index.test.ts L7-60).

### Coverage Gaps
- No tests for `src/utils/whatsnew.ts`, `src/cli/commands/whatsnew.ts`, or the `bin/codemie.js` notice block (glob for `*whatsnew*` tests returned nothing).
- `stopDaemon` / `ensureDaemon` flagged by codegraph as having no direct covering tests.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_TIPS=false|0|no` — disables notice (`isTipsEnabled`).
- `CODEMIE_HOME` — relocates marker and daemon state.
- `NODE_ENV=test` / `VITEST=true` — skip notice and update check.
- `CODEMIE_AUTO_UPDATE` — update check behaviour (`checkAndPromptForUpdate`).

### Configuration Files
- `~/.codemie/.last-seen-version`, `~/.codemie/proxy-daemon.json`, `CHANGELOG.md`, `~/.claude/settings.json` (hook commands).

### Feature Flags and Deployment Concerns
- `CHANGELOG.md` ships in the npm package; release script does not block on a missing version section.

---

## 6. Risk Indicators

- Root cause (stale notes): `getReleaseNotes()` fallback in `src/utils/whatsnew.ts` L129-136 + `CHANGELOG.md` has no `0.16.x` section → 0.16.2 renders the 0.15.1 entry under an "Updated to 0.16.2" header. The same fallback affects `codemie whatsnew`.
- Root cause candidate (repeat banner in hooks): `bin/codemie.js` L52 `process.stdout.isTTY !== false` — Node sets `isTTY` to `undefined` for pipes, so hook subprocesses (piped stdout) are treated as interactive. `hook` is not in `skipNoticeArgs`. Hook stdout is consumed by Claude Code (SessionStart / UserPromptSubmit stdout is injected as context), so this also pollutes hook output.
- Root cause candidate (0.16.0 vs 0.16.2, repeated firing): hooks invoke bare `codemie` from Claude Code's PATH, which may resolve to a different install (e.g. another nvm/node prefix at 0.16.0) than the user's shell (0.16.2). Both share one `.last-seen-version` file holding a single version string, so alternating invocations flip-flop the marker and each one sees `lastSeen !== currentVersion`. Not verified against the user's machine.
- Speculative: a "range between previous and current" rendering would need version comparison (`src/utils/version-utils.ts` has `compareVersions`/`parseSemanticVersion`) and a decision on downgrade behaviour (marker flip-flop case).
- Speculative: a naive `restart` that reuses the `start` action would always spawn with `clientType: 'codemie-daemon'` and current-profile config, silently dropping a running daemon's `telemetryMode: 'claude-desktop'` / OTLP `clientType` / port from `DaemonState`; the `start` conflict check would also throw if the running daemon was started by `connect`. Whether restart preserves the prior state's identity is a spec decision.
- `proxy-daemon.ts` port pinning: restarting releases 4001; a different port after restart would break Claude Desktop / VS Code configs that hard-code the URL.
- No unit tests for whatsnew logic or bin notice block.
- Docs (`docs/COMMANDS.md`, `README.md`) enumerate proxy subcommands.

---

## 7. Summary for Complexity Assessment

The task touches two independent, small surfaces. Fix 1 is in the CLI layer: `src/cli/commands/proxy/index.ts` lacks a `restart` subcommand, while all building blocks exist (`checkStatus`, `stopDaemon`, `spawnDaemon` in `daemon-manager.ts`, and an existing stop-then-spawn flow in `connect-orchestrator.ts:ensureDaemon`). The only design question is what identity a restart re-spawns with (the running daemon's recorded `DaemonState` vs. the `start` defaults), since daemons started by `connect --claude-desktop` or by OTLP hooks carry a different clientType/telemetryMode.

Fix 2 lives in `bin/codemie.js` (notice block) and `src/utils/whatsnew.ts`. Three concrete defects are visible in code: (a) `getReleaseNotes()` silently falls back to the newest entry (0.15.1) when the exact version is missing, and `CHANGELOG.md` has no 0.16.x sections; (b) the TTY gate `process.stdout.isTTY !== false` treats piped stdout (hooks) as interactive, and `hook` invocations are not excluded, so the banner prints in SessionStart/UserPromptSubmit hooks; (c) a single-value `.last-seen-version` shared by multiple installs on different PATHs can flip-flop, explaining repeated banners and mixed 0.16.0/0.16.2 labels. No novel patterns; changes are confined to roughly 3-5 source files plus optional CHANGELOG/doc updates.

Test posture: proxy command has a mocked Vitest suite (`__tests__/index.test.ts`) that extends naturally; whatsnew and the bin notice block have zero tests. Key risks are restart identity preservation/port stability and choosing range-vs-exact release-note semantics including downgrade handling.

---

## 8. External References

None named by the task.
