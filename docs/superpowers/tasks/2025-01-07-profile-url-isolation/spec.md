# Spec: Per-profile CodeMie identity fields (EPMCDME-15192)

## Problem

`codemie setup` → "Add a new profile" or "Update an existing profile" changes the CodeMie URL and
project for **every** profile in the global config, not just the saved one.

`ConfigLoader.splitProfileAndWorkspace()` (`src/utils/config.ts:579-593`) routes the identity
fields — `codeMieUrl`, `codeMieProject`, `codeMieIntegration` — out of the profile and into the
scope's single `workspace` object. `saveProfile()` (`config.ts:598-619`) then merges them into
`config.workspace` on every save, and `load()` (`config.ts:131-136`) applies that workspace to
whichever profile is active. Profiles no longer store identity at all (migration
`007-decouple-provider-workspace-config` stripped it).

This is the design introduced by #502 (commit `d2cad9b`), which assumed one CodeMie installation
per config file. It breaks for users whose profiles target different installations (e.g.
`codemie.lab.epam.com` and `codemie-preview.lab.epam.com`): each save overwrites the shared value,
so a profile can send LLM traffic to one installation (`baseUrl`) while authenticating and
resolving its project against another (`codeMieUrl`).

#502's goal remains valid and must be preserved: switching to a profile that carries no CodeMie
identity (e.g. `bedrock`, `litellm`, `ollama`, or `anthropic-subscription` without a CodeMie
connection) keeps the CodeMie context from the workspace.

## Terms

- **Identity** — `codeMieUrl`, `codeMieProject`, `codeMieIntegration`.
- **Tooling fields** — the remaining workspace keys: `hooks`, `plugins`, `assistants`,
  `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`.
- **Server** — a CodeMie installation, identified by `codeMieUrl`.
- **Same server** — both URLs are equal after stripping trailing `/` and lower-casing, or at least
  one of them is missing. This is the rule of the pre-#502 `shouldPreserveProjectContext()`
  (`git show d2cad9b^:src/utils/config.ts`, around line 408).

## Design

### Types

`ProviderProfile` (`src/env/types.ts`) declares optional `codeMieUrl`, `codeMieProject` and
`codeMieIntegration`. `WorkspaceConfig` is unchanged.

### Write path — `saveProfile()` (global scope)

1. Identity fields are stored on `profiles[name]`. `WORKSPACE_KEYS` (`config.ts:562-572`) no longer
   contains them, so `splitProfileAndWorkspace()` leaves them on the profile half.
2. The three identity fields are written as a group: a save replaces all three on the profile, so
   a stale `codeMieIntegration` from a previous URL cannot survive.
3. Identity is written into the global `workspace` **only if the workspace holds no identity
   field yet** (first CodeMie setup on the machine). Otherwise the workspace identity is left
   untouched, so saving one profile never changes what other profiles resolve.
4. Tooling fields keep their current behavior (merged into `workspace`).

### Read path — `load()` and `loadWithSources()`

"Profile" means the selected global profile with the same-name local profile applied on top,
exactly as today (`resolveLocalProfileName()`, `applyProjectOnly`). Identity is never merged
field by field across profiles: if the applied local profile defines any identity field, the
profile identity is the local profile's three fields; otherwise it is the global profile's.

Identity resolves in order:

1. **Profile's own.** If the profile identity includes `codeMieProject` or `codeMieIntegration`,
   it is used and resolution stops.
2. **Repo workspace.** Otherwise, if the local config's `workspace` holds any identity field and
   is on the same server as the profile, the identity fields the profile lacks are filled from it
   and resolution stops. A URL the profile already has is kept.
3. **Global workspace.** Otherwise the same applies to the global `workspace`.
4. Environment variables and CLI overrides apply on top, unchanged.

At most one workspace contributes, so a project from one workspace is never paired with an
integration or URL from the other.

Consequences:

- A repo workspace or global workspace on a different server contributes nothing.
- A profile with its own URL but no project, on a server no workspace matches, resolves with no
  project rather than one borrowed from another server.
- A local `workspace` that holds only tooling fields no longer hides the global workspace
  identity; identity sources are evaluated independently of `resolveWorkspace()`'s whole-object
  rule, which continues to govern tooling fields only.
- `loadWithSources()` attributes each identity field to the layer that supplied it
  (profile / project / global).

### Display and raw-file readers

- `profile list` (`src/cli/commands/profile/index.ts:57`, `display.ts`) shows each profile's own
  `codeMieUrl`, falling back to the workspace value.
- `profile status` (`profile/index.ts:153`) shows the identity resolved by `load()`.
- `src/agents/plugins/claude/plugin/statusline.mjs:218` reads the raw config file; it uses the
  active profile's `codeMieUrl`, falling back to `workspace.codeMieUrl`.

### Local scope — `initProjectConfig()`

Uses the same reduced `WORKSPACE_KEYS`, so a locally saved profile stores its own identity. It
also continues to write identity into the local `workspace` as it does today (see Resolved
Decisions). Its rewrite-the-whole-file behavior is out of scope.

### Existing configs

No migration. Existing profiles hold no identity, so they resolve exactly as today until they are
re-saved through `codemie setup`. Users whose profiles target different servers re-run
`codemie setup` → "Update an existing profile" once per affected profile; the release note says so.

## Resolution examples

Global workspace: lab / `proj-g`. Team repo local workspace: lab / `team-x`.

| # | Where | Profile | Profile's own identity | Resolves to |
|---|---|---|---|---|
| 1 | anywhere | SSO, re-saved on preview | preview / `my-proj` | preview / `my-proj` |
| 2 | team repo | SSO, re-saved on lab | lab / `my-proj` | lab / `my-proj` |
| 3 | outside repo | SSO, never re-saved | none | lab / `proj-g` |
| 4 | team repo | SSO, never re-saved | none | lab / `team-x` |
| 5 | outside repo | `bedrock` | none | lab / `proj-g` |
| 6 | team repo | `bedrock` | none | lab / `team-x` |
| 7 | team repo | JWT on lab (URL only) | lab / none | lab / `team-x` |
| 8 | team repo | JWT on preview (URL only) | preview / none | preview / no project |

## Acceptance Criteria

- Updating a profile via `codemie setup` changes only that profile's identity; every other
  profile resolves to the same identity as before the update.
- Adding a new profile on a different server does not change what existing profiles resolve.
- `saveProfile()` stores identity on `profiles[name]` and writes workspace identity only when the
  workspace has none.
- Loading follows the order in *Read path*; all eight rows of *Resolution examples* hold.
- Existing configs with no per-profile identity resolve identically to the current release.
- Tooling fields store and resolve exactly as today.
- `profile list`, `profile status` and the Claude statusline show the per-profile identity with
  workspace fallback.
- `config-project-override.test.ts:395-410` asserts the new storage location instead of the
  current shared-workspace behavior.
- Regression tests cover: two profiles with different URLs where updating one leaves the other
  intact; adding a profile on a different server; each row of *Resolution examples*; statusline
  profile-first URL selection.
- `.ai-run/guides/usage/project-config.md` "Team project context with a selected provider
  profile" describes the read-path order above.

## Non-Goals

- A migration or automatic repair of profiles already affected; no derivation of `codeMieUrl`
  from `baseUrl`.
- A way to change the global workspace identity after it is first set (currently only by editing
  the config file).
- Fixing `initProjectConfig()` rewriting the whole local config file on save (separate ticket).
- Changes to provider plugins, setup steps, migration 007, tooling-field behavior, or
  environment/CLI override precedence.

## Resolved Decisions

- **Mismatch warning.** Decided: do not add a warning when an SSO profile's `baseUrl` host differs
  from its resolved `codeMieUrl` host.
- **Local workspace identity on local saves.** Decided: keep today's `initProjectConfig()`
  behavior as-is; out of scope for this fix, to be settled in the local-save ticket.
