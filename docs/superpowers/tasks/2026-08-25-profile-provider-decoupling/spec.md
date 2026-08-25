# Spec: Decouple Provider Config from Workspace Config in the Profile System

## Problem

`ProviderProfile` (`src/env/types.ts:51-137`) is a single flat object per profile that mixes LLM-provider identity/credentials (`provider`, `baseUrl`, `apiKey`, `model`, `ssoConfig`, `jwtConfig`, `awsProfile`, …) with repo/tooling context (`codeMieUrl`, `codeMieProject`, `codeMieIntegration`, `hooks`, `plugins`, `assistants.maxHistoryMessages`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`). Switching `activeProfile` to change LLM provider (e.g. `codemie-sso` → `anthropic`) silently drops the workspace context, because that context lives inside the profile being switched away from. Migration `004-skills-assistants-top-level` already solved this for `codemieSkills`/`codemieAssistants` by promoting them to a top-level, scope-explicit slot on `MultiProviderConfig`; this spec extends the same idea to the remaining coupled fields, plus the `ConfigLoader.load()` merge logic that currently guards against the field mixing this coupling makes possible.

## Design

### Field classification

**Stays per-profile** (`ProviderProfile`, unchanged behavior): `name`, `provider`, `baseUrl`, `apiKey`, `model`, `reasoningEffort`, `haikuModel`, `sonnetModel`, `opusModel`, `timeout`, `debug`, `allowedDirs`, `ignorePatterns`, `authMethod`, `ssoConfig`, `jwtConfig`, `authServerUrl`, `authRealm`, `awsProfile`, `awsRegion`, `awsSecretAccessKey`, `maxOutputTokens`, `maxThinkingTokens`.

**Moves to a new top-level `workspace` section**: `codeMieUrl`, `codeMieProject`, `codeMieIntegration`, `hooks`, `plugins`, `assistants.maxHistoryMessages`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`, and per-profile `userEmail` (redundant with the `userEmail` already at `MultiProviderConfig` top level — `src/env/types.ts:174` — stop writing it per-profile). `codeMieUrl` moves with `codeMieProject`/`codeMieIntegration` because it identifies which CodeMie backend those IDs belong to, and CodeMie-platform features (assistants/skills) are usable independent of which LLM provider is active — it is workspace identity, not LLM credentials. `metrics` classification (workspace-level sync preference, not provider-level) is a judgment call — see Open Risks.

```ts
interface WorkspaceConfig {
  codeMieUrl?: string;
  codeMieProject?: string;
  codeMieIntegration?: CodeMieIntegrationInfo;
  hooks?: HooksConfiguration;
  plugins?: { enabled?: string[]; disabled?: string[]; dirs?: string[] };
  assistants?: { maxHistoryMessages?: number };
  skillsSearchUrl?: string;
  claudeAutocompactPct?: number;
  metrics?: ProviderProfile['metrics'];
}
```

`MultiProviderConfig` (`src/env/types.ts:169-176`) gains `workspace?: WorkspaceConfig`, present independently at both the global and local config files — same top-level placement as `codemieSkills`/`codemieAssistants`.

### Resolution rule (replaces the URL-equality gate)

`workspace` resolves as a **whole-object override**, not a per-field merge: if the local `MultiProviderConfig` defines `workspace`, it is used entirely; otherwise the global `workspace` is used entirely. No field-level mixing between scopes. This is deliberate: the current `PROJECT_FIELDS`/`filterProjectFields`/`shouldPreserveProjectContext` machinery (`src/utils/config.ts:389-431`, invoked at `:122-140` and `:1220-1231`) exists to stop a local `codeMieProject` from being paired with a mismatched global `codeMieUrl`. A per-field shallow merge of `workspace` would silently reintroduce that exact bug (local sets `codeMieProject` only, global's unrelated `codeMieUrl` leaks in); whole-object override removes the hazard structurally, so the URL-equality gate and its three helper functions can be deleted rather than ported. Provider identity resolution (profile field priority `CLI > env > local profile > global profile`) is unchanged. The final `CodeMieConfigOptions` returned by `load()` stays a single flat object — provider fields spread with the resolved `workspace` fields — so `ProviderTemplate.exportEnvVars`/`agentHooks` and all 7 provider plugins require no changes.

### Migration

New `006-decouple-provider-workspace-config.migration.ts`, following the tested `004`/`005` pattern (pure `migrate(config)`, unit tested per-scope like `src/utils/__tests__/config.migration.test.ts`), run automatically by the existing `MigrationRunner.runPending()` — no manual user action. Runs independently per scope (global file, then local file if present).

Per scope, the moving fields resolve in two groups (revised post-launch, CR-007 — see Open Risks):

- **Identity trio** (`codeMieUrl`, `codeMieProject`, `codeMieIntegration`): sourced from a single profile together, never mixed across profiles — a `codeMieUrl` from one provider paired with a `codeMieProject`/`codeMieIntegration` from another would point the client at the wrong project/integration. Source profile is the current `activeProfile` if it defines *any* of the three, else the first profile (iteration order) that does.
- **Everything else** (`hooks`, `plugins`, `assistants`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`): each field resolves independently — the `activeProfile`'s value if it defines one, else the first profile (iteration order) that does. No cross-field consistency requirement exists between these, so per-field dedup does not risk mismatched pairs.

This replaces the original single-source-profile-for-everything design: picking one profile as the sole source for *all* moving fields (gated on "has any moving field, of any kind") meant an active profile with only, say, `metrics` set would win as the sole source and silently drop the identity trio entirely if it lived on a different profile — breaking client authentication for every profile. Then strip the moving fields from every profile in that scope. No-op (idempotent) if `workspace` is already present.

## Acceptance Criteria

- `ProviderProfile` no longer declares any of the moved fields; `WorkspaceConfig` declares exactly them.
- `MultiProviderConfig.workspace` exists at both global and local scope, resolved by whole-object override (local wins if defined, else global) — never field-mixed.
- `ConfigLoader.load()`'s returned `CodeMieConfigOptions` remains flat and contains the resolved provider + workspace fields together; no provider plugin (`src/providers/plugins/*`) source changes.
- `PROJECT_FIELDS`, `filterProjectFields`, `shouldPreserveProjectContext` are removed from `src/utils/config.ts`. `applyProjectOnly` is **retained** (in `load()` and `loadWithSources()`): it still gates whether the local team profile's *provider identity* (model/baseUrl/credentials) applies when a different global profile is selected, which is unrelated to — and unaffected by — the workspace decoupling this spec covers; only its former role of also gating repo/tooling-context fields (via the deleted `PROJECT_FIELDS`/`filterProjectFields`/`shouldPreserveProjectContext` machinery) is removed, since `resolveWorkspace()`'s whole-object-override rule replaces that responsibility. (Revised post-Stage-6 review, CR-004: the original wording called for `applyProjectOnly`'s removal, but provider-identity resolution — explicitly unchanged per this spec's Design section — still needs it to prevent a mismatched local profile's credentials from leaking onto a different active global profile.)
- Migration `006` runs unattended on next CLI invocation for any user with an existing v2 config, is idempotent, and resolves fields per the two-group rule stated above: the identity trio atomically from one profile, all other fields independently per key.
- Switching `activeProfile` (e.g. `codemie-sso` → `anthropic`) leaves `workspace` — and therefore `codeMieProject`, `hooks`, `plugins`, `assistants.maxHistoryMessages`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics` — unchanged.
- Migration `006` has a dedicated unit test file following `src/utils/__tests__/config.migration.test.ts`'s pattern (construct migration, call `migrate()`, assert).

## Non-Goals

- No change to `ProviderTemplate.exportEnvVars`/`agentHooks` signatures or any of the 7 provider plugins' source (`src/providers/plugins/*`).
- No change to how `codemieSkills`/`codemieAssistants` are stored or merged — migration 004's scope-siloed pattern already works and is out of scope.
- No CLI UX redesign of `profile switch`/`list`/`status` beyond updating field sources where they currently read now-moved fields from a profile.
- No change to `EnvManager` (`src/env/manager.ts`) — its relationship to `ConfigLoader` is unconfirmed and not part of this work.
- No new CLI surface for viewing/editing `workspace` directly.
- No change to migrations 001-005 or the migration framework itself (`src/migrations/types.ts`, `registry.ts`, `tracker.ts`, `runner.ts`).

## Open Risks

- `metrics` classification as workspace-level (vs. provider-level, e.g. tied to SSO sync behavior) is a judgment call, not a confirmed requirement — flagged for Stage 6 acceptance review.
- **CR-007 (found in manual post-implementation testing, fixed):** the original migration design picked one profile as the sole source for *every* moving field, gated on "has any moving field of any kind." A real user hit this: their active profile had only an unrelated field (`metrics`) set while `codeMieUrl`/`codeMieProject`/`codeMieIntegration` lived on a different profile — the migration silently dropped the identity trio entirely, breaking `codemie assistants setup`'s marketplace/project fetch (`Cannot read properties of undefined (reading 'length')` in `src/cli/commands/assistants/setup/data.ts`, because the client was built without connectivity credentials). Fixed by splitting resolution into the identity trio (atomic, single-profile) vs. everything else (per-field, independent) — see the Migration section above. A user with genuinely divergent *identity* fields across profiles (e.g. two different `codeMieUrl`s on two profiles, neither the source) still has all-but-one profile's identity silently dropped at migration time; this narrower case is retained as an acceptable simplification since a coherent identity triple must come from exactly one profile.
- `ProfileDisplay`/profile CLI output (`src/cli/commands/profile/*`) has not been individually inventoried for exact fields rendered; Stage 4 planning should confirm which call sites need updating to read from `workspace` instead of a profile.
- `config-project-override.test.ts` covers logic being deleted (`shouldPreserveProjectContext` et al.) and will need replacement coverage for the new whole-object override rule.
