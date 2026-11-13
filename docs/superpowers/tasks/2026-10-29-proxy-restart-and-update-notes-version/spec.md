# Spec: `codemie proxy restart` and version-accurate update notes

## Intent

The user asked for "proper fix with version, and restart command". There are two problems:

1. `codemie proxy restart` fails with "unknown command 'restart'".
2. After updating to 0.16.2, the banner shows the 0.15.1 notes. It also fires on every SessionStart / UserPromptSubmit hook, and in one session it alternates between 0.16.0 and 0.16.2.

Root causes, from `technical-analysis.md`:
- The banner and `codemie whatsnew` share `getReleaseNotes()`, which falls back silently to the newest entry (`src/utils/whatsnew.ts:129-136`). `CHANGELOG.md` has no 0.16.x sections.
- The TTY gate in `bin/codemie.js:52` (`isTTY !== false`) treats piped stdout as interactive, and `hook` is not in the skip list.
- All installs share one `.last-seen-version` value. When two installs at different versions both run, they keep overwriting it.

## Part 1: `codemie proxy restart`

- Add a `restart` subcommand to `createProxyCommand()` (`src/cli/commands/proxy/index.ts`). Follow the existing pattern: `.description()`, `try/catch` → `printProxyError(error, 'Failed to restart proxy')`, and a `chalk.green('✓ ...')` success line.
- **A daemon is running:** read its `DaemonState` (`daemon-manager.ts`) and stop it with `stopDaemon()`. Spawn it again with the same identity: profile, clientType, telemetryMode and port. The restart works whichever way the daemon was started: `proxy start`, `connect --claude-desktop`/vscode, or an OTLP hook cold-start. Restart replaces the daemon on purpose, so `start`'s conflict check (`formatDaemonConflict`) must not reject it.
- **`--profile <name>`** replaces only the profile. Config is reloaded from that profile (`ConfigLoader.load(cwd, {name})`). clientType, telemetryMode and port stay as recorded.
- **Nothing is running:** behave exactly like `proxy start`: current profile, clientType `codemie-daemon`, default port.
- Before spawning, verify SSO credentials and sync skills, the same way `start` does.
- Port stability: the restarted daemon must come back on the recorded port. If it cannot, the command fails with a clear error and does not move to another port, because Desktop and VS Code configs point at that URL.
- Prior art: `connect-orchestrator.ts:393-450` (`ensureDaemon` stop-then-spawn).
- Docs: add `restart` to `docs/COMMANDS.md:86-88` and `README.md:732-734`.

## Part 2: Update banner and release notes

**When the banner runs** (`bin/codemie.js:46-86`):
- It prints only when `process.stdout.isTTY === true`. It never prints when stdout is piped or undefined.
- It never prints when the command is `hook`.
- Every other existing gate stays: the test environment, `--version`/`-V`/`--task`/`--help`, and `CODEMIE_TIPS`.

**Forward-only marker:**
- No marker yet: record the version silently (unchanged from today).
- Installed version newer than last-seen: show the banner, then write the installed version.
- Installed version equal to last-seen: do nothing.
- Installed version older than last-seen: no banner and no write.
- Compare versions with `src/utils/version-utils.ts` (`compareVersions` / `parseSemanticVersion`). An unparseable marker counts as "no marker".

**What the banner shows:**
- Header: `✨ Updated to <installed>`.
- Notes: every CHANGELOG version above last-seen and up to the installed version, newest first. At most 3 versions, each rendered with the existing `maxItems: 6`. If there are more, print a pointer to `codemie whatsnew --all`.
- If the installed version has no CHANGELOG section, print only `✨ Updated to <installed>` plus the pointer to `codemie whatsnew --all`. Notes from any other version are never shown under this header.

**`codemie whatsnew [version]`** (`src/cli/commands/whatsnew.ts`):
- If an explicit version is missing from the CHANGELOG, report "no release notes for <version>". Do not fall back to another version.
- The `whatsnew.ts` module stays importable from bin, with no commander dependencies.

**Release hygiene:**
- Add `CHANGELOG.md` sections for 0.16.0, 0.16.1 and 0.16.2. Write them from the commits between the matching release tags.
- `scripts/release.sh:135-139` must fail (non-zero exit) when `## [$VERSION]` is missing. Today it only warns.

## Acceptance criteria

1. AC1: `codemie proxy restart` with a running daemon stops it and starts it again with the same profile, clientType, telemetryMode and port.
2. AC2: `codemie proxy restart --profile X` restarts with profile X and keeps the recorded clientType, telemetryMode and port.
3. AC3: `codemie proxy restart` with no daemon running behaves like `codemie proxy start`.
4. AC4: Restarting a daemon started by `connect` or by a hook succeeds; there is no conflict error.
5. AC5: If the recorded port cannot be rebound, restart fails with a clear error and does not move to another port.
6. AC6: The banner never prints for `codemie hook ...`, and never prints when stdout is not a TTY.
7. AC7: The banner never shows notes from a version other than the installed one or the versions between last-seen and installed.
8. AC8: With last-seen 0.15.1 and installed 0.16.2, the banner lists 0.16.2, 0.16.1 and 0.16.0, newest first, capped at 3 versions.
9. AC9: If the installed version has no CHANGELOG section, only "Updated to X" and the pointer to `codemie whatsnew --all` are printed.
10. AC10: Running an older install after a newer one shows no banner and leaves the marker unchanged.
11. AC11: Running the same version again shows no banner.
12. AC12: `codemie whatsnew 9.9.9` reports "no release notes for 9.9.9".
13. AC13: CHANGELOG.md has sections for 0.16.0, 0.16.1 and 0.16.2.
14. AC14: `scripts/release.sh` exits non-zero when the release version has no CHANGELOG section.
15. AC15: `docs/COMMANDS.md` and `README.md` list `proxy restart`.

## Non-goals

- Changing how hooks resolve `codemie` on PATH, or rewriting hook commands in `~/.claude/settings.json`.
- Per-install markers, or any other change to the marker's storage format or location.
- Changing in-process `restartProxy()` / `ProxyWatcher` in `src/bin/proxy-daemon.ts`.
- Adding restart semantics to `connect` (its `--force` stays as it is).
- Automatic CHANGELOG generation.
- Changing the behaviour of `codemie whatsnew --all`.
- Changing the update check (`checkAndPromptForUpdate`, `CODEMIE_AUTO_UPDATE`).

## Left to the builder

- Whether to pass the recorded port and identity through `SpawnOptions` or a small helper in `daemon-manager.ts`.
- How to choose and order the range of CHANGELOG entries (a helper in `whatsnew.ts`).
- The exact wording of the pointer and error messages.
