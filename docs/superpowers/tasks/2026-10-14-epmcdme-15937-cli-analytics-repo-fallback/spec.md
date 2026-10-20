# EPMCDME-15937: Normalized repository identifier in OTLP analytics

## Problem

For a git repo with no `origin` remote, `OtlpAgentAdapter.resolveRepoFields()` (`src/agents/core/OtlpAgentAdapter.ts` ~L274-283) sends `repo_remote = ''`, and `buildEvent()` (~L159-169) stamps the absolute `cwd` on every event and mirrors it into `raw`. The backend fills `session_dims.repository` from the event `cwd` (`rollups.py` ~L1627) and the UI shows `coalesce(nullif(repo_remote,''), nullif(repository,''))`, so CLI Analytics shows e.g. `C:\Projects\testProject2` (leaking path, OS username, home dir).

## Approach

Change only what `OtlpAgentAdapter.buildEvent()` sends as `cwd`. Replace the absolute path with `extractRepository(ctx.cwd)` (`src/utils/paths.ts` ~L411), always, independent of whether a remote exists. Because the backend derives `session_dims.repository` from `cwd`, the DB `repository` column becomes the short value, and for a no-remote repo (empty `repo_remote`) the UI falls through to it. No new event field, no backend change.

- `cwd` field and the `cwd` entry in `raw` = `extractRepository(ctx.cwd)`; the absolute path is never put on the event.
- `repo_remote` and `resolveRepoFields()` are NOT changed: remote `owner/repo` when a remote exists, else `''`.
- The event-supplied `repo_remote` override (`OVERRIDABLE_FIELD_KEYS`) is unchanged.
- The fix lives in the base class, so it applies to every `OtlpAgentAdapter` subclass.

### Fallback rule (existing behavior, not modified)

`extractRepository`: last two non-empty path segments as `parent/current`, `Cowork` for Claude Desktop sandbox paths, a single segment stays single, empty gives `unknown`. Separator handling is host-independent (`splitPath`/`normalizePathSeparators`), so `\` and `/` paths behave the same on any host. `extractRepository` and `resolveRepositoryName` are not changed.

## Acceptance criteria

1. `repo_remote` is unchanged: remote-derived name when a remote exists, empty string when there is none.
2. The event `cwd` field and `raw.cwd` equal `extractRepository(cwd)` and never an absolute path, identically for macOS, Linux and Windows-style paths.
3. For a no-remote repo, the UI Repository and DB `session_dims.repository` show `parent/current` (e.g. `qa-projects/pr609-preview-agents`).
4. Repos with a remote keep showing `owner/repo` via `repo_remote`.
5. Grouping keys on the normalized value, so two checkouts at different absolute paths with the same last two segments group together.
6. The behavior applies to every `OtlpAgentAdapter` subclass.

## Non-goals

- No change to `repo_remote` or `resolveRepoFields()`; no change to the event-supplied `repo_remote` override.
- No change to `extractRepository` or `resolveRepositoryName`; no home-directory detection or special-casing.
- No backend changes (sibling repo `codemie` is read-only); no new `repository` event field.
- No correction of historical `session_dims.repository` rows.
- No changes to the proxy/spool layer (`otlp-spool/`), which only transports.
- Local working-tree files stay out of the change: `otel-analytics-override.ts` (contains a hard-coded token), `forwarder.ts`, `package.json`, `.codemie/codemie-cli.config.json`, `install.cmd`.
- No commits, branches or tests unless explicitly requested (AGENTS.md); tests, when requested, belong in `OtlpAgentAdapter.test.ts`.

## Known limitations and risks

- Accepted by the user as consistent with existing behavior: a cwd directly under the home dir yields `<username>/<dir>` (e.g. `x/proj`), and the home dir itself yields e.g. `Users/x`, so the OS username can still be visible in those cases.
- Backend consumers of the absolute `cwd` (anything other than the `session_dims.repository` derivation, including the `cwd` event field and MAX_PATH_BYTES handling in `otlp.py`) now receive the short value; not verifiable from this repo.
- Historical rows keep their full paths, and the `cwd` field now means a repository identifier rather than a working directory.
