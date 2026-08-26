# Technical Research

**Task**: profile provider config migration
**Generated**: 2026-08-25T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

There is profile functionality that allows storing profiles and connections both globally and locally. There is a gap in the existing solution related to additional params stored in profile, like agents and skills, registered via codemie setup assistants. Same applies to project info that is stored at profile level. The idea is to migrate this profile to a different setup to satisfy the following use case: I have various profiles that mostly have different providers configured, but working on the same project and set of assistants. I need to be able to easily switch between providers while preserving other configuration. For example, working with codemie sso and anthropic as providers I still want to work in the same repository with the same set of assistants. There is a need to decouple provider-level configuration from other config to make it more flexible. Also there is a need to do migration to the new format so that it is smooth for end users.

---

## 2. Codebase Findings

### Existing Implementations

- `src/env/types.ts` — `ProviderProfile` interface (the profile schema). Currently a single flat object mixing provider/auth fields (`provider`, `baseUrl`, `apiKey`, `model`, `awsProfile`, `awsRegion`, `haikuModel`/`sonnetModel`/`opusModel`, `authMethod`, `ssoConfig`, `jwtConfig`) with non-provider fields (`codeMieProject`, `codeMieIntegration`, `hooks`, `plugins`, `assistants.maxHistoryMessages`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`). `MultiProviderConfig` wraps `profiles: Record<string, ProviderProfile>` plus top-level `codemieSkills`/`codemieAssistants`/`userEmail`.
- `src/utils/config.ts` — `ConfigLoader` (static class) is the central config read/write surface: `load()`, `loadWithSources()`, `loadMultiProviderConfig()`, `loadLocalMultiProviderConfig()`, `saveMultiProviderConfig()`, `saveLocalMultiProviderConfig()`, `saveConfigByScope()`/`loadConfigByScope()` (scope-generic helpers keyed by `StorageScope`), `PROJECT_FIELDS`-based `filterProjectFields()` (used to preserve only project-context fields when the selected global profile differs from the local team profile), `resolveProfileName()`, `resolveLocalProfileName()`, `listProfiles()`.
- `src/cli/commands/profile/` — `ProfileDisplay` (`display.ts`), profile CLI subcommands (`switch`, `delete`, `rename`, `status`, `login`, `logout`, `refresh`) in `index.ts`; custom interactive profile-picker UI (`promptProfileSelectionCustom`, `renderProfileSelectionUI`).
- `src/migrations/` — an existing "database-style" migration framework already used for exactly this kind of profile-schema evolution:
  - `types.ts` — `Migration` interface (`id`, `description`, `minVersion?`, `deprecatedIn?`, `up(): Promise<MigrationResult>`), `MigrationResult`, `MigrationHistory`.
  - `registry.ts` — `MigrationRegistry` (static in-memory registry; migrations self-register on import via `MigrationRegistry.register(new X())`).
  - `tracker.ts` — `MigrationTracker` persists applied-migration history to `~/.codemie/migrations.json`, exposes `getPendingMigrations()`.
  - `runner.ts` — `MigrationRunner.runPending()` executes pending migrations in `id` order, records history, supports `dryRun`/`silent`.
  - `001-config-rename.migration.ts` … `005-skill-slug-format.migration.ts` — five prior migrations, including **`004-skills-assistants-top-level.migration.ts`**, which already moved `codemieSkills`/`codemieAssistants` from per-profile storage to top-level `MultiProviderConfig` fields, deduplicating by most-recent `registeredAt` across profiles. This is the direct precedent/pattern for the requested provider/non-provider decoupling.
- `src/cli/commands/assistants/setup/` — assistant registration flow (`index.ts`, `helpers.ts`, `selection/`, `manualConfiguration/`); reads/writes via `ConfigLoader`/`loadRegisteredAssistants` against `StorageScope` (global/local), consistent with the already-top-level `codemieAssistants`/`codemieSkills` storage.
- `src/providers/core/` — `ProviderRegistry` (`registry.ts`) and `ProviderTemplate` (`types.ts`) define the provider plugin contract (capabilities, `exportEnvVars`, `agentHooks`, etc.) that each `ProviderProfile.provider` value maps to. Provider plugins (`sso`, `jwt`, `litellm`, `bedrock`, `ollama`, `anthropic-subscription`, `moonshot-subscription`) live under `src/providers/plugins/`.
- `src/env/manager.ts` — `EnvManager`, a separate, simpler flat key/value global-config helper (distinct from `ConfigLoader`/`MultiProviderConfig`); scope of its use relative to `ProviderProfile` is not established by this research.

### Architecture and Layers Affected

- **Configuration/data layer** — `src/env/types.ts` (schema), `src/utils/config.ts` (`ConfigLoader` read/write/merge logic), `src/env/manager.ts`.
- **Migration framework layer** — `src/migrations/*` (registry, tracker, runner, and the migration implementations themselves).
- **CLI layer** — `src/cli/commands/profile/*` (display, switch/list/delete/rename), `src/cli/commands/assistants/setup/*`, `src/cli/commands/skills/setup/*` (both read profile-adjacent config via `ConfigLoader`).
- **Provider plugin layer** — `src/providers/core/*` and `src/providers/plugins/*` (own `ProviderTemplate.exportEnvVars`/`agentHooks`; consume `CodeMieConfigOptions` = `ProviderProfile`).

### Integration Points

- `ConfigLoader.load()` merges global profile → local profile overlay → env vars → CLI overrides into a single flat `CodeMieConfigOptions` (= `ProviderProfile`), per the priority documented in `.ai-run/guides/usage/project-config.md`.
- `filterProjectFields()`/`PROJECT_FIELDS` in `ConfigLoader` already encode a partial notion of "project-level fields" that survive when the selected global profile differs from the local team's `activeProfile` — this is the closest existing precedent for a provider/non-provider field split, but it currently operates as a filter over the single flat schema rather than a first-class schema separation.
- Migrations 004/005 already depend on `ConfigLoader.loadMultiProviderConfig()` / `saveMultiProviderConfig()` and the corresponding local variants — any new migration would follow the same call pattern.
- `src/providers/core/types.ts` `ProviderTemplate.exportEnvVars(config: CodeMieConfigOptions)` and `agentHooks` both take the full flat `ProviderProfile`/`CodeMieConfigOptions` shape — a schema split affects this call surface.

### Patterns and Conventions

- **Migration pattern**: implement `Migration` (`id`, `description`, `up()`), self-register via `MigrationRegistry.register(new X())` at module load, exported for direct unit testing. IDs are zero-padded, sequential (`001-…` through `005-…`), sorted lexicographically by `MigrationRegistry.getAll()`.
- **Scope duality**: nearly every config-mutating operation is written twice — once for `StorageScope.GLOBAL` (`~/.codemie/codemie-cli.config.json`) and once for `StorageScope.LOCAL` (`.codemie/codemie-cli.config.json`) — mirrored in both `ConfigLoader` (`loadConfigByScope`/`saveConfigByScope`) and in migrations 004/005's `up()` methods.
- **Deduplication-by-recency**: migration 004 illustrates the convention for merging duplicate entities that used to live per-profile into a single top-level collection (`registeredAt` timestamp comparison, `Map` keyed by `id`).
- **Registry pattern**: both `ProviderRegistry` (providers) and `MigrationRegistry` (migrations) are static, in-memory, self-registering registries.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/usage/project-config.md` — authoritative description of the current config model: file locations, config priority (`CLI > env > project > global > defaults`), profile-resolution algorithm (including the differently-named-local-profile / URL-compatibility rules), `ConfigLoader` public API table, config schema examples, CLI commands (`codemie profile switch|delete|status`).
- `.ai-run/guides/architecture/architecture.md` — plugin-based 5-layer architecture (not read in full within this research pass; recommended reading before implementation to confirm layer boundaries for a schema change of this scope).
- `.ai-run/guides/integration/external-integrations.md` — provider plugin conventions (not read in full; relevant given provider-config decoupling touches every provider plugin's `exportEnvVars`/`agentHooks`).

### Architectural Decisions

- No ADR document was found specifically for the profile schema. The de facto architectural decision record for "what belongs at top-level vs. per-profile" is embodied in migration `004-skills-assistants-top-level.migration.ts`'s docstring: *"Move codemieSkills and codemieAssistants from profile-level to top-level config"* — i.e., this exact category of gap has already been addressed once for skills/assistants, but not yet for `codeMieProject`/`codeMieIntegration`/`hooks`/`plugins`/`assistants.maxHistoryMessages`/`skillsSearchUrl`/`claudeAutocompactPct`.

### Derived Conventions

- Schema evolutions of `MultiProviderConfig`/`ProviderProfile` are implemented as numbered migrations under `src/migrations/`, not as one-off ad hoc code in `ConfigLoader`.
- `isMultiProviderConfig()`/`isLegacyConfig()` type guards in `src/env/types.ts` gate format detection; any new top-level shape addition should extend these guards or add a new one following the same boolean-predicate style.

---

## 4. Testing Landscape

### Existing Coverage

- `src/utils/__tests__/config.migration.test.ts` — exercises `SkillsAssistantsTopLevelMigration.migrate()` directly (constructs the migration, calls `.migrate(config)` as a pure function) — the template for testing a new schema-decoupling migration.
- `src/migrations/__tests__/005-skill-slug-format.migration.test.ts` — exercises `SkillSlugFormatMigration`'s private methods via `(migration as any).methodName(...)`, covering slug computation and directory-rename edge cases.
- `src/utils/__tests__/config-project-override.test.ts` — covers `ConfigLoader`/`MultiProviderConfig` project-override behavior (exact scope not fully read in this pass).
- `src/cli/commands/assistants/setup/manualConfiguration/__tests__/types.test.ts`, `src/cli/commands/assistants/setup/selection/__tests__/utils.test.ts` — cover assistant-registration adjacent types/utils, not the profile schema itself.

### Testing Framework and Patterns

- Vitest (`describe`/`it`/`expect`), consistent with `.ai-run/guides/testing/testing-patterns.md` (not read in full this pass).
- Migration tests construct the migration class directly and call `up()`/pure-`migrate()` methods rather than mocking the filesystem end-to-end; private methods are invoked via `(instance as any).method(...)` when needed.

### Coverage Gaps

- `ConfigRenameMigration` (001), `ConsolidateSessionsMigration` (002), `RemoveHooksNodeMigration` (003) — codegraph reports **no covering tests found** for any of these three.
- `ProviderProfile`, `Migration` interface, `MigrationRegistry`, `ConfigLoader` (the class overall, though individual behaviors are covered indirectly by `AgentCLI-*` tests) — flagged with no direct covering tests in the blast-radius output for several call sites.
- No existing test exercises `ConfigLoader.load()`'s merge/priority logic (`filterProjectFields`, `shouldPreserveProjectContext`, `applyProjectOnly`) directly by name in the dimensions explored — `config-project-override.test.ts` likely covers some of this but was not opened in full.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_PROVIDER`, `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`, `CODEMIE_MODEL`, `CODEMIE_TIMEOUT`, `CODEMIE_DEBUG`, `CODEMIE_ALLOWED_DIRS`, `CODEMIE_IGNORE_PATTERNS` — generic overrides read in `ConfigLoader.loadFromEnv()`.
- `CODEMIE_URL`, `CODEMIE_AUTH_METHOD`, `CODEMIE_INTEGRATION_ID`, `CODEMIE_INTEGRATION_ALIAS` — SSO/project-context-specific overrides, also read in `loadFromEnv()` — notably these map directly onto the fields the task calls out as "project info... stored at profile level" (`codeMieIntegration`).
- `CODEMIE_SKILLS_SEARCH_URL` — overrides `ProviderProfile.skillsSearchUrl` (per inline comment in `src/env/types.ts`).

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — global `MultiProviderConfig` (per `ConfigLoader.GLOBAL_CONFIG` / `getCodemiePath`).
- `.codemie/codemie-cli.config.json` — local/project `MultiProviderConfig` (`ConfigLoader.LOCAL_CONFIG`).
- `~/.codemie/migrations.json` — migration-history file managed by `MigrationTracker`.

### Feature Flags and Deployment Concerns

- None identified specific to this task in the dimensions explored. Migrations run via `MigrationRunner.runPending()` and support `dryRun`/`silent`/`autoCleanup` options; `autoCleanup` is present in the options type but its implementation is a documented no-op (`// Auto-cleanup requested but not yet implemented`).

---

## 6. Risk Indicators

- Speculative: A provider/non-provider schema split will most likely require a new top-level `MultiProviderConfig` field (e.g., a `projects`/`workspace` collection analogous to the `codemieSkills`/`codemieAssistants` precedent) and a corresponding numbered migration (`006-…`) — this mirrors migration 004's approach, but the exact new shape is a design decision for the spec/plan stage, not something confirmed by this research.
- Every field named in the task ("agents and skills... registered via codemie setup assistants") for skills/assistants is **already** decoupled from `ProviderProfile` as of migration 004/005 — the remaining coupled fields are `codeMieProject`, `codeMieIntegration`, `hooks`, `plugins`, `assistants.maxHistoryMessages`, `skillsSearchUrl`, `claudeAutocompactPct`, and `metrics`. The spec should confirm exactly which of these the user considers "project-level" vs. legitimately provider-scoped (e.g., `metrics.sync` arguably belongs with SSO/provider behavior, not project identity).
- `ConfigLoader.load()`'s merge logic (`filterProjectFields`, `shouldPreserveProjectContext`, `resolveLocalProfileName`, `applyProjectOnly`) is intricate, branchy, and only partially covered by tests found in this research — any schema change here has a real regression surface, and the existing project-context-preservation logic (URL-equality gating) would likely need to be reconciled with or superseded by a first-class decoupled schema.
- `ConfigRenameMigration` (001), `ConsolidateSessionsMigration` (002), and `RemoveHooksNodeMigration` (003) have **no covering tests** — precedent risk if a new migration follows the same (untested) pattern rather than the tested pattern used by 004/005.
- `src/providers/core/types.ts` `ProviderTemplate.exportEnvVars` and `agentHooks` both consume the full flat `CodeMieConfigOptions`/`ProviderProfile` — every provider plugin (`sso`, `jwt`, `litellm`, `bedrock`, `ollama`, `anthropic-subscription`, `moonshot-subscription`, under `src/providers/plugins/`) is a potential call site affected by a schema split, but none were individually inspected in this pass.
- `EnvManager` (`src/env/manager.ts`) is a second, simpler global-config mechanism whose relationship to `ConfigLoader`/`MultiProviderConfig` was not established — worth clarifying in the spec whether it is in scope or legacy/unrelated.
- The `.ai-run/guides/architecture/architecture.md` and `.ai-run/guides/integration/external-integrations.md` guides exist but were not read in full during this research pass; a design/spec pass should load them per the repo's own "Check Guides First" policy before finalizing the target schema.

---

## 7. Summary for Complexity Assessment

This task touches the configuration/data layer (`src/env/types.ts` schema, `src/utils/config.ts` `ConfigLoader` read/merge/save logic), the migration-framework layer (`src/migrations/*`, which already has five precedent migrations including one — `004-skills-assistants-top-level` — that solved an almost identical decoupling problem for skills/assistants), the CLI layer (`src/cli/commands/profile/*`, `assistants/setup/*`, `skills/setup/*`, all of which read profile-adjacent fields via `ConfigLoader`), and potentially the provider-plugin layer (`src/providers/core/types.ts` `ProviderTemplate.exportEnvVars`/`agentHooks`, and each of the seven provider plugins that consume the flat `ProviderProfile` shape). The file-change surface for a full decoupling is plausibly 6+ files: the schema, `ConfigLoader`, a new migration file, its test, and one or more CLI/profile-display touch points — placing this in higher-complexity territory even before any provider-plugin call sites are confirmed as affected.

Technical novelty is low-to-moderate: the repository already has a working, tested precedent (migration 004) for moving fields out of per-profile storage into top-level/shared config, including deduplication-by-recency logic, self-registering migration classes, and scope-duality (global/local) handling. This significantly de-risks the "how do we migrate existing users smoothly" half of the task. What is novel is the direction of the split requested here — decoupling *provider identity/credentials* from *project/tooling context* within `ProviderProfile itself, rather than moving one category to a flat top-level array — which is a different shape of change than the existing precedent and will need explicit design (e.g., a new nested/linked structure so multiple provider profiles can share one project+assistants context).

Test coverage posture is mixed: migrations 004 and 005 (the closest precedents) are well tested with dedicated unit tests exercising pure `migrate()`/private methods; migrations 001–003 have no covering tests at all, and `ConfigLoader`'s merge/priority logic has only partial, indirect coverage. Key risk factors for planning: (1) the exact target schema and which currently-profile-scoped fields count as "project-level" is not yet decided and should be confirmed in spec, not inferred here; (2) `ConfigLoader.load()`'s existing project-context-preservation logic (URL-equality gating between differently-named profiles) is intricate and will likely need to be reconciled with any new first-class schema; (3) the blast radius on provider plugins' `exportEnvVars`/`agentHooks` call sites was not individually verified and should be checked during planning.
