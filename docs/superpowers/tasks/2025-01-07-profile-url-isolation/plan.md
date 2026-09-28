# Per-Profile CodeMie Identity Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `codemie setup` from leaking one profile's `codeMieUrl`/`codeMieProject`/`codeMieIntegration` onto every other global profile (EPMCDME-15192), by storing identity per profile and resolving it profile-first with a same-server workspace fallback.

**Architecture:** Both write paths keep identity on the saved profile. `saveProfile()` seeds the global `workspace` identity only when it has none; `initProjectConfig()` keeps writing it into the local `workspace` as today. One private helper, `ConfigLoader.resolveIdentity()`, picks the profile identity as a group (local profile if it defines any identity field, else global profile), and — only when that group has no project or integration — fills gaps from the first same-server workspace (repo, then global) that holds identity. `load()` and `loadWithSources()` both use it, so values and `--show-sources` attribution cannot diverge. `resolveWorkspace()`'s whole-object rule keeps governing tooling fields only. Display and the Claude statusline read the profile's own URL first.

**Tech Stack:** TypeScript (ES modules), Vitest.

**Spec:** `docs/superpowers/tasks/2025-01-07-profile-url-isolation/spec.md`

## Global Constraints

- **No git operations** (commit, branch, push) unless the user explicitly asks — AGENTS.md, "Git Operations Only On Explicit Request".
- No migration: existing configs with no per-profile identity resolve exactly as today until re-saved (spec, "Existing configs").
- Do not touch: `initProjectConfig()`'s whole-file-rewrite behavior, provider plugins, setup steps, migration `007-decouple-provider-workspace-config`, tooling-field behavior, env/CLI override precedence (spec, "Non-Goals").
- No `baseUrl`/`codeMieUrl` mismatch warning (spec, "Resolved Decisions").
- "Same server" = both URLs equal after stripping trailing `/` and lower-casing, or at least one is missing (spec, "Terms").
- Identity is never merged field by field: not across global/local profiles, not across workspaces (spec, "Read path").
- Test command: `npx vitest run --project unit <file>` (`npm run test:unit` does not exist).
- Every existing test in `config-project-override.test.ts` → `describe('ConfigLoader - workspace resolution and project-only composition')` must pass **unchanged**. They encode today's resolution for configs without per-profile identity; if one fails, the implementation is wrong, not the test.

## Review Focus

- A same-name local profile saved after the fix must win over the global profile's own identity (local `setup` → Update must take effect) — Task 2.
- Local profile URL/project must never combine with a global profile's integration — Task 2.
- Repo workspace project must never combine with a global workspace integration or URL — Task 2 (and existing test "resolves workspace from the local scope, overriding the global scope entirely").
- Row 8: profile URL on a server no workspace matches resolves with no project and no integration — Task 2.
- `--show-sources` attribution must match the values `load()` returns, and env/CLI layers must still come last — Task 3.

## Test fixture notes

- `load()`/`loadWithSources()` tests go inside `describe('ConfigLoader - workspace resolution and project-only composition')` → `describe('load with selected global and local team profiles')`. Its `beforeEach` redirects the `GLOBAL_CONFIG`/`GLOBAL_CONFIG_DIR` statics; the first top-level describe does not, so `load()` tests there would read the real home config.
- Use the block's `writeGlobal()`/`writeLocal()` helpers to build "never re-saved" profiles. `saveProfile()` now stores identity on the profile, so it cannot produce a profile without identity plus a workspace with identity.
- `path.join(TEST_DIR, '.codemie', ...)` is the redirected **global** config, so `load(TEST_DIR)` would also read it as a local config. For "outside a repo" cases use a directory with no `.codemie/`, e.g. `path.join(TEST_DIR, 'elsewhere')` (create it first).
- Add a small helper next to `writeGlobal`/`writeLocal` for setting a scope's workspace:

```typescript
async function setWorkspace(configPath: string, workspace: Record<string, unknown>) {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  raw.workspace = workspace;
  await fs.writeFile(configPath, JSON.stringify(raw, null, 2));
}
```

---

### Task 1: Write paths store identity on the profile

**Files:**
- Modify: `src/env/types.ts:51-98` (`ProviderProfile`)
- Modify: `src/utils/config.ts:557-619` (`WORKSPACE_KEYS`, `splitProfileAndWorkspace`, `saveProfile`), `config.ts:900` (`initProjectConfig`)
- Test: `src/utils/__tests__/config-project-override.test.ts:394-425` (`describe('saveProfile / initProjectConfig — workspace split')`)

**Interfaces:**
- Produces (private, on `ConfigLoader`): `IDENTITY_KEYS`, `TOOLING_KEYS`, `pickIdentity()`, `hasIdentity()`, `omitIdentity()`; module-level types `IdentityKey`, `IdentityFields`. Tasks 2-3 consume them.

- [ ] **Step 1: Write the failing tests**

In the `saveProfile / initProjectConfig — workspace split` block, replace the test at line 395 and the test at line 412 (both assert today's routing), and add the rest:

```typescript
it('saveProfile stores identity on profiles[name] and seeds an empty global workspace', async () => {
  await ConfigLoader.saveProfile('p1', {
    provider: 'ai-run-sso',
    codeMieUrl: 'https://x',
    codeMieProject: 'proj'
  } as any);

  const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

  expect(config.profiles.p1.codeMieUrl).toBe('https://x');
  expect(config.profiles.p1.codeMieProject).toBe('proj');
  expect(config.workspace?.codeMieUrl).toBe('https://x');
  expect(config.workspace?.codeMieProject).toBe('proj');
});

it('saving a second profile on another server leaves the first profile and the workspace identity untouched', async () => {
  await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://a', codeMieProject: 'proj-a' } as any);
  await ConfigLoader.saveProfile('p2', { provider: 'ai-run-sso', codeMieUrl: 'https://b', codeMieProject: 'proj-b' } as any);

  const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

  expect(config.profiles.p1.codeMieUrl).toBe('https://a');
  expect(config.profiles.p1.codeMieProject).toBe('proj-a');
  expect(config.profiles.p2.codeMieUrl).toBe('https://b');
  expect(config.workspace?.codeMieUrl).toBe('https://a');
  expect(config.workspace?.codeMieProject).toBe('proj-a');
});

it('updating one profile does not change another profile or the workspace identity', async () => {
  await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://a', codeMieProject: 'proj-a' } as any);
  await ConfigLoader.saveProfile('p2', { provider: 'ai-run-sso', codeMieUrl: 'https://a', codeMieProject: 'proj-a2' } as any);
  await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://b', codeMieProject: 'proj-b' } as any);

  const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

  expect(config.profiles.p1.codeMieUrl).toBe('https://b');
  expect(config.profiles.p2.codeMieUrl).toBe('https://a');
  expect(config.profiles.p2.codeMieProject).toBe('proj-a2');
  expect(config.workspace?.codeMieUrl).toBe('https://a');
});

it('re-saving a profile without an integration drops its previous integration', async () => {
  const integration = { id: 'int-1', alias: 'old' } as unknown as CodeMieIntegrationInfo;
  await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://a', codeMieProject: 'proj', codeMieIntegration: integration } as any);
  await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', codeMieUrl: 'https://b', codeMieProject: 'proj-b' } as any);

  const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

  expect(config.profiles.p1.codeMieIntegration).toBeUndefined();
});

it('saveProfile still routes tooling fields into the global workspace', async () => {
  await ConfigLoader.saveProfile('p1', { provider: 'ai-run-sso', skillsSearchUrl: 'https://skills' } as any);

  const config: MultiProviderConfig = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8'));

  expect((config.profiles.p1 as any).skillsSearchUrl).toBeUndefined();
  expect(config.workspace?.skillsSearchUrl).toBe('https://skills');
});

it('initProjectConfig stores identity on the local profile and in the local workspace', async () => {
  const workingDir = path.join(TEST_DIR, 'project');
  await ConfigLoader.initProjectConfig(workingDir, {
    profileName: 'p1',
    codeMieProject: 'proj'
  });

  const config: MultiProviderConfig = JSON.parse(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8'));

  expect(config.profiles.p1.codeMieProject).toBe('proj');
  expect(config.workspace?.codeMieProject).toBe('proj');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit src/utils/__tests__/config-project-override.test.ts`
Expected: FAIL — `config.profiles.p1.codeMieUrl` / `codeMieProject` are `undefined` (routed to `workspace` by the current code), and the second-save test sees `workspace.codeMieUrl === 'https://b'`.

- [ ] **Step 3: Add identity fields to `ProviderProfile`**

In `src/env/types.ts:51-98`, add to `ProviderProfile`, using the same doc style as the matching `WorkspaceConfig` fields (`types.ts:106-108`):

```typescript
codeMieUrl?: string;
codeMieProject?: string;
codeMieIntegration?: CodeMieIntegrationInfo;
```

- [ ] **Step 4: Split the key list and add identity helpers**

In `src/utils/config.ts`, add module-level types next to the file's other local types:

```typescript
type IdentityKey = 'codeMieUrl' | 'codeMieProject' | 'codeMieIntegration';
type IdentityFields = Pick<WorkspaceConfig, IdentityKey>;
```

Replace `WORKSPACE_KEYS` (`config.ts:557-572`) with two lists, update its doc comment, and point `splitProfileAndWorkspace()` (`config.ts:574-593`) at `TOOLING_KEYS` so identity stays on the profile half:

```typescript
private static readonly IDENTITY_KEYS: IdentityKey[] = ['codeMieUrl', 'codeMieProject', 'codeMieIntegration'];

private static readonly TOOLING_KEYS: (keyof WorkspaceConfig)[] = [
  'hooks',
  'plugins',
  'assistants',
  'skillsSearchUrl',
  'claudeAutocompactPct',
  'metrics'
];
```

Add the helpers beside `splitProfileAndWorkspace()`:

```typescript
private static pickIdentity(source: Partial<CodeMieConfigOptions> | null | undefined): IdentityFields {
  const identity: IdentityFields = {};
  if (!source) return identity;
  for (const key of this.IDENTITY_KEYS) {
    if (source[key] !== undefined) {
      (identity as Record<IdentityKey, unknown>)[key] = source[key];
    }
  }
  return identity;
}

private static hasIdentity(source: Partial<CodeMieConfigOptions> | null | undefined): boolean {
  return Object.keys(this.pickIdentity(source)).length > 0;
}

private static omitIdentity<T extends object>(source: T): T {
  const copy = { ...source } as Record<string, unknown>;
  for (const key of this.IDENTITY_KEYS) {
    delete copy[key];
  }
  return copy as T;
}
```

- [ ] **Step 5: `saveProfile()` — identity on the profile, workspace identity seeded only when empty**

In `saveProfile()` (`config.ts:598-619`), replace the workspace write:

```typescript
const { profile: profileFields, workspace: workspaceFields } = this.splitProfileAndWorkspace(cleanProfile);

(profileFields as any).name = profileName;
config.profiles[profileName] = profileFields as ProviderProfile;

const seededIdentity = this.hasIdentity(config.workspace) ? {} : this.pickIdentity(cleanProfile);
const workspaceUpdate = { ...workspaceFields, ...seededIdentity };
if (Object.keys(this.removeUndefined(workspaceUpdate)).length > 0) {
  config.workspace = { ...config.workspace, ...workspaceUpdate };
}
```

`config.profiles[profileName]` is replaced whole, so all three identity fields are replaced as a group and a stale integration cannot survive.

- [ ] **Step 6: `initProjectConfig()` — identity on the local profile and in the local workspace**

At `config.ts:900`:

```typescript
const { profile, workspace: toolingWorkspace } = this.splitProfileAndWorkspace(rawOverrides);
const workspace = { ...toolingWorkspace, ...this.pickIdentity(rawOverrides) };
```

The rest of the function (whole-file write, `activeProfile`) is unchanged.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npx vitest run --project unit src/utils/__tests__/config-project-override.test.ts`
Expected: PASS, including every pre-existing test in the file.

---

### Task 2: `load()` resolves identity profile-first with a same-server workspace fallback

**Files:**
- Modify: `src/utils/config.ts:113-136` (`load()`), new private helpers near `resolveWorkspace()` (`config.ts:203-221`)
- Test: `src/utils/__tests__/config-project-override.test.ts` — new `describe('identity resolution')` nested inside `describe('load with selected global and local team profiles')`

**Interfaces:**
- Consumes: Task 1 helpers and types.
- Produces: private `isSameServer(a?, b?)` and `resolveIdentity(workingDir, globalProfile, localProfile): Promise<{ identity: IdentityFields; sources: Partial<Record<IdentityKey, 'global' | 'project'>> }>` — Task 3 reuses `sources`.

- [ ] **Step 1: Write the failing tests**

Fixture for the spec's resolution table: global workspace `https://lab.example.com` / `proj-g`; repo workspace `https://lab.example.com` / `team-x`. Build profiles with `writeGlobal()`/`writeLocal()` and workspaces with `setWorkspace()`. For repo cases, write a local config whose `activeProfile` is a local-only `team` profile without identity, so the selected global profile goes through `applyProjectOnly`. Use `load(projectDir, { name })` for repo cases and `load(elsewhereDir, { name })` for outside-repo cases.

Write one test per row, asserting `codeMieUrl`, `codeMieProject` and `codeMieIntegration`:

| Row | Profile (global) | Dir | Expected |
|---|---|---|---|
| 1 | own `https://preview.example.com` / `my-proj` | repo | preview / `my-proj` |
| 2 | own `https://lab.example.com` / `my-proj` | repo | lab / `my-proj` |
| 3 | no identity | elsewhere | lab / `proj-g` |
| 4 | no identity | repo | lab / `team-x` |
| 5 | `bedrock`, no identity | elsewhere | lab / `proj-g` |
| 6 | `bedrock`, no identity | repo | lab / `team-x` |
| 7 | URL only `https://lab.example.com` | repo | lab / `team-x` |
| 8 | URL only `https://preview.example.com` | repo | preview / no project / no integration |

Plus these cases:

```typescript
it('a same-name local profile with its own identity wins over the global profile identity', async () => {
  await writeGlobal('epm', {
    epm: { provider: 'ai-run-sso', codeMieUrl: 'https://lab.example.com', codeMieProject: 'old-proj', name: 'epm' }
  });
  await ConfigLoader.initProjectConfig(path.join(TEST_DIR, 'project'), {
    profileName: 'epm',
    provider: 'ai-run-sso',
    codeMieUrl: 'https://preview.example.com',
    codeMieProject: 'new-proj'
  });

  const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'epm' });

  expect(cfg.codeMieUrl).toBe('https://preview.example.com');
  expect(cfg.codeMieProject).toBe('new-proj');
});

it('does not combine a local profile identity with the global profile integration', async () => {
  await writeGlobal('epm', {
    epm: {
      provider: 'ai-run-sso',
      codeMieUrl: 'https://lab.example.com',
      codeMieProject: 'lab-proj',
      codeMieIntegration: { id: 'lab-int' } as unknown as CodeMieIntegrationInfo,
      name: 'epm'
    }
  });
  await writeLocal('epm', {
    epm: { provider: 'ai-run-sso', codeMieUrl: 'https://preview.example.com', codeMieProject: 'preview-proj', name: 'epm' }
  });

  const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'epm' });

  expect(cfg.codeMieUrl).toBe('https://preview.example.com');
  expect(cfg.codeMieProject).toBe('preview-proj');
  expect(cfg.codeMieIntegration).toBeUndefined();
});

it('takes identity from one workspace only — no repo project with a global integration', async () => {
  await writeGlobal('anthropic', { anthropic: { provider: 'anthropic-subscription', name: 'anthropic' } });
  await setWorkspace(GLOBAL_CONFIG_PATH, {
    codeMieUrl: 'https://lab.example.com',
    codeMieProject: 'proj-g',
    codeMieIntegration: { id: 'g-int' }
  });
  await writeLocal('team', { team: { provider: 'ai-run-sso', name: 'team' } });
  await setWorkspace(LOCAL_CONFIG_PATH, { codeMieUrl: 'https://lab.example.com', codeMieProject: 'team-x' });

  const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'anthropic' });

  expect(cfg.codeMieProject).toBe('team-x');
  expect(cfg.codeMieIntegration).toBeUndefined();
});

it('a repo workspace holding only tooling fields falls through to the global workspace identity', async () => {
  await writeGlobal('anthropic', { anthropic: { provider: 'anthropic-subscription', name: 'anthropic' } });
  await setWorkspace(GLOBAL_CONFIG_PATH, { codeMieUrl: 'https://lab.example.com', codeMieProject: 'proj-g' });
  await writeLocal('team', { team: { provider: 'ai-run-sso', name: 'team' } });
  await setWorkspace(LOCAL_CONFIG_PATH, { skillsSearchUrl: 'https://skills' });

  const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'anthropic' });

  expect(cfg.codeMieUrl).toBe('https://lab.example.com');
  expect(cfg.codeMieProject).toBe('proj-g');
  expect(cfg.skillsSearchUrl).toBe('https://skills');
});

it('treats URLs differing only by trailing slash or case as the same server', async () => {
  await writeGlobal('jwt', { jwt: { provider: 'ai-run-jwt', codeMieUrl: 'HTTPS://LAB.example.com/', name: 'jwt' } });
  await writeLocal('team', { team: { provider: 'ai-run-sso', name: 'team' } });
  await setWorkspace(LOCAL_CONFIG_PATH, { codeMieUrl: 'https://lab.example.com', codeMieProject: 'team-x' });

  const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'jwt' });

  expect(cfg.codeMieUrl).toBe('HTTPS://LAB.example.com/');
  expect(cfg.codeMieProject).toBe('team-x');
});

it('CODEMIE_URL overrides the resolved identity when no profile is explicitly selected', async () => {
  await writeGlobal('jwt', { jwt: { provider: 'ai-run-jwt', codeMieUrl: 'https://lab.example.com', name: 'jwt' } });
  const elsewhere = path.join(TEST_DIR, 'elsewhere');
  await fs.mkdir(elsewhere, { recursive: true });
  process.env.CODEMIE_URL = 'https://env.example.com';
  try {
    const cfg = await ConfigLoader.load(elsewhere);
    expect(cfg.codeMieUrl).toBe('https://env.example.com');
  } finally {
    delete process.env.CODEMIE_URL;
  }
});

it('an explicitly selected profile keeps its own URL over CODEMIE_URL (profile protection)', async () => {
  await writeGlobal('jwt', { jwt: { provider: 'ai-run-jwt', codeMieUrl: 'https://lab.example.com', name: 'jwt' } });
  const elsewhere = path.join(TEST_DIR, 'elsewhere');
  await fs.mkdir(elsewhere, { recursive: true });
  process.env.CODEMIE_URL = 'https://env.example.com';
  try {
    const cfg = await ConfigLoader.load(elsewhere, { name: 'jwt' });
    expect(cfg.codeMieUrl).toBe('https://lab.example.com');
  } finally {
    delete process.env.CODEMIE_URL;
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit src/utils/__tests__/config-project-override.test.ts`
Expected: FAIL — at least rows 1, 2, 8, the same-name local profile case and the local/global integration case, because the current `load()` overwrites identity with the whole `resolveWorkspace()` object. Rows 3-7 may already pass; they pin behavior that must not change.

- [ ] **Step 3: Add `isSameServer()` and `resolveIdentity()`**

Near `resolveWorkspace()` (`config.ts:203-221`):

```typescript
private static isSameServer(a?: string, b?: string): boolean {
  if (!a || !b) return true;
  const normalize = (url: string): string => url.replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

private static async resolveIdentity(
  workingDir: string,
  globalProfile: Partial<CodeMieConfigOptions>,
  localProfile: Partial<CodeMieConfigOptions>
): Promise<{ identity: IdentityFields; sources: Partial<Record<IdentityKey, 'global' | 'project'>> }> {
  const useLocal = this.hasIdentity(localProfile);
  const identity = this.pickIdentity(useLocal ? localProfile : globalProfile);
  const sources: Partial<Record<IdentityKey, 'global' | 'project'>> = {};
  for (const key of Object.keys(identity) as IdentityKey[]) {
    sources[key] = useLocal ? 'project' : 'global';
  }

  if (identity.codeMieProject !== undefined || identity.codeMieIntegration !== undefined) {
    return { identity, sources };
  }

  const localMultiConfig = await this.loadLocalMultiProviderConfig(workingDir);
  const globalMultiConfig = await this.loadMultiProviderConfig();
  const layers: { workspace: WorkspaceConfig | null | undefined; source: 'project' | 'global' }[] = [
    { workspace: localMultiConfig.workspace, source: 'project' },
    { workspace: globalMultiConfig.workspace, source: 'global' }
  ];

  for (const { workspace, source } of layers) {
    if (!workspace || !this.hasIdentity(workspace)) continue;
    if (!this.isSameServer(identity.codeMieUrl, workspace.codeMieUrl)) continue;

    for (const key of this.IDENTITY_KEYS) {
      if (identity[key] === undefined && workspace[key] !== undefined) {
        (identity as Record<IdentityKey, unknown>)[key] = workspace[key];
        sources[key] = source;
      }
    }
    break;
  }

  return { identity, sources };
}
```

Add a JSDoc block to `resolveIdentity()` in the style of `resolveWorkspace()`'s, stating the order: profile group (local over global), then the first same-server workspace holding identity (local, then global).

- [ ] **Step 4: Wire into `load()`**

Replace `config.ts:131-136` (the workspace merge):

```typescript
const workspace = await this.resolveWorkspace(workingDir);
Object.assign(config, this.removeUndefined(this.omitIdentity(workspace)));

const { identity } = await this.resolveIdentity(workingDir, globalConfig, effectiveLocalConfig);
for (const key of this.IDENTITY_KEYS) {
  delete (config as Record<string, unknown>)[key];
}
Object.assign(config, this.removeUndefined(identity));
```

Deleting first drops identity that `Object.assign` merged field by field from the global and local profiles. Update the comment above the block so it describes tooling fields resolving by whole-object override and identity resolving via `resolveIdentity()`. The env/CLI steps that follow (`config.ts:138-198`) are unchanged.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run --project unit src/utils/__tests__/config-project-override.test.ts`
Expected: PASS, including every pre-existing test in the file unchanged.

---

### Task 3: `loadWithSources()` uses the same resolution for attribution

**Files:**
- Modify: `src/utils/config.ts:1201-1289` (`loadWithSources()`)
- Test: `src/utils/__tests__/config-project-override.test.ts` (inside the Task 2 `describe`)

**Interfaces:**
- Consumes: `resolveIdentity()` `sources` (Task 2), `omitIdentity()` (Task 1).

- [ ] **Step 1: Write the failing tests**

```typescript
it('attributes a global profile own codeMieUrl to "global"', async () => {
  await writeGlobal('jwt', { jwt: { provider: 'ai-run-jwt', codeMieUrl: 'https://own.example.com', name: 'jwt' } });
  await setWorkspace(GLOBAL_CONFIG_PATH, { codeMieUrl: 'https://workspace.example.com' });

  const { config: merged, sources } = await ConfigLoader.loadWithSources(path.join(TEST_DIR, 'project'), { name: 'jwt' });

  expect(merged.codeMieUrl).toBe('https://own.example.com');
  expect(sources.codeMieUrl?.value).toBe('https://own.example.com');
  expect(sources.codeMieUrl?.source).toBe('global');
});

it('attributes a same-name local profile identity to "project"', async () => {
  await writeGlobal('epm', { epm: { provider: 'ai-run-sso', codeMieUrl: 'https://lab.example.com', codeMieProject: 'old', name: 'epm' } });
  await writeLocal('epm', { epm: { provider: 'ai-run-sso', codeMieUrl: 'https://preview.example.com', codeMieProject: 'new', name: 'epm' } });

  const { sources } = await ConfigLoader.loadWithSources(path.join(TEST_DIR, 'project'), { name: 'epm' });

  expect(sources.codeMieProject?.value).toBe('new');
  expect(sources.codeMieProject?.source).toBe('project');
});

it('attributes a global-workspace-filled project to "global" and a repo-workspace-filled one to "project"', async () => {
  await writeGlobal('jwt', { jwt: { provider: 'ai-run-jwt', codeMieUrl: 'https://lab.example.com', name: 'jwt' } });
  await setWorkspace(GLOBAL_CONFIG_PATH, { codeMieUrl: 'https://lab.example.com', codeMieProject: 'proj-g' });
  const elsewhere = path.join(TEST_DIR, 'elsewhere');
  await fs.mkdir(elsewhere, { recursive: true });

  const outside = await ConfigLoader.loadWithSources(elsewhere, { name: 'jwt' });
  expect(outside.sources.codeMieProject?.source).toBe('global');

  await writeLocal('team', { team: { provider: 'ai-run-sso', name: 'team' } });
  await setWorkspace(LOCAL_CONFIG_PATH, { codeMieUrl: 'https://lab.example.com', codeMieProject: 'team-x' });

  const inside = await ConfigLoader.loadWithSources(path.join(TEST_DIR, 'project'), { name: 'jwt' });
  expect(inside.sources.codeMieProject?.value).toBe('team-x');
  expect(inside.sources.codeMieProject?.source).toBe('project');
});

it('still attributes CODEMIE_URL to "env" when it wins', async () => {
  await writeGlobal('jwt', { jwt: { provider: 'ai-run-jwt', codeMieUrl: 'https://lab.example.com', name: 'jwt' } });
  const elsewhere = path.join(TEST_DIR, 'elsewhere');
  await fs.mkdir(elsewhere, { recursive: true });
  process.env.CODEMIE_URL = 'https://env.example.com';
  try {
    const { sources } = await ConfigLoader.loadWithSources(elsewhere);
    expect(sources.codeMieUrl?.source).toBe('env');
  } finally {
    delete process.env.CODEMIE_URL;
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit src/utils/__tests__/config-project-override.test.ts`
Expected: FAIL — the first test reports `https://workspace.example.com` from the whole-object workspace layer; the same-name local case reports the global value or a workspace value.

- [ ] **Step 3: Replace identity in the layer list**

In `loadWithSources()` (`config.ts:1229-1262`), after `globalConfig`, `effectiveLocalConfig`, `workspace` and `workspaceSource` are computed:

```typescript
const { identity, sources: identitySources } = await this.resolveIdentity(workingDir, globalConfig, effectiveLocalConfig);
const identityLayers: ConfigLayer[] = this.IDENTITY_KEYS
  .filter(key => identity[key] !== undefined)
  .map(key => ({ data: { [key]: identity[key] }, source: identitySources[key] ?? 'global' }));
```

Build `configs` in this order — the identity layers **before** `env` and `cli`, so overrides still win in the last-one-wins loop at `config.ts:1273-1279`:

1. `default` (unchanged)
2. `{ data: this.omitIdentity(globalConfig), source: 'global' }`
3. `{ data: this.omitIdentity(effectiveLocalConfig), source: 'project' }`
4. `{ data: this.omitIdentity(workspace), source: workspaceSource }`
5. `...identityLayers`
6. `env` (unchanged), then `cli` when present (unchanged)

The returned `config` still comes from `this.load(workingDir, cliOverrides)`; since both use `resolveIdentity()`, values and attribution agree.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project unit src/utils/__tests__/config-project-override.test.ts`
Expected: PASS, including the existing `loadWithSources reports …` tests unchanged.

---

### Task 4: `profile list` / `profile status` show the per-profile URL

**Files:**
- Modify: `src/cli/commands/profile/display.ts:40,114`
- Modify: `src/cli/commands/profile/index.ts:153-156`
- Test: `src/cli/commands/profile/__tests__/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('ProfileDisplay — workspace-resolved codeMieUrl')` block:

```typescript
it('format() prefers the profile\'s own codeMieUrl over the workspace value', () => {
  const output = ProfileDisplay.format(
    { name: 'personal', active: true, profile: { provider: 'ai-run-sso', codeMieUrl: 'https://own' } as any, source: 'global' },
    'https://workspace-url'
  );
  expect(output).toContain('https://own');
  expect(output).not.toContain('https://workspace-url');
});
```

Add the equivalent `formatStatus()` case, mirroring how the existing `formatStatus()` test at `index.test.ts:97` captures output.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit src/cli/commands/profile/__tests__/index.test.ts`
Expected: FAIL — `display.ts:40` and `:114` use `workspaceCodeMieUrl ?? profile.codeMieUrl`.

- [ ] **Step 3: Swap the fallback order**

At `display.ts:40` and `display.ts:114`: `codeMieUrl: profile.codeMieUrl ?? workspaceCodeMieUrl`. The existing tests at `index.test.ts:88` and `:97` (profile without a URL) keep passing.

- [ ] **Step 4: `profile status` shows the resolved URL**

In `handleStatus()` (`profile/index.ts:101-158`), `config` from `ConfigLoader.load(workingDir)` (line 103) already holds the resolved identity. Replace lines 153-156:

```typescript
ProfileDisplay.formatStatus(activeProfileInfo, authStatus, config.codeMieUrl);
```

and delete the now-unused `resolveWorkspace()` call. `listProfiles()` (line 57) keeps passing the workspace URL as the display fallback.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run --project unit src/cli/commands/profile/__tests__/index.test.ts`
Expected: PASS

---

### Task 5: Claude statusline reads the active profile's `codeMieUrl` first

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline.mjs:214-222`
- Test: `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts:200-212`

- [ ] **Step 1: Write the failing tests**

Rewrite the test at `statusline.test.ts:200` so it covers only what remains true — `userEmail` must come from the top level — and drop its claim that a profile-level `codeMieUrl` is ignored:

```typescript
it('skips silently when userEmail exists only on the profile, not at the top level', async () => {
  const readFile = vi.fn()
    .mockRejectedValueOnce(new Error('no cache'))
    .mockResolvedValueOnce(JSON.stringify({
      activeProfile: 'default',
      profiles: { default: { codeMieUrl: 'https://x', baseUrl: 'https://x/api', userEmail: 'me@x.com' } },
    }));
  const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl: vi.fn() });
  expect(result).toEqual({ budget: null, budgetError: null });
});
```

Add:

```typescript
it('uses the active profile codeMieUrl when the workspace has none', async () => {
  const readFile = vi.fn()
    .mockRejectedValueOnce(new Error('no cache'))
    .mockResolvedValueOnce(JSON.stringify({
      activeProfile: 'default',
      userEmail: 'me@x.com',
      profiles: { default: { codeMieUrl: 'https://own', baseUrl: 'https://own/api' } },
    }));
  const getAuthHeadersImpl = vi.fn().mockResolvedValue(null);
  const result = await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl });

  expect(getAuthHeadersImpl).toHaveBeenCalledWith('https://own');
  expect(result).toEqual({ budget: null, budgetError: 'reauthenticate' });
});

it('prefers the active profile codeMieUrl over the workspace codeMieUrl', async () => {
  const readFile = vi.fn()
    .mockRejectedValueOnce(new Error('no cache'))
    .mockResolvedValueOnce(JSON.stringify({
      activeProfile: 'default',
      userEmail: 'me@x.com',
      workspace: { codeMieUrl: 'https://workspace' },
      profiles: { default: { codeMieUrl: 'https://own', baseUrl: 'https://own/api' } },
    }));
  const getAuthHeadersImpl = vi.fn().mockResolvedValue(null);
  await resolveBudget({ readFile, writeFile: vi.fn(), fetchImpl: vi.fn(), getAuthHeadersImpl });

  expect(getAuthHeadersImpl).toHaveBeenCalledWith('https://own');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit src/agents/plugins/claude/plugin/__tests__/statusline.test.ts`
Expected: FAIL — the two new tests; `statusline.mjs:218` reads only `config.workspace?.codeMieUrl`.

- [ ] **Step 3: Read the profile first**

At `statusline.mjs:216-218`:

```javascript
const codeMieUrl = profile?.codeMieUrl ?? config.workspace?.codeMieUrl;
```

Replace the adjacent comment so it states the profile-first, workspace-fallback order and that `userEmail` is top-level only. The statusline reads only the global file and applies no same-server check; that matches its current scope.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project unit src/agents/plugins/claude/plugin/__tests__/statusline.test.ts`
Expected: PASS

---

### Task 6: Update the stale guide section

**Files:**
- Modify: `.ai-run/guides/usage/project-config.md:148-158`

- [ ] **Step 1: Rewrite "Team project context with a selected provider profile"**

Replace lines 150-158 (pre-#502 behavior) with the spec's read-path order: a profile's own identity wins when it includes a project or integration (a same-name local profile's identity replaces the global profile's as a group); otherwise the first workspace — repo, then global — that holds identity and is on the same server fills what the profile lacks; a workspace on a different server contributes nothing; environment variables and CLI flags still override. Keep the two example commands, adjusting their comments to match.

No test — documentation only.

---

### Task 7: Final verification

- [ ] **Step 1: Type check and lint**

Run: `npm run typecheck` then `npm run lint`
Expected: both clean (lint runs with `--max-warnings=0`).

- [ ] **Step 2: Run all affected test files**

Run:
```
npx vitest run --project unit src/utils/__tests__/config-project-override.test.ts src/cli/commands/profile/__tests__/index.test.ts src/agents/plugins/claude/plugin/__tests__/statusline.test.ts src/migrations/__tests__/007-decouple-provider-workspace-config.migration.test.ts
```
Expected: PASS. Migration 007 tests are included because they share the config types.

- [ ] **Step 3: Confirm scope**

`git diff --stat` touches only: `src/env/types.ts`, `src/utils/config.ts`, `src/cli/commands/profile/display.ts`, `src/cli/commands/profile/index.ts`, `src/agents/plugins/claude/plugin/statusline.mjs`, `.ai-run/guides/usage/project-config.md`, and the three test files. The pre-existing unrelated working-tree edits (`src/cli/first-time.ts`, `.codemie/codemie-cli.config.json`) are not part of this change and must not be modified or included.

---

## Self-Review

**Spec coverage:** Types → Task 1 Step 3. Write path (profile storage, group replacement, seed-only-when-empty) → Task 1 Steps 5, and tests. Local scope (identity on local profile and local workspace) → Task 1 Step 6. Read path (group profile identity, stop on project/integration, first same-server workspace only, env/CLI last) → Task 2. `loadWithSources()` attribution → Task 3. Display and statusline → Tasks 4-5. Resolution examples rows 1-8 → Task 2 Step 1. Guide AC → Task 6. No migration → Global Constraints.

**Existing behavior pinned:** the existing `workspace resolution and project-only composition` tests must pass unchanged — including "resolves workspace from the local scope, overriding the global scope entirely", which fails if identity is taken from more than one workspace.

**Negative constraints:** no migration file; `initProjectConfig()` still rewrites the whole file; no provider-plugin, setup-step or migration-007 source file changes; env/CLI steps in `load()` unchanged and pinned by tests in Tasks 2-3; no git operations without an explicit request.
