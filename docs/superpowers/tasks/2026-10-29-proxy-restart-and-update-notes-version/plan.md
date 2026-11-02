# Proxy Restart and Version-Accurate Update Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `codemie proxy restart`, which keeps the daemon's identity, and make the post-update banner show only the installed version's notes (or the notes between last-seen and installed). The banner moves forward only and never prints in hooks or when stdout is not a TTY.

**Architecture:** The banner's decisions become pure, dependency-free helpers in `src/utils/whatsnew.ts` that `bin/codemie.js` calls, so they can be tested. `restart` reuses `start`'s launch sequence and takes spawn options from the recorded `DaemonState`.

**Tech Stack:** TypeScript ESM, commander, Vitest, bash.

**Spec:** `docs/superpowers/tasks/2026-10-29-proxy-restart-and-update-notes-version/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- `whatsnew.ts` stays importable from bin. It must not depend on commander or the CLI layer. `version-utils.ts` has no dependencies, so it is safe to import.
- Marker storage format and location stay unchanged (`.last-seen-version`, a single plain string).
- Do not touch `src/bin/proxy-daemon.ts`, `connect --force`, `checkAndPromptForUpdate`, hook command resolution, or `whatsnew --all` behaviour.
- The banner renders each entry with `maxItems: 6`, shows at most 3 versions, and points to `codemie whatsnew --all`.

## Review Focus

1. `codemie --debug hook ...`: a global option comes before `hook`. The gate must test the first positional argument, not `argv[0]`. Test it in Task 2.
2. A marker like `garbage` or `0.17.0-beta.1` cannot be parsed. Treat it as "no marker": record silently and show no banner. Test it in Task 2.
3. A CHANGELOG `[Unreleased]` heading, or any other heading that is not semver, is never selected for the range. Test it in Task 2.
4. The daemon state file exists but the process is dead (`checkStatus().running === false`). Restart then behaves like `start` and does not use the stale identity. Test it in Task 4.
5. The restarted daemon falls back to a random port. The new daemon must be stopped, not left orphaned. Test it in Task 4.

---

### Task 1: Exact-only release notes and `whatsnew <version>` miss message

**Files:**
- Modify: `src/utils/whatsnew.ts:98-142`. Remove the fallback at L129-136 and update the JSDoc.
- Modify: `src/cli/commands/whatsnew.ts:23-33`
- Test: `src/utils/__tests__/whatsnew.test.ts` (new), `src/cli/commands/__tests__/whatsnew.test.ts` (new)

**Interfaces:**
- Produces: `getReleaseNotes(version?: string): ReleaseEntry[]`. Called with a version, it returns only exact matches, or `[]` when none match. Called without one, it returns every entry (unchanged).

- [ ] **Step 1: Write failing tests.** Mock `getChangelogPath` so it reads a fixture with `[Unreleased]`, `[0.16.2]` and `[0.15.1]`. Then:
  - `getReleaseNotes('9.9.9')` returns `[]`.
  - `getReleaseNotes('0.16.2')[0].version === '0.16.2'`.
  - `codemie whatsnew 9.9.9` logs a line containing `no release notes for 9.9.9`.
  - `whatsnew --all` still renders every entry.
- [ ] **Step 2: Run `npx vitest run src/utils/__tests__/whatsnew.test.ts src/cli/commands/__tests__/whatsnew.test.ts`.** Expected: FAIL. The fallback returns 0.16.2 or the newest entry.
- [ ] **Step 3: Implement.** Delete the fallback. In the command, empty entries print `No release notes for <version>` when a version was targeted. Keep the existing "CHANGELOG.md is missing" message for `--all` or when the changelog is absent.
- [ ] **Step 4: Re-run.** Expected: PASS.

Test-first: yes — `getReleaseNotes('9.9.9')` returns `[]`, and `whatsnew 9.9.9` prints "no release notes for 9.9.9".

### Task 2: Forward-only upgrade notice with version range and TTY/hook gate

**Files:**
- Modify: `src/utils/whatsnew.ts`. Add the helpers below and update the header comment at L7-9.
- Modify: `bin/codemie.js:46-86`. Replace the inline logic with the helpers.
- Test: `src/utils/__tests__/whatsnew.test.ts`

**Interfaces:**
- Consumes: Task 1's `getReleaseNotes()`, plus `compareVersions` and `isValidSemanticVersion` from `./version-utils.js`.
- Produces:
```ts
export type UpgradeNoticeAction = 'record-silently' | 'show' | 'none';
export function decideUpgradeNotice(installed: string, lastSeen: string | null): UpgradeNoticeAction;
export function selectUpgradeEntries(entries: ReleaseEntry[], lastSeen: string, installed: string): { shown: ReleaseEntry[]; hasMore: boolean };
export function shouldRunUpgradeNotice(argv: string[], isTTY: boolean | undefined): boolean;
export function showUpgradeNotice(installed: string): void; // never throws
```

- [ ] **Step 1: Write failing tests.**
  - `decideUpgradeNotice`:
    - `('0.16.2', null)` and `('0.16.2', 'garbage')` return `'record-silently'`.
    - `('0.16.2', '0.15.1')` returns `'show'`.
    - `('0.16.2', '0.16.2')` and `('0.16.0', '0.16.2')` return `'none'`.
    - An installed version that cannot be parsed returns `'none'`.
  - `selectUpgradeEntries`, using a fixture with Unreleased, 0.16.2, 0.16.1, 0.16.0, 0.15.1 and 0.15.0:
    - `lastSeen '0.15.1'` returns shown `['0.16.2','0.16.1','0.16.0']` with `hasMore: false`.
    - `lastSeen '0.15.0'` returns the same three with `hasMore: true`.
    - With 0.16.2 removed from the fixture, it returns `shown: []` with `hasMore: true`.
  - `shouldRunUpgradeNotice`:
    - `(['hook','--agent','x'], true)` and `(['--debug','hook'], true)` return false.
    - `(['proxy','start'], undefined)` returns false.
    - `(['--version'], true)` returns false.
    - `(['proxy','start'], true)` returns true.
  - `showUpgradeNotice`, with `getCodemiePath` pointed at a temp dir:
    - Older installed version: no `console.log`, and the marker is unchanged.
    - Missing section: it logs exactly `✨ Updated to 0.16.2` plus a line containing `codemie whatsnew --all`, and no `What's new in 0.15.1`.
- [ ] **Step 2: Run `npx vitest run src/utils/__tests__/whatsnew.test.ts`.** Expected: FAIL (functions not exported).
- [ ] **Step 3: Implement the helpers.**
  - `selectUpgradeEntries` keeps entries whose version is valid semver and satisfies `lastSeen < v <= installed`, sorts them newest first and keeps 3.
    - It returns `shown: []` when `installed` has no entry.
    - `hasMore` is true when entries were cut or `installed` is missing.
  - `shouldRunUpgradeNotice` requires `isTTY === true`, no `--version`/`-V`/`--task`/`--help`, and a first non-dash argument other than `hook`.
  - `showUpgradeNotice` runs these steps:
    1. Check `isWhatsNewEnabled()` and `decideUpgradeNotice`.
    2. On `show`, print the dim header `✨ Updated to <installed>`.
    3. Call `renderReleaseNotes([entry], { maxItems: 6 })` for each shown entry.
    4. Print the dim pointer `run \`codemie whatsnew --all\` for older release notes` when `hasMore` is true.
    5. Call `markVersionSeen(installed)`.
    6. On `record-silently`, call only `markVersionSeen`. On `none`, do nothing.
  - In `bin/codemie.js`, gate on `!isTestEnvironment && shouldRunUpgradeNotice(process.argv.slice(2), process.stdout.isTTY)`, then call `showUpgradeNotice(currentVersion)`. Keep the try/catch.
- [ ] **Step 4: Re-run.** Expected: PASS.

Test-first: yes — `decideUpgradeNotice('0.16.0','0.16.2') === 'none'`, `selectUpgradeEntries` returns 0.16.2/0.16.1/0.16.0 for last-seen 0.15.1, and `shouldRunUpgradeNotice(['hook'], true) === false`.

### Task 3: CHANGELOG 0.16.x sections and blocking release check

**Files:**
- Modify: `CHANGELOG.md`. Add `## [0.16.2]`, `## [0.16.1]` and `## [0.16.0]` with dates, below `[Unreleased]`.
- Modify: `scripts/release.sh:135-139`

- [ ] **Step 1:** Write each section in Keep-a-Changelog form (`### Added/Fixed/Changed`), using `git log --oneline v0.15.1..v0.16.0`, `v0.16.0..v0.16.1` and `v0.16.1..v0.16.2`. Take the dates from `git log -1 --format=%as <tag>`. In `release.sh`, replace the warning with a red error and `exit 1`, and change the comment from "non-blocking" to "blocking". Verify with `grep -c '^## \[0\.16\.[012]\]' CHANGELOG.md`, which should print `3`. Then set VERSION to a version with no section, e.g. `VERSION=9.9.9 bash -c 'source <(sed -n 137,140p scripts/release.sh)'`. It should exit non-zero.

Test-first: no — this changes data and a shell guard. The grep and exit-code checks above verify it.

### Task 4: `codemie proxy restart`

**Files:**
- Modify: `src/cli/commands/proxy/index.ts:129-202`. Pull out the launch helper and add `restart` after `stop`.
- Modify: `docs/COMMANDS.md:86-88` and `README.md:732-734`. Add the `codemie proxy restart [--profile <name>]` line.
- Test: `src/cli/commands/proxy/__tests__/index.test.ts`

**Interfaces:**
- Consumes: `checkStatus`, `stopDaemon`, `spawnDaemon`, `DaemonState`, `SpawnOptions` (`daemon-manager.ts:9-144`).
- Produces: a module-local `launchDaemon(config, profile: string, overrides: Partial<SpawnOptions>): Promise<DaemonState>`. It holds `start`'s current sequence from L161-182: the `baseUrl` check, `verifySsoCredentials`, the two skill syncs and `spawnDaemon`. `start` calls it with `{ port: requestedPort }`.

- [ ] **Step 1: Write failing tests** in the existing mocked suite.
  - **Running daemon.** State: `{ profile:'work', port:4001, clientType:'claude-desktop', telemetryMode:'claude-desktop', gatewayKey:'k', model:'m' }`. Expected:
    - `stopDaemon` is called before `spawnDaemon`.
    - `ConfigLoader.load` gets `{ name:'work' }`.
    - `spawnDaemon` gets an object containing `{ profile:'work', port:4001, clientType:'claude-desktop', telemetryMode:'claude-desktop', gatewayKey:'k', model:'m' }`.
    - No conflict error.
  - **`--profile other`.** Expected:
    - `ConfigLoader.load` gets `{ name:'other' }`.
    - The spawn has `profile:'other'`, and port, clientType and telemetryMode are unchanged.
  - **Not running.** Use `{ running:false, state:<stale> }`. The spawn gets `clientType:'codemie-daemon'` and `port: DEFAULT_DAEMON_PORT`, and `stopDaemon` is not called.
  - **Port mismatch.** `spawnDaemon` resolves `port: 54321` against a recorded 4001. Expected:
    - `stopDaemon` is called a second time.
    - The error output contains `4001`.
    - No `✓` line is printed.
  - **Hook-started daemon.** State has `clientType:'claude-code-otlp'`. The spawn keeps `clientType:'claude-code-otlp'`.
- [ ] **Step 2: Run `npx vitest run src/cli/commands/proxy/__tests__/index.test.ts`.** Expected: FAIL with `unknown command 'restart'`.
- [ ] **Step 3: Implement** the `restart` command: `.description('Restart the background proxy daemon, preserving its identity')` with `--profile <name>`.
  - When a daemon is running:
    - Load config for `opts.profile ?? state.profile`.
    - Call `stopDaemon()` (no conflict check).
    - Call `launchDaemon` with `{ port, clientType, telemetryMode, gatewayKey, model }` from the recorded state, and `project: opts.profile ? config.codeMieProject : state.project ?? config.codeMieProject`.
    - If `result.port !== state.port`, call `stopDaemon()` and throw `ToolExecutionError('proxy-daemon', 'Proxy could not rebind port <p>; ...')`.
  - When nothing is running, run `start`'s path: the current profile, `clientType:'codemie-daemon'` and `DEFAULT_DAEMON_PORT`.
  - On success print `chalk.green('✓ Proxy restarted at <url>  (profile: <p>)')`.
  - Wrap everything in try/catch and send errors to `printProxyError(error, 'Failed to restart proxy')`.
- [ ] **Step 4: Re-run.** Expected: PASS, and the existing `start` tests stay green.

Test-first: yes — `proxy restart` on a claude-desktop daemon re-spawns with port 4001, clientType and telemetryMode `claude-desktop`, and no conflict error.

---

## Negative-constraint pass

- No fallback to another version, and no notes from another version under the header: Task 1 and Task 2 (`shown: []` when the installed section is missing).
- An older install shows no banner and writes nothing: Task 2 (`'none'`).
- Restart does not move to another port: Task 4 (rebind check, then stop and throw).
- Restart is not rejected by `formatDaemonConflict`: Task 4 bypasses it.
- `whatsnew.ts` has no commander dependency: Task 2 imports only `version-utils.js`.
- Non-goals:
  - No task touches hook PATH resolution, `claude-code-otlp.ts`, `proxy-daemon.ts`, `connect --force`, or the update check.
  - The marker format is unchanged (`markVersionSeen` is reused).
  - CHANGELOG sections are written by hand.
  - `--all` is unchanged and still uses `getReleaseNotes(undefined)`.
