# Global Profile Identity Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each global CodeMie profile stores and resolves its own `codeMieUrl`/`codeMieProject`/`codeMieIntegration` independently, so switching between global profiles never leaks identity from the most-recently-configured one.

**Architecture:** Move the identity trio (`codeMieUrl`, `codeMieProject`, `codeMieIntegration`) off the single shared `MultiProviderConfig.workspace` object and onto `ProviderProfile` itself for global profiles — mirroring how every other per-profile field (provider, baseUrl, model) already works, and how local profiles already isolate identity structurally (one config file per working directory). Non-identity `WorkspaceConfig` fields (hooks, plugins, assistants, skillsSearchUrl, claudeAutocompactPct, metrics) and all local-profile behavior are untouched. A new migration clones each existing global config's shared identity onto every existing global profile so no one's config silently breaks.

**Tech Stack:** TypeScript (ES modules), Vitest `^4.1.5`, existing `ConfigLoader`/migration-registry patterns in `src/utils/config.ts` and `src/migrations/`.

**Spec:** EPMCDME-15411 (Jira) + `docs/superpowers/tasks/2026-10-27-global-profiles-share-workspace-identity/technical-analysis.md` (codebase research — root cause, risk indicators, test landscape). No separate spec.md exists for this `sdlc-light` run; requirements are inlined below.

## Global Constraints

- Identity trio is atomic: `codeMieUrl`, `codeMieProject`, `codeMieIntegration` always move/resolve together, never individually (existing project convention, see `IDENTITY_KEYS` in `src/utils/config.ts:603`).
- Non-identity `WORKSPACE_KEYS` (`hooks`, `plugins`, `assistants`, `skillsSearchUrl`, `claudeAutocompactPct`, `metrics`) stay scope-level shared — out of scope for this fix (AC6).
- Local-profile identity resolution (`isLocalProfile === true` branch of `resolveProfileWorkspace`) must not change at all (AC5).
- Migration strategy (user-confirmed): clone the existing shared global `workspace` identity trio onto **every** existing global profile, not just the active one, so no profile silently loses working identity post-migration.
- Follow existing migration numbering/idempotency pattern (`src/migrations/007-decouple-provider-workspace-config.migration.ts`) — new migration is `008-...`.
- ES modules, `.js`-suffixed imports, explicit return types, single quotes (project style, `.ai-run/guides/standards/code-quality.md`).
- Tests use real temp-directory fixtures + `vi.spyOn(paths, ...)`, not full `fs` mocks (`.ai-run/guides/testing/testing-patterns.md`).

## Review Focus

- **Legacy (v1) config with no `workspace` object at all, migrating straight to the new per-profile shape**: a user who has never run migration 007 must still end up with correct per-profile identity after upgrading (migration 008 must handle both legacy-already-converted-by-007-in-the-same-run and pre-existing v2-with-shared-workspace inputs). Covered by Task 2's migration tests.
- **A global profile that defines no identity fields at all (e.g. `anthropic-subscription`, no CodeMie backend)**: must not gain spurious empty identity fields it never had, and must not crash migration or resolution. Covered by Task 2 and Task 1 tests.
- **`--show-sources` diagnostics (`loadWithSources`) must still label identity fields correctly** (`'global'` when sourced from a global profile's own data, `'project'` when from a local workspace) even though the data now lives on the profile object instead of the shared workspace. Covered by Task 1.
- **The statusline's second, undocumented read path** (`statusline.ts:730`, reads `config.workspace?.codeMieUrl` directly, bypassing `ConfigLoader`) must be updated or it silently keeps showing the old shared/wrong URL after the fix ships. Covered by Task 3.
- **Switch-away-and-back**: switching global profile A → B → back to A must restore A's own identity exactly (AC8) — the one existing test for "switching global profiles" currently asserts the opposite (bug-as-correct) and must be replaced, not supplemented. Covered by Task 1.

---

### Task 1: Move identity resolution onto the profile for global profiles

**Files:**
- Modify: `src/env/types.ts:51-98` (`ProviderProfile` interface)
- Modify: `src/utils/config.ts:233-248` (`resolveProfileWorkspace`), `src/utils/config.ts:603-671` (`IDENTITY_KEYS`, `splitProfileAndWorkspace`, `saveProfile`)
- Test: `src/utils/__tests__/config-project-override.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `ProviderProfile` now optionally carries `codeMieUrl?: string`, `codeMieProject?: string`, `codeMieIntegration?: CodeMieIntegrationInfo` (same types as on `WorkspaceConfig`). `ConfigLoader.resolveProfileWorkspace(workingDir: string, isLocalProfile: boolean): Promise<WorkspaceConfig>` keeps its exact signature but, for `isLocalProfile === false`, no longer reads identity from the shared global workspace — it strips `IDENTITY_KEYS` from its result entirely, relying on the caller (`ConfigLoader.load`/`loadWithSources`) having already merged the active global profile's own identity fields earlier in the pipeline. `ConfigLoader.saveProfile(profileName, profile)` now leaves identity fields on `profiles[name]` instead of routing them into `config.workspace`. Task 2 and Task 3 depend on `ProviderProfile` carrying these three fields directly.

- [ ] **Step 1: Write failing tests for the new `saveProfile` behavior**

Rewrite the existing (bug-asserting) test block in `src/utils/__tests__/config-project-override.test.ts:394-410` — it currently asserts identity is routed OUT of `profiles[name]` into `config.workspace`, which is exactly the bug. Replace it with:

```typescript
describe('saveProfile / initProjectConfig — workspace split', () => {
  it('saveProfile keeps identity fields on profiles[name], routes only non-identity fields into the global workspace', async () => {
    await ConfigLoader.saveProfile('p1', {
      provider: 'ai-run-sso',
      codeMieUrl: 'https://x',
      codeMieProject: 'proj',
      claudeAutocompactPct: 85
    } as any);

    const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8');
    const config: MultiProviderConfig = JSON.parse(content);

    expect((config.profiles.p1 as any).codeMieUrl).toBe('https://x');
    expect((config.profiles.p1 as any).codeMieProject).toBe('proj');
    expect(config.profiles.p1.provider).toBe('ai-run-sso');
    expect(config.workspace?.codeMieUrl).toBeUndefined();
    expect(config.workspace?.codeMieProject).toBeUndefined();
    expect(config.workspace?.claudeAutocompactPct).toBe(85);
  });

  it('initProjectConfig routes workspace fields into the local scope workspace, not into profiles[name]', async () => {
    // unchanged — keep the existing test body from lines 412-424 verbatim.
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm run test -- config-project-override`
Expected: FAIL on `config.profiles.p1.codeMieUrl` being `undefined` (current `saveProfile` still routes it into `config.workspace`).

- [ ] **Step 3: Add `NON_IDENTITY_WORKSPACE_KEYS` and fix `saveProfile` in `src/utils/config.ts`**

Add a new private static list right after `WORKSPACE_KEYS` (`config.ts:614-624`):

```typescript
private static readonly NON_IDENTITY_WORKSPACE_KEYS: (keyof WorkspaceConfig)[] = [
  'hooks',
  'plugins',
  'assistants',
  'skillsSearchUrl',
  'claudeAutocompactPct',
  'metrics'
];
```

Give `splitProfileAndWorkspace` (`config.ts:631-645`) a `keys: (keyof WorkspaceConfig)[]` parameter defaulting to `this.WORKSPACE_KEYS`, and iterate `keys` instead of the hardcoded `this.WORKSPACE_KEYS` reference inside the loop (keeps `initProjectConfig`'s call site at `config.ts:952`, which must keep splitting the full `WORKSPACE_KEYS` including identity, unchanged — local behavior, AC5). In `saveProfile` (`config.ts:656`), call `this.splitProfileAndWorkspace(cleanProfile, this.NON_IDENTITY_WORKSPACE_KEYS)` instead, so identity fields stay in `profileFields`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- config-project-override`
Expected: PASS.

- [ ] **Step 5: Write failing tests for `resolveProfileWorkspace` / global-profile switching (AC7, AC8)**

Replace the bug-asserting test at `config-project-override.test.ts:653-677` (`'switching the selected global profile does not drop workspace context'`) with new coverage reflecting the per-profile contract. Also rewrite `679-701` (`'loadWithSources reports a global-only workspace value with source "global"'`), which currently sets identity via `globalRaw.workspace` instead of on the profile — update it to set `codeMieUrl` directly on the `preview` profile object in `writeGlobal(...)` so it still reflects a true global (non-local) profile.

```typescript
it('two global profiles targeting different CodeMie environments resolve their own identity independently (AC7)', async () => {
  await writeGlobal('env-a', {
    'env-a': {
      provider: 'ai-run-sso',
      codeMieUrl: 'https://a.example.com',
      codeMieProject: 'proj-a',
      baseUrl: 'https://a.example.com/code-assistant-api',
      model: 'claude-sonnet-4-6',
      name: 'env-a'
    },
    'env-b': {
      provider: 'ai-run-sso',
      codeMieUrl: 'https://b.example.com',
      codeMieProject: 'proj-b',
      baseUrl: 'https://b.example.com/code-assistant-api',
      model: 'claude-sonnet-4-6',
      name: 'env-b'
    }
  });

  const cfgA = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'env-a' });
  const cfgB = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'env-b' });

  expect(cfgA.codeMieUrl).toBe('https://a.example.com');
  expect(cfgA.codeMieProject).toBe('proj-a');
  expect(cfgB.codeMieUrl).toBe('https://b.example.com');
  expect(cfgB.codeMieProject).toBe('proj-b');
});

it('switching back to the first global profile restores its own identity (AC8)', async () => {
  await writeGlobal('env-a', {
    'env-a': {
      provider: 'ai-run-sso',
      codeMieUrl: 'https://a.example.com',
      codeMieProject: 'proj-a',
      baseUrl: 'https://a.example.com/code-assistant-api',
      model: 'claude-sonnet-4-6',
      name: 'env-a'
    },
    'env-b': {
      provider: 'ai-run-sso',
      codeMieUrl: 'https://b.example.com',
      codeMieProject: 'proj-b',
      baseUrl: 'https://b.example.com/code-assistant-api',
      model: 'claude-sonnet-4-6',
      name: 'env-b'
    }
  });

  await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'env-a' });
  await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'env-b' });
  const backToA = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'env-a' });

  expect(backToA.codeMieUrl).toBe('https://a.example.com');
  expect(backToA.codeMieProject).toBe('proj-a');
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npm run test -- config-project-override`
Expected: FAIL — with current `resolveProfileWorkspace`, both `env-a` and `env-b` resolve `codeMieUrl`/`codeMieProject` from whatever last landed in the shared `config.workspace` (none, in this fixture, since `writeGlobal` writes no `workspace` key at all) — actually expect this to fail because current code paths never pull identity from the profile object in the no-shared-workspace case either; confirm the failure message shows `undefined` rather than the expected per-profile value.

- [ ] **Step 7: Fix `resolveProfileWorkspace` in `src/utils/config.ts:233-248`**

```typescript
static async resolveProfileWorkspace(workingDir: string, isLocalProfile: boolean): Promise<WorkspaceConfig> {
  const workspace = await this.resolveWorkspace(workingDir);
  if (isLocalProfile) {
    return workspace;
  }

  const result: Record<string, unknown> = { ...workspace };
  for (const key of this.IDENTITY_KEYS) {
    delete result[key];
  }
  return result as WorkspaceConfig;
}
```

Update the doc comment above it (`config.ts:223-232`) to say identity for a global profile now comes from the profile object itself (already merged into `config` earlier in `load()`/`loadWithSources()`), not from the shared global workspace. No other call site changes: `ConfigLoader.load()` (`config.ts:135-136`) already merges the active profile's own fields (including the now-present identity fields) at line 115 before calling `resolveProfileWorkspace`, so stripping identity here stops the later `Object.assign` at line 136 from clobbering the correct value. `loadWithSources()` (`config.ts:1292-1301`) already extracts `identityWorkspace` separately from `profileWorkspace` for source-labelling — with this fix `identityWorkspace` is naturally empty for global profiles and the identity fields are already labelled `source: 'global'` via the `globalConfig` layer (`config.ts:1312-1314`), so no change needed there.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm run test -- config-project-override`
Expected: PASS, including the untouched local-profile tests at lines 491-651 and 703-735 (regression check for AC5/AC6).

- [ ] **Step 9: Commit**

```bash
git add src/env/types.ts src/utils/config.ts src/utils/__tests__/config-project-override.test.ts
git commit -m "fix(config): isolate CodeMie identity per global profile"
```

---

### Task 2: Add migration 008 to clone shared identity onto every existing global profile

**Files:**
- Create: `src/migrations/008-isolate-global-profile-identity.migration.ts`
- Create: `src/migrations/__tests__/008-isolate-global-profile-identity.migration.test.ts`
- Modify: `src/migrations/index.ts:31` (add import)

**Interfaces:**
- Consumes: `IDENTITY_KEYS` constant shape from Task 1 (kept as an independent literal per existing migration convention — no runtime import from `ConfigLoader` internals, matching `007-decouple-provider-workspace-config.migration.ts:12`).
- Produces: `IsolateGlobalProfileIdentityMigration` class with `id = '008-isolate-global-profile-identity'` and a `migrate(config: MultiProviderConfig): MultiProviderConfig` method, registered via `MigrationRegistry.register(...)`, same shape as migration 007's exported class for direct unit testing.

- [ ] **Step 1: Write failing migration tests**

```typescript
import { describe, it, expect } from 'vitest';
import { IsolateGlobalProfileIdentityMigration } from '../008-isolate-global-profile-identity.migration.js';
import type { MultiProviderConfig } from '../../env/types.js';

const migration = new IsolateGlobalProfileIdentityMigration();
const migrate = (config: any): MultiProviderConfig => migration.migrate(config);

describe('IsolateGlobalProfileIdentityMigration', () => {
  it('clones the shared workspace identity trio onto every global profile and strips it from workspace', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: {
        'env-a': { provider: 'ai-run-sso', model: 'claude-sonnet-4-6' },
        'env-b': { provider: 'ai-run-sso', model: 'claude-sonnet-4-6' }
      },
      workspace: {
        codeMieUrl: 'https://shared.example.com',
        codeMieProject: 'shared-proj',
        hooks: { PreToolUse: [] }
      }
    };

    const result = migrate(config);

    expect((result.profiles['env-a'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-a'] as any).codeMieProject).toBe('shared-proj');
    expect((result.profiles['env-b'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-b'] as any).codeMieProject).toBe('shared-proj');
    expect(result.workspace?.codeMieUrl).toBeUndefined();
    expect(result.workspace?.codeMieProject).toBeUndefined();
    expect(result.workspace?.hooks).toEqual({ PreToolUse: [] });
  });

  it('does not overwrite a profile that already defines its own identity', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: {
        'env-a': { provider: 'ai-run-sso', codeMieUrl: 'https://already-own.example.com' }
      },
      workspace: { codeMieUrl: 'https://shared.example.com' }
    };

    const result = migrate(config);

    expect((result.profiles['env-a'] as any).codeMieUrl).toBe('https://already-own.example.com');
  });

  it('is a no-op when workspace has no identity fields', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: { 'env-a': { provider: 'anthropic-subscription' } },
      workspace: { hooks: { PreToolUse: [] } }
    };

    expect(migrate(config)).toBe(config);
  });

  it('is a no-op when workspace is undefined (not yet run through migration 007)', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: { 'env-a': { provider: 'anthropic-subscription' } }
    };

    expect(migrate(config)).toBe(config);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- 008-isolate-global-profile-identity`
Expected: FAIL with "Cannot find module '../008-isolate-global-profile-identity.migration.js'".

- [ ] **Step 3: Implement `src/migrations/008-isolate-global-profile-identity.migration.ts`**

Follow the exact structure of `007-decouple-provider-workspace-config.migration.ts`: a local `IDENTITY_KEYS` literal (`['codeMieUrl', 'codeMieProject', 'codeMieIntegration']`), a class with `id`, `description`, an `up()` that loads/saves only the **global** `MultiProviderConfig` via `ConfigLoader.hasGlobalConfig()` / `loadMultiProviderConfig()` / `saveMultiProviderConfig()` (local configs are untouched — the bug and this migration are global-only), and a `migrate(config)` method:

- Idempotent guard: if `config.workspace` has none of `IDENTITY_KEYS` set, return `config` unchanged (reference-equal, matching the test's `toBe(config)` checks).
- Otherwise, for every profile in `config.profiles` that does not already define any of `IDENTITY_KEYS` itself, assign all `IDENTITY_KEYS` values found on `config.workspace` onto that profile.
- Return a new config with `workspace` stripped of `IDENTITY_KEYS` (keep every other `workspace` key as-is; if stripping identity leaves `workspace` as `{}`, still keep it defined as `{}` — matching `resolveWorkspace()`'s existing "defined empty object" semantics, do NOT delete the `workspace` key itself).
- Register with `MigrationRegistry.register(new IsolateGlobalProfileIdentityMigration())` and `export { IsolateGlobalProfileIdentityMigration }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- 008-isolate-global-profile-identity`
Expected: PASS.

- [ ] **Step 5: Register the migration in `src/migrations/index.ts`**

Add `import './008-isolate-global-profile-identity.migration.js';` after the existing `007` import at line 31.

- [ ] **Step 6: Run the full migration test suite to verify no regressions**

Run: `npm run test -- src/migrations`
Expected: PASS (007's own tests untouched; 008 runs independently and after it in the registered sequence).

- [ ] **Step 7: Commit**

```bash
git add src/migrations/008-isolate-global-profile-identity.migration.ts src/migrations/__tests__/008-isolate-global-profile-identity.migration.test.ts src/migrations/index.ts
git commit -m "feat(config): add migration to isolate identity per global profile"
```

---

### Task 3: Fix the statusline's direct read path and update the project-config guide

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline.ts:726-734`
- Modify: `.ai-run/guides/usage/project-config.md`
- Test: existing statusline test file (locate via `src/agents/plugins/claude/plugin/__tests__/` — follow whatever file already covers `resolveBudget`; if none exists, add assertions to the nearest existing statusline test suite rather than creating a new file)

**Interfaces:**
- Consumes: `profile.codeMieUrl` now being populated directly on the raw global profile object (Task 1 change to `ProviderProfile`); no new exports.
- Produces: no interface changes — `resolveBudget()`'s exported signature and return shape stay identical.

- [ ] **Step 1: Write a failing test for `resolveBudget` reading per-profile identity**

Locate the existing test(s) exercising `resolveBudget` (search `src/agents/plugins/claude/plugin/__tests__/` for `statusline` or `resolveBudget`). Add a case with two profiles in the mocked config JSON, each carrying its own `codeMieUrl` directly on the profile object and no top-level `workspace.codeMieUrl`, asserting that switching the active/session profile resolves each profile's own `codeMieUrl` (mock `fetchImpl`/`getAuthHeadersImpl` as the existing tests already do, and assert on the `codeMieUrl`-derived call target, e.g. the `baseUrl`/`codeMieUrl` same-origin check or the auth-header call argument — follow the existing test's assertion style exactly).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- statusline`
Expected: FAIL — current code reads `config.workspace?.codeMieUrl`, which is `undefined` in the new fixture, so the function returns `{ budget: null, budgetError: null }` instead of attempting the live lookup.

- [ ] **Step 3: Fix `statusline.ts:726-734`**

Replace:
```typescript
const profile = config.profiles?.[profileName];
const { baseUrl } = profile ?? {};
// codeMieUrl now lives on the scope-level workspace object (migration 006), and
// userEmail is a top-level MultiProviderConfig field — neither is per-profile anymore.
const codeMieUrl = config.workspace?.codeMieUrl;
```
with:
```typescript
const profile = config.profiles?.[profileName];
const { baseUrl } = profile ?? {};
// codeMieUrl now lives directly on each global profile (EPMCDME-15411) so that
// switching the active profile resolves that profile's own CodeMie identity.
const codeMieUrl = profile?.codeMieUrl;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- statusline`
Expected: PASS.

- [ ] **Step 5: Update `.ai-run/guides/usage/project-config.md`**

Find the sentence documenting "A global profile always uses the global workspace, even inside a repository with a local config" and replace it with the corrected contract: a global profile resolves its own CodeMie identity (`codeMieUrl`/`codeMieProject`/`codeMieIntegration`) from the profile itself; only non-identity workspace fields (hooks, plugins, assistants, skillsSearchUrl, claudeAutocompactPct, metrics) remain scope-level shared across global profiles. Local profiles are unaffected by this change. This is a documentation-only edit — no test required for it.

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agents/plugins/claude/plugin/statusline.ts .ai-run/guides/usage/project-config.md
git commit -m "fix(cli): resolve statusline CodeMie URL from the active profile"
```

(include the relevant statusline test file path in this commit if Step 1 modified one)

---

## Post-implementation

- Run `npm run lint` and `npm run typecheck` before code review (Stage 5 of `sdlc-light`).
- No feature-verification stage needed — this is a non-UI backend fix (`ui` flag not set for this run).
