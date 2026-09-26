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

**Explicit named allowlist of five agents** — Claude, Codex, Gemini, Kimi, Copilot CLI — all
verified to share the identical hardcoded-constant pattern (`<AGENT>_SUPPORTED_VERSION` /
`<AGENT>_MINIMUM_SUPPORTED_VERSION`):

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

Kimi ACP needs no separate allowlist entry: it extends `KimiPlugin` and inherits
`KimiPluginMetadata` directly, so "Kimi" already covers it. Claude ACP
(`claude-acp.plugin.ts`) is explicitly **not** in scope — see Design §2 for why.

## Design

### 1. Version cache module

New module (e.g. `src/utils/version-cache.ts`) exposing `getCachedLatestVersion(packageName, {
forceRefresh? }): Promise<string | null>`. Wraps the existing `getLatestVersion()`
(`processes.ts:315`). Persists `{ [packageName]: { version, fetchedAt } }` to a new JSON file under
`~/.codemie/` (sibling to `version-warnings.json`, not part of the `ConfigLoader` schema). TTL is 24h
from `fetchedAt`; `forceRefresh: true` bypasses the TTL. On npm failure (timeout, network, unparsable
output), returns the last cached value if one exists, else `null` — the caller owns the fallback.

### 2. `supportedVersion` becomes live-tracked, uniformly, for an explicit allowlist

Each of the five plugins' hardcoded constants (`CLAUDE_SUPPORTED_VERSION`, `CODEX_SUPPORTED_VERSION`,
`GEMINI_SUPPORTED_VERSION`, `KIMI_SUPPORTED_VERSION`, `COPILOT_SUPPORTED_VERSION`) stays in the
source as the fallback-of-last-resort. A new shared accessor — e.g. `resolveSupportedVersion(agent):
Promise<string>` — becomes the single place both `checkVersionCompatibility()` and
`checkAgentForUpdate()` read from:

1. Look up the agent by an **explicit named allowlist** (agent id/name, not a structural check such
   as "does `metadata.npmPackage` exist"). Only `claude`, `codex`, `gemini`, `kimi`, and
   `copilot-cli` are live-tracked. Any other agent — including `claude-acp`, which sets
   `npmPackage: '@zed-industries/claude-code-acp'` but defines neither `supportedVersion` nor
   `minimumSupportedVersion` today — falls straight through to step 4 (today's hardcoded/absent
   behavior), never attempting a live lookup it would have no fallback value for.
2. If the agent is allowlisted and the global toggle (Section 3) is off, return
   `metadata.supportedVersion` unchanged — zero network I/O, today's behavior exactly.
3. If allowlisted and the toggle is on, resolve via the version cache for the agent's npm package,
   extracting the version with the existing `extractVersion()` convention already used by
   `checkAgentForUpdate`'s non-Claude path.
4. On any cache/fetch failure, or for a non-allowlisted agent, fall back to
   `metadata.supportedVersion` (or its absence, for agents like `claude-acp` that don't define it).

`checkVersionCompatibility()` (`BaseAgentAdapter.ts:284`) becomes async and calls this accessor
instead of reading `this.metadata.supportedVersion` directly; its callers (`run()`'s startup warning,
`install.ts`, `update.ts`, `AgentsCheck.ts`, `setup.ts`'s `checkAndInstallClaude`) are updated to
await it. `checkAgentForUpdate()`'s Claude special-case (`update.ts:58-79`) is deleted — Claude now
goes through the same uniform npm-backed path as the other four allowlisted agents, via the same
accessor.

### 3. Global toggle

New nested boolean on `WorkspaceConfig`, following the existing `metrics.enabled` precedent —
`workspace.versionChecks.enabled` (default `true`) — resolved through `ConfigLoader`'s existing CLI
> env > project > global > defaults chain, stored in `~/.codemie/codemie-cli.config.json` /
`.codemie/codemie-cli.config.json`. Both the env var and the config value resolve **fail-safe**: any
value other than an explicit, recognized "disable" (e.g. literal `false` for the config field,
`'false'` for the env var) resolves to enabled — the deliberate inverse of the `CODEMIE_DEBUG ===
'true'` fail-closed convention, required because an invalid or unrecognized stored value must never
silently disable checks.

When disabled, `resolveSupportedVersion()` always returns the hardcoded constant for allowlisted
agents, with no network calls from any of the three gated flows: the agent-run startup warning
(`warnOnceIfUntested`'s live-lookup step), `codemie setup` (`checkAndInstallClaude`), and `codemie
update` (`checkAgentForUpdate` / `checkAllAgentsForUpdates`). `codemie doctor` and `codemie update`'s
force-refresh bypasses only the 24h TTL, not the toggle — with the toggle off, force-refresh is a
no-op.

### 4. Notice-dedup interaction

`VersionWarningStore` keeps keying its one-time notice on the resolved `supportedVersion` string,
unchanged. Because `resolveSupportedVersion()` only produces a new value when npm's reported version
actually changes, a same-value cache refresh returns the identical string and the existing dedup
logic in `version-warnings.ts` naturally stays silent — no code change needed there.

### 5. UI copy

Reword the two "verified" framings to "newer version available":

- `update.ts:289` — Claude's already-up-to-date message.
- `setup.ts:783` — `` `CodeMie has only tested and verified v...` ``.

`AgentsCheck.ts:37`'s existing "CodeMie recommends v..." wording already fits and is unchanged.

## Acceptance Criteria

- All five allowlisted agents' (Claude, Codex, Gemini, Kimi, Copilot CLI) `supportedVersion` is
  sourced from a cached npm `latest` lookup when the global toggle is on, falling back to the
  existing hardcoded constant on fetch failure or when the toggle is off.
- `resolveSupportedVersion()` keys off an explicit named allowlist, not a structural signal like
  `metadata.npmPackage` presence — `claude-acp` (npmPackage set, no supportedVersion fields) is
  never targeted for a live lookup.
- `checkAgentForUpdate()` no longer special-cases Claude; all five allowlisted agents go through one
  uniform check.
- A single global config setting, resolved through `ConfigLoader`'s standard priority chain, gates
  the startup warning, `codemie setup`, and `codemie update` identically.
- An invalid or unrecognized stored value for the toggle resolves to "checks enabled."
- `codemie doctor` and `codemie update` can force a cache refresh, bypassing only the 24h TTL.
- The two named "verified"-framing UI strings are reworded; no other UI copy changes.
- A cache refresh that resolves to an unchanged version does not re-trigger `VersionWarningStore`'s
  notice.

## Non-goals

- `minimumSupportedVersion` / `isBelowMinimum` / `blockIfBelowMinimum` stay hardcoded and untouched.
- opencode and pi agents are not touched by this change.
- Claude ACP and any other non-allowlisted plugin are out of scope, even where they share
  npmPackage-shaped metadata with an allowlisted agent.
- No per-agent toggle granularity — one global switch only.
- Automated backend-compatibility testing of new agent versions against CodeMie.
- No new tests are written as part of this spec (repo policy: tests only on explicit request); the
  existing coverage gap on `checkAgentForUpdate()` is a noted risk, not addressed here.

## Open Risks

- `AGENTS.md` currently describes Copilot CLI as "Analytics ingestion only — never installed or
  launched by CodeMie," which is stale against the plugin's actual `install()` method and its
  inclusion in this live-tracking allowlist. Flagged as documentation drift; fixing the guide is out
  of this ticket's scope.
- `checkVersionCompatibility()` becoming async may touch every call site's signature — the
  implementation plan should enumerate all callers explicitly.
- A first-ever cache miss (fresh install, or past-24h) still pays a synchronous npm-lookup latency
  hit (up to `getLatestVersion`'s existing timeout) at startup unless mitigated — the plan should
  decide the exact mitigation (e.g. short timeout with graceful fallback).
- The new cache file's format/location has no locking precedent in this codebase; concurrent CLI
  invocations should tolerate last-write-wins.
