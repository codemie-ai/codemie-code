# EPMCDME-16321: hook restarts the proxy daemon on the wrong profile

## Problem

`codemie proxy connect --claude-code-otlp --profile <name>` starts one shared proxy daemon (port 4001). Once the daemon stops, the next OTLP hook restarts it through `ensureOtlpProxy()` (`src/cli/commands/proxy/connect-orchestrator.ts:450-491`). That function takes the profile from the hook's working directory, not from what the user connected. A session in a directory with a different `.codemie/` profile therefore brings the daemon back on another environment, credentials, project and analytics, and nothing tells the user. While the daemon cannot start, every hook also waits 5 s before failing (`daemon-manager.ts:133-143`). Since #755 missing or expired SSO credentials are no longer such a case: the daemon starts, holds its port with a listener that answers 401 ("run `codemie profile login`") and swaps the real proxy in once the user has signed in (`src/bin/proxy-daemon.ts`, `awaiting-login-listener.ts`).

Once the daemon is gone its identity is gone too: `proxy-daemon.json` is deleted on stop (`daemon-manager.ts:146-183`). The fix is to remember the identity of the last daemon start in a separate file and restart from it.

## Decisions

- New `~/.codemie/proxy-connection.json` over reusing `proxy-daemon.json`: the live-state file keeps its semantics and readers. The path is built the way `DEFAULT_STATE_FILE` is, `join(getCodemieHome(), 'proxy-connection.json')`, so both daemon files resolve alike and honour `CODEMIE_HOME`; the constant sits next to `DEFAULT_STATE_FILE`, and the record type (a subset of `DaemonState` plus `updatedAt`) is documented as "identity of the last daemon start" — user.
- The record holds identity only (profile, clientType, telemetryMode, updatedAt) over also storing URL, model, provider and project: no secrets, no project (security review of attribution sources), and profile edits apply at the next restart — user.
- One writer function builds the record from the daemon's state and is called after the daemon has come up, from `spawnDaemon` and from the matched-daemon branch of `ensureDaemon`, over writing from every caller or before readiness — user (the `spawnDaemon` write site); the post-readiness rule answers AR-2 — user, answers AR-2.
- A hook restart writes the record (via `spawnDaemon`). `proxy connect` and its matched-daemon refresh write it after at least one target succeeded, so a rolled-back connect (every target failed) leaves the record untouched — user, decision CR-004 (plan behaviour governs).
- `proxy start` and `proxy restart` write the record only when `--profile` was given or no record exists yet, over letting a profile taken from the current directory overwrite it. The rule is documented where it is implemented (`shouldWriteConnectionRecord` in `launch-daemon.ts`) and in the PR description.
- A hook restart restores the record as it is, and falls back to the hook's own agent name as clientType only when the record has neither clientType nor telemetryMode. "No identity" means clientType `codemie-daemon` outside Claude Desktop mode, decided once — user.
- The hook builds its spawn options and its "requested" identity from the recorded identity, so a sibling hook does not stop a healthy daemon over a label mismatch.
- A same-named local profile in the hook's directory is honoured (`ConfigLoader.load(cwd, { name })` as today), over loading the recorded profile with no directory read; the log line states the scope (global or local) it was loaded from — user, answers AR-1.
- A profile that exists only in a project's `.codemie/` is restarted by hooks only while they run inside that repository; elsewhere it is "not found" and nothing starts — user, answers AR-1.
- The project is not recorded. On hook cold start the daemon's project comes from the loaded config (`ConfigLoader.load(cwd, { name })`) as before this change, so the daemon-level project still depends on the repository where the hook ran (existing behaviour, unchanged) — user, decision CR-003.
- The record is never deleted, not by `proxy disconnect`, `proxy stop`, `checkStatus` or the daemon cleanup, over deleting it on disconnect — user. `disconnect-orchestrator.ts` is not touched.
- `proxy stop` keeps today's behaviour over adding an "explicit stop" marker: hooks keep restarting the daemon after a stop — user.
- A missing or malformed record with no live daemon makes the hook fall back to the working directory's profile exactly as before this change (same identity as before, only the credential warning is new), log a warn and let the successful start create the record, over starting nothing, so nothing silently stops working after an upgrade — user.
- A missing record with a live daemon is seeded from the live daemon's state (in the hook's alive branch and in `proxy start`'s early return), over leaving installs from before the fix without auto-start.
- The credential check before a spawn is a non-exiting variant of `verifySsoCredentials`; the exiting one becomes a thin wrapper so there is one credential lookup. The hook variant never calls `process.exit` and never writes to `console.*`; on the hook path its result is only logged (see the next decision) — user.
- The existence check requires the recorded name to be among the profiles of the scope used for the load and the loaded config name to equal it, over trusting `ConfigLoader` (an unknown name loads as an ordinary config, and a legacy global config answers "default" for any name).
- Any spawn failure is logged with the profile name before it propagates, over relying on the adapter's message-only log line.
- A failed record write never fails the spawn and is logged at warn.
- The file log with the profile name is enough for the user to find out, over adding a visible surface such as `codemie proxy status` — user, answers AR-5.
- Missing or expired SSO credentials do not stop a hook cold start: the hook warns with the profile name and still spawns on the recorded profile (or, with no record, on the working directory profile). The daemon holds the port and answers 401 until the user signs in, then recovers by itself (#755). This replaces the earlier fail-fast "start nothing", taken when the branch was rebased onto #755, because skipping the start would leave port 4001 and the endpoint in Claude Code's settings unprotected and the fail-fast no longer saves the 5 s wait — user. No back-off marker for other boot failures (AR-6).
- The cold start lives in `otlp-cold-start.ts` and keeps what #755 added to `ensureOtlpProxy`: it respawns on the port Claude Code's settings already point at (`readConfiguredOtlpPort`), else on the dead daemon's port, else on 4001, and re-points the endpoint (`refreshClaudeCodeOtlpEndpoint`) after a spawn and when it adopts a live daemon — #755, kept by the rebase.

## Behaviour

**Hook cold start** (`ensureOtlpProxy`), when no daemon is alive:
1. Read the record. If it is missing or malformed (not a JSON object, or profile not a non-empty string), the hook falls back to the working directory's profile as before this change (see the decision on a missing record): it logs one warn, `[ensureOtlpProxy] no recorded proxy connection; starting on the working directory's profile (profile: <name>)`, then runs the credential check and the spawn below, and the successful start creates the record. A missing file logs only that line; a malformed file is also warned by the reader (`Ignoring proxy-connection.json: ...`), so it logs two warn lines.
2. With a record, load the recorded profile by name and run the existence check above. If the profile is not found or has no base URL, start nothing and log the reason with the profile name and scope.
3. Run the non-exiting credential check. On a miss or expiry (expired credentials read as "not found"), log a warn with the profile name, the scope and the reason, and carry on: the daemon holds the port and answers 401 until the user signs in. The check never stops the start and never delays it.
4. Spawn with the recorded profile, clientType and telemetryMode, the loaded config's project and the restart port (Claude settings, else last daemon, else 4001). The success path logs the resolved scope (`global` or `local`). The `ensureDaemon` status line becomes `Starting proxy (profile: <name>)...`. After the spawn the Claude Code OTLP endpoint is re-pointed at the new daemon. A spawn failure is logged with the profile name.

When a daemon is alive and the record is missing, the hook writes the record from the live state and continues as today.

`OtlpAgentAdapter` already swallows `ensureOtlpProxy` errors (`OtlpAgentAdapter.ts:99-105`), so hooks stay non-blocking. In a hook the logger writes only to the file log, so nothing reaches the protocol stdout or stderr.

**Expired SSO in practice:** the hook warns and starts the daemon on the recorded profile; the daemon holds the port and answers 401 with the login command, so the hook returns without the 5 s wait. In the common case (session profile equals recorded profile) the prompt-time check (`ensureProxyAuth`, run after `ensureOtlpProxy` inside `evaluate`) asks the user to log in; after login the daemon swaps the real proxy in by itself (#755) and the earlier events are re-sent, because the cursor was not advanced.

**Consequence of never deleting:** the record outlives `proxy disconnect`. With no hooks wired nothing reads it, and if the recorded profile is later removed the hook starts nothing and logs the profile name.

## Acceptance criteria

1. After the daemon stops, a hook cold start restarts it with the recorded profile, whatever the hook's working directory, unless that directory defines a local profile of the same name. The log line says whether the global or the local profile was loaded.
2. If the recorded profile cannot be started (unknown profile, no base URL, spawn failure), no daemon is started on any other profile and the reason is logged with the profile name. Missing or expired SSO credentials are not such a case: a warning with the profile name is logged and the daemon starts on the recorded profile and holds the port until login (#755). Abnormal case: after PR #741 the prompt-time login check follows the session profile, so with a session profile different from the recorded one the user may log in to a profile that is not the one that failed.
3. The `Starting proxy` line written by `ensureDaemon` names the profile used.
4. `proxy connect` against an already-running matching daemon creates or refreshes the record once at least one target succeeded.
5. With no record and no live daemon, a hook falls back to the working directory's profile as before this change, logs one warn, and the successful start creates the record. With no record and a live daemon, the record is created from the live state.
6. `proxy start` and `proxy restart` change an existing record only when `--profile` was given; with a profile taken from the current directory they do not.
7. The hook path writes nothing to stdout or stderr and never calls `process.exit`.

## Non-goals

- The concurrent-hooks stop-and-respawn race in `ensureDaemon`.
- An "explicit stop" marker: hooks keep restarting the daemon after `proxy stop`.
- Deleting the record anywhere, or any change to `disconnect-orchestrator.ts`.
- Changing `proxy-daemon.json` semantics or its readers.
- Any message to the user inside the hook session when the recorded profile cannot start; a follow-up ticket owns it.
- The prompt-time SSO login check (`ensureProxyAuth`) in the three OTLP plugins, which open PR #741 (EPMCDME-16308) covers.
- A back-off marker or fail-fast for boot failures where the daemon process exits during startup; a follow-up ticket owns it.
- Recording the port or gateway key, or updating the record on `profile rename`.

## Open risks

- Users whose daemon is already down at upgrade time have no record, so the first hook falls back to the working directory's profile and creates the record from that start; if that profile is not the one they connected, the first start after an upgrade can still pick the working directory's profile until they re-run `proxy connect`. Users with a running daemon are covered by seeding.
- Because a same-named local profile is honoured, the repository's URL, model and `.env` settings can still reach the restarted daemon when the hook runs in that repository; the log shows the scope.
- A project-local-only recorded profile is "not found" from any other directory, so analytics stop for hooks outside that repository.
- Session profile and recorded profile can differ (after PR #741), so the login prompt may name another profile than the one that failed.
- Boot failures where the daemon process exits during startup still cost 5 s per hook; missing or expired SSO credentials are not one of them since #755. A busy port 4001 is not one either: the daemon falls back to a random free port (`sso.proxy.ts:194-211`, comment in `src/bin/proxy-daemon.ts:145-147`) and hooks use the URL in `proxy-daemon.json`. Only clients bound to `127.0.0.1:4001`, such as Claude Desktop, miss that daemon.
- The record holds no port: a restart uses the port in Claude Code's settings, else the last daemon's, else 4001, so an unrecorded daemon on another port can come back on 4001. A profile renamed later leaves a dangling name, which the hook logs.
- Test and doc churn: the three exact `Starting proxy...` unit assertions and the `hook-stdout` regex, the closed `daemon-manager` mock factories in three suites, a seeded record in the `hook-stdout` cold-start scenario, and the cold-start note in `docs/ARCHITECTURE-OTLP-PLUGIN.md`.
