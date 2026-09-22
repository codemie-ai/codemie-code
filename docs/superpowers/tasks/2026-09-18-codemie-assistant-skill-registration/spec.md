# Headless registration for CodeMie assistants and skills

**Date**: 2026-09-18
**Status**: approved design
**Complexity**: L (23/36)

## Problem

`codemie setup assistants` and `codemie setup skills` can only be driven by a human at a TTY. Every
step — storage scope, agent targets, assistant registration mode, item selection — is a raw-mode
prompt, so the commands cannot run in CI, in a devcontainer bootstrap, or from a provisioning
script. There is no non-interactive branch anywhere in either tree.

Separately, the pipeline is *partial-tolerant* by construction. An assistant the caller cannot
access is logged and silently dropped (`src/cli/commands/assistants/setup/data.ts:168-176`), then
skipped again downstream (`setup/index.ts:190`), and `executeWithSpinner`
(`src/cli/commands/shared/helpers.ts:6-37`) converts any throw into a `null` return that the caller
reads as "skip this one". A run that registers three of five requested assistants reports success.

## What this does not need to build

The interactive half of the requirement already exists. The selection wizard carries a focused
search box with a debounced server-side query (`assistants/setup/selection/index.ts:62-102`,
`ui.ts:25`) across its Registered / Project / Marketplace panels, and the skills tree mirrors it.
"Interactive where the user can search and select via a wizard" is satisfied today.

## Approach

Add a non-interactive branch to `setupAssistants` (`assistants/setup/index.ts:62`) and `setupSkills`
(`skills/setup/index.ts:90`), reached through headless flags on the *existing* commands. No new
verb and no new top-level command: `codemie skills add` already exists as an unrelated wrapper over
the upstream skills CLI, and a second registration-shaped surface would be read as the same thing.

**Mode selection** follows the repo's established signal (`skills/add.ts:52`): headless when any
headless flag or `-y/--yes` is present, or when `process.stdin.isTTY` is not true. Otherwise the
wizard runs exactly as it does now.

**Headless inputs are explicit, never inferred.** `--scope`, `--agent` and — for assistants — the
per-item registration mode (`agent` or `skill`, `manualConfiguration/types.ts:9`) are required in
headless mode. Absent flags are an error naming the missing flag, not a default. Nothing is
auto-detected: `detectInstalledTargets()` does not run on this path. This trades single-command
convenience for a command whose effect is legible from its text alone. Multi-value flags are
comma-separated, matching `--agent <agents>` on these same commands (`assistants/setup/index.ts:45`).

**Identifiers** resolve by id, slug, or exact name, case-insensitively. A name matching more than
one item is an ambiguity error listing the candidates and their ids; it does not pick one.

**Fail-fast is one contract for both modes.** A pre-flight phase authenticates, resolves every
requested identifier, and confirms every agent target *before the first filesystem write*. Any item
that cannot be resolved or is not available to the authenticated user aborts the whole run with a
typed error and a non-zero exit — in the wizard as well as headlessly. This requires defeating the
three partial-tolerant helpers above rather than layering on top of them: resolution failures must
propagate instead of being logged and omitted.

Atomicity stops there. A failure *after* writing has begun — a generator error on item three of
five — aborts immediately and reports which items were already written, leaving them in place.
There is no filesystem rollback; pre-flight is what makes the stated requirement reachable, and
unwinding artifacts across three generators is a larger contract than the requirement asks for.

**The skills notice** (`skills/setup/index.ts:39`) is informational — it warns that skills install
without tools or MCP servers and points at attaching them to an assistant. It is not a consent gate.
Headless mode prints the same text as ordinary log output and continues; the interactive Enter gate
is unchanged.

Both wiring sites must gain the flags together: `src/cli/commands/setup.ts:27-28` and
`src/agents/core/AgentCLI.ts:115-116`.

## Acceptance criteria

- A single non-interactive command registers several assistants and/or skills with no prompt and no
  raw-mode call.
- A requested item not available to the authenticated user aborts the entire run with a named,
  actionable error and a non-zero exit — in both interactive and headless mode.
- The abort happens before any artifact is written under `.claude` / `.codex` / `.gemini` and before
  config is saved.
- Authentication is verified before any side effect, per `skills/lib/require-auth.ts`.
- Missing `--scope`, `--agent`, or assistant registration mode in headless mode each fail with an
  error naming the missing flag.
- An identifier matching no item, and a name matching several, produce distinct typed errors.
- A mid-write failure aborts and reports the already-written items by name.
- With no headless flags at a TTY, wizard behaviour — search, panels, re-registration — is unchanged.
- Both `codemie setup ...` and `codemie-<agent> setup ...` expose the same flags.

## Non-goals

- Rebuilding, restyling, or replacing the interactive selection wizard.
- Changing the `codemie skills add|update|remove|list|find` upstream-wrapper surface.
- Telemetry for the new path; `SkillCommand` (`skills/lib/skills-metrics.ts:44`) is unchanged.
- Machine-readable (`--json`) registration output.
- Config schema changes or a migration — records still append to `codemieAssistants` / `codemieSkills`.
- Filesystem rollback of artifacts written before an abort.
- Auto-detecting agent targets in headless mode.
- Unrelated known defects: `hostAgent` dropped on back-navigation (`assistants/setup/index.ts:95`),
  `loadSkillsByScope` verifying only `.claude` paths (`src/utils/config.ts:939-941`), the
  `registerSkill` slug mismatch (`skills/setup/helpers.ts:80`).
- Backfilling coverage for untested orchestration beyond what the new paths require.

## Risks

- Fail-fast must hold at three independent points (`assistants/setup/data.ts:168-176`,
  `setup/index.ts:190`, `shared/helpers.ts:6-37`); a miss at any one restores silent partial success.
- Several prompts call `setRawMode` unconditionally, so an unguarded path can still hang in CI.
- `client.assistants.get` / `client.skills.get` are not shape-guarded, so a stale SSO session
  returning Keycloak HTML with a 2xx can masquerade as "not available"
  (cf. `shared/api-response-guard.ts:26`).
- `skills/setup/data.ts:122-136` filters a `per_page: 100` page client-side, so "not found" is
  indistinguishable from "beyond page one" until that fetch is corrected.
- `setupAssistants`, `setupSkills`, `resolveAgentSetupTargets` and `handleSetupError` have no
  covering tests today.
