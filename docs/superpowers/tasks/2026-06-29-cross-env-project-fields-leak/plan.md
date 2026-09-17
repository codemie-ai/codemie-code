# Cross-env Profile Leak in ConfigLoader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `ConfigLoader` from preserving the local team profile's `codeMieProject`, `codeMieIntegration`, and `codeMieUrl` when `--profile <global>` targets a different CodeMie environment than the team's local `activeProfile`.

**Architecture:** Add a private static URL-equality gate on top of the existing `applyProjectOnly` branch in `ConfigLoader.load()`. Apply the same gate at the parallel call site in `ConfigLoader.loadWithSources()`, hoisting `loadGlobalConfigProfile` so the comparison value is in scope before the filter decision. `PROJECT_FIELDS` and `filterProjectFields` are unchanged.

**Tech Stack:** TypeScript (ES modules, `.js` import extension required), Vitest, Node ≥ 20, `valtio` not used here. Existing test patterns: real temp dirs under `process.cwd()/tmp-test-config/`, `vi.spyOn(paths, 'getCodemieHome')` for global-config redirection.

## Global Constraints

- Inline URL normalization: `url.replace(/\/+$/, '').toLowerCase()`. Do NOT import `ensureApiBase` from `src/providers/core/codemie-auth-helpers.ts` — it appends `/code-assistant-api` and would create a cross-layer dependency.
- Gate triggers ONLY when both URLs are non-empty AND normalized-differ. All other combinations (either side empty, both empty, both equal) preserve project context as today.
- All three `PROJECT_FIELDS` (`codeMieProject`, `codeMieIntegration`, `codeMieUrl`) drop atomically as a bundle — never partially.
- `load()` and `loadWithSources()` must produce parity for the same inputs (the final merged config is identical).
- Test framework: Vitest. New tests must follow the existing `tmp-test-config` / `vi.spyOn` pattern in `src/utils/__tests__/config-project-override.test.ts`.
- ES-module imports require the `.js` extension (TypeScript convention in this repo).
- No new public API on `ConfigLoader`. The gate is a `private static` helper.
- Commit message format: Conventional Commits (`fix(config): ...`). No ticket prefix on the type branch (per repo `git-workflow.md`).
- Tests only on explicit request — but this task IS an explicit test request (TDD is mandated by sdlc-light).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/utils/config.ts` | Modify | Add `shouldPreserveProjectContext` helper; wire gate into `load()` and `loadWithSources()`. |
| `src/utils/__tests__/config-project-override.test.ts` | Modify | Append a new `describe('ConfigLoader - cross-env URL gate', ...)` block with helper-unit tests and integration tests. |
| `.ai-run/guides/usage/project-config.md` | Modify | Add a URL-equality note under the "Team profile with personal provider" pattern. |

No new files. No file deletions.

---

## Task 1: Add `shouldPreserveProjectContext` private helper

**Files:**
- Modify: `src/utils/config.ts` — add helper near existing `filterProjectFields` (~line 363) and the `PROJECT_FIELDS` constant (~line 353).
- Test: `src/utils/__tests__/config-project-override.test.ts` — append new describe block.

**Interfaces:**
- Produces: `private static shouldPreserveProjectContext(localUrl: string | undefined, globalUrl: string | undefined): boolean` — true iff URL pair does NOT indicate a cross-env conflict. Tasks 2 and 3 consume this exact signature.

**Test-first: yes — six failing tests for the helper covering same URL, different URL, trailing slash, case difference, both undefined, one undefined.**

- [ ] **Step 1: Open the test file and locate the closing `});` of the existing root `describe`**

Locate the final `});` that closes `describe('ConfigLoader - Project-Level Configuration', ...)`. The new describe block sits AFTER that closing — as a sibling, not nested. (Sibling avoids re-running the `beforeEach`/`afterEach` filesystem setup for pure-function tests.)

- [ ] **Step 2: Write the failing helper unit tests**

Append to `src/utils/__tests__/config-project-override.test.ts`:

```typescript
describe('ConfigLoader - cross-env URL gate', () => {
  describe('shouldPreserveProjectContext', () => {
    // Helper is private — access via index signature cast for unit testing.
    // This is the established pattern when a Vitest suite needs to reach a
    // class-private static. No production code reads it this way.
    const gate = (l: string | undefined, g: string | undefined): boolean =>
      (ConfigLoader as unknown as {
        shouldPreserveProjectContext: (l?: string, g?: string) => boolean;
      }).shouldPreserveProjectContext(l, g);

    it('preserves when both URLs are equal', () => {
      expect(gate('https://prod.example.com', 'https://prod.example.com')).toBe(true);
    });

    it('preserves when URLs differ only by trailing slash', () => {
      expect(gate('https://prod.example.com/', 'https://prod.example.com')).toBe(true);
    });

    it('preserves when URLs differ only by case', () => {
      expect(gate('https://PROD.example.com', 'https://prod.example.com')).toBe(true);
    });

    it('drops when URLs differ on host', () => {
      expect(gate('https://prod.example.com', 'https://preview.example.com')).toBe(false);
    });

    it('preserves when local URL is undefined', () => {
      expect(gate(undefined, 'https://preview.example.com')).toBe(true);
    });

    it('preserves when global URL is undefined', () => {
      expect(gate('https://prod.example.com', undefined)).toBe(true);
    });

    it('preserves when both URLs are undefined', () => {
      expect(gate(undefined, undefined)).toBe(true);
    });

    it('preserves when local URL is empty string', () => {
      expect(gate('', 'https://preview.example.com')).toBe(true);
    });

    it('preserves when global URL is empty string', () => {
      expect(gate('https://prod.example.com', '')).toBe(true);
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts -t "shouldPreserveProjectContext"`
Expected: All 9 tests fail with `TypeError: ConfigLoader.shouldPreserveProjectContext is not a function` (helper doesn't exist yet).

- [ ] **Step 4: Implement the helper in `src/utils/config.ts`**

Locate `PROJECT_FIELDS` at line 353. Add the helper RIGHT BEFORE `private static filterProjectFields(...)` at line 363 (so the two project-context helpers sit together):

```typescript
  /**
   * Returns true when the local team profile's project context (codeMieProject,
   * codeMieIntegration, codeMieUrl) is safe to compose with the selected global
   * profile. The composition is only safe when both profiles target the same
   * CodeMie environment — otherwise the local project/integration IDs reference
   * the wrong env's database rows and the URL is outright wrong.
   *
   * The gate is conservative: it only blocks composition when both URLs are
   * explicitly set and normalized-differ. A missing URL on either side is
   * treated as "no signal of conflict" and composition proceeds. This matches
   * the common case where a local profile sets only `codeMieProject` and relies
   * on the global profile for the URL.
   */
  private static shouldPreserveProjectContext(
    localUrl: string | undefined,
    globalUrl: string | undefined
  ): boolean {
    if (!localUrl || !globalUrl) return true;
    const normalize = (u: string): string => u.replace(/\/+$/, '').toLowerCase();
    return normalize(localUrl) === normalize(globalUrl);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts -t "shouldPreserveProjectContext"`
Expected: All 9 tests PASS.

- [ ] **Step 6: Run the full file to verify no regressions**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts`
Expected: All existing tests still pass, plus the 9 new ones.

- [ ] **Step 7: Commit**

```bash
git add src/utils/config.ts src/utils/__tests__/config-project-override.test.ts
git commit -m "fix(config): add shouldPreserveProjectContext URL-equality helper"
```

---

## Task 2: Wire the gate into `ConfigLoader.load()`

**Files:**
- Modify: `src/utils/config.ts` lines 100-106 (the `applyProjectOnly` branch in `load()`). `globalConfig` is already in scope from line 91.
- Test: `src/utils/__tests__/config-project-override.test.ts` — extend the `cross-env URL gate` describe block with three integration tests under a nested `describe('load with --profile')`.

**Interfaces:**
- Consumes: `shouldPreserveProjectContext(localUrl, globalUrl)` from Task 1.
- Produces: `ConfigLoader.load()` returns a config with `codeMieUrl`/`codeMieProject`/`codeMieIntegration` from the selected global profile (and NOT the local team profile) whenever `applyProjectOnly` is true AND URLs differ. Otherwise behavior is unchanged.

**Test-first: yes — three failing tests showing `load()` currently leaks team URL/project/integration when global profile points at a different env.**

- [ ] **Step 1: Write the three failing integration tests**

Append inside the existing `describe('ConfigLoader - cross-env URL gate', ...)` block from Task 1 (as a sibling of the helper describe):

```typescript
  describe('load with --profile cross-env', () => {
    /** Build a global config with two profiles and write it under the mocked GLOBAL_CONFIG_DIR. */
    async function writeGlobal(activeProfile: string, profiles: Record<string, Partial<MultiProviderConfig['profiles'][string]>>) {
      const config: MultiProviderConfig = {
        version: 2,
        activeProfile,
        profiles: profiles as MultiProviderConfig['profiles']
      };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
    }

    /** Build a local project config and write it. */
    async function writeLocal(activeProfile: string, profiles: Record<string, Partial<MultiProviderConfig['profiles'][string]>>) {
      const config: MultiProviderConfig = {
        version: 2,
        activeProfile,
        profiles: profiles as MultiProviderConfig['profiles']
      };
      await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify(config, null, 2));
    }

    it('drops project context when --profile targets a different CodeMie URL', async () => {
      await writeGlobal('preview', {
        preview: {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://preview.example.com',
          baseUrl: 'https://preview.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'preview'
        }
      });
      await writeLocal('team-prod', {
        'team-prod': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://prod.example.com',
          codeMieProject: 'prod-proj',
          codeMieIntegration: 'prod-int' as unknown as CodeMieIntegrationInfo,
          baseUrl: 'https://prod.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'team-prod'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'preview' });

      expect(cfg.codeMieUrl).toBe('https://preview.example.com');
      expect(cfg.codeMieProject).toBeUndefined();
      expect(cfg.codeMieIntegration).toBeUndefined();
    });

    it('preserves project context when --profile targets the same CodeMie URL', async () => {
      await writeGlobal('personal-anthropic', {
        'personal-anthropic': {
          provider: 'anthropic-subscription',
          codeMieUrl: 'https://prod.example.com',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          name: 'personal-anthropic'
        }
      });
      await writeLocal('team-prod', {
        'team-prod': {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://prod.example.com',
          codeMieProject: 'prod-proj',
          codeMieIntegration: 'prod-int' as unknown as CodeMieIntegrationInfo,
          baseUrl: 'https://prod.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'team-prod'
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'personal-anthropic' });

      expect(cfg.codeMieUrl).toBe('https://prod.example.com');
      expect(cfg.codeMieProject).toBe('prod-proj');
      expect(cfg.codeMieIntegration).toBe('prod-int');
    });

    it('preserves local codeMieProject when local profile has no codeMieUrl', async () => {
      await writeGlobal('preview', {
        preview: {
          provider: 'ai-run-sso',
          codeMieUrl: 'https://preview.example.com',
          baseUrl: 'https://preview.example.com/code-assistant-api',
          model: 'claude-sonnet-4-6',
          name: 'preview'
        }
      });
      await writeLocal('team-default', {
        'team-default': {
          provider: 'ai-run-sso',
          codeMieProject: 'shared-proj',
          model: 'claude-sonnet-4-6',
          name: 'team-default'
          // no codeMieUrl on the local side
        }
      });

      const cfg = await ConfigLoader.load(path.join(TEST_DIR, 'project'), { name: 'preview' });

      expect(cfg.codeMieUrl).toBe('https://preview.example.com');
      expect(cfg.codeMieProject).toBe('shared-proj');
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts -t "load with --profile cross-env"`
Expected:
- Test 1 FAILS — `cfg.codeMieUrl` is `'https://prod.example.com'` (leaked from local) instead of preview.
- Test 2 PASSES (same-env preservation already works today). Keeping it as a green-on-green guard against regression.
- Test 3 FAILS — depending on field-undefined handling, may pass; expected fail mode is `cfg.codeMieUrl` is wrong (similar leak path).

If test 2 already passes, that's fine — it stays green through the fix and acts as a regression guard.

- [ ] **Step 3: Apply the gate in `ConfigLoader.load()`**

Modify lines 100-106 of `src/utils/config.ts`. Before:

```typescript
    const applyProjectOnly =
      cliOverrides?.name && localProfileName && cliOverrides.name !== localProfileName;
    const effectiveLocalConfig = applyProjectOnly
      ? this.filterProjectFields(localConfig)
      : localConfig;

    Object.assign(config, this.removeUndefined(effectiveLocalConfig));
```

After:

```typescript
    const applyProjectOnly =
      cliOverrides?.name && localProfileName && cliOverrides.name !== localProfileName;
    // When applying project-only composition, gate it on URL equality. If the
    // selected global profile targets a different CodeMie env than the local
    // team profile, the team's project/integration/URL all reference the wrong
    // env's records — drop the project-context bundle and let the global
    // profile supply everything.
    const preserveProjectContext =
      applyProjectOnly &&
      this.shouldPreserveProjectContext(localConfig.codeMieUrl, globalConfig.codeMieUrl);
    const effectiveLocalConfig = preserveProjectContext
      ? this.filterProjectFields(localConfig)
      : applyProjectOnly
        ? {}
        : localConfig;

    Object.assign(config, this.removeUndefined(effectiveLocalConfig));
```

Note: `applyProjectOnly && !preserveProjectContext` yields `{}` — explicit empty object, so `removeUndefined` returns `{}` and `Object.assign` is a no-op. The earlier `Object.assign(config, removeUndefined(globalConfig))` at line 92 has already populated globalConfig's fields; this branch leaves them untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts -t "load with --profile cross-env"`
Expected: All 3 tests PASS.

- [ ] **Step 5: Run the whole file to confirm no regressions**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts`
Expected: All tests pass (existing + helper + integration).

- [ ] **Step 6: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: Clean.

- [ ] **Step 7: Commit**

```bash
git add src/utils/config.ts src/utils/__tests__/config-project-override.test.ts
git commit -m "fix(config): gate project-context preservation on codeMieUrl equality in load()"
```

---

## Task 3: Wire the gate into `ConfigLoader.loadWithSources()`

**Files:**
- Modify: `src/utils/config.ts` — `loadWithSources()` at lines 1154-1174. The fix requires hoisting `loadGlobalConfigProfile(selectedProfileName)` from inside the `configs` array (line 1173) to BEFORE the `applyProjectOnly` block (line 1157).
- Test: `src/utils/__tests__/config-project-override.test.ts` — append one test to the existing `cross-env URL gate` describe block.

**Interfaces:**
- Consumes: `shouldPreserveProjectContext` from Task 1.
- Produces: parity with `load()` — `loadWithSources()` returns the same merged `config` and a `sources` map where `sources['codeMieUrl']` is `'global'` (not `'project'`) when URLs differ. The `effectiveLocalConfig` used for source attribution must reflect the same gate.

**Test-first: yes — one failing test asserting `sources['codeMieUrl'].source === 'global'` for the cross-env scenario.**

- [ ] **Step 1: Write the failing source-attribution test**

Append inside `describe('ConfigLoader - cross-env URL gate', ...)` after the `load with --profile cross-env` block:

```typescript
  describe('loadWithSources with --profile cross-env', () => {
    it('reports codeMieUrl source as "global" when URLs differ', async () => {
      const config: MultiProviderConfig = {
        version: 2,
        activeProfile: 'preview',
        profiles: {
          preview: {
            provider: 'ai-run-sso',
            codeMieUrl: 'https://preview.example.com',
            baseUrl: 'https://preview.example.com/code-assistant-api',
            model: 'claude-sonnet-4-6',
            name: 'preview'
          } as MultiProviderConfig['profiles'][string]
        }
      };
      await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));

      const localConfig: MultiProviderConfig = {
        version: 2,
        activeProfile: 'team-prod',
        profiles: {
          'team-prod': {
            provider: 'ai-run-sso',
            codeMieUrl: 'https://prod.example.com',
            codeMieProject: 'prod-proj',
            baseUrl: 'https://prod.example.com/code-assistant-api',
            model: 'claude-sonnet-4-6',
            name: 'team-prod'
          } as MultiProviderConfig['profiles'][string]
        }
      };
      await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify(localConfig, null, 2));

      const { config: merged, sources } = await ConfigLoader.loadWithSources(
        path.join(TEST_DIR, 'project'),
        { name: 'preview' }
      );

      expect(merged.codeMieUrl).toBe('https://preview.example.com');
      expect(sources['codeMieUrl']?.source).toBe('global');
      expect(sources['codeMieProject']).toBeUndefined();
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts -t "loadWithSources with --profile cross-env"`
Expected: FAIL — `sources['codeMieUrl'].source` is `'project'` (the local team URL leaks into the source attribution).

- [ ] **Step 3: Hoist global config load and apply gate in `loadWithSources()`**

Modify `src/utils/config.ts` lines 1154-1184. Before:

```typescript
    const selectedProfileName = await this.resolveProfileName(workingDir, cliOverrides?.name);
    const localProfileName = await this.resolveLocalProfileName(workingDir, selectedProfileName);

    const applyProjectOnly =
      cliOverrides?.name && localProfileName && cliOverrides.name !== localProfileName;
    const localConfig = await this.loadLocalConfigProfile(workingDir, localProfileName);
    const effectiveLocalConfig = applyProjectOnly
      ? this.filterProjectFields(localConfig)
      : localConfig;

    const configs: ConfigLayer[] = [
      {
        data: {
          timeout: 0, // Unlimited timeout by default for long AI requests
          debug: false
        },
        source: 'default'
      },
      {
        data: await this.loadGlobalConfigProfile(selectedProfileName),
        source: 'global'
      },
      {
        data: effectiveLocalConfig,
        source: 'project'
      },
```

After:

```typescript
    const selectedProfileName = await this.resolveProfileName(workingDir, cliOverrides?.name);
    const localProfileName = await this.resolveLocalProfileName(workingDir, selectedProfileName);

    // Hoisted: global config must be loaded BEFORE the URL-equality gate decision below.
    const globalConfig = await this.loadGlobalConfigProfile(selectedProfileName);
    const localConfig = await this.loadLocalConfigProfile(workingDir, localProfileName);

    const applyProjectOnly =
      cliOverrides?.name && localProfileName && cliOverrides.name !== localProfileName;
    const preserveProjectContext =
      applyProjectOnly &&
      this.shouldPreserveProjectContext(localConfig.codeMieUrl, globalConfig.codeMieUrl);
    const effectiveLocalConfig = preserveProjectContext
      ? this.filterProjectFields(localConfig)
      : applyProjectOnly
        ? {}
        : localConfig;

    const configs: ConfigLayer[] = [
      {
        data: {
          timeout: 0, // Unlimited timeout by default for long AI requests
          debug: false
        },
        source: 'default'
      },
      {
        data: globalConfig,
        source: 'global'
      },
      {
        data: effectiveLocalConfig,
        source: 'project'
      },
```

(The rest of the function — env layer, CLI layer, attribution loop, final `await this.load(...)` call — stays unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts -t "loadWithSources with --profile cross-env"`
Expected: PASS.

- [ ] **Step 5: Run all existing `loadWithSources` tests for regression**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts -t "loadWithSources"`
Expected: All pass (both the new test and the existing 5+ tests for `loadWithSources` in the same file).

- [ ] **Step 6: Run lint, typecheck, full test file**

Run: `npm run lint && npm run typecheck && npx vitest run src/utils/__tests__/config-project-override.test.ts`
Expected: Clean and all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/utils/config.ts src/utils/__tests__/config-project-override.test.ts
git commit -m "fix(config): apply URL-equality gate in loadWithSources for source attribution parity"
```

---

## Task 4: Documentation update

**Files:**
- Modify: `.ai-run/guides/usage/project-config.md` — add a URL-equality note under the "Team profile with personal provider" section (~line 131).

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: A single paragraph explaining the URL-equality precondition for project-context composition. No code change.

**Test-first: no — documentation. No failing test to author; verification is a manual read.**

- [ ] **Step 1: Locate the "Team profile with personal provider" section**

Run: `grep -n "Team profile with personal provider\|personal-anthropic\|PROJECT_FIELDS" .ai-run/guides/usage/project-config.md`
Expected: a single match around line 131. Read 30 lines around it to understand surrounding context.

- [ ] **Step 2: Add the URL-equality note**

Open the file, locate the paragraph describing the team-plus-personal-provider composition, and insert this paragraph immediately AFTER it:

```markdown
> **URL precondition.** Project-context preservation (`codeMieProject`, `codeMieIntegration`, `codeMieUrl`) applies only when the selected global profile and the local team profile target the same `codeMieUrl` (compared after stripping trailing slashes and lower-casing). When the URLs differ, the user is switching CodeMie environments and the team's project/integration IDs would reference the wrong env's records — so the local project context is dropped and the selected global profile supplies everything. This is enforced in `ConfigLoader.load()` and `ConfigLoader.loadWithSources()`.
```

- [ ] **Step 3: Verify the markdown renders cleanly**

Run: `head -200 .ai-run/guides/usage/project-config.md | grep -A1 "URL precondition"`
Expected: the paragraph appears, no orphan list markers nearby, no broken numbering. Eyeball the file once.

- [ ] **Step 4: Commit**

```bash
git add .ai-run/guides/usage/project-config.md
git commit -m "docs(config): note URL-equality precondition for project-context preservation"
```

---

## Final validation

After all four tasks complete:

- [ ] **Step 1: Full test suite**

Run: `npx vitest run src/utils/__tests__/config-project-override.test.ts`
Expected: All tests pass. New count: existing tests + 9 (helper) + 3 (load integration) + 1 (loadWithSources attribution) = 13 new tests.

- [ ] **Step 2: Quality gates**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: All clean.

- [ ] **Step 3: Diff sanity**

Run: `git diff main --stat`
Expected: three files changed — `src/utils/config.ts`, `src/utils/__tests__/config-project-override.test.ts`, `.ai-run/guides/usage/project-config.md`. Roughly +120 / -8 lines.

- [ ] **Step 4: Manual repro of EPMCDME-13167 symptom**

Run:
```bash
codemie proxy stop
codemie proxy connect desktop --profile preview --force
cat ~/.codemie/proxy-daemon.json | jq '{targetUrl, syncCodeMieUrl}'
```

Expected (after fix): both `targetUrl` and `syncCodeMieUrl` point at `codemie-preview.lab.epam.com` even when run from inside this repo (which has local `activeProfile=epm-cdme` with `codeMieUrl=codemie.lab.epam.com`).

This step is for the reviewer's confidence — not a unit-test requirement. The behavior is fully covered by the unit tests above.
