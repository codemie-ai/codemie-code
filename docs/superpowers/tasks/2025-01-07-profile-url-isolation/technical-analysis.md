# Technical Research

**Task**: profile config setup sso
**Generated**: 2026-09-23
**Research path**: filesystem

---

## 1. Original Context

Fix bug EPMCDME-15192: When a user updates the URL for one CodeMie CLI profile via 'codemie setup' → 'Update existing profile', the URL is unexpectedly updated for all other profiles instead of just the selected profile. This prevents users from maintaining different URLs per profile. Steps to reproduce: run 'codemie setup', select 'Update existing profile', update the URL of the SSO auth method, finish — all profiles end up sharing the same CodeMie URL. Expected: only the selected profile's URL changes; other profiles keep their existing URL values. Actual: after updating the URL for one profile, the same URL propagates to all other configured profiles. Acceptance criteria: (1) Updating the URL for one profile changes only that profile. (2) Other profiles keep their existing URL values after the update. (3) Profile configuration is persisted independently per profile. (4) Regression coverage is added or updated for multiple profiles with different URL values.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/setup.ts` — `runSetupWizard()` / `handlePluginSetup()`. Drives both "Add a new profile" and "Update an existing profile": calls `setupSteps.getCredentials(isUpdate)`, builds config via `setupSteps.buildConfig()`, and persists it with `ConfigLoader.saveProfile(finalProfileName, config)` (global) or `ConfigLoader.initProjectConfig()` (local). Add and Update share the same save code (`setup.ts:302-344`), so adding a profile triggers the same leak as updating one. For updates the storage location is not chosen by the user: `storageLocation = hasLocalConfig ? 'local' : 'global'` (`setup.ts:112`), i.e. it depends on whether the current directory has a local config, not on where the selected profile lives. The profile picker lists global and local profiles together (`ConfigLoader.listProfiles()`, `config.ts:720`).
- `src/providers/plugins/sso/sso.setup-steps.ts` — `SSOSetupSteps.getCredentials()` prompts for the CodeMie URL (`promptForCodeMieUrl`), authenticates, and selects a project. `buildConfig()` sets `codeMieUrl` and `codeMieProject`, and sets `codeMieIntegration` only when one was selected (`sso.setup-steps.ts:175-190`). Because `saveProfile()` merges into `workspace`, a save without an integration leaves the previous integration in place, possibly paired with a different URL.
- Other setup steps: `jwt` stores `codeMieUrl` but no project; `anthropic-subscription` and `moonshot-subscription` store URL and project when connected to CodeMie; `bedrock`, `litellm` and `ollama` never set identity fields, so they rely entirely on the workspace for CodeMie context.
- `src/utils/config.ts` — `ConfigLoader.saveProfile(profileName, profile)` (lines 598-619): loads the multi-provider config, calls `splitProfileAndWorkspace(cleanProfile)`, writes the identity-bearing half into `config.profiles[profileName]`, and merges the rest into **`config.workspace`** — a single object shared by every profile in that scope (`config.workspace = { ...config.workspace, ...workspaceFields }`).
- `ConfigLoader.WORKSPACE_KEYS` (lines 562-572) includes `codeMieUrl`, `codeMieProject`, `codeMieIntegration` alongside unrelated repo-context fields (`hooks`, `plugins`, `assistants`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`).
- `ConfigLoader.resolveWorkspace(workingDir)` (lines 209-221) returns the *whole* workspace object for the local scope if defined, else the global scope's — independent of which profile is active. `ConfigLoader.load()` (line 135-136) then `Object.assign`s this workspace onto the resolved config for every profile in that scope.
- `src/migrations/007-decouple-provider-workspace-config.migration.ts` — the migration that introduced this design. Its own doc comment states the *intent*: "CodeMie connectivity identity ... never mixed across profiles ... these three [codeMieUrl/codeMieProject/codeMieIntegration] resolve as one atomic group" — but the group is scoped per **storage scope** (global/local), not per **profile**.
- `src/cli/commands/profile/index.ts` — `listProfiles()` (line 57) reads `ConfigLoader.resolveWorkspace(workingDir)` and passes a single `workspace.codeMieUrl` to `ProfileDisplay.formatList()` for *all* listed profiles; `profile status` (line 153) passes the same workspace URL to `ProfileDisplay.formatStatus()`.
- `src/agents/plugins/claude/plugin/statusline.mjs:218` — reads the raw global config file and takes `config.workspace?.codeMieUrl` directly, bypassing `ConfigLoader.load()`. It uses that URL for auth headers and the active profile's `baseUrl` for the budget request.
- `initProjectConfig()` (local-storage path, lines 877-917) also calls `splitProfileAndWorkspace`, but it does not merge into an existing file: it writes a new file containing only the saved profile (as `activeProfile`) and its workspace half. A local save therefore does not leak a shared URL to other local profiles — it deletes them, along with any other top-level content of the local file (e.g. `codemieAssistants`). This is a separate data-loss defect with a different mechanism from the ticket's.
- Most runtime consumers of `codeMieUrl` (`sdk-client.ts`, `profile/auth.ts`, skills `require-auth.ts`/`skills-metrics.ts`, proxy `connect-orchestrator.ts`, doctor `AIConfigCheck.ts`, `sso.setup-steps.ts`) read the flat config returned by `ConfigLoader.load()`, so they follow whatever `load()` resolves. SSO credentials are stored and looked up per `codeMieUrl` (`sso.auth.ts:137`, `sdk-client.ts:48-49`).

### Architecture and Layers Affected

- **CLI command layer**: `src/cli/commands/setup.ts` (setup wizard, "Update existing profile" branch), `src/cli/commands/profile/index.ts` (display).
- **Provider plugin layer**: `src/providers/plugins/sso/sso.setup-steps.ts` (credential/URL collection for the SSO auth method named in the ticket).
- **Config/persistence layer**: `src/utils/config.ts` (`ConfigLoader.saveProfile`, `splitProfileAndWorkspace`, `resolveWorkspace`, `load`, `loadWithSources`) — this is where the cross-profile leak actually happens.
- **Agent plugin layer**: `src/agents/plugins/claude/plugin/statusline.mjs` — raw-file reader of `workspace.codeMieUrl`.
- **Migration layer**: `src/migrations/007-decouple-provider-workspace-config.migration.ts` — the historical migration that moved `codeMieUrl` out of `ProviderProfile` and into the shared `WorkspaceConfig`; any schema-level fix likely needs a companion migration here.

### Integration Points

- `ProviderRegistry.getSetupSteps('ai-run-sso')` → `SSOSetupSteps` supplies the URL entered by the user during setup.
- `ConfigLoader.saveProfile` / `initProjectConfig` are the only two write paths from the setup wizard; both funnel identity fields through the same `splitProfileAndWorkspace` helper. Only `saveProfile` merges into an existing `workspace`; `initProjectConfig` rewrites the file.
- `ConfigLoader.load()`, `loadWithSources()`, `profile/index.ts` (`listProfiles()`, profile status) and `statusline.mjs` are the read paths that consume the shared `workspace.codeMieUrl` — any fix affects what these display/resolve too.

### Patterns and Conventions

- Config types: `ProviderProfile` (per-profile identity) vs. `WorkspaceConfig` (scope-level, "repo/tooling-context") in `src/env/types.ts` (lines ~105-206); `CodeMieConfigOptions = ProviderProfile & WorkspaceConfig`.
- `splitProfileAndWorkspace()` is the single chokepoint that decides which fields are per-profile vs. shared; both `saveProfile()` and `initProjectConfig()` call it.
- Migrations follow a `Migration` interface registered via `MigrationRegistry.register()` (see `src/migrations/007-...ts` and `src/migrations/001-config-rename.migration.ts`), each with an idempotent `up()`/`migrate()`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/usage/project-config.md` — documents profile resolution priority (`cli > env > project > global > default`) and a "Team project context with a selected provider profile" section (line 148) describing when a *local team profile's* `codeMieUrl`/`codeMieProject` is allowed to overlay a *global* profile (only when the selected profile defines no project/integration and the URLs are compatible). **This section is stale**: it describes pre-#502 behavior. #502 deleted the implementing code (`PROJECT_FIELDS`, `filterProjectFields`, `shouldPreserveProjectContext`) and replaced it with `resolveWorkspace()`'s whole-object override; no URL-compatibility check exists in the current `config.ts`.
- No guide describes `saveProfile`'s workspace-splitting behavior explicitly as a caveat; it's discoverable only from `config.ts` and the migration file.

### Architectural Decisions

- Migration `007-decouple-provider-workspace-config` (introduced in commit `d2cad9b`, `feat(config): decouple provider config from workspace config (#502)`, released in CHANGELOG 0.15.0 as "Provider configuration is decoupled from workspace configuration") is the deliberate design decision that produces this bug's symptom: `codeMieUrl`/`codeMieProject`/`codeMieIntegration` were intentionally pulled out of `ProviderProfile` into a `WorkspaceConfig` that is shared per **scope** (global or local), on the stated rationale that these three fields must stay consistent together ("never mixed across profiles"). The ticket's expectation (each profile keeps its own URL) is the opposite of that stated rationale, so a fix must either scope `workspace` per-profile, or stop routing `codeMieUrl` through the shared-workspace path in `saveProfile`/`splitProfileAndWorkspace`.
- #502's own spec (`docs/superpowers/tasks/2026-08-25-profile-provider-decoupling/spec.md`) states the motivation: switching `activeProfile` (e.g. `codemie-sso` → `anthropic`) must not drop CodeMie project context, hooks, plugins or metrics. For identity fields this matters only for profiles whose provider never collects a CodeMie URL. The same spec explicitly accepted that migration 007 keeps one profile's identity trio per scope and silently drops divergent identities on other profiles — so pre-0.15.0 per-profile URLs cannot be recovered from current config files.
- Before #502, `saveProfile()` wrote the whole profile into `profiles[name]` with no shared state (`git show d2cad9b^:src/utils/config.ts`, line 596), so the ticket's bug did not exist. On load, a differently-named local team profile could contribute only `codeMieProject`/`codeMieIntegration`/`codeMieUrl`, and only when the selected global profile defined no project or integration of its own and `shouldPreserveProjectContext()` judged the URLs compatible (equal after trailing-`/` strip and lower-casing, or either missing).
- The existing test `saveProfile routes workspace fields into the global scope workspace, not into profiles[name]` (`src/utils/__tests__/config-project-override.test.ts:395-410`) is a direct, passing assertion of today's behavior — it explicitly expects `config.profiles.p1.codeMieUrl` to be `undefined` and `config.workspace.codeMieUrl` to hold the value. Any fix will need to update or replace this test's expectations, since it currently codifies the reported bug as intended behavior.

### Derived Conventions

- Fields considered "identity" (must travel together, currently scope-shared): `codeMieUrl`, `codeMieProject`, `codeMieIntegration`.
- Fields considered "other workspace" (independent, currently scope-shared): `hooks`, `plugins`, `assistants`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`.

---

## 4. Testing Landscape

### Existing Coverage

- `src/utils/__tests__/config-project-override.test.ts` — extensive coverage of `ConfigLoader.load()`/`loadWithSources()` priority resolution across global/local/env/CLI layers, including several cases with multiple profiles each defining their own `codeMieUrl` (e.g. lines 492-554, 686-735) — but these tests only exercise **reads** of pre-written JSON fixtures where `workspace` was hand-crafted; none of them exercise `saveProfile()` being called twice for two different profiles with two different URLs and then asserting isolation.
- `src/migrations/__tests__/007-decouple-provider-workspace-config.migration.test.ts` — covers the migration's own merge logic (which profile's identity trio "wins" when migrating legacy configs), not the ongoing runtime behavior of `saveProfile`.

### Testing Framework and Patterns

- Vitest (`vitest run --project unit|cli|agent`), per `package.json` scripts. Config tests use `fs`-backed temp directories with `beforeEach`/`afterEach` cleanup and spies on `ConfigLoader`'s lazy path getters (see comment at `config.ts:38-47`).

### Coverage Gaps

- No test exercises the `codemie setup` → "Update existing profile" flow at all — no test file matches `setup.ts`'s `runSetupWizard`/`handlePluginSetup` (confirmed via search; only `setup.ts` itself references those symbols).
- No test calls `ConfigLoader.saveProfile()` twice for two distinct profiles with two distinct `codeMieUrl` values and asserts both profiles retain their own URL afterward — this is precisely acceptance criteria (1)/(2)/(3) and is currently untested (the one related test asserts the opposite outcome).
- `initProjectConfig()` has no test asserting that saving one local profile preserves other local profiles; such a test would currently fail because the function rewrites the whole file.
- `statusline.mjs` has tests (`src/agents/plugins/claude/plugin/__tests__/statusline.test.ts`) that assert the URL is read from `workspace.codeMieUrl`; the test at line 200 explicitly asserts that a `codeMieUrl` present only on the profile is ignored.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_URL` — read in `ConfigLoader.loadFromEnv()` into `env.codeMieUrl`; can override the resolved profile/workspace value.
- `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`, `CODEMIE_MODEL` — used by `FirstTimeExperience.isFirstTime()` and `ConfigLoader.validate()`, not directly related to the bug but part of the same config surface.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — global multi-provider config; holds `profiles: Record<name, ProviderProfile>`, `activeProfile`, and the shared `workspace: WorkspaceConfig` object implicated in this bug.
- `<repo>/.codemie/codemie-cli.config.json` — local/project equivalent, written by `ConfigLoader.saveLocalMultiProviderConfig()`/`initProjectConfig()`. When it defines `workspace` (`!= null`), `resolveWorkspace()` uses it as a whole and ignores the global `workspace` entirely for commands run in that directory — including identity fields, even if the local `workspace` holds only tooling fields. Only the current directory is checked; parent directories are not searched.

### Feature Flags and Deployment Concerns

None found specific to this feature area.

---

## 6. Risk Indicators

- **Root cause is a deliberate architectural decision (#502, migration 007), not an oversight** — a fix must keep #502's goal: profiles without their own CodeMie identity (non-CodeMie providers such as `bedrock`, `litellm`, `ollama`) still get it from the workspace. Moving identity back to purely per-profile storage would regress that.
- **A passing test currently asserts the buggy behavior as correct** (`config-project-override.test.ts:395-410`); the fix must change this test's expectations, and the acceptance criteria explicitly call for new/updated regression coverage for the multi-profile case.
- **The two write paths fail differently** — `saveProfile` (global) leaks identity across profiles via the shared `workspace`; `initProjectConfig` (local) deletes other local profiles by rewriting the file. Only the first is the ticket's defect.
- **Downstream read paths consume the shared workspace URL** (`ConfigLoader.load()`, `loadWithSources()`, `profile/index.ts` via `resolveWorkspace()`, and `statusline.mjs` via the raw file) — changing where `codeMieUrl` is stored requires updating all of them, including the raw-file reader that bypasses `load()`.
- **Guide drift** — `.ai-run/guides/usage/project-config.md` describes a URL-compatibility gate that no longer exists in code; it cannot serve as the reference for current behavior.
- **Existing configs carry no per-profile identity** — migration 007 already removed it and discarded divergent values. Any change that relies on per-profile identity must still resolve existing profiles (via fallback or migration), and cannot restore values 007 dropped.
- **No test coverage at all for the `codemie setup` wizard's update flow** (`setup.ts`) — the bug's actual trigger point (interactive "Update existing profile" → SSO URL prompt → save) has zero existing regression tests to build on.

---

## 7. Summary for Complexity Assessment

The bug lives at the config-persistence layer, not in the CLI wizard or the SSO provider plugin themselves: `ConfigLoader.saveProfile()` calls `splitProfileAndWorkspace()`, which intentionally routes `codeMieUrl`/`codeMieProject`/`codeMieIntegration` out of the per-profile `ProviderProfile` object and merges them into the single global `workspace` object shared by every global profile; `load()` then applies that workspace to whichever profile is active. Both "Add" and "Update" in `codemie setup` trigger it. This was a deliberate design change (#502, migration `007-decouple-provider-workspace-config`, released in 0.15.0) that assumed one CodeMie installation per config file, which is exactly why updating one profile's URL overwrites the value read by all profiles. The local save path (`initProjectConfig()`) has a different defect — it rewrites the whole local file — and is not the ticket's mechanism.

The change surface is narrow (primarily `src/utils/config.ts`: `saveProfile`, `splitProfileAndWorkspace`, `WORKSPACE_KEYS`, `load`, `loadWithSources`; plus `src/env/types.ts`, `profile/index.ts`/`display.ts`, and `statusline.mjs`), but the blast radius is wider than the file count suggests: existing tests assert today's shared-workspace behavior (`config-project-override.test.ts:395-410`, statusline tests), every read path must keep resolving correctly per active profile, profiles without their own identity must keep the workspace fallback that #502 introduced, and there is no existing test coverage of the `codemie setup` wizard flow.

Technical novelty is low (no new libraries or external integrations), but the fix requires reasoning carefully about a documented, tested architectural trade-off rather than a simple oversight. The chosen design is recorded in `spec.md`.

---

## 8. External References

None named by the task.
