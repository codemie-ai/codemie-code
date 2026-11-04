# Spec: Per-profile CodeMie identity for global profiles (EPMCDME-16519 / EPMCDME-15411)

## Problem

All global profiles share one `workspace` identity in `~/.codemie/codemie-cli.config.json`. `saveProfile()` merges identity into it (`src/utils/config.ts:703-724`) and a global profile resolves identity only from it (`config.ts:284-291`). So `codemie-claude --profile mtlx-csd` bills whichever project the last `codemie setup` saved, and nothing shows the project (`src/utils/profile.ts:17-58`, `profile/display.ts`). The reverted #701 (`71093df1`) fixed storage but its migration cloned the leftover project onto every same-URL profile (analysis §2 Purpose E).

## Goal

Each global profile stores and resolves its own CodeMie project and integration. The upgrade never assigns the leftover shared project to a profile on its own. Every session shows the project it bills to.

## Behavior

**Storage.** `ProviderProfile` (`src/env/types.ts:51`) gains optional `codeMieUrl`, `codeMieProject` (`string | null`), `codeMieIntegration`. `codeMieProject: null` means "this profile stays off CodeMie"; a `null` record holds no URL or integration. `saveProfile()` writes identity to the saved profile only; an update that supplies none of the three keeps the stored values. The global `workspace` identity is no longer written and never deleted (legacy fallback).

**Resolution.** One resolver, `(workingDir, profileName, {preferLinkedProject})`, returns the identity plus a state, and replaces `resolveProfileWorkspace`, `resolveProjectOrigin` and `resolveIdentitySource` for project questions. For a global profile:
- `own`: a string `codeMieProject`. Project and integration come from the profile only; an absent integration means none, and the shared integration is never mixed in.
- `none`: `codeMieProject: null`. No project, integration or URL is resolved. No prompt, no warning.
- `unowned`: any other profile of a project-carrying provider. It resolves the shared project and integration. This includes every profile after an upgrade, and the only profile that has a project.
- Providers without the project property (litellm, bedrock, ollama) carry no CodeMie identity of their own: they use a legacy shared (`workspace`) identity when the config has one, and on a new config they get none (setup no longer writes the shared identity). No prompt, no warning, no Project line.

URL: the profile's own `codeMieUrl`, else the shared one, except `none`, which has none. The same rule applies in the standalone statusline (`statusline.ts:705-735`), inline.

`load()` applies the resolver result as the only source of the three identity keys for `own` and `none`: the raw profile record's keys are removed before the resolver result is assigned (undefined means absent), and environment identity (`CODEMIE_URL`, `CODEMIE_INTEGRATION_ID/ALIAS`) is ignored (`config.ts:120-142, 152-199, 536-544`). For these profiles the child environment gets `CODEMIE_PROJECT`, `CODEMIE_URL`, `CODEMIE_INTEGRATION_ID` and `CODEMIE_SYNC_API_URL` only from the resolved config; inherited values are removed (`BaseAgentAdapter.ts:592-594`).

Repo-local profiles keep the local branch (`config.ts:216-227, 279-282`), except that a same-named global `own` or `none` profile supplies identity when the local scope has no project.

**Carrying the state.** The launcher computes the state once, after any prompt, and exports it as output-only `CODEMIE_PROJECT_BINDING` next to `CODEMIE_PROFILE_NAME` (overwritten every launch, an inherited value is cleared). The project is the `CODEMIE_PROJECT` in the same environment. The banner, the warning and hooks read both and do not re-resolve. The evidence record stores the state as `projectBinding` only when it stamps that same environment project, otherwise it omits it. Backend `project_source` is unchanged.

**Launch with an `unowned` profile** (CLI layer, after authentication, before the provider environment is exported). "Cannot prompt" means `--task`, non-TTY stdin or stdout, or `CODEMIE_NO_PROMPTS=1`; silent mode and the resume check keep their current rules.
- *Interactive:* ask once. The list shows the account's projects with the shared project preselected and labelled "(last saved by setup, possibly for another profile)". Picking the shared project asks one confirmation that names it; answering No returns to the list. The same single confirmation is what lets the only project-carrying profile take the shared project.
  - Subscription profiles (anthropic, moonshot) get a last row "Keep this profile off CodeMie" that saves `null`; this session and later launches make no CodeMie call.
  - The pick updates this session's config (environment, `CODEMIE_PROFILE_CONFIG`, banner) and is saved to this profile only, with the profile's own stored URL, else the CodeMie host the project list came from (the profile's `baseUrl` for SSO and JWT, the persisted shared URL for subscription profiles); never the shared URL of another environment. CLI and environment overrides are never saved. The profile is then `own` and never asked again.
  - For providers that require an integration, the integration is selected as setup does for the picked project. A project with no integrations saves none. A fetch error saves nothing and takes the non-interactive path for this launch, so the next interactive launch asks again.
  - Ctrl-C at the list or the confirmation ends the launch before any session starts, saves nothing, and exits 130. Installed inquirer 9.3.8 closes the prompt and re-raises SIGINT rather than throwing `ExitPromptError`/`AbortPromptError`, so the prompt installs its own SIGINT listener (exit 130) for its duration. Esc is not a dismissal.
  - A failed or empty project list takes the non-interactive path.
- *Cannot prompt:* one warning is written to `process.stderr`, whatever the silent mode. It names the profile and the project the session will use (from the merged environment) or "none", and the fix ("launch this profile once in a terminal, or run `codemie setup`"; for a JWT profile "run `codemie setup` with your token available"). The session continues with the shared project.

**Credential host.** The project list is fetched only from the host the credentials were issued for. sso and jwt use `ensureApiBase(baseUrl)`, the profile's own API host (existing rule, `codemie-auth-helpers.ts:131-152, 183-215`); subscription profiles use the stored analytics credentials for their resolved CodeMie URL, never their vendor `baseUrl`. A token or cookie is never sent to a URL whose origin differs from its host; the launch then takes the non-interactive path. Setup sends a pasted token only to the URL typed in that same run.

**JWT setup.** `jwt.setup-steps.ts` gains a project step. `selectCodeMieProject` needs SSO cookies (`codemie-auth-helpers.ts:316-319`), so the shared selection function also accepts a bearer token and calls the existing `fetchCodeMieUserInfo(apiUrl, jwtToken)` overload (`:271-278`). The token comes from the chosen env var, or is pasted once (hidden, never stored or logged), or the step is skipped; skip or failure saves no project and the profile stays `unowned`. No integration is selected for jwt. A project-less JWT CI launch takes the cannot-prompt path.

**Proxy daemon paths.** `proxy connect` and `proxy start` print the same warning for an `unowned` profile and mark `Project:` as the shared fallback. `proxy restart` re-reads the profile's resolved project instead of `state.project`. The hook cold start only logs. `DesktopTelemetryRuntime` (`:473`) loads the daemon's profile by name. Clients routed through one daemon share its project.

**Display.** The banner (`BaseAgentAdapter.ts:624-640`), `codemie profile` (per profile name) and `profile status`/`--show-sources` show the project and its state: own, off CodeMie, or shared fallback.

**Upgrade.** Migration `010` only repairs #701 residue; it never assigns a project. #701's migration id is the known fact `'008-isolate-global-profile-identity'` (from `git show 71093df1:src/migrations/008-isolate-global-profile-identity.migration.ts`); it differs from today's `008-repair-hook-shell-and-stale-paths`, and 009 is `009-raise-otlp-prompt-hook-timeout`, so the ids cannot collide. No release contained #701 without its revert (`71093df1` is not an ancestor of v0.16.1; the revert `0cb83c77` is in v0.16.2-v0.16.4), so only configs that ran unreleased main carry cloned trios. When the ledger holds that id, 010 clears the trio of every global profile whose trio equals the shared trio. When the ledger exists but is unparsable it is moved aside (`migrations.json.corrupt`) and 010 treats #701 as possibly applied and clears the same way; this errs toward asking once more. Profiles with a different trio keep it.

## Security

The derivation source of `X-CodeMie-Project` / `X-CodeMie-Integration` changes (`header-injection.plugin.ts:69-107`). The plan and implementation must pass the CRITICAL checklist in `.ai-run/guides/security/security-practices.md:18-69` (reviewer checklist `:65-69`, single-injector rule `:53`). Header injection stays a consumer of `config.codeMieProject`; no new input path. The recorded outcome also covers: removal of inherited identity from the child environment, `CODEMIE_PROJECT_BINDING` being output-only, no credential sent to a foreign host, and JWT token handling at setup.

## Acceptance Criteria

- AC1: Two global profiles on the same URL with different projects each resolve and export their own project via `--profile X`; saving or updating A never changes B, and switching A → B → A restores A's project. An update that omits identity keeps the stored values.
- AC2: The same holds for two global profiles on different URLs (URL, project and integration all per profile).
- AC3: An upgrade assigns the shared project to no profile. Every project-carrying profile without its own project is `unowned`, including a sole one, until its owner confirms a project at an interactive launch.
- AC4: An interactive launch of an `unowned` profile prompts once.
  - The session bills the pick, and only that profile is saved.
  - Picking the shared project needs a named confirmation (No returns to the list).
  - The integration matches what setup selects. A fetch error saves nothing and warns, and an empty list saves none.
  - The "off CodeMie" row (subscription profiles) saves `null` and makes no CodeMie call.
  - Ctrl-C on a pseudo-terminal exits 130 with no file change and no session start.
  - The profile is never prompted again.
- AC5: A cannot-prompt launch of an `unowned` profile (`--task`, piped stdout, `CODEMIE_NO_PROMPTS=1` on a pseudo-TTY, IDE/ACP) prints one stderr warning naming the project actually used (or "none") and the fix, then continues with the shared project. Silent mode and the resume check are unchanged.
- AC6: A `none` profile makes no CodeMie call (no analytics auth check, credential validation or metrics upload) and exports no project, integration or URL, even when its record still holds a URL or `CODEMIE_URL` is exported.
- AC7: An `own` profile never receives an inherited `CODEMIE_PROJECT` or integration. A litellm/bedrock/ollama profile shows no prompt, warning or Project line.
- AC8: The banner, `codemie profile` and `profile status` (with `--show-sources`) show the resolved project per profile with its state.
- AC9: Local profiles and repo-local workspace resolution are unchanged, except the same-name rule above. One regression case covers active-profile `load()` callers without a profile name now seeing an `own`/`none` profile's identity.
- AC10: The statusline picks the session profile's URL by the inline rule without importing ConfigLoader.
- AC11: JWT setup lists projects with bearer auth and saves the pick; skip or failure saves none. A JWT profile on host A with a shared URL on host B makes no request to B.
- AC12: `proxy connect` with an `unowned` profile warns and marks the fallback; `proxy restart` after the profile gains its own project bills it; Desktop telemetry reports the daemon profile's project.
- AC13: Migration 010 clears #701 trios as described (ledger id present or ledger unparsable), keeps different trios, runs twice concurrently to one outcome, and assigns nothing. A unit check pins the id constant to the string above.
- AC14: The security checklist outcome is recorded.
- AC15: Regression tests cover AC1-AC13 with ≥2 global profiles, same URL and different URLs (written if the user approves testing in the plan).

## Non-goals

- No launcher `--project <name>` override.
- No change to native-hook linked-folder precedence (PR #753's area).
- `CODEMIE_PROJECT` and `CODEMIE_PROJECT_BINDING` never become inputs to `load()`.
- The global `workspace` identity is not removed, and retiring its readers is not planned here.
- `assistants/setup` stays on the active profile.
- No new `project_source` label values sent to the backend.
- No refusal to launch in non-interactive contexts.

## Decisions

- Prompt once in TTY with the shared project preselected over warning-only or launching without a project; answers "what does a TTY launch of an unowned profile do" — user
- Warn on stderr and continue with the shared project over continuing with none or refusing to launch; answers "non-TTY behavior" — user
- Leave out a launcher `--project` override over a session-only flag; answers "--project scope" — user
- URL falls back to shared while integration follows the project rules over falling back as a trio; answers "fallback scope" — user
- JWT setup gains a project step over saving JWT profiles with `null`; answers "how a JWT profile owns a project" — user
- A `none` profile resolves no URL over taking the shared URL; answers "do declined-analytics profiles stay off CodeMie" — user
- The only project-carrying profile gets the shared project only after one named confirmation at its first interactive launch, over silent assignment at upgrade or read time; answers "what does the upgrade assign" — user, answers AR-5
- Add a "Keep this profile off CodeMie" row to the launch prompt for subscription profiles over forcing a project pick; answers "how an older personal profile leaves the prompt" — user, answers AR-8
- A dismissed prompt aborts with exit 130 over continuing with the shared project; answers "what Ctrl-C at the prompt means" — user
- No sole-profile state, marker or auto-assignment: the unowned prompt's named confirmation covers the sole profile, over a separate rule in resolver and migration; answers "how the sole profile is handled"
- Migration 010 repairs #701 residue only (ledger id, or unparsable ledger moved aside) over also assigning the shared project; answers "what 010 does"
- Dismissal is detected with the prompt's own SIGINT listener over `ExitPromptError` names; answers "how Ctrl-C is detected"
- The project list is fetched only from the host the credentials were issued for over the resolved shared URL; answers "credential host"
- For `own` and `none`, `load()` takes identity only from the resolver and ignores environment identity over merging raw record and env; answers "where the identity merge is cut"
- State is carried in `CODEMIE_PROJECT_BINDING` (state only) next to `CODEMIE_PROJECT` over re-resolving per consumer; answers "how banner, warning and evidence agree"
- A fetch error at the integration step takes the warning path and saves nothing over saving a project without an integration; answers "integration fetch failure"
- A failed or empty project list takes the warning path over aborting; answers "list unavailable"
- Prompt/warn check is `--task`, non-TTY stdin/stdout, `CODEMIE_NO_PROMPTS=1`, with silent mode and resume rules unchanged, over merging all predicates; answers "when may anything prompt"
- A same-named global `own`/`none` profile supplies identity to a repo-local profile with no local project over the shared fallback; answers "same-name local profile"
- Providers without the project property use only a legacy shared identity, none on new configs, over a new gate; answers "litellm/bedrock/ollama behavior"
- Proxy connect/start warn, restart re-reads, Desktop telemetry loads the daemon's profile over launcher-only handling; answers "daemon-routed sessions"
- `saveProfile()` stops writing `workspace` identity but leaves it on disk over stripping it; answers "legacy shared identity"
- Migration id 010 over reusing 008; answers "migration numbering" (008/009 taken)

## Risks

- Open PRs #753, #667, #575 overlap `config.ts`, `setup.ts`, `profile/index.ts`, `env/types.ts`.
- Because nothing is assigned at upgrade, every existing project-carrying profile warns (or prompts once). Users who only launch non-interactively keep billing the shared project, visible only via the stderr warning, until they run setup or launch once in a terminal.
- A litellm/bedrock/ollama profile tags hook and analytics events with the legacy shared project when the config has one, while the banner shows none. On a new config it tags them with no project, because setup no longer writes a shared identity (decided in the PR #758 review, finding 5).
- Before 010 runs, shortcut launchers treat #701 residue as own. Only unreleased-main configs are affected.
- The frozen `workspace` identity keeps gaining readers until a later release retires it; downgrade reads and rewrites it.
- Needs the backend owner: whether a missing `X-CodeMie-Integration` changes billing or the LiteLLM key, whether fallback sessions may send `project_source` `none`, and whether the backend verifies project membership.

## Plan notes

- Land the `env/types.ts` change (`IDENTITY_KEYS`, from which `WORKSPACE_KEYS` is built, and `StoredIdentity`) as a small first PR; size the plan at about 30 files; sequence it against #753.
- Saving: a field-level writer sets only the identity keys, does nothing if the profile is gone, and a `null` save removes the stored URL and integration. Global-config and ledger writes are atomic (uniquely named temp file, existing mode, real path) and refuse to overwrite an unparsable file; check each `saveGlobalConfig` caller surfaces a message.
- One policy function (`resolveLaunchIdentity`) holds the prompt or warn decision, in-memory update, save, environment clearing and binding export; `AgentCLI`, `proxy connect/start/restart` and the hook cold start call it. The state union, its text and the parser live in one dependency-free module the statusline may import.
- The prompt-or-warn check sits in `utils/interactive.ts`. The integration step is exported from the SSO plugin; project selection stays in core.
- Tracker: distinguish missing from unparsable ledger; 010 asks the tracker. The resolver parses the global config once per call. Add a contract test between the statusline URL rule and the resolver.
- Launch hygiene: short timeout on the launch-time fetches and measure against an unreachable host; guard the direct stderr write against EPIPE in shortcut launchers; strip control characters from project names in the prompt, banner and warning.
- Touched code also includes `renameProfile` (`config.ts:916-938`) and the daemon state / evidence profile name it does not update. List the active-profile `load()` callers (`sdk-client.ts:33`, `assistants/chat/index.ts:78`, `test-metrics.ts:77`, `skills-search-client.ts`, `skills/lib/require-auth.ts:27`, `skills-metrics.ts:354`, `models.ts:76`, `doctor/checks/*`).
- Update `.ai-run/guides/usage/project-config.md:146-182`.
