# Fix Registered Assistants Empty Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface `codemieAssistants` and `codemieSkills` from the `MultiProviderConfig` root through `ConfigLoader.load()` so the Registered Assistants tab is no longer empty after setup.

**Architecture:** Two surgical changes: (1) add `codemieSkills` to `ProviderProfile` so the type accepts the field, then (2) include both top-level fields in the return objects of `loadGlobalConfigProfile` and `loadLocalConfigProfile`. The `load()` method already uses `removeUndefined()` before `Object.assign`, so `undefined` from a local config that lacks these fields will not overwrite values from the global config.

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- ES modules only — all imports use `.js` extensions
- No `any` types
- `CodeMieConfigOptions = ProviderProfile` — adding a field to `ProviderProfile` is sufficient for it to be available on `CodeMieConfigOptions`

---

### Task 1: Add `codemieSkills` to `ProviderProfile` and fix both load helpers

**Files:**
- Modify: `src/env/types.ts` — add `codemieSkills?: CodemieSkill[]` to `ProviderProfile`
- Modify: `src/utils/config.ts:228` — include `codemieAssistants` + `codemieSkills` in `loadGlobalConfigProfile` return
- Modify: `src/utils/config.ts:255` — include `codemieAssistants` + `codemieSkills` in `loadLocalConfigProfile` return
- Test: `src/utils/__tests__/config-project-override.test.ts` — add round-trip tests

**Interfaces:**
- Consumes: `MultiProviderConfig.codemieAssistants`, `MultiProviderConfig.codemieSkills` (both already defined in `src/env/types.ts:172-173`)
- Produces: `ConfigLoader.load()` returning `codemieAssistants` and `codemieSkills` when present in the raw config

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the bottom of `src/utils/__tests__/config-project-override.test.ts`:

```typescript
describe('ConfigLoader - top-level fields (codemieAssistants / codemieSkills)', () => {
  it('load() returns codemieAssistants from global MultiProviderConfig root', async () => {
    const workingDir = path.join(TEST_DIR, 'project');
    const globalConfig: MultiProviderConfig = {
      version: 2,
      activeProfile: 'default',
      codemieAssistants: [
        {
          id: 'ast-1',
          name: 'Brianna',
          slug: 'brianna',
          description: 'Jira assistant',
          registeredAt: '2026-06-23T00:00:00.000Z',
        },
      ],
      profiles: {
        default: { provider: 'openai', model: 'gpt-4o', apiKey: 'test-key' },
      },
    };
    await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig));

    const config = await ConfigLoader.load(workingDir);

    expect(config.codemieAssistants).toHaveLength(1);
    expect(config.codemieAssistants![0].slug).toBe('brianna');
  });

  it('load() returns codemieSkills from global MultiProviderConfig root', async () => {
    const workingDir = path.join(TEST_DIR, 'project');
    const globalConfig: MultiProviderConfig = {
      version: 2,
      activeProfile: 'default',
      codemieSkills: [
        {
          id: 'sk-1',
          name: 'My Skill',
          slug: 'my-skill',
          description: 'A test skill',
          registeredAt: '2026-06-23T00:00:00.000Z',
        },
      ],
      profiles: {
        default: { provider: 'openai', model: 'gpt-4o', apiKey: 'test-key' },
      },
    };
    await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig));

    const config = await ConfigLoader.load(workingDir);

    expect(config.codemieSkills).toHaveLength(1);
    expect(config.codemieSkills![0].slug).toBe('my-skill');
  });

  it('local config without codemieAssistants does not overwrite global values', async () => {
    const workingDir = path.join(TEST_DIR, 'project');
    const globalConfig: MultiProviderConfig = {
      version: 2,
      activeProfile: 'default',
      codemieAssistants: [
        {
          id: 'ast-1',
          name: 'Brianna',
          slug: 'brianna',
          description: 'Jira assistant',
          registeredAt: '2026-06-23T00:00:00.000Z',
        },
      ],
      profiles: {
        default: { provider: 'openai', model: 'gpt-4o', apiKey: 'global-key' },
      },
    };
    const localConfig: MultiProviderConfig = {
      version: 2,
      activeProfile: 'default',
      // no codemieAssistants
      profiles: {
        default: { provider: 'openai', model: 'gpt-4o-mini' },
      },
    };
    await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig));
    await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify(localConfig));

    const config = await ConfigLoader.load(workingDir);

    // Global codemieAssistants must survive the local config overlay
    expect(config.codemieAssistants).toHaveLength(1);
    expect(config.codemieAssistants![0].slug).toBe('brianna');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/utils/__tests__/config-project-override.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: 3 failures — `config.codemieAssistants` is `undefined` and `config.codemieSkills` is `undefined`.

- [ ] **Step 3: Add `codemieSkills` to `ProviderProfile` in `src/env/types.ts`**

Locate the existing `codemieAssistants` entry in `ProviderProfile` (around line 123) and add `codemieSkills` directly below it:

```typescript
  // In-memory assistants/skills state (not persisted here; stored at MultiProviderConfig level)
  codemieAssistants?: CodemieAssistant[];
  codemieSkills?: CodemieSkill[];
```

- [ ] **Step 4: Fix `loadGlobalConfigProfile` return in `src/utils/config.ts`**

Replace the return statement at line 228 (inside the `if (isMultiProviderConfig(rawConfig))` block):

Before:
```typescript
      // Return profile with name included
      return { ...rawConfig.profiles[profile], name: profile };
```

After:
```typescript
      // Return profile with name included; codemieAssistants and codemieSkills live at
      // MultiProviderConfig root (not inside a profile) so they must be forwarded explicitly.
      return {
        ...rawConfig.profiles[profile],
        name: profile,
        codemieAssistants: rawConfig.codemieAssistants,
        codemieSkills: rawConfig.codemieSkills,
      };
```

- [ ] **Step 5: Fix `loadLocalConfigProfile` return in `src/utils/config.ts`**

Replace the return statement at line 255–256 (inside `if (profile && rawConfig.profiles[profile])`):

Before:
```typescript
        return { ...rawConfig.profiles[profile], name: profile };
```

After:
```typescript
        // codemieAssistants and codemieSkills live at MultiProviderConfig root; forward them
        // so load() can overlay them. removeUndefined() in load() strips undefined before
        // Object.assign, so a local config without these fields won't overwrite global values.
        return {
          ...rawConfig.profiles[profile],
          name: profile,
          codemieAssistants: rawConfig.codemieAssistants,
          codemieSkills: rawConfig.codemieSkills,
        };
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest run src/utils/__tests__/config-project-override.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: all tests in the file pass, including the 3 new ones.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/env/types.ts src/utils/config.ts src/utils/__tests__/config-project-override.test.ts
git commit -m "fix(config): surface codemieAssistants and codemieSkills from MultiProviderConfig root through ConfigLoader.load()"
```
