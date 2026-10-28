# Technical Research

**Task**: config profile workspace identity resolution cli (EPMCDME-15411)
**Generated**: 2026-10-27
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15411 — Global profiles share workspace identity; switching profiles applies wrong CodeMie URL and project.

Bug: The CodeMie CLI profile setup flow stores identity fields for global profiles in a shared workspace-level configuration object instead of keeping them isolated per profile. A user who configures multiple global profiles for different CodeMie environments (or same URL, different projects) can switch back to an earlier profile but still receive environment values (codeMieUrl, codeMieProject, codeMieIntegration) from the most recently configured profile. This routes CLI commands (e.g. codemie-claude) and analytics attribution to the wrong CodeMie environment/project.

Root cause reported in src/utils/config.ts:
```javascript
config.workspace = { ...config.workspace, ...workspaceFields };
```
`ConfigLoader.saveProfile()` merges identity keys into a single shared `config.workspace` object, and `resolveProfileWorkspace()` reads identity for global profiles from that same shared global workspace, instead of from profile-specific data.

Acceptance criteria:
1. Each global profile stores and resolves its own CodeMie identity independently.
2. Switching between global profiles applies the selected profile's own CodeMie URL and project.
3. `codeMieUrl`, `codeMieProject`, and `codeMieIntegration` are not overwritten across unrelated global profiles.
4. `resolveProfileWorkspace()` resolves identity for a global profile from profile-specific data instead of a shared mutable workspace identity.
5. Existing local profile behavior is not regressed.
6. Existing workspace behavior is not regressed.
7. Regression coverage is added for at least two global profiles targeting different CodeMie environments.
8. Regression coverage verifies that switching back to the first global profile restores that profile's CODEMIE_URL, project, and integration.

feature_area: config profile workspace identity resolution cli
run_dir: docs/superpowers/tasks/2026-10-27-global-profiles-share-workspace-identity/

---

## 2. Codebase Findings

### Existing Implementations

- `src/utils/config.ts` — `ConfigLoader` class, the single source of truth for profile/workspace load, save, and resolution.
  - `saveProfile()` (line 650) — splits an incoming profile object into `profileFields` (stored at `config.profiles[profileName]`) and `workspaceFields` (merged into the single shared `config.workspace`). The merge line `config.workspace = { ...config.workspace, ...workspaceFields }` (line ~662) is the exact root cause: every global profile writes into the same object.
  - `resolveWorkspace(workingDir)` (line 209) — whole-object override: returns local scope's `workspace` if defined, else global scope's `workspace`. Not per-profile.
  - `resolveProfileWorkspace(workingDir, isLocalProfile)` (line 233) — for a local profile, returns `resolveWorkspace()`; for a **global** profile, forces identity keys (`IDENTITY_KEYS`) to always come from `(await this.loadMultiProviderConfig()).workspace` — i.e. the single shared global `workspace` object, regardless of which profile is active. This is the exact function the ticket names as needing a per-profile fix.
  - `resolveIdentitySource()` (line 254) — labels which scope supplied identity, used only for `--show-sources` diagnostics.
  - `splitProfileAndWorkspace()` (line 631) plus `IDENTITY_KEYS` (line 603) and `WORKSPACE_KEYS` (line 614) constants — define which fields are profile-local vs. workspace-shared. Any fix re-keying identity per-profile must touch these lists/constants.
  - `initProjectConfig()` (line 929) — same split/merge pattern applied to local/project scope; isolated per working directory (not per profile name), so it is NOT affected by the bug as described, but any refactor must keep this path symmetric.
  - `switchProfile()` (line 728), `listProfiles()` (line 772), `getProfile()` (line 842), `load()` (line 91), `loadWithSources()` (line 1253) — all consume/display resolved identity; `loadWithSources()` duplicates `resolveWorkspace()`'s local-else-global logic (lines ~1282-1321) and must be kept in sync with any fix.
  - `exportProviderEnvVars()` (line 1479) — exports `CODEMIE_PROVIDER`, `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`, `CODEMIE_MODEL`, etc.; does not directly re-export identity fields here (provider templates may).
  - `multiProviderCache` (static in-memory cache) — invalidated only in `saveGlobalConfig()`; any identity-resolution change must handle cache invalidation carefully.

- `src/env/types.ts` — type definitions.
  - `ProviderProfile` (line 51) — per-profile fields (provider, baseUrl, apiKey, model, etc.). **Contains no `codeMieUrl`/`codeMieProject`/`codeMieIntegration` and no `isGlobal`/`scope` field** — this is the structural gap: there is currently nowhere on the profile object itself to pin per-profile identity.
  - `WorkspaceConfig` (line 105) — `codeMieUrl?`, `codeMieProject?`, `codeMieIntegration?`, plus unrelated tooling fields `hooks?`, `plugins?`, `assistants?`, `skillsSearchUrl?`, `claudeAutocompactPct?`, `metrics?`. One instance per scope (global or local), not per profile.
  - `MultiProviderConfig` (line 176) — `{ version: 2, activeProfile, profiles: Record<name, ProviderProfile>, workspace?: WorkspaceConfig, codemieSkills?, codemieAssistants?, userEmail? }`. The single shared `workspace` field at root is the bug's locus.
  - `LegacyConfig` (line 149) — version-1 shape; embeds identity fields directly, no `workspace` object. Must remain supported during any migration.
  - `CodeMieConfigOptions = ProviderProfile & WorkspaceConfig` (line 206) — runtime-merged type consumers see after `ConfigLoader.load()`.
  - `StorageScope` enum (`GLOBAL`/`LOCAL`) — distinguishes scope at the file level only; no per-profile scope flag exists.

- `src/migrations/007-decouple-provider-workspace-config.migration.ts` — the migration that introduced the current shared-`workspace`-per-scope design, moving identity fields out of per-profile storage. Comment calls the identity trio "an atomic group... never mixed across profiles," but that guarantee only holds within a single migration run, not across repeated `saveProfile()` calls for different global profiles. Idempotent: treats `config.workspace !== undefined` (including `{}`) as "already migrated."

- `src/cli/commands/setup.ts` — profile setup wizard, the UI entry point that triggers the bug.
  - Line 345: global-profile path calls `ConfigLoader.saveProfile(finalProfileName!, config as any)` when `storageLocation !== 'local'`. Each time a user sets up a new global profile with a different `codeMieUrl`/`codeMieProject`, it overwrites the one shared `config.workspace`.
  - Line 312: local-profile path calls `ConfigLoader.initProjectConfig()` instead — correctly isolated per working directory (not per profile), unaffected by this bug.

- `src/cli/commands/profile/index.ts` (lines 52-73) — `listProfiles()` calls `resolveProfileWorkspace(workingDir, true/false)` to display `codeMieUrl` per profile; currently shows the same (wrong) URL for every global profile.

- `src/agents/plugins/claude/plugin/statusline.ts` (line 730) — reads `config.workspace?.codeMieUrl` directly, bypassing `ConfigLoader.resolveProfileWorkspace` — another direct consumer of the shared shape that must stay consistent with any fix.

- `docs/superpowers/tasks/2026-08-25-profile-provider-decoupling/spec.md` — the ADR that deliberately introduced this design. It explicitly documents the whole-object-override rule and the identity-trio atomicity rule (single source, never mixed per-field) — but at scope level, not per-profile level. This spec is the direct ancestor of the current bug.

### Architecture and Layers Affected

- **CLI command layer**: `src/cli/commands/setup.ts` (profile creation wizard — the write path that triggers the bug), `src/cli/commands/profile/index.ts` (profile list/switch/status — the read path that surfaces the bug).
- **Config persistence/resolution layer**: `src/utils/config.ts` (`ConfigLoader`) — the layer requiring the actual fix (`saveProfile`, `resolveProfileWorkspace`, `resolveWorkspace`, `splitProfileAndWorkspace`, `IDENTITY_KEYS`/`WORKSPACE_KEYS`, `loadWithSources`).
- **Type/schema layer**: `src/env/types.ts` (`ProviderProfile`, `WorkspaceConfig`, `MultiProviderConfig`) — likely needs a new field or structural change (e.g. moving identity fields back onto `ProviderProfile`, or keying workspace identity by profile name) to support per-profile isolation.
- **Migration layer**: `src/migrations/` — a new migration will likely be needed to move existing users' shared `workspace` identity data into a per-profile shape, following the numbered-migration pattern (e.g. `006-...`, `007-...`).
- **Env-export layer**: `exportProviderEnvVars()` plus 47 files across agent plugins/provider templates that read `CODEMIE_URL`/`CODEMIE_INTEGRATION_*` at runtime — the downstream blast radius if identity resolves incorrectly (wrong CodeMie environment routed to `codemie-claude` etc.).
- **Display layer**: `src/cli/commands/profile/display.ts` (`ProfileDisplay.formatList`), `src/agents/plugins/claude/plugin/statusline.ts` — both must reflect per-profile identity once fixed.

### Integration Points

- `src/cli/commands/setup.ts` → `src/utils/config.ts` (`saveProfile`, `initProjectConfig`, `switchProfile`, `listProfiles`, `getActiveProfileName`).
- `src/cli/commands/profile/index.ts` → `src/utils/config.ts` (`resolveProfileWorkspace`, `listProfiles`, `hasLocalConfig`).
- `src/utils/config.ts` → `src/env/types.ts` (type imports) and → `src/providers/index.js` (`ProviderRegistry`, for `exportProviderEnvVars()`).
- `src/migrations/007-decouple-provider-workspace-config.migration.ts` → `src/utils/config.ts` (calls `hasGlobalConfig`/`loadMultiProviderConfig`/`saveMultiProviderConfig`/etc.) and → `src/env/types.ts`.
- `src/agents/plugins/claude/plugin/statusline.ts` → reads `config.workspace?.codeMieUrl` directly, bypassing `ConfigLoader.resolveProfileWorkspace`.
- `src/agents/core/BaseAgentAdapter.ts`, provider templates (`sso.template.ts`, `jwt.template.ts`, etc.), and agent plugins (`codex.plugin.ts`, `opencode.plugin.ts`, etc.) consume exported `CODEMIE_URL`/`CODEMIE_INTEGRATION_*` env vars derived from the resolved (currently shared) workspace — this is the real-world blast radius described in the bug report.
- External dependency: `dotenv` loads `.env` before env-var config layer is read; `chalk` for CLI display; no DB/ORM — persistence is flat JSON via `fs/promises`.

### Patterns and Conventions

- **Scope-level, not profile-level, workspace storage** — `MultiProviderConfig.workspace` is one object per scope (global file has one `workspace`; each local `.codemie/` config file has its own one `workspace`). Deliberate simplification from the profile-provider-decoupling spec, but is the root cause for global profiles since multiple global profiles compete for the one global `workspace` object.
- **Whole-object-override merge across scopes, field-level merge within a scope** — `resolveWorkspace()` picks local `workspace` XOR global `workspace` wholesale; but `saveProfile()` does a field-level spread merge within the single global scope, which is what lets fields from profile A leak into profile B's view.
- **IDENTITY_KEYS vs WORKSPACE_KEYS split** — identity fields (`codeMieUrl`, `codeMieProject`, `codeMieIntegration`) are treated as an atomic "must all come from the same source" trio, distinct from other tooling-context workspace fields (`hooks`, `plugins`, `assistants`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`), which resolve independently per key.
- **Local vs global distinguished structurally by file location**, not a per-profile flag — `StorageScope.LOCAL`/`StorageScope.GLOBAL` plus two physically separate JSON files (`~/.codemie/codemie-cli.config.json` vs `<workingDir>/.codemie/codemie-cli.config.json`). No `isGlobal` field exists on `ProviderProfile`.
- **"First profile becomes active" convention** — `saveProfile()` sets `config.activeProfile = profileName` only if `Object.keys(config.profiles).length === 1`.
- **Idempotent migration guard** — migration 007 treats `config.workspace !== undefined` as "already migrated," never overwrites.
- **removeUndefined() helper** used before `Object.assign` merges to avoid clobbering with `undefined`.
- **load() / loadWithSources() duplication** — intentionally duplicate profile-resolution/merge logic (source-tracking is the only difference); any fix must patch both symmetrically.
- **Lazy getter/setter for class statics** — `ConfigLoader.GLOBAL_CONFIG_DIR`/`GLOBAL_CONFIG` were converted from static fields to lazy getters specifically so test spies (`vi.spyOn(paths, ...)`) attach before module-load-time field initialization runs. Any new workspace-resolution statics must follow this same pattern.
- **Backward compatibility requirement** — `LegacyConfig` (version 1) still embeds identity fields inline with no `workspace` object; any per-profile identity fix must handle both legacy and v2 shapes during migration.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/usage/project-config.md` (P0 for config/profile/env/setup) — documents the **current target contract** that the bug violates: "A local profile ... uses the local workspace, falling back to the global one when the local config has none. A global profile always uses the global workspace, even inside a repository with a local config." This confirms `resolveProfileWorkspace()`'s global-profile branch is working exactly as documented — the documented design itself is what needs to change (global profile should use *its own* identity, not simply "the global workspace"). Also documents config priority (CLI > env > project > global > default) and the `ConfigLoader` method table.
- `.ai-run/guides/architecture/architecture.md` — 5-layer architecture (CLI → Registry → Plugin → Core → Utils); `ConfigLoader` sits in the Utils layer. Flow rule: never skip layers.
- `.ai-run/guides/development/development-practices.md` — error handling via `CodeMieError`/`ConfigurationError` subclasses and `createErrorContext()`; async/await only; ES module imports with `.js` extensions. Config-specific: "Validate config at startup with ConfigLoader," "Use profiles for user-specific settings." Points to `src/env/config-loader.ts` as a separate reference module (worth checking for overlap/duplication during implementation).
- `.ai-run/guides/testing/testing-patterns.md` — Vitest conventions: dynamic `import()` inside test body/`beforeEach` after `vi.spyOn()` setup; `vi.restoreAllMocks()` in `afterEach`. Documents the prior fix converting `ConfigLoader.GLOBAL_CONFIG_DIR`/`GLOBAL_CONFIG` to lazy getters for exactly this reason — directly relevant to any new statics introduced by the fix.

### Architectural Decisions

- `docs/superpowers/tasks/2026-08-25-profile-provider-decoupling/spec.md` — **the ADR that created this exact subsystem and is the direct ancestor of the bug.** Introduced `WorkspaceConfig` and `MultiProviderConfig.workspace`, moving identity fields out of per-profile storage into a shared scope-level object. Explicit rule: workspace resolves as a whole-object override, not a per-field merge. Added migration `006/007-decouple-provider-workspace-config.migration.ts`, with a "CR-007" fix splitting resolution into identity-trio (atomic) vs. everything-else (per-field). Noted open risk at the time: classification of `metrics` as workspace vs. provider-level was a judgment call, unconfirmed.
- `docs/superpowers/tasks/2026-06-29-cross-env-project-fields-leak/technical-analysis.md` — predecessor bug: the old `PROJECT_FIELDS`/`filterProjectFields` mechanism leaked identity fields across environments when `--profile` differed from the local active profile; fixed via URL-equality gating. Superseded by the profile-provider-decoupling spec, which (ironically) reintroduced a related leak at the global-profile level — the current ticket.
- `CHANGELOG.md [0.15.0]` — "Provider configuration is decoupled from workspace configuration" — the shipped changelog entry for the spec above.
- No NOTE/HACK/TODO/ADR/DECISION-tagged inline comments exist in `src/utils/config.ts` — only descriptive doc comments explaining the whole-object-override and identity-trio design (not flagged as questionable).

### Derived Conventions

- Inline URL/field normalization uses simple one-liners (e.g. `url.replace(/\/+$/, '').toLowerCase()`), not a shared utility, to avoid a `utils → providers` cross-layer import.
- `load()`/`loadWithSources()` duplicate merge logic intentionally; patch both symmetrically.
- Single-quotes, `.js`-suffixed ESM imports, explicit return types apply to any new code in `config.ts`.
- Tests use real temp directories + `vi.spyOn(paths, 'getCodemieHome'/'getCodemiePath')`, not full module mocks.

---

## 4. Testing Landscape

### Existing Coverage

- `src/utils/__tests__/config-project-override.test.ts` — the de facto `config.ts` test suite (no file is literally named `config.test.ts`). Covers `initProjectConfig`, `hasLocalConfig`/`hasProjectConfig`, `loadWithSources` priority ordering, a `saveProfile / initProjectConfig — workspace split` block (lines 394-425) asserting `saveProfile` routes identity fields into `config.workspace` (global scope) rather than `profiles[name]`, and a large `ConfigLoader - workspace resolution and project-only composition` block (lines 428-737).
  - **Critical finding**: the test `'switching the selected global profile does not drop workspace context'` (lines 653-677) currently **asserts the buggy behavior as correct** — it writes one shared `globalRaw.workspace = { codeMieProject: 'shared-proj' }`, loads two different global profiles, and asserts both resolve to the same `'shared-proj'` value. This test must be rewritten (not merely supplemented) as part of the fix.
- `src/cli/commands/profile/__tests__/index.test.ts` — tests profile list UI rendering; fully mocks `ConfigLoader` via `vi.mock(...)`, so it does not exercise real resolution logic. Will need its mocks/expectations reviewed if the resolved shape changes.
- `src/utils/__tests__/config.migration.test.ts` — unrelated legacy-config migration tests; no hits for `saveProfile`/`resolveProfileWorkspace`/`workspace`.
- `src/migrations/__tests__/007-decouple-provider-workspace-config.migration.test.ts` — tests for the migration that introduced the current shared-workspace shape; relevant background, not current-bug coverage.

### Testing Framework and Patterns

- Vitest `^4.1.5` (package.json devDependency).
- Real filesystem fixtures (not mocked `fs`): `TEST_DIR = path.join(process.cwd(), 'tmp-test-config')` with `.codemie/` (global) and `project/.codemie/` (local) subdirs created in `beforeEach`, removed in `afterEach`.
- Global/local config paths redirected via `vi.spyOn(paths, 'getCodemieHome'/'getCodemiePath')`.
- `ConfigLoader.GLOBAL_CONFIG`/`GLOBAL_CONFIG_DIR` statics saved/overridden directly per test (with an explicit comment that `vi.spyOn` on `paths` is too late for statics evaluated at module load time), restored in `afterEach`.
- Helper functions `writeGlobal(activeProfile, profiles)`/`writeLocal(activeProfile, profiles)` build a `MultiProviderConfig` and write it as JSON; callers hand-edit the parsed JSON (e.g. `globalRaw.workspace = {...}`) since the helpers don't accept a `workspace` param directly.
- Env var cleanup (`delete process.env.CODEMIE_*`) repeated in every `beforeEach`.
- `vi.restoreAllMocks()` in `afterEach`.

### Coverage Gaps

- No test exists with **two global profiles pointing at different CodeMie environments** (distinct `codeMieUrl`/`codeMieProject`/`codeMieIntegration` per profile) verifying independent resolution — this is acceptance criterion 7, currently absent.
- No test asserts **switch-back** behavior: switch to global profile A, switch to global profile B, switch back to A, confirm A's own identity is restored (acceptance criterion 8) — currently absent.
- The one existing "switching global profiles" test encodes the bug as expected/passing behavior and must be rewritten.
- No test for `saveProfile` called twice for two different profile names asserting the resulting workspace storage does not collapse/overwrite distinct identities.
- No regression test confirming local-profile behavior (lines 557-651, local-overrides-global and `workspace: null` fallback) remains unaffected once the fix lands — should be re-run/extended post-fix (acceptance criteria 5, 6).
- No direct unit test of `resolveProfileWorkspace()` in isolation — only exercised indirectly through `ConfigLoader.load()`/`loadWithSources()`, or via a fully-mocked stand-in in the CLI profile test.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — overrides base config directory (`src/utils/paths.ts:367-373`; `getCodemieHome()` priority: env var → `~/.codemie`).
- `CODEMIE_URL` → `config.codeMieUrl` (identity field). Env var name differs from the field name.
- `CODEMIE_AUTH_METHOD` → `config.authMethod`.
- `CODEMIE_INTEGRATION_ID` / `CODEMIE_INTEGRATION_ALIAS` → combined into `config.codeMieIntegration = { id, alias }` (identity field).
- No `process.env.CODEMIE_PROJECT` read exists anywhere in `src/` — `codeMieProject` is set only via config file / CLI setup flow, not an env var, despite the ticket's phrasing of "codeMieProject" alongside env-var-style names. Worth flagging to the implementer in case the ticket author conflated config-file field with env var.
- Generic provider/runtime env vars (not identity): `CODEMIE_PROVIDER`, `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`, `CODEMIE_MODEL`, `CODEMIE_TIMEOUT`, `CODEMIE_DEBUG`, `CODEMIE_ALLOWED_DIRS`, `CODEMIE_IGNORE_PATTERNS`.
- `exportProviderEnvVars()` (config.ts:1479) emits `CODEMIE_PROVIDER`, `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`, `CODEMIE_MODEL`, `CODEMIE_REASONING_EFFORT`, model-tier vars, `CODEMIE_TIMEOUT`, `CODEMIE_DEBUG`, `CODEMIE_AUTH_METHOD` — does not directly re-export identity fields here; provider templates may re-export separately.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` (or `$CODEMIE_HOME/codemie-cli.config.json`) — GLOBAL config (`ConfigLoader.GLOBAL_CONFIG`). Holds `MultiProviderConfig`: `{ version: 2, activeProfile, profiles: Record<name, ProviderProfile>, workspace?: WorkspaceConfig, codemieSkills?, codemieAssistants?, userEmail? }`.
- `<workingDir>/.codemie/codemie-cli.config.json` — LOCAL/project config, same shape (`ConfigLoader.LOCAL_CONFIG`).
- `~/.codemie/installation-id` — persistent UUID per install, unrelated to this bug.
- `<workingDir>/.env` — optional, loaded via `dotenv` before env-var resolution.
- No `.env.example` or JSON-schema files exist for this config.
- **No separate "profiles directory" exists** — all profiles for a scope live inside one `profiles: {}` map in that scope's single JSON file, alongside one shared `workspace` object for that scope. This is the structural root of the bug: multiple global profiles share one file and one `workspace` sub-object.

### Feature Flags and Deployment Concerns

- No boolean feature flag toggles global vs. local scope; scope is structural (presence of `<workingDir>/.codemie/codemie-cli.config.json` via `hasLocalConfig()`/`hasProjectConfig()`). `StorageScope` enum is passed as an explicit parameter to several `ConfigLoader` methods, not a persisted flag.
- `applyProjectOnly` guard (`ConfigLoader.load()`, line 124-127) — when the selected global profile name differs from the resolved local profile name, local profile fields are not applied, preventing a project's team-default profile from contaminating a different explicitly-selected global profile. Must remain intact.
- **Migration path required**: any fix moving identity per-profile needs a migration for existing `~/.codemie/codemie-cli.config.json` files, following the existing numbered-migration pattern in `src/migrations/` (e.g. `006-...`, `007-decouple-provider-workspace-config.migration.ts`).
- `CODEMIE_HOME` relocation must keep working post-fix; tests rely on it for isolation (`src/utils/__tests__/vitest-codemie-home-isolation.test.ts`).
- `ConfigLoader.multiProviderCache` (static in-memory cache, cleared only in `saveGlobalConfig()`) — must be invalidated/bypassed correctly once identity resolution changes.
- Backward compatibility: `LegacyConfig` (v1) embeds identity fields directly with no `workspace` object; migration must handle both legacy and v2 shapes.

---

## 6. Risk Indicators

- The one existing test exercising global-profile switching (`'switching the selected global profile does not drop workspace context'` in `config-project-override.test.ts`, lines 653-677) currently asserts the **buggy** behavior as the expected/passing result. The fix will break this test by design; it must be rewritten, not just supplemented — regression risk if overlooked.
- `resolveProfileWorkspace()`'s current global-profile behavior matches the documented contract in `.ai-run/guides/usage/project-config.md` ("A global profile always uses the global workspace"). The fix changes documented, guide-codified behavior — the guide itself will need updating, and any reviewer checking against the guide may initially flag the fix as a guide violation.
- No per-profile `isGlobal`/`scope`/identity field exists on `ProviderProfile` today — the fix likely requires either (a) a structural change to `ProviderProfile`/`MultiProviderConfig` (e.g. keying workspace identity by profile name, or moving identity fields back onto the profile object), or (b) a new per-profile workspace map. Either approach touches the on-disk schema and requires a migration — non-trivial for a "bug fix."
- Backward-compatible migration needed for existing users' `~/.codemie/codemie-cli.config.json` files that already have a single shared `workspace` object with ambiguous origin (which profile's identity does the shared value actually belong to, post-fix?). The migration script will need a judgment call/fallback rule (e.g. assign the shared value to the currently active profile, leave others empty) — a design decision the implementer must make explicit.
- `loadWithSources()` duplicates `resolveWorkspace()`'s resolution logic (lines ~1282-1321 per Thread A); any fix must patch both code paths symmetrically or `--show-sources` diagnostics will drift out of sync with actual resolution.
- `src/agents/plugins/claude/plugin/statusline.ts` reads `config.workspace?.codeMieUrl` directly, bypassing `ConfigLoader.resolveProfileWorkspace()` entirely — a second code path that must be updated/verified or it will keep showing stale/shared identity after the fix.
- `ConfigLoader.multiProviderCache` static in-memory cache could mask the fix in long-running CLI sessions if not properly invalidated when switching profiles — worth explicit verification.
- Lazy-getter pattern for class statics (`GLOBAL_CONFIG_DIR`/`GLOBAL_CONFIG`) exists specifically to make `vi.spyOn` work in tests; any new static state introduced by the fix must follow the same pattern or tests will silently pass against stale paths.
- `src/env/config-loader.ts` is mentioned in `development-practices.md` as a "reference module" distinct from `src/utils/config.ts` — worth confirming during implementation that there isn't a second, parallel config-loading implementation that also needs the fix (not yet directly inspected by research threads).
- Env var naming ambiguity: the ticket references `codeMieProject` as if env-var-backed, but no `CODEMIE_PROJECT` env var exists in code — only a config-file field. Implementer should clarify scope boundaries with the ticket reporter if env-var support is also expected.
- This is the second time this exact field group (codeMieUrl/codeMieProject/codeMieIntegration) has caused a cross-profile/cross-environment leak (first: `docs/superpowers/tasks/2026-06-29-cross-env-project-fields-leak/`, pre-decoupling; now: this ticket, post-decoupling). Any fix should be designed to survive a third iteration — e.g. consider whether per-profile identity storage, rather than another scope-level patch, is the structurally correct fix.

---

## 7. Summary for Complexity Assessment

This task touches a single logical layer (config persistence/resolution in `src/utils/config.ts`) but with meaningful ripple effects: the CLI setup wizard (`src/cli/commands/setup.ts`, write path), the profile list/switch command (`src/cli/commands/profile/index.ts`, read path), a statusline display that bypasses `ConfigLoader` entirely (`src/agents/plugins/claude/plugin/statusline.ts`), the type schema (`src/env/types.ts`), and a likely-needed new data migration (`src/migrations/`). Estimated change surface is 5-8 files for the implementation plus test rewrites, which pushes this toward medium-to-high complexity rather than a narrow one-file bug fix, because the root cause is a *data model* choice (identity stored per-scope, not per-profile) made deliberately in a prior architectural decision (`docs/superpowers/tasks/2026-08-25-profile-provider-decoupling/spec.md`), not a simple logic error. Fixing it correctly requires either restructuring where identity lives on disk (with a backward-compatible migration for existing users' config files) or introducing a new per-profile identity map — both are schema changes, not pure logic changes.

Technical novelty is moderate: the codebase already has the scaffolding for this exact problem (`IDENTITY_KEYS`/`WORKSPACE_KEYS` split, `resolveIdentitySource()`, numbered migration pattern, lazy-getter-for-statics testing convention), so the fix follows established patterns rather than inventing new ones. However, this is the second occurrence of a cross-profile/cross-environment identity leak in this subsystem's history (first fixed via `PROJECT_FIELDS`/URL-equality gating, then "fixed" again by the profile-provider-decoupling spec that introduced the current bug) — this history suggests the underlying design is prone to this class of bug and a durable fix should be favored over another narrow patch.

Test coverage posture is mixed-to-concerning: real test infrastructure exists for this exact area (`config-project-override.test.ts` with real temp-directory fixtures and `vi.spyOn` path redirection), but the one test that specifically covers "switching between global profiles" currently encodes the bug as correct behavior and must be rewritten, not merely extended. No test currently exercises two global profiles with distinct identities, nor a switch-away-and-back scenario — both explicitly required by the acceptance criteria. Key risk factors for complexity scoring: (1) a documented guide (`project-config.md`) currently codifies the buggy contract as intended behavior and will need a coordinated update, (2) a backward-compatible data migration is likely required for existing users, (3) a second, undocumented read path (`statusline.ts`) bypasses the resolution function entirely and must be found/updated independently, and (4) the fix changes a data model that has already caused a related bug once before, raising the bar for "durable" versus "sufficient" fix design.
