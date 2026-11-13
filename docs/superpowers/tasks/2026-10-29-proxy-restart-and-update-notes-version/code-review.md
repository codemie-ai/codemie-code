---
schema: sdlc-factory/code-review@1
decision: approve
reviewed_head: 0094c04734ff0032ffe7e7a8048c89bc6c2a61ee
---

# Code review — 2026-10-29-proxy-restart-and-update-notes-version

**Decision:** approve (check round, confidence final low · check high)  
**Reviewed head:** `0094c04` · **Rounds:** final → check

**Closed:** 7 fixed · 0 moot · 1 decided

Targeted re-check: all 8 prior blocking findings resolved (7 code findings verified against current source, CR-006 resolved by the mapped user decision to keep attribution from recorded daemon state; the PR should flag it as a reviewed CRITICAL attribution change). business_review and standards_review are carried forward from the final round, so its code-quality/security partial rows reflect the pre-fix state; the deferred item was not re-checked.

## Open — 0

## Decided — 1

- **CR-006** · Attribution values sourced from daemon state — `src/cli/commands/proxy/index.ts:259` — **User signs off: keep inheriting project/client attribution from the running daemon's recorded state; no code change needed for CR-006.** Restart is meant to keep the running daemon's identity, attribution included. The user, as owner, accepted taking X-CodeMie-Project/X-CodeMie-Client from the recorded daemon state. A --profile switch still takes project from the new profile config. The PR should call out the attribution source as a reviewed CRITICAL change.

## Pre-existing (not blocking) — 1

- **Output-contract args matched by exact string only** — `src/utils/whatsnew.ts:237` — `OUTPUT_CONTRACT_ARGS` is an exact-string `Set`, so `--task=foo`, `-h` and the `help` subcommand are not skipped and the upgrade notice can print ahead of scripted `--task=` output. Pre-existing: the previous `bin/codemie.js` `skipNoticeArgs` used the identical exact-match set; this change only moved it.

## Coverage

Graded at the final round; the check round re-verified the findings, not these rows — Open and Closed above are current.

| Acceptance criterion | Status | Notes |
|---|---|---|
| Add `restart` subcommand to createProxyCommand following existing pattern (.description, try/catch -> printProxyError 'Failed to restart proxy', chalk.green ✓ l | pass | src/cli/commands/proxy/index.ts restart hunk (+218..+277): .description, printProxyError(error, 'Failed to restart proxy'), chalk.green('✓ Proxy restarted at ...') |
| Running daemon: read DaemonState, stopDaemon(), respawn with same profile, clientType, telemetryMode and port | pass | checkStatus() state -> stopDaemon() -> launchDaemon with port/clientType/telemetryMode/gatewayKey/model from state; test 're-spawns a running daemon with its recorded identity' |
| Restart works regardless of how the daemon was started (proxy start, connect, OTLP hook cold-start) | pass | restart reads clientType from state and applies no client-type check; test 'keeps the client type of a hook-started daemon' |
| Restart must not be rejected by start's conflict check (formatDaemonConflict) | pass | restart path never calls daemonMatchesRequest/formatDaemonConflict; test asserts no 'already running with different settings' |
| --profile <name> replaces only the profile; config reloaded via ConfigLoader.load(cwd, {name}); clientType, telemetryMode, port kept | pass | ConfigLoader.load(process.cwd(), { name: opts.profile ?? state.profile }); identity fields still from state; project taken from the new profile config; test 'switches only the profile' |
| Nothing running: behave exactly like proxy start (current profile, clientType codemie-daemon, default port) | pass | !running branch: ConfigLoader.load(cwd, profile?), port DEFAULT_DAEMON_PORT, clientType 'codemie-daemon' via shared launchDaemon; test 'behaves like start when the recorded daemon is not running' |
| Verify SSO credentials and sync skills before spawning, as start does | pass | launchDaemon (shared with start) runs verifySsoCredentials + syncRegisteredSkills/syncPluginSkills before spawnDaemon; this runs after stopDaemon, so a credential failure leaves no daemon running |
| Port stability: restarted daemon must come back on the recorded port; otherwise fail with a clear error and do not move ports | pass | port passed as state.port; sso.proxy.ts falls back to a random port on EADDRINUSE without pinnedPort, and restart detects daemonState.port !== state.port, stops it, throws ToolExecutionError naming th |
| Docs: add restart to docs/COMMANDS.md and README.md | pass | docs/COMMANDS.md:88 and README.md:734 add `codemie proxy restart [--profile <name>]` |
| Banner prints only when process.stdout.isTTY === true; never when piped/undefined | pass | shouldRunUpgradeNotice returns false unless isTTY === true; bin/codemie.js passes process.stdout.isTTY; unit tests cover undefined/false |
| Banner never prints when the command is `hook` | pass | shouldRunUpgradeNotice: first non-option arg !== 'hook'; tests cover 'hook' and '--debug hook' |
| Existing gates kept: test environment, --version/-V/--task/--help, CODEMIE_TIPS | pass | bin keeps !isTestEnvironment; OUTPUT_CONTRACT_ARGS in whatsnew.ts; showUpgradeNotice checks isWhatsNewEnabled() |
| Marker: none -> record silently; newer -> banner then write; equal -> nothing; older -> no banner, no write | pass | decideUpgradeNotice + showUpgradeNotice in src/utils/whatsnew.ts; tests for record-silently/show/none and older-install marker preservation |
| Compare with version-utils (compareVersions/parseSemanticVersion); unparseable marker counts as no marker | pass | imports compareVersions, isValidSemanticVersion (wraps parseSemanticVersion); 'garbage' marker -> record-silently, tested |
| Header `✨ Updated to <installed>` | pass | console.log(chalk.dim(`✨ Updated to ${installed}`)) in showUpgradeNotice |
| Notes: every version > last-seen and <= installed, newest first, max 3 versions, maxItems 6 each, pointer to `codemie whatsnew --all` when more | pass | selectUpgradeEntries filters/sorts/slices MAX_NOTICE_VERSIONS=3; renderReleaseNotes maxItems MAX_NOTICE_ITEMS=6; hasMore prints the --all pointer |
| Installed version without CHANGELOG section: only header plus pointer; never other versions' notes | pass | selectUpgradeEntries returns shown [] with hasMore true when installed is missing; test 'shows only the header and the pointer' |
| `codemie whatsnew <version>` missing from CHANGELOG reports 'no release notes for <version>', no fallback | pass | getReleaseNotes fallback removed; whatsnew.ts prints 'No release notes for ${targetVersion} in CHANGELOG.md.'; test for 9.9.9 |
| whatsnew.ts module stays importable from bin without commander dependencies | pass | src/utils/whatsnew.ts adds only ./version-utils.js import; bin imports ../dist/utils/whatsnew.js |
| Add CHANGELOG sections for 0.16.0, 0.16.1, 0.16.2 written from commits between release tags | pass | CHANGELOG.md adds ## [0.16.2], [0.16.1], [0.16.0]; that the content matches the commits between tags cannot be checked from the diff; the 'Tips also surface after codemie doctor...' bullet was removed |
| scripts/release.sh fails non-zero when `## [$VERSION]` is missing | pass | scripts/release.sh:139 adds `exit 1` after the error message |
| Non-goals respected (no hook PATH/settings rewrite, no marker format change, no proxy-daemon.ts restartProxy change, no connect restart semantics, no auto CHANG | pass | changed_files touch none of those areas; marker read/write still uses getLastSeenVersion/markVersionSeen; --all path (targetVersion undefined) skips the new branch |
| AC1: restart with running daemon stops and restarts with same profile, clientType, telemetryMode, port | pass | restart running branch in proxy/index.ts; covered by proxy restart unit test |
| AC2: restart --profile X uses profile X, keeps clientType, telemetryMode, port | pass | covered by test 'switches only the profile when --profile is given' |
| AC3: restart with no daemon behaves like proxy start | pass | !running branch mirrors start defaults; covered by test |
| AC4: restarting a connect- or hook-started daemon succeeds with no conflict error | pass | no conflict check in restart; tests with claude-desktop and claude-code-otlp client types |
| AC5: recorded port cannot be rebound -> clear error, no port move | pass | port mismatch -> stopDaemon + ToolExecutionError naming the port; test 'stops the new daemon and fails...' |
| AC6: banner never prints for `codemie hook ...` or non-TTY stdout | pass | shouldRunUpgradeNotice gate in bin/codemie.js; unit tests |
| AC7: banner never shows notes outside installed / (last-seen, installed] range | pass | selectUpgradeEntries range filter plus missing-installed guard; no-fallback getReleaseNotes |
| AC8: last-seen 0.15.1, installed 0.16.2 -> lists 0.16.2, 0.16.1, 0.16.0 newest first, capped at 3 | pass | selectUpgradeEntries tests for range and cap; showUpgradeNotice range test |
| AC9: installed has no CHANGELOG section -> only 'Updated to X' and --all pointer | pass | covered by showUpgradeNotice test asserting header + pointer and no 0.15.1 notes |
| AC10: older install after newer shows no banner and leaves marker unchanged | pass | decideUpgradeNotice returns 'none' for a downgrade; test confirms the marker stays 0.16.2 |
| AC11: same version again shows no banner | pass | compareVersions(...) > 0 required for 'show'; test for equal versions |
| AC12: `codemie whatsnew 9.9.9` reports 'no release notes for 9.9.9' | pass | src/cli/commands/whatsnew.ts new branch; src/cli/commands/__tests__/whatsnew.test.ts |
| AC13: CHANGELOG.md has sections for 0.16.0, 0.16.1, 0.16.2 | pass | CHANGELOG.md hunk adds all three headings |
| AC14: scripts/release.sh exits non-zero when release version has no CHANGELOG section | pass | scripts/release.sh `exit 1` in the missing-section branch |
| AC15: docs/COMMANDS.md and README.md list `proxy restart` | pass | both docs hunks add the restart line |

Standards: commit-format pass · code-quality partial (final round) · security partial (final round)
