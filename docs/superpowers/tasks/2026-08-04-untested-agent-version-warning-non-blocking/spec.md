# Spec — User-friendly agent version handling (EPMCDME-13734)

## Summary

Replace the blocking agent-version checks in CodeMie CLI with a **one-time, non-blocking mismatch notice**. Each plugin keeps a manually-bumped `SUPPORTED_VERSION` constant (updated per CodeMie release when a new agent CLI version is validated). When a user's installed agent version differs from the pinned `SUPPORTED_VERSION`, CodeMie shows one `chalk.yellow` line to stderr — never blocks, never throws, never prompts — and records the `(agent, installed-version)` pair to `~/.codemie/version-warnings.json`. Subsequent launches of the same pair stay silent. When the installed version matches the pinned supported version, no notice is shown at all. The running CodeMie version is displayed in the banner text for context but is **not** part of the marker key — a CodeMie release must not re-nag users about an agent version they have already acknowledged.

## Goals

- User is never prevented from launching a wrapped agent by a version check — no `throw`, no `process.exit`, no `inquirer.prompt` for any version condition.
- User is never nagged more than once per `(agent, installed-agent-version)` pair — CodeMie releases do not reset acknowledgements.
- Pinned per-agent constants (`*_SUPPORTED_VERSION`, `*_MINIMUM_SUPPORTED_VERSION`) stay in the codebase, bumped manually per CodeMie release when a new agent CLI has been validated. They serve as the reference point for the mismatch check and the target of `codemie install <agent> --supported`.
- User in the tested range (`installedVersion === metadata.supportedVersion`) never sees a notice.
- Non-interactive contexts (ACP, silent, non-TTY, CI, scripted) log a warning and proceed automatically — never throw, never prompt.
- `codemie doctor` surfaces per-agent verification status so users can see, at a glance, which agent versions have already been acknowledged.

## Non-Goals

- No blocking behavior of any kind — even below `minimumSupportedVersion`. That constant remains only for informational/display purposes.
- No per-agent-version reset (users reset all markers, or nothing).
- No changes to `DISABLE_AUTOUPDATER=1` lifecycle behavior or the CLI updater path.
- No UI to view the raw warned-markers store.
- No re-introduction of the `checkVersionCompatibility` blocking branches or the old `inquirer.prompt` UX.

## User-Visible Behavior

### 1. First launch with a mismatched agent version (interactive TTY)

```
$ codemie claude
⚠  CodeMie has verified claude v2.1.218; you are on v2.1.219
   (running CodeMie v0.11.0). Proceeding — this notice is shown once for this version.

   To install the version CodeMie last verified, run:
     codemie install claude --supported

<agent starts normally>
```

- Fires only when `installedVersion !== metadata.supportedVersion`.
- Written with `chalk.yellow` for the header and plain white for the guidance line.
- Emitted to stderr (so `codemie claude --print ... | jq` still works).
- Marker `{agentName: "claude", agentVersion: "2.1.219"}` is recorded to `~/.codemie/version-warnings.json` **after** the warning is printed. The running CodeMie version appears in the banner text but is **not** stored in the marker.
- Agent launches immediately after the marker is persisted.

### 2. Launch while installed matches supported (in tested range)

```
$ codemie claude
<agent starts normally, no version banner, no marker recorded>
```

- No comparison-based notice fires. No marker recorded (there was nothing to acknowledge).
- Doctor renders "Untested" until the user experiences a mismatch and acknowledges it — this is the price of the simple 3-state doctor rendering the ticket asked for.

### 3. Repeat launch with an already-acknowledged mismatch

```
$ codemie claude
<agent starts normally, no version banner>
```

- Store's `hasWarned(agent, installedVersion)` short-circuits before any output.

### 4. Non-interactive / ACP / silent / non-TTY / CI / scripted

- Warning is emitted via `logger.warn()` only. No prose is written to stdout — stdout stays clean for JSON-RPC in ACP, for piped scripts, and for CI.
- Never `throw`, never `process.exit`, never `inquirer.prompt` — even below `minimumSupportedVersion`.
- Marker is recorded exactly as in the interactive case, so subsequent runs stay silent.

### 5. `codemie install <agent>`, `codemie update <agent>`, `codemie setup`

- `codemie install <agent> --supported` resolves to `metadata.supportedVersion` (the pinned constant) — same as the old behavior. The flag exists specifically so users can pin back to what CodeMie has verified after seeing the mismatch notice.
- `codemie install <agent>` without version defaults to `--supported` for claude / codex (backend-compat sensitive) and to the plugin's own default for other agents.
- `codemie update <agent>` targets `metadata.supportedVersion` for claude (native installer) and `getLatestVersion` from npm for the others.
- `codemie setup` runs `warnOnceIfUntested()` on the Claude adapter — silent when installed matches supported, one-time notice on mismatch.

### 5. `codemie doctor`

```
Agents
  claude (2.1.219) — Acknowledged with CodeMie 0.11.0
  codex  (0.143.0) — Untested with CodeMie 0.11.0
  gemini            — Not installed
  kimi   (0.16.0)  — Acknowledged with CodeMie 0.11.0
```

Three states:

| State | When | Rendering |
|---|---|---|
| **Acknowledged** | A marker exists for `(agent, installed-version)` | `chalk.green('Acknowledged')` |
| **Untested** | Agent is installed but no marker exists for the current `(agent, installed-version)` pair | `chalk.yellow('Untested')` |
| **Not installed** | `agent.getVersion()` returned `null` | `chalk.gray('Not installed')` |

Deprecation warning for legacy npm-global installs (existing behavior) is preserved and appended as a secondary line.

### 6. Reset

```
$ codemie doctor --reset-version-warnings
Cleared version-warnings.json — 3 markers removed.
```

- Flag on `codemie doctor`. When set, the doctor command first deletes `~/.codemie/version-warnings.json` (if present) and prints a one-line confirmation. Then it runs the normal doctor checks — every installed agent is `Untested` again.
- No env var. No config option. One entry point.

## Architecture

### Layer changes

| Layer | Change |
|---|---|
| **Plugin metadata** (`src/agents/plugins/*/*.plugin.ts`) | Remove `*_SUPPORTED_VERSION`, `*_MINIMUM_SUPPORTED_VERSION` constants (8 total across 4 plugins). Remove `supportedVersion`, `minimumSupportedVersion` fields from every plugin's metadata literal. |
| **Types** (`src/agents/core/types.ts`) | Remove `supportedVersion`, `minimumSupportedVersion` optional fields from `AgentMetadata`. Replace `VersionCompatibilityResult` with narrower `AgentVersionInfo { installedVersion: string \| null }`. |
| **Adapter core** (`src/agents/core/BaseAgentAdapter.ts`) | Replace `checkVersionCompatibility()` returning `VersionCompatibilityResult` with a simpler `getVersionInfo()` returning `AgentVersionInfo`. Rewrite the version-check block inside `run()` (lines 383–506) as a call to a new helper `warnOnceIfUntested()` that consults `VersionWarningStore`. Remove every `inquirer.prompt` in this block. Remove the `throw` in `silentMode` branch. Never call `process.exit()` in this block. |
| **State** (new: `src/utils/version-warnings.ts`) | `VersionWarningStore` class following the `MigrationTracker` shape. File: `~/.codemie/version-warnings.json`. Methods: `hasWarned(agent, agentVersion)`, `recordWarning(agent, agentVersion)`, `clear()`. The running CodeMie version is **not** part of the key — see rationale in the Summary. |
| **CLI — install** (`src/cli/commands/install.ts`) | Route `--supported` and default-`'supported'` values to `'latest'`. Remove references to `compat.supportedVersion` in display strings (there is no supported version). Continue emitting the one-time-warning through the same shared helper. |
| **CLI — update** (`src/cli/commands/update.ts`) | Stop calling `checkVersionCompatibility()` for its return shape. Use `getVersionInfo()` for installed version display only. Emit one-time-warning via the same shared helper. Do not gate the update on version comparison. |
| **CLI — setup** (`src/cli/commands/setup.ts`) | Replace the `chalk.yellow(...isNewer...) / chalk.green(...compatible...)` block with the shared helper. Preserve the 3-second timeout wrapper for `getVersion()`. |
| **CLI — doctor** (`src/cli/commands/doctor/index.ts`, `checks/AgentsCheck.ts`) | Add `--reset-version-warnings` flag on the doctor Commander command. Extend `AgentsCheck` to look up each installed agent in `VersionWarningStore` and render the three-state status. |
| **Test setup** (`tests/setup/agent-build-setup.ts`) | Remove the `CLAUDE_SUPPORTED_VERSION` import from dist. Install claude `--latest` (or check for any installed version and skip re-install). |
| **Tests** | Rewrite `codex.plugin.version-support.test.ts` to cover the new one-time-warning contract instead of asserting a constant. Add unit tests for `VersionWarningStore`. Add unit tests for `BaseAgentAdapter.run()` version-check branches (currently zero coverage) — one test per state per interactive-vs-silent axis. |

### New shared helper

`BaseAgentAdapter.warnOnceIfUntested()` is the single seam every entry point calls:

- Input: none (uses `this.metadata`).
- Behavior:
  1. Call `this.getVersionInfo()`.
  2. If `installedVersion` is `null`, return without warning (no version → nothing to warn about; the install/setup command surfaces this separately).
  3. If `VersionWarningStore.hasWarned(agentName, installedVersion)`, return.
  4. Otherwise:
     - Read `codemieVersion` from `getCurrentCliVersion()` in `src/utils/cli-updater.ts` for the display line only (fall back to `"unknown"` when null).
     - Emit the "untested version" notice: `logger.warn(...)` always; if `!metadata.silentMode && isInteractive()`, also print the chalk-formatted banner to `console.error`.
     - Call `VersionWarningStore.recordWarning(agentName, installedVersion)`.
- Never throws. Never blocks. Never prompts.
- The running CodeMie version appears in the banner text but does **not** participate in the marker lookup — see Summary rationale.

`isInteractive()` is a shared utility function evaluating `process.stdin.isTTY === true && process.env.CODEMIE_NO_PROMPTS !== '1'`. It lives with `sanitizeLogArgs` in `src/utils/logger-helpers.ts` or a new `src/utils/tty.ts` — plan decides.

### State file

`~/.codemie/version-warnings.json`:

```json
{
  "version": 1,
  "warnings": [
    {
      "agentName": "claude",
      "agentVersion": "2.1.219",
      "warnedAt": "2026-08-04T12:00:00.000Z"
    }
  ]
}
```

- Written after the warning is emitted (never before, so a crash during warn does not silence the next launch).
- Reads use `fs.readFile` with an empty-history fallback on missing file / parse error, mirroring `MigrationTracker.loadHistory()`.
- File is under `getCodemiePath('version-warnings.json')`, so `CODEMIE_HOME` in tests automatically isolates it.
- `clear()` deletes the file with `fs.unlink`; missing file is not an error.

### `AgentVersionInfo` replaces `VersionCompatibilityResult`

Rationale: after removing pinned versions, the only piece of information any caller needs is the installed version string. The old `VersionCompatibilityResult` shape carried five fields (`supportedVersion`, `isNewer`, `hasUpdate`, `isBelowMinimum`, `minimumSupportedVersion`) that all become meaningless without a pinned reference. Callers previously reading `compat.supportedVersion` for user-facing display are refactored to display the installed version and the CodeMie version, or to route to `--latest`.

## Behavior changes vs. today

| Path | Before | After |
|---|---|---|
| `BaseAgentAdapter.run()` — `isBelowMinimum`, interactive | Blocks with `inquirer.prompt` `Install / Exit`; `process.exit(0)` on Exit | One-time chalk warning, records marker, proceeds. Never prompts. |
| `BaseAgentAdapter.run()` — `isBelowMinimum`, silentMode/ACP | **Throws** `Error(...)` | `logger.warn(...)`, records marker, proceeds. Never throws. **Deliberate behavior change from prior ADR.** |
| `BaseAgentAdapter.run()` — `isNewer`, interactive | Blocks with `inquirer.prompt` `Install / Continue / Exit` | Same one-time warning; no prompt. |
| `BaseAgentAdapter.run()` — `hasUpdate && compatible`, interactive | Prompts `Install / Continue / Exit` | Removed. There is no "update recommended" flow in `run()` anymore; `codemie update <agent>` remains the explicit path. |
| `install.ts` — `--supported` flag | Resolves `metadata.supportedVersion` | Resolves to `'latest'`. |
| `install.ts` — default version routing for Claude | Uses `metadata.supportedVersion` | Uses `'latest'`. |
| `install.ts` — post-install "installed newer than supported" note (lines ~216–223) | Prints yellow warning referencing `compat.supportedVersion` | Removed. |
| `update.ts` — Claude update path | Reads `compat.supportedVersion` to decide "has update" | Uses `getVersionInfo()` to display installed version; update logic switches to `--latest`. |
| `setup.ts` — Claude version check (~line 883) | Prints yellow "isNewer" or green "compatible" line | Same one-time warning via shared helper. Neither line references a supported version. |
| `AgentsCheck.ts` — doctor output | `<name> (<version>)` only | `<name> (<version>) — Untested/Acknowledged with CodeMie <codemie-version>` |
| `codemie doctor` command | No `--reset-version-warnings` flag | New flag; deletes `version-warnings.json` before running checks. |

### The one deliberate ACP behavior change

**ACP `isBelowMinimum` currently throws.** With this change it will log-and-proceed. The JSON-RPC caller no longer receives a structured error for a below-minimum agent version; it receives the agent's normal output stream and a `logger.warn` line in the CodeMie log file. This is intentional — the ticket AC explicitly requires "never throw and never block on version mismatch" in ACP contexts. Callers that depended on the throw as an integration signal must switch to reading the log or checking `codemie doctor` output.

## Reset semantics

- Scope: user-level, machine-wide. Not per-agent, not per-version. `codemie doctor --reset-version-warnings` wipes the entire file.
- Composability: the flag runs before the doctor checks in the same command invocation. So `codemie doctor --reset-version-warnings` shows every installed agent as `Untested` immediately after clearing.
- Idempotency: running the flag twice is a no-op the second time (missing file is silently OK).

## Non-interactive detection

- Single canonical predicate: `isInteractive()` returning `process.stdin.isTTY === true && process.env.CODEMIE_NO_PROMPTS !== '1'`.
- ACP plugins gate on `this.metadata.silentMode === true`. When `silentMode`, the warn is `logger.warn` only — no chalk output to stdout or stderr.
- Non-interactive path uses `logger.warn` regardless of `silentMode` value; `silentMode` only suppresses the chalk banner.

## Persistence

- Location: `~/.codemie/version-warnings.json` (`getCodemiePath('version-warnings.json')`).
- Schema versioned via `version: 1` for forward compatibility.
- Concurrent writes: not defended against. The store is user-scope; concurrent CodeMie sessions writing at the same instant is possible in theory but the worst case is a duplicate marker or the last writer wins — both benign because `hasWarned` is idempotent. No fs-level locking.
- Store never records `agentVersion: null`. If `getVersion()` returns `null`, no marker is written and no warning fires.

## `--version supported` handling

- The `--supported` boolean flag on `codemie install` stays. Its semantic is now "install the latest published version" — identical to `--latest`.
- The literal string `'supported'` in `versionToInstall` code paths is either replaced with `'latest'` or dropped in favor of leaving `versionToInstall` `undefined` (plugin default). Plan decides at implementation time.
- The `--supported` help text is updated to "Install the latest available version tested by the CodeMie team." No mention of a pinned version.
- User-facing output no longer says "(supported version)". Wherever the install command previously interpolated `compat.supportedVersion`, we interpolate the actually-installed version (`compat.installedVersion` today, `versionInfo.installedVersion` post-change).

## Testing surface

- `VersionWarningStore` unit tests: fresh install (empty file), record + read, dedup, `clear()` on missing file, `clear()` after records, schema-version tolerance, `CODEMIE_HOME` isolation.
- `BaseAgentAdapter.warnOnceIfUntested()` unit tests: interactive-TTY with marker present → silent, interactive-TTY with marker absent → warn + record, `silentMode` with marker absent → `logger.warn` only (no chalk), `installedVersion === null` → nothing happens, `hasWarned` throws → non-fatal, warn is emitted, marker is not recorded.
- `BaseAgentAdapter.run()` regression tests: with marker present, `run()` does not `inquirer.prompt` and does not call `getVersion()` twice; with marker absent it warns and continues; with `silentMode` and no marker it never throws.
- `install.ts`: `--supported` routes to `--latest`; default routing for Claude routes to `--latest`; user-facing output no longer mentions "supported version".
- `AgentsCheck.ts`: doctor shows `Untested` when no marker, `Acknowledged` when marker matches the running CodeMie version and installed version, `Not installed` when `getVersion()` returns `null`.
- `codemie doctor --reset-version-warnings`: file deleted, checks run, all installed agents show `Untested`.
- `agent-build-setup.ts`: does not import `CLAUDE_SUPPORTED_VERSION`; global setup installs claude `--latest` (or reuses existing install if present).

## Rollout & risk

- Single PR — this is a coupled change and cannot be split cleanly without a broken intermediate state (removing constants breaks tests until callers are updated).
- ACP behavior change (`throw` → `log-and-proceed`) called out in PR description and release notes.
- `--supported` flag becoming an alias is silent — no user-facing message, no breakage of existing scripts.
- Fallback path: if the `VersionWarningStore` cannot read or write, we degrade gracefully — `hasWarned` returns `false` (users see the notice once per session in the worst case) and `recordWarning` swallows the error via `logger.warn` (the run continues). Version-check logic never becomes a launch blocker.

## Open decisions deferred to the plan

- Exact test file for `warnOnceIfUntested()` — new file `src/agents/core/__tests__/BaseAgentAdapter.version-warning.test.ts` or extend `BaseAgentAdapter.test.ts`.
- Whether `isInteractive()` lives in `src/utils/tty.ts` (new) or is inlined into `warnOnceIfUntested()`.
- Whether `AgentsCheck` looks up markers in parallel with `getVersion()` calls (already parallelized today).
- Which `versionToInstall` sentinel replaces `'supported'` in `install.ts` code paths (`'latest'` string literal vs `undefined`).
