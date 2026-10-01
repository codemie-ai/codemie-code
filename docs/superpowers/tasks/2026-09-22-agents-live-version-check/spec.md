# Spec: Smarter Agent Version Recommendations (EPMCDME-14767)

## Problem

`supportedVersion` for Claude, Codex, Gemini, Kimi, and Copilot CLI is a hand-edited constant per
plugin (`claude.plugin.ts:39`, `codex.plugin.ts:73`, `gemini.plugin.ts:16`, `kimi.plugin.ts:26`,
`copilot-cli.plugin.ts:27-28`) that goes stale between manual bumps. Two separate code paths decide
"is this current?" — `checkVersionCompatibility()` (`BaseAgentAdapter.ts:284`, pure local compare)
and `checkAgentForUpdate()` (`update.ts:45`, queries npm for most agents but special-cases Claude by
copying the hardcoded constant instead of checking, `update.ts:58-79`). This replaces the hardcoded
"recommended" value with a live npm-tracked one, unifies the two paths, and adds a global kill
switch.

## Scope

**Explicit named allowlist of the ticket's four agents** — Claude, Codex, Gemini, Kimi (plus Kimi
ACP, the same binary) — all sharing the hardcoded-constant pattern (`<AGENT>_SUPPORTED_VERSION` /
`<AGENT>_MINIMUM_SUPPORTED_VERSION`). Copilot CLI was verified below but, per PR #576 review, is left
out: it isn't one of the ticket's agents, so it keeps its maintainer-pinned version, unchanged.

- Claude (`@anthropic-ai/claude-code`) — npm/upstream lockstep verified.
- Kimi (`@moonshot-ai/kimi-code`) — npm/upstream lockstep verified.
- Gemini (`@google/gemini-cli`) — npm/upstream lockstep verified live (`npm view` → `0.60.0`,
  matches GitHub's stable tag; nightly pre-releases are not returned by npm's `latest` dist-tag).
- Codex (`codex.plugin.ts:73`, npmPackage `@openai/codex`) — verified: npm `latest` (`0.155.1`)
  structurally excludes GitHub's heavy alpha pre-release stream (`0.157.0-alpha.x`, ahead of npm by
  design) via npm's semver pre-release-tag exclusion from the `latest` dist-tag — a mechanical
  guarantee, not an empirical match like the other four. Safe to use as source of truth for the same
  reason, not merely by analogy.
- Copilot CLI (`copilot-cli.plugin.ts:27-28`, npmPackage `@github/copilot`, has a real `install()`
  method) — npm/upstream lockstep verified live (`npm view` → `1.0.87`, matches GitHub's latest
  release tag `v1.0.87` exactly).

Kimi ACP needs its own allowlist entry: the allowlist is keyed by agent name and Kimi ACP is named
`kimi-acp`, though it inherits `KimiPluginMetadata` and runs the same binary. Claude ACP
(`claude-acp.plugin.ts`) is explicitly **not** in scope — see Design §2 for why.

## Design

> **Revised 2026-09-28 after PR #576 review.** The original design fell back to the hardcoded
> constant whenever the live value was unavailable. That contradicted ticket criteria #4 ("no stale
> value shown as current") and #5 ("checks off → as if no supported version were configured"), so
> the sections below now describe the implemented behavior: an unknown tracked version is reported
> as unknown, and every passive consumer stays silent instead of comparing against the constant.

### 1. Version cache module

New module `src/utils/version-cache.ts` exposing `getCachedLatestVersion(packageName): Promise<string
| null>`. Persists `{ [packageName]: { version, fetchedAt } }` to a new JSON file under `~/.codemie/`
(sibling to `version-warnings.json`, not part of the `ConfigLoader` schema). TTL is 24h from
`fetchedAt` (a `fetchedAt` in the future counts as stale). On a miss it reads the package's `latest`
version from the npm registry (`src/utils/npm-registry.ts`). A failed lookup (timeout, network,
non-200, or a response that isn't a version string) returns `null`, never the expired entry, and is
logged with `logger.warn` (log file only). The failure time is recorded, and lookups for that package
are skipped (returning `null`) for 10 minutes, so an offline machine doesn't wait the full timeout on
every launch; a later success clears it. The expired version itself is never served. A failed
cache write still returns the fetched value; malformed or torn cache files read as empty, and the next
successful write replaces them. A `bypassCache` option skips a fresh entry or a recent failure and always fetches (still
writing the result back); `codemie update` uses it, because the user explicitly asked to check now.

The registry is queried directly (one HTTPS GET of `<registry>/<name>/latest`, 3s limit) rather than
by spawning `npm view`: measured on a Windows laptop, `npm view` took 2.5–3.8s per package and ~4s
each when run in parallel, so the original 3s limit was routinely exceeded and the feature silently did
nothing. The direct request takes well under a second. It honors npm's `registry` and `@scope:registry`
settings (env var, project `.npmrc`, user `.npmrc`) and `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`, plus
npm's `https-proxy`/`proxy`. Registries that require authentication aren't supported; those lookups
fail safely. `${VAR}` references are expanded only in the user `.npmrc`; a project `.npmrc` value that
contains one is ignored, so a checked-out repo can't route env secrets to a host of its choosing on
agent launch.

### 2. `supportedVersion` becomes live-tracked, uniformly, for an explicit allowlist

The plugins' hardcoded constants (`CLAUDE_SUPPORTED_VERSION`, `CODEX_SUPPORTED_VERSION`,
`GEMINI_SUPPORTED_VERSION`, `KIMI_SUPPORTED_VERSION`) stay in the source as the fallback of last
resort. One shared accessor, `resolveSupportedVersionDetailed()` in
`src/agents/core/version-resolution.ts`, is the single place both `checkVersionCompatibility()` and
`checkAgentForUpdate()` read from. It returns `{ version, isCurrent }`:

1. With the global toggle (Section 3) off, nothing is current, for any agent, and there's no network
   I/O.
2. Agents are matched by an **explicit named allowlist** (agent name, not a structural check such as
   "does `metadata.npmPackage` exist"): `claude`, `codex`, `gemini`, `kimi` and `kimi-acp`.
   `claude-acp` is not: its `getVersion()` returns `null`, so it never takes part in version
   comparison.
3. For an allowlisted agent the version cache is consulted for its npm package, extracting the version
   with the existing `extractVersion()` convention. Only a successful lookup is current. A failed
   lookup or a prerelease value returns the fallback with `isCurrent: false`.
4. Any other agent with a pinned version (e.g. Copilot CLI) keeps it as current, exactly as before.

`checkVersionCompatibility()` exposes `isCurrent` as `versionKnown`. When it is `false`, the result
reports `supportedVersion: 'latest'`, `compatible: true`, and no update. The launch notice, `codemie
doctor`, `codemie setup` and `codemie update` then behave as if no supported version were configured.
The `minimumSupportedVersion` gate is computed independently and still applies in every case.
`installVersion('supported')` (`resolveSupportedInstallVersion()`) installs the current version, or
the `latest` channel when it is unknown — never the stale constant, which can be far behind upstream.
`run()` resolves compatibility once and shares it between the minimum gate and the notice.

`checkVersionCompatibility()` (`BaseAgentAdapter.ts:284`) becomes async and calls this accessor
instead of reading `this.metadata.supportedVersion` directly; its callers (`run()`'s startup warning,
`install.ts`, `update.ts`, `AgentsCheck.ts`, `setup.ts`'s `checkAndInstallClaude`) are updated to
await it. `checkAgentForUpdate()`'s Claude special-case (`update.ts:58-79`) is deleted — Claude now
goes through the same uniform path as the other allowlisted agents, via the same accessor.

### 3. Global toggle

New nested boolean on `WorkspaceConfig`, following the existing `metrics.enabled` precedent —
`workspace.versionChecks.enabled` (default `true`), stored in `~/.codemie/codemie-cli.config.json` /
`.codemie/codemie-cli.config.json`, env var `CODEMIE_VERSION_CHECKS_ENABLED`. It is resolved field by
field — env var, then project, then global — not through `ConfigLoader.load()`. `load()` swaps in a
project's whole `workspace` block (which would hide a global setting the project doesn't repeat) and
throws when no profile is active (which would hide the env var). Both the env var and the config
value resolve **fail-safe**: any value other than an explicit, recognized "disable" (literal `false`
for the config field, `'false'` for the env var) resolves to enabled — the deliberate inverse of the
`CODEMIE_DEBUG === 'true'` fail-closed convention, because an invalid or unrecognized stored value
must never silently disable checks.

When disabled there are no network calls from any gated flow:
- **Launch notice:** silent.
- **`codemie setup`:** shows a plain "installed" line; a missing Claude is still offered for install
  (a missing-agent prompt, not a version check), with neutral copy.
- **`codemie doctor`:** no "tracking vX" warning.
- **`codemie update`:** skips these agents, with a dim "version checks are disabled" note instead of
  "Could not check".
- **Minimum-version block:** unchanged. The ticket keeps it "as-is" and scopes this story to the
  recommended/supported advisory only.

### 4. Notice-dedup interaction

`VersionWarningStore` keeps keying its one-time notice on the resolved `supportedVersion` string,
unchanged. Because the resolver only produces a new value when npm's reported version actually
changes, a same-value cache refresh returns the identical string and the existing dedup logic in
`version-warnings.ts` naturally stays silent — no code change needed there.

A live-tracked agent whose installed version is *ahead of* the tracked one has usually self-updated
since the (up to 24h old) cached lookup, so the launch notice, `codemie setup` and `codemie doctor`
don't advise `install --supported` there — that would suggest a downgrade. Agents with a pinned
version (Copilot CLI) keep the notice when ahead, as before.

### 5. UI copy

Once the number follows npm rather than a hand-tested pin, every string that says CodeMie "tested",
"verified" or "recommends" a version is inaccurate. All of them use "tracking" framing instead
(decided during implementation, answering the ticket's open question on terminology):

- `update.ts` — up-to-date message: "no newer version available".
- `setup.ts` — "ahead of the tracked v...", and a neutral "Installing Claude Code..." spinner.
- `AgentsCheck.ts` — "CodeMie is tracking v...".
- `install.ts` — "(tracked version)" instead of "(supported version)".
- The launch notice ("CodeMie is tracking X vN; you are running vM"), the `install --supported`
  option help, and the two related `tips.json` entries.

## Acceptance Criteria

- The allowlisted agents' (Claude, Codex, Gemini, Kimi incl. Kimi ACP) tracked version is sourced
  from a cached npm registry lookup when the global toggle is on. On lookup failure or with the toggle
  off it is reported as unknown: no notice, warning or update offer. The hardcoded constant is never
  presented as current.
- The accessor keys off an explicit named allowlist, not a structural signal like
  `metadata.npmPackage` presence — `claude-acp` is never targeted for a live lookup. Agents outside it
  (Copilot CLI) keep their pinned version, unchanged.
- `minimumSupportedVersion` still blocks launch below the floor regardless of the toggle or lookup
  outcome.
- `checkAgentForUpdate()` no longer special-cases Claude; all allowlisted agents go through one
  uniform check.
- A single setting (env var > project > global) gates the startup warning, `codemie setup`,
  `codemie doctor` and `codemie update` identically. A global `false` holds in projects that have
  their own `workspace` block, and the env var works without an active profile.
- An invalid or unrecognized stored value for the toggle resolves to "checks enabled."
- `install --supported` with an unknown tracked version installs the latest release, and asks first
  when the agent is already installed.
- No user-facing string claims CodeMie "tested", "verified" or "recommends" a version; they use the
  §5 "tracking" framing. Other copy changes are limited to the checks-disabled notes in
  `codemie update` / `codemie install --supported`, and hiding the "Latest tracked version" line of
  the below-minimum message when the version is unknown.
- A cache refresh that resolves to an unchanged version does not re-trigger `VersionWarningStore`'s
  notice.

## Non-goals

- `minimumSupportedVersion` stays hardcoded and keeps blocking (even with checks off). Its
  comparison is only moved ahead of the unknown-version exit so it keeps working, and its message
  drops the "Latest tracked version" line when that version is unknown.
- New `codemie doctor` features. `doctor` already compares versions on `main` (#553) through the
  shared gate, so it follows the tracked version automatically; there is no forced-refresh flag.
- Forced cache refresh flags for `doctor` or `update` (dropped in PR #576 review; not asked for by
  the ticket). `codemie update` always fetches fresh instead, with no flag.
- opencode and pi agents are not touched by this change; Copilot CLI keeps its pinned version.
- Claude ACP is out of scope (no version comparison); Kimi ACP was added to the allowlist because it
  is the same binary as Kimi.
- No per-agent toggle granularity — one global switch only.
- Automated backend-compatibility testing of new agent versions against CodeMie.
- `exec()` quoting of the base command in shell mode: split into its own PR.
- Tests: written on explicit request during PR #576 review (version resolution, version cache,
  registry client, notice/doctor/update/install version paths).

## Open Risks

- `AGENTS.md` describes Copilot CLI as "Analytics ingestion only — never installed or launched by
  CodeMie," which is stale against the plugin's actual `install()` method. Flagged as documentation
  drift; fixing the guide is out of this ticket's scope.
- A cache miss (fresh install, past 24h, or offline) pays one registry request of up to 3s at
  launch; after a failure, lookups are skipped for 10 minutes, so an offline user pays it at most
  once per 10 minutes per agent.
- The cache file has no cross-process lock and isn't written atomically: concurrent CLI invocations
  are last-write-wins, and a torn file reads as empty (worst case: one extra lookup).
- Private npm registries that require authentication aren't supported by the direct lookup; for
  those users the tracked version stays unknown (no notice), which fails safely.
- Known, pre-existing and out of scope: `codemie update kimi` updates the npm package, not the
  native Kimi binary; a malformed installed version skips the minimum gate; `setup` shows a green
  check for a below-minimum Claude.
