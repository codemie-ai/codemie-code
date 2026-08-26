# Decouple Provider Config from Workspace Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move repo/tooling-context fields (`codeMieUrl`, `codeMieProject`, `codeMieIntegration`, `hooks`, `plugins`, `assistants.maxHistoryMessages`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`) out of the per-profile `ProviderProfile` schema into a new scope-level `WorkspaceConfig`, so switching `activeProfile` (e.g. `codemie-sso` → `anthropic`) no longer drops workspace context. Ship a migration so existing configs upgrade automatically.

**Architecture:** `WorkspaceConfig` becomes a new top-level field on `MultiProviderConfig`, resolved by whole-object override (local wins if defined, else global — no field mixing), mirroring where `codemieSkills`/`codemieAssistants` already live per migration 004. The runtime `CodeMieConfigOptions` type widens to `ProviderProfile & WorkspaceConfig` so `ConfigLoader.load()` keeps returning one flat merged object and every provider plugin's `exportEnvVars`/`agentHooks` keeps compiling unchanged.

**Tech Stack:** TypeScript, Vitest, existing `src/migrations/*` framework.

**Spec:** `docs/superpowers/tasks/2026-08-25-profile-provider-decoupling/spec.md`

## Global Constraints

- No signature changes to `ProviderTemplate.exportEnvVars`/`agentHooks`, and no source changes inside `src/providers/plugins/*` (7 plugins) — they must keep compiling and behaving unchanged.
- No changes to `codemieSkills`/`codemieAssistants` storage or merge behavior (migration 004's pattern is out of scope).
- No new CLI surface for viewing/editing `workspace` directly.
- No changes to `src/env/manager.ts` (`EnvManager`).
- No changes to migrations 001–005 or `src/migrations/types.ts`/`registry.ts`/`tracker.ts`/`runner.ts` — only add `006` and its one-line import.
- Commit per task using the repository's existing convention.

---

### Task 1: Schema — `WorkspaceConfig` and the widened `CodeMieConfigOptions`

**Files:**
- Modify: `src/env/types.ts:51-137` (`ProviderProfile`), `:169-176` (`MultiProviderConfig`), `:198` (`CodeMieConfigOptions`)

**Interfaces:**
- Produces: `WorkspaceConfig` interface; `MultiProviderConfig.workspace?: WorkspaceConfig`; `CodeMieConfigOptions = ProviderProfile & WorkspaceConfig` (was `= ProviderProfile`).

Test-first: no — pure type/interface change with no runtime branching; correctness is verified by Tasks 2–5's tests and by every existing provider-plugin file (untouched) continuing to compile against the widened `CodeMieConfigOptions`.

- [ ] **Step 1: Add `WorkspaceConfig` and update the three types**

Remove from `ProviderProfile` (`src/env/types.ts:51-137`): `codeMieUrl`, `codeMieProject`, `userEmail`, `codeMieIntegration`, `metrics`, `hooks`, `plugins`, `assistants`, `skillsSearchUrl`, `claudeAutocompactPct`. Keep every other field (`name`, `provider`, `baseUrl`, `apiKey`, `model`, `reasoningEffort`, `haikuModel`/`sonnetModel`/`opusModel`, `timeout`, `debug`, `allowedDirs`, `ignorePatterns`, `authMethod`, `ssoConfig`, `jwtConfig`, `authServerUrl`, `authRealm`, `awsProfile`, `awsRegion`, `awsSecretAccessKey`, `maxOutputTokens`, `maxThinkingTokens`, `codemieAssistants` in-memory field).

```ts
export interface WorkspaceConfig {
  codeMieUrl?: string;
  codeMieProject?: string;
  codeMieIntegration?: CodeMieIntegrationInfo;
  hooks?: HooksConfiguration;
  plugins?: { enabled?: string[]; disabled?: string[]; dirs?: string[] };
  assistants?: { maxHistoryMessages?: number };
  skillsSearchUrl?: string;
  claudeAutocompactPct?: number;
  metrics?: {
    enabled?: boolean;
    sync?: { enabled?: boolean; interval?: number; maxRetries?: number; dryRun?: boolean };
  };
}
```

Add `workspace?: WorkspaceConfig;` to `MultiProviderConfig` (`src/env/types.ts:169-176`). Change line 198 to `export type CodeMieConfigOptions = ProviderProfile & WorkspaceConfig;`.

- [ ] **Step 2: Commit**

```bash
git add src/env/types.ts
git commit -m "refactor(config): split WorkspaceConfig out of ProviderProfile"
```

---

### Task 2: `ConfigLoader` — workspace resolution replaces the URL-equality gate

**Files:**
- Modify: `src/utils/config.ts:90-207` (`load()`), `:1197-1282` (`loadWithSources()`), `:389-431` (delete `PROJECT_FIELDS`/`filterProjectFields`/`shouldPreserveProjectContext`)
- Test: `src/utils/__tests__/config-project-override.test.ts` (rewrite — currently tests the deleted gate)

**Interfaces:**
- Consumes: `WorkspaceConfig`, widened `CodeMieConfigOptions` (Task 1).
- Produces: `ConfigLoader.resolveWorkspace(workingDir: string): Promise<WorkspaceConfig>` (new public static method — local `MultiProviderConfig.workspace` if defined, else global's, else `{}`). Task 5 (`display.ts`/`index.ts`) calls this directly.

Test-first: yes — failing test: "switching the selected global profile away from the local team profile no longer drops `codeMieProject`/`hooks`/etc., because `workspace` resolves independently of which profile is active."

- [ ] **Step 1: Rewrite `config-project-override.test.ts`'s gated-composition tests**

Replace the suites that assert the old URL-equality gate (`shouldPreserveProjectContext`, `filterProjectFields` behavior — search the file for `codeMieUrl` mismatch/match cases) with assertions on the new rule: write a local `MultiProviderConfig` with `workspace: { codeMieProject: 'local-proj' }` and a global config with a different `workspace: { codeMieProject: 'global-proj', codeMieUrl: 'https://x' }`; call `ConfigLoader.load(workingDir)` and assert the result carries `codeMieProject: 'local-proj'` and no `codeMieUrl` (whole-object override — global's `codeMieUrl` must NOT leak in). Add a second case: no local `workspace` → global's is used entirely.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts`
Expected: FAIL (`workspace` not read anywhere yet).

- [ ] **Step 3: Implement `resolveWorkspace` and rewire `load()`**

Add `static async resolveWorkspace(workingDir: string): Promise<WorkspaceConfig>`: load local `MultiProviderConfig` via `loadLocalMultiProviderConfig(workingDir)`; if `.workspace` is defined, return it; else load global via `loadMultiProviderConfig()` and return its `.workspace ?? {}`.

In `load()` (`:90-207`): delete the `applyProjectOnly`/`selectedProfileDefinesProjectContext`/`preserveProjectContext`/`effectiveLocalConfig` block (`:119-140`) and the plain `localConfig` composition it replaced — the local *profile* overlay (`:117`, `Object.assign(config, this.removeUndefined(localConfig))`) stays untouched (provider-identity resolution is unchanged per spec). After the profile-merge block, call `const workspace = await this.resolveWorkspace(workingDir);` and `Object.assign(config, this.removeUndefined(workspace));` before the env-var layer.

Delete `PROJECT_FIELDS` (`:389-393`), `shouldPreserveProjectContext` (`:408-415`), `filterProjectFields` (`:421-431`) entirely.

- [ ] **Step 4: Apply the same rewire to `loadWithSources()`**

`loadWithSources()` (`:1197-1282`) duplicates the same gate at `:1220-1233` — delete it identically and add `workspace` as its own `ConfigLayer` entry (`source: 'project'`, using `await this.resolveWorkspace(workingDir)`) inside the `configs` array (`:1235-1255`), positioned where `effectiveLocalConfig` was.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/utils/config.ts src/utils/__tests__/config-project-override.test.ts
git commit -m "refactor(config): resolve workspace by whole-object override, drop URL-equality gate"
```

---

### Task 3: `ConfigLoader` — split workspace fields out on profile write

**Files:**
- Modify: `src/utils/config.ts:596-611` (`saveProfile`), `:869-914` (`initProjectConfig`)
- Test: `src/utils/__tests__/config-project-override.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveWorkspace` (Task 2), `WorkspaceConfig` (Task 1).
- Produces: private `ConfigLoader.splitProfileAndWorkspace(input: Partial<CodeMieConfigOptions>): { profile: Partial<ProviderProfile>; workspace: Partial<WorkspaceConfig> }`.

Test-first: yes — failing test: "saving a profile whose input includes `codeMieProject`/`codeMieUrl` persists those fields into the scope's `workspace`, not into `profiles[name]`."

- [ ] **Step 1: Write the failing test**

In `config-project-override.test.ts`, add: call `ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://x', codeMieProject: 'proj' } as any)`; read back the raw JSON at `GLOBAL_CONFIG_PATH`; assert `profiles.p1.codeMieUrl` is `undefined` and `workspace.codeMieUrl === 'https://x'` / `workspace.codeMieProject === 'proj'`. Add a second case for `initProjectConfig(workingDir, { profileName: 'p1', codeMieProject: 'proj' })` asserting the same split against the local config file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts`
Expected: FAIL (fields currently land inside the profile object).

- [ ] **Step 3: Implement `splitProfileAndWorkspace` and wire it into both writers**

Add a private static method listing the `WorkspaceConfig` keys (`codeMieUrl`, `codeMieProject`, `codeMieIntegration`, `hooks`, `plugins`, `assistants`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`) and partitioning `input` into `{ profile, workspace }`.

In `saveProfile()` (`:596-611`): after the existing `codemieSkills`/`codemieAssistants` strip, run the input through `splitProfileAndWorkspace`; save only `profile` fields into `config.profiles[profileName]`; if `workspace` has any defined keys, merge them into `config.workspace = { ...config.workspace, ...workspace }` before `saveMultiProviderConfig(config)`.

In `initProjectConfig()` (`:869-914`): apply the same split to `overrides` before building `profile`; merge the `workspace` half into the new `MultiProviderConfig.workspace` (`{ ...workspace-half }`, since this always creates a fresh local config) instead of onto the `profile` object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/config.ts src/utils/__tests__/config-project-override.test.ts
git commit -m "refactor(config): route workspace fields to scope-level workspace on profile save"
```

---

### Task 4: Migration 006 — decouple provider/workspace config

**Files:**
- Create: `src/migrations/006-decouple-provider-workspace-config.migration.ts`
- Create: `src/migrations/__tests__/006-decouple-provider-workspace-config.migration.test.ts`
- Modify: `src/migrations/index.ts:29` (add import)

**Interfaces:**
- Consumes: `MultiProviderConfig`, `WorkspaceConfig`, `ProviderProfile` (Task 1); `Migration`/`MigrationResult` (`src/migrations/types.ts`, unchanged); `MigrationRegistry.register` (`src/migrations/registry.ts`, unchanged).
- Produces: exported `DecoupleProviderWorkspaceConfigMigration` class with a pure `migrate(config: MultiProviderConfig): MultiProviderConfig`.

Test-first: yes — failing test: "migrating a config where the active profile has `codeMieProject` set lifts exactly that profile's moving fields into `workspace` and strips them from every profile."

- [ ] **Step 1: Write the failing migration test**

Follow `src/utils/__tests__/config.migration.test.ts`'s pattern: `const migration = new DecoupleProviderWorkspaceConfigMigration(); const migrate = (c: any) => migration.migrate(c);`. Cases:
1. Active profile has `codeMieProject`/`hooks` set, another profile has none → `result.workspace` equals that active profile's moving-field snapshot; both profiles in `result.profiles` no longer have those keys.
2. Active profile has none of the moving fields set but a different profile does → that other profile (first in iteration order with a moving field) is the source.
3. No profile has any moving field → `result.workspace` is `{}` (or omitted) and profiles are unchanged reference-wise where nothing moved.
4. `config.workspace` already defined → `migrate(config)` returns the same reference (no-op / idempotent), mirroring migration 004's `if (!skillsMissing && !assistantsMissing) return config;` guard.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/migrations/__tests__/006-decouple-provider-workspace-config.migration.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the migration**

Structure exactly like `src/migrations/004-skills-assistants-top-level.migration.ts` (`id`, `description`, `up()` running global then local scope independently via `ConfigLoader.hasGlobalConfig`/`loadMultiProviderConfig`/`saveMultiProviderConfig` and `hasProjectConfig`/`loadLocalMultiProviderConfig`/`saveLocalMultiProviderConfig`). `id = '006-decouple-provider-workspace-config'`. In `migrate(config)`: return `config` unchanged if `config.workspace !== undefined`; otherwise define the moving-field key list (same list as Task 3's `splitProfileAndWorkspace`); pick the source profile per the spec's rule (`config.activeProfile`'s profile if it has ≥1 moving field set, else the first profile in `Object.entries(config.profiles)` iteration order that does, else `undefined`); build the `workspace` snapshot from that one profile's moving fields (or `{}` if no source found); return a new config with `profiles` rebuilt (each profile's moving fields stripped) and `workspace` set.

- [ ] **Step 4: Register the migration**

Add `import './006-decouple-provider-workspace-config.migration.js';` to `src/migrations/index.ts` after the `005` import (line 29), following the exact one-line pattern already there.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/migrations/__tests__/006-decouple-provider-workspace-config.migration.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/migrations/006-decouple-provider-workspace-config.migration.ts src/migrations/__tests__/006-decouple-provider-workspace-config.migration.test.ts src/migrations/index.ts
git commit -m "feat(migrations): add 006 to decouple provider config from workspace config"
```

---

### Task 5: Profile display — source `codeMieUrl` from resolved workspace

**Files:**
- Modify: `src/cli/commands/profile/display.ts:33-53` (`format`), `:96-126` (`formatStatus`)
- Modify: `src/cli/commands/profile/index.ts:52-68` (`listProfiles`), `:100-156` (`handleStatus`)
- Test: `src/cli/commands/profile/__tests__/index.test.ts` (extend)

**Interfaces:**
- Consumes: `ConfigLoader.resolveWorkspace(workingDir)` (Task 2).

Test-first: yes — failing test: "profile list/status display the workspace's `codeMieUrl`, not a per-profile one, after a profile no longer stores it."

- [ ] **Step 1: Write the failing test**

In `src/cli/commands/profile/__tests__/index.test.ts`, add a case that mocks `ConfigLoader.listProfiles`/`resolveWorkspace` (following the file's existing mocking style for `ConfigLoader`) so `resolveWorkspace` returns `{ codeMieUrl: 'https://workspace-url' }` and a listed profile has no `codeMieUrl` field; assert the rendered output (via `ProfileDisplay.format`/console capture, matching the file's existing assertion style) contains `https://workspace-url`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/profile/__tests__/index.test.ts`
Expected: FAIL (`codeMieUrl` is `undefined`, not rendered).

- [ ] **Step 3: Thread the resolved workspace URL through display**

`display.ts`: add an optional parameter to `format(info: ProfileInfo, workspaceCodeMieUrl?: string)` and `formatStatus(info: ProfileInfo, authStatus?: AuthStatus, workspaceCodeMieUrl?: string)`; use `workspaceCodeMieUrl` in place of `profile.codeMieUrl` at lines 40 and 114. Also add the same optional parameter to `formatList(profiles: ProfileInfo[], workspaceCodeMieUrl?: string)`, passed through to each `format()` call.

`index.ts`: in `listProfiles()` (`:52-68`), call `const workspace = await ConfigLoader.resolveWorkspace(workingDir);` and pass `workspace.codeMieUrl` into `ProfileDisplay.formatList(profiles, workspace.codeMieUrl)`. In `handleStatus()` (`:100-156`), resolve the same way and pass `workspace.codeMieUrl` into `ProfileDisplay.formatStatus(activeProfileInfo, authStatus, workspace.codeMieUrl)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/profile/__tests__/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/profile/display.ts src/cli/commands/profile/index.ts src/cli/commands/profile/__tests__/index.test.ts
git commit -m "fix(profile): display workspace-resolved codeMieUrl instead of per-profile field"
```

---

## Self-Review Notes

- **Spec coverage:** Field classification/`WorkspaceConfig` shape → Task 1. Whole-object resolution rule → Task 2. Migration 006 + dedicated test → Task 4. `PROJECT_FIELDS`/`filterProjectFields`/`shouldPreserveProjectContext`/`applyProjectOnly` removal → Task 2. `CodeMieConfigOptions` staying flat with no provider-plugin changes → Task 1's type widening + no task touches `src/providers/plugins/*`. Profile-switch preserving workspace → Task 2 (resolution is scope-level, independent of active profile) verified by Task 5's display fix and the acceptance criterion example (`codemie-sso` → `anthropic`).
- **Negative constraints:** No task modifies `src/providers/plugins/*`, `src/env/manager.ts`, migrations 001–005, or the migration framework files — verified by the File lists above touching only `types.ts`, `config.ts`, `migrations/006-*`, `migrations/index.ts`, and `cli/commands/profile/*`. No new CLI command/flag is added — Task 5 only changes what an existing display path reads.
